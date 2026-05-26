import React, { useEffect, useState } from 'react';
import { api } from './api.js';

// First screen the operator sees on the phone. Lists existing projects
// (created either here or on the desktop) and lets them spin up a new one
// in two taps.
export default function ProjectPicker({ onPickProject }) {
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
      onPickProject(p);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      {error && <div className="card error">{error}</div>}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Pick a project</h2>
        {projects == null && <div className="muted">Loading…</div>}
        {projects && projects.length === 0 && (
          <div className="muted">No projects yet — create one below.</div>
        )}
        {projects && projects.length > 0 && (
          <div className="project-list">
            {projects.map((p) => (
              <button key={p.id} className="project" onClick={() => onPickProject(p)}>
                <span className="name">{p.name}</span>
                <span className="meta">
                  {p.capture_count} capture{p.capture_count === 1 ? '' : 's'}
                  {p.notes ? ` · ${p.notes}` : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>New project</h2>
        {!creating && (
          <button className="ghost" onClick={() => setCreating(true)}>+ Create project</button>
        )}
        {creating && (
          <form className="new-project" onSubmit={onCreate}>
            <input
              autoFocus
              placeholder="Project name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              placeholder="Notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button type="button" className="ghost" onClick={() => setCreating(false)} disabled={busy}>
                Cancel
              </button>
              <button type="submit" disabled={busy || !name.trim()} style={{ flex: 1 }}>
                {busy ? 'Creating…' : 'Create & open'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
