import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// Detail view for a single project: shows all captures (mobile-app
// origin) and lets the operator upload a .pqidat that gets merged
// against those captures by Beskrivelse1 code.
export default function ProjectDetail({ projectId }) {
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const fileInput = useRef(null);

  const reload = () => {
    setError(null);
    api.getProject(projectId).then(setProject).catch((e) => setError(e.message));
  };
  useEffect(reload, [projectId]);

  const onUpload = async (file) => {
    setUploading(true);
    setUploadResult(null);
    setError(null);
    try {
      const r = await api.uploadFileToProject(projectId, file);
      setUploadResult(r);
      reload();
      // Don't auto-navigate — let the user see the merge summary first.
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  if (!project && !error) return <div className="muted">Loading…</div>;
  if (error) return <div style={{ color: 'var(--bad)' }}>{error}</div>;

  return (
    <div className="library">
      <div style={{ marginBottom: '1rem' }}>
        <a href="#/projects" className="muted">← Projects</a>
        <h2 style={{ margin: '0.25rem 0' }}>{project.name}</h2>
        {project.notes && <div className="muted">{project.notes}</div>}
      </div>

      <div style={{
        background: 'var(--panel)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '1rem', marginBottom: '1.25rem',
      }}>
        <strong>Upload .pqidat to this project</strong>
        <p className="muted" style={{ margin: '0.35rem 0 0.75rem' }}>
          Rows whose Beskrivelse1 matches a 2-digit capture code from this
          project will get their road code, meter and GPS pre-filled from
          the capture's NVDB position. Other rows are imported unchanged.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept=".pqidat,text/plain"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
          }}
          disabled={uploading}
        />
        {uploading && <span className="muted" style={{ marginLeft: '0.5rem' }}>Uploading & merging…</span>}
        {uploadResult && (
          <div style={{ marginTop: '0.75rem', padding: '0.6rem 0.8rem', background: '#eaf6ed', border: '1px solid #b9e3c5', borderRadius: 6 }}>
            Uploaded <strong>{uploadResult.filename}</strong> ({uploadResult.measurements} rows).
            {' '}<strong>{uploadResult.matched}</strong> matched to captures.
            {' '}<a href={`#/files/${uploadResult.id}`}>Open file →</a>
          </div>
        )}
      </div>

      <h3>Captures <span className="muted" style={{ fontWeight: 400, fontSize: '0.85rem' }}>· {project.captures.length}</span></h3>
      {project.captures.length === 0 ? (
        <div className="muted">No captures yet — take some from the mobile companion on port 8081.</div>
      ) : (
        <table className="files">
          <thead>
            <tr>
              <th style={{ width: 70 }}>Code</th>
              <th>Road</th>
              <th style={{ width: 200 }}>GPS (taken)</th>
              <th style={{ width: 200 }}>GPS (road marker)</th>
              <th style={{ width: 160 }}>Captured</th>
            </tr>
          </thead>
          <tbody>
            {project.captures.map((c) => (
              <tr key={c.id}>
                <td><strong style={{ fontFamily: 'ui-monospace, monospace' }}>{c.code}</strong></td>
                <td>{c.kortform || c.road_ref || <span className="muted">no road match</span>}</td>
                <td className="muted">{c.lat?.toFixed(6)}, {c.lon?.toFixed(6)}</td>
                <td className="muted">
                  {c.road_lat != null ? `${c.road_lat.toFixed(6)}, ${c.road_lon.toFixed(6)}` : '—'}
                </td>
                <td className="muted">{c.created_at ? new Date(c.created_at).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={{ marginTop: '1.5rem' }}>Files in this project <span className="muted" style={{ fontWeight: 400, fontSize: '0.85rem' }}>· {project.files.length}</span></h3>
      {project.files.length === 0 ? (
        <div className="muted">No files uploaded yet.</div>
      ) : (
        <table className="files">
          <thead>
            <tr>
              <th>Filename</th>
              <th style={{ width: 90, textAlign: 'right' }}>Rows</th>
              <th style={{ width: 160 }}>Uploaded</th>
              <th style={{ width: 160 }}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {project.files.map((f) => (
              <tr key={f.id}>
                <td><a href={`#/files/${f.id}`}>{f.filename}</a></td>
                <td style={{ textAlign: 'right' }}>{f.measurement_count}</td>
                <td className="muted">{f.uploaded_at ? new Date(f.uploaded_at).toLocaleString() : '—'}</td>
                <td className="muted">{f.updated_at ? new Date(f.updated_at).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
