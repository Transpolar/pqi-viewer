import React, { useEffect, useState } from 'react';
import ProjectPicker from './ProjectPicker.jsx';
import CaptureScreen from './CaptureScreen.jsx';
import { api } from './api.js';

// Tiny client-side router (hash-based) so the app works offline-friendly
// and doesn't need a backend route catch-all beyond /index.html.
// Hash forms:
//   #/                    → project picker
//   #/project/:id         → capture screen
function useRoute() {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export default function App() {
  const hash = useRoute();
  const [version, setVersion] = useState('');

  useEffect(() => {
    fetch('/api/version').then((r) => r.json()).then((v) => setVersion(v.version)).catch(() => {});
  }, []);

  let body;
  let crumb = '';

  const projectMatch = hash.match(/^#\/project\/(\d+)/);
  if (projectMatch) {
    const id = Number(projectMatch[1]);
    body = (
      <CaptureScreen
        projectId={id}
        onBack={() => { window.location.hash = '#/'; }}
      />
    );
    crumb = 'capture';
  } else {
    body = (
      <ProjectPicker
        onPickProject={(p) => { window.location.hash = `#/project/${p.id}`; }}
      />
    );
    crumb = 'projects';
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>PQI Capture</h1>
        <span className="crumb">
          {crumb}
          {version && <> · v{version}</>}
        </span>
      </div>
      {body}
    </div>
  );
}
