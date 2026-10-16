"""Deploys the renderer on Modal. From this directory: ``modal deploy modal_app.py``.

Each visitor's render session gets a container with one L40S of its own, switched off after a
minute without requests. It renders the path-traced spin the visitor orbits through: their view and
the angles nearest it while the loading screen is up, then the rest. Compiled GPU kernels, uploaded
scene data and finished frames are kept on a volume, so a container starting cold reuses them.

One GPU per container, because Modal places a container's GPUs on one machine: an eight-L40S
container sat "scheduling" for over ten minutes, and a single L40S schedules in seconds. The
gateway runs at most FURY_MAX_SESSIONS sessions at once (gateway.py); FURY_GPU (say L40S:2) gives
each session more GPUs, at that risk.
"""

import os

import modal

GPU = os.environ.get("FURY_GPU", "L40S")
GPU_COUNT = int(GPU.split(":")[1]) if ":" in GPU else 1
IDLE_SECONDS = int(os.environ.get("FURY_IDLE_SECONDS", "60"))
MAX_SESSIONS = os.environ.get("FURY_MAX_SESSIONS", "3")

cache = modal.Volume.from_name("fury-render-cache", create_if_missing=True)

# The durable frame store (fury_render/frames.py): an S3-compatible bucket where every finished
# showroom still is kept and from which the gateway answers a repeat without waking a GPU. Read at
# deploy time from FURY_FRAME_BUCKET, FURY_FRAME_ENDPOINT, FURY_FRAME_PREFIX, FURY_FRAME_REGION and
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY; with no bucket, frames live on the volume only.
FRAME_STORE = modal.Secret.from_dict(
    {
        name: os.environ[name]
        for name in (
            "FURY_FRAME_BUCKET",
            "FURY_FRAME_ENDPOINT",
            "FURY_FRAME_PREFIX",
            "FURY_FRAME_REGION",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
        )
        if os.environ.get(name)
    }
)

environment = {
    "FURY_DEVICE": "auto",
    # One renderer per GPU, each rendering its own frames.
    "FURY_WORKERS": str(GPU_COUNT),
    # Scene data (geometry, textures, sky) is content-addressed and shared by every visitor. Kept on
    # the volume, a container starting cold already has what others uploaded before it started,
    # instead of the browser re-uploading some 25 MB before the first view.
    "FURY_BLOB_DIR": "/fury-cache/blobs",
    # Finished spin frames, shared by every visitor who sees the same design from the same angle.
    "FURY_FRAME_DIR": "/fury-cache/frames",
    # OptiX compiles its kernels on first use; keep them between containers.
    "OPTIX_CACHE_PATH": "/fury-cache/optix",
    "XDG_CACHE_HOME": "/fury-cache/xdg",
}

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "libx11-6",
        "libxi6",
        "libxxf86vm1",
        "libxfixes3",
        "libxrender1",
        "libxkbcommon0",
        "libsm6",
        "libgl1",
        "libegl1",
        "libgomp1",
    )
    # Keep in step with requirements.txt.
    .uv_pip_install(
        "bpy==4.5.0",
        "fastapi[standard]==0.143.2",
        "numpy==1.26.4",
        "pillow==11.3.0",
        "boto3==1.40.49",
    )
    .add_local_python_source("fury_render")
)

app = modal.App(os.environ.get("FURY_APP_NAME", "fury-render"))


@app.cls(
    image=image,
    gpu=GPU,
    # A Blender process per GPU, and frames finished and encoded on the CPU while the GPUs render
    # the next ones.
    cpu=max(4, 2 * GPU_COUNT),
    memory=max(16384, 6144 * GPU_COUNT),
    volumes={"/fury-cache": cache},
    scaledown_window=IDLE_SECONDS,
    # Per session: each value of `session` is a function of its own, with its own containers.
    max_containers=1,
    timeout=900,
    # FURY_DENOISE=cpu at deploy time skips GPU denoising (it falls back by itself if it fails).
    secrets=[
        modal.Secret.from_dict({"FURY_DENOISE": os.environ.get("FURY_DENOISE", "auto")}),
        FRAME_STORE,
    ],
)
# Frame requests wait in the renderer's own priority queue.
@modal.concurrent(max_inputs=64)
class Renderer:
    # The visitor's render session: every session runs in containers of its own.
    session: str = modal.parameter()

    @modal.enter()
    def start(self):
        # Boot phases are timed and printed, so `modal app logs` shows what a cold start costs:
        # importing Blender, configuring the device and compiling kernels, the warm-up render.
        import time

        t0 = time.perf_counter()
        phase = lambda name: print(
            f"boot[{self.session}]: {name} at {round((time.perf_counter() - t0) * 1000)} ms"
        )  # noqa: E731
        phase("container entered")
        # Set cache paths after volume mounting, not while the image is being built.
        os.environ.update(environment)
        from fury_render.api import create_app

        phase("api imported")
        self.web_app = create_app(start=False)
        phase("app created; starting workers (bpy import, device, warm-up)")
        info = self.web_app.state.service.start()
        phase(f"renderer ready: {info}")
        cache.commit()
        phase("volume committed")

    @modal.method()
    async def request(self, method: str, path: str, body: bytes, client: str):
        from fury_render.rpc import call_app

        # Images stay gzip-compressed all the way to the browser.
        return await call_app(self.web_app, method, path, body, client)


gateway_image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install("fastapi[standard]==0.143.2", "numpy==1.26.4", "boto3==1.40.49")
    .add_local_python_source("fury_render")
)


@app.function(
    image=gateway_image,
    cpu=0.25,
    memory=2048,
    max_containers=1,
    scaledown_window=60,
    timeout=240,
    secrets=[
        modal.Secret.from_dict(
            {
                "FURY_ALLOWED_ORIGINS": os.environ.get("FURY_ALLOWED_ORIGINS", "(?!)"),
                "FURY_MAX_SESSIONS": MAX_SESSIONS,
            }
        ),
        FRAME_STORE,
    ],
)
# Visitors keep several frame requests open while their spin renders.
@modal.concurrent(max_inputs=64)
@modal.asgi_app()
def gateway():
    from fury_render.gateway import create_gateway
    from fury_render.rpc import answer_or_cancel

    # One per session seen: binding a session to its GPU function happens once, on its first call.
    renderers: dict[str, Renderer] = {}

    async def dispatch(method, path, body, client, session):
        renderer = renderers.get(session)
        if renderer is None:
            if len(renderers) > 1000:
                renderers.clear()
            renderer = renderers[session] = Renderer(session=session)
        # Spawned rather than called, so a request the gateway stops waiting for is cancelled
        # instead of left queued for the GPU.
        return await answer_or_cancel(renderer.request.spawn.aio(method, path, body, client))

    return create_gateway(dispatch)
