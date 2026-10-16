"""HTTP API of the render server.

    GET  /health          device and queue state
    PUT  /blobs/{sha256}  upload a blob (raw or gzip); stored by the hash of its raw content
    POST /render          render a view; 200 with a linear half-float image (protocol.py),
                          gzip transfer-encoded, or a gzip file with "transfer": "file",
                          409 {"missing": [...]} when blobs must be uploaded first,
                          409 {"superseded": true} when the same session asked for a newer view

One worker renders at a time. A session's queued requests are dropped once it asks for a newer
view, so an orbiting visitor never waits behind views they have already left. Queued renders go
by "kind": a quick preview first, then the visitor's view, then pre-rendered orbit views.
"""

from __future__ import annotations

import asyncio
import hashlib
import heapq
import itertools
import json
import multiprocessing
import os
import re
import struct
import tempfile
import threading
import time
import uuid
from collections.abc import Awaitable
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import numpy as np

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from . import finishing
from . import worker as worker_module
from .frames import FrameCache, remote_frames_from_env
from .protocol import (
    HASH,
    IMAGE_FORMAT,
    MAX_BLOB_BYTES,
    ProtocolError,
    decompress,
    digest,
    required_blobs,
    validate_request,
)

# The configurator's production and preview deployments, plus local development.
DEFAULT_ORIGINS = (
    r"^https://furygymconfigurator[a-z0-9-]*\.vercel\.app$"
    r"|^http://(localhost|127\.0\.0\.1)(:\d+)?$"
)


@dataclass
class Settings:
    device: str = field(default_factory=lambda: os.environ.get("FURY_DEVICE", "auto"))
    blob_dir: str = field(
        default_factory=lambda: os.environ.get(
            "FURY_BLOB_DIR", os.path.join(tempfile.gettempdir(), "fury-blobs")
        )
    )
    blob_budget: int = field(
        default_factory=lambda: int(os.environ.get("FURY_BLOB_BUDGET_MB", "6000")) << 20
    )
    origins: str = field(
        default_factory=lambda: os.environ.get("FURY_ALLOWED_ORIGINS", DEFAULT_ORIGINS)
    )
    renders_per_minute: float = field(
        default_factory=lambda: float(os.environ.get("FURY_RENDERS_PER_MINUTE", "600"))
    )
    upload_mb_per_hour: float = field(
        default_factory=lambda: float(os.environ.get("FURY_UPLOAD_MB_PER_HOUR", "2000"))
    )
    max_queue: int = field(default_factory=lambda: int(os.environ.get("FURY_MAX_QUEUE", "64")))
    # Blender processes, each rendering one frame at a time; with several GPUs, one on each.
    workers: int = field(default_factory=lambda: int(os.environ.get("FURY_WORKERS", "1")))
    # Finished frames (WebP), by the hash of everything that determines them.
    frame_dir: str = field(
        default_factory=lambda: os.environ.get(
            "FURY_FRAME_DIR", os.path.join(tempfile.gettempdir(), "fury-frames")
        )
    )
    frame_budget: int = field(
        default_factory=lambda: int(os.environ.get("FURY_FRAME_BUDGET_MB", "4000")) << 20
    )
    # Threads that finish and encode frames while the GPU renders the next one.
    finish_threads: int = field(
        default_factory=lambda: int(
            os.environ.get("FURY_FINISH_THREADS", str(max(2, (os.cpu_count() or 4) // 2)))
        )
    )
    # "auto" denoises on the GPU when there is one; "cpu" forces the CPU.
    denoise: str = field(default_factory=lambda: os.environ.get("FURY_DENOISE", "auto"))


class WorkerDied(RuntimeError):
    pass


class Worker:
    """A Blender child process and the pipe to it. Calls are serialized by the caller.

    `gpu` pins it to one GPU, so several workers render different frames side by side: a spin's
    frames are independent, and one GPU per frame keeps every GPU busy where splitting each frame
    across all of them would not.
    """

    def __init__(self, settings: Settings, gpu: int | None = None):
        self.settings = settings
        self.gpu = gpu
        self.denoise = settings.denoise
        self.process = None
        self.conn = None
        self.info: dict = {}
        self.lock = threading.Lock()

    def start(self) -> dict:
        with self.lock:
            if self.process is not None and self.process.is_alive():
                return self.info
            try:
                return self._spawn()
            except WorkerDied:
                if self.denoise == "cpu":
                    raise
                # A GPU denoiser that takes the whole renderer down: keep rendering without it.
                print("The renderer failed to start; retrying with CPU denoising.", flush=True)
                self.denoise = "cpu"
                return self._spawn()

    def _spawn(self) -> dict:
        context = multiprocessing.get_context("spawn")
        parent, child = context.Pipe()
        process = context.Process(
            target=worker_module.run,
            args=(child, self.settings.blob_dir, self.settings.device, self.denoise, self.gpu),
            daemon=True,
        )
        process.start()
        child.close()
        if not parent.poll(600):
            process.kill()
            raise WorkerDied("the renderer did not start")
        try:
            self.info = parent.recv()
        except EOFError as error:
            raise WorkerDied("the renderer failed to start") from error
        self.process, self.conn = process, parent
        return self.info

    def crashed(self):
        """After the renderer died mid-render, restart it without GPU denoising if it used it."""
        if self.info.get("denoise") == "gpu":
            print("The renderer stopped while denoising on the GPU; using the CPU.", flush=True)
            self.denoise = "cpu"

    def call(self, message: dict) -> dict:
        try:
            self.conn.send(message)
            return self.conn.recv()
        except (EOFError, BrokenPipeError, OSError) as error:
            self.process = None
            raise WorkerDied("the renderer stopped") from error


class BlobStore:
    """Blobs as files named by their hash, pruned oldest first beyond a byte budget.

    The directory may be on a network volume, so it is listed only when the budget is exceeded.
    """

    def __init__(self, directory: str, budget: int):
        self.directory = directory
        self.budget = budget
        os.makedirs(directory, exist_ok=True)
        self.total = sum(size for _, size, _ in self._entries())

    def path(self, key: str) -> str:
        return os.path.join(self.directory, key)

    def has(self, key: str) -> bool:
        path = self.path(key)
        if os.path.exists(path):
            os.utime(path)
            return True
        return False

    def read(self, key: str) -> bytes | None:
        try:
            with open(self.path(key), "rb") as f:
                data = f.read()
        except FileNotFoundError:
            return None
        os.utime(self.path(key))
        return data

    def put(self, key: str, data: bytes):
        temp = self.path(f".{key}.{uuid.uuid4().hex}")
        with open(temp, "wb") as f:
            f.write(data)
        os.replace(temp, self.path(key))
        self.total += len(data)
        if self.total > self.budget:
            self.prune()

    def _entries(self):
        for name in os.listdir(self.directory):
            if HASH.match(name):
                stat = os.stat(self.path(name))
                yield stat.st_mtime, stat.st_size, name

    def prune(self):
        entries = sorted(self._entries())
        self.total = sum(size for _, size, _ in entries)
        for _, size, name in entries:
            if self.total <= self.budget:
                break
            os.remove(self.path(name))
            self.total -= size


# Queue order by request kind (lower first); requests may also give a "priority" of 0-9.
PRIORITY = {"preview": 0, "view": 1, "orbit": 5}


def frame_digest(request: dict) -> str:
    """Names a finished frame by everything that determines it."""
    keys = ("scene", "camera", "width", "height", "samples", "threshold", "time_limit", "finish")
    record = {k: request[k] for k in keys}
    record["format"] = FRAME_FORMAT
    text = json.dumps(record, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode()).hexdigest()


# A stored frame: its traced key (the browser's exposure meter on the unfinished image), then the
# WebP. The key comes back with the frame, also from the cache.
FRAME_FORMAT = "key+webp"
FRAME_KEY = struct.Struct("<d")


def finish_frame(path: str, finish: dict) -> tuple[bytes, float]:
    hdr = np.load(path).astype(np.float32)
    rgb = finishing.finish(hdr, finish["exposure"], finish["gain"], finish["glow"])
    return finishing.encode_webp(rgb), finishing.traced_key(hdr)


async def uninterrupted(work: Awaitable):
    """Awaits work that cannot be stopped once begun, such as a frame Blender is rendering.

    A cancelled caller (its gateway stopped waiting) still waits for the work to end before the
    cancellation is raised. Until then the work keeps the worker's turn and output file: released
    any sooner, the next render would share the worker's pipe while Blender is still answering.
    """
    task = asyncio.ensure_future(work)
    cancelled = False
    while not task.done():
        try:
            await asyncio.wait([task])
        except asyncio.CancelledError:
            cancelled = True
    result = task.result()
    if cancelled:
        raise asyncio.CancelledError
    return result


class RenderQueue:
    """Renders on a number of workers, one each, by priority (lower first), then in order of arrival.

    A render in progress is never interrupted, but views the visitor is waiting for go ahead of
    queued pre-renders. A turn is the index of the worker that is free.
    """

    def __init__(self, workers: int = 1):
        self.workers = workers
        self.free = list(range(workers))
        self.waiters: list[tuple[int, int, asyncio.Future]] = []
        self.order = itertools.count()

    @property
    def busy(self) -> bool:
        return len(self.free) < self.workers

    async def acquire(self, priority: int) -> int:
        if self.free and not self.waiters:
            return self.free.pop(0)
        turn = asyncio.get_running_loop().create_future()
        heapq.heappush(self.waiters, (priority, next(self.order), turn))
        try:
            return await turn
        except asyncio.CancelledError:
            # Granted just as the caller went away: pass the turn on.
            if turn.done() and not turn.cancelled():
                self.release(turn.result())
            raise

    @asynccontextmanager
    async def turn(self, priority: int):
        worker = await self.acquire(priority)
        try:
            yield worker
        finally:
            self.release(worker)

    def release(self, worker: int = 0):
        while self.waiters:
            _, _, turn = heapq.heappop(self.waiters)
            if not turn.done():
                turn.set_result(worker)
                return
        self.free.append(worker)


class Bucket:
    """Per-client token buckets."""

    def __init__(self, rate_per_second: float, capacity: float):
        self.rate = rate_per_second
        self.capacity = capacity
        self.state: dict[str, tuple[float, float]] = {}

    def take(self, key: str, amount: float = 1) -> bool:
        now = time.monotonic()
        tokens, last = self.state.get(key, (self.capacity, now))
        tokens = min(self.capacity, tokens + (now - last) * self.rate)
        if len(self.state) > 10000:
            self.state.clear()
        if tokens < amount:
            self.state[key] = (tokens, now)
            return False
        self.state[key] = (tokens - amount, now)
        return True


def client_key(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# Responses after boot that carry X-Cold: 1 (the first frames of a cold start).
COLD_RESPONSES = 3


class Service:
    def __init__(self, settings: Settings | None = None):
        self.settings = settings or Settings()
        self.store = BlobStore(self.settings.blob_dir, self.settings.blob_budget)
        # Finished frames: the volume in front of the durable bucket, when one is configured.
        self.frames = FrameCache(
            BlobStore(self.settings.frame_dir, self.settings.frame_budget), remote_frames_from_env()
        )
        self.finisher = ThreadPoolExecutor(self.settings.finish_threads)
        count = max(1, self.settings.workers)
        self.workers = [Worker(self.settings, i if count > 1 else None) for i in range(count)]
        self.origins = re.compile(self.settings.origins)
        self.queue = RenderQueue(count)
        self.waiting = 0
        self.latest: dict[str, int] = {}
        self.renders = Bucket(
            self.settings.renders_per_minute / 60, self.settings.renders_per_minute / 2
        )
        upload_rate = self.settings.upload_mb_per_hour * (1 << 20) / 3600
        self.uploads = Bucket(upload_rate, MAX_BLOB_BYTES * 4)
        # Cold-start accounting, reported on every response (X-Boot-Ms, X-Container-Age-Ms) and
        # as X-Cold on the first responses after boot, so the browser's timeline can tell a cold
        # GPU from a slow one.
        self.boot_started = time.perf_counter()
        self.boot_ready: float | None = None
        self.responses = 0

    def start(self) -> dict:
        # Side by side: each warms up its own GPU.
        with ThreadPoolExecutor(len(self.workers)) as pool:
            infos = list(pool.map(lambda worker: worker.start(), self.workers))
        self.boot_ready = time.perf_counter()
        print(f"boot: {round((self.boot_ready - self.boot_started) * 1000)} ms to ready")
        return infos[0]

    def timing_headers(self) -> dict[str, str]:
        """Cold-start headers for a response: how long boot took, how old the container is."""
        self.responses += 1
        headers = {}
        if self.boot_ready is not None:
            headers["X-Boot-Ms"] = str(round((self.boot_ready - self.boot_started) * 1000))
            headers["X-Container-Age-Ms"] = str(
                round((time.perf_counter() - self.boot_ready) * 1000)
            )
        if self.responses <= COLD_RESPONSES:
            headers["X-Cold"] = "1"
        return headers

    @property
    def info(self) -> dict:
        return self.workers[0].info

    async def missing(self, scene: dict) -> list[str]:
        # Always upload from the browser; never fetch caller-supplied URLs on the server.
        return [key for key, _ in required_blobs(scene) if not self.store.has(key)]

    async def render(self, body: dict) -> Response:
        request = validate_request(body)
        session = str(body.get("session", ""))[:64]
        seq = int(body.get("seq", 0))
        # "preview", "view" or "orbit" (a pre-render), or an explicit priority: the place in the
        # queue.
        kind = str(body.get("kind", "view"))
        priority = request["priority"]
        if priority is None:
            priority = PRIORITY.get(kind, 1)
        frame = request["output"] == "frame"
        key = frame_digest(request) if frame else None
        if key:
            cached = self.frames.read(key)
            if cached is not None:
                (key_light,) = FRAME_KEY.unpack_from(cached)
                return self.frame_response(
                    cached[FRAME_KEY.size :],
                    request,
                    {"X-Cache": "hit", "X-Traced-Key": f"{key_light:.4f}"},
                )
        if session:
            if len(self.latest) > 10000:
                self.latest.clear()
            self.latest[session] = max(seq, self.latest.get(session, seq))
        missing = await self.missing(request["scene"])
        if missing:
            return JSONResponse({"missing": missing}, status_code=409)
        if self.waiting >= self.settings.max_queue:
            return JSONResponse({"error": "busy"}, status_code=503)
        queued = time.perf_counter()
        self.waiting += 1
        try:
            # Waiting for a worker can be given up: the request leaves the queue.
            index = await self.queue.acquire(priority)

            async def on_worker() -> Response:
                out = os.path.join(tempfile.gettempdir(), f"fury-{uuid.uuid4().hex}.bin")
                try:
                    try:
                        if session and self.latest.get(session, seq) > seq:
                            return JSONResponse({"superseded": True}, status_code=409)
                        waited = time.perf_counter() - queued
                        worker = self.workers[index]
                        try:
                            result = await asyncio.to_thread(
                                worker.call, {"op": "render", "request": request, "out": out}
                            )
                        except WorkerDied:
                            worker.crashed()
                            await asyncio.to_thread(worker.start)
                            return JSONResponse({"error": "renderer restarted"}, status_code=503)
                        if not result.get("ok"):
                            return JSONResponse(
                                {"error": result.get("error", "render failed")},
                                status_code=int(result.get("status", 500)),
                            )
                        if not frame:
                            with open(out, "rb") as f:
                                image = f.read()
                    finally:
                        self.queue.release(index)
                    stats = result["stats"]
                    timings = {
                        "X-Queue-Ms": str(round(waited * 1000)),
                        "X-Prepare-Ms": str(stats["prepareMs"]),
                        "X-Render-Ms": str(stats["renderMs"]),
                        "X-Device": str(stats["device"]),
                        "X-Denoise": str(stats.get("denoise", "")),
                    }
                    if frame:
                        # The GPU is free again: finish this frame while it renders the next.
                        started = time.perf_counter()
                        data, key_light = await asyncio.get_running_loop().run_in_executor(
                            self.finisher, finish_frame, out, request["finish"]
                        )
                        self.frames.put(key, FRAME_KEY.pack(key_light) + data)
                        return self.frame_response(
                            data,
                            request,
                            {
                                **timings,
                                "X-Cache": "miss",
                                "X-Finish-Ms": str(round((time.perf_counter() - started) * 1000)),
                                "X-Traced-Key": f"{key_light:.4f}",
                            },
                        )
                finally:
                    if os.path.exists(out):
                        os.remove(out)
                # As a gzip file the browser keeps the image compressed (it caches pre-rendered
                # views); as gzip transfer encoding it arrives inflated.
                as_file = body.get("transfer") == "file"
                return Response(
                    image,
                    media_type="application/gzip" if as_file else "application/octet-stream",
                    headers={
                        **({} if as_file else {"Content-Encoding": "gzip"}),
                        **timings,
                        "X-Image-Format": IMAGE_FORMAT,
                        "X-Image-Width": str(stats["width"]),
                        "X-Image-Height": str(stats["height"]),
                        "X-Pack-Ms": str(stats["packMs"]),
                        "Cache-Control": "no-store",
                    },
                )

            # On a worker, the request goes on even if its caller has gone (the gateway stopped
            # waiting): Blender can't be interrupted, and a finished spin frame is cached for
            # whoever asks for it next, the browser's retry included.
            return await uninterrupted(on_worker())
        finally:
            self.waiting -= 1

    @staticmethod
    def frame_response(data: bytes, request: dict, headers: dict) -> Response:
        return Response(
            data,
            media_type="image/webp",
            headers={
                **headers,
                "X-Image-Format": "webp",
                "X-Image-Width": str(request["width"]),
                "X-Image-Height": str(request["height"]),
                "Cache-Control": "no-store",
            },
        )


def create_app(settings: Settings | None = None, start: bool = True) -> FastAPI:
    service = Service(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if start:
            await asyncio.to_thread(service.start)
        yield

    app = FastAPI(title="Fury Studio renderer", lifespan=lifespan)
    app.state.service = service
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=service.settings.origins,
        allow_methods=["GET", "PUT", "POST"],
        allow_headers=["content-type"],
        expose_headers=[
            "x-image-format",
            "x-image-width",
            "x-image-height",
            "x-queue-ms",
            "x-prepare-ms",
            "x-render-ms",
            "x-pack-ms",
            "x-device",
            "x-denoise",
            "x-cache",
            "x-finish-ms",
            "x-traced-key",
            "x-cold",
            "x-boot-ms",
            "x-container-age-ms",
            "x-cache-store",
        ],
        max_age=3600,
    )

    @app.middleware("http")
    async def cold_start_headers(request: Request, call_next):
        response = await call_next(request)
        for name, value in service.timing_headers().items():
            response.headers[name] = value
        return response

    @app.get("/health")
    async def health():
        info = service.info
        return {
            "ok": True,
            "device": info.get("device"),
            "gpus": info.get("gpus", []),
            "denoise": info.get("denoise"),
            "workers": len(service.workers),
            "queue": service.waiting,
            "bootMs": (
                round((service.boot_ready - service.boot_started) * 1000)
                if service.boot_ready is not None
                else None
            ),
            "containerAgeMs": (
                round((time.perf_counter() - service.boot_ready) * 1000)
                if service.boot_ready is not None
                else None
            ),
            "responses": service.responses,
        }

    async def bounded_body(request: Request, limit: int):
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > limit:
                raise HTTPException(413, "too large")
            data.extend(chunk)
        return bytes(data)

    @app.put("/blobs/{key}")
    async def put_blob(key: str, request: Request):
        if not HASH.match(key):
            return JSONResponse({"error": "bad hash"}, status_code=400)
        body = await bounded_body(request, MAX_BLOB_BYTES)
        if not service.uploads.take(client_key(request), len(body)):
            return JSONResponse({"error": "upload rate exceeded"}, status_code=429)
        try:
            data = await asyncio.to_thread(decompress, body)
        except (OSError, EOFError, ProtocolError):
            return JSONResponse({"error": "bad gzip"}, status_code=400)
        if len(data) > MAX_BLOB_BYTES or digest(data) != key:
            return JSONResponse({"error": "hash mismatch"}, status_code=400)
        await asyncio.to_thread(service.store.put, key, data)
        return Response(status_code=204)

    @app.post("/render")
    async def render(request: Request):
        if not service.renders.take(client_key(request)):
            return JSONResponse({"error": "render rate exceeded"}, status_code=429)
        raw = await bounded_body(request, 32 << 20)
        try:
            body = json.loads(decompress(raw, 32 << 20))
            return await service.render(body)
        except (ProtocolError, ValueError, TypeError, AttributeError, OSError, EOFError) as error:
            return JSONResponse({"error": str(error)}, status_code=400)

    return app
