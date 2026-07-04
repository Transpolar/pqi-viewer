import React, { useEffect, useState } from 'react';
import Home from './Home.jsx';
import ProjectPicker from './ProjectPicker.jsx';
import CaptureScreen from './CaptureScreen.jsx';
import EstimateScreen from './EstimateScreen.jsx';
import AreaWalker from './AreaWalker.jsx';

// Hash-based router (works offline-friendly, no backend catch-all
// beyond /index.html). Routes:
//   #/                      → Home menu
//   #/projects              → Project picker
//   #/project/:id           → Capture screen
//   #/estimate              → Asphalt estimate calculator
//   #/area                  → Walk-the-perimeter area calculator
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
    body = (
      <CaptureScreen
        projectId={Number(projectMatch[1])}
        onBack={() => { window.location.hash = '#/projects'; }}
      />
    );
    crumb = 'capture';
  } else if (hash.startsWith('#/projects')) {
    body = <ProjectPicker onPickProject={(p) => { window.location.hash = `#/project/${p.id}`; }} />;
    crumb = 'projects';
  } else if (hash.startsWith('#/estimate')) {
    body = <EstimateScreen onBack={() => { window.location.hash = '#/'; }} />;
    crumb = 'estimate';
  } else if (hash.startsWith('#/area')) {
    body = <AreaWalker onBack={() => { window.location.hash = '#/'; }} />;
    crumb = 'area';
  } else {
    body = <Home />;
    crumb = 'home';
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>
          {crumb === 'home'
            ? <span>PQI Capture</span>
            : <a href="#/" style={{ textDecoration: 'none', color: 'inherit' }}>← PQI Capture</a>}
        </h1>
        <span className="crumb">
          {crumb}
          {version && <> · v{version}</>}
        </span>
      </div>
      {body}
    </div>
  );
}
