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
// app.listen(). Mirrors the SQLite schema in main/server/db.js.
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
