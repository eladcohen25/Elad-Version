/**
 * The showroom: a handful of composed camera angles instead of a free orbit, like a car
 * configurator's gallery. Each angle is a fixed, reproducible camera, so a path-traced still of
 * it can be rendered once and kept for every visitor who looks at the same design. Free orbiting
 * stays available as "explore" mode (`?explore=1`).
 *
 * Deliberately free of three.js imports so the app shell can use it.
 */

export type Vec3 = [number, number, number]

export type Angle = {
  id: string
  /** Shown in the angle strip. */
  label: string
  view: 'exterior' | 'interior'
  /**
   * Exterior: direction from the subject toward the camera (framing.ts). `null` means the
   * build's own hero direction: the default framing, or a signature build's photographed angle.
   */
  direction: Vec3 | null
  /** Exterior: closer (< 1) or farther (> 1) than the framed distance. */
  zoom: number
  /** Interior: which end of the room the camera stands at. */
  eye: 'entry' | 'back'
}

export const ANGLES: readonly Angle[] = [
  { id: 'hero', label: 'Hero', view: 'exterior', direction: null, zoom: 1, eye: 'entry' },
  {
    id: 'front-left',
    label: 'Front ¾',
    view: 'exterior',
    direction: [-0.62, 0.22, 0.78],
    zoom: 1,
    eye: 'entry',
  },
  {
    id: 'side',
    label: 'Side',
    view: 'exterior',
    direction: [1, 0.16, 0.12],
    zoom: 1,
    eye: 'entry',
  },
  {
    id: 'rear',
    label: 'Rear ¾',
    view: 'exterior',
    direction: [-0.55, 0.3, -0.78],
    zoom: 1,
    eye: 'entry',
  },
  {
    id: 'aerial',
    label: 'Aerial',
    view: 'exterior',
    direction: [0.35, 0.85, 0.45],
    zoom: 1.05,
    eye: 'entry',
  },
  {
    id: 'detail',
    label: 'Entry detail',
    view: 'exterior',
    direction: [0.3, 0.09, 0.95],
    zoom: 0.62,
    eye: 'entry',
  },
  { id: 'inside', label: 'Inside', view: 'interior', direction: null, zoom: 1, eye: 'entry' },
  {
    id: 'inside-back',
    label: 'Looking back',
    view: 'interior',
    direction: null,
    zoom: 1,
    eye: 'back',
  },
]

export const DEFAULT_ANGLE = ANGLES[0].id

export function angleById(id: string): Angle {
  return ANGLES.find((a) => a.id === id) ?? ANGLES[0]
}

/** The first angle of a view: where "Exterior" and "Interior" in the view switcher land. */
export function firstAngle(view: 'exterior' | 'interior'): Angle {
  return ANGLES.find((a) => a.view === view) ?? ANGLES[0]
}

/** The angle `steps` along the strip (wrapping), for the arrow keys and swipes. */
export function stepAngle(id: string, steps: number): Angle {
  const index = Math.max(
    0,
    ANGLES.findIndex((a) => a.id === id),
  )
  const n = ANGLES.length
  return ANGLES[(((index + steps) % n) + n) % n]
}

/** `?explore=1` brings back the free orbit (drag, scroll, auto-rotate) in place of the angles. */
export function exploreEnabled(
  search = typeof window === 'undefined' ? '' : window.location.search,
) {
  return new URLSearchParams(search).get('explore') === '1'
}

/**
 * Time of day as four presets rather than a slider: a path-traced still is rendered once per
 * distinct design, and sixty-one times of day would be sixty-one designs. The hours were picked
 * from the sun model in lib/visuals: it rises at 6:00 and peaks at 13:15.
 */
export const TIME_PRESETS = [
  { id: 'morning', label: 'Morning', time: 8.5 },
  { id: 'midday', label: 'Midday', time: 13.25 },
  { id: 'golden', label: 'Golden hour', time: 18.75 },
  { id: 'night', label: 'Night', time: 21 },
] as const

export type TimePreset = (typeof TIME_PRESETS)[number]['id']

/** The preset a stored time matches, or null for a time from an older share link. */
export function timePreset(time: number): TimePreset | null {
  return TIME_PRESETS.find((p) => Math.abs(p.time - time) < 0.01)?.id ?? null
}

/**
 * The size a hero still is rendered at: a fixed width for the aspect bucket nearest the screen,
 * so visitors with similar screens share one cached render. The still covers the canvas
 * (cropping a sliver at the edges) rather than being re-rendered for every pixel size.
 */
export const FRAME_ASPECTS = [2.333, 1.778, 1.6, 1.5, 1.333, 1, 0.75, 0.5625] as const
/** Preview stills: quick, upscaled on a Retina screen. Final stills: about native 2x density. */
const PREVIEW_WIDTH = { landscape: 1440, portrait: 900 }
const FINAL_WIDTH = { landscape: 2160, portrait: 1350 }

export function frameSize(width: number, height: number) {
  const aspect = width / Math.max(1, height)
  let best: number = FRAME_ASPECTS[0]
  for (const candidate of FRAME_ASPECTS)
    if (Math.abs(Math.log(candidate / aspect)) < Math.abs(Math.log(best / aspect))) best = candidate
  const orientation = best >= 1 ? 'landscape' : 'portrait'
  const w = PREVIEW_WIDTH[orientation]
  const fw = FINAL_WIDTH[orientation]
  return {
    width: w,
    height: Math.round(w / best / 8) * 8,
    finalWidth: fw,
    finalHeight: Math.round(fw / best / 8) * 8,
    aspect: best,
  }
}

/**
 * How a frame of `frameAspect` covers a screen of `screenAspect`: the UV scale and offset that
 * crop it centred, without stretching.
 */
export function coverFit(frameAspect: number, screenAspect: number) {
  if (frameAspect > screenAspect) {
    // The frame is wider than the screen: crop its sides.
    const scale = screenAspect / frameAspect
    return { scaleX: scale, scaleY: 1, offsetX: (1 - scale) / 2, offsetY: 0 }
  }
  const scale = frameAspect / screenAspect
  return { scaleX: 1, scaleY: scale, offsetX: 0, offsetY: (1 - scale) / 2 }
}

/**
 * Exposure gain rounded to quarter stops. The gain is metered against this device's raster
 * frame, which differs slightly between devices and quality tiers; rounding keeps the rendered
 * still identical (and so cached) across them.
 */
export function quantizeGain(gain: number) {
  return 2 ** (Math.round(Math.log2(gain) * 4) / 4)
}
