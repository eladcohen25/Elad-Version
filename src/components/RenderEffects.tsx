import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  DataTexture,
  HalfFloatType,
  Matrix3,
  Matrix4,
  RGBAFormat,
  Vector2,
  Vector3,
  type PerspectiveCamera,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { Config, View } from '../lib/config'
import type { SkyLook } from '../lib/visuals'
import {
  createExposureMeter,
  createPipeline,
  createSpinPresent,
  createTracePresent,
  type Pipeline,
  type TracePresent,
} from '../render/pipeline'
import {
  CloudClient,
  CloudSession,
  cameraRecord,
  cloudUrl,
  type CloudCamera,
} from '../render/cloud'
import { EXTERIOR_FOV, cameraFraming } from '../render/framing'
import {
  SpinSession,
  spinView,
  type Decoded,
  type RasterMeter,
  type SpinState,
} from '../render/spin'
import { ANGLES, coverFit, frameSize, type Vec3 } from '../render/angles'
import { ShowroomSession, type AngleFrame, type ShowroomState } from '../render/showroom'
import { INTERIOR_EXPOSURE } from './Atmosphere'
import { onMaterialsChanged } from '../render/materials'
import {
  EXPORT_SAMPLES,
  EXPORT_TIMEOUT_MS,
  PathTraceSession,
  REST_SAMPLES,
  loadTracerModule,
  lookKey,
  sceneSignature,
} from '../render/pathtrace'
import type { Quality } from '../render/quality'
import { backendOf } from '../render/renderer'
import { TraceSession } from '../render/session'
import { textureProgress } from '../render/progress'
import {
  setAngleThumbnail,
  setPrerenderProgress,
  setSpinStatus,
  setTraceStatus,
} from '../render/traceStatus'
import { mark, markOnce } from '../render/timeline'

/** Median frame time (ms) of a settle run above which a tier is too heavy for this device. */
const SLOW_FRAME_MS: Record<Quality, number> = { ultra: 50, high: 75, lite: Infinity }
/**
 * Tracing starts once the view has held still for this many raster frames and REST_MS more. The
 * traced image replaces the raster one, so it need not wait for the raster settle run to finish.
 */
const TRACE_AFTER_FRAMES = 6
const REST_MS = 150
/** `?denoise=0` shows the raw accumulation, for comparing against the denoised image. */
const denoise = new URLSearchParams(window.location.search).get('denoise') !== '0'

export type Capture = () => Promise<string>
/** Requests made while an image is rendering share it. An empty image means none was made. */
type PendingCapture = { deadline: number; resolvers: ((image: string) => void)[] }

/**
 * Drives the frame. While the camera moves, the TSL raster pipeline renders on demand and keeps
 * drawing for a short settle window so temporal anti-aliasing, AO, and GI accumulate. Once the
 * view rests, path tracing takes over and crossfades in: on a cloud GPU when a render server is
 * configured, and progressively on this device where WebGPU is available (see TraceSession);
 * any camera or scene change hands back to the rasterizer.
 *
 * With `spin`, views are never shown with the rasterizer once the cloud has rendered them: the
 * exterior steps through the path-traced spin's frames and the interior is a 360° panorama
 * (spin.ts). The rasterizer only fills in until the first frame arrives.
 */
export function RenderEffects({
  quality,
  trace,
  look,
  config,
  view,
  dimensions,
  spin,
  showroom,
  onCaptureReady,
  onSlow,
}: {
  quality: Quality
  /** Path-trace resting views (on a cloud GPU, or locally with WebGPU). */
  trace: boolean
  look: SkyLook
  config: Config
  view: View
  dimensions: boolean
  /** Show the cloud's path-traced spin and panorama (spin.ts). */
  spin: boolean
  /**
   * The showroom (angles.ts): the angle being looked at and the build's hero direction. With a
   * cloud renderer its stills replace the raster frame as they arrive (showroom.ts); without one
   * the angles are simply fixed cameras for the real-time renderer and the local tracer.
   */
  showroom: { angle: string; hero: Vec3; cloud: boolean } | null
  onCaptureReady: (capture: Capture) => void
  /** Called once per tier when consecutive frames are consistently slow. */
  onSlow?: () => void
}) {
  const { gl, scene, camera, invalidate } = useThree()
  // The exterior OrbitControls (CameraRig): their target is the centre of pre-rendered orbits.
  const controls = useThree((state) => state.controls) as unknown as OrbitControlsImpl | null
  const renderer = gl as unknown as WebGPURenderer
  const webgpu = backendOf(renderer) === 'webgpu'
  const pipeline = useRef<Pipeline | null>(null)
  const [raster, setRaster] = useState<Pipeline | null>(null)
  const [session, setSession] = useState<TraceSession | null>(null)
  const present = useRef<TracePresent | null>(null)
  const mode = useRef<'raster' | 'trace'>('raster')
  const settle = useRef(0)
  /** Raster frames drawn since the view last changed. */
  const still = useRef(0)
  const lastView = useRef(new Matrix4())
  const lastProjection = useRef(new Matrix4())
  const changed = useRef(true)
  /** Whether the raster frame on screen (and in `hdr`) shows the current view. */
  const fresh = useRef(false)
  const rested = useRef(false)
  const restTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<PendingCapture | null>(null)
  const reported = useRef(0)
  const lookRef = useRef(look)
  const spinSize = useRef(new Vector2()).current
  const meterMatrix = useRef(new Matrix4()).current
  const meterEye = useRef(new Vector3()).current
  const meterTarget = useRef(new Vector3()).current
  const spinRotation = useRef(new Matrix3()).current
  const timing = useRef({ last: 0, samples: [] as number[], frames: 0, reported: false })
  useEffect(() => {
    lookRef.current = look
  }, [look])
  const deliver = (image: string) => {
    const capture = pending.current
    pending.current = null
    capture?.resolvers.forEach((resolve) => resolve(image))
  }
  // Thumbnails for the angle strip: the design version a thumbnail was taken for, per angle
  // ("final" stills count as a later version so they replace a preview or a raster snapshot).
  const thumbDesign = useRef(1)
  const thumbTaken = useRef(new Map<string, string>())
  const thumbCanvas = useRef<HTMLCanvasElement | null>(null)
  const thumbnail = (
    angle: string,
    source: CanvasImageSource,
    w: number,
    h: number,
    tag: string,
  ) => {
    if (thumbTaken.current.get(angle) === tag) return
    const canvas = (thumbCanvas.current ??= document.createElement('canvas'))
    canvas.width = 192
    canvas.height = Math.max(1, Math.round((192 * h) / w))
    const context = canvas.getContext('2d')
    if (!context) return
    try {
      context.drawImage(source, 0, 0, canvas.width, canvas.height)
      thumbTaken.current.set(angle, tag)
      setAngleThumbnail(angle, { url: canvas.toDataURL('image/jpeg', 0.82), design: tag })
    } catch {
      /* A tainted or unavailable source: the tile keeps its placeholder. */
    }
  }

  useEffect(() => {
    const created = createPipeline(renderer, scene, camera, quality)
    pipeline.current = created
    setRaster(created)
    settle.current = 0
    fresh.current = false
    mode.current = 'raster'
    timing.current = { last: 0, samples: [], frames: 0, reported: false }
    invalidate()
    return () => {
      pipeline.current = null
      created.dispose()
    }
  }, [renderer, scene, camera, quality, invalidate])

  // The local tracer loads on demand, and only where WebGPU compute is available. With a cloud
  // renderer, light devices leave all tracing to it.
  const remote = useMemo(() => cloudUrl(), [])
  // The spin, or the showroom's cloud stills, replace both while they work.
  const stills = !!showroom?.cloud && remote !== null
  const cloudAvailable = trace && remote !== null && !spin && !stills
  const localAvailable =
    webgpu && trace && !spin && !stills && (quality !== 'lite' || !cloudAvailable)
  useEffect(() => {
    if (!localAvailable && !cloudAvailable) return
    let active = true
    let created: TraceSession | null = null
    const local = localAvailable
      ? loadTracerModule()
          .then((module) => new PathTraceSession(renderer, module, denoise))
          .catch((error) => {
            console.warn('Path tracing is unavailable on this device.', error)
            return null
          })
      : Promise.resolve(null)
    local.then((tracer) => {
      if (!active) {
        tracer?.dispose()
        return
      }
      const cloud = cloudAvailable ? new CloudSession(renderer, remote!) : null
      if (cloud) cloud.onProgress = setPrerenderProgress
      if (!tracer && !cloud) return
      created = new TraceSession(tracer, cloud)
      setSession(created)
    })
    return () => {
      active = false
      created?.dispose()
      setSession(null)
      // Hand the canvas straight back to the rasterizer.
      mode.current = 'raster'
      changed.current = true
      invalidate()
      setTraceStatus({ state: 'off', source: 'local', samples: 0, target: 0, exporting: false })
      setPrerenderProgress(null)
    }
  }, [renderer, localAvailable, cloudAvailable, remote, invalidate])

  useEffect(() => {
    if (!session || !raster) return
    const created = createTracePresent(renderer, raster.hdr, session.texture)
    present.current = created
    // A view that settled before the tracer finished loading starts refining now.
    rested.current = true
    invalidate()
    return () => {
      present.current = null
      created.dispose()
    }
  }, [renderer, session, raster, invalidate])

  // The spin: its session, the pass that shows its frames, and a meter for the raster frame's
  // brightness, which the spin's exposure matches once per lighting look.
  const spinner = useRef<
    | {
        kind: 'spin'
        session: SpinSession
        present: ReturnType<typeof createSpinPresent>
        meter: ReturnType<typeof createExposureMeter>
      }
    | {
        kind: 'showroom'
        session: ShowroomSession
        present: ReturnType<typeof createSpinPresent>
        meter: ReturnType<typeof createExposureMeter>
      }
    | null
  >(null)
  /** What the spin shows: a frame, and the one it fades from. */
  const spinShown = useRef<{
    frame: Decoded | null
    mode: 'exterior' | 'interior'
    from: Texture | null
    start: number
  }>({ frame: null, mode: 'exterior', from: null, start: 0 })
  const sceneKey = useRef('')
  const sceneDirty = useRef(true)
  /** Waiting for the raster frame's brightness at a camera, which the next frame measures. */
  const meterWanted = useRef<
    { camera: CloudCamera | null; resolve: (meter: Promise<RasterMeter>) => void }[]
  >([])
  useEffect(() => {
    if ((!spin && !stills) || !remote) return
    const placeholder = new DataTexture(new Uint16Array(4), 1, 1, RGBAFormat, HalfFloatType)
    const present = createSpinPresent(renderer)
    const meter = createExposureMeter(renderer, placeholder)
    const created = stills
      ? ({
          kind: 'showroom',
          session: new ShowroomSession(new CloudClient(remote), invalidate),
          present,
          meter,
        } as const)
      : ({
          kind: 'spin',
          session: new SpinSession(new CloudClient(remote), invalidate),
          present,
          meter,
        } as const)
    spinner.current = created
    sceneDirty.current = true
    invalidate()
    return () => {
      spinner.current = null
      spinShown.current = { frame: null, mode: 'exterior', from: null, start: 0 }
      created.session.dispose()
      created.present.dispose()
      created.meter.dispose()
      placeholder.dispose()
      setSpinStatus(null)
      changed.current = true
      invalidate()
    }
  }, [spin, stills, remote, renderer, invalidate])

  // Any edit to the design hands the frame back to the rasterizer and re-captures before tracing.
  useEffect(() => {
    changed.current = true
    sceneDirty.current = true
    thumbDesign.current++
    invalidate()
  }, [config, view, dimensions, invalidate])

  useEffect(
    () =>
      onMaterialsChanged((change) => {
        settle.current = 0
        sceneDirty.current = true
        if (change === 'textures') {
          changed.current = true
          session?.invalidate()
        }
        invalidate()
      }),
    [invalidate, session],
  )

  useEffect(() => {
    onCaptureReady(() => {
      // The spin's full-quality frame, once it is on screen.
      if (spinner.current)
        return new Promise<string>((resolve) => {
          if (pending.current) pending.current.resolvers.push(resolve)
          else
            pending.current = {
              deadline: performance.now() + EXPORT_TIMEOUT_MS,
              resolvers: [resolve],
            }
          invalidate()
        })
      if (!session || !present.current) {
        pipeline.current?.render()
        return Promise.resolve(renderer.domElement.toDataURL('image/png'))
      }
      return new Promise<string>((resolve) => {
        if (pending.current) pending.current.resolvers.push(resolve)
        else
          pending.current = {
            deadline: performance.now() + EXPORT_TIMEOUT_MS,
            resolvers: [resolve],
          }
        if (mode.current !== 'trace') rested.current = true
        invalidate()
      })
    })
  }, [renderer, session, onCaptureReady, invalidate])

  useEffect(
    () => () => {
      if (restTimer.current) clearTimeout(restTimer.current)
      // An export never waits on a scene that is gone.
      const capture = pending.current
      pending.current = null
      capture?.resolvers.forEach((resolve) => resolve(''))
    },
    [],
  )

  useFrame(() => {
    const active = pipeline.current
    if (!active) return
    const now = performance.now()
    const tracer = session && present.current ? session : null
    const report = (force = false) => {
      if (!force && now - reported.current < 200) return
      reported.current = now
      setTraceStatus({
        state: tracer && mode.current === 'trace' ? tracer.state : 'off',
        source: tracer?.source ?? 'local',
        samples: tracer?.samples ?? 0,
        target: tracer?.target ?? 0,
        exporting: pending.current !== null,
      })
    }
    // Controls move the camera without refreshing its world matrix, and while tracing nothing
    // renders through it, so refresh it before checking for movement.
    camera.updateMatrixWorld()

    // The path-traced spin and panorama.
    const spinning = spinner.current
    if (spinning) {
      const cam = camera as PerspectiveCamera
      const size = renderer.getDrawingBufferSize(spinSize)
      const aspect = size.x / size.y
      const inside = cameraFraming(config, 'interior', [0, 0, 0], aspect)
      // The panorama has about the screen's pixel density at the interior's field of view.
      const across = 2 * Math.atan(Math.tan((inside.fov * Math.PI) / 360) * aspect)
      const panoramaWidth = Math.round((size.x * 2 * Math.PI) / across / 16) * 16
      const outside = renderer.toneMappingExposure / (view === 'interior' ? INTERIOR_EXPOSURE : 1)
      if (sceneDirty.current) {
        sceneKey.current = String(sceneSignature(scene, lookKey(lookRef.current)))
        sceneDirty.current = false
      }
      const looking = view === 'interior' ? 'interior' : 'exterior'
      const textures = textureProgress.get()
      const rasterKey = (at: CloudCamera | null) =>
        new Promise<RasterMeter>((resolve) => {
          meterWanted.current.push({ camera: at, resolve })
          invalidate()
        })
      // Scanned materials still streaming in: the stills wait for them (each arrival redraws).
      const settled = textures.loaded >= textures.requested
      if (spinning.kind === 'showroom') {
        // Every angle's camera, as CameraRig frames it, at the still size for this screen.
        const still = frameSize(size.x, size.y)
        const frames: AngleFrame[] = ANGLES.map((angle) => {
          const framing = cameraFraming(
            config,
            angle.view,
            angle.direction ?? showroom!.hero,
            still.aspect,
            { eye: angle.eye, zoom: angle.zoom },
          )
          return {
            id: angle.id,
            view: angle.view,
            camera: {
              matrix: meterMatrix
                .lookAt(
                  meterEye.set(...framing.position),
                  meterTarget.set(...framing.target),
                  camera.up,
                )
                .setPosition(meterEye)
                .toArray(),
              fov: framing.fov,
              near: cam.near,
              far: cam.far,
            },
            width: still.width,
            height: still.height,
          }
        })
        const state: ShowroomState = {
          angle: showroom!.angle,
          frames,
          exposure: { exterior: outside, interior: outside * INTERIOR_EXPOSURE },
        }
        spinning.session.sync(scene, lookRef.current, sceneKey.current, state, rasterKey, settled)
      } else {
        const state: SpinState = {
          active: looking,
          exterior:
            spinView.spec && spinView.pose
              ? {
                  spec: spinView.spec,
                  pose: spinView.pose,
                  width: size.x,
                  height: size.y,
                  lens: { fov: EXTERIOR_FOV, near: cam.near, far: cam.far },
                }
              : null,
          interior: {
            eye: new Vector3(...inside.position),
            width: Math.min(8192, Math.max(2048, panoramaWidth)),
            lens: { fov: inside.fov, near: cam.near, far: cam.far },
            view: {
              matrix: meterMatrix
                .lookAt(
                  meterEye.set(...inside.position),
                  meterTarget.set(...inside.target),
                  camera.up,
                )
                .setPosition(meterEye)
                .toArray(),
              fov: inside.fov,
              near: cam.near,
              far: cam.far,
            },
          },
          exposure: { exterior: outside, interior: outside * INTERIOR_EXPOSURE },
        }
        spinning.session.sync(scene, lookRef.current, sceneKey.current, state, rasterKey, settled)
      }
      if (meterWanted.current.length) {
        // The raster frame for this look at each camera asked for (the interior's while the
        // visitor is outside: only the camera and exposure differ between views), rendered a few
        // times so its temporal effects settle, and measured. The camera is put back, and a
        // path-traced frame drawn below replaces the raster one before it is seen.
        const position = cam.position.clone()
        const quaternion = cam.quaternion.clone()
        const fov = cam.fov
        const frames = Math.min(16, Math.max(4, active.settleFrames))
        for (const { camera: at, resolve } of meterWanted.current.splice(0)) {
          if (at) {
            meterMatrix.fromArray(at.matrix).decompose(cam.position, cam.quaternion, meterEye)
            cam.fov = at.fov
            cam.updateProjectionMatrix()
            cam.updateMatrixWorld()
          }
          for (let i = 0; i < frames; i++) active.render()
          const record = at ?? cameraRecord(cam)
          resolve(
            spinning.meter
              .measure(active.hdr, false)
              .then((key) => ({ key, camera: record, width: size.x, height: size.y })),
          )
          cam.position.copy(position)
          cam.quaternion.copy(quaternion)
          cam.fov = fov
          cam.updateProjectionMatrix()
          cam.updateMatrixWorld()
        }
      }
      const frame = spinning.session.texture()
      const shown = spinShown.current
      if (frame && frame !== shown.frame) {
        if (spinning.session.isFocus(frame))
          markOnce(`spin-focus-${frame.final ? 'final' : 'preview'}-shown`, {
            key: frame.key,
            final: frame.final,
            view: looking,
          })
        else markOnce('spin-nearest-frame-shown', { key: frame.key, view: looking })
        // A better image of the same frame, or the first one after a design change, fades in;
        // stepping to the next frame of the spin cuts to it.
        const fades =
          shown.frame &&
          shown.mode === looking &&
          (frame.key === shown.frame.key || frame.design !== shown.frame.design)
        spinShown.current = {
          frame,
          mode: looking,
          from: fades ? shown.frame!.texture : null,
          start: now,
        }
      }
      const current = spinShown.current
      // Until the next frame is decoded the last one stays, in the same view only.
      if (current.frame && current.mode === looking) {
        const t = current.from ? Math.min(1, (now - current.start) / 300) : 1
        const image = current.frame.texture.image as { width?: number; height?: number }
        spinning.present.render({
          from: t < 1 ? current.from : null,
          to: current.frame.texture,
          t,
          panorama:
            spinning.kind === 'spin' && looking === 'interior'
              ? {
                  rotation: spinRotation.setFromMatrix4(camera.matrixWorld),
                  tanHalfFov: Math.tan((cam.fov * Math.PI) / 360),
                  aspect: cam.aspect,
                }
              : null,
          fit:
            spinning.kind === 'showroom' && image.width && image.height
              ? coverFit(image.width / image.height, size.x / size.y)
              : undefined,
        })
        spinning.session.hold(
          t < 1 && current.from ? [current.frame.texture, current.from] : [current.frame.texture],
        )
        if (spinning.kind === 'showroom' && showroom && spinning.session.isFocus(current.frame)) {
          const image = current.frame.texture.image as ImageBitmap
          if (image?.width)
            thumbnail(
              showroom.angle,
              image,
              image.width,
              image.height,
              `${current.frame.design}|${current.frame.final ? 'final' : 'preview'}`,
            )
        }
        if (t < 1) invalidate()
        const capture = pending.current
        // The full-quality frame of the view itself, not the nearest one standing in for it.
        const exact = current.frame.final && spinning.session.isFocus(current.frame)
        if (capture && (exact || now > capture.deadline))
          deliver(renderer.domElement.toDataURL('image/png'))
        else if (capture) invalidate()
        setSpinStatus({
          active: true,
          ...spinning.session.progress,
          panorama: spinning.kind === 'spin' && looking === 'interior',
          showing: true,
        })
        return
      }
      setSpinStatus({
        active: true,
        ...spinning.session.progress,
        panorama: spinning.kind === 'spin' && looking === 'interior',
        showing: false,
      })
      // Nothing path traced to show yet: the raster frame, which the exposure meter also reads.
    }
    const moved =
      !lastView.current.equals(camera.matrixWorld) ||
      !lastProjection.current.equals(camera.projectionMatrix)
    if (moved || changed.current) {
      lastView.current.copy(camera.matrixWorld)
      lastProjection.current.copy(camera.projectionMatrix)
      changed.current = false
      if (restTimer.current) clearTimeout(restTimer.current)
      restTimer.current = null
      rested.current = pending.current !== null
      settle.current = 0
      still.current = 0
      fresh.current = false
      if (mode.current === 'trace') {
        mode.current = 'raster'
        tracer?.halt()
        report(true)
      }
    }

    // Path-traced refinement of a resting view.
    if (mode.current === 'trace' && tracer) {
      const refining = tracer.step()
      const traced = tracer.view(now)
      // Until the first traced image is ready the canvas keeps the last raster frame.
      if (traced.from || traced.t > 0) {
        markOnce('first-traced-image', { source: tracer.source, samples: tracer.samples, view })
        present.current!.render(traced)
      }
      const capture = pending.current
      if (capture && (tracer.ready(EXPORT_SAMPLES) || now > capture.deadline))
        deliver(renderer.domElement.toDataURL('image/png'))
      report(!refining)
      if (refining || pending.current) invalidate()
      return
    }

    if (rested.current && tracer && fresh.current) {
      rested.current = false
      mode.current = 'trace'
      // Resting exterior views sit on the orbit grid (CameraRig snaps to it), so they can be
      // pre-rendered; not while auto-rotating.
      const orbit =
        view === 'exterior' && controls && !controls.autoRotate
          ? { target: controls.target.clone() }
          : null
      tracer.begin(scene, camera, lookRef.current, active.hdr, REST_SAMPLES, orbit)
      mark('trace-begin', { source: tracer.source, view })
      report(true)
      invalidate()
      return
    }

    // Raster rendering with a settle run after every change.
    const chained = settle.current > 0
    if (settle.current <= 0) settle.current = active.settleFrames
    active.render()
    markOnce('first-raster-frame', { quality, view })
    fresh.current = true
    settle.current--
    still.current++
    // A settled real-time frame of a posed angle stands in for its thumbnail until a still does.
    if (showroom && !stills && settle.current <= 0) {
      const el = renderer.domElement
      thumbnail(showroom.angle, el, el.width, el.height, `raster-${thumbDesign.current}`)
    }
    if (settle.current > 0) invalidate()
    if (tracer) {
      if (!restTimer.current && (settle.current <= 0 || still.current >= TRACE_AFTER_FRAMES))
        restTimer.current = setTimeout(() => {
          rested.current = true
          invalidate()
        }, REST_MS)
    } else if (settle.current <= 0 && pending.current)
      deliver(renderer.domElement.toDataURL('image/png'))
    // Back-to-back settle frames measure what this GPU can sustain at this tier. The first frames
    // after a pipeline is built include shader compilation and are ignored.
    const t = timing.current
    t.frames++
    if (chained && t.last && t.frames > 8 && !t.reported) {
      t.samples.push(now - t.last)
      if (t.samples.length >= 16) {
        const sorted = [...t.samples].sort((a, b) => a - b)
        if (sorted[sorted.length >> 1] > SLOW_FRAME_MS[quality]) {
          t.reported = true
          onSlow?.()
        }
        t.samples = []
      }
    }
    t.last = now
  }, 1)
  return null
}
