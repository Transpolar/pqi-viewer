// Express server: serves the built React frontend + REST API for PQI files.
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePqi, serializePqi, parseGps, formatGps, findColumn } from './pqi.js';
import {
  insertFile,
  listFiles,
  getFile,
  updateMeasurementCell,
  deleteFile,
  getHeadersForMeasurement,
  getMeasurementWithFile,
  applySnap,
} from './db.js';
import {
  assembleRoadRef,
  isSectionDefaulted,
  isKommuneMissing,
  scanCellsForCombinedRef,
  inferDefaultKommune,
  parseRoadAndSection,
} from './roadref.js';
import { lookupRef, lookupRefsBatch, lookupPosition, haversineMetres } from './nvdb.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Bump this when you change anything user-visible. Surfaced via /api/version
// and shown in the UI footer so the user can confirm which build is live.
const APP_VERSION = '0.11.0';
const APP_BUILT  = new Date().toISOString();

const app = express();
app.use(express.json({ limit: '10mb' }));

// Request logger — prints every API call to stdout so `docker compose logs
// -f pqi-app` shows exactly what hit the server (method, path, status,
// duration). This is critical for debugging "snap doesn't do anything":
// if the user clicks Snap and no log line appears, the request never
// reached the container (proxy/firewall issue). If a log line appears
// with status != 2xx, we know which row/error to investigate.
app.use((req, res, next) => {
  if (!req.url.startsWith('/api')) return next();
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    console.log(`[req] ${req.method} ${req.url} → ${res.statusCode} ${ms}ms`);
  });
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Build a road reference from a row, with two robustness layers:
//   1. Try the standard columns (Sted på veien + Beskrivelse2), falling
//      back to the second Sted column when the per-row road is blank.
//   2. If that yielded nothing, scan EVERY cell in the row for a glued
//      pattern like "9999KV1234S1D1M200" — some operators paste the full
//      ref into a comment cell.
// Both layers consult `defaultKommune` (file-level inference) so that
// K/P/S roads missing their kommune prefix can still resolve.
function refFromRow(headers, cells, defaultKommune) {
  const stedIdx = findColumn(headers, 'Sted på veien');
  const b1Idx = findColumn(headers, 'Beskrivelse1');
  const b2Idx = findColumn(headers, 'Beskrivelse2');

  if (b2Idx >= 0) {
    let road = stedIdx >= 0 ? (cells[stedIdx] || '').trim() : '';
    if (!road) {
      // Fall back to the SECOND "Sted" column.
      let found = -1, n = 0;
      for (let i = 0; i < headers.length; i++) {
        if (headers[i].trim().toLowerCase() === 'sted') {
          n++;
          if (n === 2) { found = i; break; }
        }
      }
      if (found >= 0) road = (cells[found] || '').trim();
    }
    if (road) {
      const b1 = b1Idx >= 0 ? cells[b1Idx] : '';
      const ref = assembleRoadRef(road, b1, cells[b2Idx], { defaultKommune });
      if (ref) return ref;
    }
  }

  // Last resort: maybe the operator typed the whole reference into a
  // random cell. Look for "<kommune>?<cat>V<num><section>M<meter>".
  return scanCellsForCombinedRef(cells, { defaultKommune });
}

// Was the section assumed (S1D1 default) rather than embedded in the road string?
function rowSectionWasDefaulted(headers, cells) {
  const b1Idx = findColumn(headers, 'Beskrivelse1');
  const stedIdx = findColumn(headers, 'Sted på veien');
  const sted = stedIdx >= 0 ? cells[stedIdx] : '';
  const b1 = b1Idx >= 0 ? cells[b1Idx] : '';
  return isSectionDefaulted(sted, b1);
}

// True if Sted på veien is missing the kommune prefix for a K/P/S road.
function rowKommuneWasMissing(headers, cells) {
  const stedIdx = findColumn(headers, 'Sted på veien');
  return stedIdx >= 0 && isKommuneMissing(cells[stedIdx]);
}

// Diagnostic helper: which mandatory input columns are blank for this row?
// Mandatory = road + meter. Section is no longer in this list since we
// auto-default it.
function refMissingReason(headers, cells) {
  const stedIdx = findColumn(headers, 'Sted på veien');
  const b2Idx = findColumn(headers, 'Beskrivelse2');
  const missing = [];

  const sted1 = stedIdx >= 0 ? (cells[stedIdx] || '').trim() : '';
  let sted2 = '';
  let n = 0;
  for (let i = 0; i < headers.length; i++) {
    if (headers[i].trim().toLowerCase() === 'sted') {
      n++;
      if (n === 2) { sted2 = (cells[i] || '').trim(); break; }
    }
  }
  if (!sted1 && !sted2) missing.push('road (Sted på veien / Sted)');
  if (b2Idx < 0 || !(cells[b2Idx] || '').trim()) missing.push('meter (Beskrivelse2)');
  return missing;
}

// --- API ----------------------------------------------------------------

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Hit this from your browser to verify which build the container is serving:
//   http://your-server:8080/api/version
app.get('/api/version', (_req, res) => res.json({
  version: APP_VERSION,
  built: APP_BUILT,
  node: process.version,
  pid: process.pid,
}));

app.get('/api/files', (_req, res) => {
  res.json(listFiles());
});

app.get('/api/files/:id', (req, res) => {
  const id = Number(req.params.id);
  const file = getFile(id);
  if (!file) return res.status(404).json({ error: 'not found' });

  const defaultKommune = inferDefaultKommune(file.measurements.map((m) => m.cells));
  file.measurements = file.measurements.map((m) => {
    const kommuneInferred =
      defaultKommune && rowKommuneWasMissing(file.headers, m.cells);
    const roadRef = refFromRow(file.headers, m.cells, defaultKommune);
    return {
      ...m,
      roadRef,
      sectionDefaulted: roadRef ? rowSectionWasDefaulted(file.headers, m.cells) : false,
      kommuneInferred: !!kommuneInferred,
      missingForRef: roadRef ? [] : refMissingReason(file.headers, m.cells),
    };
  });
  file.defaultKommune = defaultKommune;
  res.json(file);
});

app.post('/api/files', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const filename = req.file.originalname || 'upload.pqidat';
  const text = req.file.buffer.toString('utf8');
  try {
    const doc = parsePqi(text);
    const id = insertFile(doc, filename);
    res.json({ id, filename, measurements: doc.rows.length });
  } catch (err) {
    res.status(400).json({ error: 'parse failed', detail: String(err.message || err) });
  }
});

app.patch('/api/measurements/:id', (req, res) => {
  const id = Number(req.params.id);
  const { columnIndex, value } = req.body || {};
  if (!Number.isInteger(columnIndex) || columnIndex < 0) {
    return res.status(400).json({ error: 'columnIndex (integer) required' });
  }
  if (typeof value !== 'string') {
    return res.status(400).json({ error: 'value must be a string' });
  }

  const headers = getHeadersForMeasurement(id);
  if (!headers) return res.status(404).json({ error: 'measurement not found' });

  let parsedGps;
  const gpsIdx = findColumn(headers, 'GPS');
  if (gpsIdx === columnIndex) {
    parsedGps = parseGps(value);
  }

  const updated = updateMeasurementCell(id, columnIndex, value, parsedGps);
  if (!updated) return res.status(404).json({ error: 'measurement not found' });
  res.json(updated);
});

// --- Road-marker matching -----------------------------------------------

// GET /api/files/:id/road-positions
// Look up the NVDB road-marker position for every row that has a valid
// road reference. Returns positions + distance from the recorded GPS.
// This is the "preview" call — it does NOT mutate the database.
app.get('/api/files/:id/road-positions', async (req, res) => {
  const id = Number(req.params.id);
  const file = getFile(id);
  if (!file) return res.status(404).json({ error: 'not found' });

  const defaultKommune = inferDefaultKommune(file.measurements.map((m) => m.cells));
  const refsByMeasurement = new Map(); // measurementId → ref string
  for (const m of file.measurements) {
    const ref = refFromRow(file.headers, m.cells, defaultKommune);
    if (ref) refsByMeasurement.set(m.id, ref);
  }

  const results = await lookupRefsBatch(Array.from(refsByMeasurement.values()));

  const out = file.measurements.map((m) => {
    const ref = refsByMeasurement.get(m.id);
    if (!ref) return { id: m.id, position: m.position, ref: null };
    const r = results.get(ref);
    if (!r || r.error) {
      return { id: m.id, position: m.position, ref, error: r?.error || 'lookup failed' };
    }
    const dist = m.lat != null && m.lon != null
      ? haversineMetres(m.lat, m.lon, r.lat, r.lon)
      : null;
    return {
      id: m.id,
      position: m.position,
      ref,
      kortform: r.kortform,
      lat: r.lat,
      lon: r.lon,
      distance_m: dist,
    };
  });

  res.json(out);
});

// POST /api/measurements/:id/snap
// Looks up the row's road reference, then overwrites its GPS column with
// the road-marker position. Returns the updated row (with cells/lat/lon).
//
// Optional body: { ref: "9999 KV1234 S1D1 m100" } overrides auto-detection
// for files where Sted på veien / Beskrivelse columns are empty. NVDB is
// quite tolerant of formatting variations so the exact spacing rarely
// matters; we pass the user's string through verbatim.
app.post('/api/measurements/:id/snap', async (req, res) => {
  const id = Number(req.params.id);
  const ctx = getMeasurementWithFile(id);
  if (!ctx) return res.status(404).json({ error: 'measurement not found' });

  const manualRef = typeof req.body?.ref === 'string' ? req.body.ref.trim() : '';
  // Need every row's cells to infer the file's default kommune.
  const fileForKommune = getFile(ctx.file.id);
  const defaultKommune = inferDefaultKommune(
    (fileForKommune?.measurements || []).map((m) => m.cells)
  );
  const ref = manualRef || refFromRow(
    ctx.file.headers, ctx.measurement.cells, defaultKommune
  );
  if (!ref) return res.status(400).json({
    error: 'row has no usable road reference',
    hint: 'pass {"ref": "9999 KV1234 S1D1 m100"} in the request body to override',
  });

  const result = await lookupRef(ref);
  if (result.error) return res.status(502).json({ error: 'NVDB lookup failed', detail: result.error, ref });

  const gpsIdx = findColumn(ctx.file.headers, 'GPS');
  if (gpsIdx < 0) return res.status(500).json({ error: 'file has no GPS column' });

  const formatted = formatGps(result.lat, result.lon);
  const updated = applySnap(id, gpsIdx, formatted, result.lat, result.lon);
  console.log(`[snap] m${id} ref=${ref} → ${formatted}`);
  res.json({
    ...updated,
    ref,
    kortform: result.kortform,
    gpsColIndex: gpsIdx,
    gps: formatted, // the exact string written into cells[gpsColIndex]
  });
});

// POST /api/measurements/:id/set-gps   body: { lat, lon }
// Assign a lat/lon to a measurement (typically the coordinates the user
// got by clicking on the map). Writes the formatted PQI-style string into
// the GPS cell and updates the cached lat/lon.
app.post('/api/measurements/:id/set-gps', (req, res) => {
  const id = Number(req.params.id);
  const lat = Number(req.body?.lat);
  const lon = Number(req.body?.lon);
  if (!isFinite(lat) || !isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon (numbers) required in body' });
  }
  const ctx = getMeasurementWithFile(id);
  if (!ctx) return res.status(404).json({ error: 'measurement not found' });
  const gpsIdx = findColumn(ctx.file.headers, 'GPS');
  if (gpsIdx < 0) return res.status(500).json({ error: 'file has no GPS column' });

  const formatted = formatGps(lat, lon);
  const updated = applySnap(id, gpsIdx, formatted, lat, lon);
  console.log(`[set-gps] m${id} → ${formatted}`);
  res.json({ ...updated, gpsColIndex: gpsIdx, gps: formatted });
});

// POST /api/files/:id/snap-all
// Batch-snap every row in the file that has a usable road reference.
// Body: { onlyIfDistanceOver?: number }  — skip rows already close enough.
app.post('/api/files/:id/snap-all', async (req, res) => {
  const id = Number(req.params.id);
  const file = getFile(id);
  if (!file) return res.status(404).json({ error: 'not found' });

  const onlyOver = Number(req.body?.onlyIfDistanceOver);
  const gpsIdx = findColumn(file.headers, 'GPS');
  if (gpsIdx < 0) return res.status(500).json({ error: 'file has no GPS column' });

  const defaultKommune = inferDefaultKommune(file.measurements.map((m) => m.cells));
  const refsByMeasurement = new Map();
  for (const m of file.measurements) {
    const ref = refFromRow(file.headers, m.cells, defaultKommune);
    if (ref) refsByMeasurement.set(m.id, ref);
  }
  const results = await lookupRefsBatch(Array.from(refsByMeasurement.values()));

  let snapped = 0;
  let skipped = 0;
  let failed = 0;
  const details = [];
  for (const m of file.measurements) {
    const ref = refsByMeasurement.get(m.id);
    if (!ref) { skipped++; details.push({ id: m.id, ref: null, reason: 'no road reference' }); continue; }
    const r = results.get(ref);
    if (!r || r.error) { failed++; details.push({ id: m.id, ref, reason: r?.error || 'lookup failed' }); continue; }

    const distBefore = m.lat != null && m.lon != null
      ? haversineMetres(m.lat, m.lon, r.lat, r.lon)
      : null;
    if (isFinite(onlyOver) && distBefore != null && distBefore < onlyOver) {
      skipped++;
      details.push({ id: m.id, ref, reason: `within ${onlyOver}m (${distBefore.toFixed(1)}m)` });
      continue;
    }
    const formatted = formatGps(r.lat, r.lon);
    applySnap(m.id, gpsIdx, formatted, r.lat, r.lon);
    snapped++;
    details.push({ id: m.id, ref, distance_m: distBefore, kortform: r.kortform });
  }

  res.json({ snapped, skipped, failed, details });
});

// GET /api/road-position?lat=&lon=&maks_avstand=
// Reverse NVDB lookup: returns the road marker nearest a given map click.
app.get('/api/road-position', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const maxDist = req.query.maks_avstand ? Number(req.query.maks_avstand) : 200;
  if (!isFinite(lat) || !isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon (numbers) required' });
  }
  const result = await lookupPosition(lat, lon, maxDist);
  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result);
});

// --- Export -------------------------------------------------------------

app.get('/api/files/:id/export', (req, res) => {
  const id = Number(req.params.id);
  const file = getFile(id);
  if (!file) return res.status(404).json({ error: 'not found' });

  const doc = {
    version: file.version,
    serial: file.serial,
    headers: file.headers,
    rows: file.measurements.map((m) => ({ cells: m.cells })),
  };
  const out = serializePqi(doc);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${file.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`
  );
  res.send(out);
});

app.delete('/api/files/:id', (req, res) => {
  const id = Number(req.params.id);
  deleteFile(id);
  res.json({ ok: true });
});

// --- Static frontend ----------------------------------------------------

const clientDist = path.resolve(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, () => {
  console.log(`PQI app listening on http://0.0.0.0:${PORT}`);
});
