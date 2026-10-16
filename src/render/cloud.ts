import {
  DataTexture,
  DataUtils,
  HalfFloatType,
  NearestFilter,
  RGBAFormat,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type BufferAttribute,
  type BufferGeometry,
  type Camera,
  type InstancedMesh,
  type InterleavedBufferAttribute,
  type Light,
  type Material,
  type Mesh,
  type PerspectiveCamera,
  type RectAreaLight,
  type Scene,
  type SpotLight,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import type { SkyLook } from '../lib/visuals'
import {
  environmentTexture,
  lookKey,
  preparePathTraceScene,
  sceneSignature,
  sunLight,
} from './pathtrace'
import {
  AZIMUTH_STEPS,
  ViewCache,
  poseAt,
  poseMatrix,
  ringKey,
  ringOrder,
  type GridPose,
} from './orbit'
import { createExposureMeter } from './pipeline'
import { cloudUrl, type TraceState } from './traceStatus'
import { mark, markOnce, responseTiming, type Mark } from './timeline'

export { cloudUrl }

/**
 * Off-device rendering: the resting view is rendered by Blender Cycles on a cloud GPU with
 * hardware ray tracing (render-server/), and the result crossfades in like a local trace.
 *
 * The browser describes the same path-traced form of the scene the local tracer captures
 * (preparePathTraceScene): meshes, physically based materials, textures, lights, and the sky.
 * Bulky data travels as blobs named by the SHA-256 of their content: geometry, instance
 * matrices, the sky map, and texture files. The server keeps them, so a new camera angle or a
 * material edit sends only the small JSON description, and a blob is uploaded only when the
 * server answers that it is missing (409). Texture bytes are uploaded by the browser too.
 * The image comes back as linear half floats, so it gets exactly the same
 * finishing (exposure match, bloom, tone mapping) as a local trace.
 */

/** `?traceStats=1` logs each cloud render's timings. */
const TRACE_STATS = new URLSearchParams(window.location.search).get('traceStats') === '1'

/** Render settings sent with each view: adaptive sampling stops well before the cap. */
export const CLOUD_QUALITY = { samples: 1024, threshold: 0.01, timeLimit: 15 }
/**
 * A quick first image, shown while the full one renders: 64 samples, denoised. On an L40S it takes
 * about 1.5 s at 1200x827 instead of 14 s, and at that size it is hard to tell from the final.
 */
export const PREVIEW_QUALITY = { samples: 64, threshold: 0, timeLimit: 4 }
/** Longest edge of a cloud render, in device pixels. */
const MAX_EDGE = 3200
/** Crossfade into the cloud image, in milliseconds. */
const FADE_MS = 520
/** The traced image may brighten by two stops or darken by one to match the raster frame. */
const GAIN_RANGE = [0.5, 4] as const
/** Uploads in flight at once. */
const UPLOADS = 4
/**
 * This page's render session. The gateway gives each session a GPU of its own
 * (render-server/modal_app.py), so every request from the page, render or upload, names it. A query
 * parameter rather than a header: no CORS preflight depends on it, so a page works against a
 * gateway from before sessions too.
 */
const RENDER_SESSION =
  globalThis.crypto?.randomUUID?.().replaceAll('-', '') ??
  `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`

// --- Scene description ----------------------------------------------------------------------

export type Vec3 = [number, number, number]

export type CloudTexture = {
  blob: string
  /** Where the server may fetch the file itself (the site's own assets). */
  url?: string
  srgb: boolean
  wrap: 'repeat' | 'mirror' | 'clamp'
  /** three.js UV transform, column-major 3x3. */
  matrix: number[]
}

export type CloudMaterial = {
  color: Vec3
  roughness: number
  metalness: number
  emissive: Vec3
  emissiveIntensity: number
  transmission: number
  ior: number
  clearcoat: number
  clearcoatRoughness: number
  sheen: number
  sheenRoughness: number
  sheenColor: Vec3
  specularIntensity: number
  specularColor: Vec3
  opacity: number
  transparent: boolean
  alphaTest: number
  side: number
  normalScale: [number, number]
  maps: Partial<Record<MapSlot, string>>
}

export type CloudLight =
  | {
      type: 'area'
      shape: 'rect' | 'ellipse'
      matrix: number[]
      width: number
      height: number
      color: Vec3
      intensity: number
    }
  | {
      type: 'spot'
      position: Vec3
      direction: Vec3
      angle: number
      penumbra: number
      radius: number
      color: Vec3
      intensity: number
    }
  | { type: 'point'; position: Vec3; radius: number; color: Vec3; intensity: number }
  | { type: 'sun'; direction: Vec3; angle: number; color: Vec3; irradiance: number }

export type CloudObject = {
  id: string
  geometry: string
  materials: string[]
  matrix: number[]
  instances?: string
}

export type CloudScene = {
  objects: CloudObject[]
  materials: Record<string, CloudMaterial>
  textures: Record<string, CloudTexture>
  lights: CloudLight[]
  environment: { blob: string } | null
}

type MapSlot = 'map' | 'normalMap' | 'roughnessMap' | 'metalnessMap' | 'emissiveMap' | 'alphaMap'
const MAP_SLOTS: MapSlot[] = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
  'alphaMap',
]

/** Raw bytes of a blob, produced on demand (uploads are rare, so nothing is kept around). */
type BlobSource = () => Promise<Uint8Array>
type HashedBlob = { hash: string; source: BlobSource }

/** A captured scene: its description and where each referenced blob's bytes come from. */
export type CapturedScene = { scene: CloudScene; blobs: Map<string, BlobSource> }

async function sha256(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  let hex = ''
  for (const b of digest) hex += b.toString(16).padStart(2, '0')
  return hex
}

/** Hashes a blob once; the bytes are dropped and re-made from `source` if an upload needs them. */
async function hashed(source: BlobSource): Promise<HashedBlob> {
  return { hash: await sha256(await source()), source }
}

// Geometry -------------------------------------------------------------------------------------

function floats(attribute: BufferAttribute | InterleavedBufferAttribute, size: number) {
  const plain = attribute as BufferAttribute
  if (
    !(attribute as InterleavedBufferAttribute).isInterleavedBufferAttribute &&
    plain.array instanceof Float32Array &&
    plain.itemSize === size &&
    !plain.normalized
  )
    return plain.array.subarray(0, attribute.count * size)
  const out = new Float32Array(attribute.count * size)
  for (let i = 0; i < attribute.count; i++) {
    out[i * size] = attribute.getX(i)
    out[i * size + 1] = attribute.getY(i)
    if (size > 2) out[i * size + 2] = attribute.getZ(i)
  }
  return out
}

/** The FRG1 blob of a geometry (render-server/fury_render/protocol.py). */
export function encodeGeometry(geometry: BufferGeometry): Uint8Array {
  const position = geometry.getAttribute('position')
  const normal = geometry.getAttribute('normal')
  const uv = geometry.getAttribute('uv')
  const index = geometry.getIndex()
  const count = position.count
  const parts: Uint8Array[] = []
  let offset = 0
  const add = (array: Float32Array | Uint32Array) => {
    const at = offset
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
    parts.push(bytes)
    offset += bytes.byteLength
    return at
  }
  const indexCount = index ? index.count : count
  const header = {
    count,
    position: add(floats(position, 3)),
    normal: normal ? add(floats(normal, 3)) : null,
    uv: uv ? add(floats(uv, 2)) : null,
    index: index ? { offset: 0, count: index.count } : null,
    groups: geometry.groups.map((g) => [
      g.start,
      Math.min(g.count, indexCount - g.start),
      g.materialIndex ?? 0,
    ]),
  }
  if (index && header.index) {
    header.index.offset = add(
      index.array instanceof Uint32Array
        ? index.array.subarray(0, index.count)
        : Uint32Array.from(index.array.subarray(0, index.count)),
    )
  }
  let text = new TextEncoder().encode(JSON.stringify(header))
  if (text.byteLength % 4) {
    const padded = new Uint8Array(text.byteLength + 4 - (text.byteLength % 4)).fill(32)
    padded.set(text)
    text = padded
  }
  const out = new Uint8Array(8 + text.byteLength + offset)
  out.set([0x46, 0x52, 0x47, 0x31]) // FRG1
  new DataView(out.buffer).setUint32(4, text.byteLength, true)
  out.set(text, 8)
  let at = 8 + text.byteLength
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

function geometryVersion(geometry: BufferGeometry) {
  const parts = [geometry.index?.version ?? -1, geometry.groups.length]
  for (const name of ['position', 'normal', 'uv']) {
    const a = geometry.getAttribute(name) as BufferAttribute | undefined
    parts.push(a ? (a.version ?? 0) + a.count * 7 : -1)
  }
  return parts.join(',')
}

const geometryBlobs = new WeakMap<BufferGeometry, { version: string; blob: Promise<HashedBlob> }>()
function geometryBlob(geometry: BufferGeometry) {
  const version = geometryVersion(geometry)
  const cached = geometryBlobs.get(geometry)
  if (cached && cached.version === version) return cached.blob
  const blob = hashed(async () => encodeGeometry(geometry))
  geometryBlobs.set(geometry, { version, blob })
  return blob
}

/** The FRI1 blob of an instanced mesh's local matrices, copied now since they may change. */
export function encodeInstances(matrices: Float32Array, count: number) {
  const out = new Uint8Array(8 + count * 64)
  out.set([0x46, 0x52, 0x49, 0x31]) // FRI1
  new DataView(out.buffer).setUint32(4, count, true)
  new Float32Array(out.buffer, 8, count * 16).set(matrices.subarray(0, count * 16))
  return out
}

const instanceBlobs = new WeakMap<object, { version: string; blob: Promise<HashedBlob> }>()
function instanceBlob(mesh: InstancedMesh) {
  const version = `${mesh.instanceMatrix.version},${mesh.count}`
  const cached = instanceBlobs.get(mesh.instanceMatrix)
  if (cached && cached.version === version) return cached.blob
  const bytes = encodeInstances(mesh.instanceMatrix.array as Float32Array, mesh.count)
  const blob = hashed(async () => bytes)
  instanceBlobs.set(mesh.instanceMatrix, { version, blob })
  return blob
}

// Sky ------------------------------------------------------------------------------------------

/** The FRE1 blob of an equirect radiance map: half-float RGB, rows from v = 0 upward. */
export function encodeSky(data: Float32Array, width: number, height: number) {
  const out = new Uint8Array(12 + width * height * 6)
  out.set([0x46, 0x52, 0x45, 0x31]) // FRE1
  const view = new DataView(out.buffer)
  view.setUint32(4, width, true)
  view.setUint32(8, height, true)
  const half = new Uint16Array(out.buffer, 12, width * height * 3)
  for (let i = 0, j = 0; i < width * height; i++, j += 3) {
    half[j] = DataUtils.toHalfFloat(data[i * 4])
    half[j + 1] = DataUtils.toHalfFloat(data[i * 4 + 1])
    half[j + 2] = DataUtils.toHalfFloat(data[i * 4 + 2])
  }
  return out
}

const skyBlobs = new Map<string, Promise<HashedBlob>>()
function skyBlob(look: SkyLook) {
  const key = lookKey(look)
  let blob = skyBlobs.get(key)
  if (!blob) {
    const texture = environmentTexture(look)
    const { data, width, height } = texture.image as {
      data: Float32Array
      width: number
      height: number
    }
    const bytes = encodeSky(data, width, height)
    blob = hashed(async () => bytes)
    if (skyBlobs.size >= 4) skyBlobs.delete(skyBlobs.keys().next().value!)
    skyBlobs.set(key, blob)
  }
  return blob
}

// Textures -------------------------------------------------------------------------------------

const imageBlobs = new WeakMap<object, { version: number; blob: Promise<HashedBlob | null> }>()

async function pngOf(image: CanvasImageSource & { width: number; height: number }) {
  const canvas = new OffscreenCanvas(image.width, image.height)
  canvas.getContext('2d')!.drawImage(image, 0, 0)
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
}

/** A texture's image as a file: fetched from its URL when it has one, else encoded as PNG. */
function textureBlob(texture: Texture): { blob: Promise<HashedBlob | null>; url?: string } {
  const image = texture.source.data as unknown
  const key = texture.source as object
  const cached = imageBlobs.get(key)
  const url =
    typeof HTMLImageElement !== 'undefined' &&
    image instanceof HTMLImageElement &&
    /^https?:/.test(image.currentSrc || image.src)
      ? new URL(image.currentSrc || image.src, window.location.href).href
      : undefined
  if (cached && cached.version === texture.source.version) return { blob: cached.blob, url }
  let source: BlobSource | null = null
  if (url) {
    source = async () => new Uint8Array(await (await fetch(url)).arrayBuffer())
  } else if (
    (typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement) ||
    (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas) ||
    (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) ||
    (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement)
  ) {
    const drawable = image as CanvasImageSource & { width: number; height: number }
    // Canvases may be redrawn later; encode their pixels as they are now.
    const now = pngOf(drawable)
    source = () => now
  }
  const blob = source ? hashed(source).catch(() => null) : Promise.resolve(null)
  imageBlobs.set(key, { version: texture.source.version, blob })
  return { blob, url }
}

function wrapOf(texture: Texture): CloudTexture['wrap'] {
  // RepeatWrapping 1000, ClampToEdgeWrapping 1001, MirroredRepeatWrapping 1002
  const modes = [texture.wrapS, texture.wrapT]
  if (modes.includes(1000)) return 'repeat'
  if (modes.includes(1002)) return 'mirror'
  return 'clamp'
}

// Materials ------------------------------------------------------------------------------------

const color = (c: { r: number; g: number; b: number } | undefined, fallback: Vec3): Vec3 =>
  c ? [c.r, c.g, c.b] : fallback

function materialParams(
  material: Material,
  textureKey: (texture: Texture) => string,
): CloudMaterial {
  const m = material as Material & Record<string, unknown>
  const num = (name: string, fallback: number) =>
    typeof m[name] === 'number' && Number.isFinite(m[name]) ? (m[name] as number) : fallback
  const rgb = (name: string, fallback: Vec3) =>
    color(m[name] as { r: number; g: number; b: number } | undefined, fallback)
  const maps: CloudMaterial['maps'] = {}
  for (const slot of MAP_SLOTS) {
    const texture = m[slot] as Texture | null | undefined
    if (texture?.isTexture && texture.source?.data) maps[slot] = textureKey(texture)
  }
  const scale = m.normalScale as Vector2 | undefined
  return {
    color: rgb('color', [1, 1, 1]),
    roughness: num('roughness', 1),
    metalness: num('metalness', 0),
    emissive: rgb('emissive', [0, 0, 0]),
    emissiveIntensity: num('emissiveIntensity', 1),
    transmission: num('transmission', 0),
    ior: num('ior', 1.5),
    clearcoat: num('clearcoat', 0),
    clearcoatRoughness: num('clearcoatRoughness', 0),
    sheen: num('sheen', 0),
    sheenRoughness: num('sheenRoughness', 1),
    sheenColor: rgb('sheenColor', [0, 0, 0]),
    specularIntensity: num('specularIntensity', 1),
    specularColor: rgb('specularColor', [1, 1, 1]),
    opacity: num('opacity', 1),
    transparent: Boolean(m.transparent),
    alphaTest: num('alphaTest', 0),
    side: num('side', 0),
    normalScale: scale ? [scale.x, scale.y] : [1, 1],
    maps,
  }
}

// Lights ---------------------------------------------------------------------------------------

const v3 = (v: Vector3): Vec3 => [v.x, v.y, v.z]

function lightRecord(light: Light): CloudLight | null {
  const c = color(light.color, [1, 1, 1])
  if ((light as RectAreaLight).isRectAreaLight) {
    const area = light as RectAreaLight & { isCircular?: boolean }
    return {
      type: 'area',
      shape: area.isCircular ? 'ellipse' : 'rect',
      matrix: Array.from(area.matrixWorld.elements),
      width: area.width,
      height: area.height,
      color: c,
      intensity: area.intensity,
    }
  }
  if ((light as SpotLight).isSpotLight) {
    const spot = light as SpotLight & { radius?: number }
    const position = spot.getWorldPosition(new Vector3())
    const target = spot.target.getWorldPosition(new Vector3())
    return {
      type: 'spot',
      position: v3(position),
      direction: v3(target.sub(position).normalize()),
      angle: spot.angle,
      penumbra: spot.penumbra,
      radius: spot.radius ?? 0,
      color: c,
      intensity: spot.intensity,
    }
  }
  if ((light as Light & { isPointLight?: boolean }).isPointLight) {
    const point = light as Light & { radius?: number }
    return {
      type: 'point',
      position: v3(point.getWorldPosition(new Vector3())),
      radius: point.radius ?? 0,
      color: c,
      intensity: light.intensity,
    }
  }
  return null
}

// Capture --------------------------------------------------------------------------------------

/**
 * Describes the scene as the local path tracer would see it. The scene is read synchronously
 * while in its path-traced form; hashing blobs finishes asynchronously.
 */
export async function captureScene(scene: Scene, look: SkyLook): Promise<CapturedScene> {
  const environment = environmentTexture(look)
  const objects: {
    record: Omit<CloudObject, 'geometry' | 'instances'>
    geometry: Promise<HashedBlob>
    instances?: Promise<HashedBlob>
  }[] = []
  const materials: Record<string, CloudMaterial> = {}
  const textureRefs = new Map<string, Texture>()
  const lights: CloudLight[] = []
  const textureKey = (texture: Texture) => {
    textureRefs.set(texture.uuid, texture)
    return texture.uuid
  }
  const restore = preparePathTraceScene(scene, look, environment)
  try {
    scene.updateMatrixWorld()
    scene.traverseVisible((object) => {
      const light = object as Light
      if (light.isLight) {
        if (light.userData.sun) return
        const record = lightRecord(light)
        if (record && light.intensity > 0) lights.push(record)
        return
      }
      const mesh = object as Mesh
      if (!mesh.isMesh || !mesh.geometry?.getAttribute('position')) return
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const keys = list.map((material) => {
        if (!materials[material.uuid])
          materials[material.uuid] = materialParams(material, textureKey)
        return material.uuid
      })
      const instanced = mesh as InstancedMesh
      if (instanced.isInstancedMesh && instanced.count === 0) return
      objects.push({
        record: { id: mesh.uuid, materials: keys, matrix: Array.from(mesh.matrixWorld.elements) },
        geometry: geometryBlob(mesh.geometry),
        instances: instanced.isInstancedMesh ? instanceBlob(instanced) : undefined,
      })
    })
  } finally {
    restore()
  }
  const sun = sunLight(look)
  if (sun)
    lights.push({
      type: 'sun',
      direction: sun.direction,
      angle: sun.angularRadius * 2,
      color: sun.color,
      irradiance: sun.irradiance,
    })

  const blobs = new Map<string, BlobSource>()
  const keep = (blob: HashedBlob) => {
    blobs.set(blob.hash, blob.source)
    return blob.hash
  }
  const textures: Record<string, CloudTexture> = {}
  await Promise.all(
    [...textureRefs].map(async ([key, texture]) => {
      const { blob, url } = textureBlob(texture)
      const resolved = await blob
      if (!resolved) return
      texture.updateMatrix()
      textures[key] = {
        blob: keep(resolved),
        ...(url ? { url } : {}),
        srgb: texture.colorSpace === SRGBColorSpace,
        wrap: wrapOf(texture),
        matrix: Array.from(texture.matrix.elements),
      }
    }),
  )
  // Materials whose texture could not be read fall back to their plain values.
  for (const params of Object.values(materials))
    for (const slot of MAP_SLOTS)
      if (params.maps[slot] && !textures[params.maps[slot]!]) delete params.maps[slot]
  const resolved = await Promise.all(
    objects.map(async ({ record, geometry, instances }) => ({
      ...record,
      geometry: keep(await geometry),
      ...(instances ? { instances: keep(await instances) } : {}),
    })),
  )
  const sky = keep(await skyBlob(look))
  return {
    scene: { objects: resolved, materials, textures, lights, environment: { blob: sky } },
    blobs,
  }
}

// Transport ------------------------------------------------------------------------------------

async function gzip(bytes: Uint8Array) {
  const stream = new Response(bytes as BodyInit).body!.pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Undoes the wire packing of a rendered image (render-server protocol.py) into half floats. */
export function unpackImage(bytes: Uint8Array, width: number, height: number) {
  const n = width * height * 4
  if (bytes.byteLength < 2 * n) throw new Error('truncated cloud image')
  const hi = bytes.subarray(0, n)
  const lo = bytes.subarray(n, 2 * n)
  const out = new Uint16Array(n)
  const stride = width * 4
  for (let row = 0; row < height; row++) {
    const start = row * stride
    for (let i = start; i < start + 4; i++) out[i] = (hi[i] << 8) | lo[i]
    for (let i = start + 4; i < start + stride; i++)
      out[i] = (out[i - 4] + ((hi[i] << 8) | lo[i])) & 0xffff
  }
  return out
}

export class Superseded extends Error {}
/** The server or gateway is busy (rate limit, full queue): worth trying again shortly. */
export class Busy extends Error {}
/** The server answered a frame request with a view's raw image: it predates the spin. */
export class Outdated extends Error {}
/** Every cloud GPU is in use by other visitors: this page renders on its own device. */
export class Full extends Error {}

export type CloudCamera = { matrix: number[]; fov: number; near: number; far: number }

export function cameraRecord(camera: Camera): CloudCamera {
  const c = camera as PerspectiveCamera
  // Zoom narrows the field of view.
  const fov = (2 * Math.atan(Math.tan((c.fov * Math.PI) / 360) / (c.zoom || 1)) * 180) / Math.PI
  return { matrix: Array.from(camera.matrixWorld.elements), fov, near: c.near, far: c.far }
}

/** A rendered view as the server sent it: gzip-compressed packed half floats (protocol.py). */
export type CloudFrame = {
  bytes: Uint8Array
  width: number
  height: number
  stats: {
    queueMs: number
    prepareMs: number
    renderMs: number
    totalMs: number
    device: string
    /** Where the server denoised: "gpu" or "cpu". */
    denoise: string
  }
}

async function inflate(bytes: Uint8Array) {
  // A server that sent the image with Content-Encoding arrives already inflated.
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes
  const stream = new Response(bytes as BodyInit).body!.pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** The texture of a rendered view: linear half floats, rows top down. */
export async function decodeFrame(frame: CloudFrame) {
  const data = unpackImage(await inflate(frame.bytes), frame.width, frame.height)
  const texture = new DataTexture(data, frame.width, frame.height, RGBAFormat, HalfFloatType)
  texture.minFilter = texture.magFilter = NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

/**
 * "view" renders what the visitor looks at, "preview" a quick first version of it, and "orbit"
 * pre-renders views around it. The server renders queued previews first and pre-renders last.
 */
export type RenderKind = 'view' | 'preview' | 'orbit'

/** Client of one render server. */
export class CloudClient {
  readonly url: string
  private readonly session = Math.random().toString(36).slice(2)
  private seq = 0
  /** Uploads in flight, shared by renders that need the same blob (a preview and its view). */
  private readonly uploading = new Map<string, Promise<void>>()
  /** When the server last answered with an image: a warm GPU answers within seconds. */
  lastSuccess: number | null = null

  constructor(url: string) {
    this.url = url
    markOnce('cloud-client-created', { url, session: RENDER_SESSION })
  }

  /** True while the server has rendered recently enough that its GPU is likely still on. */
  get warm() {
    return this.lastSuccess !== null && performance.now() - this.lastSuccess < 4 * 60 * 1000
  }

  private async put(key: string, blobs: Map<string, BlobSource>, signal: AbortSignal) {
    const source = blobs.get(key)
    if (!source) throw new Error(`server asked for an unknown blob ${key}`)
    const raw = await source()
    // Image files are compressed already.
    const isImage = raw[0] === 0x89 || raw[0] === 0xff || raw[0] === 0x52
    const body = isImage ? raw : await gzip(raw)
    const response = await fetch(`${this.url}/blobs/${key}?session=${RENDER_SESSION}`, {
      method: 'PUT',
      body: body as BodyInit,
      signal,
    })
    if (!response.ok) throw new Error(`upload failed (${response.status})`)
  }

  private async upload(keys: string[], blobs: Map<string, BlobSource>, signal: AbortSignal) {
    const queue = [...keys]
    const worker = async () => {
      for (let key = queue.shift(); key; key = queue.shift()) {
        const shared = this.uploading.get(key)
        if (shared) {
          try {
            await shared
            continue
          } catch {
            // The other render gave up on it; upload it for this one.
            signal.throwIfAborted()
          }
        }
        const upload = this.put(key, blobs, signal).finally(() => {
          if (this.uploading.get(key) === upload) this.uploading.delete(key)
        })
        this.uploading.set(key, upload)
        await upload
      }
    }
    await Promise.all(Array.from({ length: Math.min(UPLOADS, keys.length) }, worker))
  }

  /**
   * Renders a view, uploading whatever the server is missing. Previews and pre-renders use
   * sessions of their own, so a newer view the visitor asked for never drops them, nor they it.
   */
  async render(
    captured: CapturedScene,
    camera: CloudCamera,
    width: number,
    height: number,
    signal: AbortSignal,
    kind: RenderKind = 'view',
  ): Promise<CloudFrame> {
    const start = performance.now()
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
    const response = await this.post(
      {
        // A session of its own for each kind, so none supersedes another.
        session: `${this.session}${kind === 'orbit' ? 'o' : kind === 'preview' ? 'p' : ''}`,
        kind,
        seq: ++this.seq,
        camera,
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: kind === 'preview' ? PREVIEW_QUALITY : CLOUD_QUALITY,
        // The image as a gzip file rather than gzip transfer encoding, so it can be kept compressed.
        transfer: 'file',
      },
      captured,
      signal,
    )
    const bytes = new Uint8Array(await response.arrayBuffer())
    const header = (name: string) => Number(response.headers.get(name) ?? 0)
    return {
      bytes,
      width: header('x-image-width'),
      height: header('x-image-height'),
      stats: {
        queueMs: header('x-queue-ms'),
        prepareMs: header('x-prepare-ms'),
        renderMs: header('x-render-ms'),
        totalMs: performance.now() - start,
        device: response.headers.get('x-device') ?? '',
        denoise: response.headers.get('x-denoise') ?? '',
      },
    }
  }

  /**
   * A finished frame of the path-traced spin (spin.ts): tone mapped, with bloom, as WebP. All
   * frames of one `generation` share a sequence number, so a newer generation (the design
   * changed) drops the ones still queued.
   */
  async frame(
    captured: CapturedScene,
    request: {
      camera: CloudCamera & { panorama?: boolean }
      width: number
      height: number
      quality: { samples: number; threshold: number; timeLimit: number }
      finish: { exposure: number; gain: number }
      priority: number
      generation: number
      /** Frames on another channel never supersede these (the exposure meter's own frame). */
      channel?: string
    },
    signal: AbortSignal,
  ): Promise<SpinFrame> {
    const start = performance.now()
    const response = await this.post(
      {
        session: `${this.session}${request.channel ?? 's'}`,
        seq: request.generation,
        kind: 'spin',
        priority: request.priority,
        output: 'frame',
        camera: request.camera,
        width: request.width,
        height: request.height,
        quality: request.quality,
        finish: request.finish,
      },
      captured,
      signal,
    )
    // An older server ignores the frame fields and renders a view: a half-float image, not WebP.
    if (!(response.headers.get('content-type') ?? '').startsWith('image/'))
      throw new Outdated('the render server does not finish spin frames; redeploy it')
    const header = (name: string) => Number(response.headers.get(name) ?? 0)
    const answered = performance.now()
    const image = await response.blob()
    return {
      image,
      cached: response.headers.get('x-cache') === 'hit',
      renderMs: header('x-render-ms'),
      totalMs: performance.now() - start,
      tracedKey: Number(response.headers.get('x-traced-key') ?? NaN),
      timing: {
        ...responseTiming(response.headers),
        transferMs: Math.round(performance.now() - answered),
        bytes: image.size,
      },
    }
  }

  /** Posts a render request, uploading whatever blobs the server asks for. */
  private async post(fields: object, captured: CapturedScene, signal: AbortSignal) {
    const encoded = new TextEncoder().encode(JSON.stringify({ ...fields, scene: captured.scene }))
    const payload = encoded.byteLength > 32 * 1024 ? await gzip(encoded) : encoded
    for (let attempt = 0; attempt < 3; attempt++) {
      markOnce('cloud-first-render-sent', { bytes: payload.byteLength })
      const sent = performance.now()
      const response = await fetch(`${this.url}/render?session=${RENDER_SESSION}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload as BodyInit,
        signal,
      })
      const timing = responseTiming(response.headers)
      markOnce('cloud-first-response', {
        status: response.status,
        roundTripMs: Math.round(performance.now() - sent),
        ...timing,
      })
      if (timing.cold !== undefined) markOnce('cloud-cold-start-seen', { ...timing })
      if (response.status === 409) {
        const answer = (await response.json()) as { missing?: string[]; superseded?: boolean }
        if (answer.superseded) throw new Superseded()
        if (answer.missing?.length) {
          mark('cloud-uploading-blobs', { count: answer.missing.length })
          const uploading = performance.now()
          await this.upload(answer.missing, captured.blobs, signal)
          mark('cloud-blobs-uploaded', {
            count: answer.missing.length,
            ms: Math.round(performance.now() - uploading),
          })
          continue
        }
      }
      if (response.ok)
        markOnce('cloud-first-render-answered', { status: response.status, ...timing })
      if (response.status === 503) {
        const answer = (await response.json().catch(() => null)) as { full?: boolean } | null
        if (answer?.full) throw new Full('every cloud GPU is in use')
      }
      if (response.status === 429 || response.status === 503)
        throw new Busy(`cloud renderer busy (${response.status})`)
      if (!response.ok) throw new Error(`cloud render failed (${response.status})`)
      this.lastSuccess = performance.now()
      return response
    }
    throw new Error('cloud render kept asking for uploads')
  }
}

/**
 * A finished spin frame as the server sent it (WebP), with the traced image's key: its mean log
 * luminance before finishing, metered as the browser meters (pipeline.ts createExposureMeter).
 */
export type SpinFrame = {
  image: Blob
  cached: boolean
  renderMs: number
  totalMs: number
  tracedKey: number
  /** The server's timing headers (timeline.ts responseTiming), for `?traceStats=1`. */
  timing: Mark['extra']
}

// Session --------------------------------------------------------------------------------------

/** What to put on screen: `from` (null for the frozen raster frame) blending into `to`. */
export type CloudView = { from: Texture | null; to: Texture; t: number; gain: number }

/** Where the camera orbits, for pre-rendered views; null outside the exterior orbit. */
export type OrbitContext = { target: Vector3 } | null

/** Rendered views kept in memory, compressed (a few MB each). */
const VIEW_CACHE_BYTES = 320 << 20
/** Pre-rendering pauses once the visitor has not touched the page for this long. */
const IDLE_MS = 3 * 60 * 1000

/** Where a resting camera sits in the orbit grid, and the key of its view. */
type Spot = {
  key: string
  ring: string
  pose: GridPose
  sceneKey: string
  size: Vector2
  camera: CloudCamera
}

/** One ring of pre-rendered views around the orbit target. */
type Ring = {
  key: string
  sceneKey: string
  target: Vector3
  /** Pre-rendering starts next to this pose and works outward. */
  pose: GridPose
  camera: CloudCamera
  size: Vector2
  abort: AbortController
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One cloud render per resting view, crossfaded in over whatever is on screen. Mirrors the parts
 * of PathTraceSession the frame loop uses.
 *
 * In the exterior orbit the camera rests on a grid of poses (orbit.ts). Each view rendered there
 * is kept, compressed, and the rest of its ring is pre-rendered in the background, nearest first,
 * so orbiting lands on finished views. Pre-rendering yields to the visitor's own views, stops when
 * the design changes, and pauses while the page is hidden or the visitor is idle.
 */
export class CloudSession {
  readonly client: CloudClient
  private readonly renderer: WebGPURenderer
  private readonly meter: ReturnType<typeof createExposureMeter>
  private readonly placeholder = new DataTexture(
    new Uint16Array(4),
    1,
    1,
    RGBAFormat,
    HalfFloatType,
  )
  private abort: AbortController | null = null
  private epoch = 0
  private image: DataTexture | null = null
  /** False while the image on screen is a preview. */
  private final = false
  private retired: DataTexture | null = null
  private from: Texture | null = null
  private start = 0
  private gain = 1
  private rasterKey: Promise<number> | null = null
  private readonly views = new ViewCache<CloudFrame>(VIEW_CACHE_BYTES)
  private ring: Ring | null = null
  /** The pre-render in flight, which the visitor's own view joins if it is the same. */
  private prerendering: { key: string; frame: Promise<CloudFrame> } | null = null
  /** The visitor's own render in flight; pre-rendering waits for it. */
  private interactive: Promise<unknown> | null = null
  /** The last captured scene, reused while the design is unchanged. */
  private capture: { key: string; scene: Promise<CapturedScene> } | null = null
  private live: { scene: Scene; look: SkyLook } | null = null
  private lastInput = performance.now()
  private readonly onInput = () => {
    this.lastInput = performance.now()
  }
  /** Called when an image arrives, to learn what it should fade from. */
  onArrive: (() => Texture | null) | null = null
  /** Called as orbit views are pre-rendered, and when pre-rendering starts or stops. */
  onProgress: ((progress: { ready: number; total: number } | null) => void) | null = null
  state: TraceState = 'off'
  /** True when the last request failed; the local tracer takes over. */
  failed = false
  stats: CloudFrame['stats'] | null = null

  constructor(renderer: WebGPURenderer, url: string) {
    this.renderer = renderer
    this.client = new CloudClient(url)
    this.meter = createExposureMeter(renderer, this.placeholder)
    this.placeholder.needsUpdate = true
    for (const event of ['pointerdown', 'keydown', 'wheel'])
      window.addEventListener(event, this.onInput, { passive: true })
  }

  /** The grid spot the camera rests on, or null when it is between poses or not orbiting. */
  private spot(scene: Scene, camera: Camera, look: SkyLook, orbit: OrbitContext): Spot | null {
    if (!orbit) return null
    const position = camera.getWorldPosition(new Vector3())
    const pose = poseAt(position, orbit.target)
    if (!pose) return null
    const sceneKey = String(sceneSignature(scene, lookKey(look)))
    const size = this.renderer.getDrawingBufferSize(new Vector2())
    const record = cameraRecord(camera)
    const ring = ringKey(sceneKey, orbit.target, pose, record.fov, `${size.x}x${size.y}`)
    return { key: `${ring}|a${pose.azimuth}`, ring, pose, sceneKey, size, camera: record }
  }

  /** True when the view from this camera is already rendered: no need to trace it locally. */
  hasCached(scene: Scene, camera: Camera, look: SkyLook, orbit: OrbitContext) {
    const spot = this.spot(scene, camera, look, orbit)
    return spot !== null && this.views.has(spot.key)
  }

  /** The captured scene for this design, captured now if it has not been yet. */
  private captured(scene: Scene, look: SkyLook, key: string) {
    if (this.capture?.key !== key) this.capture = { key, scene: captureScene(scene, look) }
    return this.capture.scene
  }

  begin(scene: Scene, camera: Camera, look: SkyLook, raster: Texture, orbit: OrbitContext = null) {
    this.halt()
    const epoch = ++this.epoch
    const rested = performance.now()
    const abort = new AbortController()
    this.abort = abort
    this.state = 'preparing'
    this.failed = false
    this.image = null
    this.final = false
    this.from = null
    this.live = { scene, look }
    this.rasterKey = this.meter.measure(raster, false).catch(() => NaN)
    const spot = this.spot(scene, camera, look, orbit)
    // Looking at something else: stop pre-rendering the orbit.
    if (!spot) this.stopRing()
    const cached = spot ? this.views.get(spot.key) : undefined
    if (TRACE_STATS)
      console.info(
        spot
          ? `[cloud view] orbit pose ${spot.pose.azimuth}/${spot.pose.polar}/${spot.pose.radius}, scene ${spot.sceneKey}${cached ? ', pre-rendered' : ''}`
          : '[cloud view] off the orbit grid',
      )
    const sceneKey = spot?.sceneKey ?? String(sceneSignature(scene, lookKey(look)))
    const size = spot?.size ?? this.renderer.getDrawingBufferSize(new Vector2())
    const view = cameraRecord(camera)
    /** Puts a rendered image on screen, fading from whatever is there now. */
    let finalShown = false
    const show = async (frame: CloudFrame, kind: 'preview' | 'view' | 'cached') => {
      if (epoch !== this.epoch || finalShown) return
      if (kind !== 'preview') finalShown = true
      // A preview that comes after its final image is dropped.
      const stale = () => epoch !== this.epoch || (kind === 'preview' && finalShown)
      const decoding = performance.now()
      const texture = await decodeFrame(frame)
      const decoded = performance.now()
      if (stale()) {
        texture.dispose()
        return
      }
      const [raster, traced] = await Promise.all([
        this.rasterKey,
        this.meter.measure(texture, true).catch(() => NaN),
      ])
      if (stale()) {
        texture.dispose()
        return
      }
      const ratio = Math.exp((raster ?? NaN) - traced)
      this.gain = Number.isFinite(ratio)
        ? Math.min(GAIN_RANGE[1], Math.max(GAIN_RANGE[0], ratio))
        : 1
      this.stats = frame.stats
      if (this.image) {
        // The final image fades in over the preview.
        this.retired?.dispose()
        this.retired = this.image
        this.from = this.image
      } else this.from = this.onArrive?.() ?? null
      this.image = texture
      this.final = kind !== 'preview'
      this.start = performance.now()
      if (TRACE_STATS) {
        const s = frame.stats
        const { width, height } = frame
        console.info(
          kind === 'cached'
            ? `[cloud render] ${width}x${height} pre-rendered view: on screen ${Math.round(this.start - rested)} ms after rest (decode ${Math.round(decoded - decoding)} ms, exposure match ${Math.round(this.start - decoded)} ms)`
            : `[cloud render] ${width}x${height} ${kind} on ${s.device}, ${s.denoise} denoising: on screen ${((this.start - rested) / 1000).toFixed(1)} s after rest (queue ${s.queueMs} ms, scene ${s.prepareMs} ms, render ${s.renderMs} ms)`,
        )
      }
    }
    const render = () =>
      this.captured(scene, look, sceneKey).then((captured) => {
        if (epoch !== this.epoch) return null
        this.state = 'tracing'
        // A quick preview first; the server renders it ahead of the full view.
        this.client
          .render(captured, view, size.x, size.y, abort.signal, 'preview')
          .then((frame) => show(frame, 'preview'))
          .catch(() => {})
        return this.client
          .render(captured, view, size.x, size.y, abort.signal)
          .then((frame) => ({ frame, cached: false }))
      })
    // Landing on the view being pre-rendered: wait for it rather than render it twice.
    const joined = spot && this.prerendering?.key === spot.key ? this.prerendering.frame : null
    const work: Promise<{ frame: CloudFrame; cached: boolean } | null> = cached
      ? Promise.resolve({ frame: cached, cached: true })
      : joined
        ? joined.then(
            (frame) => ({ frame, cached: true }),
            () => (epoch === this.epoch ? render() : null),
          )
        : render()
    if (joined) this.state = 'tracing'
    const shown: Promise<void> = work
      .then(async (result) => {
        if (!result) return
        if (spot && !result.cached) {
          this.views.set(spot.key, result.frame)
          this.progress()
        }
        await show(result.frame, result.cached ? 'cached' : 'view')
        if (epoch === this.epoch && spot && orbit) this.prerender(spot, orbit.target)
      })
      .catch((error) => {
        if (epoch !== this.epoch || error instanceof Superseded || abort.signal.aborted) return
        if (this.image) {
          // The preview is on screen: keep it as this view's image.
          console.warn('Cloud rendering failed; keeping the preview.', error)
          this.final = true
          return
        }
        console.warn('Cloud rendering failed; tracing on this device instead.', error)
        this.failed = true
        this.state = 'off'
      })
      .finally(() => {
        if (this.interactive === shown) this.interactive = null
      })
    // Pre-rendering waits until this view is on screen.
    this.interactive = shown
  }

  /** Pre-renders the ring around a resting view, or re-centers the ring already running. */
  private prerender(spot: Spot, target: Vector3) {
    if (this.ring?.key === spot.ring && !this.ring.abort.signal.aborted) {
      this.ring.pose = spot.pose
      return
    }
    this.stopRing()
    const ring: Ring = {
      key: spot.ring,
      sceneKey: spot.sceneKey,
      target: target.clone(),
      pose: spot.pose,
      camera: spot.camera,
      size: spot.size.clone(),
      abort: new AbortController(),
    }
    this.ring = ring
    this.progress()
    this.fill(ring)
      .catch(() => {})
      .finally(() => {
        if (this.ring !== ring) return
        this.ring = null
        this.progress()
      })
  }

  private stopRing() {
    if (!this.ring) return
    this.ring.abort.abort()
    this.ring = null
    this.progress()
  }

  private progress() {
    this.onProgress?.(this.prerendered)
  }

  private async fill(ring: Ring) {
    let failures = 0
    while (!ring.abort.signal.aborted) {
      const live = this.live
      // The design changed: these views would show the old one.
      if (!live || String(sceneSignature(live.scene, lookKey(live.look))) !== ring.sceneKey) return
      if (document.hidden || performance.now() - this.lastInput > IDLE_MS) {
        await sleep(1500)
        continue
      }
      if (this.interactive) {
        await this.interactive.catch(() => {})
        continue
      }
      const azimuth = ringOrder(ring.pose.azimuth).find((a) => !this.views.has(`${ring.key}|a${a}`))
      // The whole ring is rendered; it stays cached while the visitor orbits it.
      if (azimuth === undefined) return
      const key = `${ring.key}|a${azimuth}`
      const pose = { ...ring.pose, azimuth }
      const camera = { ...ring.camera, matrix: Array.from(poseMatrix(ring.target, pose).elements) }
      const frame = this.captured(live.scene, live.look, ring.sceneKey).then((captured) =>
        this.client.render(captured, camera, ring.size.x, ring.size.y, ring.abort.signal, 'orbit'),
      )
      this.prerendering = { key, frame }
      try {
        this.views.set(key, await frame)
        failures = 0
        this.progress()
      } catch (error) {
        if (ring.abort.signal.aborted) return
        if (error instanceof Superseded) continue
        if (++failures >= 3) return
        await sleep(4000 * failures)
      } finally {
        if (this.prerendering?.frame === frame) this.prerendering = null
      }
    }
  }

  /** Views of the current ring rendered so far, while one is being pre-rendered. */
  get prerendered(): { ready: number; total: number } | null {
    const ring = this.ring
    if (!ring) return null
    let ready = 0
    for (let a = 0; a < AZIMUTH_STEPS; a++) if (this.views.has(`${ring.key}|a${a}`)) ready++
    return { ready, total: AZIMUTH_STEPS }
  }

  /** True once an image has arrived for the current view. */
  get arrived() {
    return this.image !== null
  }

  step() {
    if (this.image && this.view().t >= 1) {
      this.retired?.dispose()
      this.retired = null
      if (this.final) this.state = 'converged'
    }
    return this.state === 'preparing' || this.state === 'tracing'
  }

  view(now = performance.now()): CloudView {
    if (!this.image) return { from: null, to: this.placeholder, t: 0, gain: 1 }
    const t = Math.min(1, (now - this.start) / FADE_MS)
    return { from: t < 1 ? this.from : null, to: this.image, t, gain: this.gain }
  }

  /** Stops the visitor's view; pre-rendering carries on while the design is unchanged. */
  halt() {
    this.epoch++
    this.abort?.abort()
    this.abort = null
    // The image may still be on screen while the next one fades from it.
    if (this.image) {
      this.retired?.dispose()
      this.retired = this.image
    }
    this.image = null
    this.state = 'off'
  }

  dispose() {
    this.halt()
    this.onProgress = null
    this.stopRing()
    for (const event of ['pointerdown', 'keydown', 'wheel'])
      window.removeEventListener(event, this.onInput)
    this.retired?.dispose()
    this.placeholder.dispose()
    this.meter.dispose()
  }
}
