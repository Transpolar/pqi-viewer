import React, { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import { api } from './api.js';

// Re-use Leaflet's default marker images from the CDN so we don't need to
// bundle them.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const KARTVERKET_TOPO = 'https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png';
const KARTVERKET_ATTR = '© <a href="https://www.kartverket.no/">Kartverket</a>';

// When `coords` changes, recenter the map. Used so the very first GPS
// fix moves us from Norway-overview to the actual point.
function Recenter({ coords, zoom }) {
  const map = useMap();
  useEffect(() => {
    if (coords) map.setView(coords, zoom ?? map.getZoom());
  }, [coords?.[0], coords?.[1]]);
  return null;
}

// Main mobile flow:
//   1. Page boots → start watching geolocation (one-shot on first read).
//   2. Show the device GPS as a draggable marker on the Kartverket topo.
//   3. Operator can pan/drag the marker to nudge the point onto the
//      actual measurement spot.
//   4. Tap "Save capture" → POST lat/lon → server resolves NVDB road
//      ref + mints 2-digit code → modal displays the code.
//   5. Operator types that code into the PQI device's Beskrivelse1.
export default function CaptureScreen({ projectId, onBack }) {
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);

  const [gpsStatus, setGpsStatus] = useState('starting'); // starting | ok | denied | error
  const [gpsMessage, setGpsMessage] = useState('Waiting for GPS…');
  const [marker, setMarker] = useState(null); // [lat, lon] — adjustable
  const [accuracy, setAccuracy] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showCode, setShowCode] = useState(null); // capture object once saved

  const reloadProject = () => {
    api.getProject(projectId).then(setProject).catch((e) => setError(e.message));
  };
  useEffect(reloadProject, [projectId]);

  // Geolocation: start a one-shot lookup. The operator can then drag the
  // marker to fine-tune. We don't watchPosition continuously because the
  // marker is meant to reflect operator intent, not the phone's GPS noise.
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGpsStatus('error');
      setGpsMessage('Browser does not expose geolocation. Drag the marker to set position.');
      // Default to a point in Norway so the map at least loads usefully.
      setMarker([60.0, 11.0]);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsStatus('ok');
        setGpsMessage(null);
        setMarker([pos.coords.latitude, pos.coords.longitude]);
        setAccuracy(pos.coords.accuracy);
      },
      (err) => {
        setGpsStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'error');
        setGpsMessage(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied. Drag the marker to set position manually.'
            : `GPS unavailable (${err.message}). Drag the marker to set position manually.`
        );
        // Fall back to a Norway-centred view.
        setMarker([60.0, 11.0]);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }, []);

  const onRefetchGps = () => {
    if (!('geolocation' in navigator)) return;
    setGpsStatus('starting');
    setGpsMessage('Re-reading GPS…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsStatus('ok');
        setGpsMessage(null);
        setMarker([pos.coords.latitude, pos.coords.longitude]);
        setAccuracy(pos.coords.accuracy);
      },
      (err) => {
        setGpsStatus('error');
        setGpsMessage(`GPS unavailable (${err.message}).`);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };

  const onSave = async () => {
    if (!marker) return;
    setSaving(true);
    setError(null);
    try {
      const cap = await api.postCapture(projectId, { lat: marker[0], lon: marker[1] });
      setShowCode(cap);
      reloadProject();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const closeModal = () => setShowCode(null);

  // Drag handler — captured via useRef so we don't recreate the marker
  // every render and lose the drag state.
  const markerRef = useRef(null);
  const eventHandlers = {
    dragend: () => {
      const m = markerRef.current;
      if (!m) return;
      const ll = m.getLatLng();
      setMarker([ll.lat, ll.lng]);
    },
  };

  return (
    <div className="page no-pad capture-screen">
      {project && (
        <div style={{
          padding: '0.5rem 1rem', background: 'var(--panel)',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <strong>{project.name}</strong>
            {' '}<span className="muted">· {project.captures.length} capture{project.captures.length === 1 ? '' : 's'}</span>
          </div>
          <button className="ghost" onClick={onBack} style={{ padding: '0.35rem 0.7rem', minHeight: 'auto', fontSize: '0.85rem' }}>
            ← Projects
          </button>
        </div>
      )}

      {gpsMessage && (
        <div className={'gps-banner' + (gpsStatus === 'denied' || gpsStatus === 'error' ? ' error' : '')}>
          {gpsMessage}
        </div>
      )}
      {error && <div className="gps-banner error">{error}</div>}

      <div className="capture-map">
        <MapContainer
          center={marker || [60.0, 11.0]}
          zoom={marker ? 17 : 5}
          maxZoom={19}
          scrollWheelZoom
        >
          <TileLayer url={KARTVERKET_TOPO} attribution={KARTVERKET_ATTR} maxZoom={18} />
          <Recenter coords={marker} zoom={17} />
          {marker && (
            <Marker
              position={marker}
              draggable
              eventHandlers={eventHandlers}
              ref={markerRef}
            />
          )}
        </MapContainer>
      </div>

      <div className="capture-info">
        <div className="coords">
          {marker
            ? <>{marker[0].toFixed(6)}, {marker[1].toFixed(6)}{accuracy != null && gpsStatus === 'ok' && <span className="muted"> · ±{Math.round(accuracy)} m</span>}</>
            : <span className="muted">No position yet</span>}
        </div>
        <div className="capture-actions">
          <button className="ghost" onClick={onRefetchGps} disabled={gpsStatus === 'starting'}>
            ↻ GPS
          </button>
          <button onClick={onSave} disabled={!marker || saving} className="huge">
            {saving ? 'Saving…' : 'Save capture'}
          </button>
        </div>

        {project && project.captures.length > 0 && (
          <div className="captures-list">
            {project.captures.slice().reverse().map((c) => (
              <div key={c.id} className="cap">
                <span className="c-code">{c.code}</span>
                <span className="c-road">{c.kortform || c.road_ref || 'no road match'}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCode && (
        <div className="modal-backdrop" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="label">Type this into the device's Beskrivelse1</div>
            <div className="code">{showCode.code}</div>
            <div className="road">
              {showCode.kortform || showCode.road_ref || (
                <span className="muted">no NVDB road match — capture saved without road context</span>
              )}
            </div>
            <button onClick={closeModal} className="huge">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
