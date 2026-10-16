# Cloud renderer

Optional Blender Cycles renderer for the configurator. An L40S uses OptiX hardware ray tracing,
and Open Image Denoise (OIDN) finishes the image on the GPU. OptiX's own denoiser fails on the
tested Modal runtime even though OptiX rendering works, so OIDN is used instead.

If GPU denoising fails, the renderer falls back to CPU denoising by itself. That covers failing
at warm-up, failing to start, or crashing mid-render. The CPU path uses OIDN's fast prefilter:
about 3.5 s at 1920×1200 on 4 vCPUs, against 12.5 s with the accurate one. `/health`, the
`X-Denoise` header, and the browser's `?traceStats=1` log say which is in use. The browser
applies exposure matching, bloom, and tone mapping to views; the path-traced spin's frames are
finished here instead (`fury_render/finishing.py`: the browser's exposure gain, bloom, AgX tone
mapping and dither) and sent as WebP.

## Access and deployment

The public endpoint is a **CPU-only gateway**, not the GPU. It validates and rate-limits render
and blob requests, then invokes a private Modal method. `/health` checks only the gateway and never
starts a GPU. There is no PIN: browsers on the allowed origins render directly. Anyone who can
reach the gateway URL can request renders, so the Modal spending limit is the real cost cap.

**One GPU per render session.** Each page names its render session in a `session` query
parameter on every render and upload (one id per page load, `src/render/cloud.ts`). A query
parameter needs no CORS preflight, so pages and gateways from before sessions keep working with
each other in either order of deployment. The renderer is a
parametrized Modal class, `Renderer(session=...)`: each session is a Modal function of its own,
with its own container holding one L40S, its own Blender process and its own queue. At most
`FURY_MAX_SESSIONS` sessions (default 3) hold a GPU at once; a session keeps its place until two
minutes after its last request, a little longer than its GPU stays on. A new session beyond the
limit gets `503 {"full": true}` without starting a GPU, and its page traces on the visitor's own
device. A page that names no session (one older than sessions) shares one.

1. Create a Modal account, add billing, and configure the workspace spending controls. Pricing
   is approximately $1.95 per L40S GPU-hour for each visitor's container while it runs, so up to
   about $5.85 an hour with three visitors at once, **plus CPU/RAM and idle time**. Scale-to-zero and rate limits do not enforce a
   dollar budget. Do not leave a test deployment running without approval.
2. Install `modal==1.1.4` with Python 3.11 and authenticate using `modal setup` or the
   `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` environment variables.
3. Deploy with **explicit allowed origins** (none are allowed by default at the gateway). Every
   Vercel deployment has its own URL besides the branch URL; a pattern like this one covers all
   of a project's preview URLs:

   ```sh
   cd render-server
   FURY_ALLOWED_ORIGINS='^https://<project>(-[a-z0-9-]+)?-<team-slug>\.vercel\.app$' modal deploy modal_app.py
   ```

   Set `VITE_CLOUD_RENDER_URL` to the printed **gateway** URL on the intended Vercel **preview
   branch only**, then build/deploy that preview. Do not enable production until tested and approved.
   No cloud URL means the existing local-only experience. `?cloud=0` also disables cloud rendering.
   If the gateway can't be reached, the browser traces on its own GPU instead.

Settings read during deployment:

| Variable               | Default       | Effect                                            |
| ---------------------- | ------------- | ------------------------------------------------- |
| `FURY_APP_NAME`        | `fury-render` | Use a separate name for preview/test deployments  |
| `FURY_ALLOWED_ORIGINS` | No origins    | Fully anchored regex for approved browser origins |
| `FURY_GPU`             | `L40S`        | GPUs per session; one renderer per GPU            |
| `FURY_MAX_SESSIONS`    | `3`           | Render sessions holding a GPU at once             |
| `FURY_IDLE_SECONDS`    | `60`          | GPU idle tail before scale-to-zero; billed time   |
| `FURY_DENOISE`         | `auto`        | `cpu` skips GPU denoising (it falls back anyway)  |

Stop a test with `modal app stop <app-name>` and confirm zero tasks with `modal app list`.
Never raise gateway `max_containers` above 1 without replacing the in-memory limits and the
session registry with shared durable counters.

## Deploying from GitHub

`.github/workflows/deploy-render-server.yml` runs `modal deploy` on every push to `main` or
`showroom` that touches `render-server/`, and on demand (Actions → Deploy render server → Run
workflow). It needs two repository secrets, `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` (Modal
dashboard → Settings → API tokens); the optional frame-store secrets and the `FURY_*` variables
are listed at the top of the workflow. The job summary prints the gateway URL to set as
`VITE_CLOUD_RENDER_URL` on Vercel.

## Frame store

Showroom stills (src/render/angles.ts) are fixed cameras, so a finished frame is the right image for
everyone who looks at the same design from the same angle. `fury_render/frames.py` keeps every
finished frame in an S3-compatible bucket in front of the renderer's volume: the renderer reads the
volume, then the bucket (back-filling the volume), and writes both; the **gateway** checks the bucket
first for `output: "frame"` requests and answers a hit itself, with `X-Cache: hit` and
`X-Cache-Store: gateway`, so a repeat never wakes a GPU. Configure at deploy time:

| Variable                                      | Meaning                                          |
| --------------------------------------------- | ------------------------------------------------ |
| `FURY_FRAME_BUCKET`                           | Bucket name (unset: volume only)                 |
| `FURY_FRAME_ENDPOINT`                         | S3-compatible endpoint (Cloudflare R2, MinIO, …) |
| `FURY_FRAME_PREFIX`                           | Key prefix, default `frames/`                    |
| `FURY_FRAME_REGION`                           | Region, default `auto`                           |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Credentials                                      |

Cloudflare R2 works well: `FURY_FRAME_ENDPOINT=https://<account>.r2.cloudflarestorage.com`,
`FURY_FRAME_REGION=auto`. A frame is about 0.2 MB; the popular space below is under 2 GB.

### Pre-warming

`npm run prewarm -- https://<deploy>.vercel.app [--pages 3]` (needs `npx playwright install chrome`)
opens the app with `?prewarm=…`, which steps through the five signature builds in every finish,
setting and time of day (src/render/prewarm.ts, about 840 designs) and renders every angle's
still. Roughly 10 s of GPU time per design: 2.5 hours on one GPU, so `--pages 3` with
`FURY_MAX_SESSIONS=3` finishes overnight. Run it after a catalog or material change.

## Timing

Every response carries `X-Boot-Ms` (how long the container took to become ready) and
`X-Container-Age-Ms` (how long ago that was); the first three responses after a boot also carry
`X-Cold: 1`. The gateway adds `X-Dispatch-Ms`, its wall time waiting on the GPU call, so
`X-Dispatch-Ms − X-Queue-Ms − X-Render-Ms` is Modal scheduling plus a cold container starting.
`GET /health` on the gateway reports its session table, and `GET /health?session=<id>` adds that
session's renderer state (device, denoiser, queue, boot time) when the session already holds a
GPU; it never starts one. Container boot phases print to `modal app logs` as `boot[<session>]:`.
The browser's `?traceStats=1` timeline reads all of these.

## Limits and caveats

- Scene data (geometry, textures, sky) is stored on the `fury-render-cache` volume, shared by every
  visitor and kept across cold starts, so the browser uploads a design's data only once.
- One container with one L40S for each render session. A container's GPUs are on one machine,
  and Modal warns that more than two per container usually means longer waits: an eight-L40S
  container stayed "scheduling" for over ten minutes, while a single L40S schedules in seconds.
  `FURY_GPU=L40S:2` gives each session two, with a Blender process on each (`FURY_WORKERS`)
  rendering whole frames side by side. A session's container reads the blobs and frames other
  sessions had committed to the volume when it started; whatever its own visitor still lacks they
  upload to it (the 409 protocol), so no volume reload is needed. Each visitor's first request
  starts their container cold. Max 15 seconds of Cycles sampling per view, 60 for a 360°
  panorama. Waiting renders go by priority: the visitor's frame, then the angles near it, then
  the rest; with `?spin=0`, previews, then views, then orbit pre-renders. Scene preparation,
  denoising, cold starts, finishing and idle time are additional billable work.
- Finished spin frames are kept on the volume (`/fury-cache/frames`, 4 GB, oldest pruned first)
  with their exposure reading, named by the SHA-256 of the scene, camera, size, quality and
  finish. A design anyone has seen from that angle comes back without a render.
- Gateway: global 600 render requests/minute (burst 240), 1 GiB of uploads/hour (burst 512 MiB).
  Missing-blob retries count as render requests. The render limit leaves room for each visitor's
  spin: about five frame requests open at a time, a few hundred per design. A busy answer (429 or 503) makes the browser wait two seconds and ask again; a full one (`"full": true`) makes it
  render on its own device.
- The gateway waits up to 180 seconds for the GPU, then answers 503 and **cancels** the Modal
  call (`fury_render/rpc.py`). A plain `.remote()` call would stay queued: while the GPU
  container was still "scheduling", calls the gateway had given up on minutes earlier were still
  pending, waiting to be rendered for no one. A call cancelled mid-render still finishes on its
  GPU (Blender can't be interrupted), and the worker stays taken until it does. A finished spin
  frame still goes into the frame cache, so asking again gets it without another render.
- These token buckets are in-process and reset when the gateway restarts/scales down. They reduce
  abuse but are **not durable quotas or a hard budget**. With no PIN, a script that ignores CORS
  could keep the GPU busy up to these limits; the Modal workspace spending limit caps the cost.
- Wire and expanded bodies are bounded: 32 MiB for scenes, 128 MiB for individual blobs.
  Texture URLs are never fetched by the server, preventing redirects/private-network SSRF.
- GPU failure falls back to local tracing where supported. WebGL retains the raster image. The
  spin gives up after three failed frames in a row and does not try again on that page.
- Rendered images stay gzip-compressed from the GPU method through the gateway to the browser
  (`fury_render/rpc.py`). At 1920×1200 that is about 4.9 MB instead of 18.4 MB raw. The browser
  asks for `"transfer": "file"`, which sends the image as a gzip file rather than with
  `Content-Encoding: gzip`, so it stays compressed in the browser's cache of orbit views too.
- A tiny 640×480/128-sample scene passed through the deployed gateway (then PIN-gated) to L40S/OptiX:
  660 ms rendering, 1.85 s HTTP round trip with a warm worker after blob uploads. That run
  predates GPU denoising and compressed transfer. It is not a full configurator benchmark:
  verify actual scenes, GPU denoising, and cold starts before launch.

## Local development and tests

The local server is intentionally unauthenticated and binds only to loopback. Do not expose it.

```sh
cd render-server
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt pytest
.venv/bin/python -m fury_render.local --device cpu
# Open the frontend with ?cloud=http://127.0.0.1:8787.
.venv/bin/python -m pytest -q
```

Gateway tests use a fake private dispatcher and verify that locked/malformed/rate-limited requests
never invoke it. Server tests exercise real CPU Cycles renders, uploads, image packing, camera
reuse and material edits. They do not replace deployed GPU or browser tests.

## Code map

- `fury_render/gateway.py`: CORS, request validation, pre-GPU request limits and the render
  sessions with a GPU.
- `modal_app.py`: CPU ASGI endpoint and private GPU RPC, persistent OptiX cache.
- `fury_render/rpc.py`: the private call, with compressed images kept compressed and abandoned
  calls cancelled.
- `fury_render/api.py`: missing-blob protocol, frame cache, priority queue over the workers and
  superseded-view handling.
- `fury_render/worker.py`: isolated Blender process, one per GPU; one render at a time each.
- `fury_render/finishing.py`: spin frames' exposure, bloom, AgX tone mapping, dither and WebP.
- `fury_render/blender.py`: geometry/material/light conversion and Cycles/OIDN rendering.
- `fury_render/protocol.py`: binary formats, validation and bounded decompression.
