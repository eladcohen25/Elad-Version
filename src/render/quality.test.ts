import { describe, expect, it, vi } from 'vitest'
import { QUALITY_DETAILS, defaultQuality, requestedBackend } from './quality'
import { textureProgress } from './progress'

describe('render quality selection', () => {
  it('starts laptops and tablets on High (Ultra is opt-in) and phones on Lite', () => {
    expect(defaultQuality(1440, '')).toBe('high')
    expect(defaultQuality(1100, '')).toBe('high')
    expect(defaultQuality(900, '')).toBe('high')
    expect(defaultQuality(390, '')).toBe('lite')
  })
  it('honours an explicit ?quality= tier and ignores unknown values', () => {
    expect(defaultQuality(390, '?quality=ultra')).toBe('ultra')
    expect(defaultQuality(1440, '?quality=lite')).toBe('lite')
    expect(defaultQuality(1440, '?quality=cinematic')).toBe('high')
  })
  it('lets ?renderer= force a GPU backend', () => {
    expect(requestedBackend('?renderer=webgl')).toBe('webgl2')
    expect(requestedBackend('?renderer=webgl2')).toBe('webgl2')
    expect(requestedBackend('?renderer=webgpu')).toBe('webgpu')
    expect(requestedBackend('')).toBeNull()
    expect(requestedBackend('?renderer=vulkan')).toBeNull()
  })
  it('describes every tier', () => {
    for (const detail of Object.values(QUALITY_DETAILS)) expect(detail.length).toBeGreaterThan(20)
  })
})

describe('material streaming progress', () => {
  it('accumulates requested and loaded maps and notifies subscribers', () => {
    const listener = vi.fn()
    const stop = textureProgress.subscribe(listener)
    const before = textureProgress.get()
    textureProgress.update(3, 0)
    textureProgress.update(0, 2)
    expect(textureProgress.get()).toEqual({
      requested: before.requested + 3,
      loaded: before.loaded + 2,
    })
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    textureProgress.update(0, 1)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
