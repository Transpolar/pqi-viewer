// Parser and serializer for TransTech PQI 380 .pqidat files.
//
// File format (observed):
//   Line 1: "<version>;<serial>"               e.g. "1.0.1157;PQI3800XXXXXXXX"
//   Line 2: ";"-separated Norwegian column headers (CAN CONTAIN DUPLICATES —
//           the sample file has two "Sted" columns and two "Operatør" columns,
//           so we MUST index row values by column position, not by header name)
//   Line 3+: ";"-separated data rows
//   Line endings: CRLF ("\r\n")
//   Trailing newline at end of file.
//
// GPS column format (when present):
//   "<deg> <minutes> N <deg> <minutes> E"  (degrees + decimal minutes)
//   e.g. "00 00.00000 N 0 00.00000 E"
//   Empty value when GPS was not acquired.

const LINE_SEP = '\r\n';
const FIELD_SEP = ';';

// Parse a GPS string into { lat, lon } decimal degrees, or null if empty/invalid.
export function parseGps(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const re = /^(-?\d+)\s+(\d+(?:\.\d+)?)\s*([NS])\s+(-?\d+)\s+(\d+(?:\.\d+)?)\s*([EW])$/i;
  const m = trimmed.match(re);
  if (!m) return null;

  const latDeg = parseFloat(m[1]);
  const latMin = parseFloat(m[2]);
  const latHem = m[3].toUpperCase();
  const lonDeg = parseFloat(m[4]);
  const lonMin = parseFloat(m[5]);
  const lonHem = m[6].toUpperCase();

  let lat = Math.abs(latDeg) + latMin / 60;
  if (latHem === 'S') lat = -lat;
  let lon = Math.abs(lonDeg) + lonMin / 60;
  if (lonHem === 'W') lon = -lon;

  if (!isFinite(lat) || !isFinite(lon)) return null;
  return { lat, lon };
}

// Format decimal degrees back to the device's "DD MM.MMMMM N DD MM.MMMMM E" form.
export function formatGps(lat, lon) {
  if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) return '';
  const latHem = lat >= 0 ? 'N' : 'S';
  const lonHem = lon >= 0 ? 'E' : 'W';
  const absLat = Math.abs(lat);
  const absLon = Math.abs(lon);
  const latDeg = Math.floor(absLat);
  const lonDeg = Math.floor(absLon);
  const latMin = ((absLat - latDeg) * 60).toFixed(5);
  const lonMin = ((absLon - lonDeg) * 60).toFixed(5);
  return `${latDeg} ${latMin} ${latHem} ${lonDeg} ${lonMin} ${lonHem}`;
}

// Parse a full .pqidat file content (string) into a structured object.
//
// Returns:
//   {
//     version: "1.0.1157",
//     serial:  "PQI3800XXXXXXXX",
//     headers: [ ... 21 column names (may include duplicates) ... ],
//     rows: [
//       { cells: ["PROJECT_NAME", "PLACE_NAME", ...], gps: {lat,lon}|null },
//       ...
//     ],
//   }
export function parsePqi(text) {
  if (typeof text !== 'string') throw new Error('parsePqi: text must be a string');

  const lines = text.split(/\r\n|\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length < 2) throw new Error('parsePqi: file too short');

  const [version, serial] = lines[0].split(FIELD_SEP);
  const headers = lines[1].split(FIELD_SEP);

  const gpsIdx = headers.findIndex((h) => h.trim().toLowerCase() === 'gps');

  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    const parts = line.split(FIELD_SEP);
    // Pad short rows so cells.length === headers.length (defensive).
    while (parts.length < headers.length) parts.push('');
    const gpsRaw = gpsIdx >= 0 ? (parts[gpsIdx] || '') : '';
    rows.push({
      cells: parts,
      gps: parseGps(gpsRaw),
    });
  }

  return {
    version: version || '',
    serial: serial || '',
    headers,
    rows,
  };
}

// Serialize a parsed structure back to the original .pqidat textual format.
// Uses CRLF line endings and a trailing CRLF.
export function serializePqi(doc) {
  const out = [];
  out.push(`${doc.version}${FIELD_SEP}${doc.serial}`);
  out.push(doc.headers.join(FIELD_SEP));
  for (const row of doc.rows) {
    // Strictly use row.cells (indexed by column position) — header-keyed
    // values would silently merge duplicate headers like "Sted".
    const parts = doc.headers.map((_h, idx) => {
      const v = row.cells[idx];
      return v == null ? '' : String(v);
    });
    out.push(parts.join(FIELD_SEP));
  }
  return out.join(LINE_SEP) + LINE_SEP;
}

// Convenience: find the column index for a header name (first occurrence).
export function findColumn(headers, name) {
  const target = name.trim().toLowerCase();
  return headers.findIndex((h) => h.trim().toLowerCase() === target);
}
