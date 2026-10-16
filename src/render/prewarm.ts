import { ENVIRONMENTS, FINISHES, SIGNATURES, type Config } from '../lib/config'
import { TIME_PRESETS } from './angles'

/**
 * Pre-warming the showroom: the popular designs rendered ahead of any visitor, so their stills
 * come back from the frame store at once (render-server/fury_render/frames.py). The list is the
 * five signature builds in every finish, every setting and every time of day; a visitor who
 * starts from a signature build and changes the colour, the setting or the light never waits.
 *
 * `?prewarm=1` puts the page in this mode (App.tsx usePrewarm); scripts/prewarm.mjs drives it.
 * Deliberately free of three.js imports.
 */

export type PrewarmDesign = {
  index: number
  label: string
  camera: [number, number, number]
  config: Config
}

/** Every design to warm, in an order that finishes the defaults first. */
export function prewarmDesigns(
  signatures = SIGNATURES,
  finishes = FINISHES,
  environments = ENVIRONMENTS,
  times = TIME_PRESETS,
): PrewarmDesign[] {
  const designs: PrewarmDesign[] = []
  const seen = new Set<string>()
  const add = (label: string, camera: [number, number, number], config: Config) => {
    const key = JSON.stringify(config)
    if (seen.has(key)) return
    seen.add(key)
    designs.push({ index: designs.length, label, camera, config })
  }
  // Pass 1: each signature build exactly as published. Pass 2: its finishes. Pass 3: settings
  // and times. So an interrupted run has still covered what most visitors see first.
  for (const build of signatures) add(build.name, build.camera, build.config)
  for (const build of signatures)
    for (const finish of finishes)
      add(`${build.name} · ${finish.name}`, build.camera, { ...build.config, finish: finish.id })
  for (const build of signatures)
    for (const finish of finishes)
      for (const environment of environments)
        for (const time of times)
          add(
            `${build.name} · ${finish.name} · ${environment.name} · ${time.label}`,
            build.camera,
            { ...build.config, finish: finish.id, environment: environment.id, time: time.time },
          )
  return designs
}

/** `?prewarm=1`, or `?prewarm=<from>-<to>` for one slice of the list (several pages in parallel). */
export function prewarmRange(
  total: number,
  search = typeof window === 'undefined' ? '' : window.location.search,
): [number, number] | null {
  const value = new URLSearchParams(search).get('prewarm')
  if (!value) return null
  const match = /^(\d+)-(\d+)$/.exec(value)
  if (!match) return [0, total]
  return [
    Math.max(0, Math.min(total, Number(match[1]))),
    Math.max(0, Math.min(total, Number(match[2]))),
  ]
}
