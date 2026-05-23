# Changelog

All notable changes to PQI Viewer are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.12.0]: https://github.com/aerktisk/pqi-viewer/releases/tag/v0.12.0
[0.11.0]: https://github.com/aerktisk/pqi-viewer/releases/tag/v0.11.0
