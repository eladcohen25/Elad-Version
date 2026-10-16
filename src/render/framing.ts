import { productHeight, type Config, type View } from '../lib/config'
import { deckFront, roofTop } from './addons'

type Vec3 = [number, number, number]

export const EXTERIOR_FOV = 32
export const INTERIOR_FOV = 68

/**
 * Where the camera sits for a view: the interior stands in the entry corner looking down the
 * room; the exterior frames the unit and its outdoor additions from `direction`, far enough that
 * the whole build fits the viewport at this aspect ratio.
 */
export type FramingOptions = {
  /** Interior: stand in the entry corner (default) or at the back wall looking toward the entry. */
  eye?: 'entry' | 'back'
  /** Exterior: closer (< 1) or farther (> 1) than the distance that frames the whole build. */
  zoom?: number
}

export function cameraFraming(
  c: Config,
  view: View,
  direction: Vec3,
  aspect: number,
  options: FramingOptions = {},
): { position: Vec3; target: Vec3; fov: number } {
  if (view === 'interior') {
    if (options.eye === 'back')
      return {
        position: [-c.length / 2 + 2.2, 5.8, -1.4],
        target: [c.length / 4, 4.6, 0.7],
        fov: INTERIOR_FOV,
      }
    return {
      position: [c.length / 2 - 2.2, 5.8, 1.4],
      target: [-c.length / 4, 4.6, -0.7],
      fov: INTERIOR_FOV,
    }
  }
  const zoom = options.zoom ?? 1
  const hasOutdoor = c.addons.deck || c.addons.gazebo || c.addons.stairs || c.addons.canopy
  const outdoorDepth = c.addons.stairs ? 17 : c.addons.deck ? deckFront(c) + 4 : 12
  const height = c.addons.roof || c.addons.stairs ? roofTop(c) + 3.6 : productHeight(c)
  const width = c.length + (c.addons.stairs ? 6 : 2),
    depth = hasOutdoor ? outdoorDepth : 10
  const v = (EXTERIOR_FOV * Math.PI) / 360,
    h = Math.atan(Math.tan(v) * aspect)
  const radius = Math.sqrt(width * width + depth * depth + height * height) / 2
  const distance = (radius / Math.sin(Math.min(v, h))) * 0.94 * zoom
  const target: Vec3 = [
    c.addons.stairs ? 2 : 0,
    c.addons.roof ? 5 : 3.5,
    hasOutdoor ? Math.min(2.2, (depth - 8) / 4) : 0,
  ]
  const length = Math.hypot(...direction) || 1
  return {
    position: [
      target[0] + (direction[0] / length) * distance,
      target[1] + (direction[1] / length) * distance,
      target[2] + (direction[2] / length) * distance,
    ],
    target,
    fov: EXTERIOR_FOV,
  }
}
