import React, { useEffect, useRef, useState } from 'react';
import {
  MapContainer, TileLayer, Marker, CircleMarker, Circle, Pane, useMap,
} from 'react-leaflet';
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

// Centres the map on the given coords. Imperative so the parent can
// control WHEN to recenter (first fix, or when the user taps "my
// location") rather than recentering on every GPS tick — which would
// fight the user trying to pan to a nearby spot.
function MapCommander({ recenterRequest, zoom }) {
  const map = useMap();
  useEffect(() => {
    if (!recenterRequest) return;
    map.setView(recenterRequest, zoom ?? map.getZoom());
  }, [recenterRequest]);
  return null;
}

// Small status component for the live / marker NVDB readout. The
// `road` prop carries:
//   - undefined  → lookup in flight
//   - null       → server returned 404 (no road within search radius)
//   - { error }  → network / NVDB error
//   - object     → success ({ kortform, distance_m, kommune, ... })
function RoadReadout({ road, prefix }) {
  if (road === undefined) {
    return <span className="muted"><strong>{prefix}:</strong> checking NVDB…</span>;
  }
  if (road === null) {
    return <span className="muted"><strong>{prefix}:</strong> no road within 200 m</span>;
  }
  if (road && road.error) {
    return <span style={{ color: 'var(--bad)' }}><strong>{prefix}:</strong> {road.error}</span>;
  }
  return (
    <span>
      <strong>{prefix}:</strong> {road.kortform || road.ref || '—'}
      {road.distance_m != null && (
        <span className="muted">
          {' '}· {road.distance_m < 1
            ? `${(road.distance_m * 100).toFixed(0)} cm`
            : `${road.distance_m.toFixed(0)} m`} off road
        </span>
      )}
    </span>
  );
}

// Haversine distance (m) — used to show the gap between the operator's
// live position and the manually-adjusted capture marker.
function haversineM(a, b) {
  if (!a || !b) return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Main mobile flow:
//   1. Page boots → watchPosition starts streaming GPS continuously. The
//      "live" blue dot + accuracy ring update as the operator moves.
//   2. On the very first fix the capture marker (a draggable pin) drops
//      at the same place. The operator can then drag it to fine-tune.
//   3. "↻ My location" snaps both the marker AND the map view back to
//      the current live position.
//   4. "Save capture" → POST marker's lat/lon → server resolves NVDB
//      road ref + mints 2-digit code → modal shows the code.
//   5. Operator types that code into the PQI device's Beskrivelse1.
export default function CaptureScreen({ projectId, onBack }) {
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);

  // Live state coming from the GPS watcher.
  const [gpsStatus, setGpsStatus] = useState('starting'); // starting | ok | denied | error
  const [gpsMessage, setGpsMessage] = useState('Waiting for GPS…');
  const [livePos, setLivePos] = useState(null);   // [lat, lon] — updates with every fix
  const [accuracy, setAccuracy] = useState(null); // metres
  const [heading, setHeading] = useState(null);   // degrees (if reported)

  // The capture marker the operator can drag. Starts off at the first
  // GPS fix; from then on it's manual until they tap "My location".
  const [marker, setMarker] = useState(null);

  // Live + marker NVDB road context. Each is { kortform, distance_m,
  // kommune, ... } when a road is within range, null when there isn't
  // one within NVDB's 200 m search radius, an { error } object on
  // network failure, or undefined while a lookup is in flight.
  const [liveRoad, setLiveRoad]     = useState(undefined);
  const [markerRoad, setMarkerRoad] = useState(undefined);

  // Pure UI bits.
  const [saving, setSaving] = useState(false);
  const [showCode, setShowCode] = useState(null); // capture result post-save
  const [recenterRequest, setRecenterRequest] = useState(null);
  const [deletingCaptureId, setDeletingCaptureId] = useState(null);

  const reloadProject = () => {
    api.getProject(projectId).then(setProject).catch((e) => setError(e.message));
  };
  useEffect(reloadProject, [projectId]);

  // GPS: continuous watcher. The first fix seeds both the live dot and
  // the draggable marker; subsequent fixes only move the live dot, so
  // the marker doesn't jump out from under the operator's finger.
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGpsStatus('error');
      setGpsMessage('Browser does not expose geolocation. Drag the marker to set position.');
      setMarker([60.0, 11.0]);
      setRecenterRequest([60.0, 11.0]);
      return;
    }
    let seededMarker = false;
    let firstFix = true;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        setLivePos([lat, lon]);
        setAccuracy(pos.coords.accuracy);
        setHeading(typeof pos.coords.heading === 'number' && isFinite(pos.coords.heading) ? pos.coords.heading : null);
        setGpsStatus('ok');
        setGpsMessage(null);
        if (!seededMarker) {
          seededMarker = true;
          setMarker([lat, lon]);
        }
        if (firstFix) {
          firstFix = false;
          setRecenterRequest([lat, lon]);
        }
      },
      (err) => {
        setGpsStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'error');
        setGpsMessage(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied. Drag the marker to set position manually.'
            : `GPS unavailable (${err.message}). Drag the marker to set position manually.`
        );
        if (!seededMarker) {
          seededMarker = true;
          setMarker([60.0, 11.0]);
          setRecenterRequest([60.0, 11.0]);
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
    // clearWatch on unmount so we don't keep the GPS radio hot when the
    // operator navigates back to the project picker.
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // Debounced reverse-NVDB lookup for the live position. We refresh
  // whenever the dot has moved more than a few metres, capped at one
  // request per second, so a stationary phone doesn't spam NVDB and a
  // walking operator gets fresh road context every couple of seconds.
  const liveSeqRef = useRef(0);
  const lastLiveLookupRef = useRef(null); // [lat, lon] of last fired lookup
  useEffect(() => {
    if (!livePos) return;
    // Skip if we already looked up basically this point.
    if (
      lastLiveLookupRef.current &&
      haversineM(lastLiveLookupRef.current, livePos) < 5
    ) return;
    const seq = ++liveSeqRef.current;
    const t = setTimeout(async () => {
      lastLiveLookupRef.current = livePos;
      try {
        const r = await api.roadPositionAt(livePos[0], livePos[1]);
        if (liveSeqRef.current === seq) setLiveRoad(r);
      } catch (e) {
        if (liveSeqRef.current === seq) setLiveRoad({ error: e.message });
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [livePos?.[0], livePos?.[1]]);

  // Same idea for the draggable marker — fires after the user stops
  // moving it for half a second.
  const markerSeqRef = useRef(0);
  useEffect(() => {
    if (!marker) return;
    const seq = ++markerSeqRef.current;
    setMarkerRoad(undefined); // show "checking…" while we wait
    const t = setTimeout(async () => {
      try {
        const r = await api.roadPositionAt(marker[0], marker[1]);
        if (markerSeqRef.current === seq) setMarkerRoad(r);
      } catch (e) {
        if (markerSeqRef.current === seq) setMarkerRoad({ error: e.message });
      }
    }, 500);
    return () => clearTimeout(t);
  }, [marker?.[0], marker?.[1]]);

  const onRecenter = () => {
    if (!livePos) return;
    setMarker(livePos);
    setRecenterRequest([livePos[0] + Math.random() * 1e-9, livePos[1]]); // perturb so React sees a change even if pos identical
  };

  const onDeleteCapture = async (cap) => {
    if (!confirm(`Delete capture ${cap.code} (${cap.kortform || cap.road_ref || 'no road match'})?`)) return;
    setDeletingCaptureId(cap.id);
    setError(null);
    try {
      await api.deleteCapture(cap.id);
      reloadProject();
    } catch (e) {
      setError(e.message);
    } finally {
      setDeletingCaptureId(null);
    }
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

  // Capture-marker drag handler.
  const markerRef = useRef(null);
  const eventHandlers = {
    dragend: () => {
      const m = markerRef.current;
      if (!m) return;
      const ll = m.getLatLng();
      setMarker([ll.lat, ll.lng]);
    },
  };

  // Distance between live position and the capture marker — useful for
  // the operator to know how far they've nudged the pin.
  const markerOffset = haversineM(livePos, marker);

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
          <MapCommander recenterRequest={recenterRequest} zoom={18} />

          {/* Live position: accuracy ring + blue dot, rendered in a
              custom pane with z-index 650 so they sit ABOVE the
              draggable marker pin (markerPane is z-index 600). Without
              this, the pin covers the blue dot whenever the operator
              is standing on the marker — which is the default state
              immediately after the first GPS fix. */}
          <Pane name="livePosition" style={{ zIndex: 650 }}>
            {livePos && (
              <Circle
                center={livePos}
                // Show at least a 6-m halo so the ring is visible even on
                // a sharp fix. Real accuracy still drives the size when
                // it's larger than the floor.
                radius={Math.max(accuracy ?? 0, 6)}
                pane="livePosition"
                pathOptions={{ color: '#2d6cdf', weight: 1, fillColor: '#2d6cdf', fillOpacity: 0.18 }}
              />
            )}
            {livePos && (
              <CircleMarker
                center={livePos}
                radius={9}
                pane="livePosition"
                pathOptions={{ color: 'white', weight: 3, fillColor: '#2d6cdf', fillOpacity: 1 }}
              />
            )}
          </Pane>

          {/* Draggable capture marker (what gets saved). */}
          {marker && (
            <Marker
              position={marker}
              draggable
              eventHandlers={eventHandlers}
              ref={markerRef}
            />
          )}
        </MapContainer>

        {/* My-location floating button (bottom-right of map). */}
        <button
          onClick={onRecenter}
          disabled={!livePos}
          aria-label="Recenter on my location"
          title={livePos ? 'Snap marker to my current position' : 'Waiting for GPS…'}
          style={{
            position: 'absolute', right: 12, bottom: 12, zIndex: 500,
            width: 48, height: 48, minHeight: 48, padding: 0,
            borderRadius: '50%', background: 'var(--panel)', color: 'var(--accent)',
            border: '1px solid var(--border)', boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '1.4rem', fontWeight: 700,
          }}
        >
          ⌖
        </button>
      </div>

      <div className="capture-info">
        <div className="coords">
          {marker
            ? <>
                <strong>Marker:</strong> {marker[0].toFixed(6)}, {marker[1].toFixed(6)}
                {markerOffset != null && markerOffset >= 0.5 && (
                  <span className="muted"> · {markerOffset < 1 ? `${(markerOffset * 100).toFixed(0)} cm` : `${markerOffset.toFixed(1)} m`} from you</span>
                )}
              </>
            : <span className="muted">No position yet</span>}
        </div>
        <div className="road">
          <RoadReadout road={markerRoad} prefix="Marker road" />
        </div>
        <div className="coords" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span style={{
            display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
            background: gpsStatus === 'ok' ? '#2d6cdf' : (gpsStatus === 'starting' ? '#e0731a' : '#c92a2a'),
            boxShadow: '0 0 0 2px white',
          }} />
          {livePos
            ? <>You: {livePos[0].toFixed(6)}, {livePos[1].toFixed(6)}{accuracy != null && <span className="muted"> · ±{Math.round(accuracy)} m</span>}{heading != null && <span className="muted"> · {Math.round(heading)}°</span>}</>
            : <span className="muted">{gpsStatus === 'starting' ? 'acquiring GPS…' : 'GPS off'}</span>}
        </div>
        {livePos && (
          <div className="road">
            <RoadReadout road={liveRoad} prefix="Your road" />
          </div>
        )}
        <div className="capture-actions">
          <button className="ghost" onClick={onRecenter} disabled={!livePos}>
            ⌖ My location
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
                <button
                  className="c-del"
                  aria-label={`Delete capture ${c.code}`}
                  disabled={deletingCaptureId === c.id}
                  onClick={() => onDeleteCapture(c)}
                  title="Delete capture"
                >
                  {deletingCaptureId === c.id ? '…' : '×'}
                </button>
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
