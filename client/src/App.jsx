import React, { useEffect, useState } from 'react';
import Library from './Library.jsx';
import FileDetail from './FileDetail.jsx';
import Projects from './Projects.jsx';
import ProjectDetail from './ProjectDetail.jsx';

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

// Minimal hash-router. Routes:
//   #/                      → Library (files)
//   #/files/:id             → FileDetail
//   #/projects              → Projects list
//   #/projects/:id          → ProjectDetail (captures + upload)
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
  const version = useServerVersion();

  const fileMatch = hash.match(/^#\/files\/(\d+)/);
  const fileId = fileMatch ? Number(fileMatch[1]) : null;
  const projectMatch = hash.match(/^#\/projects\/(\d+)/);
  const projectId = projectMatch ? Number(projectMatch[1]) : null;
  const onProjectsList = hash.startsWith('#/projects') && !projectId;
  const onLibrary = !fileId && !onProjectsList && !projectId;

  let body;
  if (fileId) body = <FileDetail fileId={fileId} />;
  else if (projectId) body = <ProjectDetail projectId={projectId} />;
  else if (onProjectsList) body = <Projects />;
  else body = <Library />;

  return (
    <>
      <header className="topbar">
        <h1>
          <a href="#/">PQI Viewer</a> <span className="muted">— TransTech PQI 380</span>
        </h1>
        <nav style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <a href="#/" className={onLibrary ? 'active' : ''}>Library</a>
          <a href="#/projects" className={onProjectsList || projectId ? 'active' : ''}>Projects</a>
          <span className="muted" style={{ fontSize: '0.75rem' }} title={version ? `built ${version.built}` : ''}>
            build {version ? version.version : '…'}
          </span>
        </nav>
      </header>
      <main className="page">{body}</main>
    </>
  );
}
