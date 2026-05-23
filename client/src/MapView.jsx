import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  MapContainer, TileLayer, CircleMarker, Marker, Popup, Polyline,
  useMap, useMapEvents,
} from 'react-leaflet';
import L from 'leaflet';
import { api } from './api.js';

// Match the device's own GPS format: "DD MM.MMMMM N DD MM.MMMMM E"
// (degrees + decimal minutes). Mirrors server-side formatGps so the
// strings line up exactly with what's in the .pqidat file.
function formatPqiGps(lat, lon) {
  if (lat == null || lon == null) return '';
  const latHem = lat >= 0 ? 'N' : 'S';
  const lonHem = lon >= 0 ? 'E' : 'W';
  const aLat = Math.abs(lat), aLon = Math.abs(lon);
  const dLat = Math.floor(aLat), dLon = Math.floor(aLon);
  return `${dLat} ${((aLat - dLat) * 60).toFixed(5)} ${latHem} ` +
         `${dLon} ${((aLon - dLon) * 60).toFixed(5)} ${lonHem}`;
}

// Basemap definitions.
//   - "Topographic" = official Kartverket topo (Norway's standard basemap)
//   - "Satellite"   = Esri World Imagery (free for general use, no API key)
//   - "Hybrid"      = Satellite base + Kartverket topo overlay at reduced
//                     opacity so road lines, tunnel symbols, place names
//                     and contours are visible on top of the imagery.
const BASEMAPS = {
  topo: {
    url: 'https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png',
    attribution: '© <a href="https://www.kartverket.no/">Kartverket</a>',
    maxZoom: 18,
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    maxZoom: 19,
  },
};

// Opacity for the topo overlay when in hybrid mode. Low enough that the
// satellite shows through clearly, high enough that road lines and tunnel
// dashes stay readable.
const HYBRID_TOPO_OPACITY = 0.55;

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

function compactionColor(pct) {
  if (pct == null || isNaN(pct)) return '#888';
  if (pct >= 96) return '#2f9e44';
  if (pct >= 92) return '#e0731a';
  return '#c92a2a';
}

function compactionOf(headers, cells) {
  const idx = headers.findIndex((h) => h.trim().toLowerCase() === 'kompaktering');
  if (idx < 0) return null;
  const v = parseFloat(cells[idx]);
  return isNaN(v) ? null : v;
}

// Purple diamond marker for NVDB road-reference positions.
function diamondIcon(color = '#9333ea', size = 14) {
  return L.divIcon({
    className: 'road-marker',
    html: `<div style="
      width:${size}px;height:${size}px;
      background:${color};
      border:2px solid white;
      transform:rotate(45deg);
      box-shadow:0 0 2px rgba(0,0,0,0.4);
    "></div>`,
    iconSize: [size + 4, size + 4],
    iconAnchor: [(size + 4) / 2, (size + 4) / 2],
  });
}
const ROAD_ICON = diamondIcon('#9333ea');
const CLICK_ICON = diamondIcon('#0ea5e9', 16); // teal — distinguishes the user's map-click marker

function FitBoundsAndPan({ points, selectedId }) {
  const map = useMap();
  const fittedSig = useRef('');

  useEffect(() => {
    if (!points.length) return;
    const sig = points.map((p) => `${p.id}:${p.lat}:${p.lon}`).sort().join(',');
    if (sig !== fittedSig.current) {
      fittedSig.current = sig;
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon]));
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 17 });
    }
  }, [map, points]);

  useEffect(() => {
    if (selectedId == null) return;
    const sel = points.find((p) => p.id === selectedId);
    if (sel) map.panTo([sel.lat, sel.lon]);
  }, [map, points, selectedId]);

  return null;
}

// Captures map clicks and asks the backend what road marker is nearest.
// Renders the result as a teal diamond + popup. The query is async, so the
// popup briefly shows "looking up…" while the NVDB call completes.
function ClickProbe() {
  const [click, setClick] = useState(null); // { lat, lon, loading, result, error }

  useMapEvents({
    click: async (e) => {
      const lat = e.latlng.lat;
      const lon = e.latlng.lng;
      setClick({ lat, lon, loading: true });
      try {
        const result = await api.roadPositionAt(lat, lon);
        setClick({ lat, lon, loading: false, result });
      } catch (err) {
        setClick({ lat, lon, loading: false, error: err.message });
      }
    },
  });

  // Once the click+result are settled, open the popup automatically so the
  // user doesn't have to click the diamond a second time.
  const markerRef = useRef(null);
  useEffect(() => {
    if (click && !click.loading && markerRef.current) {
      markerRef.current.openPopup();
    }
  }, [click]);

  if (!click) return null;

  // If a road position came back, show its road marker location (not the
  // raw click point) so the diamond sits ON the road.
  const pos = (click.result && click.result.lat != null)
    ? [click.result.lat, click.result.lon]
    : [click.lat, click.lon];

  return (
    <Marker position={pos} icon={CLICK_ICON} ref={markerRef}>
      <Popup>
        <b>Map click</b><br />
        {click.loading && <span>Looking up road marker…</span>}
        {click.error && <span style={{ color: 'var(--bad)' }}>Lookup failed: {click.error}</span>}
        {click.result && (
          <>
            {click.result.kortform ? (
              <>
                Road marker: <b>{click.result.kortform}</b><br />
                {click.result.distance_m != null && (
                  <>Distance from click: {click.result.distance_m.toFixed(1)} m<br /></>
                )}
              </>
            ) : (
              <>
                <i>No vegsystemreferanse mapped here.</i><br />
                Road link: {click.result.veglenke}<br />
              </>
            )}
            Kommune: {click.result.kommune ?? '—'}<br />
            Click point (decimal): {click.lat.toFixed(5)}, {click.lon.toFixed(5)}<br />
            Click point (PQI format): <code>{formatPqiGps(click.lat, click.lon)}</code>
            {click.result.lat != null && (
              <>
                <br />
                Road marker (PQI format):<br />
                <code>{formatPqiGps(click.result.lat, click.result.lon)}</code>
              </>
            )}
          </>
        )}
      </Popup>
    </Marker>
  );
}

// Custom control panel anchored top-right of the map. Replaces Leaflet's
// LayersControl so we can:
//   - present base maps as a clear 3-way radio (topo / satellite / hybrid),
//   - expose first-class visibility toggles for the row markers.
// stopPropagation on every event keeps clicks from bubbling into the map
// (otherwise picking "Satellite" would also trigger a ClickProbe lookup).
function MapControls({
  basemap, onBasemapChange,
  showGps, onShowGpsChange,
  showRoad, onShowRoadChange,
}) {
  const stop = (e) => { e.stopPropagation(); };
  return (
    <div
      className="map-controls"
      onMouseDown={stop}
      onDoubleClick={stop}
      onClick={stop}
      onWheel={stop}
      onTouchStart={stop}
    >
      <div className="map-controls-section">
        <div className="map-controls-title">Base map</div>
        {[
          ['topo', 'Topographic'],
          ['satellite', 'Satellite'],
          ['hybrid', 'Hybrid'],
        ].map(([value, label]) => (
          <label key={value} className="map-controls-row">
            <input
              type="radio"
              name="basemap"
              value={value}
              checked={basemap === value}
              onChange={() => onBasemapChange(value)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <div className="map-controls-section">
        <div className="map-controls-title">Show</div>
        <label className="map-controls-row">
          <input
            type="checkbox"
            checked={showGps}
            onChange={(e) => onShowGpsChange(e.target.checked)}
          />
          <span><span className="legend-dot legend-gps" /> Recorded GPS</span>
        </label>
        <label className="map-controls-row">
          <input
            type="checkbox"
            checked={showRoad}
            onChange={(e) => onShowRoadChange(e.target.checked)}
          />
          <span><span className="legend-dot legend-road" /> Road marker</span>
        </label>
      </div>
    </div>
  );
}

export default function MapView({
  headers, measurements, roadMarkers, selectedId, onSelect,
}) {
  const initialCenter = measurements.length
    ? [measurements[0].lat, measurements[0].lon]
    : [64.0, 12.0];
  const initialZoom = measurements.length ? 14 : 5;

  const [basemap, setBasemap] = useState('topo'); // 'topo' | 'satellite' | 'hybrid'
  const [showGps, setShowGps] = useState(true);
  const [showRoad, setShowRoad] = useState(true);

  const gpsPoints = useMemo(
    () => measurements.map((m) => ({ ...m, compaction: compactionOf(headers, m.cells) })),
    [headers, measurements]
  );

  const pairLines = useMemo(() => {
    const byId = new Map(gpsPoints.map((p) => [p.id, p]));
    return (roadMarkers || []).flatMap((r) => {
      const gp = byId.get(r.measurement.id);
      if (!gp) return [];
      return [{
        id: r.measurement.id,
        positions: [[gp.lat, gp.lon], [r.lat, r.lon]],
        distance: r.distance_m,
      }];
    });
  }, [gpsPoints, roadMarkers]);

  const fitPoints = useMemo(() => {
    const arr = gpsPoints.map((p) => ({ id: `g-${p.id}`, lat: p.lat, lon: p.lon }));
    for (const r of roadMarkers || []) arr.push({ id: `r-${r.measurement.id}`, lat: r.lat, lon: r.lon });
    return arr;
  }, [gpsPoints, roadMarkers]);

  return (
    <div className="map-pane-inner">
      <MapContainer
        center={initialCenter}
        zoom={initialZoom}
        maxZoom={19}
        scrollWheelZoom
      >
        {/* Base layer(s). React-leaflet handles add/remove via conditional
            rendering — switching basemap unmounts the old TileLayer and
            mounts the new one, which is what we want. */}
        {basemap === 'topo' && (
          <TileLayer
            url={BASEMAPS.topo.url}
            attribution={BASEMAPS.topo.attribution}
            maxZoom={BASEMAPS.topo.maxZoom}
          />
        )}
        {basemap === 'satellite' && (
          <TileLayer
            url={BASEMAPS.satellite.url}
            attribution={BASEMAPS.satellite.attribution}
            maxZoom={BASEMAPS.satellite.maxZoom}
          />
        )}
        {basemap === 'hybrid' && (
          <>
            <TileLayer
              url={BASEMAPS.satellite.url}
              attribution={BASEMAPS.satellite.attribution}
              maxZoom={BASEMAPS.satellite.maxZoom}
            />
            {/* Topo overlay at reduced opacity so road lines, tunnel
                dashes, contour lines and place names from the Kartverket
                topo render visibly on top of the imagery. */}
            <TileLayer
              url={BASEMAPS.topo.url}
              attribution={BASEMAPS.topo.attribution}
              maxZoom={BASEMAPS.topo.maxZoom}
              opacity={HYBRID_TOPO_OPACITY}
            />
          </>
        )}

        <FitBoundsAndPan points={fitPoints} selectedId={selectedId != null ? `g-${selectedId}` : null} />
        <ClickProbe />

        {/* Pair lines only make sense when BOTH endpoints are visible —
            a line dangling to nowhere is confusing. */}
        {showGps && showRoad && pairLines.map((l) => (
          <Polyline
            key={l.id}
            positions={l.positions}
            pathOptions={{
              color: l.distance == null || l.distance < 10 ? '#2f9e44'
                   : l.distance < 50 ? '#e0731a' : '#c92a2a',
              weight: 2,
              opacity: 0.7,
              dashArray: '4 4',
            }}
          />
        ))}

        {showGps && gpsPoints.map((p) => (
          <CircleMarker
            key={`g-${p.id}`}
            center={[p.lat, p.lon]}
            radius={selectedId === p.id ? 10 : 7}
            pathOptions={{
              color: '#222',
              weight: selectedId === p.id ? 2 : 1,
              fillColor: compactionColor(p.compaction),
              fillOpacity: 0.85,
            }}
            eventHandlers={{ click: () => onSelect && onSelect(p.id) }}
          >
            <Popup>
              <b>Row {p.position + 1}</b><br />
              Compaction: {p.compaction != null ? p.compaction.toFixed(2) + ' %' : '—'}<br />
              {headers.map((h, i) => {
                const k = h.trim().toLowerCase();
                if (['densitet', 'overflate temperatur', 'hulrom'].includes(k)) {
                  return <div key={i}>{h}: {p.cells[i]}</div>;
                }
                return null;
              })}
            </Popup>
          </CircleMarker>
        ))}

        {showRoad && (roadMarkers || []).map((r) => (
          <Marker
            key={`r-${r.measurement.id}`}
            position={[r.lat, r.lon]}
            icon={ROAD_ICON}
            eventHandlers={{ click: () => onSelect && onSelect(r.measurement.id) }}
          >
            <Popup>
              <b>Road marker · row {r.measurement.position + 1}</b><br />
              {r.kortform || r.ref}<br />
              {r.distance_m != null && (
                <>Gap to recorded GPS: <b>{r.distance_m.toFixed(1)} m</b></>
              )}
            </Popup>
          </Marker>
        ))}
      </MapContainer>

      <MapControls
        basemap={basemap}
        onBasemapChange={setBasemap}
        showGps={showGps}
        onShowGpsChange={setShowGps}
        showRoad={showRoad}
        onShowRoadChange={setShowRoad}
      />
    </div>
  );
}
