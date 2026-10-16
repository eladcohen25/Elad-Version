import { LinearFilter, Texture, type Scene } from 'three/webgpu'
import type { SkyLook } from '../lib/visuals'
import { ANGLES, quantizeGain, stepAngle } from './angles'
import {
  Busy,
  Full,
  Outdated,
  Superseded,
  captureScene,
  type CapturedScene,
  type CloudCamera,
  type CloudClient,
} from './cloud'
import { lookKey } from './pathtrace'
import type { Decoded, MeterRaster, SpinProgress } from './spin'
import { mark, markOnce, now as timelineNow, resetOnce, timelineEnabled } from './timeline'

/**
 * The showroom's path-traced stills. Each angle (angles.ts) is a fixed camera, so a still of it
 * is rendered once per design and kept by the server for everyone who looks at the same design
 * from the same angle (api.py frame cache; a later visitor gets it in a round trip).
 *
 * Order of work for a design: the angle being looked at as a quick preview, then previews of the
 * other angles of the same view (so clicking through the strip shows a still at once), then the
 * looked-at angle at full quality, then the other view's previews, then the rest at full quality.
 * The raster frame stays on screen until the first still arrives: nothing waits behind a screen.
 */

/** Frame quality: a quick preview, then the full render. */
const PREVIEW = { samples: 64, threshold: 0.05, timeLimit: 3 }
const FINAL = { samples: 256, threshold: 0.03, timeLimit: 10 }
/** The exposure meter's frame: denoised, its mean brightness settles within a few samples. */
const METER = { samples: 16, threshold: 0, timeLimit: 4 }
/** Requests kept open besides the one for the angle being looked at. */
const IN_FLIGHT = 3
const BUSY_MS = 2000
/** Decoded frames kept as textures. */
const DECODED = 10
/** The status pill stops saying "rendering" after this long without a still; the raster stands. */
export const SHOWROOM_TIMEOUT_MS = 8000

const TRACE_STATS = new URLSearchParams(window.location.search).get('traceStats') === '1'

/** One angle's camera and size this frame, as RenderEffects computes it from the framing. */
export type AngleFrame = {
  id: string
  view: 'exterior' | 'interior'
  camera: CloudCamera
  /** The preview's size; the full-quality still is rendered at finalWidth × finalHeight. */
  width: number
  height: number
  finalWidth: number
  finalHeight: number
}

export type ShowroomState = {
  /** The angle being looked at. */
  angle: string
  frames: AngleFrame[]
  /** The renderer's exposure outside and inside. */
  exposure: { exterior: number; interior: number }
}

type Gains = { exterior: number; interior: number }
type Stored = { preview?: Blob; final?: Blob }
type Job = {
  key: string
  final: boolean
  priority: number
  frame: AngleFrame
  quality: { samples: number; threshold: number; timeLimit: number }
  focus: boolean
}

/** A camera's identity for a frame key: its matrix to the millimetre, its lens and size. */
function frameKey(frame: AngleFrame) {
  const m = frame.camera.matrix.map((v) => v.toFixed(3)).join(',')
  return `${frame.id}|${frame.width}x${frame.height}|${frame.camera.fov.toFixed(2)}|${m}`
}

export class ShowroomSession {
  private readonly client: CloudClient
  private readonly onChange: () => void
  private generation = 0
  private focused = ''
  private focusSeq = 0
  private abort = new AbortController()
  private readonly closed = new AbortController()
  private design = ''
  private sceneKey = ''
  private captured: Promise<CapturedScene> | null = null
  private state: ShowroomState | null = null
  private gain: Gains | null = null
  private readonly gains = new Map<string, Gains>()
  private metering = ''
  private readonly frames = new Map<string, Stored>()
  private readonly decoded = new Map<string, Promise<Decoded | null> | Decoded>()
  private held = new Set<Texture>()
  private readonly doomed = new Set<Texture>()
  private inFlight = new Set<string>()
  private failures = 0
  private busyUntil = 0
  private started = performance.now()
  private watching = ''
  private timeout: ReturnType<typeof setTimeout> | undefined
  private waitLog = { at: 0, waiting: false }
  progress: SpinProgress = {
    loading: true,
    ready: 0,
    total: ANGLES.length,
    final: 0,
    waitReady: 0,
    waitTotal: 1,
    failed: false,
  }

  constructor(client: CloudClient, onChange: () => void) {
    this.client = client
    this.onChange = onChange
    document.addEventListener('visibilitychange', this.resume)
  }

  private readonly resume = () => {
    if (!document.hidden) this.pump()
  }

  /**
   * The design, look and angles. Cheap to call every frame: work starts only when something
   * that determines the stills changed. While the scene is not `settled` (textures arriving),
   * the stills keep the design they have, so a design is rendered once, complete.
   */
  sync(
    scene: Scene,
    look: SkyLook,
    sceneKey: string,
    state: ShowroomState,
    rasterKey: MeterRaster,
    settled = true,
  ) {
    this.state = state
    const lighting = lookKey(look)
    const design = settled ? `${sceneKey}|${lighting}` : this.design
    if (!design) return
    if (design === this.design) {
      this.pump()
      return
    }
    mark(this.design ? 'showroom-design-changed' : 'showroom-first-design', { sceneKey, lighting })
    resetOnce('showroom-')
    this.generation++
    this.focused = ''
    this.abort.abort()
    this.abort = new AbortController()
    this.inFlight = new Set()
    this.failures = 0
    this.design = design
    this.frames.clear()
    for (const d of this.decoded.values()) if (!(d instanceof Promise)) this.doom(d.texture)
    this.decoded.clear()
    this.progress = { ...this.progress, loading: true, failed: false }
    if (sceneKey !== this.sceneKey || !this.captured) {
      this.sceneKey = sceneKey
      this.captured = captureScene(scene, look)
    }
    this.gain = this.gains.get(lighting) ?? null
    if (this.gain === null) this.startMeter(lighting, rasterKey)
    this.pump()
  }

  private startMeter(lighting: string, rasterKey: MeterRaster) {
    const design = this.design
    this.metering = design
    const settle = (gains: Gains | null) => {
      if (this.metering !== design) return
      this.metering = ''
      if (design !== this.design || this.closed.signal.aborted) return
      if (gains) this.gains.set(lighting, gains)
      this.gain = gains ?? { exterior: 1, interior: 1 }
      this.pump()
    }
    this.meterViews(rasterKey).then(settle, (error) => {
      if (error instanceof Outdated || error instanceof Full) return this.fail(error)
      if (this.metering === design && !this.closed.signal.aborted)
        console.warn('The path-traced exposure could not be metered.', error)
      settle(null)
    })
  }

  /** Both views' gains, metered at their first angles; the looked-at view first. */
  private async meterViews(rasterKey: MeterRaster): Promise<Gains> {
    const captured = await this.captured!
    const state = this.state!
    const focus = state.frames.find((f) => f.id === state.angle)
    const views: ('exterior' | 'interior')[] =
      focus?.view === 'interior' ? ['interior', 'exterior'] : ['exterior', 'interior']
    const gains: Gains = { exterior: 1, interior: 1 }
    for (const view of views) {
      const frame =
        (focus?.view === view ? focus : null) ?? state.frames.find((f) => f.view === view)
      if (!frame) continue
      gains[view] = await this.meter(captured, rasterKey, frame, view)
      // The looked-at view can start rendering while the other view is metered.
      if (view === views[0]) {
        this.gain = { ...gains }
        this.pump()
      }
    }
    return gains
  }

  private async meter(
    captured: CapturedScene,
    rasterKey: MeterRaster,
    frame: AngleFrame,
    label: string,
  ) {
    mark(`showroom-meter-${label}-raster-wanted`)
    const raster = await rasterKey(frame.camera)
    mark(`showroom-meter-${label}-sent`)
    const result = await this.client.frame(
      captured,
      {
        camera: frame.camera,
        width: frame.width,
        height: frame.height,
        quality: METER,
        finish: { exposure: 1, gain: 1 },
        priority: 0,
        generation: 0,
        channel: 'm',
      },
      this.closed.signal,
    )
    mark(`showroom-meter-${label}-answered`, {
      ...result.timing,
      totalMs: Math.round(result.totalMs),
    })
    const ratio = Math.exp(raster.key - result.tracedKey)
    if (!Number.isFinite(ratio))
      throw new Error(`no exposure reading (${raster.key}, ${result.tracedKey})`)
    const gain = quantizeGain(Math.min(4, Math.max(0.5, ratio)))
    if (TRACE_STATS)
      console.info(
        `[showroom] ${label} exposure: raster key ${raster.key.toFixed(3)}, traced key ${result.tracedKey.toFixed(3)}, gain ${gain.toFixed(3)}`,
      )
    return gain
  }

  /** The stills still to render, most wanted first. */
  private jobs(): Job[] {
    const state = this.state
    if (!state) return []
    const focus = state.frames.find((f) => f.id === state.angle)
    if (!focus) return []
    const job = (frame: AngleFrame, final: boolean, isFocus = false): Job => ({
      key: frameKey(frame),
      final,
      priority: 0,
      frame,
      quality: final ? FINAL : PREVIEW,
      focus: isFocus,
    })
    // The angles beside the looked-at one on the strip first, then the rest of its view.
    const order = new Map<string, number>()
    for (let d = 1; d < ANGLES.length; d++) {
      for (const sign of [1, -1]) {
        const id = stepAngle(focus.id, d * sign).id
        if (!order.has(id)) order.set(id, order.size)
      }
    }
    const rank = (f: AngleFrame) => order.get(f.id) ?? 99
    const same = state.frames
      .filter((f) => f.view === focus.view && f.id !== focus.id)
      .sort((a, b) => rank(a) - rank(b))
    const other = state.frames
      .filter((f) => f.view !== focus.view)
      .sort((a, b) => rank(a) - rank(b))
    const groups: Job[][] = [
      [job(focus, false, true)],
      same.map((f) => job(f, false)),
      [job(focus, true, true)],
      other.map((f) => job(f, false)),
      same.map((f) => job(f, true)),
      other.map((f) => job(f, true)),
    ]
    return groups.flatMap((group, priority) => group.map((j) => ({ ...j, priority })))
  }

  private pump() {
    if (this.gain === null || !this.captured || this.failures >= 3) return
    if (this.closed.signal.aborted || document.hidden) return
    if (performance.now() < this.busyUntil) return
    const state = this.state
    const focused = state ? state.angle : ''
    if (focused !== this.focused) {
      this.focused = focused
      this.focusSeq++
    }
    for (const job of this.jobs()) {
      const stored = this.frames.get(job.key)
      if (job.final ? stored?.final : stored?.preview || stored?.final) continue
      const id = `${job.key}|${job.final}`
      if (this.inFlight.has(id)) continue
      if (!job.focus && this.inFlight.size >= IN_FLIGHT) break
      this.request(job, id)
    }
  }

  private request(job: Job, id: string) {
    const generation = this.generation
    const sequence = job.focus ? { generation: this.focusSeq, channel: 'f' } : { generation }
    const inFlight = this.inFlight
    const gain = this.gain!
    const finish = {
      exposure:
        job.frame.view === 'interior'
          ? this.state!.exposure.interior
          : this.state!.exposure.exterior,
      gain: job.frame.view === 'interior' ? gain.interior : gain.exterior,
    }
    inFlight.add(id)
    const sentAt = timelineNow()
    markOnce('showroom-first-frame-sent', { angle: job.frame.id, final: job.final })
    this.captured!.then((captured) =>
      this.client.frame(
        captured,
        {
          camera: job.frame.camera,
          width: job.final ? job.frame.finalWidth : job.frame.width,
          height: job.final ? job.frame.finalHeight : job.frame.height,
          quality: job.quality,
          priority: job.priority,
          finish,
          ...sequence,
        },
        this.abort.signal,
      ),
    )
      .then((frame) => {
        if (generation !== this.generation) return
        if (TRACE_STATS) {
          console.info(
            `[showroom] ${job.frame.id} ${job.final ? 'final' : 'preview'} ${job.frame.width}x${job.frame.height}: ${frame.cached ? 'cached' : `render ${frame.renderMs} ms`}, ${Math.round(frame.totalMs)} ms in all`,
          )
          markOnce('showroom-first-frame-answered', { angle: job.frame.id, ...frame.timing })
          mark('showroom-frame', {
            angle: job.frame.id,
            final: job.final,
            focus: job.focus,
            waitMs: timelineNow() - sentAt,
            ...frame.timing,
          })
        }
        const stored = this.frames.get(job.key) ?? {}
        stored[job.final ? 'final' : 'preview'] = frame.image
        this.frames.set(job.key, stored)
        if (job.final) {
          const old = this.decoded.get(job.key)
          if (old && !(old instanceof Promise) && !old.final) {
            this.decoded.delete(job.key)
            this.doom(old.texture)
          }
        }
        this.failures = 0
        this.onChange()
      })
      .catch((error) => {
        if (generation !== this.generation || this.abort.signal.aborted) return
        if (error instanceof Superseded) return
        if (error instanceof Busy) {
          this.busyUntil = performance.now() + BUSY_MS
          setTimeout(() => this.pump(), BUSY_MS)
          return
        }
        if (error instanceof Outdated || error instanceof Full || ++this.failures >= 3)
          this.fail(error)
      })
      .finally(() => {
        inFlight.delete(id)
        if (generation === this.generation) this.pump()
      })
  }

  /** Gives up on cloud stills for this page: resting views are traced on this device instead. */
  private fail(error: unknown) {
    if (this.progress.failed) return
    console.warn('Path-traced stills could not be rendered in the cloud.', error)
    this.failures = 3
    this.progress = { ...this.progress, loading: false, failed: true }
    this.onChange()
  }

  private doom(texture: Texture) {
    if (this.held.has(texture)) this.doomed.add(texture)
    else texture.dispose()
  }

  hold(textures: Texture[]) {
    this.held = new Set(textures)
    for (const texture of this.doomed)
      if (!this.held.has(texture)) {
        texture.dispose()
        this.doomed.delete(texture)
      }
  }

  private focusFrame() {
    const state = this.state
    return state?.frames.find((f) => f.id === state.angle) ?? null
  }

  private count() {
    const state = this.state
    const focus = this.focusFrame()
    if (!state || !focus) return
    const watching = this.design && `${this.design}|${focus.id}`
    if (watching !== this.watching) {
      if (this.watching) this.started = performance.now()
      this.watching = watching
      clearTimeout(this.timeout)
      const left = this.started + SHOWROOM_TIMEOUT_MS - performance.now()
      this.timeout = setTimeout(this.onChange, Math.max(0, left) + 50)
    }
    let ready = 0,
      final = 0
    for (const frame of state.frames) {
      const f = this.frames.get(frameKey(frame))
      if (f) ready++
      if (f?.final) final++
    }
    // What the status waits for: the looked-at angle, at least as a preview.
    const waitReady = this.frames.has(frameKey(focus)) ? 1 : 0
    const loading = waitReady < 1 && performance.now() - this.started < SHOWROOM_TIMEOUT_MS
    if (timelineEnabled) this.logWait(loading, focus)
    this.progress = {
      loading,
      ready,
      total: state.frames.length,
      final,
      waitReady,
      waitTotal: 1,
      failed: this.progress.failed,
    }
  }

  private logWait(loading: boolean, focus: AngleFrame) {
    const waited = Math.round(performance.now() - this.started)
    if (loading) {
      if (performance.now() - this.waitLog.at < 2000) return
      this.waitLog = { at: performance.now(), waiting: true }
      mark('showroom-waiting', {
        waitedMs: waited,
        angle: focus.id,
        inFlight: [...this.inFlight],
        metering: this.metering !== '',
        gain: this.gain !== null,
      })
    } else if (this.waitLog.waiting) {
      this.waitLog = { at: 0, waiting: false }
      mark('showroom-still-shown-or-timeout', {
        waitedMs: waited,
        angle: focus.id,
        gaveUp: !this.frames.has(frameKey(focus)),
      })
    }
  }

  /**
   * The still for the angle being looked at, or null until one is decoded (the raster frame
   * shows meanwhile). Decoding also starts for the angles beside it on the strip.
   */
  texture(): Decoded | null {
    const state = this.state
    const focus = this.focusFrame()
    if (!state || !focus) return null
    this.count()
    const shown = this.decode(frameKey(focus))
    for (const d of [1, -1, 2, -2]) {
      const id = stepAngle(focus.id, d).id
      const frame = state.frames.find((f) => f.id === id)
      if (frame) this.decode(frameKey(frame))
    }
    return shown
  }

  /** Whether a decoded still is the looked-at angle's own. */
  isFocus(frame: Decoded) {
    const focus = this.focusFrame()
    return !!focus && frame.key === frameKey(focus)
  }

  private decode(key: string): Decoded | null {
    const current = this.decoded.get(key)
    if (current && !(current instanceof Promise)) {
      this.decoded.delete(key)
      this.decoded.set(key, current)
      return current
    }
    const stored = this.frames.get(key)
    if (current || !stored) return null
    const blob = stored.final ?? stored.preview!
    const final = !!stored.final
    const design = this.design
    const work: Promise<Decoded | null> = createImageBitmap(blob).then((bitmap) => {
      const texture = new Texture(bitmap as never)
      texture.flipY = false
      texture.generateMipmaps = false
      texture.minFilter = LinearFilter
      texture.needsUpdate = true
      const decoded = { texture, final, key, design }
      if (this.decoded.get(key) !== work) {
        texture.dispose()
        return decoded
      }
      this.decoded.set(key, decoded)
      while (this.decoded.size > DECODED) {
        const [oldKey, old] = this.decoded.entries().next().value!
        this.decoded.delete(oldKey)
        if (!(old instanceof Promise)) this.doom(old.texture)
      }
      this.onChange()
      return decoded
    })
    work.catch((error) => {
      if (this.decoded.get(key) === work) this.decoded.delete(key)
      this.fail(error)
    })
    this.decoded.set(key, work)
    return null
  }

  dispose() {
    document.removeEventListener('visibilitychange', this.resume)
    clearTimeout(this.timeout)
    this.generation++
    this.abort.abort()
    this.closed.abort()
    for (const d of this.decoded.values()) if (!(d instanceof Promise)) d.texture.dispose()
    for (const texture of this.doomed) texture.dispose()
    this.decoded.clear()
    this.doomed.clear()
  }
}
