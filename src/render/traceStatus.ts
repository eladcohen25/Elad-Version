import { useSyncExternalStore } from 'react'

/**
 * Live path-tracing progress, kept outside React state so the status badge can update several
 * times a second without re-rendering the 3D scene tree. Free of three.js imports.
 */
export type TraceState = 'off' | 'preparing' | 'tracing' | 'converged'
/** Where the view is being path traced: on this device or on a cloud GPU. */
export type TraceSource = 'local' | 'cloud'
export type TraceStatus = {
  state: TraceState
  source: TraceSource
  /** Samples per pixel reached by every pixel. */
  samples: number
  /** Samples per pixel the current pass is refining toward. */
  target: number
  /** True while an exported still is waiting on the tracer. */
  exporting: boolean
}

const OFF: TraceStatus = { state: 'off', source: 'local', samples: 0, target: 0, exporting: false }
let current = OFF
const listeners = new Set<() => void>()

export function setTraceStatus(next: TraceStatus) {
  if (
    next.state === current.state &&
    next.source === current.source &&
    next.samples === current.samples &&
    next.target === current.target &&
    next.exporting === current.exporting
  )
    return
  current = next
  listeners.forEach((listener) => listener())
}

export function traceStatus() {
  return current
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useTraceStatus() {
  return useSyncExternalStore(subscribe, traceStatus, traceStatus)
}

/** Orbit views pre-rendered in the cloud around the resting view; null when none are. */
export type PrerenderProgress = { ready: number; total: number } | null
let prerender: PrerenderProgress = null
const prerenderListeners = new Set<() => void>()

export function setPrerenderProgress(next: PrerenderProgress) {
  if (next?.ready === prerender?.ready && next?.total === prerender?.total) return
  prerender = next
  prerenderListeners.forEach((listener) => listener())
}

function subscribePrerender(listener: () => void) {
  prerenderListeners.add(listener)
  return () => {
    prerenderListeners.delete(listener)
  }
}

const prerenderProgress = () => prerender

export function usePrerenderProgress() {
  return useSyncExternalStore(subscribePrerender, prerenderProgress, prerenderProgress)
}

/** `?spin=0` keeps the earlier behaviour with a cloud renderer: real time while moving. */
export function spinEnabled(search = window.location.search) {
  return new URLSearchParams(search).get('spin') !== '0'
}

/** The path-traced spin's progress (spin.ts), for the loading screen and the status badge. */
export type SpinStatus = {
  active: boolean
  loading: boolean
  ready: number
  total: number
  final: number
  /** What the loading screen waits for, and how much of it is ready (spin.ts SpinProgress). */
  waitReady: number
  waitTotal: number
  failed: boolean
  /** The interior's 360° panorama, rather than the exterior spin. */
  panorama: boolean
  /** A path-traced frame of the current view is on screen (otherwise the raster frame is). */
  showing: boolean
}
const SPIN_OFF: SpinStatus = {
  active: false,
  loading: false,
  ready: 0,
  total: 0,
  final: 0,
  waitReady: 0,
  waitTotal: 0,
  failed: false,
  panorama: false,
  showing: false,
}
let spin = SPIN_OFF
const spinListeners = new Set<() => void>()

/** null when the spin stops. A failure stays: the spin is not tried again on this page. */
export function setSpinStatus(next: SpinStatus | null) {
  const value = next ?? { ...SPIN_OFF, failed: spin.failed }
  if ((Object.keys(value) as (keyof SpinStatus)[]).every((k) => value[k] === spin[k])) return
  spin = value
  spinListeners.forEach((listener) => listener())
}

function subscribeSpin(listener: () => void) {
  spinListeners.add(listener)
  return () => {
    spinListeners.delete(listener)
  }
}

const spinStatus = () => spin

export function useSpinStatus() {
  return useSyncExternalStore(subscribeSpin, spinStatus, spinStatus)
}

const never = () => () => {}

/** The spin status, re-rendering the caller only while `active` (the pre-warm, say). */
export function useSpinStatusWhen(active: boolean) {
  return useSyncExternalStore(active ? subscribeSpin : never, spinStatus, spinStatus)
}

const spinFailed = () => spin.failed

/** Whether the spin failed; unlike useSpinStatus, progress does not re-render the caller. */
export function useSpinFailed() {
  return useSyncExternalStore(subscribeSpin, spinFailed, spinFailed)
}

/** `?trace=0` or `?trace=1` overrides the default, which follows the device's quality tier. */
export function requestedTrace(search = window.location.search): boolean | null {
  const value = new URLSearchParams(search).get('trace')
  return value === '1' || value === 'on' ? true : value === '0' || value === 'off' ? false : null
}

/**
 * The cloud render server's address: VITE_CLOUD_RENDER_URL at build time. `?cloud=0` turns it
 * off, and `?cloud=<url>` points at a local server for development (localhost only).
 */
export function cloudUrl(search = window.location.search): string | null {
  const param = new URLSearchParams(search).get('cloud')
  if (param === '0' || param === 'off') return null
  if (param && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(param))
    return param.replace(/\/$/, '')
  const configured = import.meta.env.VITE_CLOUD_RENDER_URL as string | undefined
  return configured ? configured.replace(/\/$/, '') : null
}
