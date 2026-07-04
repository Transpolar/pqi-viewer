import React from 'react';

// Mobile home menu. Three big tiles, one per tool. The order matches
// the field workflow: most operators come here first to take captures
// against a project, the other two are occasional-use tools.
export default function Home() {
  return (
    <div className="page">
      <div className="card">
        <h2 style={{ marginTop: 0, marginBottom: '0.25rem' }}>What are you doing?</h2>
        <p className="muted" style={{ margin: 0 }}>Pick a tool.</p>
      </div>

      <div className="home-tiles">
        <a className="tile" href="#/projects">
          <div className="tile-icon">📍</div>
          <div className="tile-title">Capture</div>
          <div className="tile-sub">
            Take a GPS point against a project. Get a 2-digit code to
            type into the PQI device's Beskrivelse1.
          </div>
        </a>

        <a className="tile" href="#/estimate">
          <div className="tile-icon">∑</div>
          <div className="tile-title">Asphalt estimate</div>
          <div className="tile-sub">
            Pick two points on the map → length × width × thickness →
            tonnes needed for the job.
          </div>
        </a>

        <a className="tile" href="#/area">
          <div className="tile-icon">⬡</div>
          <div className="tile-title">Walk an area</div>
          <div className="tile-sub">
            Walk the perimeter of an irregular shape, the phone collects
            GPS points, the app reports the area in m².
          </div>
        </a>
      </div>
    </div>
  );
}
