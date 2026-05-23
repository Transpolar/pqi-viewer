import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

export default function Library() {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dragover, setDragover] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setFiles(await api.listFiles());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const upload = async (file) => {
    try {
      await api.uploadFile(file);
      refresh();
    } catch (e) {
      alert('Upload failed: ' + e.message);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragover(false);
    for (const f of e.dataTransfer.files) upload(f);
  };

  const onPick = (e) => {
    for (const f of e.target.files) upload(f);
    e.target.value = '';
  };

  const onDelete = async (id, filename) => {
    if (!confirm(`Delete ${filename}? This cannot be undone.`)) return;
    try {
      await api.deleteFile(id);
      refresh();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  };

  return (
    <div className="library">
      <div
        className={'uploader' + (dragover ? ' dragover' : '')}
        onDragOver={(e) => { e.preventDefault(); setDragover(true); }}
        onDragLeave={() => setDragover(false)}
        onDrop={onDrop}
      >
        <p style={{ margin: 0 }}>
          Drag &amp; drop <code>.pqidat</code> files here, or{' '}
          <label style={{ color: 'var(--accent)', cursor: 'pointer' }}>
            choose a file
            <input type="file" accept=".pqidat,text/plain" hidden onChange={onPick} multiple />
          </label>
        </p>
      </div>

      {error && <p style={{ color: 'var(--bad)' }}>Error: {error}</p>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : files.length === 0 ? (
        <p className="muted">No files yet — upload one above.</p>
      ) : (
        <table className="files">
          <thead>
            <tr>
              <th>File</th>
              <th>Device serial</th>
              <th>Version</th>
              <th>Measurements</th>
              <th>Uploaded</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id}>
                <td><a href={`#/files/${f.id}`}>{f.filename}</a></td>
                <td>{f.serial}</td>
                <td>{f.version}</td>
                <td>{f.measurement_count}</td>
                <td>{f.uploaded_at}</td>
                <td>{f.updated_at}</td>
                <td className="row-actions">
                  <a href={api.exportUrl(f.id)}>
                    <button className="ghost">Export</button>
                  </a>
                  <button className="danger" onClick={() => onDelete(f.id, f.filename)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
