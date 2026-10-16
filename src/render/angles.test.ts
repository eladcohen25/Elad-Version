import { describe, expect, it } from 'vitest'
import {
  ANGLES,
  DEFAULT_ANGLE,
  FRAME_ASPECTS,
  TIME_PRESETS,
  angleById,
  coverFit,
  exploreEnabled,
  firstAngle,
  frameSize,
  quantizeGain,
  stepAngle,
  timePreset,
} from './angles'
import { cameraFraming } from './framing'
import { DEFAULT_CONFIG } from '../lib/config'

describe('showroom angles', () => {
  it('has unique ids, six exterior and two interior angles, and a hero first', () => {
    expect(new Set(ANGLES.map((a) => a.id)).size).toBe(ANGLES.length)
    expect(ANGLES.filter((a) => a.view === 'exterior')).toHaveLength(6)
    expect(ANGLES.filter((a) => a.view === 'interior')).toHaveLength(2)
    expect(ANGLES[0].id).toBe(DEFAULT_ANGLE)
    expect(ANGLES[0].direction).toBeNull()
  })
  it('steps along the strip and wraps, and falls back to the hero for unknown ids', () => {
    expect(stepAngle(DEFAULT_ANGLE, 1).id).toBe(ANGLES[1].id)
    expect(stepAngle(DEFAULT_ANGLE, -1).id).toBe(ANGLES[ANGLES.length - 1].id)
    expect(stepAngle(ANGLES[ANGLES.length - 1].id, 1).id).toBe(DEFAULT_ANGLE)
    expect(angleById('nope').id).toBe(DEFAULT_ANGLE)
    expect(firstAngle('interior').view).toBe('interior')
    expect(firstAngle('exterior').id).toBe(DEFAULT_ANGLE)
  })
  it('is on unless ?explore=1', () => {
    expect(exploreEnabled('')).toBe(false)
    expect(exploreEnabled('?explore=1')).toBe(true)
    expect(exploreEnabled('?explore=0')).toBe(false)
  })
  it('frames every angle as a distinct camera', () => {
    const c = { ...DEFAULT_CONFIG }
    const seen = new Set<string>()
    for (const angle of ANGLES) {
      const framing = cameraFraming(c, angle.view, angle.direction ?? [0.48, 0.24, 0.84], 1.6, {
        eye: angle.eye,
        zoom: angle.zoom,
      })
      const key = framing.position.map((v) => v.toFixed(2)).join(',')
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })
  it('stands at the back of the room looking toward the entry for the second interior angle', () => {
    const c = { ...DEFAULT_CONFIG }
    const entry = cameraFraming(c, 'interior', [0, 0, 0], 1.6, { eye: 'entry' })
    const back = cameraFraming(c, 'interior', [0, 0, 0], 1.6, { eye: 'back' })
    expect(Math.sign(entry.position[0])).toBe(1)
    expect(Math.sign(back.position[0])).toBe(-1)
    expect(back.target[0]).toBeGreaterThan(back.position[0])
  })
  it('zooms the exterior framing in and out', () => {
    const c = { ...DEFAULT_CONFIG }
    const far = cameraFraming(c, 'exterior', [0.3, 0.1, 0.95], 1.6, { zoom: 1 })
    const near = cameraFraming(c, 'exterior', [0.3, 0.1, 0.95], 1.6, { zoom: 0.62 })
    const d = (f: typeof far) => Math.hypot(...f.position.map((v, i) => v - f.target[i]))
    expect(d(near) / d(far)).toBeCloseTo(0.62, 3)
  })
})

describe('time presets', () => {
  it('names four times of day within the sun model and matches stored times', () => {
    expect(TIME_PRESETS).toHaveLength(4)
    for (const p of TIME_PRESETS) {
      expect(p.time).toBeGreaterThanOrEqual(6)
      expect(p.time).toBeLessThanOrEqual(21)
      expect(timePreset(p.time)).toBe(p.id)
    }
    expect(timePreset(10.75)).toBeNull()
  })
})

describe('still sizes', () => {
  it('renders at a fixed width for the nearest aspect bucket', () => {
    expect(frameSize(1920, 1080)).toEqual({ width: 1440, height: 808, aspect: 1.778 })
    expect(frameSize(1512, 982)).toMatchObject({ width: 1440, aspect: 1.5 })
    expect(frameSize(390, 844)).toMatchObject({ width: 900, aspect: 0.5625 })
    for (const aspect of FRAME_ASPECTS) expect(frameSize(aspect * 1000, 1000).aspect).toBe(aspect)
  })
  it('covers the screen without stretching', () => {
    // A 16:9 still on a 3:2 screen: crop the sides.
    const wide = coverFit(1.778, 1.5)
    expect(wide.scaleY).toBe(1)
    expect(wide.scaleX).toBeCloseTo(1.5 / 1.778, 5)
    expect(wide.offsetX).toBeCloseTo((1 - wide.scaleX) / 2, 5)
    // A 3:2 still on a 16:9 screen: crop top and bottom.
    const tall = coverFit(1.5, 1.778)
    expect(tall.scaleX).toBe(1)
    expect(tall.scaleY).toBeCloseTo(1.5 / 1.778, 5)
    expect(coverFit(1.6, 1.6)).toEqual({ scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 })
  })
  it('rounds exposure gain to quarter stops so stills are shared between devices', () => {
    expect(quantizeGain(1)).toBe(1)
    expect(quantizeGain(1.05)).toBe(1)
    expect(quantizeGain(2.9)).toBeCloseTo(2 ** 1.5, 6)
    expect(quantizeGain(0.53)).toBeCloseTo(0.5, 6)
  })
})
