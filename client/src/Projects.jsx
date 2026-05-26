import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// Lists all projects + lets you create new ones from the desktop.
// Most projects will actually be created on the phone by the operator,
// but having parity here is useful for setup and admin.
export default function Projects() {
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = () => {
    setError(null);
    api.listProjects().then(setProjects).catch((e) => setError(e.message));
  };
  useEffect(reload, []);

  const onCreate = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const p = await api.createProject(name.trim(), notes.trim() || null);
      setName(''); setNotes(''); setCreating(false);
      window.location.hash = `#/projects/${p.id}`;
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (p) => {
    if (!confirm(`Delete project "${p.name}"? Captures and any uploaded files in this project will be deleted too.`)) return;
    try {
      await api.deleteProject(p.id);
      reload();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="library">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Projects</h2>
        <button onClick={() => setCreating((v) => !v)} className={creating ? 'ghost' : ''}>
          {creating ? 'Cancel' : '+ New project'}
        </button>
      </div>

      <p className="muted" style={{ marginTop: 0 }}>
        Projects are shared between this app and the mobile companion on port 8081.
        On the phone, capture GPS points against a project — each gets a 2-digit code
        the operator types into the PQI device's Beskrivelse1 cell. Upload the
        .pqidat into the same project here and the rows merge automatically.
      </p>

      {error && <div style={{ color: 'var(--bad)', marginBottom: '0.5rem' }}>{error}</div>}

      {creating && (
        <form onSubmit={onCreate} style={{
          display: 'flex', flexDirection: 'column', gap: '0.5rem',
          marginBottom: '1rem', padding: '1rem',
          background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8,
        }}>
          <input
            autoFocus
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ padding: '0.5rem 0.7rem', border: '1px solid var(--border)', borderRadius: 6 }}
          />
          <input
            placeholder="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            style={{ padding: '0.5rem 0.7rem', border: '1px solid var(--border)', borderRadius: 6 }}
          />
          <button type="submit" disabled={busy || !name.trim()} style={{ alignSelf: 'flex-start' }}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </form>
      )}

      {projects == null && <div className="muted">Loading…</div>}
      {projects && projects.length === 0 && (
        <div className="muted">No projects yet — create one above or on the mobile companion.</div>
      )}
      {projects && projects.length > 0 && (
        <table className="files">
          <thead>
            <tr>
              <th>Name</th>
              <th style={{ width: 90, textAlign: 'right' }}>Captures</th>
              <th style={{ width: 70,  textAlign: 'right' }}>Files</th>
              <th style={{ width: 160 }}>Created</th>
              <th style={{ width: 60 }}></th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td>
                  <a href={`#/projects/${p.id}`}><strong>{p.name}</strong></a>
                  {p.notes && <div className="muted" style={{ fontSize: '0.8rem' }}>{p.notes}</div>}
                </td>
                <td style={{ textAlign: 'right' }}>{p.capture_count}</td>
                <td style={{ textAlign: 'right' }}>{p.file_count}</td>
                <td className="muted">{p.created_at ? new Date(p.created_at).toLocaleString() : '—'}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="ghost danger" onClick={() => onDelete(p)} style={{ padding: '0.25rem 0.55rem', fontSize: '0.8rem' }}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
