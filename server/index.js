// Express server: serves the built React frontend + REST API for PQI files.
// Azure branch — all DB calls are async (Postgres via the `pg` driver).
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePqi, serializePqi, parseGps, formatGps, findColumn } from './pqi.js';
import {
  initSchema,
  insertFile,
  listFiles,
  getFile,
  updateMeasurementCell,
  deleteFile,
  deleteMeasurement,
  getHeadersForMeasurement,
  getMeasurementWithFile,
  applySnap,
  listProjects,
  createProject,
  getProject,
  deleteProject,
  insertFileForProject,
  getCapturesByCode,
  appendCapture,
  deleteCapture,
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
const APP_VERSION = '0.14.0';
const APP_BUILT  = new Date().toISOString();

const app = express();
app.use(express.json({ limit: '10mb' }));

// Request logger — prints every API call to stdout so container logs show
// exactly what hit the server (method, path, status, duration).
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

  return scanCellsForCombinedRef(cells, { defaultKommune });
}

function rowSectionWasDefaulted(headers, cells) {
  const b1Idx = findColumn(headers, 'Beskrivelse1');
  const stedIdx = findColumn(headers, 'Sted på veien');
  const sted = stedIdx >= 0 ? cells[stedIdx] : '';
  const b1 = b1Idx >= 0 ? cells[b1Idx] : '';
  return isSectionDefaulted(sted, b1);
}

function rowKommuneWasMissing(headers, cells) {
  const stedIdx = findColumn(headers, 'Sted på veien');
  return stedIdx >= 0 && isKommuneMissing(cells[stedIdx]);
}

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

// Endpoints shared by BOTH the desktop and mobile apps. We register them
// on each Express instance via this function rather than mounting one app
// on the other, because mounting confuses the static-file middleware
// (desktop's `client/dist` would shadow mobile's `mobile/client/dist`).
// Keeping a single closure per handler means no logic duplication.
function registerSharedApi(targetApp) {
  targetApp.get('/api/health', (_req, res) => res.json({ ok: true }));

  targetApp.get('/api/version', (_req, res) => res.json({
    version: APP_VERSION,
    built: APP_BUILT,
    node: process.version,
    pid: process.pid,
  }));

  targetApp.get('/api/projects', async (_req, res, next) => {
    try { res.json(await listProjects()); } catch (err) { next(err); }
  });

  targetApp.post('/api/projects', async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      res.json(await createProject(name, req.body?.notes));
    } catch (err) {
      if (err && /unique/i.test(String(err.message))) {
        return res.status(409).json({ error: 'project name already exists' });
      }
      next(err);
    }
  });

  targetApp.get('/api/projects/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const p = await getProject(id);
      if (!p) return res.status(404).json({ error: 'not found' });
      res.json(p);
    } catch (err) { next(err); }
  });

  targetApp.delete('/api/projects/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      await deleteProject(id);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // POST /api/projects/:id/captures
  // Called by the mobile companion when the operator taps "Save capture".
  // Reverse-lookup against NVDB → mint per-project 2-digit code → return
  // both so the operator can type the code into the device's Beskrivelse1.
  targetApp.post('/api/projects/:id/captures', async (req, res, next) => {
    try {
      const projectId = Number(req.params.id);
      const project = await getProject(projectId);
      if (!project) return res.status(404).json({ error: 'project not found' });

      const lat = Number(req.body?.lat);
      const lon = Number(req.body?.lon);
      if (!isFinite(lat) || !isFinite(lon)) {
        return res.status(400).json({ error: 'lat and lon (numbers) required' });
      }
      const maxDist = req.body?.maxDistance ? Number(req.body.maxDistance) : 200;

      // Tolerate "no road within search radius" — the capture is still
      // stored so the operator can fix it on the desktop side later.
      const road = await lookupPosition(lat, lon, maxDist);
      const cap = await appendCapture(projectId, {
        lat, lon,
        road_ref:  road.error ? null : road.ref,
        kortform:  road.error ? null : road.kortform,
        road_lat:  road.error ? null : road.lat,
        road_lon:  road.error ? null : road.lon,
        notes:     req.body?.notes || null,
      });
      console.log(`[capture] project=${projectId} code=${cap.code} ref=${cap.kortform || '—'}`);
      res.json({ ...cap, nvdb: road.error ? { error: road.error } : road });
    } catch (err) { next(err); }
  });

  targetApp.delete('/api/captures/:id', async (req, res, next) => {
    try {
      await deleteCapture(Number(req.params.id));
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
}

registerSharedApi(app);

app.get('/api/files', async (_req, res, next) => {
  try {
    res.json(await listFiles());
  } catch (err) { next(err); }
});

app.get('/api/files/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const file = await getFile(id);
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
  } catch (err) { next(err); }
});

app.post('/api/files', upload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const filename = req.file.originalname || 'upload.pqidat';
  const text = req.file.buffer.toString('utf8');
  try {
    const doc = parsePqi(text);
    const id = await insertFile(doc, filename);
    res.json({ id, filename, measurements: doc.rows.length });
  } catch (err) {
    if (err && err.message && err.message.startsWith('PQI')) {
      return res.status(400).json({ error: 'parse failed', detail: String(err.message) });
    }
    next(err);
  }
});

// Projects + captures REST endpoints are defined in registerSharedApi()
// above (they're also exposed on the mobile-companion port). The desktop
// side adds the one upload endpoint below — multer + the merge step
// aren't needed on mobile.

// POST /api/projects/:id/files
// Upload a .pqidat into a project. Before storing, the parser walks every
// row and, for any row whose Beskrivelse1 cell matches a 2-digit capture
// code from this project, rewrites the row's Sted på veien, Beskrivelse2
// and GPS cells from the capture's resolved NVDB position. The result is
// a file where the device just typed "01", "02", "03" but the saved data
// already has the full road context — and the GPS already snapped.
app.post('/api/projects/:id/files', upload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  try {
    const projectId = Number(req.params.id);
    const project = await getProject(projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const text = req.file.buffer.toString('utf8');
    const doc = parsePqi(text);

    const capturesByCode = await getCapturesByCode(projectId);

    const b1Idx    = findColumn(doc.headers, 'Beskrivelse1');
    const stedIdx  = findColumn(doc.headers, 'Sted på veien');
    const b2Idx    = findColumn(doc.headers, 'Beskrivelse2');
    const gpsIdx   = findColumn(doc.headers, 'GPS');

    let matched = 0;
    const matchDetails = [];
    for (const row of doc.rows) {
      const raw = b1Idx >= 0 ? String(row.cells[b1Idx] || '').trim() : '';
      // Accept "1", "01", "  17  " — normalise to the zero-padded 2-digit
      // form we minted. Skip empty / non-numeric cells silently.
      if (!/^\d+$/.test(raw)) continue;
      const code = raw.length === 1 ? '0' + raw : raw;
      const cap = capturesByCode.get(code);
      if (!cap) continue;

      // Apply: road context from the capture's resolved NVDB ref + GPS
      // from the road-marker position (so the row is also pre-snapped).
      if (cap.kortform && stedIdx >= 0) {
        // kortform is the canonical "FV911 S1D1 m100" style — split off the
        // meter and write the road+section into Sted på veien and the meter
        // into Beskrivelse2 so the desktop's road-ref parser keeps working.
        const m = String(cap.kortform).trim().match(/^(.*?)\s+m(\d+)\s*$/i);
        if (m) {
          row.cells[stedIdx] = m[1].replace(/\s+/g, '');
          if (b2Idx >= 0) row.cells[b2Idx] = `M${m[2]}`;
        } else {
          row.cells[stedIdx] = String(cap.kortform);
        }
      } else if (cap.road_ref && stedIdx >= 0) {
        row.cells[stedIdx] = String(cap.road_ref);
      }

      if (gpsIdx >= 0) {
        const useLat = cap.road_lat != null ? cap.road_lat : cap.lat;
        const useLon = cap.road_lon != null ? cap.road_lon : cap.lon;
        row.cells[gpsIdx] = formatGps(useLat, useLon);
        row.gps = { lat: useLat, lon: useLon };
      }
      matched++;
      matchDetails.push({ code, kortform: cap.kortform });
    }

    const filename = req.file.originalname || 'upload.pqidat';
    const id = await insertFileForProject(doc, filename, projectId);
    res.json({
      id, filename, projectId,
      measurements: doc.rows.length,
      matched,
      matchDetails,
    });
  } catch (err) {
    if (err && err.message && err.message.startsWith('PQI')) {
      return res.status(400).json({ error: 'parse failed', detail: String(err.message) });
    }
    next(err);
  }
});

app.patch('/api/measurements/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { columnIndex, value } = req.body || {};
    if (!Number.isInteger(columnIndex) || columnIndex < 0) {
      return res.status(400).json({ error: 'columnIndex (integer) required' });
    }
    if (typeof value !== 'string') {
      return res.status(400).json({ error: 'value must be a string' });
    }

    const headers = await getHeadersForMeasurement(id);
    if (!headers) return res.status(404).json({ error: 'measurement not found' });

    let parsedGps;
    const gpsIdx = findColumn(headers, 'GPS');
    if (gpsIdx === columnIndex) {
      parsedGps = parseGps(value);
    }

    const updated = await updateMeasurementCell(id, columnIndex, value, parsedGps);
    if (!updated) return res.status(404).json({ error: 'measurement not found' });
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/measurements/:id
// Remove one row from a file. The map view, the table row, and the file's
// measurement count all update on the next reload. Position values for the
// surviving rows are not renumbered — the export serializer reads them in
// position order but doesn't require contiguous numbering.
app.delete('/api/measurements/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await deleteMeasurement(id);
    if (!result) return res.status(404).json({ error: 'measurement not found' });
    console.log(`[delete] m${id} (file ${result.fileId})`);
    res.json({ ok: true, fileId: result.fileId });
  } catch (err) { next(err); }
});

// --- Road-marker matching -----------------------------------------------

app.get('/api/files/:id/road-positions', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const file = await getFile(id);
    if (!file) return res.status(404).json({ error: 'not found' });

    const defaultKommune = inferDefaultKommune(file.measurements.map((m) => m.cells));
    const refsByMeasurement = new Map();
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
  } catch (err) { next(err); }
});

app.post('/api/measurements/:id/snap', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const ctx = await getMeasurementWithFile(id);
    if (!ctx) return res.status(404).json({ error: 'measurement not found' });

    const manualRef = typeof req.body?.ref === 'string' ? req.body.ref.trim() : '';
    const fileForKommune = await getFile(ctx.file.id);
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
    const updated = await applySnap(id, gpsIdx, formatted, result.lat, result.lon);
    console.log(`[snap] m${id} ref=${ref} → ${formatted}`);
    res.json({
      ...updated,
      ref,
      kortform: result.kortform,
      gpsColIndex: gpsIdx,
      gps: formatted,
    });
  } catch (err) { next(err); }
});

app.post('/api/measurements/:id/set-gps', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const lat = Number(req.body?.lat);
    const lon = Number(req.body?.lon);
    if (!isFinite(lat) || !isFinite(lon)) {
      return res.status(400).json({ error: 'lat and lon (numbers) required in body' });
    }
    const ctx = await getMeasurementWithFile(id);
    if (!ctx) return res.status(404).json({ error: 'measurement not found' });
    const gpsIdx = findColumn(ctx.file.headers, 'GPS');
    if (gpsIdx < 0) return res.status(500).json({ error: 'file has no GPS column' });

    const formatted = formatGps(lat, lon);
    const updated = await applySnap(id, gpsIdx, formatted, lat, lon);
    console.log(`[set-gps] m${id} → ${formatted}`);
    res.json({ ...updated, gpsColIndex: gpsIdx, gps: formatted });
  } catch (err) { next(err); }
});

app.post('/api/files/:id/snap-all', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const file = await getFile(id);
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
      await applySnap(m.id, gpsIdx, formatted, r.lat, r.lon);
      snapped++;
      details.push({ id: m.id, ref, distance_m: distBefore, kortform: r.kortform });
    }

    res.json({ snapped, skipped, failed, details });
  } catch (err) { next(err); }
});

app.get('/api/road-position', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const maxDist = req.query.maks_avstand ? Number(req.query.maks_avstand) : 200;
    if (!isFinite(lat) || !isFinite(lon)) {
      return res.status(400).json({ error: 'lat and lon (numbers) required' });
    }
    const result = await lookupPosition(lat, lon, maxDist);
    if (result.error) return res.status(404).json({ error: result.error });
    res.json(result);
  } catch (err) { next(err); }
});

// --- Export -------------------------------------------------------------

app.get('/api/files/:id/export', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const file = await getFile(id);
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
  } catch (err) { next(err); }
});

app.delete('/api/files/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await deleteFile(id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Catch-all error handler. Without this, a thrown error in any handler
// dangles the request until the client times out. Logs to stdout (visible
// in container logs) and returns a JSON 500.
app.use((err, _req, res, _next) => {
  console.error('[err]', err);
  res.status(500).json({ error: 'internal error', detail: String(err?.message || err) });
});

// --- Static frontend ----------------------------------------------------

const clientDist = path.resolve(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// --- Mobile companion (second port) -------------------------------------
//
// Second Express instance in the same Node process. Same DB pool, same
// NVDB client, same shared API handlers (registered via
// registerSharedApi). Only difference is the static bundle — mobile/client
// instead of client. The operator hits :8080 on a laptop and :8081 on a
// phone; each side gets a UI tuned to its form factor.
const mobileApp = express();
mobileApp.use(express.json({ limit: '1mb' }));
mobileApp.use((req, res, next) => {
  if (!req.url.startsWith('/api')) return next();
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    console.log(`[req:mobile] ${req.method} ${req.url} → ${res.statusCode} ${ms}ms`);
  });
  next();
});
registerSharedApi(mobileApp);

// Re-use the same error handler on the mobile app so thrown handler
// errors don't dangle the client.
mobileApp.use((err, _req, res, _next) => {
  console.error('[err:mobile]', err);
  res.status(500).json({ error: 'internal error', detail: String(err?.message || err) });
});

const mobileDist = path.resolve(__dirname, '..', 'mobile', 'client', 'dist');
if (fs.existsSync(mobileDist)) {
  mobileApp.use(express.static(mobileDist));
  mobileApp.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(mobileDist, 'index.html'));
  });
}

// Ports can be set to 0 to disable that listener. This is used in Azure
// where each Container App gets HTTP ingress on a single targetPort —
// the "desktop" Container App runs with MOBILE_PORT=0 and the "mobile"
// Container App runs with PORT=0. docker-compose leaves both at their
// defaults so the single local container serves both surfaces.
const PORT        = process.env.PORT        != null ? Number(process.env.PORT)        : 8080;
const MOBILE_PORT = process.env.MOBILE_PORT != null ? Number(process.env.MOBILE_PORT) : 8081;

// Init schema first so the first /api/files request doesn't race table
// creation. If Postgres is unreachable at boot we want to crash loudly
// rather than silently serve 500s — Container Apps will restart us.
initSchema()
  .then(() => {
    if (PORT > 0) {
      app.listen(PORT, () => {
        console.log(`PQI app listening on http://0.0.0.0:${PORT}`);
      });
    } else {
      console.log('PQI app listener disabled (PORT=0)');
    }
    if (MOBILE_PORT > 0) {
      mobileApp.listen(MOBILE_PORT, () => {
        console.log(`PQI mobile companion listening on http://0.0.0.0:${MOBILE_PORT}`);
      });
    } else {
      console.log('PQI mobile companion listener disabled (MOBILE_PORT=0)');
    }
    if (PORT <= 0 && MOBILE_PORT <= 0) {
      console.error('[fatal] both PORT and MOBILE_PORT are disabled — nothing to serve');
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('[fatal] schema init failed:', err);
    process.exit(1);
  });
