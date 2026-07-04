# Changelog

All notable changes to PQI Viewer are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.18.0] — 2026-05-26

### Added

- **AreaWalker: stop-and-go corner mode with vertex averaging.**
  Primary flow is now: stand at each corner → tap **📍 Save corner**
  → phone collects up to 12 qualified GPS fixes over up to 15 s →
  stores the **median** as one point. Quality gates on every incoming
  fix: `accuracy > 0`, `accuracy ≤ 10 m`, `timestamp < 5 s old`. On
  finish the result panel also reports the average corner spread
  (tightness of each sample cluster) so the operator has a sense of
  how much to trust the m² number. A checkbox toggles the old
  walk-and-log mode as an opt-in for very large loose shapes; the
  default is corner-median because it's dramatically more accurate.
- **Estimate now uses road-follow distance from NVDB.** New
  `POST /api/road-distance` (server) computes distance by reverse-
  looking-up both endpoints and, when both land on the same
  `(kategori, nummer, strekning, delstrekning)`, returning the meter
  delta from NVDB's `vegsystemreferanse`. Client shows the road
  length in green, with the straight-line length as a secondary
  reference. Multi-segment routing isn't implemented yet — the
  endpoint returns `road_m: null` with a reason and the client falls
  back to straight-line distance in the tonnage math.
- **Save measurements to a project.** New
  `project_measurements (id, project_id, type, name, data JSON,
  created_at)` table. Endpoints:
  `POST /api/projects/:id/measurements` (save),
  `DELETE /api/measurements/saved/:id` (remove). Both the estimate
  and area screens get a **💾 Save to project** button that opens a
  modal picker for an existing project (or spins up a new one
  in-line). Desktop **Projects → detail** page now shows a "Saved
  measurements" section listing all estimates and walked areas per
  project, with type-appropriate summary columns.
- **lookupPosition returns structured road address.** In addition to
  the `kortform`, the position response now includes `vegkategori`,
  `vegnummer`, `strekning`, `delstrekning`, `meter`. Used by
  `/api/road-distance` and available to future clients.

### Notes on GPS accuracy

- The browser Geolocation API doesn't expose iOS Core Location knobs
  like `desiredAccuracy = kCLLocationAccuracyBestForNavigation` or
  `requestTemporaryFullAccuracyAuthorization` from a web app — that
  requires a native shell. `enableHighAccuracy: true` is the best a
  PWA can request. Typical iOS Safari accuracy on a modern iPhone is
  5–15 m; corner-median gets that down to ~2–5 m per corner on a
  quiet fix. For survey-grade work you'd want an external RTK GNSS
  receiver (Emlid Reach, Bad Elf) feeding a native app — outside the
  scope of this web app for now.

## [0.17.2] — 2026-05-26

### Fixed

- **NVDB width auto-fill in the asphalt estimator now actually works.**
  The 0.17.0 implementation used guessed vegobjekttype IDs that didn't
  match reality. Verified against the NVDB datakatalog and rewrote
  `lookupWidth(ref)` in `server/nvdb.js`:
  - **VT 838** ("Vegbredde, beregnet" — modern, NVDB-computed) tried
    first. The catalogue explicitly tells callers to prefer 838 over
    the historisk variant.
  - **VT 583** ("Vegbredde, historisk") used as fallback only when 838
    has no data for the segment.
  - Property names matched **exactly** in priority order: `Dekkebredde`
    (the wearing course — what an asphalt job pays for) →
    `Vegbredde` / `Vegbredde, totalt` → `Kjørebanebredde`. The previous
    substring regex picked up `Dekkebredde, min` etc. by accident.
  - Switched the include set to `inkluder=alle` to be robust against
    NVDB tweaking the default field selection.
  - Server-side `[nvdb-width]` log line on every lookup so it's easy to
    see in container logs whether NVDB returned width or not.
- **Mobile width-field status** now distinguishes "checking NVDB…",
  "auto from NVDB (Dekkebredde, avg of 4)", "NVDB has no width data
  here — using default", and "edited". The 0.17.0 version silently fell
  back to 6.5 when NVDB returned nothing, with no visible signal that
  the lookup had even run.

## [0.17.1] — 2026-05-26

### Changed

- **AreaWalker UX simplified to a three-phase flow.** Idle → tap
  **▶ Start walking** → walking around the perimeter while the polygon
  fills in → tap **■ Stop & calculate** → result panel shows the area
  + perimeter + corner count, with a **↻ Start over** button to reset.
  Removed the Pause/Resume controls (which were never the right model
  for "walk around the patch once and stop"). The secondary
  Drop-corner / Undo buttons stay but only appear while recording.
  Live area + walked distance still update during recording so the
  operator can sanity-check the trace.

## [0.17.0] — 2026-05-26

### Added

- **NVDB road-width auto-fill in the asphalt estimator.** New
  `lookupWidth(ref)` in `server/nvdb.js` hits NVDB's vegobjekter API,
  trying "Bredde, dekke" (vegobjekttype 583 — wearing-course width)
  first and falling back to "Bredde" (581 — full road) when dekke
  isn't mapped on that segment. When the estimator's start and end
  pins both resolve to a road, the width field is pre-filled with the
  average of the returned widths, labelled "auto from NVDB
  (Bredde, dekke, avg of N)". The operator can still edit it — once
  they do, the field is marked "edited" and auto-fill stops fighting
  them. Exposed at `GET /api/road-width?vegsystemreferanse=<ref>` on
  both desktop and mobile ports.
- **Live GPS + map auto-recenter on the estimate screen.** Continuous
  `watchPosition` watcher drops a blue dot + accuracy ring on the
  Kartverket topo (same custom-pane trick as the capture screen). On
  first fix the map snaps from a Norway-overview view to the
  operator's actual location at zoom 16.
- **"Start here" / "End here" buttons.** Drop the segment pins at the
  operator's current GPS position — perfect for driving down the
  road you're about to pave: pull over at the start, tap Start here,
  drive to the end, tap End here. Map taps still work as a manual
  override.

### Notes

- The vegobjekttype IDs (583, 581) are the most common width
  attributes in NVDB; if your specific road segment uses a different
  attribute, the lookup returns `{ width_m: null }` and the field
  keeps its default — no user-visible error.

## [0.16.0] — 2026-05-26

### Added

- **Mobile home menu** with three tools: **Capture** (existing
  project + 2-digit code flow), **Asphalt estimate**, **Walk an area**.
  The home screen is now `#/` on the mobile app; the project picker
  moved to `#/projects`.
- **Asphalt estimate (v1).** Tap two points on a Kartverket topo map →
  app reads NVDB road context for each point (informational) and
  computes the straight-line segment length. Operator enters width
  (m), thickness (mm), mix (dropdown with built-in densities for Ab /
  Agb / Ska / Ma / Pmb, plus a custom-density slot), and wastage (%).
  Output: estimated tonnes + m³, with the chosen density and wastage
  shown for transparency. Both pins are draggable for fine-tuning.
- **Walk an area.** Continuous GPS watcher records a polyline as the
  operator walks the perimeter of an irregular shape; the polygon
  auto-closes and the area is reported in m² (with ha for big shapes)
  using a local-equirectangular shoelace projection (sub-percent error
  at job-site scale). Quality gates skip fixes worse than ±30 m or
  closer than 2 m to the previous point. Controls: Start / Pause /
  Resume / Reset / Undo / ＋ Drop point (manual corner). Perimeter and
  closing-leg distance are shown live alongside the area.

### Changed

- Mobile router gains `#/estimate` and `#/area`; existing routes
  unchanged. The topbar's back-arrow always returns to home.

### Notes

- Estimate v1 uses straight-line distance and a single average width;
  a v2 could pull width along the segment from NVDB's Dekkebredde
  vegobjekt and sample the road-network distance instead.

## [0.15.0] — 2026-05-26

### Added

- **Live NVDB road context on the mobile capture screen.** Two
  debounced reverse-NVDB lookups now run continuously:
  - "Your road" — fired when the operator has moved more than ~5 m
    since the last lookup, capped at one request per second. Shows
    which `vegsystemreferanse` the live blue dot is on, plus how many
    metres off the centreline they are.
  - "Marker road" — fired ~½ second after the operator stops dragging
    the capture pin. Shows the road the saved capture will end up on,
    so the operator can see immediately whether their nudge landed on
    the right street.
  Both readouts handle the "no road within 200 m" and "NVDB error"
  cases gracefully — they render as muted hints, not blocking errors.
- **Per-capture delete button** on the captures list under the map.
  Tap the trailing `×`, confirm, and the row is removed from the
  shared DB; the list reloads immediately. Uses the existing
  `DELETE /api/captures/:id` endpoint.

### Changed

- `/api/road-position` moved into the shared API router so both the
  desktop port (8080) and the mobile port (8081) serve it. The desktop
  map-click probe still works exactly as before.

## [0.14.2] — 2026-05-26

### Fixed

- **Live location was invisible** when the operator hadn't moved yet.
  The blue dot + accuracy ring were rendered into Leaflet's default
  `overlayPane` (z-index 400) while the draggable pin lives in
  `markerPane` (z-index 600), so any time the live position coincided
  with the pin (which is the default state right after the first GPS
  fix, since the marker is seeded at livePos), the pin completely
  covered the dot. The live elements now render into a custom pane
  with z-index 650, so they sit visibly above the pin even when
  coincident. Also bumped the dot radius from 8→9 px, the accuracy
  ring's opacity from 0.12→0.18, and gave the ring a 6-m floor so it's
  visible even on a sharp fix.

## [0.14.1] — 2026-05-26

### Added

- **Live location on the mobile capture map.** Geolocation switched from
  a one-shot `getCurrentPosition` to a continuous `watchPosition`
  watcher. A blue dot + translucent accuracy ring on the map updates as
  the operator moves, while the draggable capture marker stays
  independent (drag it to fine-tune the spot, then tap the **⌖ My
  location** floating button to snap it back to your live position).
  The status bar under the map now shows live coords with ± accuracy
  and (when reported) heading, and the marker readout shows how many
  metres it's been nudged from your current position. The GPS watcher
  is `clearWatch`'d on screen unmount so the radio doesn't stay hot.

## [0.14.0] — 2026-05-26

### Added

- **Mobile companion app.** New mobile-friendly web app served from the
  same container on port **8081**. Field flow:
  1. Phone opens `http://pqi-host:8081`, picks (or creates) a project.
  2. Browser geolocation centres a Kartverket topo map on the operator's
     position; the marker is **draggable** so the operator can nudge it
     onto the actual measurement spot before saving.
  3. Tap "Save capture" → server reverse-looks-up the lat/lon against
     NVDB and mints the next per-project 2-digit code (`00`, `01`, …).
  4. Code appears in a big modal — operator types it into the PQI
     device's **Beskrivelse1** cell, then takes the measurement.
- **Per-project upload + merge.** New `POST /api/projects/:id/files`
  endpoint and matching "Projects" page on the desktop. Upload a
  `.pqidat` into a project and the server joins every row to its capture
  by the 2-digit Beskrivelse1 code, pre-filling `Sted på veien`,
  `Beskrivelse2` and `GPS` from the capture's resolved NVDB position.
  Rows whose code doesn't match a capture are imported unchanged.
- **Shared `projects` and `captures` tables** in Postgres. `files` gains
  a nullable `project_id` so files can be tagged to a project without
  breaking legacy uploads.
- **Projects nav + page** in the desktop UI (`#/projects`,
  `#/projects/:id`) — list, create, delete projects; see captures and
  uploaded files per project.

### Changed

- **Single container, two ports.** One Node process now spawns two
  Express apps in the same image: 8080 serves the desktop bundle, 8081
  serves the mobile bundle. Both share the DB pool, the NVDB client and
  the project + capture REST handlers (factored into a
  `registerSharedApi(targetApp)` helper). `docker-compose.yml` exposes
  both ports from the existing `pqi-app` service.
- **Dockerfile** now multi-stage builds `client/` and `mobile/client/`
  in parallel stages, then copies both `dist/` folders into the runtime.
- **Azure infra (`infra/main.bicep` + `infra/deploy.sh`).** Adds a
  second Container App (`pqi-viewer-mobile`) that pulls the same image
  with `PORT=0, MOBILE_PORT=8081` so the mobile bundle gets its own
  `https://pqi-viewer-mobile.<region>.azurecontainerapps.io` URL with a
  valid Let's Encrypt cert — required for the browser Geolocation API.
  Both Container Apps share the same Postgres and can scale to zero
  independently. `deploy.sh` now prints both URLs and cleans up both
  apps on rerun.
- **Server boot.** `PORT` and `MOBILE_PORT` can now be set to `0` to
  disable a listener, so the desktop and mobile Container Apps each
  bind only the port their HTTP ingress targets.

## [0.13.2] — 2026-05-25

### Changed

- Per-row `×` delete button moved from the second column (right after
  `#`) to the last column. Keeps the high-density data columns
  visually adjacent and matches the convention that destructive
  actions sit at the trailing edge of a row.

## [0.13.1] — 2026-05-25

### Added

- **Per-row delete.** New `×` button in the data table next to the row
  number. Removes the row from the file with a confirm prompt, the
  table and map markers update immediately, and the export now omits
  the deleted row. Surviving rows keep their original `position`
  values (no renumbering) so the export serializer is unaffected.
  Wired up by a new `DELETE /api/measurements/:id` endpoint.

## [0.13.0] — 2026-05-25

Persistence moves from SQLite to Postgres so the same image runs on
a laptop (via docker-compose) or on Azure Container Apps without
any platform-specific glue. User-facing app is unchanged.

### Changed

- **SQLite → Postgres.** `server/db.js` rewritten against the `pg`
  driver. Same schema (`files`, `measurements`), same JSON-blob columns,
  same lat/lon caching, same transaction semantics for uploads. All
  helpers are now async; Express handlers in `server/index.js` await
  them.
- **Dockerfile.** Drops `python3 / make / g++` build deps — `pg` is
  pure JS, no C toolchain needed at install time.
- **docker-compose.yml.** Adds a `postgres:16-alpine` service with a
  healthcheck, so `docker compose up --build -d` works end-to-end
  locally without any external DB setup.
- **infra/main.bicep.** Drops the Premium FileStorage / NFS share /
  managed env storage entirely. Adds an Azure Database for PostgreSQL
  Flexible Server (`Standard_B1ms`) + database + Azure-services
  firewall rule. The Container App reads the DB connection string from
  a Bicep secret. Scale range widened to 0–2 replicas now that state
  lives in a real DB.
- **infra/deploy.sh.** `GITHUB_BRANCH=azure`, otherwise the same
  two-pass flow as main.

## [0.12.0] — 2026-05-23

### Changed

- **Map control panel rebuilt.** Replaced Leaflet's default `LayersControl`
  with a custom top-right panel that exposes a clear 3-way base map choice
  — **Topographic**, **Satellite**, **Hybrid** — instead of stacking base
  layers and a separate labels overlay.
- **Hybrid view is now actually hybrid.** Previously "Hybrid" overlaid
  only the CartoDB labels-only tileset on satellite, so you saw place
  names but no road geometry. It now overlays the full Kartverket topo at
  55 % opacity, so road lines, tunnel symbols, contours and place names
  are all readable on top of the imagery — far more useful for
  cross-checking GPS points against the road network.

### Added

- **Marker visibility toggles.** New "Show" section in the map control
  panel with checkboxes for ● Recorded GPS and ◆ Road marker. Dashed
  pair-lines connecting the two are automatically hidden when either
  endpoint is off (no more dangling lines).

### Removed

- **"Snap to road (skip already-close)" toolbar button.** Use the per-row
  Snap buttons for selective work, or **Snap all** for batch. The backend
  endpoint (`POST /api/files/:id/snap-all` with `onlyIfDistanceOver`) is
  unchanged — only the UI shortcut went away.

## [0.11.0] — 2026-05-23

Initial public release. Self-hosted web app for viewing and editing
TransTech PQI 380 asphalt density (`.pqidat`) files, with map plotting
on Kartverket and automatic matching against the NVDB national road
database.

### Added

- Upload `.pqidat`, parse into SQLite, list in a library view.
- Map view with Kartverket topographic basemap, Esri satellite alternate,
  and a labels overlay. Green/orange/red GPS circles coloured by
  `Kompaktering` (≥ 96 % / 92–96 % / < 92 %) and purple-diamond road
  markers derived from each row's NVDB reference.
- Editable table: click any cell to edit; Enter saves, Escape cancels.
  Changes round-trip back to the exported `.pqidat`.
- NVDB road-marker matching (`vegsystemreferanse`) built from
  `Sted på veien` + `Beskrivelse2`. `Beskrivelse1` is ignored (it commonly
  contains device-internal identifiers that crash NVDB with HTTP 400).
- Robustness fallbacks for messy operator data:
  - default section `S1D1` when `Sted på veien` doesn't include one,
  - kommune inference from sibling rows when the operator omits the
    kommune prefix,
  - row-cell scan for fully-glued references when standard columns yield
    nothing,
  - per-row manual reference input as a last resort.
- Snap operations: per-row **Snap**, **Snap to road (skip already-close)**
  (replaced in 0.12.0), and **Snap all**. After each snap the table
  refreshes, a banner reports the result, and distances recompute.
- Export endpoint: byte-for-byte identical round-trip with the device's
  own files (UTF-8, semicolon-delimited, CRLF line endings, trailing
  newline).
- Map click probe: click any blank spot → reverse NVDB lookup → diamond +
  popup with the road reference and a one-click "assign to row" action.
- `/api/version` endpoint + build version in the topbar.
- Stdout request logger (method, path, status, duration).

### Tech

- Backend: Node.js 20, Express, `better-sqlite3`, `multer`.
- Frontend: React 18, Vite, Leaflet, react-leaflet.
- Maps: Kartverket WMTS (topo) + Esri World Imagery (satellite) +
  CartoDB Voyager labels (hybrid overlay, removed in 0.12.0 in favour of
  the topo overlay).
- Road database: NVDB API LES v4 (`X-Client: pqi-viewer`).
- DB: SQLite (one file in `/app/data` inside the container).

[0.12.0]: https://github.com/transpolar/pqi-viewer/releases/tag/v0.12.0
[0.11.0]: https://github.com/transpolar/pqi-viewer/releases/tag/v0.11.0
