// Small geo helpers shared across mobile screens.

// Haversine distance in metres between two [lat, lon] pairs.
export function haversineM(a, b) {
  if (!a || !b) return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Perimeter of an open polyline (sum of consecutive haversine segments).
export function perimeterM(points) {
  if (!points || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1], points[i]);
  return total;
}

// Polygon area in m² using shoelace on a local equirectangular projection
// anchored at the first vertex. For job-site-sized areas (≤ a few km
// across) the cos(lat) approximation introduces sub-percent error, which
// is well below GPS noise. Auto-closes the polygon back to the first
// point.
export function polygonAreaSqM(points) {
  if (!points || points.length < 3) return 0;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const lat0 = toRad(points[0][0]);
  const lon0 = toRad(points[0][1]);
  const cosLat0 = Math.cos(lat0);
  // Project each point to local-tangent metres.
  const xy = points.map(([lat, lon]) => [
    (toRad(lon) - lon0) * cosLat0 * R,
    (toRad(lat) - lat0) * R,
  ]);
  // Shoelace, wrapping the last vertex back to the first.
  let sum = 0;
  for (let i = 0; i < xy.length; i++) {
    const j = (i + 1) % xy.length;
    sum += xy[i][0] * xy[j][1] - xy[j][0] * xy[i][1];
  }
  return Math.abs(sum) / 2;
}

// Format a distance in metres for human display (cm if sub-metre, km
// for thousands).
export function fmtDistance(m) {
  if (m == null || !isFinite(m)) return '—';
  if (m < 1) return `${(m * 100).toFixed(0)} cm`;
  if (m < 1000) return `${m.toFixed(1)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

// Format an area in m² (with hectare for large values).
export function fmtArea(sq) {
  if (sq == null || !isFinite(sq)) return '—';
  if (sq < 10000) return `${sq.toFixed(1)} m²`;
  return `${sq.toFixed(0)} m² (${(sq / 10000).toFixed(3)} ha)`;
}
