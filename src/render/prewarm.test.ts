import { describe, expect, it } from 'vitest'
import { ENVIRONMENTS, FINISHES, SIGNATURES } from '../lib/config'
import { TIME_PRESETS } from './angles'
import { prewarmDesigns, prewarmRange } from './prewarm'

describe('pre-warm list', () => {
  const designs = prewarmDesigns()
  it('covers every signature build in every finish, setting and time of day, defaults first', () => {
    const grid = SIGNATURES.length * FINISHES.length * ENVIRONMENTS.length * TIME_PRESETS.length
    // The grid, plus the builds as published where their own time is not a preset.
    expect(designs.length).toBeGreaterThanOrEqual(grid)
    expect(designs.length).toBeLessThanOrEqual(grid + SIGNATURES.length * FINISHES.length)
    expect(designs.slice(0, SIGNATURES.length).map((d) => d.label)).toEqual(
      SIGNATURES.map((s) => s.name),
    )
    expect(designs.map((d) => d.index)).toEqual(designs.map((_, i) => i))
    for (const build of SIGNATURES)
      for (const time of TIME_PRESETS)
        expect(
          designs.some(
            (d) =>
              d.config.items === build.config.items &&
              d.config.finish === 'chalk' &&
              d.config.environment === 'desert' &&
              d.config.time === time.time,
          ),
        ).toBe(true)
  })
  it('never repeats a design', () => {
    const keys = designs.map((d) => JSON.stringify(d.config))
    expect(new Set(keys).size).toBe(keys.length)
  })
  it('reads the slice from ?prewarm', () => {
    expect(prewarmRange(100, '')).toBeNull()
    expect(prewarmRange(100, '?prewarm=1')).toEqual([0, 100])
    expect(prewarmRange(100, '?prewarm=20-40')).toEqual([20, 40])
    expect(prewarmRange(100, '?prewarm=90-500')).toEqual([90, 100])
  })
})
