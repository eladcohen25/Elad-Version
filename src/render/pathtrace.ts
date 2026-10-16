import {
  DataTexture,
  EquirectangularReflectionMapping,
  FloatType,
  LinearFilter,
  MeshStandardMaterial,
  RGBAFormat,
  RectAreaLight,
  RenderTarget,
  StorageTexture,
  Vector2,
  Vector3,
  type Camera,
  type Material,
  type PerspectiveCamera,
  type Mesh,
  type Object3D,
  type Scene,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import type { WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu'
import {
  SUN_ANGULAR_RADIUS,
  SUN_INTENSITY,
  environmentRadiance,
  equirectRadiance,
  studioRadiance,
  type SkyLook,
} from '../lib/visuals'
import { AdaptiveSampler, MIN_SETTLE_SAMPLES } from './adaptive'
import { GBuffer, ViewHistory } from './history'
import { createExposureMeter } from './pipeline'
import type { TraceState } from './traceStatus'

/**
 * Progressive path tracing of the live scene, used whenever the camera rests and for exports.
 *
 * The tracer captures geometry, materials, and lights once per scene revision, so anything the
 * path tracer should see differently from the rasterizer is swapped in only for that capture:
 *
 * - `object.userData.pathTrace = false` hides an object (the raster sky dome, helpers).
 * - `material.userData.pathTrace = { ... }` overrides material properties, so node materials whose
 *   look lives in TSL (foliage atlases, the scanned ground, the planar mirror) expose plain
 *   physically based values the tracer can read.
 * - Meshes with unlit materials (lines, labels, the sky) are hidden automatically.
 * - Volumetric glass becomes thin-walled glass tinted by its absorption, since panes are modeled
 *   as open sheets rather than closed solids.
 * - The sun becomes a distant disc of its true angular size, so shadows soften with distance and
 *   glossy surfaces show a real sun glint, while the sky arrives as an HDR radiance map with the
 *   same clouds as the raster sky.
 */

/** `?traceStats=1` logs, per view, when the first traced image appeared and when it settled. */
const TRACE_STATS = new URLSearchParams(window.location.search).get('traceStats') === '1'

/**
 * Samples per pixel at which a resting view stops refining. With the denoiser, 256 is visually
 * settled at screen resolution; going on to 1024 kept the GPU at full load for the better part
 * of a minute on a laptop (fans spinning, battery draining) for no visible gain.
 */
export const REST_SAMPLES = 256
/** Samples per pixel an exported still waits for (or until EXPORT_TIMEOUT_MS). */
export const EXPORT_SAMPLES = 256
export const EXPORT_TIMEOUT_MS = 30000
/**
 * A resting view stops refining after this long even if REST_SAMPLES is not reached: a slow GPU
 * is not asked to run flat out indefinitely for a view the visitor may already have moved on from.
 */
export const REST_TIME_MS = 10000

type TracerModule = typeof import('three-gpu-pathtracer/webgpu')
type Modules = { tracer: TracerModule; initUNetFromURL: unknown }
let modules: Promise<Modules> | null = null
/** The tracer and denoiser load on demand so they never weigh on the first paint. */
export function loadTracerModule() {
  modules ??= Promise.all([
    import('three-gpu-pathtracer/webgpu'),
    import('oidn-web').catch(() => null),
  ]).then(([tracer, oidn]) => ({ tracer, initUNetFromURL: oidn?.initUNetFromURL ?? null }))
  return modules
}
/** Open Image Denoise weights (RT filter, HDR color guided by albedo and normals). */
export const DENOISER_WEIGHTS = `${import.meta.env.BASE_URL}denoise/rt_hdr_alb_nrm.tza`

/** Distance of the stand-in sun disc; far enough that it subtends the same angle everywhere. */
const SUN_DISTANCE = 12000
const ENV_WIDTH = 1024
const ENV_HEIGHT = 512
/**
 * Most passes per batch. Once most pixels have converged a pass is cheap, so batches grow until
 * they keep the GPU busy for about two display frames.
 */
const MAX_PASSES = 64
/** Wavefront path slots per dispatch: ~300 bytes each, so this stays under 128 MB bindings. */
const FRAME_BUDGET = 262144

type Restore = () => void
const placeholder = new MeshStandardMaterial()

function isLit(material: Material) {
  const m = material as Material & {
    isMeshStandardMaterial?: boolean
    isMeshStandardNodeMaterial?: boolean
  }
  return Boolean(m.isMeshStandardMaterial || m.isMeshStandardNodeMaterial)
}

/** Temporarily assigns properties, returning a function that puts the old values back. */
function assign(target: object, values: Record<string, unknown>, restores: Restore[]) {
  const record = target as Record<string, unknown>
  const previous: Record<string, unknown> = {}
  for (const key of Object.keys(values)) previous[key] = record[key]
  Object.assign(record, values)
  restores.push(() => Object.assign(record, previous))
}

/** Thin-walled equivalent of a volumetric glass: its absorption across the pane becomes a tint. */
export function thinGlass(material: Material & Record<string, unknown>) {
  const thickness = (material.thickness as number) ?? 0
  const distance = (material.attenuationDistance as number) ?? Infinity
  if (!(thickness > 0) && distance === Infinity) return null
  const color = (material.color as { clone: () => { r: number; g: number; b: number } }).clone()
  const attenuation = material.attenuationColor as { r: number; g: number; b: number } | undefined
  if (attenuation && distance < Infinity && thickness > 0) {
    const depth = thickness / distance
    color.r *= Math.pow(attenuation.r, depth)
    color.g *= Math.pow(attenuation.g, depth)
    color.b *= Math.pow(attenuation.b, depth)
  }
  return { thickness: 0, attenuationDistance: Infinity, color }
}

/** The sun as path tracers see it, or null when it is down or the setting is the studio. */
export function sunLight(look: SkyLook) {
  const { sunlight } = look
  if (sunlight.intensity <= 1e-4 || look.environment === 'studio') return null
  return {
    /** Unit vector toward the sun. */
    direction: [...sunlight.direction] as [number, number, number],
    color: [...sunlight.color] as [number, number, number],
    irradiance: SUN_INTENSITY * sunlight.intensity,
    angularRadius: SUN_ANGULAR_RADIUS,
  }
}

/**
 * Swaps the scene into its path-traced form and returns a function that restores it. Everything
 * happens synchronously around the tracer's capture, so the rasterizer never sees the swap.
 */
export function preparePathTraceScene(scene: Scene, look: SkyLook, environment: Texture) {
  const restores: Restore[] = []
  const seen = new Set<Material>()
  scene.traverse((object: Object3D) => {
    const excluded = object.userData.pathTrace === false
    if (excluded && object.visible) assign(object, { visible: false }, restores)
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const traceable = materials.every((m) => m.userData.pathTrace || isLit(m))
    if (excluded || !traceable) {
      // The tracer still indexes hidden meshes' materials, so give them a plain one.
      assign(mesh, { visible: false, material: placeholder }, restores)
      return
    }
    for (const material of materials) {
      if (seen.has(material)) continue
      seen.add(material)
      const override = material.userData.pathTrace as Record<string, unknown> | undefined
      if (override) assign(material, override, restores)
      const record = material as Material & Record<string, unknown>
      if (((record.transmission as number) ?? 0) > 0) {
        const thin = thinGlass(record)
        if (thin) assign(material, thin, restores)
      }
    }
  })

  // The sun as a disc light at its true angular size, replacing the raster directional light.
  const sunlight = sunLight(look)
  if (sunlight) {
    const radius = SUN_DISTANCE * Math.tan(sunlight.angularRadius)
    const sun = new RectAreaLight(0xffffff, 1, radius * 2, radius * 2) as RectAreaLight & {
      isCircular: boolean
    }
    sun.isCircular = true
    sun.userData.sun = true
    sun.color.setRGB(...sunlight.color)
    // A disc of radius r at distance d subtends π r²/d², so radiance = irradiance / solid angle.
    sun.intensity =
      sunlight.irradiance / ((Math.PI * radius * radius) / (SUN_DISTANCE * SUN_DISTANCE))
    sun.position.copy(new Vector3(...sunlight.direction).multiplyScalar(SUN_DISTANCE))
    sun.lookAt(0, 0, 0)
    sun.updateMatrixWorld()
    scene.add(sun)
    restores.push(() => scene.remove(sun))
  }

  assign(
    scene,
    {
      environment,
      background: environment,
      environmentIntensity: 1,
      backgroundIntensity: 1,
      backgroundBlurriness: 0,
    },
    restores,
  )
  return () => {
    for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  }
}

/**
 * Cheap fingerprints of what the tracer captures, one per kind of change, so an edit rebuilds
 * only what it touched: meshes appearing, disappearing, or changing shape need a new capture
 * (BVH and kernels), while moved objects, changed finishes, and changed lights are updated in
 * place.
 */
export type SceneParts = {
  structure: number
  transforms: number
  materials: number
  lights: number
}

export function sceneParts(scene: Scene): SceneParts {
  const hash = {
    structure: 2166136261,
    transforms: 2166136261,
    materials: 2166136261,
    lights: 2166136261,
  }
  const mix = (part: keyof SceneParts, value: number) => {
    hash[part] = Math.imul(hash[part] ^ Math.round(value * 1000), 16777619)
  }
  scene.traverse((object) => {
    mix('structure', object.id)
    mix('structure', object.visible ? 1 : 0)
    // Every element separately: a weighted sum cancels for some moves, such as a floor-plan
    // drag of (4.25, -2.75) ft.
    for (const element of object.matrixWorld.elements) mix('transforms', element)
    const mesh = object as Mesh & {
      instanceMatrix?: { version: number }
      count?: number
    }
    if (mesh.isMesh) {
      mix('structure', mesh.geometry.id)
      mix('structure', mesh.instanceMatrix?.version ?? 0)
      mix('structure', mesh.count ?? 0)
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        const m = material as Material & { id: number; emissiveIntensity?: number }
        mix('materials', m.id)
        mix('materials', material.version)
        mix('materials', m.emissiveIntensity ?? 0)
      }
    }
    const light = object as Object3D & {
      isLight?: boolean
      intensity?: number
      color?: { r: number; g: number; b: number }
    }
    if (light.isLight) {
      mix('lights', light.intensity ?? 0)
      mix('lights', (light.color?.r ?? 0) + (light.color?.g ?? 0) * 3 + (light.color?.b ?? 0) * 7)
    }
  })
  return {
    structure: hash.structure >>> 0,
    transforms: hash.transforms >>> 0,
    materials: hash.materials >>> 0,
    lights: hash.lights >>> 0,
  }
}

/** One fingerprint of everything the tracer captures, including the sky and sun. */
export function sceneSignature(scene: Scene, lookKey: string) {
  const parts = sceneParts(scene)
  let hash = 2166136261
  const mix = (value: number) => {
    hash = Math.imul(hash ^ value, 16777619)
  }
  for (let i = 0; i < lookKey.length; i++) mix(lookKey.charCodeAt(i))
  for (const value of Object.values(parts)) mix(value)
  return hash >>> 0
}

const environmentCache = new Map<string, DataTexture>()
/** The site's radiance as an equirect HDR map, built on the CPU from the analytic sky. */
export function environmentTexture(look: SkyLook) {
  const key = lookKey(look)
  const cached = environmentCache.get(key)
  if (cached) return cached
  const data = equirectRadiance(
    ENV_WIDTH,
    ENV_HEIGHT,
    look.environment === 'studio' ? studioRadiance : (d) => environmentRadiance(d, look),
  )
  const texture = new DataTexture(data, ENV_WIDTH, ENV_HEIGHT, RGBAFormat, FloatType)
  texture.mapping = EquirectangularReflectionMapping
  texture.minFilter = texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  // Keep only a handful: each map is 8 MB.
  if (environmentCache.size >= 4) {
    const [oldest] = environmentCache.keys()
    environmentCache.get(oldest)?.dispose()
    environmentCache.delete(oldest)
  }
  environmentCache.set(key, texture)
  return texture
}

export function lookKey(look: SkyLook) {
  return `${look.environment}|${look.sunlight.direction.map((v) => v.toFixed(4)).join(',')}|${look.night.toFixed(3)}`
}

type GPUBackend = {
  device: {
    queue: {
      writeTexture: (
        destination: { texture: unknown },
        data: ArrayBufferView,
        layout: { bytesPerRow: number; rowsPerImage: number },
        size: number[],
      ) => void
    }
  }
  get: (texture: Texture) => { texture?: unknown }
}

/** Uploads zeros to an rgba16float 3D texture so it counts as initialized. */
function zeroFill(renderer: WebGPURenderer, texture: Texture) {
  const { width, height, depth } = texture.image as { width: number; height: number; depth: number }
  renderer.initTexture(texture)
  const backend = renderer.backend as unknown as GPUBackend
  const gpuTexture = backend.get(texture).texture
  if (!gpuTexture) return
  backend.device.queue.writeTexture(
    { texture: gpuTexture },
    new Uint16Array(width * height * depth * 4),
    { bytesPerRow: width * 8, rowsPerImage: height },
    [width, height, depth],
  )
}

/**
 * Accumulation milestones at which the image is denoised and crossfaded in. They double, so
 * each denoised image can be compared with the last to find the regions that have settled.
 */
const MILESTONES = [8, 16, 32, 64, 128, 256, 512, 1024].filter((m) => m <= REST_SAMPLES)
/**
 * A view seeded from the previous one is mostly converged from the start; only what that view did
 * not show is new, so its first image is denoised almost at once.
 */
const SEEDED_MILESTONES = [2, ...MILESTONES]
/** Crossfade between successive images, in milliseconds. */
const FADE_MS = 520

type Denoiser = InstanceType<TracerModule['OIDNDenoiser']>
/** What to put on screen: `from` (null for the frozen raster frame) blending into `to`. */
export type TraceView = { from: Texture | null; to: Texture; t: number; gain: number }
/** The traced image may brighten by two stops or darken by one to match the raster frame. */
const GAIN_RANGE = [0.5, 4] as const

/**
 * One path tracer bound to a renderer, re-capturing the scene only when it actually changed.
 *
 * Accumulation runs continuously while the view rests. At each milestone the accumulated image is
 * copied aside and run through Open Image Denoise (guided by rasterized albedo and normals), and
 * the clean result crossfades over the previous one, so the view develops from the raster frame
 * into a converged photograph without ever showing path-tracing noise. Two denoisers alternate,
 * so the image on screen stays valid while the next one is computed. If the denoiser cannot run,
 * the raw accumulation fades in instead.
 */
export class PathTraceSession {
  readonly tracer: WebGPUPathTracer
  private readonly renderer: WebGPURenderer
  /** Absorbs the tracer's own presentation; the app composites the images itself. */
  private readonly sink = new RenderTarget(1, 1)
  private readonly denoisers: Denoiser[]
  private snapshot: StorageTexture | null = null
  /** The current view's rasterized albedo, normals, and positions (denoiser guides, reuse). */
  private readonly gbuffer = new GBuffer()
  /** The last traced view, reprojected into the next one so it never starts from nothing. */
  private readonly history = new ViewHistory()
  /** Whether the current view started from the previous view's samples. */
  seeded = false
  /** Retires regions whose denoised image has settled, so samples go where it still changes. */
  private readonly adaptive = new AdaptiveSampler()
  private scene: Scene | null = null
  private camera: Camera | null = null
  private running: { index: number; samples: number } | null = null
  private shownIndex = -1
  private denoiseFailed = false
  private transition: { from: Texture | null; to: Texture | null; start: number } = {
    from: null,
    to: null,
    start: 0,
  }
  private readonly meter: ReturnType<typeof createExposureMeter>
  /** Exposure match for the traced images; null until metered for this view. */
  private gain: number | null = null
  private rasterKey: Promise<number> | null = null
  private metering = false
  private signature = -1
  /** What the tracer holds: the scene parts and sky it last captured or updated. */
  private captured: { parts: SceneParts; look: string } | null = null
  /** Bumped per view, so readbacks that land after the camera moved are ignored. */
  private epoch = 0
  /** When this view started tracing, and when its first traced image appeared. */
  private timing = { start: 0, first: 0 }
  private frames = 0
  private passes = 1
  private inFlight = false
  private measuring = false
  private accumulating = false
  /** Samples per pixel reached by every pixel. */
  samples = 0
  /** Samples behind the image currently on screen. */
  shownSamples = 0
  target = REST_SAMPLES
  state: TraceState = 'off'

  constructor(renderer: WebGPURenderer, modules: Modules, denoise = true) {
    this.renderer = renderer
    this.meter = createExposureMeter(renderer, this.sink.texture)
    const module = modules.tracer
    const tracer = new module.WebGPUPathTracer(renderer)
    tracer.frameBudget = FRAME_BUDGET
    // Six bounces: a unit under an open sky gathers nearly all its light in three or four, and
    // each extra bounce costs a full pass. (The cloud renderer keeps its own bounce settings.)
    tracer.maxBounces = 6
    tracer.maxTransparentBounces = 8
    tracer.filterGlossyFactor = 0.5
    tracer.transmissiveBackground = module.TRANSMISSIVE_BACKGROUND_ENVIRONMENT
    // The session crossfades from the raster image itself, so skip the tracer's low-res preview.
    tracer.dynamicLowRes = false
    tracer.renderDelay = 0
    tracer.minSamples = 4
    tracer.fadeDuration = FADE_MS
    tracer.maxSamples = REST_SAMPLES
    // The GGX energy table is a 3D storage texture sampled without mipmaps. Keep three from
    // regenerating mipmaps after each compute write, and fill it once up front so the GPU never
    // lazily zero-fills it on first use: some Dawn backends do that through a 2D view, which is
    // invalid for a 3D texture and fails every dispatch that touches the table.
    const table = (tracer as unknown as { material: { turquinTexture: Texture } }).material
      .turquinTexture as Texture & { mipmapsAutoUpdate: boolean }
    table.generateMipmaps = false
    table.mipmapsAutoUpdate = false
    zeroFill(renderer, table)
    this.tracer = tracer
    this.denoisers =
      denoise && modules.initUNetFromURL
        ? [0, 1].map(() => {
            const denoiser = new module.OIDNDenoiser({
              initUNetFromURL: modules.initUNetFromURL as never,
              auxWeightsUrl: DENOISER_WEIGHTS,
            })
            denoiser.init(renderer)
            return denoiser
          })
        : []
  }

  /** Starts refining the current view, re-capturing the scene only if it changed. */
  begin(scene: Scene, camera: Camera, look: SkyLook, raster: Texture, target = REST_SAMPLES) {
    const key = lookKey(look)
    const parts = sceneParts(scene)
    const signature = sceneSignature(scene, key)
    this.state = 'preparing'
    const last = this.captured
    if (!last || last.parts.structure !== parts.structure) {
      // New or reshaped meshes: build the BVH and kernels again.
      const restore = preparePathTraceScene(scene, look, environmentTexture(look))
      try {
        this.tracer.setScene(scene, camera)
      } finally {
        restore()
      }
    } else if (signature !== this.signature) {
      // Same meshes: update in place only what changed, keeping the BVH and compiled kernels.
      const moved = last.parts.transforms !== parts.transforms
      const sky = last.look !== key
      const restore = preparePathTraceScene(scene, look, environmentTexture(look))
      try {
        if (moved) this.tracer.updateTransforms()
        if (last.parts.materials !== parts.materials) this.tracer.updateMaterials()
        if (sky) this.tracer.updateEnvironment()
        if (sky || moved || last.parts.lights !== parts.lights) this.tracer.updateLights()
      } finally {
        restore()
      }
      this.tracer.updateCamera()
    } else {
      this.tracer.updateCamera()
    }
    // Samples of a different design, time of day, or texture set describe a different image.
    if (signature !== this.signature) this.history.clear()
    this.signature = signature
    this.captured = { parts, look: key }
    this.epoch++
    this.scene = scene
    this.camera = camera
    this.target = target
    this.tracer.maxSamples = target
    // Size the accumulation now rather than on the first sample, which would clear the seed.
    const { width, height } = this.syncSize()
    this.tracer.reset()
    this.gbuffer.render(this.renderer, scene, camera as PerspectiveCamera, width, height)
    this.seeded = this.history.seed(
      this.renderer,
      this.backend,
      this.gbuffer,
      this.signature,
      target,
    )
    this.adaptive.reset()
    for (const denoiser of this.denoisers) denoiser.reset()
    this.running = null
    this.shownIndex = -1
    this.shownSamples = 0
    this.transition = { from: null, to: null, start: 0 }
    this.samples = 0
    this.frames = 0
    this.passes = 1
    this.accumulating = true
    this.gain = null
    this.metering = false
    this.measuring = false
    // Meter the frozen raster frame now, before anything else draws over the GPU's time.
    this.rasterKey = this.meter.measure(raster, false).catch(() => NaN)
    this.state = 'tracing'
    this.timing = { start: performance.now(), first: 0 }
  }

  /** The tracer's accumulation targets. */
  private get backend() {
    return (
      this.tracer as unknown as {
        _pathTracer: {
          outputTarget: StorageTexture
          sampleCountTarget: StorageTexture
          setSize: (w: number, h: number) => boolean
        }
      }
    )._pathTracer
  }

  /** Allocates the accumulation at the size the tracer is about to render at. */
  private syncSize() {
    const size = this.renderer.getDrawingBufferSize(new Vector2())
    const width = Math.max(1, Math.floor(this.tracer.renderScale * size.x))
    const height = Math.max(1, Math.floor(this.tracer.renderScale * size.y))
    this.tracer.setSize(width, height)
    this.backend.setSize(width, height)
    return { width, height }
  }

  private get denoising() {
    return this.denoisers.length > 0 && !this.denoiseFailed
  }

  /** Accumulates samples for this frame. Returns true while the image is still developing. */
  step() {
    if (this.state === 'off' || this.state === 'preparing' || this.state === 'converged')
      return false
    const now = performance.now()
    // One batch in flight at a time: the display does not pace frames that present nothing, so
    // without this the GPU queue would grow without bound.
    // Raw (undenoised) display keeps presenting through the tracer until its fade completes.
    const fading = !this.denoising && this.tracer.fadeState < 1
    // Out of time for this view: keep what has been gathered and let the denoised image stand.
    if (this.accumulating && now - this.timing.start > REST_TIME_MS && this.samples >= 8)
      this.accumulating = false
    if ((this.accumulating || fading) && !this.inFlight) {
      const previous = this.renderer.getRenderTarget()
      this.renderer.setRenderTarget(this.sink)
      this.tracer.renderSample()
      const backend = (this.tracer as unknown as { _pathTracer: { update: () => void } })
        ._pathTracer
      for (let i = 1; i < this.passes; i++) backend.update()
      this.renderer.setRenderTarget(previous)
      this.frames++
      this.inFlight = true
      const device = (
        this.renderer.backend as unknown as {
          device: { queue: { onSubmittedWorkDone: () => Promise<void> } }
        }
      ).device
      device.queue
        .onSubmittedWorkDone()
        .then(() => {
          // Size batches to roughly two display frames of GPU time.
          const busy = performance.now() - now
          if (busy < 28) this.passes = Math.min(MAX_PASSES, Math.ceil(this.passes * 1.5))
          else if (busy > 45) this.passes = Math.max(1, Math.floor(this.passes * 0.75))
        })
        .catch(() => {})
        .finally(() => {
          this.inFlight = false
        })
      if (!this.measuring && this.frames % 6 === 0) this.measure()
    }
    if (this.denoising) this.advanceDenoise(now)
    const settled = this.denoising
      ? !this.accumulating && !this.running && this.shownSamples >= this.samples
      : !this.accumulating && this.tracer.fadeState >= 1
    if (!this.timing.first && this.view(now).t > 0) this.timing.first = now
    if (settled && this.view(now).t >= 1) {
      this.state = 'converged'
      if (TRACE_STATS) {
        const { start, first } = this.timing
        const { width, height } = this.tracer.target!.image as { width: number; height: number }
        console.info(
          `[path tracing] ${width}x${height}${this.seeded ? ', seeded' : ''}: first image ${((first - start) / 1000).toFixed(1)} s, settled ${((now - start) / 1000).toFixed(1)} s`,
        )
      }
    }
    return this.state !== 'converged'
  }

  private measure() {
    this.measuring = true
    const epoch = this.epoch
    this.tracer
      .getSampleCountsAsync()
      .then((counts) => {
        if (epoch !== this.epoch || this.state !== 'tracing') return
        this.samples = counts.min
        if (counts.min >= this.target) this.accumulating = false
      })
      .catch(() => {})
      .finally(() => {
        if (epoch === this.epoch) this.measuring = false
      })
  }

  private advanceDenoise(now: number) {
    const running = this.running
    if (running) {
      const denoiser = this.denoisers[running.index]
      if (denoiser.complete && denoiser.texture) {
        // The first image of a view waits for its exposure match before fading in.
        if (this.gain === null) {
          this.matchExposure(denoiser.texture)
          return
        }
        // Regions this image shows unchanged from the last one are finished: stop sampling them.
        const previous = this.shownIndex >= 0 ? this.denoisers[this.shownIndex].texture : null
        if (previous && this.shownSamples >= MIN_SETTLE_SAMPLES && this.accumulating)
          this.adaptive.update(
            this.renderer,
            denoiser.texture,
            previous,
            this.backend.sampleCountTarget,
            this.target,
          )
        this.transition = { from: this.view(now).to, to: denoiser.texture, start: now }
        if (this.shownIndex < 0) this.transition.from = null
        this.shownIndex = running.index
        this.shownSamples = running.samples
        this.running = null
      }
      return
    }
    // Wait for the previous image to finish fading in before replacing what it fades from.
    if (this.transition.to && this.view(now).t < 1) return
    const goal = this.accumulating
      ? (this.seeded ? SEEDED_MILESTONES : MILESTONES).find(
          (m) => m > this.shownSamples && m <= this.target,
        )
      : this.samples > this.shownSamples
        ? this.samples
        : undefined
    if (goal === undefined || this.samples < goal || !this.scene || !this.camera) return
    const color = this.tracer.target!
    const { width, height } = color.image as { width: number; height: number }
    if (!this.snapshot) {
      this.snapshot = new StorageTexture(width, height)
      this.snapshot.type = FloatType
      this.snapshot.format = RGBAFormat
      this.snapshot.generateMipmaps = false
    }
    const size = this.snapshot.image as { width: number; height: number }
    if (size.width !== width || size.height !== height) this.snapshot.setSize(width, height, 1)
    this.renderer.copyTextureToTexture(color, this.snapshot)
    const index = this.shownIndex === 0 ? 1 : 0
    const denoiser = this.denoisers[index]
    denoiser.reset()
    this.running = { index, samples: this.samples }
    const epoch = this.epoch
    denoiser.denoise(this.snapshot, this.gbuffer.albedo, this.gbuffer.normal).catch((error) => {
      if (epoch !== this.epoch) return
      console.warn('Denoising is unavailable; showing the raw path-traced image.', error)
      this.denoiseFailed = true
      this.running = null
      this.transition = { from: null, to: null, start: now }
    })
  }

  private matchExposure(image: Texture) {
    if (this.metering || !this.rasterKey) return
    this.metering = true
    const epoch = this.epoch
    Promise.all([this.rasterKey, this.meter.measure(image, true)])
      .then(([raster, traced]) => {
        if (epoch !== this.epoch) return
        const ratio = Math.exp(raster - traced)
        this.gain = Number.isFinite(ratio)
          ? Math.min(GAIN_RANGE[1], Math.max(GAIN_RANGE[0], ratio))
          : 1
      })
      .catch(() => {
        if (epoch === this.epoch) this.gain = 1
      })
      .finally(() => {
        if (epoch === this.epoch) this.metering = false
      })
  }

  /** The images to composite this frame. */
  view(now = performance.now()): TraceView {
    const raw = this.tracer.target!
    const gain = this.gain ?? 1
    if (!this.denoising) {
      if (this.gain === null && this.tracer.fadeState > 0) this.matchExposure(raw)
      return { from: null, to: raw, t: this.gain === null ? 0 : this.tracer.fadeState, gain }
    }
    const { from, to, start } = this.transition
    if (!to) return { from: null, to: raw, t: 0, gain }
    const t = Math.min(1, (now - start) / FADE_MS)
    // Once faded in, the outgoing image may be recycled, so stop referencing it.
    return { from: t < 1 ? from : null, to, t, gain }
  }

  /** True once the image on screen holds at least `samples` and has fully faded in. */
  ready(samples: number) {
    const shown = this.denoising ? this.shownSamples : this.samples
    return (shown >= samples || this.state === 'converged') && this.view().t >= 1
  }

  halt() {
    // Keep what this view accumulated for the next one. Queued after any batch still in flight.
    if (this.frames > 0 && (this.state === 'tracing' || this.state === 'converged'))
      this.history.store(this.renderer, this.backend, this.gbuffer, this.signature)
    this.state = 'off'
    this.samples = 0
    this.running = null
    for (const denoiser of this.denoisers) denoiser.reset()
  }

  /** Forces the next `begin` to re-capture, e.g. after textures finish streaming in. */
  invalidate() {
    this.signature = -1
    this.captured = null
  }

  dispose() {
    this.tracer.dispose()
    this.meter.dispose()
    this.sink.dispose()
    this.snapshot?.dispose()
    this.gbuffer.dispose()
    this.history.dispose()
    this.adaptive.dispose()
    for (const denoiser of this.denoisers) denoiser.dispose()
  }
}
