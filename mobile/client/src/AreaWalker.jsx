import React, { useEffect, useRef, useState } from 'react';
import {
  MapContainer, TileLayer, Polygon, Polyline, CircleMarker, Circle, Pane, useMap,
} from 'react-leaflet';
import { haversineM, perimeterM, polygonAreaSqM, fmtDistance, fmtArea } from './geo.js';
import SaveToProjectModal from './SaveToProjectModal.jsx';

const KARTVERKET_TOPO = 'https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png';
const KARTVERKET_ATTR = '© <a href="https://www.kartverket.no/">Kartverket</a>';

// Stop-and-go corner mode is the primary flow. Stand at a corner,
// press "Save corner", the phone collects ~N high-quality fixes over
// up to STAY_MS milliseconds and stores the MEDIAN as one point. This
// is dramatically more accurate than walking with auto-log, because
// every jittery fix from a walking trace becomes a corner in the
// polygon and area error compounds.
const TARGET_SAMPLES     = 12;   // aim for this many good fixes per corner
const STAY_MS            = 15000;// give up after 15 s per corner
const CORNER_MAX_ACC_M   = 10;   // reject fixes with reported accuracy > 10 m
const CORNER_MAX_AGE_MS  = 5000; // reject fixes older than this (browser cached)

// Optional secondary auto-log mode (walk the perimeter, phone drops
// points every few metres). Less accurate but useful for very large
// loose shapes where standing at every corner is impractical.
const AUTO_MIN_SPACING_M = 2;
const AUTO_MAX_ACCURACY  = 30;

function FollowMe({ to }) {
  const map = useMap();
  useEffect(() => {
    if (to) map.setView(to, Math.max(map.getZoom(), 18));
  }, [to?.[0], to?.[1]]);
  return null;
}

// Median helper — resistant to a single outlier fix in the sampling
// buffer. Works elementwise on [lat, lon].
function medianOfPoints(points) {
  if (!points || points.length === 0) return null;
  const lats = points.map((p) => p[0]).sort((a, b) => a - b);
  const lons = points.map((p) => p[1]).sort((a, b) => a - b);
  const mid = Math.floor(points.length / 2);
  const lat = points.length % 2 === 0 ? (lats[mid - 1] + lats[mid]) / 2 : lats[mid];
  const lon = points.length % 2 === 0 ? (lons[mid - 1] + lons[mid]) / 2 : lons[mid];
  return [lat, lon];
}
// Spread of a point cluster around its median in metres — used to
// report per-corner uncertainty to the user.
function spreadM(points, center) {
  if (!points || points.length === 0 || !center) return null;
  const dists = points.map((p) => haversineM(p, center)).filter((d) => d != null);
  if (dists.length === 0) return null;
  return dists.reduce((a, b) => a + b, 0) / dists.length;
}

export default function AreaWalker({ onBack }) {
  const [livePos, setLivePos]   = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [gpsStatus, setGpsStatus]   = useState('starting');
  const [gpsMessage, setGpsMessage] = useState('Waiting for GPS…');
  const [autoCenter, setAutoCenter] = useState(null);

  const [phase, setPhase]     = useState('idle');    // idle | measuring | sampling | finished
  const [corners, setCorners] = useState([]);         // averaged corner points [{ lat, lon, samples, spread_m }]
  const [autoMode, setAutoMode] = useState(false);    // secondary walk-and-log mode
  const [autoPoints, setAutoPoints] = useState([]);   // raw points captured in auto mode
  const [error, setError] = useState(null);

  // Sampling state during a corner capture.
  const [sampling, setSampling] = useState(null); // { buf: [[lat,lon]], startedAt, deadline }
  const samplingRef = useRef(null);
  useEffect(() => { samplingRef.current = sampling; }, [sampling]);

  // Auto-log mode ref (so watchPosition can see current state).
  const autoRef       = useRef({ enabled: false, points: [] });
  useEffect(() => { autoRef.current.enabled = (phase === 'measuring' && autoMode); }, [phase, autoMode]);
  useEffect(() => { autoRef.current.points = autoPoints; }, [autoPoints]);

  // Save-to-project modal.
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [savedNote, setSavedNote] = useState(null);

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGpsStatus('error');
      setGpsMessage('Browser does not expose geolocation.');
      return;
    }
    let firstFix = true;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        const acc = pos.coords.accuracy;
        setLivePos([lat, lon]);
        setAccuracy(acc);
        setGpsStatus('ok'); setGpsMessage(null);
        if (firstFix) { firstFix = false; setAutoCenter([lat, lon]); }

        const now = Date.now();
        const fresh = now - (pos.timestamp || now) < CORNER_MAX_AGE_MS;

        // Corner sampling: append qualified fixes to the current
        // sampling buffer.
        const s = samplingRef.current;
        if (s) {
          const qualityOk = acc != null && acc > 0 && acc <= CORNER_MAX_ACC_M && fresh;
          if (qualityOk) {
            setSampling((prev) => prev ? { ...prev, buf: [...prev.buf, [lat, lon]] } : prev);
          }
        }

        // Auto-log mode: drop points every ~N metres.
        if (autoRef.current.enabled) {
          if (acc != null && acc > AUTO_MAX_ACCURACY) return;
          const last = autoRef.current.points[autoRef.current.points.length - 1];
          if (last) {
            const d = haversineM(last, [lat, lon]);
            if (d != null && d < AUTO_MIN_SPACING_M) return;
          }
          setAutoPoints((prev) => [...prev, [lat, lon]]);
        }
      },
      (err) => {
        setGpsStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'error');
        setGpsMessage(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied — walking needs GPS.'
            : `GPS unavailable (${err.message}).`
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // Automatically finalize a corner capture when it hits TARGET_SAMPLES
  // or the deadline elapses.
  useEffect(() => {
    if (!sampling) return;
    if (sampling.buf.length >= TARGET_SAMPLES) {
      finalizeCornerSample();
      return;
    }
    const remaining = sampling.deadline - Date.now();
    if (remaining <= 0) {
      finalizeCornerSample();
      return;
    }
    const t = setTimeout(finalizeCornerSample, remaining);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampling]);

  const finalizeCornerSample = () => {
    const s = samplingRef.current;
    if (!s) return;
    const buf = s.buf;
    if (buf.length === 0) {
      setError('No good fixes captured — try holding still with a clearer sky view.');
      setSampling(null);
      return;
    }
    const median = medianOfPoints(buf);
    const spread = spreadM(buf, median);
    setCorners((prev) => [...prev, {
      lat: median[0],
      lon: median[1],
      samples: buf.length,
      spread_m: spread,
    }]);
    setSampling(null);
    setError(null);
  };

  // Actions.
  const startMeasuring = () => { setPhase('measuring'); setError(null); };
  const captureCorner = () => {
    if (!livePos) return;
    setSampling({
      buf: [],
      startedAt: Date.now(),
      deadline: Date.now() + STAY_MS,
    });
  };
  const undoCorner = () => setCorners((c) => c.slice(0, -1));
  const stopAndCalculate = () => setPhase('finished');
  const reset = () => {
    setPhase('idle');
    setCorners([]);
    setAutoPoints([]);
    setSampling(null);
    setError(null);
    setSavedNote(null);
  };

  // Point set that drives the polygon. Corner mode uses the averaged
  // corners; auto mode falls back to raw auto-log points.
  const points = corners.length
    ? corners.map((c) => [c.lat, c.lon])
    : (autoMode ? autoPoints : []);

  const perimeter = perimeterM(points);
  const closedSide = points.length >= 2 ? haversineM(points[points.length - 1], points[0]) : 0;
  const totalLoop = perimeter + closedSide;
  const area = polygonAreaSqM(points);

  return (
    <div className="page no-pad capture-screen">
      <div style={{
        padding: '0.5rem 1rem', background: 'var(--panel)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <strong>Walk an area</strong>
        <button className="ghost" onClick={onBack} style={{ padding: '0.35rem 0.7rem', minHeight: 'auto', fontSize: '0.85rem' }}>
          ← Home
        </button>
      </div>

      {gpsMessage && (
        <div className={'gps-banner' + (gpsStatus === 'denied' || gpsStatus === 'error' ? ' error' : '')}>
          {gpsMessage}
        </div>
      )}
      {error && (
        <div className="gps-banner error">{error}</div>
      )}
      {phase === 'idle' && !gpsMessage && (
        <div className="gps-banner" style={{ background: '#eef4ff', color: '#1f3a8a', borderColor: '#c7d8ff' }}>
          Stand at each corner and tap <strong>Save corner</strong> — the phone averages a
          burst of GPS fixes for accuracy. Walk to the next corner, repeat, then <strong>Stop &amp; calculate</strong>.
        </div>
      )}

      <div className="capture-map">
        <MapContainer
          center={livePos || [64.0, 12.0]}
          zoom={livePos ? 18 : 5}
          maxZoom={19}
          scrollWheelZoom
        >
          <TileLayer url={KARTVERKET_TOPO} attribution={KARTVERKET_ATTR} maxZoom={18} />
          <FollowMe to={autoCenter} />

          {points.length >= 3 && (
            <Polygon
              positions={points}
              pathOptions={{ color: '#2d6cdf', weight: 2, fillColor: '#2d6cdf', fillOpacity: 0.18 }}
            />
          )}
          {points.length === 2 && (
            <Polyline positions={points} pathOptions={{ color: '#2d6cdf', weight: 3 }} />
          )}
          {points.map((p, i) => (
            <CircleMarker
              key={i}
              center={p}
              radius={5}
              pathOptions={{ color: 'white', weight: 2, fillColor: '#2d6cdf', fillOpacity: 1 }}
            />
          ))}

          <Pane name="livePosition" style={{ zIndex: 650 }}>
            {livePos && accuracy != null && (
              <Circle center={livePos} radius={Math.max(accuracy, 6)} pane="livePosition"
                      pathOptions={{ color: '#2d6cdf', weight: 1, fillColor: '#2d6cdf', fillOpacity: 0.18 }} />
            )}
            {livePos && (
              <CircleMarker center={livePos} radius={9} pane="livePosition"
                            pathOptions={{ color: 'white', weight: 3, fillColor: '#c92a2a', fillOpacity: 1 }} />
            )}
          </Pane>
        </MapContainer>
      </div>

      <div className="capture-info">
        {phase === 'finished' && (
          <div style={{
            background: '#eafff0', border: '1px solid #b9e3c5', borderRadius: 10,
            padding: '0.85rem 1rem',
          }}>
            <div style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#2f6d3d' }}>
              Result
            </div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700 }}>
              {points.length >= 3 ? fmtArea(area) : <span style={{ color: 'var(--bad)' }}>need ≥ 3 corners</span>}
            </div>
            <div className="muted" style={{ fontSize: '0.85rem' }}>
              Perimeter (auto-closed) {fmtDistance(totalLoop)} · {corners.length || autoPoints.length} corner{(corners.length || autoPoints.length) === 1 ? '' : 's'}
              {points.length >= 2 && <> · closing leg {fmtDistance(closedSide)}</>}
            </div>
            {corners.length > 0 && (
              <div className="muted" style={{ fontSize: '0.78rem', marginTop: '0.35rem' }}>
                Corner spread: avg {(corners.reduce((a, c) => a + (c.spread_m || 0), 0) / corners.length).toFixed(1)} m
                (fewer m = tighter fixes = more accurate area)
              </div>
            )}
          </div>
        )}

        {phase === 'measuring' && (
          <div className="road">
            <strong>{corners.length} corner{corners.length === 1 ? '' : 's'}</strong>{' '}
            {sampling && (
              <span style={{ color: 'var(--accent)' }}>
                · sampling {sampling.buf.length}/{TARGET_SAMPLES} — hold still
              </span>
            )}
            {!sampling && corners.length >= 3 && (
              <span className="muted"> · area so far {fmtArea(area)}</span>
            )}
          </div>
        )}

        <div className="capture-actions">
          {phase === 'idle' && (
            <button onClick={startMeasuring} disabled={!livePos} className="huge">
              ▶ Start measuring
            </button>
          )}
          {phase === 'measuring' && (
            <>
              <button
                onClick={captureCorner}
                disabled={!livePos || !!sampling || autoMode}
                className="huge"
              >
                {sampling
                  ? `Sampling ${sampling.buf.length}/${TARGET_SAMPLES}…`
                  : '📍 Save corner'}
              </button>
              <button onClick={stopAndCalculate} className="huge danger" disabled={!!sampling}>
                ■ Stop &amp; calculate
              </button>
            </>
          )}
          {phase === 'finished' && (
            <button onClick={reset} className="huge">
              ↻ Start over
            </button>
          )}
        </div>

        {phase === 'measuring' && (
          <div className="capture-actions">
            <button className="ghost" onClick={undoCorner} disabled={!corners.length || !!sampling}>↶ Undo corner</button>
            <label className="ghost" style={{
              display: 'flex', alignItems: 'center', gap: '0.35rem',
              padding: '0.5rem 0.75rem', border: '1px solid var(--border)',
              borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem',
            }}>
              <input
                type="checkbox"
                checked={autoMode}
                onChange={(e) => { setAutoMode(e.target.checked); if (e.target.checked) setCorners([]); else setAutoPoints([]); }}
                disabled={!!sampling}
              />
              auto-log (walk mode)
            </label>
          </div>
        )}

        {phase === 'finished' && points.length >= 3 && (
          <div className="capture-actions">
            <button className="ghost" onClick={() => setShowSaveModal(true)} style={{ flex: 1 }}>
              💾 Save to project
            </button>
          </div>
        )}
        {savedNote && (
          <div style={{
            background: '#eafff0', border: '1px solid #b9e3c5', borderRadius: 8,
            padding: '0.5rem 0.75rem', fontSize: '0.85rem',
          }}>
            Saved to project as <strong>{savedNote.name || 'unnamed area'}</strong>.
          </div>
        )}

        {phase === 'idle' && (
          <div className="muted" style={{ fontSize: '0.78rem' }}>
            Corner mode collects {TARGET_SAMPLES} qualified fixes per corner (up to {STAY_MS/1000}s,
            rejecting fixes with ± &gt; {CORNER_MAX_ACC_M} m or older than {CORNER_MAX_AGE_MS/1000}s),
            then stores the median as one point. That's typically {'±'}2–5 m per corner on a phone,
            vs 5–15 m with continuous auto-logging. Turn on "auto-log" during measuring if you
            need to trace a very large loose shape without stopping.
          </div>
        )}
      </div>

      {showSaveModal && points.length >= 3 && (
        <SaveToProjectModal
          type="area"
          name={`${fmtArea(area)} area`}
          data={{
            area_m2: area,
            perimeter_m: perimeter,
            closing_leg_m: closedSide,
            total_loop_m: totalLoop,
            corner_count: corners.length || autoPoints.length,
            mode: autoMode ? 'auto-log' : 'corner-median',
            corners: corners.length
              ? corners.map((c) => ({ lat: c.lat, lon: c.lon, samples: c.samples, spread_m: c.spread_m }))
              : autoPoints.map(([lat, lon]) => ({ lat, lon })),
            avg_corner_spread_m: corners.length
              ? corners.reduce((a, c) => a + (c.spread_m || 0), 0) / corners.length
              : null,
            computed_at: new Date().toISOString(),
          }}
          onSaved={(m) => setSavedNote(m)}
          onClose={() => setShowSaveModal(false)}
        />
      )}
    </div>
  );
}
