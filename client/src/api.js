// Thin wrapper around fetch — keeps URL construction and error handling
// in one place so components stay tidy.

async function jsonOrThrow(res) {
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).detail || ''; } catch { /* ignore */ }
    throw new Error(`${res.status} ${res.statusText}${detail ? ': ' + detail : ''}`);
  }
  return res.json();
}

export const api = {
  listFiles: () => fetch('/api/files').then(jsonOrThrow),
  getFile: (id) => fetch(`/api/files/${id}`).then(jsonOrThrow),
  uploadFile: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch('/api/files', { method: 'POST', body: fd }).then(jsonOrThrow);
  },
  updateCell: (measurementId, columnIndex, value) =>
    fetch(`/api/measurements/${measurementId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnIndex, value }),
    }).then(jsonOrThrow),
  deleteFile: (id) =>
    fetch(`/api/files/${id}`, { method: 'DELETE' }).then(jsonOrThrow),
  exportUrl: (id) => `/api/files/${id}/export`,
  roadPositions: (id) => fetch(`/api/files/${id}/road-positions`).then(jsonOrThrow),
  snapOne: (measurementId, manualRef) =>
    fetch(`/api/measurements/${measurementId}/snap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manualRef ? { ref: manualRef } : {}),
    }).then(jsonOrThrow),
  setGps: (measurementId, lat, lon) =>
    fetch(`/api/measurements/${measurementId}/set-gps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon }),
    }).then(jsonOrThrow),
  snapAll: (fileId, opts = {}) =>
    fetch(`/api/files/${fileId}/snap-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    }).then(jsonOrThrow),
  // Reverse NVDB lookup for an arbitrary map-click position.
  roadPositionAt: (lat, lon) =>
    fetch(`/api/road-position?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`)
      .then(async (res) => {
        if (res.status === 404) return null; // no road within search radius
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      }),
};
