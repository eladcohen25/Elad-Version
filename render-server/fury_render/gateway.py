"""CPU-only gateway in front of the GPUs, which have no public HTTP endpoint.

There is no PIN: browsers on the allowed origins render directly. Requests are validated and
rate-limited here, before they can start a GPU. Each visitor's render session (the page's
`session` query parameter) is sent to a GPU of its own, and only so many sessions run at once.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from .api import Bucket
from .protocol import HASH, MAX_BLOB_BYTES, ProtocolError, decompress, digest, validate_request

MAX_SCENE_BYTES = 32 << 20
SESSION = re.compile(r"[A-Za-z0-9_-]{8,64}")
# A page that names no session (one older than sessions) shares this one.
SHARED_SESSION = "shared-session"


class Sessions:
    """The render sessions that have a GPU, at most `limit` at once.

    A session keeps its place while it keeps asking: until `idle` seconds after its last request,
    a little longer than its GPU stays on without requests. While every place is taken, a new
    session is turned away, and its page traces on the visitor's own device instead.
    """

    def __init__(self, limit: int, idle: float = 120):
        self.limit = limit
        self.idle = idle
        self.seen: dict[str, float] = {}

    def has_room(self, session: str) -> bool:
        """Whether the session has its GPU, or one is free for it."""
        now = time.monotonic()
        for key, last in list(self.seen.items()):
            if now - last > self.idle:
                del self.seen[key]
        return session in self.seen or len(self.seen) < self.limit

    def admit(self, session: str) -> bool:
        if not self.has_room(session):
            return False
        self.seen[session] = time.monotonic()
        return True

    def touch(self, session: str):
        if session in self.seen:
            self.seen[session] = time.monotonic()


async def read_body(request: Request, limit: int) -> bytes:
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise HTTPException(413, "Request too large")
        body.extend(chunk)
    return bytes(body)


def create_gateway(
    dispatch: Callable[[str, str, bytes, str, str], Awaitable[tuple[int, dict, bytes]]],
    origins: str | None = None,
    max_sessions: int | None = None,
) -> FastAPI:
    """`dispatch(method, path, body, client, session)` calls the session's own GPU."""
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=origins or os.environ["FURY_ALLOWED_ORIGINS"],
        allow_methods=["GET", "POST", "PUT"],
        allow_headers=["content-type"],
        expose_headers=[
            "x-image-format",
            "x-image-width",
            "x-image-height",
            "x-device",
            "x-denoise",
            "x-cache",
            "x-finish-ms",
            "x-traced-key",
            "x-queue-ms",
            "x-prepare-ms",
            "x-render-ms",
            "x-pack-ms",
            "x-cold",
            "x-boot-ms",
            "x-container-age-ms",
            "x-dispatch-ms",
        ],
    )
    # Global, not per caller: one gateway container is required. A visitor's spin is a few hundred
    # frame requests in the first minutes, many answered from the frame cache; each session's GPU
    # renders one frame at a time, and the session limit bounds how many GPUs there are.
    render_limit = Bucket(600 / 60, 240)
    upload_limit = Bucket((1024 << 20) / 3600, MAX_BLOB_BYTES * 4)
    sessions = Sessions(
        max_sessions if max_sessions is not None else int(os.environ.get("FURY_MAX_SESSIONS", "3"))
    )

    @app.middleware("http")
    async def no_cache(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health")
    async def health(request: Request):
        """The gateway's own state, never starting a GPU. With `?session=<id>` for a session
        that already holds a GPU, its renderer's state too (device, denoiser, queue, boot time)."""
        now = time.monotonic()
        report: dict = {
            "ok": True,
            "service": "gateway",
            "sessions": {
                "limit": sessions.limit,
                "active": len(sessions.seen),
                "idleSeconds": sessions.idle,
                "ages": {key: round(now - last, 1) for key, last in sorted(sessions.seen.items())},
            },
        }
        session = request.query_params.get("session")
        if session and SESSION.fullmatch(session) and session in sessions.seen:
            started = time.perf_counter()
            try:
                status, _headers, content = await asyncio.wait_for(
                    dispatch("GET", "/health", b"", "gateway", session), timeout=30
                )
                report["renderer"] = json.loads(content) if status == 200 else {"status": status}
            except Exception as error:  # noqa: BLE001 - reported, not raised
                report["renderer"] = {"error": repr(error)}
            report["rendererMs"] = round((time.perf_counter() - started) * 1000)
        return report

    async def forward(request: Request, path: str, limit: int):
        client = request.client.host if request.client else "unknown"
        session = request.query_params.get("session", SHARED_SESSION)
        if not SESSION.fullmatch(session):
            raise HTTPException(400, "Bad render session")
        # Not "busy": asking again soon would not help, so the page renders on its own.
        full = JSONResponse({"error": "Every cloud GPU is in use", "full": True}, status_code=503)
        if not sessions.has_room(session):
            return full
        if request.method == "POST" and not render_limit.take("all"):
            raise HTTPException(429, "Render limit reached; try again shortly")
        raw = await read_body(request, limit)
        try:
            body = await asyncio.to_thread(decompress, raw, limit)
            if path == "/render":
                data = json.loads(body)
                if not isinstance(data, dict):
                    raise ValueError
                validate_request(data)
                # Supersession stays within one caller's own views.
                data["session"] = client + ":" + str(data.get("session", ""))[:24]
                quality = data.get("quality") or {}
                # A 360° panorama has several times a view's pixels.
                cap = 60 if (data.get("camera") or {}).get("panorama") else 15
                quality["timeLimit"] = min(cap, float(quality.get("timeLimit", 15)))
                data["quality"] = quality
                body = json.dumps(data).encode()
            else:
                if digest(body) != path.rsplit("/", 1)[1]:
                    raise ValueError
                if not upload_limit.take("all", len(body)):
                    raise HTTPException(429, "Upload limit reached")
        except (ProtocolError, ValueError, TypeError, AttributeError, OSError, EOFError):
            raise HTTPException(400, "Invalid render request or blob") from None
        # Only a valid request takes a place, so malformed ones cannot keep visitors off the GPUs.
        if not sessions.admit(session):
            return full
        dispatched = time.perf_counter()
        try:
            status, headers, content = await asyncio.wait_for(
                dispatch(request.method, path, body, client, session), timeout=180
            )
        except Exception:
            logging.getLogger(__name__).exception(
                "Private GPU dispatch failed after %d ms",
                round((time.perf_counter() - dispatched) * 1000),
            )
            raise HTTPException(503, "Cloud renderer unavailable; try again shortly") from None
        finally:
            # A long render keeps its session's place.
            sessions.touch(session)
        # Wall time at the gateway: the renderer's own queue and render times are in its headers,
        # so the difference is Modal scheduling and a cold container starting.
        headers = {
            **headers,
            "X-Dispatch-Ms": str(round((time.perf_counter() - dispatched) * 1000)),
        }
        return Response(content, status_code=status, headers=headers)

    @app.post("/render")
    async def render(request: Request):
        return await forward(request, "/render", MAX_SCENE_BYTES)

    @app.put("/blobs/{blob_hash}")
    async def upload(blob_hash: str, request: Request):
        if not HASH.fullmatch(blob_hash):
            raise HTTPException(400, "Bad hash")
        return await forward(request, f"/blobs/{blob_hash}", MAX_BLOB_BYTES)

    return app
