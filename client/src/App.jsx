import React, { useEffect, useState } from 'react';
import Library from './Library.jsx';
import FileDetail from './FileDetail.jsx';

// Mounted once on app boot, fetches /api/version so the topbar shows what
// build is running. If this number doesn't change after a redeploy, the
// container still has the old build (likely a Docker layer cache hit).
function useServerVersion() {
  const [v, setV] = useState(null);
  useEffect(() => {
    fetch('/api/version')
      .then((r) => r.ok ? r.json() : null)
      .then(setV)
      .catch(() => setV({ version: 'unknown' }));
  }, []);
  return v;
}

// Minimal hash-router. Avoids pulling in react-router for a 2-route app.
// Routes:
//   #/                → Library
//   #/files/:id       → FileDetail
function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHashRoute();
  const match = hash.match(/^#\/files\/(\d+)/);
  const fileId = match ? Number(match[1]) : null;
  const version = useServerVersion();

  return (
    <>
      <header className="topbar">
        <h1>
          <a href="#/">PQI Viewer</a> <span className="muted">— TransTech PQI 380</span>
        </h1>
        <nav style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <a href="#/" className={!fileId ? 'active' : ''}>Library</a>
          <span className="muted" style={{ fontSize: '0.75rem' }} title={version ? `built ${version.built}` : ''}>
            build {version ? version.version : '…'}
          </span>
        </nav>
      </header>
      <main className="page">
        {fileId ? <FileDetail fileId={fileId} /> : <Library />}
      </main>
    </>
  );
}
