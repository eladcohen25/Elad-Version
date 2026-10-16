/**
 * A timeline of where the first seconds go: scene load, textures, the cloud GPU's cold start,
 * metering, the first traced frame, the loading screen lifting. One `[fury] t=<ms> <label>` line
 * per milestone in the console, and the same list on `window.__furyTimeline` to copy as JSON.
 *
 * On only with `?traceStats=1`, so visitors never see it. Free of three.js imports.
 */

export type Mark = { t: number; label: string; extra?: Record<string, unknown> }

const ENABLED =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('traceStats') === '1'

const marks: Mark[] = []
/** Labels marked once: a second mark of the same label is ignored (first texture arrival, say). */
const once = new Set<string>()

declare global {
  interface Window {
    __furyTimeline?: Mark[]
  }
}

if (ENABLED) window.__furyTimeline = marks

/** Whether the timeline is being recorded (`?traceStats=1`). */
export const timelineEnabled = ENABLED

/** Milliseconds since the page started loading, as the timeline stamps them. */
export function now() {
  return Math.round(performance.now())
}

/** Records a milestone. `extra` is logged alongside and kept in the JSON. */
export function mark(label: string, extra?: Record<string, unknown>) {
  if (!ENABLED) return
  const t = now()
  marks.push(extra ? { t, label, extra } : { t, label })
  if (extra) console.info(`[fury] t=${t} ${label}`, extra)
  else console.info(`[fury] t=${t} ${label}`)
}

/** Records a milestone the first time only. */
export function markOnce(label: string, extra?: Record<string, unknown>) {
  if (!ENABLED || once.has(label)) return
  once.add(label)
  mark(label, extra)
}

/** Whether a once-only milestone has been recorded. */
export function marked(label: string) {
  return once.has(label)
}

/** Forgets once-only milestones with this prefix, so a new design records them again. */
export function resetOnce(prefix: string) {
  for (const label of once) if (label.startsWith(prefix)) once.delete(label)
}

/** The timing headers a cloud response carries, as the timeline wants them. */
export function responseTiming(headers: Headers) {
  const read = (name: string) => {
    const value = headers.get(name)
    return value === null ? undefined : Number.isNaN(Number(value)) ? value : Number(value)
  }
  return {
    cache: read('x-cache'),
    cold: read('x-cold'),
    bootMs: read('x-boot-ms'),
    containerAgeMs: read('x-container-age-ms'),
    dispatchMs: read('x-dispatch-ms'),
    queueMs: read('x-queue-ms'),
    prepareMs: read('x-prepare-ms'),
    renderMs: read('x-render-ms'),
    packMs: read('x-pack-ms'),
    finishMs: read('x-finish-ms'),
    device: read('x-device'),
    denoise: read('x-denoise'),
  }
}

/** The marks so far, for tests. */
export function timeline() {
  return marks
}
