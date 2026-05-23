# PQI Viewer

A small self-hosted web app for viewing and editing TransTech PQI 380 asphalt
density (`.pqidat`) files, with measurement points plotted on a Norwegian
Kartverket map and automatic matching against the NVDB national road database
(Statens vegvesen).

Built so a field engineer can:

- upload a `.pqidat` straight off the device,
- see every measurement on a real map,
- spot rows whose recorded GPS doesn't match the road marker the operator
  typed in,
- snap the GPS to the road marker with one click,
- fix typos in any cell, and
- export a `.pqidat` the device will accept back.

## Features

### Library + upload

- Drop a `.pqidat` on the upload area; it's parsed, stored in SQLite, and
  appears in the file list. Files persist across container restarts.

### Map (Kartverket + Esri)

A custom control panel (top-right of the map) gives three base maps and
two visibility toggles:

- **Topographic** (Kartverket WMTS, the default) for road context.
- **Satellite** (Esri World Imagery) for visual ground truth.
- **Hybrid** — satellite with the Kartverket topo layered on top at 55 %
  opacity, so road lines, tunnel dashes, contours and place names all
  stay readable over the imagery.
- Toggles for **● Recorded GPS** and **◆ Road marker** to show/hide the
  two marker types independently. The dashed pair-lines hide
  automatically when either endpoint is off.
- Green/orange/red circles = recorded GPS, coloured by the `Kompaktering`
  column (≥ 96 % / 92–96 % / < 92 %).
- Purple diamonds = the position derived from the row's road marker (NVDB),
  with a dashed line joining each pair so a bad match is obvious at a glance.
- Click any blank spot on the map → the app does a reverse NVDB lookup for
  that coordinate and shows the road reference. The found point can be
  assigned to any row as its GPS (useful for rows the device recorded
  without a GPS fix).

### Editable table

- Click any cell to edit. Enter saves, Escape cancels. Changes round-trip
  back to the `.pqidat` export.
- A "Road match" column shows:
  - the assembled NVDB reference (e.g. `9999 KV1234 S1D1 m100`),
  - distance from the recorded GPS to that reference, colour-coded,
  - a per-row **Snap** button.

### NVDB road-marker matching

The app builds a `vegsystemreferanse` from the operator's columns and looks it
up against `nvdbapiles.atlas.vegvesen.no`. Sources used:

- `Sted på veien` for the road and (if embedded) the section/delstrekning,
  e.g. `9999KV1234KS1D1`.
- `Beskrivelse2` for the meter (`M100`, `M100 F1`, etc.).

`Beskrivelse1` is **intentionally ignored** — in real PQI files it commonly
holds device-internal identifiers in a `<digits>\<digits>` shape that crash
NVDB with a 400.

Real operator data is messy, so a few fallbacks fire automatically:

- **Missing section** — if `Sted på veien` doesn't include a section, the
  app defaults to `S1D1` and shows a `(section S1D1)` hint on the row.
- **Missing kommune** — operators sometimes type `KV1234S2D1` instead of
  `9999KV1234S2D1`. The app scans the whole file for rows that DO have a
  kommune number, takes the most common one, and injects it into rows that
  don't. Affected rows are tagged `(kommune inferred)`.
- **Combined ref in a comment cell** — if `Sted på veien` and `Beskrivelse2`
  don't yield anything, the app scans every other cell of the row for a
  fully-glued pattern like `9999KV1234S1D1M200` and uses that.
- **Manual override** — if all of the above fail, the row exposes a text
  input where you can type the reference yourself and snap.

### Snap

- **Snap one row** (per-row button) — overwrites that row's `GPS` cell with
  the NVDB position. If the row had no GPS, this fills it in.
- **Snap all** — snaps every matchable row regardless of distance.

After every snap the table refreshes, a banner says exactly what happened,
and the new road-match distance is recomputed.

### Export

The export endpoint serialises the in-database measurements back to PQI's
exact wire format: UTF-8, semicolon-delimited, CRLF line endings, trailing
newline. Round-trip with the device's own files is byte-for-byte identical.

### Other

- `/api/version` returns the running build; the topbar shows it so you
  always know what's deployed.
- Every request is logged to stdout with method, path, status and duration —
  helpful when diagnosing snap behaviour.

## Quick start

### Docker Compose (recommended)

```bash
docker compose up --build -d
```

Open <http://localhost:8080>. SQLite lives in the named volume `pqi-data`
and survives container rebuilds.

Stop (keep data):

```bash
docker compose down
```

Stop and wipe data:

```bash
docker compose down -v
```

### Plain Docker

```bash
docker build -t pqi-app .
docker run -d --name pqi-app -p 8080:8080 -v pqi-data:/app/data pqi-app
```

### Local dev

Backend:

```bash
cd server
npm install
npm run dev          # http://localhost:8080
```

Frontend (separate terminal):

```bash
cd client
npm install
npm run dev          # http://localhost:5173 (proxies /api → :8080)
```

## How to use it (typical workflow)

1. Open the app, drag a `.pqidat` onto the upload box.
2. Click the new file in the library to open the detail view.
3. Look at the map. Any row whose purple diamond is far from its green circle
   is a candidate for snapping.
4. Skim the "Road match" column for orange/red distances or "auto failed"
   rows.
5. Use per-row Snap buttons to fix individual rows, or **Snap all** to
   snap every matchable row in one go.
6. For rows that don't auto-resolve, either:
   - type the correct reference (e.g. `9999 KV1234 S1D1 m100`) into the
     row's manual-ref input and press Snap, or
   - click the right spot on the map → use "assign to row" from the popup.
7. Edit any other cells you need to fix by clicking them.
8. Click **Export .pqidat** to download an edited copy. Load it back on the
   PQI 380.

## File format reference

The PQI 380 writes UTF-8 with CRLF endings:

```
1.0.1157;PQI3800XXXXXXXX
Prosjekt;Sted;Sted;Kontakt;Asfalttype;Steinstørrelse;Dybde;…;GPS;GPS Tid;Dato/Tid;Hulrom
PROJECT_NAME;PLACE_NAME;9999 KV1234;NN;AB11 0000;11mm - 15mm;50;…;00 00.00000 N 0 00.00000 E;…;0.0000000
…
```

(Example values are fully anonymised — real `.pqidat` files contain
project, operator and road data that is private to the operator.)

- Line 1 is `version;serial`.
- Line 2 is the (Norwegian) column header row. The device emits **duplicate
  headers** (`Sted` twice, `Operatør` twice); the parser stores cells by
  position rather than header name so no data is lost.
- GPS is `DD MM.MMMMM N DD MM.MMMMM E` (degrees + decimal minutes).

## Tech stack

- **Backend:** Node.js 20, Express, `better-sqlite3`, `multer`.
- **Frontend:** React 18, Vite, Leaflet, react-leaflet.
- **Maps:** Kartverket WMTS (topo) + Esri World Imagery (satellite) +
  CartoDB Voyager labels (hybrid overlay).
- **Road database:** [NVDB API LES v4](https://nvdbapiles.atlas.vegvesen.no/)
  (`X-Client: pqi-viewer`).
- **DB:** SQLite (one file in `/app/data` inside the container).

## Layout

```
.
├── Dockerfile              # multi-stage: client build → server runtime
├── docker-compose.yml
├── server/
│   ├── index.js            # Express + REST API + request logger
│   ├── db.js               # SQLite schema + helpers
│   ├── pqi.js              # PQI parser + serializer (byte-perfect round-trip)
│   ├── roadref.js          # NVDB reference assembly + kommune inference
│   ├── nvdb.js             # NVDB API client + haversine distance
│   └── package.json
└── client/
    ├── index.html
    ├── vite.config.js
    └── src/
        ├── main.jsx
        ├── App.jsx         # hash router + build version
        ├── Library.jsx     # file list + upload
        ├── FileDetail.jsx  # map + table layout, snap toasts
        ├── MapView.jsx     # Leaflet, layer switcher, click probe
        ├── DataTable.jsx   # editable cells, road-match column
        ├── api.js
        └── styles.css
```

## REST API

| Method | Path                                  | Purpose |
|--------|---------------------------------------|---------|
| GET    | `/api/version`                        | Build version string |
| GET    | `/api/health`                         | Health probe |
| GET    | `/api/files`                          | List uploaded files |
| GET    | `/api/files/:id`                      | File + all measurements (with assembled road ref) |
| POST   | `/api/files`                          | Upload (multipart `file`) |
| DELETE | `/api/files/:id`                      | Delete a file |
| PATCH  | `/api/measurements/:id`               | Edit one cell `{columnIndex, value}` |
| POST   | `/api/measurements/:id/snap`          | Snap one row to its road marker. Optional body `{ref}` to override the auto-detected reference. |
| POST   | `/api/measurements/:id/set-gps`       | Assign explicit `{lat, lon}` to one row. |
| GET    | `/api/files/:id/road-positions`       | NVDB lookup for every row (no mutation). |
| POST   | `/api/files/:id/snap-all`             | Batch snap; body `{onlyIfDistanceOver?: number}` to skip already-close rows. |
| GET    | `/api/road-position?lat=&lon=`        | Reverse NVDB lookup for an arbitrary map click. |
| GET    | `/api/files/:id/export`               | Download the edited `.pqidat`. |

## Privacy / data handling

- `.pqidat` files often contain project, operator and GPS information that
  the company considers sensitive. They live only in the SQLite database
  inside your deployment — the app does not send file contents anywhere
  except to NVDB (which only ever sees an assembled road reference string,
  never the file).
- `.pqidat` is in `.gitignore`. Don't commit operator data.

## Notes on map tile licensing

- **Kartverket** tiles are free for general use; attribution is built into
  the map. Review [Kartverket's terms](https://www.kartverket.no/api-og-data/vilkar-for-bruk)
  before deploying publicly.
- **Esri World Imagery** is used under Esri's standard map attribution. For
  heavy commercial use, consider a paid satellite provider.
- **CartoDB Voyager** labels: attribution included on the map.
