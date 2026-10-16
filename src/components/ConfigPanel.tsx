import {
  ArrowRight,
  Building2,
  Check,
  ChevronDown,
  Dumbbell,
  Flame,
  Footprints,
  Heart,
  Home,
  Layers3,
  Leaf,
  Moon,
  Plus,
  ScanLine,
  Sun,
  Sunrise,
  TreePine,
  Umbrella,
  Waves,
  Wind,
} from 'lucide-react'
import {
  ADDONS,
  CATALOG,
  ENVIRONMENTS,
  FINISHES,
  FLOORS,
  INTERIORS,
  PACKAGES,
  RAILINGS,
  SIGNATURES,
  addEquipment,
  addonAvailable,
  area,
  distance,
  layoutIssues,
  money,
  packageItems,
  setAddon,
  setFamily,
  productHeight,
  type Config,
  type PackageId,
  type SignatureId,
  type Unit,
} from '../lib/config'
import { QUALITY_DETAILS, type Quality } from '../render/quality'
import {
  PRODUCT_FAMILIES,
  CONTAINER_OPENINGS,
  OPENING_INFILLS,
  PORTFOLIO_NOTE,
  STUDIO_DOORS,
  STUDIO_LAYOUTS,
  PRODUCT_SOURCE_DATE,
  productFamily,
} from '../lib/products'
import { Elevation } from './Elevation'
import { TIME_PRESETS, exploreEnabled, timePreset } from '../render/angles'

const STEPS = ['Space', 'Exterior', 'Interior', 'Setting']

function Toggle({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string
  detail?: string
  checked: boolean
  onChange: () => void
}) {
  return (
    <button className="toggle-row" role="switch" aria-checked={checked} onClick={onChange}>
      <span>
        <strong>{label}</strong>
        {detail && <small>{detail}</small>}
      </span>
      <span className={`switch ${checked ? 'on' : ''}`} aria-hidden="true">
        <span />
      </span>
    </button>
  )
}
const packageIcons = {
  strength: Dumbbell,
  recovery: Waves,
  movement: Wind,
  cardio: Heart,
  empty: ScanLine,
}
const addonIcons = {
  deck: Layers3,
  gazebo: TreePine,
  roof: Sun,
  stairs: Footprints,
  canopy: Umbrella,
}
const environmentIcons = {
  residences: Building2,
  campus: Sunrise,
  backyard: Home,
  courtyard: TreePine,
  desert: Sun,
  studio: Layers3,
}
/** Surface previews for the interior finish cards. */
const interiorSwatch: Record<Config['interiorStyle'], string> = {
  gallery: 'linear-gradient(180deg, #f5f3ef 0 72%, #ffe9c8 72% 76%, #f1efea 76%)',
  slatted:
    'repeating-linear-gradient(90deg, #c49a6a 0 5px, #1b1c1b 5px 8px) top / 100% 30% no-repeat, #efebe4',
  timber: 'repeating-linear-gradient(180deg, #c98c57 0 7px, #9f6a3d 7px 8px)',
  birch: 'linear-gradient(90deg, #dcc199 0 49%, #8a7356 49% 51%, #d8bc93 51%)',
}

export default function ConfigPanel({
  config: c,
  onChange,
  step,
  setStep,
  unit,
  setUnit,
  quality,
  setQuality,
  trace,
  setTrace,
  traceSupported,
  notify,
  onPlan,
  onSignature,
}: {
  config: Config
  onChange: (c: Config) => void
  step: number
  setStep: (step: number) => void
  unit: Unit
  setUnit: (u: Unit) => void
  quality: Quality
  setQuality: (q: Quality) => void
  trace: boolean
  setTrace: (trace: boolean) => void
  /** Path tracing needs WebGPU compute. */
  traceSupported: boolean
  notify: (message: string) => void
  onPlan: () => void
  onSignature: (id: SignatureId) => void
}) {
  const product = productFamily(c.family)
  const container = c.family === 'container'
  /** Applies a change unless it would obstruct the planned entry. */
  const guarded = (next: Config, message: string) => {
    if (layoutIssues(next).length) {
      notify(message)
      return
    }
    onChange(next)
  }
  const applyPackage = (id: PackageId) => {
    const next = { ...c, package: id, items: packageItems(id, c.length) }
    if (layoutIssues(next).length) {
      notify(
        'This concept layout does not keep the selected entry clear. Choose another layout or arrange equipment individually.',
      )
      return
    }
    if (
      c.items.length > 0 &&
      !window.confirm(
        'Replace the current equipment layout with this package? Your previous layout will remain available through Undo.',
      )
    )
      return
    onChange(next)
    notify(
      `${PACKAGES.find((p) => p.id === id)!.name} layout applied. You can customize every item.`,
    )
  }
  const operable = container ? c.containerOpening === 'roll-up' || c.openingInfill !== 'none' : true
  const operableLabel = !container
    ? 'Show the door open'
    : c.containerOpening === 'roll-up'
      ? 'Show the roll-up door raised'
      : c.openingInfill === 'awning'
        ? 'Show the sashes propped open'
        : 'Show the glass door raised'
  return (
    <aside className="config-panel" aria-label="Gym configuration">
      <div className="panel-tabs" role="tablist" aria-label="Configuration steps">
        {STEPS.map((label, i) => (
          <button
            key={label}
            role="tab"
            id={`step-${i}`}
            aria-selected={step === i}
            aria-controls="step-content"
            tabIndex={step === i ? 0 : -1}
            onClick={() => setStep(i)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault()
                const next = (step + (e.key === 'ArrowRight' ? 1 : -1) + 4) % 4
                setStep(next)
                document.getElementById(`step-${next}`)?.focus()
              }
            }}
          >
            <span>0{i + 1}</span>
            {label}
          </button>
        ))}
      </div>
      <div
        className="panel-scroll"
        role="tabpanel"
        id="step-content"
        aria-labelledby={`step-${step}`}
        key={step}
      >
        {step === 0 && (
          <>
            <div className="panel-title">
              <span className="eyebrow">FURY CO GYMS / PORTABLE UNITS</span>
              <h2>
                Your space.
                <br />
                Your way to train.
              </h2>
              <p>
                Purpose-built for your practice.
                <br />
                Designed to feel entirely yours.
              </p>
            </div>
            <div className="section-label">
              Start from a Fury build <span>Portfolio</span>
            </div>
            <div className="signature-list" role="group" aria-label="Signature builds">
              {SIGNATURES.map((build) => (
                <button
                  key={build.id}
                  className="signature-card"
                  onClick={() => onSignature(build.id)}
                >
                  <Elevation config={build.config} className="signature-art" />
                  <span>
                    <strong>{build.name}</strong>
                    <small>{build.subtitle}</small>
                  </span>
                  <ArrowRight size={15} />
                </button>
              ))}
            </div>
            <p className="muted small">
              Recreated from Fury build photography as concept models. Each one stays fully editable
              and requires a quote.
            </p>
            <div className="section-label">Choose your product family</div>
            <div className="family-options" role="group" aria-label="Product family">
              {PRODUCT_FAMILIES.map((family) => (
                <button
                  key={family.id}
                  className={`family-card ${c.family === family.id ? 'selected' : ''}`}
                  aria-pressed={c.family === family.id}
                  onClick={() => {
                    const next = setFamily(c, family.id)
                    if (layoutIssues(next).length) {
                      notify(
                        'Rearrange equipment to keep the new entry clear before changing family.',
                      )
                      return
                    }
                    onChange(next)
                    if (c.family !== family.id)
                      notify(
                        `${family.name} selected. Family-specific openings, doors, and additions are reset. Undo restores the previous design.`,
                      )
                  }}
                >
                  <strong>{family.name}</strong>
                  <small>{family.description}</small>
                  <span>Family from {money(family.startingPrice)}</span>
                </button>
              ))}
            </div>
            <p className="muted small">
              Published family starting prices—not a price for this size or configuration. All
              selections require a quote.
            </p>
            <a className="source-link" href={product.source} target="_blank" rel="noreferrer">
              Official {product.shortName} specifications ↗
            </a>
            <div className="section-label">
              Choose your footprint <span>01 / 02</span>
            </div>
            <div className="size-options">
              {([20, 40] as const).map((length) => (
                <button
                  className={`size-card ${c.length === length ? 'selected' : ''}`}
                  key={length}
                  aria-pressed={c.length === length}
                  onClick={() => {
                    const updated = { ...c, length }
                    if (layoutIssues(updated).length) {
                      notify(
                        'Your equipment needs more room. Rearrange or remove items in the floor plan before choosing 20 feet.',
                      )
                      return
                    }
                    onChange(updated)
                  }}
                >
                  <div className="size-card-top">
                    <span>
                      {length}′ {product.shortName}
                    </span>
                    <span className="selection-dot">
                      {c.length === length && <Check size={11} />}
                    </span>
                  </div>
                  <Elevation
                    config={{ ...c, length, items: c.length === length ? c.items : [] }}
                    className="mini-studio"
                  />
                  <div className="size-card-bottom">
                    <strong>{distance(length, unit)} footprint</strong>
                    <small>
                      {area(length * 8, unit)} · {length === 20 ? 'Focused' : 'Expansive'}
                    </small>
                  </div>
                </button>
              ))}
            </div>
            <div className="spec-strip">
              <span>
                <b>{distance(8, unit)}</b>Width
              </span>
              <span>
                <b>{distance(c.length, unit)}</b>Length
              </span>
              <span>
                <b>{distance(productHeight(c), unit)}</b>Height
              </span>
            </div>
            <div className="included">
              <Check size={14} />
              <p>{product.features}</p>
            </div>
            {c.family === 'studio' && (
              <label className="field-label studio-layout">
                Configuration request
                <select
                  value={c.studioLayout}
                  onChange={(e) =>
                    onChange({ ...c, studioLayout: e.target.value as Config['studioLayout'] })
                  }
                >
                  {STUDIO_LAYOUTS.map((layout) => (
                    <option key={layout.id} value={layout.id}>
                      {layout.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {c.studioLayout !== 'single' && (
              <p className="inline-notice">
                Custom inquiry recorded. The scene shows one reference unit, not the connected or
                stacked project. Unit count, arrangement, engineering, and pricing require Fury
                review.
              </p>
            )}
            <p className="muted small">
              Sources checked {PRODUCT_SOURCE_DATE}. Nominal exterior sizes; usable space and
              technical specifications require confirmation.
            </p>
          </>
        )}
        {step === 1 && (
          <>
            <div className="panel-title">
              <span className="eyebrow">AN EXPRESSION OF YOU</span>
              <h2>
                Beautiful.
                <br />
                From the outside in.
              </h2>
              <p>
                {container
                  ? 'Published Container openings and portfolio glazing, with concept finishes.'
                  : 'Published Studio additions and portfolio doors, with concept finishes.'}
              </p>
            </div>
            {container ? (
              <>
                <div className="section-label">Access + openings</div>
                <div className="opening-options" role="group" aria-label="Container opening">
                  {CONTAINER_OPENINGS.map((opening) => (
                    <button
                      key={opening.id}
                      aria-pressed={c.containerOpening === opening.id}
                      className={`opening-card ${c.containerOpening === opening.id ? 'selected' : ''}`}
                      onClick={() =>
                        guarded(
                          {
                            ...c,
                            containerOpening: opening.id,
                            openingInfill: opening.id === 'roll-up' ? 'none' : c.openingInfill,
                          },
                          'Rearrange equipment to keep the selected opening’s entry clear.',
                        )
                      }
                    >
                      <strong>{opening.name}</strong>
                      <small>{opening.detail}</small>
                      <span>Quote required</span>
                    </button>
                  ))}
                </div>
                <p className="muted small">
                  Available on 20′ and 40′ builds. Open-side widths, positions, door height, and
                  structure are conceptual, not approved construction dimensions.
                </p>
                {c.containerOpening !== 'roll-up' && (
                  <>
                    <div className="section-label">
                      Fill the opening <span>Portfolio</span>
                    </div>
                    <div className="choice-list" role="group" aria-label="Opening infill">
                      {OPENING_INFILLS.map((infill) => (
                        <button
                          key={infill.id}
                          aria-pressed={c.openingInfill === infill.id}
                          className={`choice-card ${c.openingInfill === infill.id ? 'selected' : ''}`}
                          onClick={() => onChange({ ...c, openingInfill: infill.id })}
                        >
                          <span>
                            <strong>{infill.name}</strong>
                            <small>{infill.detail}</small>
                          </span>
                          <span className="check-square">
                            {c.openingInfill === infill.id && <Check size={13} />}
                          </span>
                        </button>
                      ))}
                    </div>
                    <p className="muted small">{PORTFOLIO_NOTE}</p>
                  </>
                )}
                <Toggle
                  label="Integrated exterior finish"
                  detail="Published design option. Material, detailing, and cost require a quote."
                  checked={c.integratedFinish}
                  onChange={() => onChange({ ...c, integratedFinish: !c.integratedFinish })}
                />
              </>
            ) : (
              <>
                <div className="section-label">
                  Glazed front <span>Portfolio</span>
                </div>
                <div className="choice-list" role="group" aria-label="Studio door">
                  {STUDIO_DOORS.map((door) => (
                    <button
                      key={door.id}
                      aria-pressed={c.studioDoor === door.id}
                      className={`choice-card ${c.studioDoor === door.id ? 'selected' : ''}`}
                      onClick={() =>
                        guarded(
                          { ...c, studioDoor: door.id },
                          'Rearrange equipment to keep the new door’s entry clear.',
                        )
                      }
                    >
                      <span>
                        <strong>{door.name}</strong>
                        <small>{door.detail}</small>
                      </span>
                      <span className="check-square">
                        {c.studioDoor === door.id && <Check size={13} />}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
            {operable && (
              <Toggle
                label={operableLabel}
                detail="Visualization only. Shows how the door or glazing operates."
                checked={c.doorsOpen}
                onChange={() => onChange({ ...c, doorsOpen: !c.doorsOpen })}
              />
            )}
            <div className="section-label">
              Concept color study <span>{FINISHES.find((f) => f.id === c.finish)!.name}</span>
            </div>
            <p className="muted small">
              Visualization palette only—not Fury’s approved finish names or availability.
            </p>
            <div className="finish-options">
              {FINISHES.map((f) => (
                <button
                  key={f.id}
                  className={c.finish === f.id ? 'selected' : ''}
                  aria-pressed={c.finish === f.id}
                  onClick={() => onChange({ ...c, finish: f.id })}
                >
                  <span className="finish-swatch" style={{ background: f.color }}>
                    {c.finish === f.id && (
                      <Check
                        size={18}
                        color={f.id === 'chalk' || f.id === 'cloud' ? '#252d23' : '#fff'}
                      />
                    )}
                  </span>
                  <strong>{f.name}</strong>
                  <small>Concept</small>
                </button>
              ))}
            </div>
            {!container && (
              <Toggle
                label="Concept timber accent"
                detail="Visual study only. Material and availability unconfirmed."
                checked={c.accent}
                onChange={() => onChange({ ...c, accent: !c.accent })}
              />
            )}
            <div className="section-label separated">
              {container ? 'Portfolio additions' : 'Published Studio additions'}{' '}
              <span>Quote required</span>
            </div>
            <div className="addon-list">
              {ADDONS.filter((addon) => addonAvailable(c.family, addon.id)).map((addon) => {
                const Icon = addonIcons[addon.id]
                return (
                  <button
                    key={addon.id}
                    className={`addon ${c.addons[addon.id] ? 'selected' : ''}`}
                    aria-pressed={c.addons[addon.id]}
                    onClick={() => {
                      const result = setAddon(c, addon.id)
                      onChange(result.config)
                      if (result.notice) notify(result.notice)
                    }}
                  >
                    <span className="addon-icon">
                      <Icon size={21} strokeWidth={1.3} />
                    </span>
                    <span className="addon-description">
                      <strong>{addon.name}</strong>
                      <small>{container ? addon.containerDetail : addon.detail}</small>
                      <b>Quote required</b>
                    </span>
                    <span className="check-square">
                      {c.addons[addon.id] ? <Check size={13} /> : <Plus size={13} />}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="muted small">
              Available individually or combined. All add-on geometry is conceptual; support,
              access, and compatibility need Fury’s approval.
            </p>
            {(c.addons.roof || c.addons.stairs) && (
              <div className="setting-row railing-row">
                <span>Guard rail</span>
                <div className="segmented" role="group" aria-label="Guard rail">
                  {RAILINGS.map((r) => (
                    <button
                      key={r.id}
                      className={c.railing === r.id ? 'active' : ''}
                      aria-pressed={c.railing === r.id}
                      onClick={() => onChange({ ...c, railing: r.id })}
                    >
                      {r.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {c.addons.roof && !c.addons.stairs && (
              <p className="inline-notice">
                Rooftop selected without stairs. An approved access solution is required before
                installation.
              </p>
            )}
          </>
        )}
        {step === 2 && (
          <>
            <div className="panel-title">
              <span className="eyebrow">BUILT AROUND YOUR RITUAL</span>
              <h2>
                Your best self.
                <br />
                Right at home.
              </h2>
              <p>Concept planning layouts—not Fury equipment packages.</p>
            </div>
            <div className="package-options">
              {PACKAGES.map((p) => {
                const Icon = packageIcons[p.icon]
                return (
                  <button
                    key={p.id}
                    className={c.package === p.id ? 'selected' : ''}
                    aria-pressed={c.package === p.id}
                    onClick={() => applyPackage(p.id)}
                  >
                    <Icon size={21} strokeWidth={1.4} />
                    <strong>{p.name}</strong>
                    <small>{p.subtitle}</small>
                    {c.package === p.id && <Check className="package-check" size={13} />}
                  </button>
                )
              })}
            </div>
            <button className="plan-button" onClick={onPlan}>
              <ScanLine size={19} />
              <span>
                <strong>Make it fit your life</strong>
                <small>Edit your floor plan · {c.items.length} items</small>
              </span>
              <ArrowRight size={17} />
            </button>
            <div className="section-label separated">
              Interior finish <span>Concept</span>
            </div>
            <div className="interior-options" role="group" aria-label="Interior finish">
              {INTERIORS.map((style) => (
                <button
                  key={style.id}
                  aria-pressed={c.interiorStyle === style.id}
                  className={c.interiorStyle === style.id ? 'selected' : ''}
                  onClick={() => onChange({ ...c, interiorStyle: style.id })}
                >
                  <span
                    className="interior-swatch"
                    style={{ background: interiorSwatch[style.id] }}
                  />
                  <strong>{style.name}</strong>
                  <small>{style.detail}</small>
                </button>
              ))}
            </div>
            <div className="section-label separated">Concept floor appearance</div>
            <p className="muted small">
              Fury lists performance flooring. These looks and materials are not confirmed
              purchasable options.
            </p>
            <div className="floor-options">
              {FLOORS.map((f) => (
                <button
                  key={f.id}
                  aria-pressed={c.flooring === f.id}
                  className={c.flooring === f.id ? 'selected' : ''}
                  onClick={() => onChange({ ...c, flooring: f.id })}
                >
                  <span style={{ background: f.color }} />
                  {f.name}
                  {c.flooring === f.id && <Check size={13} />}
                </button>
              ))}
            </div>
            <Toggle
              label="Concept mirror wall"
              detail="Visual study only. Availability requires confirmation."
              checked={c.mirror}
              onChange={() => onChange({ ...c, mirror: !c.mirror })}
            />
            <details className="catalog-details">
              <summary>
                Add individual equipment <ChevronDown size={16} />
              </summary>
              <p className="muted small">
                Generic planning models, not endorsed partner products. Dimensions and working
                clearances are illustrative. Equipment pricing requires a quote.
              </p>
              {(['Strength', 'Cardio', 'Movement', 'Recovery'] as const).map((category) => (
                <div className="catalog" key={category}>
                  <span className="catalog-category">{category}</span>
                  {CATALOG.filter((p) => p.category === category).map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        const next = addEquipment(c, p.id)
                        if (next) {
                          onChange(next)
                          notify(`${p.name} added. Drag it into place in the floor plan.`)
                        } else
                          notify(
                            'No collision-free position is available. Remove or rearrange equipment, or choose a larger footprint.',
                          )
                      }}
                    >
                      <span>
                        <strong>{p.name}</strong>
                        <small>
                          {distance(p.w, unit)} × {distance(p.d, unit)} · Quote required
                        </small>
                      </span>
                      <Plus size={16} />
                    </button>
                  ))}
                </div>
              ))}
            </details>
          </>
        )}
        {step === 3 && (
          <>
            <div className="panel-title">
              <span className="eyebrow">PICTURE THE EVERYDAY</span>
              <h2>
                A different
                <br />
                kind of escape.
              </h2>
              <p>Find your light. Set the scene.</p>
            </div>
            <div className="section-label">
              Surroundings <span>Concept settings</span>
            </div>
            <div className="environment-options">
              {ENVIRONMENTS.map((env) => {
                const Icon = environmentIcons[env.id]
                return (
                  <button
                    key={env.id}
                    className={`environment-card ${env.id} ${c.environment === env.id ? 'selected' : ''}`}
                    aria-pressed={c.environment === env.id}
                    onClick={() => onChange({ ...c, environment: env.id })}
                  >
                    <Icon size={22} strokeWidth={1} />
                    <span>{env.name}</span>
                    {c.environment === env.id && <Check size={14} />}
                  </button>
                )
              })}
            </div>
            <div className="section-label separated">
              Chase the light{' '}
              <span>
                {Math.floor(c.time)}:{String(Math.round((c.time % 1) * 60)).padStart(2, '0')}
              </span>
            </div>
            <div className="time-presets" role="group" aria-label="Time of day">
              {TIME_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={timePreset(c.time) === preset.id}
                  className={timePreset(c.time) === preset.id ? 'active' : ''}
                  onClick={() => onChange({ ...c, time: preset.time })}
                >
                  {preset.id === 'night' ? <Moon size={13} /> : <Sun size={13} />}
                  <span>{preset.label}</span>
                </button>
              ))}
            </div>
            {exploreEnabled() && (
              <>
                <input
                  className="time-slider"
                  type="range"
                  min="6"
                  max="21"
                  step="0.25"
                  value={c.time}
                  aria-label="Time of day"
                  onChange={(e) => onChange({ ...c, time: Number(e.target.value) })}
                />
                <div className="time-labels">
                  <span>
                    <Sun size={13} /> Morning
                  </span>
                  <span>
                    <Moon size={13} /> After dark
                  </span>
                </div>
              </>
            )}
            <Toggle
              label="Architectural lighting"
              detail="A warm welcome, any time of day."
              checked={c.lights}
              onChange={() => onChange({ ...c, lights: !c.lights })}
            />
            <p className="muted small">
              Lighting is artistic, not a location-based sun or shadow study.
            </p>
            <div className="section-label separated">Make yourself comfortable</div>
            <div className="setting-row">
              <span>Measurements</span>
              <div className="segmented">
                {(['ft', 'm'] as const).map((u) => (
                  <button
                    key={u}
                    className={unit === u ? 'active' : ''}
                    aria-pressed={unit === u}
                    onClick={() => setUnit(u)}
                  >
                    {u === 'ft' ? 'Imperial' : 'Metric'}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting-row">
              <span>Render quality</span>
              <div className="segmented">
                {(['ultra', 'high', 'lite'] as const).map((q) => (
                  <button
                    key={q}
                    className={quality === q ? 'active' : ''}
                    aria-pressed={quality === q}
                    onClick={() => setQuality(q)}
                  >
                    {q === 'ultra' ? 'Ultra' : q === 'high' ? 'High' : 'Lite'}
                  </button>
                ))}
              </div>
            </div>
            <p className="muted small quality-detail">{QUALITY_DETAILS[quality]}</p>
            <Toggle
              label="Path-traced stills"
              detail={
                traceSupported
                  ? 'When the view rests, it refines into a ray-traced image with true bounce light, soft shadows, and real reflections.'
                  : 'Needs a browser with WebGPU. Real-time rendering stays available.'
              }
              checked={trace && traceSupported}
              onChange={() => traceSupported && setTrace(!trace)}
            />
            <div className="nature-note">
              <Leaf size={22} />
              <p>
                Less commute.
                <br />
                <strong>More you.</strong>
              </p>
            </div>
            <details className="catalog-details">
              <summary>
                What this concept includes <ChevronDown size={16} />
              </summary>
              <p className="muted small">
                All models are procedural interpretations, not manufacturer CAD. Structural
                suitability, roof occupancy, stair design, equipment clearances, accessibility,
                permits, HVAC, and site services require professional review. No AR, zoning checks,
                or engineering certification is implied.
              </p>
            </details>
          </>
        )}
      </div>
      <div className="panel-next">
        <span>
          <Flame size={13} /> MAKE ROOM FOR MORE.
        </span>
        <button onClick={() => setStep((step + 1) % 4)}>
          {step === 3 ? 'Back to space' : STEPS[step + 1]}
          <ArrowRight size={16} />
        </button>
      </div>
    </aside>
  )
}
