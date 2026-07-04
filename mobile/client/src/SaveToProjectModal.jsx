import React, { useEffect, useState } from 'react';
import { api } from './api.js';

// Small modal that lets the operator pick or create a project, then
// POSTs the measurement to it. Used by both the estimate and area
// screens — they pass in `type` ('estimate' or 'area'), a suggested
// `name`, and the `data` payload to save.
export default function SaveToProjectModal({ type, name: initialName, data, onClose, onSaved }) {
  const [projects, setProjects] = useState(null);
  const [name, setName] = useState(initialName || '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');

  useEffect(() => {
    api.listProjects().then(setProjects).catch((e) => setError(e.message));
  }, []);

  const saveTo = async (projectId) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveMeasurement(projectId, { type, name: name.trim() || null, data });
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const createAndSave = async (e) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProject(newProjectName.trim(), null);
      await saveTo(p.id);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="label">Save {type} to project</div>

        <label style={{ textAlign: 'left', fontSize: '0.85rem' }}>
          <span className="muted">Label (optional)</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. north side of parking lot"
            style={{ marginTop: '0.2rem' }}
          />
        </label>

        {error && <div className="error" style={{ fontSize: '0.85rem' }}>{error}</div>}

        {projects == null && <div className="muted">Loading projects…</div>}
        {projects && projects.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', maxHeight: 220, overflowY: 'auto' }}>
            {projects.map((p) => (
              <button
                key={p.id}
                className="ghost"
                disabled={busy}
                onClick={() => saveTo(p.id)}
                style={{ textAlign: 'left', padding: '0.6rem 0.8rem' }}
              >
                <strong>{p.name}</strong>
                <span className="muted" style={{ fontSize: '0.8rem', display: 'block' }}>
                  {p.capture_count} capture{p.capture_count === 1 ? '' : 's'}
                </span>
              </button>
            ))}
          </div>
        )}

        {!creating ? (
          <button className="ghost" onClick={() => setCreating(true)} disabled={busy}>
            + New project
          </button>
        ) : (
          <form onSubmit={createAndSave} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <input
              autoFocus
              placeholder="New project name"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
            />
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button type="button" className="ghost" onClick={() => setCreating(false)} disabled={busy}>Cancel</button>
              <button type="submit" disabled={busy || !newProjectName.trim()} style={{ flex: 1 }}>
                {busy ? 'Saving…' : 'Create & save'}
              </button>
            </div>
          </form>
        )}

        <button onClick={onClose} className="ghost">Close</button>
      </div>
    </div>
  );
}
