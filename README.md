# FURY / Container Gyms + S-Series Studios

A laptop-first configurator built for [Fury Co Gyms](https://www.furycogyms.com/), designed around 12–16-inch displays (roughly 1280–1728 CSS pixels wide). Explore separate Container Gym and S-Series Studio families, start from five signature builds recreated from Fury's portfolio, choose published and portfolio options, arrange generic equipment in a collision-aware floor plan, and take away a shareable concept design and PDF inquiry brief. Mobile has a basic responsive fallback but is not the primary experience.

**This is a working concept configurator, not a live purchasing system.** Published family starting prices are source-backed, but every selected build requires a quote. Geometry is not manufacturer CAD; finish palettes, floor looks, equipment, and working clearances are generic visual studies. No customer details, payments, or sales emails are sent anywhere. The official inquiry link opens Fury's website without transferring this configuration.

## Official product sources

Reviewed **October 14, 2026**. `src/lib/products.ts` contains the source URLs, nominal heights, features, starting prices, and published option names. These are a dated snapshot, not a live pricing feed.

| Family                                                            | Nominal exterior sizes                     | Published family starting price | Published choices                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [Container Gyms](https://www.furycogyms.com/gym-design/container) | 20′ or 40′ L × 8′ W × 9′6″ H; 160 / 320 SF | $20,000 USD                     | 10′ roll-up door; center, partial, full open-side; integrated exterior finish                                     |
| [S-Series Studios](https://www.furycogyms.com/gym-design/studio)  | 20′ or 40′ L × 8′ W × 10′ H; 160 / 320 SF  | $35,000 USD                     | Front deck, gazebo, rooftop deck, exterior stairs; connected, double-wide, multi-level, stacked, custom inquiries |

Fury does **not** publish separate 20′/40′ prices or a full option price list on these pages. Starting prices therefore never scale by length or become configured totals. `estimate()` returns `total: null` and `amount: null` for unpriced selections—not zero. There is no financing calculator based on an invented principal. The [project inquiry page](https://www.furycogyms.com/start-a-project) separately says smaller entry-level projects typically start at $25,000; this is different project guidance, not an extra fee added to the Container starting price.

### Portfolio reference designs

Five client-supplied photographs of built Fury units (reviewed **October 14, 2026**) define the portfolio options and the signature builds that reproduce them:

| Signature build     | Photographed build                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| Courtyard pod       | Light S-Series pod, five black-framed bays, hinged door, functional trainer and air bike, apartments |
| Campus pod          | Dark S-Series pod, sliding door, oak floor, trainer, dumbbells, plyo box, med balls, office campus   |
| Clubhouse container | Bronze container, full-view glass overhead door, lit canopy, cedar interior, half racks, at dusk     |
| Garden Pilates      | Charcoal container, top-hung glass sashes propped open, timber deck, birch interior, reformer        |
| Rooftop container   | Black container, raised glass door, timber-clad roof deck, cable rail, black steel stair, power rack |

Options taken from these photographs (Studio hinged/sliding doors, Container glass overhead doors and awning sashes, Container decks, roof decks, stairs and entry canopy, cable railing) are labeled **“Seen in Fury builds”** or **Portfolio** in the app. They are concept interpretations of the photographs, not published specifications: none has a published price, all are quote-only, and geometry is illustrative.

Connected and stacked Studio requests are saved in the design and brief, but the scene and floor plan show **one reference unit**, not an engineered assembly. The website does not specify unit counts, connection geometry, loads, or permitted arrangements. Other door widths and colors are also inquiry-only. Performance flooring is published; the app's oak/stone looks, timber accent, named colors, mirror wall, and equipment presets are not an approved Fury catalog.

## Run locally

Requirements: **Node.js 24 LTS** and npm. The runtime version is declared in `.nvmrc`; dependencies are locked in `package-lock.json`.

```sh
nvm install
nvm use
npm ci
npm run dev
```

Open the URL printed by Vite. If you do not use nvm, install Node 24 and run the npm commands directly. No environment variables, API keys, database, or third-party accounts are required. Fonts, models, textures, and scripts are bundled or generated locally; there are no remote model, texture, or font requests at runtime. The one optional service is the cloud renderer: set `VITE_CLOUD_RENDER_URL` to its address and resting views are rendered on a cloud GPU (see [Cloud rendering](#cloud-rendering) and `render-server/README.md`).

Optional URL parameters help when comparing devices or debugging: `?renderer=webgl` forces the WebGL 2 backend, `?quality=ultra|high|lite` fixes the render tier (and disables the automatic step-down), `?trace=1|0` turns path-traced stills on or off, `?cloud=0` keeps tracing on this device even when a cloud renderer is configured, `?cloud=http://127.0.0.1:8787` uses a local render server, `?spin=0` shows resting views traced one at a time instead of the cloud's path-traced spin, `?denoise=0` shows the raw path-traced accumulation, `?traceStats=1` logs a timeline of the first seconds (`[fury] t=<ms> …` lines in the console, and `window.__furyTimeline` as JSON: scene load, textures, the cloud GPU's cold start, metering, the first traced frame, the loading screen lifting), and `?debug=ao`, `?debug=normal`, `?debug=contact`, or `?debug=reflections` shows the ambient-occlusion, normal, contact-shadow, or screen-space reflection buffer on High and Ultra.

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run preview
```

`npm run format` applies Prettier. CI runs formatting, ESLint, TypeScript, Vitest, and the production build. There are no custom pre-commit hooks. Production output is `dist/`, suitable for Vercel, Netlify, Cloudflare Pages, or another static host. Configure `npm run build` as the build command and `dist` as the output directory; serve the app over HTTPS for clipboard sharing and WebGPU (browsers only expose WebGPU to secure contexts). Do not expose Vite's development server as the public production service.

The project deploys on Vercel. `vercel.json` caches Vite's content-hashed `/assets/*` for a year and the bundled `/textures/*` for a day with background revalidation, since texture filenames are not hashed. If you regenerate a texture set, returning visitors may see the previous version for up to a day.

## What works

| Area          | Implemented                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Products      | Two families, 20-/40-foot footprints, family-specific nominal heights and source-linked features; five signature builds with matching camera angles                     |
| Exterior      | Studio hinged or sliding door; Container openings with open side, glass overhead door, or awning sashes, each shown open or closed; integrated finish; seven colors     |
| Additions     | Studio front deck and gazebo; Container grade deck and entry canopy with downlights; roof deck with glass or cable rail and exterior stair for both families            |
| Visualization | WebGPU renderer with WebGL 2 fallback, photo-scanned materials, physical sky and sun by time of day, exterior orbit, interior look-around, six settings, lights         |
| Rendering     | Ultra (screen-space GI), High (GTAO, bloom, temporal AA), Lite (MSAA); interior radiance probe, planar mirror, area-light washes, automatic quality step-down           |
| Interior      | Gallery, oak-slat, cedar, and birch-ply finishes; four floors; strength, recovery, movement, cardio, and empty presets; sixteen generic equipment items                 |
| Floor plan    | Pointer dragging, quarter-foot snapping, rotation, removal, entry and boundary protection, collision rejection, visible working-space envelopes                         |
| Decisions     | Published family starting prices, unpriced quote checklist, custom Studio inquiry request, 50-step undo/redo, signature portfolio builds                                |
| Persistence   | Automatic local draft, up to 12 named local builds, two-build comparison, versioned compressed share URLs                                                               |
| Deliverables  | Configuration JSON, current-view PNG, multipage PDF with scene image when available, floor plan, sourced starting price, quote checklist, notes, and share link         |
| Access        | Responsive controls, touch interaction, keyboard camera and floor-plan controls, labeled options, focus-trapped dialogs, reduced-motion camera transitions, 2D fallback |

### Controls

- **Exterior:** drag to orbit, pinch or scroll to zoom. Focus the scene for arrow keys and `+`/`−`. With a cloud renderer the view steps through a path-traced spin, 72 angles around the building at three distances (see [Cloud rendering](#cloud-rendering)): each left or right arrow press moves one 5° step, and up/`−` or down/`+` moves out or in a distance.
- **Interior:** drag or use arrows to look around from a fixed point inside the studio. This is not a collision-enabled walk-through.
- **Floor plan:** drag an item; arrows move it 3 inches, Shift+arrows move it 1 foot, `R` rotates, Delete/Backspace removes. Invalid moves are rejected with an explanation. Rotation is 0° or 90°.
- **History:** Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z redoes. Changing size preserves selections, and downsizing is blocked if current equipment would no longer fit.
- **Photo mode:** expands the scene and downloads a rasterized PNG at the current canvas resolution. It is not 4K path tracing.

## Configuration architecture

One validated, versioned `Config` object drives the scene, layout, quote checklist, share payload, and PDF. `src/lib/config.ts` owns the Zod schema, planning equipment, presets, validation rules, unit conversions, and quote semantics. `src/lib/products.ts` owns the sourced product facts. Never add prices separately in a component or PDF.

```text
src/
  App.tsx                     Workspace, dialogs, camera modes, history shortcuts, quality governor
  components/
    ConfigPanel.tsx           Four-step selection interface and signature builds
    Elevation.tsx             Front-elevation drawing of any configuration (cards, dialogs)
    Scene.tsx                 Async WebGPU canvas, camera, dimensions, graphics fallback
    RenderEffects.tsx         Drives the TSL pipeline, settle frames, captures, frame-time governor
    Atmosphere.tsx            Physical sky, fog, image-based lighting, sun and moon, exposure
    InteriorProbe.tsx         Radiance probe captured inside the room for interior surfaces
    InteriorLights.tsx        Downlights, cove and toe-kick area lights, fixtures
    StudioModel.tsx           Shell, interior, glazing, add-ons, signature, mirror, equipment
    Equipment.tsx             Batched equipment models shared by every placed copy
    Landscape.tsx             Anti-tiled ground, hardscape, trees, hedge, grasses, desert plants
    Surroundings.tsx          Residential courtyard, corporate campus, and backyard settings
    Mirror.tsx                Planar reflector (High/Ultra) or probe-lit metal (Lite)
    Parts.tsx                 Renders a part list as merged, per-material meshes
    FloorPlan.tsx             Accessible SVG floor-plan editor
    Dialogs.tsx               Saved comparisons, quote checklist, sharing, brief form
    Modal.tsx                 Native dialog lifecycle
  render/
    renderer.ts               WebGPURenderer creation, area-light tables, texture-view shim
    pipeline.ts               TSL render pipelines per quality tier, traced-image presentation
    pathtrace.ts              Path-traced stills: scene capture, sun disc, sky map, denoising
    history.ts                Sample reuse between views: G-buffer, reprojection kernel
    cloud.ts                  Cloud renderer client: scene capture, blob uploads, frames
    spin.ts                   Path-traced spin and interior panorama from the cloud renderer
    adaptive.ts               Adaptive sampling: retire regions whose denoised image has settled
    motion.ts                 Camera rest: on-screen motion, ending an orbit's glide
    traceStatus.ts            Path-tracing progress store for the status line (no three.js)
    framing.ts                Camera framing for the exterior and interior views
    quality.ts                Tiers, backend selection, defaults (no three.js imports)
    materials.ts              Material library over the scanned texture sets
    palette.ts                Named physically based materials (powder coat, vinyl, glass...)
    geometry.ts               Geometry helpers with UVs in feet, corrugation, tubes, lathes
    parts.ts                  Part lists and static batching
    architecture.ts           Studio and Container shells, interior finishes, glazing
    openings.ts               Studio doors, glass overhead door, awning sashes, roll-up shutter
    addons.ts                 Decks, pergola, roof deck, railings, stairs, canopy, timber accent
    buildings.ts              Apartment blocks, offices, modern house, site furniture
    scenery.ts                Landscape density tiers and plant/rock geometry
    equipment.ts              Sixteen equipment models at real-world dimensions
    vegetation.ts             Leaf atlas, trees, grass, fan palms, flowering shrubs
    progress.ts               Material streaming progress (no three.js imports)
    useResource.ts            StrictMode-safe GPU resource lifetime
  lib/
    config.ts                 Domain model, rules, estimates, URLs, persistence
    products.ts               Official product facts, sources, and published choices
    useConfig.ts              Reducer-backed history and automatic draft
    export.ts                 On-demand PDF generation and downloads
    visuals.ts                Sun path, Preetham sky model, sunlight color, horizon fog
scripts/
  build-textures.py           Fetches CC0 scans and bakes procedural detail maps
public/textures/              Bundled texture sets and sources.json (authors, sizes, roles)
```

Dimensions use **feet internally**, with x along unit length and z along depth; the front is positive z. Both families are 20/40 × 8 feet, with heights from the product table above. The floor plan uses a conservative concept usable envelope and reserves a planned entry aligned to the chosen opening or Studio door. The Studio glazing is divided into equal bays (five on 20 feet, eleven on 40); the hinged door takes the second bay from the end and the sliding door the center bay. Only the roll-up width is published; other opening widths/positions and all deck/gazebo/stair geometry are illustrative. Collision checks cover equipment footprints and a small placement buffer, **not manufacturer safety clearances, electrical requirements, accessibility, structural loading, or permitted occupancy**. Dashed envelopes are illustrative guidance and can overlap.

Rules:

- Additions can be selected individually or together. Decks, roof decks, and stairs apply to both families (the Container versions come from the portfolio photographs); the gazebo and timber accent are Studio-only; the entry canopy is Container-only. All combinations still require support/access/engineering review; the model is not certification.
- Opening infills (glass overhead door, awning sashes) apply to the center, partial, and full open-side openings; the roll-up opening carries its own door. “Show open” is a visualization state saved with the design.
- Switching to Containers clears Studio-only additions, timber accents, doors, and custom Studio requests while preserving decks, roof decks, stairs, shared finishes, length, and equipment. Switching to Studios clears Container openings, infills, and the canopy, and prefers the hinged door unless it would obstruct the current layout, in which case the centered sliding door is used. Undo restores the previous state. A change that obstructs the new planned entry is blocked until equipment is rearranged.
- Signature builds replace the whole design, including family and length, after confirmation; every option stays editable.
- Invalid, unsupported, oversized, duplicate-ID, or geometrically invalid shared configurations are rejected.
- Schema `v: 3` adds `studioDoor`, `openingInfill`, `doorsOpen`, `railing`, `interiorStyle`, and `addons.canopy` to v2's `family`, `containerOpening`, `integratedFinish`, and `studioLayout`. Legacy `v: 1` and `v: 2` links/drafts/saved builds migrate automatically and are fully revalidated: Studios get the centered sliding door (so their planned entry, and every saved layout, is unchanged) and the original oak-slat interior; Containers keep their opening shown open, as v2 rendered it. Existing selections are preserved; old conceptual prices are not. Unsupported versions are rejected. This is the implemented app contract, not a roadmap example.

### Local data and sharing

The URL fragment `#c=…` contains the entire LZ-string-compressed configuration. It updates with edits and is not sent in HTTP requests to the static host. Anyone with the full link can read the configuration. There is no short-link service, authentication, cross-device account, or automatic social-preview image. A link needs a running deployment of this app; localhost and session-preview links are not permanent public links.

`fury-draft-v1` and `fury-builds-v1` remain the only localStorage keys to preserve existing drafts and saved builds; their payloads migrate to schema v2. A valid URL configuration takes precedence over the draft. Storage failure does not prevent configuration or file export; named-save failures show a message. Clearing browser storage removes local drafts and saved builds, so export important designs.

PDF generation loads jsPDF only when needed. Scene capture is omitted in floor-plan mode or when graphics are unavailable; the floor-plan drawing and other brief sections still export. Core PDF fonts target Latin-script text. No analytics or session replay is installed.

### Rendering and performance

The scene renders with three.js r186's `WebGPURenderer`. It runs natively on WebGPU and falls back to its WebGL 2 backend automatically, so every material and post effect is written once in TSL (three's shading language) and works on both. React Three Fiber creates the renderer asynchronously. The renderer badge in the scene status line shows the active backend and tier.

| Tier  | Pipeline                                                                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ultra | High plus screen-space global illumination (one diffuse bounce of on-screen light) and screen-space reflections on metals and coated facade glass                    |
| High  | Depth/normal/velocity pre-pass, GTAO applied only to ambient light, sun contact shadows, emissive bloom, temporal reprojection anti-aliasing, 4096-pixel sun shadows |
| Lite  | One 4× MSAA pass, 2048-pixel sun shadows, probe-lit mirror                                                                                                           |

Laptop-width screens start on Ultra, tablets on High, and phones on Lite. If back-to-back frames stay slow, the app steps down one tier and says so, unless a tier was chosen explicitly. Rendering is on demand: after any change it keeps drawing for a short settle window (about 28–40 frames) so temporal anti-aliasing, AO, and GI converge into a clean still, then stops.

#### Path-traced stills

With WebGPU, a view that holds still refines into a path-traced image: true multi-bounce light, soft sun and area-light shadows, glass and mirror reflections, and light through the glazing into the room. Orbiting, walking the interior, and every edit stay real-time; the moment the camera or design changes, the rasterizer takes the frame back. `src/render/pathtrace.ts` drives [`three-gpu-pathtracer`](https://github.com/gkjohnson/three-gpu-pathtracer)'s WebGPU tracer on the app's own renderer, so the scene and textures are shared rather than duplicated.

- **Starting promptly:** tracing starts about 150 ms after the view has held still for six frames, without waiting for the raster settle window, since the traced image replaces it. An orbit's damped glide used to keep the camera moving by fractions of a pixel for hundreds of frames (10–20 s) after a drag, and nothing could start until it ended. Once the glide is below 0.6 px a frame it now decays faster, and below 0.05 px it is stopped, a final step of under 0.2 px (`src/render/motion.ts`).
- **Moving the camera keeps the work done:** a new view does not start from zero samples. When tracing stops, the view's accumulation, per-pixel sample counts, and rasterized positions and normals are kept; the next view of the same scene is seeded from them by a compute pass that reprojects each pixel to the same surface point in the old view (`src/render/history.ts`). A pixel inherits old samples only where that point was visible (positions within about a pixel's footprint, normals agreeing), and only as far as its look does not depend on the viewpoint: none for glass, mirrors, metals, clear coats, and anything below roughness 0.2; most for rough dielectrics, tapering as the viewing angle turns, when zooming in magnifies the old image, and across shadow edges. What carries over is the light arriving at the surface (color divided by albedo), multiplied back by the new view's own rasterized albedo, so texture detail stays sharp instead of being resampled. Every pixel still takes at least a quarter of its 1024 samples fresh, so edges and anything the estimate got wrong converge to the true image. The tracer skips pixels that already hold enough samples, so its time goes first to what the old view did not show. A seeded view is denoised at 2 samples, so after a small orbit the converged image is back almost at once instead of after a full re-render.
- **Finishing where the image has settled:** a view no longer gives every pixel the same 1024 samples. Each time a new denoised image arrives (the milestones double the sample count), it is compared with the previous one in 16-pixel tiles; a tile whose image changed by less than 1% on average and nowhere by more than 15%, at two doublings in a row, has settled, and pixels whose tile and neighbouring tiles have settled stop taking samples (`src/render/adaptive.ts`). Open sky, walls, and lawns finish after a few dozen samples while glass, deep shadow, and foliage keep refining up to 1024. When a tracer slot draws a finished pixel it now looks a few queue entries further for one that still needs samples, instead of idling for the round (a small patch to `three-gpu-pathtracer`, applied by `patch-package` on install; see `patches/`).
- **Edits update the traced scene in place:** a fingerprint per kind of change decides what to rebuild. Meshes appearing, disappearing, or changing shape capture the scene again (BVH and kernels); moved objects refit the BVH, new finishes rewrite the material buffers, and light or time-of-day changes update lights and sky, all without recompiling the tracer's GPU kernels.
- **Capture:** the tracer reads plain PBR properties, so the scene is swapped into a traceable form only for the instant of capture: the raster sky dome and sun are hidden, TSL-only materials expose stand-ins through `material.userData.pathTrace` (foliage and blossom atlases, grass, palms, the scanned ground, the planar mirror as polished metal), unlit helpers hide, and volumetric glass becomes thin-walled glass tinted by its absorption. Captures are cached by a fingerprint of geometry, transforms, materials, and lights; a camera-only change re-traces without rebuilding.
- **Sun and sky:** the sun is a disc light at its true 0.53° angular size carrying the same irradiance as the raster sun, so shadows soften with distance and glossy surfaces show real glints. The sky is a 1024×512 HDR map computed on the CPU from a line-for-line port of three's `SkyMesh` (Preetham scattering and its cloud layer), so the traced sky matches the real-time one. Calibration lives in `src/lib/visuals.ts` and is shared by both renderers.
- **Denoising:** at 8, 16, 32, 64, 128, 256, 512, and 1024 samples per pixel (from 2 on a seeded view) the accumulation is denoised with [Open Image Denoise](https://www.openimagedenoise.org/) on the GPU (`oidn-web`, guided by rasterized albedo and normals) and crossfaded in, so the image develops from the raster frame into a clean photograph without showing path-tracing noise. The 1.8 MB weights (`public/denoise/`, Apache-2.0) download only when tracing starts.
- **Exposure:** before the first traced image fades in, both it and the frozen raster frame are metered (log-average luminance over a coarse grid, like a camera's matrix meter) and the traced image is scaled to match, within one stop darker to two stops brighter. The handover keeps the brightness the viewer was looking at, while the light distribution (sky occlusion in a courtyard, bounce light in a room) is the traced one.
- **Exports:** photo mode and the PDF brief wait for a denoised image of at least 384 samples, or one whose every region has settled (up to 45 seconds), then save it. Without WebGPU they capture the real-time view as before.

The status line shows progress. The **Path-traced stills** switch under Surroundings turns it off; it starts on for Ultra and High and off for Lite (on for every tier when a cloud renderer is configured). `?trace=1` or `?trace=0` overrides that, `?denoise=0` shows the raw accumulation for comparison, and `?traceStats=1` logs to the browser console, for each resting view, when its first traced image appeared and when it settled. Tracing runs only while the view rests and stops once every region has settled (or at 1024 samples), but it does keep a GPU busy for that time; how quickly depends on the GPU and has not been benchmarked on physical hardware.

#### Cloud rendering

A laptop GPU cannot reach 1024 samples per pixel at full resolution in seconds, so views can instead be rendered on cloud GPUs: Blender Cycles with hardware ray tracing (OptiX) and Open Image Denoise on the GPU (falling back to the CPU if GPU denoising fails), on Modal's L40S GPUs: each visitor's render session gets one of its own. It is optional and off unless `VITE_CLOUD_RENDER_URL` is set at build time; `render-server/README.md` covers deploying it. The browser side is `src/render/spin.ts` and `src/render/cloud.ts` (with `?spin=0`, `src/render/orbit.ts` and `src/render/session.ts`).

- **Path-traced spin:** once the cloud has rendered a view, the real-time image is not shown. The exterior camera steps through a ring of path-traced frames, 72 angles (every 5°) at three distances (closer and lower, the framed view, and farther and higher), like a 360° product spin: dragging moves through the frames and lands on the nearest one. The interior is a 360° panorama from the interior's eye, so looking around inside stays path traced at every angle (`src/render/spin.ts`, shown by `createSpinPresent` in `src/render/pipeline.ts`).
- **Loading screen:** on opening, a loading screen covers the scene until the visitor's view is at full quality and the four angles on each side of it are ready at least as 64-sample previews, so turning a few steps either way shows a path-traced frame at once ("Path tracing your gym · 5 of 9 angles ready"). On one L40S that is about 30 s once the GPU is up (estimated from the measured 14 s per full frame and 1.5 s per preview); the screen gives up after a minute and a half, as the visitor's own GPU may be starting cold. The frames wait for the scanned textures to arrive, so a design is rendered once, complete. Later, a view's first visit (the interior, usually ready by then) shows the loading screen only if no frame of it is ready yet.
- **Order of work:** the visitor's frame (preview, then full quality), the four angles either side as previews, the panorama's preview, those angles at full quality, the rest of the ring as previews and then at full quality, nearest first, then the other two distances the same way, then the full panorama; from inside, the panorama goes first. The plan follows the visitor: wherever they turn to is asked for at once, on a channel of its own, so the server drops frames still queued for angles they have turned past, and the angles around the new one come next. Three other requests are kept open, enough to keep one GPU busy and few enough that the queue never runs far ahead. An angle not rendered yet shows the nearest one that is until it arrives, and every frame is rendered at the screen's full resolution (up to 3200 pixels across). A design change keeps the previous frame on screen ("Path tracing your changes") until the new design's arrives, then crossfades; dropping a frame request is free, as the server drops queued frames of a superseded design. Rendering pauses while the tab is hidden, and a busy server is asked again two seconds later.
- **Finished on the server:** spin frames come tone mapped from the server (exposure, the browser's bloom, AgX, sRGB and dither, in `render-server/fury_render/finishing.py`) as WebP, about 0.2 MB at 1200×827 instead of 4 MB of half floats; the browser adds only the vignette. The server keeps every finished frame on its volume, named by the SHA-256 of everything that determines it, so a design anyone has viewed before comes back from the cache without a render.
- **Exposure:** the traced image is matched to the real-time image's brightness once per lighting look and view, then held, like a camera on manual exposure, so a finish change never shifts the brightness. For the exterior and for the interior, the browser renders its real-time frame at that view's camera (the interior's while the visitor is still outside: only the camera and exposure differ between views), the server renders a 16-sample frame of the same view at the same size, and the gain is the ratio of their mean log luminance.
- **What is sent:** the same path-traced form of the scene the local tracer captures (the same `preparePathTraceScene` swap): meshes, physically based materials with their textures and UV transforms, spot, point, and area lights, the sun disc, and the sky map. Geometry, instance matrices, the sky, and texture files travel as blobs named by the SHA-256 of their content, which the server keeps. A request carries only the JSON description and the camera; when the server lacks a blob it answers 409 with the hashes and the browser uploads just those. Texture bytes are uploaded by the browser too; the server never fetches user-supplied URLs. A new camera angle or a finish change therefore sends a few hundred kilobytes, and the server re-syncs only what changed (Cycles persistent data).
- **Matching the local tracer:** light and emission units were calibrated against `three-gpu-pathtracer` in Cycles (emission and sky radiance carry over as is; sun strength is irradiance; spot and point lights, 4π W per W/sr; area lights, π·area W per unit radiance), spot cones fade over the same angles, glass is thin-walled and reflects by Fresnel alike from either side, and one-sided surfaces are invisible from behind except to shadow rays, as in the browser's tracer. With `?spin=0` the image comes back as linear half floats (losslessly packed, decoded in about 50 ms for 1920×1200), so it gets the same exposure match, bloom, vignette, and tone mapping as a local trace.

With `?spin=0`, resting views are rendered one at a time instead:

- **Handover:** when the cloud GPU answered in the last four minutes it is probably still on, so it gets six seconds before this device starts tracing too. Otherwise (a cold start takes an estimated 15–40 s), the local tracer starts at once where WebGPU is available, and the cloud image crossfades over whatever it reached; the local samples are kept for the next view. If the server fails or is busy, tracing simply continues locally. Lite devices, and browsers without WebGPU, leave tracing to the cloud and show the real-time view until the image arrives.
- **Preview first:** each new view is also rendered with 64 samples, which takes about 1.5 s on an L40S at 1200×827 instead of about 14 s. The denoised preview appears within about 2 s, and the full image crossfades over it. The renderer's queue puts previews first, then the visitor's views, then pre-renders.
- **Orbit views ahead of time:** in the exterior view the camera rests only on a grid of orbit poses: 48 directions around the building (every 7.5°), elevation steps of 5°, and zoom steps of 6%. When a drag or zoom comes to rest, the camera eases onto the nearest pose in about a quarter of a second, a correction of at most a few degrees. Once the resting view is on screen, the GPU renders the other 47 directions at the same elevation and zoom in the background, nearest first, at full resolution. Orbiting then lands on finished images, which appear without a new render or any local tracing; the status reads "Path traced · 12/48 angles ready" while the ring fills. The views are kept compressed in memory (about 3–5 MB each at 1920×1200, up to 320 MB). Pre-rendering yields to the view the visitor is looking at, stops when the design changes, and pauses while the tab is hidden or after three minutes without input. A new elevation or zoom starts a new ring around that view. Interior views, and orbits while auto-rotating, are rendered one at a time as before.

Cost and abuse limits: each visitor's render session has a container with one L40S of its own, switched off after a minute without requests, so cost follows use: about $1.95 an hour of GPU time for each visitor while they are rendering, plus CPU and memory. At most three sessions run at once (`FURY_MAX_SESSIONS`); a visitor beyond that traces on their own device. A single L40S schedules in seconds; eight in one container (`FURY_GPU=L40S:8`) never started in testing, as Modal held it "scheduling" for over ten minutes. A design's full spin is 433 renders (216 previews, 216 full frames, and the panorama twice). On one L40S a full 1200×827 frame took about 14 s and a preview 1.5 s (measured), so a full spin is roughly an hour of GPU time, about $2 per new design when a visitor stays until every frame is done (estimates; not yet measured on the deployed container). Views stop at 15 s and the panorama at 60 s of sampling, a session's queued frames are dropped when it moves on to a newer design or view, and frames anyone has seen before come from the cache. Configure and verify Modal workspace spending controls before ongoing use. A CPU-only gateway validates and rate-limits requests before invoking the private GPUs, and browser access is restricted to explicitly configured origins. There is no PIN, so the in-process rate limits and the Modal spending limit are the cost controls; they are not a guaranteed dollar cap.

`?traceStats=1` also logs each cloud render's total time, queue wait, scene sync, and render time, and for the spin each frame's time and the metered exposure. Earlier CPU tests took about 20 seconds for a 930×627 view, with a camera-only re-render syncing in 3 ms. A deployed 640×480/128-sample test scene passed through the authenticated gateway to a private L40S/OptiX worker: 660 ms rendering, 1.85 s HTTP round trip after blob uploads. This is not a full-gym or cold-start benchmark.

Lighting:

- **Sun shadows:** the sun's shadow map covers at least 128 × 128 ft around the unit and gathers casters up to about 400 ft toward the sun, so surrounding buildings, trees, and palms shade the site at low sun, as they do in the path-traced image.
- **Sky and sun:** a Preetham daylight sky with clouds is both the visible background and the image-based lighting (captured into a PMREM cube). Sun color comes from atmospheric extinction along the sun path. A multiple-scattering fill keeps the zenith-to-horizon ratio near measured clear skies. Fog matches the horizon. After dark, exposure adapts, moonlight takes over, and airglow keeps the sky deep blue. The sun follows an artistic summer path (sunrise 06:00, sunset 20:30, 60° at noon), not a location-based study.
- **Contact shadows (High, Ultra):** a short screen-space march toward the sun adds the fine shadows a site-wide shadow map cannot resolve: equipment feet on the floor, bench legs on paving, the pod's skirt where it meets the ground. They darken only the sun's light, so lamps and sky light are unaffected.
- **Reflections:** a second radiance probe is captured just in front of the unit with the unit itself hidden. Glazing and the glossy exterior finish reflect it, so they show the actual buildings, trees, and paving around them instead of only the open sky, on every tier. On Ultra, screen-space reflections add what is on screen to chrome, brushed steel, and the coated glass of neighboring office facades. Both probes leave the sky's sun disc out of their captures, since the sun light already lights every surface and the disc would only add fireflies.
- **Interior:** a radiance probe captured from the middle of the room lights and reflects interior surfaces with the room itself (daylight through the glazing, luminaires, finishes) rather than the open sky. It is captured twice per change to approximate a second bounce. Downlights are spot lights; the back-wall cove and toe-kick are rectangular area lights. The interior view meters about +2/3 stop brighter, as a photographer would.
- **Mirror:** High and Ultra render a true planar reflection; Lite uses a probe-lit polished surface.
- **Interior finishes:** gallery and birch interiors use two continuous linear LED channels (area lights on High and Ultra, spot lights on Lite); slatted and cedar interiors use recessed downlights. The Container canopy carries real downlights that wash the ground at night.
- **Settings:** background apartment, office, and house windows are reflective, non-transmissive glazing; a share of them light from inside through dusk. Their glow is a live material property, so the time slider never rebuilds the background geometry.

Materials come from 24 CC0 photo-scanned PBR sets from [Poly Haven](https://polyhaven.com/) (albedo, OpenGL normal, and packed AO/roughness/metalness), plus baked powder-coat, brushed-steel, and knurl detail maps. `public/textures/sources.json` records each set's authors, physical size, and role; `scripts/build-textures.py` (Python 3, Pillow, NumPy) reproduces them. Every model carries UVs measured in feet, so each texture appears at its true physical scale. The ground blends two scales of its scan with noise so it never visibly repeats. Textures stream in after the scene appears, with a progress indicator. Surfaces seen up close and at scale (interior linings and walls, decking, pavers, brick, stucco, concrete, the roll-up door, and the floors) use 2K scans; small-object fabrics, rubber, gravel, bark, and distant ground use 1K. The library is about 40 MB of WebP; only the sets a view needs are downloaded.

Models are procedural and batched: each equipment item or architectural assembly is merged per material into a few draw calls and shared by every placed copy. Trees, shrubs, and blossoms use alpha-tested cards with crown-bent normals and daylight-scaled translucency; fan-palm fronds, grass, and foliage are instanced. Footprint tests keep every equipment model inside the planning envelope the floor-plan collision rules use; a racked Olympic bar on the power rack and half rack is the one deliberate exception, overhanging its uprights into the rack's side clearance as on real racks.

These remain procedural concept models, not manufacturer-verified CAD or photographic scans of Fury products. Equipment is generic. Real-time glass and water use physically based transmission, and screen-space GI only bounces light that is on screen; the path tracer resolves both properly but does not render caustics through thin glass or participating media. Lights do not simulate certified photometry.

The three.js chunk (WebGPU and the classic renderer React Three Fiber references) is about 2.2 MB minified, 630 kB gzipped, and loads only with the scene; the app shell stays about 160 kB. No 60 fps or low-end mobile performance claim has been validated on physical hardware; the automatic step-down is a safeguard, not a benchmark.

## Verification

Vitest covers presets at both sizes with every Studio door and Container opening, family transitions and heights, Container openings and infills, add-on availability per family, signature builds (valid, collision-free, shareable, matching their photographs), Studio door entry positions, v1 and v2 migration, custom inquiries, wall/entry/collision constraints, quote-only pricing, schema v1 migration, share validation, storage failure, undo/redo, real PDF generation for both families, demand-render invalidation, the sun path and sky model, quality and backend selection, material streaming progress, every equipment model staying inside its planning footprint, valid batched geometry, both product shells staying inside their nominal envelopes for every door, opening, infill, open state, and length, the four interior finishes, Container additions with both railings, and the background buildings. These are not substitutes for browser interaction tests, real-device performance testing, accessibility audits, or manufacturer review. No screenshot-diff or browser E2E suite is included yet.

## Before commercial launch

The supplied six-phase roadmap remains the product direction, not a claim that every phase has shipped. The current release is a self-contained frontend foundation plus useful interior-planning and decision tools. Production integrations are deliberately absent rather than simulated.

1. **Verified product data:** replace procedural geometry with approved CAD-derived glTF, confirm shell and add-on dimensions, and obtain licensed equipment assets and manufacturer clearances.
2. **Commercial configuration:** approved prices, taxes, regional delivery/foundation assumptions, deposit/refund terms, finance partner disclosures, production lead times, and warranty/specification copy.
3. **Backend and operations:** provision the intended Supabase project, authentication/RLS, versioned pricing/catalog administration, server-side quote validation, transactional email, CRM routing, and a rep dashboard. Confirm the recipient and retention policy before collecting leads.
4. **Payments:** use server-created, approved-price Stripe Checkout sessions, signed webhook handling, idempotency, and refund handling; never trust the client estimate as a charge amount.
5. **Visual and spatial services:** validated glTF/USDZ export, physical-device AR/VR, actual first-person navigation, photoreal asset pipeline, high-resolution path-traced capture, share-preview rendering, and performance budgets.
6. **Site and AI layers:** licensed map/parcel data, sourced zoning guidance, calibrated geospatial shadows, privacy controls for uploaded photos, and a model-backed assistant restricted to validated configuration tools and approved source documents.
7. **Release gate:** desktop/mobile E2E and accessibility audits, field-tested PDF and sharing, renderer fallback testing, observability with appropriate consent, and legal/product sign-off.

The configurator does **not** certify construction, safe installation, site fit, zoning, engineering, delivery feasibility, or equipment suitability. All such decisions require qualified local review.
