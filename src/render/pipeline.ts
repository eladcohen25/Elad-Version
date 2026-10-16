import {
  DataTexture,
  FloatType,
  Matrix3,
  MeshBasicNodeMaterial,
  type DirectionalLight,
  QuadMesh,
  RenderPipeline,
  RenderTarget,
  UnsignedByteType,
  Vector2,
  type Camera,
  type Node,
  type PerspectiveCamera,
  type Scene,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  acos,
  atan,
  builtinAOContext,
  cameraFar,
  cameraNear,
  context,
  diffuseColor,
  emissive,
  float,
  interleavedGradientNoise,
  ivec2,
  log,
  luminance,
  max,
  metalness,
  mix,
  mrt,
  normalView,
  orthographicDepthToViewZ,
  output,
  packNormalToRGB,
  pass,
  perspectiveDepthToViewZ,
  positionView,
  renderOutput,
  roughness,
  sample,
  screenCoordinate,
  screenUV,
  smoothstep,
  texture,
  textureLoad,
  uniform,
  unpackRGBToNormal,
  uv,
  vec2,
  vec3,
  vec4,
  velocity,
} from 'three/tsl'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { ssgi } from 'three/addons/tsl/display/SSGINode.js'
import { ssr } from 'three/addons/tsl/display/SSRNode.js'
import { sss } from 'three/addons/tsl/display/SSSNode.js'
import { traa } from 'three/addons/tsl/display/TRAANode.js'
import type { Quality } from './renderer'

export type Pipeline = {
  render: () => void
  dispose: () => void
  /** Frames to keep rendering after a change so temporal AA, AO, and GI converge. */
  settleFrames: number
  /** The latest linear HDR frame, before finishing; it holds still while nothing renders. */
  hdr: Texture
}

/** Display-referred finishing: filmic tone mapping, a soft lens vignette, and dither. */
function finish(hdr: Node<'vec4'>) {
  const display = renderOutput(hdr)
  const edge = screenUV.sub(0.5).length().mul(1.18)
  const vignette = mix(float(0.8), float(1), smoothstep(0.98, 0.32, edge))
  const dither = interleavedGradientNoise(screenCoordinate.xy)
    .sub(0.5)
    .mul(1 / 255)
  return vec4(display.rgb.mul(vignette).add(dither), 1)
}

/** View distances (ft) over which contact shadows fade from full strength to none. */
const CONTACT_NEAR = 20
const CONTACT_FAR = 45

/** The raster sun, tagged by the atmosphere. */
function findSun(scene: Scene) {
  let sun: DirectionalLight | null = null
  scene.traverse((object) => {
    if (object.userData.sun && (object as DirectionalLight).isDirectionalLight)
      sun = object as DirectionalLight
  })
  return sun as DirectionalLight | null
}

/**
 * Builds the TSL render pipeline for a quality tier. Every tier uses the same scene graph.
 *
 * - Lite: one 4x MSAA scene pass.
 * - High: depth/normal/velocity pre-pass, GTAO injected only into ambient light, sun contact
 *   shadows, emissive bloom, temporal reprojection anti-aliasing.
 * - Ultra: High plus screen-space global illumination (one diffuse bounce of on-screen light) and
 *   screen-space reflections on metals.
 */
export function createPipeline(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
  quality: Quality,
): Pipeline {
  const pipeline = new RenderPipeline(renderer)
  pipeline.outputColorTransform = false
  const disposables: { dispose: () => void }[] = [pipeline]

  if (quality === 'lite') {
    const scenePass = pass(scene, camera, { samples: 4 })
    pipeline.outputNode = finish(scenePass)
    return {
      render: () => pipeline.render(),
      dispose: () => pipeline.dispose(),
      settleFrames: 1,
      hdr: scenePass.getTexture('output'),
    }
  }

  // Opaque geometry only: glazing must not occlude the interior in AO, GI, or reprojection.
  const prePass = pass(scene, camera)
  prePass.transparent = false
  const reflective = quality === 'ultra'
  prePass.setMRT(
    mrt(
      reflective
        ? {
            output: packNormalToRGB(normalView),
            velocity,
            metalrough: vec2(metalness, roughness),
          }
        : { output: packNormalToRGB(normalView), velocity },
    ),
  )
  prePass.getTexture('output').type = UnsignedByteType
  if (reflective) prePass.getTexture('metalrough').type = UnsignedByteType
  const preDepth = prePass.getTextureNode('depth')
  const preVelocity = prePass.getTextureNode('velocity')
  const preNormal = sample((uv) => unpackRGBToNormal(prePass.getTextureNode().sample(uv)))

  const occlusion = ao(preDepth, preNormal, camera)
  occlusion.resolutionScale = 0.5
  occlusion.radius.value = 0.9
  occlusion.thickness.value = 1.2
  occlusion.distanceExponent.value = 1.5
  occlusion.samples.value = 16
  disposables.push(occlusion)

  // Contact shadows: a short screen-space march toward the sun resolves the fine shadows a shadow
  // map spread over the whole site cannot (feet on the floor, a bench leg on paving, a plate on
  // its horn). They multiply the sun's shadow only, so lamps and sky light are untouched.
  let lighting = builtinAOContext(occlusion.getTextureNode().sample(screenUV).r)
  let contactDebug: Node<'float'> | null = null
  const sun = findSun(scene)
  if (sun) {
    const contact = sss(preDepth, camera, sun)
    contact.maxDistance.value = 0.45
    contact.thickness.value = 0.08
    contact.quality.value = quality === 'ultra' ? 0.6 : 0.4
    contact.resolutionScale = quality === 'ultra' ? 1 : 0.5
    contact.useTemporalFiltering = true
    disposables.push(contact)
    // Full strength up close, gone by mid-distance: far away the depth buffer is too coarse to
    // tell contact from noise, and the site-wide shadow map already covers those scales.
    const contactAt = (viewZ: Node<'float'>) =>
      mix(
        float(1),
        contact.getTextureNode().sample(screenUV).r,
        smoothstep(CONTACT_FAR, CONTACT_NEAR, viewZ.negate()).mul(0.85),
      )
    const contactNode = contactAt(positionView.z)
    const toViewZ = (camera as PerspectiveCamera).isPerspectiveCamera
      ? perspectiveDepthToViewZ
      : orthographicDepthToViewZ
    contactDebug = contactAt(toViewZ(preDepth.sample(screenUV).r, cameraNear, cameraFar))
    // Glazing is not in the depth pre-pass, so what the march found belongs to the surface behind
    // it; its sun glints keep the shadow map alone.
    lighting = context(lighting, {
      getShadow: (
        { light, shadowColorNode }: { light: unknown; shadowColorNode: Node<'vec3'> },
        { material }: { material: { transparent: boolean } },
      ) =>
        light === sun && !material.transparent ? shadowColorNode.mul(contactNode) : shadowColorNode,
    })
  }
  const scenePass = pass(scene, camera)
  scenePass.contextNode = lighting
  scenePass.setMRT(
    mrt(quality === 'ultra' ? { output, emissive, diffuseColor } : { output, emissive }),
  )
  const color = scenePass.getTextureNode('output')
  const glow = bloom(scenePass.getTextureNode('emissive'), 0.55, 0.45, 0.05)
  disposables.push(glow)

  let lit: Node<'vec4'> = color.add(vec4(glow.rgb, 0))
  if (quality === 'ultra') {
    const diffuseTexture = scenePass.getTexture('diffuseColor')
    diffuseTexture.type = UnsignedByteType
    const gi = ssgi(color, preDepth, preNormal, camera as PerspectiveCamera)
    gi.sliceCount.value = 2
    gi.stepCount.value = 10
    gi.radius.value = 6
    gi.thickness.value = 0.6
    gi.giIntensity.value = 1.4
    disposables.push(gi)
    const bounce = scenePass.getTextureNode('diffuseColor').rgb.mul(gi.getGINode().rgb)
    lit = lit.add(vec4(bounce, 0))
  }

  let reflectionNode: Node<'vec4'> | null = null
  if (reflective) {
    // Screen-space reflections for metals and metallic-coated glass: chrome, brushed steel, and
    // facade windows reflect what is actually on screen, on top of their probe reflections.
    const metalRough = prePass.getTextureNode('metalrough')
    const reflections = ssr(color, preDepth, preNormal, {
      metalnessNode: metalRough.r,
      roughnessNode: metalRough.g,
      camera,
    })
    reflections.resolutionScale = 0.5
    reflections.maxDistance.value = 60
    reflections.thickness.value = 0.6
    reflections.intensity.value = 0.7
    disposables.push(reflections)
    reflectionNode = vec4(reflections.rgb, 1)
    lit = lit.add(vec4(reflections.rgb, 0))
  }

  const resolved = traa(lit, preDepth, preVelocity, camera)
  disposables.push(resolved)
  pipeline.outputNode = finish(resolved)
  // `?debug=ao|normal|contact|reflections` shows the occlusion, normal, contact-shadow, or
  // screen-space reflection buffer for tuning.
  const debug = new URLSearchParams(window.location.search).get('debug')
  if (debug === 'ao')
    pipeline.outputNode = vec4(vec3(occlusion.getTextureNode().sample(screenUV).r), 1)
  if (debug === 'normal')
    pipeline.outputNode = vec4(prePass.getTextureNode().sample(screenUV).rgb, 1)
  if (debug === 'contact' && contactDebug) pipeline.outputNode = vec4(vec3(contactDebug), 1)
  if (debug === 'reflections' && reflectionNode) pipeline.outputNode = finish(reflectionNode)
  return {
    render: () => pipeline.render(),
    dispose: () => disposables.forEach((d) => d.dispose()),
    settleFrames: quality === 'ultra' ? 40 : 28,
    hdr: (resolved as unknown as { getTextureNode: () => { value: Texture } }).getTextureNode()
      .value,
  }
}

export type TracePresent = {
  /** Composites the traced images over the frozen raster frame and finishes them. */
  render: (view: { from: Texture | null; to: Texture; t: number; gain: number }) => void
  dispose: () => void
}

/**
 * Presents path-traced images with the same finishing as the raster image. `from` (or, when it is
 * null, the frozen raster frame) blends into `to`, so every change of image reads as the picture
 * settling rather than a cut. Bright highlights (lamps, sun glints) get a faint lens bloom, as a
 * camera would record them.
 */
export function createTracePresent(
  renderer: WebGPURenderer,
  raster: Texture,
  traced: Texture,
): TracePresent {
  const pipeline = new RenderPipeline(renderer)
  pipeline.outputColorTransform = false
  const t = uniform(0)
  const fromRaster = uniform(1)
  const size = uniform(new Vector2(1, 1))
  // Traced images are unfilterable float with rows top down, like screen coordinates.
  const gain = uniform(1)
  const pixel = ivec2(screenUV.mul(size).floor())
  const from = textureLoad(traced, pixel)
  const to = textureLoad(traced, pixel)
  const before = mix(vec4(from.rgb.mul(gain), 1), texture(raster), fromRaster)
  const after = vec4(to.rgb.mul(gain), 1)
  const glow = bloom(after, 0.16, 0.5, 1.4)
  const image = mix(before, after.add(vec4(glow.rgb, 0)), t)
  pipeline.outputNode = finish(image)
  return {
    render: (view) => {
      to.value = view.to
      from.value = view.from ?? view.to
      fromRaster.value = view.from ? 0 : 1
      const { width, height } = view.to.image as { width: number; height: number }
      size.value.set(width, height)
      t.value = view.t
      gain.value = view.gain
      pipeline.render()
    },
    dispose: () => {
      glow.dispose()
      pipeline.dispose()
    },
  }
}

/** What the spin shows (spin.ts): a frame, or a 360° panorama, fading in over the previous one. */
export type SpinView = {
  from: Texture | null
  to: Texture
  t: number
  /** For a panorama: the camera's rotation and lens, to look up each pixel's direction. */
  panorama: { rotation: Matrix3; tanHalfFov: number; aspect: number } | null
  /**
   * For a still rendered at another aspect ratio (angles.ts frameSize): the UV scale and offset
   * that crop it to cover the screen without stretching. Omitted: the frame fills the screen.
   */
  fit?: { scaleX: number; scaleY: number; offsetX: number; offsetY: number }
}

/**
 * Shows the path-traced spin. Its frames come finished from the server (exposure, bloom, tone
 * mapping, sRGB), so only the screen's vignette and dither are added, as finish() does. A
 * panorama is looked up per pixel by viewing direction, which is exact for any rotation.
 */
export function createSpinPresent(renderer: WebGPURenderer) {
  const pipeline = new RenderPipeline(renderer)
  pipeline.outputColorTransform = false
  const blank = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
  blank.needsUpdate = true
  const t = uniform(1)
  const isPanorama = uniform(0)
  const rotation = uniform(new Matrix3())
  const tanHalf = uniform(1)
  const aspect = uniform(1)
  const fitScale = uniform(new Vector2(1, 1))
  const fitOffset = uniform(new Vector2(0, 0))
  // Screen rows run top down, as frames do (screenUV's origin is the top left).
  const ndc = screenUV.mul(2).sub(1)
  const ray = vec3(ndc.x.mul(tanHalf).mul(aspect), ndc.y.mul(tanHalf).negate(), float(-1))
  const direction = rotation.mul(ray).normalize()
  // Cycles' equirectangular camera, measured: u = 0.5 + atan2(x, -z) / 2π, v = acos(y) / π.
  const panoramaUV = vec2(
    atan(direction.x, direction.z.negate())
      .div(Math.PI * 2)
      .add(0.5),
    acos(direction.y.clamp(-1, 1)).div(Math.PI),
  )
  const lookup = mix(screenUV.mul(fitScale).add(fitOffset), panoramaUV, isPanorama)
  const to = texture(blank, lookup)
  const from = texture(blank, lookup)
  const color = mix(from.rgb, to.rgb, t)
  const edge = screenUV.sub(0.5).length().mul(1.18)
  const vignette = mix(float(0.8), float(1), smoothstep(0.98, 0.32, edge))
  const dither = interleavedGradientNoise(screenCoordinate.xy)
    .sub(0.5)
    .mul(1 / 255)
  pipeline.outputNode = vec4(color.mul(vignette).add(dither), 1)
  return {
    render: (view: SpinView) => {
      to.value = view.to
      from.value = view.from ?? view.to
      t.value = view.from ? view.t : 1
      isPanorama.value = view.panorama ? 1 : 0
      fitScale.value.set(view.fit?.scaleX ?? 1, view.fit?.scaleY ?? 1)
      fitOffset.value.set(view.fit?.offsetX ?? 0, view.fit?.offsetY ?? 0)
      if (view.panorama) {
        rotation.value.copy(view.panorama.rotation)
        tanHalf.value = view.panorama.tanHalfFov
        aspect.value = view.panorama.aspect
      }
      pipeline.render()
    },
    dispose: () => {
      blank.dispose()
      pipeline.dispose()
    },
  }
}

/**
 * Matrix metering for HDR images: the log-average luminance over a coarse grid, as a camera
 * meters a scene. Used to hand over from the raster frame to the traced one without a jump in
 * brightness: the traced image keeps the exposure the viewer was looking at, while its light
 * distribution (occlusion, bounce, sky visibility) stays physically resolved.
 */
export function createExposureMeter(renderer: WebGPURenderer, sample: Texture) {
  const width = 48,
    height = 30
  const target = new RenderTarget(width, height, { type: FloatType, depthBuffer: false })
  const size = uniform(new Vector2(1, 1))
  // Material output is clamped to non-negative values, so store the log luminance offset.
  const OFFSET = 10
  const logLuminance = (color: Node<'vec4'>) =>
    vec4(log(max(luminance(color.rgb), float(1e-4))).add(OFFSET), 0, 0, 1)
  // Raster frames are filterable; traced images are unfilterable float and read texel by texel.
  const rasterNode = texture(sample, uv())
  const tracedNode = textureLoad(sample, ivec2(uv().mul(size).floor()))
  const rasterMaterial = new MeshBasicNodeMaterial()
  rasterMaterial.colorNode = logLuminance(rasterNode)
  const tracedMaterial = new MeshBasicNodeMaterial()
  tracedMaterial.colorNode = logLuminance(tracedNode)
  const quad = new QuadMesh(rasterMaterial)
  return {
    /** Mean log luminance of `image`; `traced` selects texel reads for unfilterable floats. */
    async measure(image: Texture, traced: boolean) {
      const material = traced ? tracedMaterial : rasterMaterial
      if (traced) {
        tracedNode.value = image
        const { width: w, height: h } = image.image as { width: number; height: number }
        size.value.set(w, h)
      } else rasterNode.value = image
      quad.material = material
      const previous = renderer.getRenderTarget()
      renderer.setRenderTarget(target)
      quad.render(renderer)
      renderer.setRenderTarget(previous)
      const pixels = (await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        width,
        height,
      )) as Float32Array
      const stride = pixels.length / height
      let sum = 0
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) sum += pixels[y * stride + x * 4]
      return sum / (width * height) - OFFSET
    },
    dispose() {
      target.dispose()
      rasterMaterial.dispose()
      tracedMaterial.dispose()
    },
  }
}
