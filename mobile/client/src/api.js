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
};
