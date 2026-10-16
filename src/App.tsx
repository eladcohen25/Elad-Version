import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  Bookmark,
  Camera,
  Check,
  ChevronDown,
  CircleHelp,
  Expand,
  ExternalLink,
  Eye,
  Leaf,
  Maximize,
  Minus,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Ruler,
  Share2,
  SlidersHorizontal,
  Undo2,
  X,
} from 'lucide-react'
import ConfigPanel from './components/ConfigPanel'
import FloorPlan from './components/FloorPlan'
import Modal from './components/Modal'
import { BriefDialog, EstimateDialog, LibraryDialog, ShareDialog } from './components/Dialogs'
import {
  DEFAULT_CAMERA,
  DEFAULT_CONFIG,
  FINISHES,
  SIGNATURES,
  area,
  distance,
  encodeConfig,
  environmentName,
  estimate,
  money,
  productName,
  productHeight,
  type Config,
  type SignatureId,
  type Unit,
  type View,
} from './lib/config'
import { useConfig } from './lib/useConfig'
import { productFamily } from './lib/products'
import { defaultQuality, onBattery, type Backend, type Quality } from './render/quality'
import {
  cloudUrl,
  requestedTrace,
  usePrerenderProgress,
  useSpinStatus,
  useTraceStatus,
} from './render/traceStatus'
import { textureProgress } from './render/progress'
import { mark } from './render/timeline'
import {
  ANGLES,
  DEFAULT_ANGLE,
  angleById,
  exploreEnabled,
  firstAngle,
  stepAngle,
} from './render/angles'
import { prewarmDesigns, prewarmRange } from './render/prewarm'

const Scene = lazy(() =>
  import('./components/Scene').then((m) => {
    mark('scene-chunk-loaded')
    return m
  }),
)
type Dialog = 'share' | 'brief' | 'estimate' | 'library' | 'help' | null

export default function App() {
  const { config, setConfig, undo, redo, canUndo, canRedo, initialNotice } = useConfig()
  const [step, setStep] = useState(0),
    [view, setView] = useState<View>('exterior'),
    [unit, setUnit] = useState<Unit>('ft')
  const [dimensions, setDimensions] = useState(false),
    [quality, setQuality] = useState<Quality>(() => defaultQuality()),
    [backend, setBackend] = useState<Backend | null>(null),
    // A cloud renderer path traces on any device, so light devices get it too.
    [trace, setTrace] = useState(
      () => requestedTrace() ?? (cloudUrl() !== null || defaultQuality() !== 'lite'),
    )
  // An explicit choice (panel or ?quality=) is never overridden by the performance governor.
  const qualityChosen = useRef(new URLSearchParams(window.location.search).has('quality'))
  // On battery, path tracing on this device is off unless asked for: it runs the GPU flat out.
  // A cloud renderer does the work elsewhere, so it stays on.
  useEffect(() => {
    if (requestedTrace() !== null || cloudUrl() !== null) return
    let cancelled = false
    onBattery().then((battery) => {
      if (!cancelled && battery) setTrace(false)
    })
    return () => {
      cancelled = true
    }
  }, [])
  const [dialog, setDialog] = useState<Dialog>(null),
    [toast, setToast] = useState(initialNotice),
    [reset, setReset] = useState(0)
  const [autoRotate, setAutoRotate] = useState(false),
    [photoMode, setPhotoMode] = useState(false),
    [mobilePanel, setMobilePanel] = useState(true)
  const [camera, setCamera] = useState<[number, number, number]>(DEFAULT_CAMERA)
  // The showroom: a strip of composed camera angles (angles.ts). `?explore=1` frees the orbit.
  const explore = useMemo(() => exploreEnabled(), [])
  const [angle, setAngle] = useState(DEFAULT_ANGLE)
  const showAngle = useCallback((id: string) => {
    const next = angleById(id)
    setAngle(next.id)
    setView(next.view)
    setAutoRotate(false)
  }, [])
  usePrewarm(setConfig, setCamera, setAngle, setView)
  const captureRef = useRef<(() => Promise<string>) | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notify = useCallback((s: string) => {
    setToast(s)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(''), 6500)
  }, [])
  const chooseQuality = useCallback((next: Quality) => {
    qualityChosen.current = true
    setQuality(next)
  }, [])
  const onSlow = useCallback(() => {
    if (qualityChosen.current || quality === 'lite') return
    const next = quality === 'ultra' ? 'high' : 'lite'
    setQuality(next)
    notify(
      `Switched to ${next === 'high' ? 'High' : 'Lite'} quality for smoother interaction on this device. You can change it under Surroundings.`,
    )
  }, [quality, notify])
  const onCaptureReady = useCallback((capture: () => Promise<string>) => {
    captureRef.current = capture
  }, [])
  const capture = useCallback(async () => {
    if (view === 'plan' || !captureRef.current) return null
    try {
      return (await captureRef.current()) || null
    } catch {
      return null
    }
  }, [view])
  const close = () => setDialog(null)
  useEffect(() => {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#c=${encodeConfig(config)}`,
    )
  }, [config])
  useEffect(() => {
    if (initialNotice) timer.current = setTimeout(() => setToast(''), 6500)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [initialNotice])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (dialog || ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName))
        return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
      if (e.key === 'Escape') setPhotoMode(false)
      if (!explore && view !== 'plan' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        showAngle(stepAngle(angle, e.key === 'ArrowRight' ? 1 : -1).id)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [dialog, undo, redo, explore, view, angle, showAngle])
  const signature = (id: SignatureId) => {
    const build = SIGNATURES.find((s) => s.id === id)!
    if (
      !window.confirm(
        `Apply the ${build.name} build? This replaces your current design, including product family, size, and equipment. You can undo the change.`,
      )
    )
      return
    setConfig(structuredClone(build.config))
    setCamera(build.camera)
    setView('exterior')
    setAngle(DEFAULT_ANGLE)
    setReset((r) => r + 1)
    notify(`${build.name} applied. Every option stays editable; the build still requires a quote.`)
  }
  const photo = async () => {
    if (trace && backend === 'webgpu')
      notify('Rendering a path-traced image. Hold the view still for a moment.')
    const image = await capture()
    if (!image) {
      notify('Your scene is still getting ready. Try again in a moment.')
      return
    }
    const a = document.createElement('a')
    a.href = image
    a.download = `Fury-${config.family}-${config.length}-${config.finish}.png`
    a.click()
    notify('Your gym image is downloaded. Concept rendering, not manufacturer photography.')
  }
  const startingPrice = estimate(config).startingPrice,
    finish = FINISHES.find((f) => f.id === config.finish)!
  return (
    <div
      className={`app ${photoMode ? 'photo-mode' : ''} ${mobilePanel ? 'panel-open' : 'panel-closed'}`}
    >
      <a className="skip-link" href="#configuration">
        Skip to configuration
      </a>
      <header className="header">
        <a
          className="brand"
          href={window.location.pathname}
          onClick={(e) => {
            e.preventDefault()
            setDialog('help')
          }}
          aria-label="Fury gym information"
        >
          <svg viewBox="0 0 30 30" aria-hidden="true">
            <path d="M3 5h24l-4 6H10v4h11l-4 6h-7v6H3z" />
          </svg>
          <span>FURY</span>
          <span className="brand-divider" />
          <small>
            GYM
            <br />
            CONFIGURATOR
          </small>
        </a>
        <div className="header-center">
          <span className="live-dot" /> YOUR SPACE. YOUR WAY.
        </div>
        <nav className="header-actions" aria-label="Build actions">
          <button onClick={() => setDialog('library')}>
            <Bookmark size={16} />
            <span>My builds</span>
          </button>
          <button onClick={() => setDialog('share')}>
            <Share2 size={16} />
            <span>Share</span>
          </button>
          <button
            className="help-button"
            aria-label="Help and information"
            onClick={() => setDialog('help')}
          >
            <CircleHelp size={18} />
          </button>
        </nav>
      </header>
      <main className="workspace">
        <section
          className={`stage ${view === 'plan' ? 'is-plan' : ''}`}
          aria-label="Gym visualization"
        >
          {view === 'plan' ? (
            <FloorPlan config={config} unit={unit} onChange={setConfig} notify={notify} />
          ) : (
            <Suspense
              fallback={
                <div className="scene-loading">
                  <span className="loading-mark">F</span>
                  <p>Making room for possibility.</p>
                </div>
              }
            >
              <Scene
                config={config}
                view={view}
                dimensions={dimensions}
                unit={unit}
                reset={reset}
                camera={camera}
                angle={explore ? null : angle}
                autoRotate={autoRotate}
                quality={quality}
                trace={trace}
                onCaptureReady={onCaptureReady}
                onFallback={() => setView('plan')}
                onBackend={setBackend}
                onSlow={onSlow}
              />
            </Suspense>
          )}
          {view !== 'plan' && <SpinLoading compact={!explore} />}
          <div className="stage-heading">
            <span className="eyebrow">
              <span className="small-line" />{' '}
              {config.family === 'studio' ? 'THE S-SERIES COLLECTION' : 'CONTAINER GYMS'}
            </span>
            <h1>
              {config.family === 'studio' ? 'S' : 'C'}-{config.length}
              <span>
                Space to
                <br />
                become more.
              </span>
            </h1>
            <div className="studio-meta">
              {area(config.length * 8, unit)}
              <i />
              {finish.name}
              <i />
              {distance(productHeight(config), unit)} high
            </div>
            {config.studioLayout !== 'single' && (
              <p className="custom-preview-note">
                Custom project requested · Single reference unit shown
              </p>
            )}
          </div>
          <div className="view-switch" role="group" aria-label="Camera views">
            {(['exterior', 'interior', 'plan'] as const).map((v, i) => {
              const icons = [Expand, Eye, Maximize],
                Icon = icons[i]
              return (
                <button
                  key={v}
                  aria-pressed={view === v}
                  className={view === v ? 'active' : ''}
                  onClick={() => {
                    if (v !== 'plan' && !explore) showAngle(firstAngle(v).id)
                    else {
                      setView(v)
                      setAutoRotate(false)
                    }
                    if (v === 'plan') setStep(2)
                  }}
                >
                  <Icon size={14} />
                  <span>{v === 'plan' ? 'Floor plan' : v[0].toUpperCase() + v.slice(1)}</span>
                </button>
              )
            })}
          </div>
          <div className="stage-tools" aria-label="Scene controls">
            <button
              className={dimensions ? 'active' : ''}
              aria-label="Show dimensions"
              aria-pressed={dimensions}
              onClick={() => setDimensions(!dimensions)}
              disabled={view === 'plan'}
            >
              <Ruler size={18} />
              <span>Dimensions</span>
            </button>
            <button
              aria-label="Reset camera"
              onClick={() => {
                if (!explore)
                  showAngle(view === 'interior' ? firstAngle('interior').id : DEFAULT_ANGLE)
                setReset((r) => r + 1)
              }}
              disabled={view === 'plan'}
            >
              <RotateCcw size={17} />
              <span>Reset view</span>
            </button>
            {explore && (
              <button
                className={autoRotate ? 'active' : ''}
                aria-label={autoRotate ? 'Pause rotation' : 'Rotate automatically'}
                aria-pressed={autoRotate}
                disabled={view !== 'exterior'}
                onClick={() => setAutoRotate(!autoRotate)}
              >
                {autoRotate ? <Pause size={17} /> : <Play size={17} />}
                <span>Auto rotate</span>
              </button>
            )}
            <span className="tool-divider" />
            <button
              aria-label="Enter photo mode"
              onClick={() => {
                setView('exterior')
                setPhotoMode(true)
                setMobilePanel(false)
              }}
            >
              <Camera size={18} />
              <span>Photo mode</span>
            </button>
          </div>
          {photoMode && (
            <div className="photo-controls">
              <span>
                PHOTO MODE <small>Concept rendering</small>
              </span>
              <button onClick={photo}>
                <ArrowDownToLine size={16} /> Save image
              </button>
              <button
                aria-label="Exit photo mode"
                onClick={() => {
                  setPhotoMode(false)
                  setMobilePanel(true)
                }}
              >
                <X size={18} />
              </button>
            </div>
          )}
          {view !== 'plan' && <MaterialProgress />}
          {view !== 'plan' && !explore && !photoMode && (
            <div className="angle-strip" role="tablist" aria-label="Camera angles">
              {ANGLES.map((a) => (
                <button
                  key={a.id}
                  role="tab"
                  aria-selected={angle === a.id}
                  className={`angle ${angle === a.id ? 'active' : ''} ${a.view}`}
                  onClick={() => showAngle(a.id)}
                >
                  <span>{a.label}</span>
                </button>
              ))}
            </div>
          )}
          {view !== 'plan' && (
            <div className="stage-bottom">
              <div className="scene-status">
                <span className="status-dot" />
                <strong>LIVE 3D</strong>
                {backend && (
                  <span className="render-backend">
                    {backend === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · {quality}
                  </span>
                )}
                <TraceBadge />
                <span>Concept visualization · Not manufacturer CAD</span>
              </div>
              <div className="scene-hint">
                {explore
                  ? view === 'interior'
                    ? 'Drag to look around'
                    : 'Drag to orbit · Scroll to explore'
                  : 'Choose an angle · Arrow keys step through'}
              </div>
              <button className="environment-quick" onClick={() => setStep(3)}>
                <Leaf size={14} />
                {environmentName(config.environment)}
                <ChevronDown size={13} />
              </button>
            </div>
          )}
          <div className="history-controls">
            <button aria-label="Undo last change" disabled={!canUndo} onClick={undo}>
              <Undo2 size={16} />
            </button>
            <button aria-label="Redo last change" disabled={!canRedo} onClick={redo}>
              <Redo2 size={16} />
            </button>
          </div>
          <button
            className="mobile-toggle"
            onClick={() => setMobilePanel(!mobilePanel)}
            aria-expanded={mobilePanel}
            aria-controls="configuration"
          >
            <SlidersHorizontal size={16} />
            {mobilePanel ? 'Hide options' : 'Customize gym'}
            {mobilePanel ? <Minus size={14} /> : <Plus size={14} />}
          </button>
        </section>
        <div id="configuration" className="panel-wrapper">
          <ConfigPanel
            config={config}
            onChange={setConfig}
            step={step}
            setStep={setStep}
            unit={unit}
            setUnit={setUnit}
            quality={quality}
            setQuality={chooseQuality}
            trace={trace}
            setTrace={setTrace}
            traceSupported={backend === 'webgpu'}
            notify={notify}
            onPlan={() => {
              setView('plan')
              setPhotoMode(false)
            }}
            onSignature={signature}
          />
        </div>
      </main>
      <footer className="summary-bar">
        <div className="summary-product">
          <span className="summary-monogram">
            {config.family === 'studio' ? 'S' : 'C'}
            {config.length}
          </span>
          <div>
            <strong>Your {productName(config)}</strong>
            <span>
              {distance(config.length, unit)} × {distance(8, unit)} · {finish.name} ·{' '}
              {config.items.length} equipment items
            </span>
          </div>
        </div>
        <div className="summary-estimate">
          <button onClick={() => setDialog('estimate')}>
            <span>
              {productFamily(config.family).shortName.toUpperCase()} FAMILY STARTING AT <InfoIcon />
            </span>
            <strong>
              {money(startingPrice)}
              <small>USD</small>
              <ChevronDown size={15} />
            </strong>
          </button>
          <small>Selected build: quote required</small>
        </div>
        <button className="primary brief-cta" onClick={() => setDialog('brief')}>
          <span>
            Create build brief<small>Your vision, in one beautiful PDF.</small>
          </span>
          <ArrowRight size={19} />
        </button>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          <span>{toast}</span>
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {dialog === 'estimate' && <EstimateDialog config={config} onClose={close} />}
      {dialog === 'share' && <ShareDialog config={config} onClose={close} notify={notify} />}
      {dialog === 'brief' && (
        <BriefDialog config={config} capture={capture} onClose={close} notify={notify} />
      )}
      {dialog === 'library' && (
        <LibraryDialog
          config={config}
          unit={unit}
          onLoad={setConfig}
          onClose={close}
          notify={notify}
        />
      )}
      {dialog === 'help' && (
        <Modal
          title="A clearer starting point."
          subtitle="Explore. Personalize. Bring your vision into focus."
          onClose={close}
        >
          <div className="help-grid">
            <div>
              <span>01</span>
              <strong>Shape your space</strong>
              <p>
                Choose your footprint, finishes, and outdoor additions. Size changes never silently
                reset your selections.
              </p>
            </div>
            <div>
              <span>02</span>
              <strong>Find your ritual</strong>
              <p>
                Start from an interior package. Drag items in the floor plan, use arrow keys to move
                them, R to rotate, or Delete to remove.
              </p>
            </div>
            <div>
              <span>03</span>
              <strong>Keep the possibilities</strong>
              <p>
                Save and compare builds locally. Share a complete configuration or download a PDF
                brief to discuss with your project team.
              </p>
            </div>
          </div>
          <div className="notice">
            <CircleHelp size={18} />
            <p>
              This is a concept design tool, not a purchasing or engineering system. Family starting
              prices are published; configured totals require a quote. Equipment, materials, and
              geometry are illustrative. No sales requests, deposits, or personal data are
              transmitted.
            </p>
          </div>
          <p className="muted small">
            Camera: drag / pinch / scroll, or focus the scene and use arrow keys and +/−. Undo:
            Ctrl/Cmd+Z. Redo: Ctrl/Cmd+Shift+Z. Floor plan: arrow keys move 3 inches; Shift moves 1
            foot.
          </p>
          <button
            className="secondary full"
            onClick={() => {
              if (
                window.confirm(
                  'Reset to the original Studio concept? Saved builds will not be deleted.',
                )
              ) {
                setConfig(structuredClone(DEFAULT_CONFIG))
                setCamera(DEFAULT_CAMERA)
                setView('exterior')
                setAngle(DEFAULT_ANGLE)
                setReset((r) => r + 1)
                close()
                notify('Your design is reset. Undo is available.')
              }
            }}
          >
            <RotateCcw size={16} /> Start fresh
          </button>
        </Modal>
      )}
    </div>
  )
}
declare global {
  interface Window {
    __furyPrewarm?: {
      total: number
      from: number
      to: number
      done: number
      current: string
      finished: boolean
      timedOut: string[]
    }
  }
}

/** A design's stills are all at full quality when every angle is final. */
const PREWARM_DESIGN_TIMEOUT_MS = 180_000

/**
 * `?prewarm=1` (or `?prewarm=<from>-<to>`): steps through prewarmDesigns, applying each and
 * waiting until every showroom still of it is rendered at full quality (or a timeout), so the
 * frame store holds them for visitors. Progress is on window.__furyPrewarm for scripts/prewarm.mjs.
 */
function usePrewarm(
  setConfig: (config: Config) => void,
  setCamera: (camera: [number, number, number]) => void,
  setAngle: (angle: string) => void,
  setView: (view: View) => void,
) {
  const spin = useSpinStatus()
  const designs = useMemo(() => prewarmDesigns(), [])
  const range = useMemo(() => prewarmRange(designs.length), [designs.length])
  const at = useRef(range ? range[0] : 0)
  const startedAt = useRef(0)
  const applied = useRef(false)
  const timedOut = useRef<string[]>([])
  useEffect(() => {
    if (!range) return
    const [from, to] = range
    const report = (current: string, finished = false) => {
      window.__furyPrewarm = {
        total: designs.length,
        from,
        to,
        done: at.current - from,
        current,
        finished,
        timedOut: timedOut.current,
      }
    }
    const apply = () => {
      if (at.current >= to) {
        report('', true)
        console.info(
          `[prewarm] finished ${to - from} designs (${timedOut.current.length} timed out)`,
        )
        return
      }
      const design = designs[at.current]
      setConfig(design.config)
      setCamera(design.camera)
      setAngle(DEFAULT_ANGLE)
      setView('exterior')
      startedAt.current = performance.now()
      applied.current = true
      report(design.label)
      console.info(`[prewarm] ${at.current + 1}/${to}: ${design.label}`)
    }
    if (!applied.current) {
      apply()
      return
    }
    // The current design is done once every still is final; the spin status counts them.
    const complete = spin.active && spin.total > 0 && spin.final >= spin.total
    const late = performance.now() - startedAt.current > PREWARM_DESIGN_TIMEOUT_MS
    if (complete || late || spin.failed) {
      if (late && !complete) timedOut.current.push(designs[at.current].label)
      if (spin.failed) {
        console.warn('[prewarm] the cloud renderer is unavailable; stopping.')
        report(designs[at.current].label, true)
        return
      }
      at.current++
      apply()
    }
  }, [range, designs, spin, setConfig, setCamera, setAngle, setView])
}

/**
 * Covers the scene while the cloud path traces the spin, so the first view seen is the finished
 * one: on opening until the view is ready at full quality and the angles either side of it as
 * previews, and later whenever a view has no path-traced frame yet (the interior's first visit,
 * say). It gives up after a minute and a half.
 */
function SpinLoading({ compact = false }: { compact?: boolean }) {
  const spin = useSpinStatus()
  const [opened, setOpened] = useState(false)
  const done = spin.active && !spin.loading
  useEffect(() => {
    if (done) setOpened(true)
  }, [done])
  const waiting = spin.active && !spin.failed && spin.loading && (!opened || !spin.showing)
  if (!waiting) return null
  // The showroom never covers the scene: the real-time frame shows while the still renders.
  if (compact)
    return (
      <div className="still-pill" role="status" aria-live="polite">
        <span className="still-pill-dot" />
        Rendering photoreal still
      </div>
    )
  const progress = spin.panorama ? null : spin.waitReady / Math.max(1, spin.waitTotal)
  return (
    <div className={`spin-loading ${opened ? 'later' : ''}`} role="status" aria-live="polite">
      <span className="loading-mark">F</span>
      <strong>{spin.panorama ? 'Path tracing the interior' : 'Path tracing your gym'}</strong>
      <p>
        {spin.panorama
          ? 'A 360° view, so looking around stays photoreal'
          : spin.waitReady
            ? `${spin.waitReady} of ${spin.waitTotal} angles ready`
            : 'Lighting every angle with true bounce light'}
      </p>
      <span className={`spin-progress ${progress === null ? 'indeterminate' : ''}`}>
        <span style={progress === null ? undefined : { width: `${Math.round(progress * 100)}%` }} />
      </span>
    </div>
  )
}

/** Path-tracing progress for a resting view, or the export waiting on it. */
function TraceBadge() {
  const status = useTraceStatus()
  const orbit = usePrerenderProgress()
  const spin = useSpinStatus()
  if (spin.active) {
    const label = spin.panorama
      ? spin.final
        ? 'Path traced · 360°'
        : 'Path tracing 360° view'
      : spin.final >= spin.total
        ? 'Path traced · every angle'
        : spin.ready === 0
          ? // The previous design stays on screen until its first new frame arrives.
            'Path tracing your changes'
          : `Path traced · ${spin.final}/${spin.total} angles in full`
    const state = spin.final >= spin.total ? 'converged' : 'tracing'
    return (
      <span
        className={`trace-badge ${state}`}
        role="status"
        aria-live="polite"
        title="Every view is path traced in the cloud: true bounce light, soft shadows, and real reflections."
      >
        <span
          className="trace-meter"
          style={{ '--progress': spin.final / Math.max(1, spin.total) } as never}
        />
        {label}
      </span>
    )
  }
  if (status.state === 'off') return null
  const label =
    status.state === 'converged'
      ? !orbit
        ? 'Path traced'
        : // Angles around this one render in the background, so orbiting shows them at once.
          orbit.ready < orbit.total
          ? `Path traced · ${orbit.ready}/${orbit.total} angles ready`
          : 'Path traced · all angles ready'
      : status.source === 'cloud'
        ? 'Path tracing in the cloud'
        : status.state === 'preparing'
          ? 'Preparing path tracer'
          : // Settled regions stop early, so the cap is not where most views finish.
            `Path tracing · ${status.samples} samples`
  return (
    <span
      className={`trace-badge ${status.state}`}
      role="status"
      aria-live="polite"
      title="The resting view refines with physically based path tracing: true bounce light, soft shadows, and real reflections."
    >
      <span
        className="trace-meter"
        style={{ '--progress': Math.min(1, status.samples / Math.max(1, status.target)) } as never}
      />
      {status.exporting ? `Rendering image · ${status.samples} samples` : label}
    </span>
  )
}

/** Shows progress while the photo-scanned material library streams in. */
function MaterialProgress() {
  const { requested, loaded } = useSyncExternalStore(textureProgress.subscribe, textureProgress.get)
  if (!requested || loaded >= requested) return null
  return (
    <div className="material-progress" role="status">
      <span style={{ width: `${Math.round((loaded / requested) * 100)}%` }} />
      Loading scanned materials · {Math.round((loaded / requested) * 100)}%
    </div>
  )
}
function InfoIcon() {
  return <ExternalLink size={10} />
}
