import React, { useEffect, useRef, useState } from 'react';
import {
  MapContainer, TileLayer, Marker, Polyline, CircleMarker, Circle, Pane, useMapEvents, useMap,
} from 'react-leaflet';
import L from 'leaflet';
import { api } from './api.js';
import { haversineM, fmtDistance } from './geo.js';
import SaveToProjectModal from './SaveToProjectModal.jsx';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const KARTVERKET_TOPO = 'https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png';
const KARTVERKET_ATTR = '© <a href="https://www.kartverket.no/">Kartverket</a>';

// Standard Norwegian asphalt mixes with typical compacted densities
// (kg/m³). These are sensible defaults — the operator can override the
// density per job if their plant runs different recipes.
const MIXES = [
  { id: 'Ab',   label: 'Ab (asfaltbetong)',          density: 2400 },
  { id: 'Agb',  label: 'Agb (grovbet. asfaltbet.)',  density: 2420 },
  { id: 'Ska',  label: 'Ska (skjelettasfalt)',       density: 2400 },
  { id: 'Ma',   label: 'Ma (mykasfalt)',             density: 2350 },
  { id: 'Pmb',  label: 'Pmb (polymermodifisert)',    density: 2420 },
  { id: 'custom', label: 'Custom density…',          density: null },
];

function ClickHandler({ onPick }) {
  useMapEvents({ click: (e) => onPick([e.latlng.lat, e.latlng.lng]) });
  return null;
}
function MapJumpTo({ to, zoom }) {
  const map = useMap();
  useEffect(() => {
    if (to) map.setView(to, zoom ?? Math.max(map.getZoom(), 14));
  }, [to?.[0], to?.[1]]);
  return null;
}

export default function EstimateScreen({ onBack }) {
  const [start, setStart]       = useState(null); // [lat, lon]
  const [end, setEnd]           = useState(null);
  const [startRoad, setStartRoad] = useState(undefined);
  const [endRoad, setEndRoad]   = useState(undefined);

  // Width state. `widthSource` indicates whether the value currently
  // shown was hand-typed by the operator or auto-filled from NVDB —
  // used to keep auto-fills from silently overwriting an operator's
  // adjustment.
  const [widthM, setWidthM]            = useState('6.5');
  const [widthSource, setWidthSource]  = useState('default');  // 'default' | 'auto' | 'manual'
  const [widthDetail, setWidthDetail]  = useState(null);       // {samples, source} when auto

  const [thicknessMm, setThicknessMm] = useState('50');
  const [mixId, setMixId]             = useState('Ab');
  const [customDensity, setCustomDensity] = useState('2400');
  const [wastagePct, setWastagePct]   = useState('4');

  // Live GPS so the operator can drop start/end pins at their current
  // position (e.g. driving along the road they're about to pave). The
  // first fix also recenters the map.
  const [livePos, setLivePos]   = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [gpsStatus, setGpsStatus]   = useState('starting'); // starting | ok | denied | error
  const [gpsMessage, setGpsMessage] = useState(null);
  const [autoCenter, setAutoCenter] = useState(null); // [lat,lon] when we want the map to follow

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
        setLivePos([lat, lon]);
        setAccuracy(pos.coords.accuracy);
        setGpsStatus('ok'); setGpsMessage(null);
        if (firstFix) {
          firstFix = false;
          setAutoCenter([lat, lon]);
        }
      },
      (err) => {
        setGpsStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'error');
        setGpsMessage(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied — Start here / End here disabled. Tap the map instead.'
            : `GPS unavailable (${err.message}).`
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // Reverse-NVDB road context for each pinned endpoint (informational).
  useEffect(() => {
    if (!start) return;
    setStartRoad(undefined);
    api.roadPositionAt(start[0], start[1])
      .then(setStartRoad)
      .catch((e) => setStartRoad({ error: e.message }));
  }, [start?.[0], start?.[1]]);
  useEffect(() => {
    if (!end) return;
    setEndRoad(undefined);
    api.roadPositionAt(end[0], end[1])
      .then(setEndRoad)
      .catch((e) => setEndRoad({ error: e.message }));
  }, [end?.[0], end?.[1]]);

  // Road-following distance between the two pins. Server queries NVDB
  // and returns { straight_m, road_m } — road_m is populated when both
  // points land on the same delstrekning (asked NVDB for its meter
  // values and diffed them); otherwise it's null and we fall back to
  // haversine for the tonnage calc.
  const [roadDist, setRoadDist] = useState(null); // { straight_m, road_m, sameSegment, reason }
  useEffect(() => {
    if (!start || !end) { setRoadDist(null); return; }
    let cancelled = false;
    setRoadDist({ status: 'looking' });
    api.roadDistance(start[0], start[1], end[0], end[1])
      .then((r) => { if (!cancelled) setRoadDist({ status: 'ok', ...r }); })
      .catch((e) => { if (!cancelled) setRoadDist({ status: 'error', error: e.message }); });
    return () => { cancelled = true; };
  }, [start?.[0], start?.[1], end?.[0], end?.[1]]);

  // Auto-fill width from NVDB whenever the resolved road refs for
  // start/end land. Reports both successes (width found) and "tried
  // but found nothing" so the operator knows the lookup actually ran.
  // Once the operator types a value manually, widthSource flips to
  // 'manual' and the auto-fill stops overwriting them.
  useEffect(() => {
    if (widthSource === 'manual') return;
    const refs = [];
    if (startRoad && !startRoad.error && startRoad.kortform) refs.push(startRoad.kortform);
    if (endRoad   && !endRoad.error   && endRoad.kortform)   refs.push(endRoad.kortform);
    if (refs.length === 0) return;

    let cancelled = false;
    setWidthDetail({ status: 'looking', refs });
    Promise.all(refs.map((r) => api.roadWidthForRef(r).catch((e) => ({ error: e.message }))))
      .then((results) => {
        if (cancelled) return;
        const widths = results
          .filter((r) => r && typeof r.width_m === 'number' && isFinite(r.width_m) && r.width_m > 0)
          .map((r) => r.width_m);
        if (widths.length === 0) {
          // Helpful diagnostic: did any of the lookups error out, or
          // did NVDB just have no width data for these segments?
          const errs = results.filter((r) => r && r.error).map((r) => r.error);
          setWidthDetail({
            status: 'empty',
            refs,
            errors: errs,
          });
          return;
        }
        const avg = widths.reduce((a, b) => a + b, 0) / widths.length;
        const source = results.find((r) => r && r.source)?.source || 'NVDB';
        setWidthM(avg.toFixed(2));
        setWidthSource('auto');
        setWidthDetail({ status: 'ok', samples: widths.length, source, refs });
      });
    return () => { cancelled = true; };
  }, [startRoad, endRoad, widthSource]);

  const straightLengthM = (start && end) ? haversineM(start, end) : null;
  // Prefer NVDB road-follow distance when we have it, straight-line
  // otherwise. Whichever we use drives the tonnage calc.
  const lengthM = roadDist?.status === 'ok' && roadDist.road_m != null
    ? roadDist.road_m
    : straightLengthM;
  const usingRoadLength = roadDist?.status === 'ok' && roadDist.road_m != null;

  // Estimate: tonnes = L × W × T × ρ / 1000 × (1 + wastage).
  const w = parseFloat(widthM);
  const t = parseFloat(thicknessMm) / 1000;
  const mix = MIXES.find((m) => m.id === mixId) || MIXES[0];
  const density = mix.id === 'custom' ? parseFloat(customDensity) : mix.density;
  const wastageFrac = (parseFloat(wastagePct) || 0) / 100;
  let tonnes = null, m3 = null;
  if (lengthM != null && isFinite(w) && isFinite(t) && isFinite(density) && t > 0 && w > 0 && density > 0) {
    m3 = lengthM * w * t;
    tonnes = m3 * density / 1000 * (1 + wastageFrac);
  }

  const [showSaveModal, setShowSaveModal] = useState(false);
  const [savedNote, setSavedNote]         = useState(null);

  // Map-tap workflow: first tap → start, second tap → end, third
  // resets and treats itself as a new start.
  const onPick = (latlng) => {
    if (!start) { setStart(latlng); return; }
    if (!end)   { setEnd(latlng); return; }
    setStart(latlng); setEnd(null);
    setStartRoad(undefined); setEndRoad(undefined);
  };

  // Live-GPS workflow: pin to current position.
  const placeStartHere = () => {
    if (!livePos) return;
    setStart(livePos.slice());
    setEnd(null);
    setStartRoad(undefined); setEndRoad(undefined);
  };
  const placeEndHere = () => {
    if (!livePos) return;
    if (!start) setStart(livePos.slice());
    else setEnd(livePos.slice());
  };

  const reset = () => {
    setStart(null); setEnd(null);
    setStartRoad(undefined); setEndRoad(undefined);
    setWidthM('6.5'); setWidthSource('default'); setWidthDetail(null);
  };

  const startRef = useRef(null);
  const endRef   = useRef(null);

  // Used to disable Start here right after End is placed (would clobber
  // the segment by accident).
  const segmentReady = !!(start && end);

  return (
    <div className="page no-pad capture-screen">
      <div style={{
        padding: '0.5rem 1rem', background: 'var(--panel)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <strong>Asphalt estimate</strong>
        <button className="ghost" onClick={onBack} style={{ padding: '0.35rem 0.7rem', minHeight: 'auto', fontSize: '0.85rem' }}>
          ← Home
        </button>
      </div>

      {gpsMessage && (
        <div className={'gps-banner' + (gpsStatus === 'denied' || gpsStatus === 'error' ? ' error' : '')}>
          {gpsMessage}
        </div>
      )}
      <div className="gps-banner" style={{ background: '#eef4ff', color: '#1f3a8a', borderColor: '#c7d8ff' }}>
        Use <strong>Start here</strong> / <strong>End here</strong> while driving the segment, or tap the map to drop pins manually.
      </div>

      <div className="capture-map">
        <MapContainer
          center={livePos || [64.0, 12.0]}
          zoom={livePos ? 16 : 5}
          maxZoom={19}
          scrollWheelZoom
        >
          <TileLayer url={KARTVERKET_TOPO} attribution={KARTVERKET_ATTR} maxZoom={18} />
          <ClickHandler onPick={onPick} />
          <MapJumpTo to={autoCenter} zoom={16} />
          <MapJumpTo to={end || start} />

          {/* Live position dot in a custom pane so it draws above the
              marker pins when overlapping (same trick the capture
              screen uses). */}
          <Pane name="livePosition" style={{ zIndex: 650 }}>
            {livePos && accuracy != null && (
              <Circle center={livePos} radius={Math.max(accuracy, 6)} pane="livePosition"
                      pathOptions={{ color: '#2d6cdf', weight: 1, fillColor: '#2d6cdf', fillOpacity: 0.18 }} />
            )}
            {livePos && (
              <CircleMarker center={livePos} radius={9} pane="livePosition"
                            pathOptions={{ color: 'white', weight: 3, fillColor: '#2d6cdf', fillOpacity: 1 }} />
            )}
          </Pane>

          {start && (
            <Marker
              position={start}
              draggable
              ref={startRef}
              eventHandlers={{
                dragend: () => {
                  const ll = startRef.current?.getLatLng();
                  if (ll) setStart([ll.lat, ll.lng]);
                },
              }}
            />
          )}
          {end && (
            <Marker
              position={end}
              draggable
              ref={endRef}
              eventHandlers={{
                dragend: () => {
                  const ll = endRef.current?.getLatLng();
                  if (ll) setEnd([ll.lat, ll.lng]);
                },
              }}
            />
          )}
          {start && end && (
            <Polyline
              positions={[start, end]}
              pathOptions={{ color: '#2d6cdf', weight: 4, opacity: 0.85 }}
            />
          )}
        </MapContainer>
      </div>

      <div className="capture-info">
        {/* Live-GPS shortcut buttons, prominent at the top. */}
        <div className="capture-actions">
          <button onClick={placeStartHere} disabled={!livePos || segmentReady} className="huge">
            📍 Start here
          </button>
          <button onClick={placeEndHere} disabled={!livePos} className="huge">
            🏁 {start ? 'End here' : 'Start here'}
          </button>
        </div>

        <div className="road">
          <strong>Start:</strong>{' '}
          {start ? <RoadHint road={startRoad} /> : <span className="muted">tap "Start here" or the map</span>}
        </div>
        <div className="road">
          <strong>End:</strong>{' '}
          {end ? <RoadHint road={endRoad} /> : <span className="muted">tap "End here" or the map</span>}
        </div>
        <div className="road">
          <strong>Length:</strong>{' '}
          {lengthM == null && <span className="muted">—</span>}
          {roadDist?.status === 'looking' && <span className="muted">checking NVDB…</span>}
          {usingRoadLength && (
            <>
              <span style={{ color: 'var(--good)' }}>{fmtDistance(roadDist.road_m)}</span>{' '}
              <span className="muted">along road (NVDB)</span>
              {' · '}
              <span className="muted">straight line {fmtDistance(straightLengthM)}</span>
            </>
          )}
          {!usingRoadLength && lengthM != null && (
            <>
              <span>{fmtDistance(lengthM)}</span>{' '}
              <span className="muted">
                (straight line
                {roadDist?.status === 'ok' && roadDist.reason && ` — ${roadDist.reason}`}
                )
              </span>
            </>
          )}
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem',
        }}>
          <label style={{ gridColumn: '1 / -1' }}>
            <span className="muted" style={{ fontSize: '0.75rem' }}>
              Width (m)
              {widthDetail?.status === 'looking' && (
                <> · <span className="muted">checking NVDB…</span></>
              )}
              {widthSource === 'auto' && widthDetail?.status === 'ok' && (
                <> · <span style={{ color: 'var(--accent)' }}>auto from NVDB ({widthDetail.source}{widthDetail.samples > 1 ? `, avg of ${widthDetail.samples}` : ''})</span></>
              )}
              {widthSource !== 'manual' && widthDetail?.status === 'empty' && (
                <> · <span style={{ color: 'var(--warn)' }}>
                  NVDB has no width data here
                  {widthDetail.errors?.length ? ` (${widthDetail.errors[0]})` : ''} — using default
                </span></>
              )}
              {widthSource === 'manual' && <> · <span style={{ color: 'var(--warn)' }}>edited</span></>}
            </span>
            <input
              type="number" inputMode="decimal" step="0.1" min="0"
              value={widthM}
              onChange={(e) => { setWidthM(e.target.value); setWidthSource('manual'); }}
            />
          </label>
          <label>
            <span className="muted" style={{ fontSize: '0.75rem' }}>Thickness (mm)</span>
            <input type="number" inputMode="numeric" step="1" min="0"
                   value={thicknessMm} onChange={(e) => setThicknessMm(e.target.value)} />
          </label>
          <label>
            <span className="muted" style={{ fontSize: '0.75rem' }}>Wastage (%)</span>
            <input type="number" inputMode="numeric" step="0.5" min="0"
                   value={wastagePct} onChange={(e) => setWastagePct(e.target.value)} />
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            <span className="muted" style={{ fontSize: '0.75rem' }}>Mix</span>
            <select value={mixId} onChange={(e) => setMixId(e.target.value)}>
              {MIXES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}{m.density != null ? ` · ${m.density} kg/m³` : ''}
                </option>
              ))}
            </select>
          </label>
          {mixId === 'custom' && (
            <label style={{ gridColumn: '1 / -1' }}>
              <span className="muted" style={{ fontSize: '0.75rem' }}>Custom density (kg/m³)</span>
              <input type="number" inputMode="numeric" step="1" min="0"
                     value={customDensity} onChange={(e) => setCustomDensity(e.target.value)} />
            </label>
          )}
        </div>

        <div style={{
          background: '#eafff0', border: '1px solid #b9e3c5', borderRadius: 10,
          padding: '0.85rem 1rem',
        }}>
          <div style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#2f6d3d' }}>
            Estimate
          </div>
          {tonnes != null ? (
            <>
              <div style={{ fontSize: '1.8rem', fontWeight: 700 }}>
                {tonnes.toFixed(1)} tonnes
              </div>
              <div className="muted" style={{ fontSize: '0.85rem' }}>
                {m3.toFixed(1)} m³ asphalt · density {density} kg/m³ · {wastagePct}% wastage
              </div>
            </>
          ) : (
            <div className="muted">Pick start + end and fill in width / thickness to see an estimate.</div>
          )}
        </div>

        <div className="capture-actions">
          <button
            className="ghost"
            onClick={() => setShowSaveModal(true)}
            disabled={tonnes == null}
            style={{ flex: 1 }}
          >
            💾 Save to project
          </button>
          <button className="ghost" onClick={reset} disabled={!start && !end}>Clear segment</button>
        </div>

        {savedNote && (
          <div style={{
            background: '#eafff0', border: '1px solid #b9e3c5', borderRadius: 8,
            padding: '0.5rem 0.75rem', fontSize: '0.85rem',
          }}>
            Saved to project as <strong>{savedNote.name || 'unnamed estimate'}</strong>.
          </div>
        )}
      </div>

      {showSaveModal && tonnes != null && (
        <SaveToProjectModal
          type="estimate"
          name={
            (startRoad?.kortform || endRoad?.kortform || 'segment')
            + ` · ${tonnes.toFixed(1)} t`
          }
          data={{
            start,
            end,
            startRef: startRoad?.kortform || null,
            endRef:   endRoad?.kortform || null,
            length_m: lengthM,
            straight_m: straightLengthM,
            road_m: usingRoadLength ? roadDist.road_m : null,
            length_source: usingRoadLength ? 'NVDB' : 'straight-line',
            width_m: w,
            width_source: widthSource,
            width_detail: widthDetail,
            thickness_mm: parseFloat(thicknessMm),
            mix: mix.id,
            density_kg_m3: density,
            wastage_pct: parseFloat(wastagePct),
            volume_m3: m3,
            tonnes,
            computed_at: new Date().toISOString(),
          }}
          onSaved={(m) => setSavedNote(m)}
          onClose={() => setShowSaveModal(false)}
        />
      )}
    </div>
  );
}

function RoadHint({ road }) {
  if (road === undefined) return <span className="muted">checking NVDB…</span>;
  if (road === null) return <span className="muted">no NVDB road within 200 m</span>;
  if (road?.error) return <span style={{ color: 'var(--bad)' }}>{road.error}</span>;
  return <>{road.kortform || road.ref || '—'}</>;
}
