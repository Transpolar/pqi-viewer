// Postgres schema and helpers, async via the `pg` driver.
//
// The app uses Postgres so the same image runs unchanged on a laptop
// (via docker-compose, which boots a local Postgres alongside) or on
// Azure Container Apps (pointing at Azure Database for PostgreSQL
// Flexible Server). Schema is JSON-blob-heavy so the parsed PQI rows
// round-trip back to the device byte-for-byte on export.
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL env var is required (e.g. postgres://user:pw@host:5432/pqi?sslmode=require)');
  process.exit(1);
}

// `pg` picks up ssl=true from `?sslmode=require` in the URL, which is what
// Azure Database for PostgreSQL Flexible Server demands by default.
export const pool = new Pool({ connectionString });

pool.on('error', (err) => {
  // Long-lived idle clients in the pool can be cut by network blips; the
  // pool will reconnect on next use, just log and continue so we don't
  // crash the process.
  console.error('[pg] idle client error:', err);
});

// Idempotent schema init. Called once at startup from index.js before
// app.listen(). The mobile companion (mobile/server/index.js) calls the
// same initSchema() at boot, so the projects/captures tables get created
// regardless of which service starts first.
export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS files (
      id           BIGSERIAL PRIMARY KEY,
      filename     TEXT NOT NULL,
      version      TEXT,
      serial       TEXT,
      headers_json TEXT NOT NULL,
      uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS measurements (
      id          BIGSERIAL PRIMARY KEY,
      file_id     BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL,
      cells_json  TEXT NOT NULL,
      lat         DOUBLE PRECISION,
      lon         DOUBLE PRECISION
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_measurements_file ON measurements(file_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_measurements_file_pos ON measurements(file_id, position)`);

  // Companion-app tables. A `project` is just a named bucket the operator
  // selects on both devices (mobile companion + PQI 380). The mobile app
  // creates `captures` against a project — each capture is a GPS point
  // turned into an NVDB road reference, and is assigned a 2-digit `code`
  // (unique per project). The operator types that code into the PQI
  // device's Beskrivelse1 cell while taking a measurement.
  //
  // On the desktop side, when a .pqidat is uploaded INTO a project, the
  // server joins rows to captures on (project_id, code) and writes the
  // capture's road ref + GPS into the row — saving the operator from
  // typing road codes on the device.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id          BIGSERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      notes       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS captures (
      id          BIGSERIAL PRIMARY KEY,
      project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      code        TEXT NOT NULL,
      lat         DOUBLE PRECISION NOT NULL,
      lon         DOUBLE PRECISION NOT NULL,
      road_ref    TEXT,
      kortform    TEXT,
      road_lat    DOUBLE PRECISION,
      road_lon    DOUBLE PRECISION,
      notes       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, code)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_captures_project ON captures(project_id)`);

  // Allow files to be tagged to the project they belong to. Nullable so
  // legacy uploads (created before this feature) keep working unchanged.
  await pool.query(`
    ALTER TABLE files
       ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id)`);

  // Saved measurements — asphalt estimates and walked areas — that the
  // operator wants to keep with the project. `type` is a small enum
  // ('estimate' | 'area') and `data` carries the full JSON payload so
  // the shape can evolve without a schema migration.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_measurements (
      id          BIGSERIAL PRIMARY KEY,
      project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      name        TEXT,
      data        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_measurements_saved_project ON project_measurements(project_id)`);
}

// pg returns BIGSERIAL ids as JS strings (numbers >2^53 can't be JS
// numbers safely). For our row counts they fit fine, so coerce.
const num = (v) => (v == null ? null : Number(v));

// pg returns TIMESTAMPTZ as a JS Date; the React frontend already accepts
// ISO strings via Date parsing, so always emit ISO for consistency with
// the SQLite branch's text format.
const iso = (d) => (d instanceof Date ? d.toISOString() : (d == null ? '' : String(d)));

export async function insertFile(doc, filename) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fileRes = await client.query(
      `INSERT INTO files (filename, version, serial, headers_json)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [filename, doc.version || '', doc.serial || '', JSON.stringify(doc.headers)]
    );
    const fileId = num(fileRes.rows[0].id);
    for (let idx = 0; idx < doc.rows.length; idx++) {
      const row = doc.rows[idx];
      await client.query(
        `INSERT INTO measurements (file_id, position, cells_json, lat, lon)
         VALUES ($1, $2, $3, $4, $5)`,
        [fileId, idx, JSON.stringify(row.cells), row.gps ? row.gps.lat : null, row.gps ? row.gps.lon : null]
      );
    }
    await client.query('COMMIT');
    return fileId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function listFiles() {
  const res = await pool.query(`
    SELECT f.id, f.filename, f.version, f.serial, f.uploaded_at, f.updated_at,
           (SELECT COUNT(*) FROM measurements m WHERE m.file_id = f.id) AS measurement_count
      FROM files f
     ORDER BY f.uploaded_at DESC
  `);
  return res.rows.map((r) => ({
    id: num(r.id),
    filename: r.filename,
    version: r.version,
    serial: r.serial,
    measurement_count: num(r.measurement_count),
    uploaded_at: iso(r.uploaded_at),
    updated_at: iso(r.updated_at),
  }));
}

export async function getFile(id) {
  const fileRes = await pool.query(`SELECT * FROM files WHERE id = $1`, [id]);
  if (fileRes.rows.length === 0) return null;
  const file = fileRes.rows[0];
  const mRes = await pool.query(
    `SELECT id, position, cells_json, lat, lon FROM measurements
     WHERE file_id = $1 ORDER BY position ASC`,
    [id]
  );
  return {
    id: num(file.id),
    filename: file.filename,
    version: file.version,
    serial: file.serial,
    headers: JSON.parse(file.headers_json),
    uploaded_at: iso(file.uploaded_at),
    updated_at: iso(file.updated_at),
    measurements: mRes.rows.map((m) => ({
      id: num(m.id),
      position: m.position,
      cells: JSON.parse(m.cells_json),
      lat: m.lat,
      lon: m.lon,
    })),
  };
}

// Update a single cell at (measurementId, columnIndex).
// If parsedGps is provided (not undefined), the lat/lon columns are updated too.
export async function updateMeasurementCell(measurementId, columnIndex, newValue, parsedGps) {
  const rowRes = await pool.query(
    `SELECT m.cells_json, m.lat, m.lon, m.file_id FROM measurements m WHERE m.id = $1`,
    [measurementId]
  );
  if (rowRes.rows.length === 0) return null;
  const row = rowRes.rows[0];
  const cells = JSON.parse(row.cells_json);
  while (cells.length <= columnIndex) cells.push('');
  cells[columnIndex] = newValue;

  let lat = row.lat;
  let lon = row.lon;
  if (parsedGps !== undefined) {
    if (parsedGps === null) {
      lat = null;
      lon = null;
    } else {
      lat = parsedGps.lat;
      lon = parsedGps.lon;
    }
  }

  await pool.query(
    `UPDATE measurements SET cells_json = $1, lat = $2, lon = $3 WHERE id = $4`,
    [JSON.stringify(cells), lat, lon, measurementId]
  );
  await pool.query(`UPDATE files SET updated_at = NOW() WHERE id = $1`, [row.file_id]);

  return { id: measurementId, cells, lat, lon };
}

export async function deleteFile(id) {
  await pool.query(`DELETE FROM files WHERE id = $1`, [id]);
}

// Delete a single measurement row. Returns the parent file id so the
// caller can flush any per-file caches, or null if the id didn't exist.
// The remaining rows keep their original `position` values so previously
// computed indexes (e.g. the "#" column in the UI) stay stable; the
// export serializer doesn't depend on position being contiguous.
export async function deleteMeasurement(id) {
  const res = await pool.query(
    `DELETE FROM measurements WHERE id = $1 RETURNING file_id`,
    [id]
  );
  if (res.rows.length === 0) return null;
  const fileId = num(res.rows[0].file_id);
  await pool.query(`UPDATE files SET updated_at = NOW() WHERE id = $1`, [fileId]);
  return { fileId };
}

// Look up the header list for the file that owns a given measurement.
export async function getHeadersForMeasurement(measurementId) {
  const res = await pool.query(
    `SELECT f.headers_json FROM measurements m
       JOIN files f ON f.id = m.file_id
      WHERE m.id = $1`,
    [measurementId]
  );
  if (res.rows.length === 0) return null;
  return JSON.parse(res.rows[0].headers_json);
}

// Return file + measurement row for a measurement id.
export async function getMeasurementWithFile(measurementId) {
  const res = await pool.query(
    `SELECT m.id AS m_id, m.position, m.cells_json, m.lat, m.lon,
            f.id AS f_id, f.headers_json, f.filename
       FROM measurements m
       JOIN files f ON f.id = m.file_id
      WHERE m.id = $1`,
    [measurementId]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    measurement: {
      id: num(r.m_id),
      position: r.position,
      cells: JSON.parse(r.cells_json),
      lat: r.lat,
      lon: r.lon,
    },
    file: {
      id: num(r.f_id),
      filename: r.filename,
      headers: JSON.parse(r.headers_json),
    },
  };
}

// --- Projects + captures (companion-app domain) -------------------------

export async function listProjects() {
  const res = await pool.query(`
    SELECT p.id, p.name, p.notes, p.created_at,
           (SELECT COUNT(*) FROM captures c WHERE c.project_id = p.id) AS capture_count,
           (SELECT COUNT(*) FROM files    f WHERE f.project_id = p.id) AS file_count
      FROM projects p
     ORDER BY p.created_at DESC
  `);
  return res.rows.map((r) => ({
    id: num(r.id),
    name: r.name,
    notes: r.notes,
    created_at: iso(r.created_at),
    capture_count: num(r.capture_count),
    file_count: num(r.file_count),
  }));
}

export async function createProject(name, notes) {
  const res = await pool.query(
    `INSERT INTO projects (name, notes) VALUES ($1, $2) RETURNING id, name, notes, created_at`,
    [String(name).trim(), notes == null ? null : String(notes)]
  );
  const r = res.rows[0];
  return { id: num(r.id), name: r.name, notes: r.notes, created_at: iso(r.created_at) };
}

export async function getProject(id) {
  const pRes = await pool.query(`SELECT * FROM projects WHERE id = $1`, [id]);
  if (pRes.rows.length === 0) return null;
  const p = pRes.rows[0];
  const cRes = await pool.query(
    `SELECT id, code, lat, lon, road_ref, kortform, road_lat, road_lon, notes, created_at
       FROM captures WHERE project_id = $1 ORDER BY code ASC`,
    [id]
  );
  const fRes = await pool.query(
    `SELECT id, filename, uploaded_at, updated_at,
            (SELECT COUNT(*) FROM measurements m WHERE m.file_id = f.id) AS measurement_count
       FROM files f WHERE f.project_id = $1 ORDER BY f.uploaded_at DESC`,
    [id]
  );
  const mRes = await pool.query(
    `SELECT id, type, name, data, created_at
       FROM project_measurements WHERE project_id = $1 ORDER BY created_at DESC`,
    [id]
  );
  return {
    id: num(p.id),
    name: p.name,
    notes: p.notes,
    created_at: iso(p.created_at),
    captures: cRes.rows.map((c) => ({
      id: num(c.id),
      code: c.code,
      lat: c.lat,
      lon: c.lon,
      road_ref: c.road_ref,
      kortform: c.kortform,
      road_lat: c.road_lat,
      road_lon: c.road_lon,
      notes: c.notes,
      created_at: iso(c.created_at),
    })),
    files: fRes.rows.map((f) => ({
      id: num(f.id),
      filename: f.filename,
      measurement_count: num(f.measurement_count),
      uploaded_at: iso(f.uploaded_at),
      updated_at: iso(f.updated_at),
    })),
    measurements: mRes.rows.map((m) => {
      let parsed = null;
      try { parsed = JSON.parse(m.data); } catch { /* leave null */ }
      return {
        id: num(m.id),
        type: m.type,
        name: m.name,
        data: parsed,
        created_at: iso(m.created_at),
      };
    }),
  };
}

export async function insertMeasurement(projectId, type, name, data) {
  const res = await pool.query(
    `INSERT INTO project_measurements (project_id, type, name, data)
     VALUES ($1, $2, $3, $4)
     RETURNING id, type, name, data, created_at`,
    [projectId, String(type), name || null, JSON.stringify(data || {})]
  );
  const r = res.rows[0];
  return {
    id: num(r.id),
    type: r.type,
    name: r.name,
    data: JSON.parse(r.data),
    created_at: iso(r.created_at),
  };
}

export async function deleteMeasurementRecord(id) {
  await pool.query(`DELETE FROM project_measurements WHERE id = $1`, [id]);
}

export async function deleteProject(id) {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [id]);
}

// Append a capture and mint the next 2-digit code for the project (or
// 3-digit if a project somehow grows past 99). Uses a transaction so two
// simultaneous capture requests can't both grab the same code.
export async function appendCapture(projectId, payload) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const maxRes = await client.query(
      `SELECT COALESCE(MAX(CAST(code AS INTEGER)), -1) AS m FROM captures WHERE project_id = $1`,
      [projectId]
    );
    const nextN = Number(maxRes.rows[0].m) + 1;
    const code = nextN < 100 ? String(nextN).padStart(2, '0') : String(nextN);
    const insRes = await client.query(
      `INSERT INTO captures
         (project_id, code, lat, lon, road_ref, kortform, road_lat, road_lon, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, code, lat, lon, road_ref, kortform, road_lat, road_lon, notes, created_at`,
      [
        projectId, code,
        payload.lat, payload.lon,
        payload.road_ref || null, payload.kortform || null,
        payload.road_lat ?? null, payload.road_lon ?? null,
        payload.notes || null,
      ]
    );
    await client.query('COMMIT');
    const r = insRes.rows[0];
    return {
      id: num(r.id), code: r.code, lat: r.lat, lon: r.lon,
      road_ref: r.road_ref, kortform: r.kortform,
      road_lat: r.road_lat, road_lon: r.road_lon,
      notes: r.notes, created_at: iso(r.created_at),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteCapture(id) {
  await pool.query(`DELETE FROM captures WHERE id = $1`, [id]);
}

// Insert a file like insertFile, but tagged to a project. Used by the
// project-upload endpoint; we keep the two paths separate so the legacy
// "untagged upload" endpoint stays simple.
export async function insertFileForProject(doc, filename, projectId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fileRes = await client.query(
      `INSERT INTO files (filename, version, serial, headers_json, project_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [filename, doc.version || '', doc.serial || '', JSON.stringify(doc.headers), projectId]
    );
    const fileId = num(fileRes.rows[0].id);
    for (let idx = 0; idx < doc.rows.length; idx++) {
      const row = doc.rows[idx];
      await client.query(
        `INSERT INTO measurements (file_id, position, cells_json, lat, lon)
         VALUES ($1, $2, $3, $4, $5)`,
        [fileId, idx, JSON.stringify(row.cells), row.gps ? row.gps.lat : null, row.gps ? row.gps.lon : null]
      );
    }
    await client.query('COMMIT');
    return fileId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Fetch all captures for a project keyed by their code, used by the
// project-upload merge step on the desktop side.
export async function getCapturesByCode(projectId) {
  const res = await pool.query(
    `SELECT code, lat, lon, road_ref, kortform, road_lat, road_lon
       FROM captures WHERE project_id = $1`,
    [projectId]
  );
  const map = new Map();
  for (const r of res.rows) map.set(r.code, r);
  return map;
}

// Apply a snapped position: writes new lat/lon AND rewrites the GPS textual
// cell so an export matches the moved point.
export async function applySnap(measurementId, gpsColIndex, formattedGps, lat, lon) {
  const rowRes = await pool.query(
    `SELECT cells_json, file_id FROM measurements WHERE id = $1`,
    [measurementId]
  );
  if (rowRes.rows.length === 0) return null;
  const row = rowRes.rows[0];
  const cells = JSON.parse(row.cells_json);
  while (cells.length <= gpsColIndex) cells.push('');
  cells[gpsColIndex] = formattedGps;

  await pool.query(
    `UPDATE measurements SET cells_json = $1, lat = $2, lon = $3 WHERE id = $4`,
    [JSON.stringify(cells), lat, lon, measurementId]
  );
  await pool.query(`UPDATE files SET updated_at = NOW() WHERE id = $1`, [row.file_id]);

  return { id: measurementId, cells, lat, lon };
}
