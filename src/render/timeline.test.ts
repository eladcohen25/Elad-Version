import { describe, expect, it } from 'vitest'
import { responseTiming } from './timeline'

describe('timeline', () => {
  it('reads the cloud timing headers, numbers as numbers', () => {
    const headers = new Headers({
      'x-cache': 'hit',
      'x-cold': '1',
      'x-boot-ms': '48210',
      'x-dispatch-ms': '51000',
      'x-render-ms': '1532',
      'x-device': 'OPTIX',
    })
    expect(responseTiming(headers)).toMatchObject({
      cache: 'hit',
      cold: 1,
      bootMs: 48210,
      dispatchMs: 51000,
      renderMs: 1532,
      device: 'OPTIX',
      queueMs: undefined,
    })
  })
})
