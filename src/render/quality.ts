/**
 * Rendering tiers and backend selection. Deliberately free of three.js imports so the app shell
 * can use it without pulling the 3D bundle into the initial load.
 */
export type Quality = 'ultra' | 'high' | 'lite'
export type Backend = 'webgpu' | 'webgl2'

/** `?renderer=webgl` forces the WebGL 2 backend, useful for comparing or working around drivers. */
export function requestedBackend(search = window.location.search): Backend | null {
  const value = new URLSearchParams(search).get('renderer')
  return value === 'webgl' || value === 'webgl2' ? 'webgl2' : value === 'webgpu' ? 'webgpu' : null
}

/**
 * Starting tier: `?quality=` wins, otherwise the viewport decides. Users can change it later.
 * Laptops start on High: Ultra's screen-space GI and reflections kept laptop GPUs at full load
 * (fans, battery) for a difference most visitors never notice; it stays one click away.
 */
export function defaultQuality(
  width = window.innerWidth,
  search = window.location.search,
): Quality {
  const requested = new URLSearchParams(search).get('quality')
  if (requested === 'ultra' || requested === 'high' || requested === 'lite') return requested
  return width >= 700 ? 'high' : 'lite'
}

type BatteryManager = { charging: boolean; addEventListener: (t: string, f: () => void) => void }

/**
 * Whether the device is running on battery, when the browser says (Chromium only). Path tracing
 * on the visitor's own GPU is skipped on battery unless they asked for it (`?trace=1`), since it
 * runs the GPU flat out for seconds after every view change.
 */
export async function onBattery(): Promise<boolean> {
  const getBattery = (navigator as { getBattery?: () => Promise<BatteryManager> }).getBattery
  if (!getBattery) return false
  try {
    const battery = await getBattery.call(navigator)
    return !battery.charging
  } catch {
    return false
  }
}

export const QUALITY_DETAILS: Record<Quality, string> = {
  ultra:
    'Screen-space global illumination, ambient occlusion, temporal anti-aliasing, bloom. Runs the GPU hard.',
  high: 'Ambient occlusion, temporal anti-aliasing, and bloom.',
  lite: 'Multisampled direct rendering for older or battery-powered devices.',
}
