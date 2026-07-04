// Thin fetch wrapper for the mobile companion API. All endpoints live
// under /api on whichever port this client is being served from
// (typically :8081 in production, or proxied during `vite dev`).

async function json(res) {
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const detail = typeof body === 'object' ? (body.detail || body.error) : body;
    throw new Error(`${res.status}: ${detail || res.statusText}`);
  }
  return body;
}

export const api = {
  listProjects: () => fetch('/api/projects').then(json),
  createProject: (name, notes) =>
    fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, notes }),
    }).then(json),
  getProject: (id) => fetch(`/api/projects/${id}`).then(json),
  postCapture: (projectId, { lat, lon, notes }) =>
    fetch(`/api/projects/${projectId}/captures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon, notes }),
    }).then(json),
  deleteCapture: (id) =>
    fetch(`/api/captures/${id}`, { method: 'DELETE' }).then(json),
  // Reverse NVDB lookup. Returns the road context for a lat/lon, or
  // null if no road is within the search radius (server replies 404).
  roadPositionAt: (lat, lon) =>
    fetch(`/api/road-position?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`)
      .then(async (res) => {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      }),
  // NVDB Dekkebredde / Vegbredde lookup for a vegsystemreferanse.
  // Returns { width_m, samples, source } on success, { width_m: null }
  // if NVDB has no width mapped here, throws on error.
  roadWidthForRef: (ref) =>
    fetch(`/api/road-width?vegsystemreferanse=${encodeURIComponent(ref)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      }),
  // Road-following distance between two GPS positions. Uses NVDB meter
  // delta when both endpoints land on the same delstrekning; falls
  // back to null for road_m otherwise (client uses straight-line as
  // the estimate).
  roadDistance: (startLat, startLon, endLat, endLon) =>
    fetch('/api/road-distance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startLat, startLon, endLat, endLon }),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    }),
  saveMeasurement: (projectId, { type, name, data }) =>
    fetch(`/api/projects/${projectId}/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, name, data }),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    }),
};
