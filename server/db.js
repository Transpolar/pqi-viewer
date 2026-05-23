// SQLite schema and helpers (synchronous via better-sqlite3).
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = process.env.PQI_DATA_DIR || path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.PQI_DB_PATH || path.join(DATA_DIR, 'pqi.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  version TEXT,
  serial TEXT,
  headers_json TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS measurements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  position INTEGER NOT NULL,         -- order within the file (0-based)
  cells_json TEXT NOT NULL,          -- JSON array of cell strings, indexed by column position
  lat REAL,
  lon REAL,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_measurements_file ON measurements(file_id);
CREATE INDEX IF NOT EXISTS idx_measurements_file_pos ON measurements(file_id, position);
`);

export function insertFile(doc, filename) {
  const insertFileStmt = db.prepare(
    `INSERT INTO files (filename, version, serial, headers_json) VALUES (?, ?, ?, ?)`
  );
  const insertRowStmt = db.prepare(
    `INSERT INTO measurements (file_id, position, cells_json, lat, lon) VALUES (?, ?, ?, ?, ?)`
  );

  const tx = db.transaction((doc, filename) => {
    const info = insertFileStmt.run(
      filename,
      doc.version || '',
      doc.serial || '',
      JSON.stringify(doc.headers)
    );
    const fileId = info.lastInsertRowid;
    doc.rows.forEach((row, idx) => {
      insertRowStmt.run(
        fileId,
        idx,
        JSON.stringify(row.cells),
        row.gps ? row.gps.lat : null,
        row.gps ? row.gps.lon : null
      );
    });
    return fileId;
  });

  return tx(doc, filename);
}

export function listFiles() {
  return db
    .prepare(
      `SELECT f.id, f.filename, f.version, f.serial, f.uploaded_at, f.updated_at,
              (SELECT COUNT(*) FROM measurements m WHERE m.file_id = f.id) AS measurement_count
         FROM files f
         ORDER BY f.uploaded_at DESC`
    )
    .all();
}

export function getFile(id) {
  const file = db.prepare(`SELECT * FROM files WHERE id = ?`).get(id);
  if (!file) return null;
  const measurements = db
    .prepare(
      `SELECT id, position, cells_json, lat, lon
         FROM measurements WHERE file_id = ? ORDER BY position ASC`
    )
    .all(id)
    .map((m) => ({
      id: m.id,
      position: m.position,
      cells: JSON.parse(m.cells_json),
      lat: m.lat,
      lon: m.lon,
    }));
  return {
    id: file.id,
    filename: file.filename,
    version: file.version,
    serial: file.serial,
    headers: JSON.parse(file.headers_json),
    uploaded_at: file.uploaded_at,
    updated_at: file.updated_at,
    measurements,
  };
}

// Update a single cell at (measurementId, columnIndex).
// If parsedGps is provided (not undefined), the lat/lon columns are updated too.
export function updateMeasurementCell(measurementId, columnIndex, newValue, parsedGps) {
  const row = db
    .prepare(`SELECT m.*, f.id AS file_id FROM measurements m JOIN files f ON f.id = m.file_id WHERE m.id = ?`)
    .get(measurementId);
  if (!row) return null;
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

  db.prepare(
    `UPDATE measurements SET cells_json = ?, lat = ?, lon = ? WHERE id = ?`
  ).run(JSON.stringify(cells), lat, lon, measurementId);

  db.prepare(`UPDATE files SET updated_at = datetime('now') WHERE id = ?`).run(row.file_id);

  return { id: measurementId, cells, lat, lon };
}

export function deleteFile(id) {
  db.prepare(`DELETE FROM files WHERE id = ?`).run(id);
}

// Look up the header list for the file that owns a given measurement.
// Used to detect whether a cell edit is on the GPS column.
export function getHeadersForMeasurement(measurementId) {
  const row = db
    .prepare(
      `SELECT f.headers_json FROM measurements m
         JOIN files f ON f.id = m.file_id
         WHERE m.id = ?`
    )
    .get(measurementId);
  if (!row) return null;
  return JSON.parse(row.headers_json);
}

// Return the file + measurement row for a given measurement id, so callers
// can build a vegsystemreferanse from the row's textual columns.
export function getMeasurementWithFile(measurementId) {
  const row = db
    .prepare(
      `SELECT m.id AS m_id, m.position, m.cells_json, m.lat, m.lon,
              f.id AS f_id, f.headers_json, f.filename
         FROM measurements m
         JOIN files f ON f.id = m.file_id
         WHERE m.id = ?`
    )
    .get(measurementId);
  if (!row) return null;
  return {
    measurement: {
      id: row.m_id,
      position: row.position,
      cells: JSON.parse(row.cells_json),
      lat: row.lat,
      lon: row.lon,
    },
    file: {
      id: row.f_id,
      filename: row.filename,
      headers: JSON.parse(row.headers_json),
    },
  };
}

// Apply a snapped position to a measurement: writes the new lat/lon AND
// rewrites the GPS textual cell so an export matches the moved point.
// `gpsColIndex` is the column index of the "GPS" header in this file.
// `formattedGps` is the deg+decimal-minutes string for that column.
export function applySnap(measurementId, gpsColIndex, formattedGps, lat, lon) {
  const row = db
    .prepare(
      `SELECT m.cells_json, m.file_id FROM measurements m WHERE m.id = ?`
    )
    .get(measurementId);
  if (!row) return null;
  const cells = JSON.parse(row.cells_json);
  while (cells.length <= gpsColIndex) cells.push('');
  cells[gpsColIndex] = formattedGps;

  db.prepare(
    `UPDATE measurements SET cells_json = ?, lat = ?, lon = ? WHERE id = ?`
  ).run(JSON.stringify(cells), lat, lon, measurementId);

  db.prepare(`UPDATE files SET updated_at = datetime('now') WHERE id = ?`).run(row.file_id);

  return { id: measurementId, cells, lat, lon };
}
