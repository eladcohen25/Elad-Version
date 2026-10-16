// @vitest-environment jsdom
import { Matrix4, Scene, Vector3 } from 'three/webgpu'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkyLook } from '../lib/visuals'
import { ANGLES } from './angles'
import { Busy, Full, Outdated, Superseded, type CloudCamera, type CloudClient } from './cloud'
import {
  SHOWROOM_TIMEOUT_MS,
  ShowroomSession,
  type AngleFrame,
  type ShowroomState,
} from './showroom'

vi.mock('./cloud', async (original) => ({
  ...(await original<typeof import('./cloud')>()),
  captureScene: vi.fn(async () => ({})),
}))

type FrameRequest = {
  priority: number
  generation: number
  width: number
  height: number
  camera: CloudCamera
  finish: { exposure: number; gain: number }
  quality: { samples: number }
  channel?: string
}

function fakeClient() {
  const requests: { request: FrameRequest; resolve: () => void; reject: (e: unknown) => void }[] =
    []
  const meters: { request: FrameRequest }[] = []
  const answer = {
    image: new Blob(['x']),
    cached: false,
    renderMs: 1,
    totalMs: 1,
    tracedKey: 0,
    timing: {},
  }
  const frame = vi.fn((_captured: unknown, request: FrameRequest) => {
    if (request.channel === 'm') {
      meters.push({ request })
      return Promise.resolve(answer)
    }
    return new Promise((resolve, reject) =>
      requests.push({ request, resolve: () => resolve(answer), reject }),
    )
  })
  return { client: { frame } as unknown as CloudClient, requests, meters }
}

const look = { environment: 'meadow', sunlight: { direction: [0, 1, 0] }, night: 0 } as never
const lens = { near: 0.1, far: 2000 }
/** Each angle gets a camera translated to a distinct spot, so requests can be told apart. */
function frames(): AngleFrame[] {
  return ANGLES.map((a, i) => ({
    id: a.id,
    view: a.view,
    camera: {
      matrix: new Matrix4().makeTranslation(i * 10, 5, 0).toArray(),
      fov: a.view === 'interior' ? 68 : 32,
      ...lens,
    },
    width: 1440,
    height: 900,
    finalWidth: 2160,
    finalHeight: 1350,
  }))
}
function state(angle = ANGLES[0].id): ShowroomState {
  return { angle, frames: frames(), exposure: { exterior: 1, interior: 1.6 } }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const label = (r: FrameRequest) => {
  const x = new Vector3().setFromMatrixPosition(new Matrix4().fromArray(r.camera.matrix)).x
  return `${ANGLES[Math.round(x / 10)].id} ${r.quality.samples === 64 ? 'preview' : 'final'}`
}
async function answer(requests: ReturnType<typeof fakeClient>['requests'], count: number) {
  const answered: string[] = []
  for (let i = 0; i < count; i++) {
    const next = requests.shift()!
    answered.push(label(next.request))
    next.resolve()
    await settle()
  }
  return answered
}
const stubBitmaps = () =>
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1440, height: 900, close() {} })),
  )
const raster = (key: number, at: CloudCamera | null = null) => ({
  key,
  camera: at ?? { matrix: new Matrix4().toArray(), fov: 32, ...lens },
  width: 900,
  height: 600,
})

describe('showroom session', () => {
  let scene: Scene
  beforeEach(() => {
    scene = new Scene()
  })

  it('meters the looked-at view first, then renders its angle, the strip beside it, then full quality', async () => {
    const { client, requests, meters } = fakeClient()
    const session = new ShowroomSession(client, () => {})
    session.sync(scene, look as SkyLook, 'design-a', state(), async (at) => raster(0, at))
    await settle()
    // Both views metered, outside first, each at its first angle's camera and still size.
    expect(meters).toHaveLength(2)
    expect(meters[0].request.camera.matrix).toEqual(frames()[0].camera.matrix)
    expect([meters[0].request.width, meters[0].request.height]).toEqual([1440, 900])
    expect(meters[1].request.camera.matrix).toEqual(frames()[6].camera.matrix)
    // The looked-at angle as a preview goes out at once; then the strip beside it.
    expect(await answer(requests, 9)).toEqual([
      'hero preview',
      // The exterior angles nearest on the strip (wrapping), so clicking along it shows a still.
      'front-left preview',
      'side preview',
      'rear preview',
      'detail preview',
      'aerial preview',
      // Then the looked-at angle at full quality, before the other view's previews.
      'hero final',
      'inside-back preview',
      'inside preview',
    ])
    // Another design in the same light keeps the metered gains.
    session.sync(scene, look as SkyLook, 'design-b', state(), async (at) => raster(0, at))
    await settle()
    expect(meters).toHaveLength(2)
    session.dispose()
  })

  it('renders whichever angle the visitor clicks next, first', async () => {
    const { client, requests } = fakeClient()
    const session = new ShowroomSession(client, () => {})
    session.sync(scene, look as SkyLook, 'design-a', state(), async (at) => raster(0, at))
    await settle()
    expect(await answer(requests, 1)).toEqual(['hero preview'])
    session.sync(scene, look as SkyLook, 'design-a', state('rear'), async (at) => raster(0, at))
    await settle()
    // The focus request goes out regardless of what is in flight.
    expect(requests.map((r) => label(r.request))).toContain('rear preview')
    session.dispose()
  })

  it('shows the raster frame until the still arrives, then the still, never a blocking wait', async () => {
    stubBitmaps()
    const { client, requests } = fakeClient()
    const changes = vi.fn()
    const session = new ShowroomSession(client, changes)
    session.sync(scene, look as SkyLook, 'design-a', state(), async (at) => raster(0, at))
    await settle()
    expect(session.texture()).toBeNull()
    expect(session.progress.loading).toBe(true)
    expect(session.progress.waitTotal).toBe(1)
    await answer(requests, 1)
    session.texture()
    await settle()
    const shown = session.texture()
    expect(shown).not.toBeNull()
    expect(shown!.final).toBe(false)
    expect(session.isFocus(shown!)).toBe(true)
    expect(session.progress.loading).toBe(false)
    expect(session.progress.ready).toBe(1)
    session.dispose()
    vi.unstubAllGlobals()
  })

  it('stops reporting a wait after the timeout even with nothing rendered', async () => {
    vi.useFakeTimers()
    const { client } = fakeClient()
    const session = new ShowroomSession(client, () => {})
    session.sync(scene, look as SkyLook, 'design-a', state(), async (at) => raster(0, at))
    session.texture()
    expect(session.progress.loading).toBe(true)
    vi.advanceTimersByTime(SHOWROOM_TIMEOUT_MS + 100)
    session.texture()
    expect(session.progress.loading).toBe(false)
    session.dispose()
    vi.useRealTimers()
  })

  it('rounds the metered exposure gain to quarter stops', async () => {
    const { client, requests } = fakeClient()
    const session = new ShowroomSession(client, () => {})
    // raster key 0.3 against a traced key of 0: a gain of e^0.3 = 1.35, nearest quarter stop 1.414.
    session.sync(scene, look as SkyLook, 'design-a', state(), async (at) => raster(0.3, at))
    await settle()
    expect(requests[0].request.finish.gain).toBeCloseTo(2 ** 0.5, 6)
    session.dispose()
  })

  it('drops frames of a design that changed while they rendered', async () => {
    stubBitmaps()
    const { client, requests } = fakeClient()
    const session = new ShowroomSession(client, () => {})
    session.sync(scene, look as SkyLook, 'design-a', state(), async (at) => raster(0, at))
    await settle()
    const stale = requests.shift()!
    session.sync(scene, look as SkyLook, 'design-b', state(), async (at) => raster(0, at))
    await settle()
    stale.resolve()
    await settle()
    expect(session.texture()).toBeNull()
    session.dispose()
    vi.unstubAllGlobals()
  })

  it('waits out a busy server, takes a superseded frame as no failure, and gives up when full', async () => {
    vi.useFakeTimers()
    const { client, requests } = fakeClient()
    const session = new ShowroomSession(client, () => {})
    session.sync(scene, look as SkyLook, 'design-a', state(), async (at) => raster(0, at))
    await vi.advanceTimersByTimeAsync(0)
    requests.shift()!.reject(new Busy('busy'))
    await vi.advanceTimersByTimeAsync(0)
    expect(session.progress.failed).toBe(false)
    requests.shift()!.reject(new Superseded())
    await vi.advanceTimersByTimeAsync(0)
    expect(session.progress.failed).toBe(false)
    await vi.advanceTimersByTimeAsync(2100)
    requests.shift()!.reject(new Full('full'))
    await vi.advanceTimersByTimeAsync(0)
    expect(session.progress.failed).toBe(true)
    session.dispose()
    vi.useRealTimers()
  })

  it('gives up at once on a server that predates stills', async () => {
    const { client, requests } = fakeClient()
    const session = new ShowroomSession(client, () => {})
    session.sync(scene, look as SkyLook, 'design-a', state(), async (at) => raster(0, at))
    await settle()
    requests.shift()!.reject(new Outdated('old'))
    await settle()
    expect(session.progress.failed).toBe(true)
    session.dispose()
  })
})
