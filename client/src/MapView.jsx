import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  MapContainer, TileLayer, CircleMarker, Marker, Popup, Polyline,
  LayersControl, useMap, useMapEvents,
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

// Basemap + overlay options.
//   - "Topographic" = official Kartverket topo (Norway's standard basemap)
//   - "Satellite"   = Esri World Imagery (free for general use, no API key)
//   - "Place + road labels" overlay (transparent) toggled separately; turn
//     it on top of satellite to get a Google-style hybrid view.
//
// react-leaflet's <LayersControl.BaseLayer> wants a single Leaflet layer
// as its child. Earlier versions tried to stuff two TileLayers into one
// BaseLayer, which the control couldn't handle — it rendered the entry
// twice and showed only the bottom layer (raw satellite). The fix is to
// model labels as a separate Overlay.
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

// Transparent label overlay. CartoDB Voyager labels-only — clean place
// names + road names overlay that works on top of anything. Subdomains
// {a,b,c,d} for parallel loading.
const LABEL_OVERLAY = {
  url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png',
  attribution: '© <a href="https://carto.com/attribution">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 19,
};

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
  const map = useMap();

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

export default function MapView({
  headers, measurements, roadMarkers, selectedId, onSelect,
}) {
  const initialCenter = measurements.length
    ? [measurements[0].lat, measurements[0].lon]
    : [64.0, 12.0];
  const initialZoom = measurements.length ? 14 : 5;

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
    <MapContainer
      center={initialCenter}
      zoom={initialZoom}
      maxZoom={19}
      scrollWheelZoom
    >
      {/* Layer switcher (top-right). Pick ONE base layer; the labels
          overlay can be toggled independently. Satellite + labels = a
          hybrid map. */}
      <LayersControl position="topright">
        <LayersControl.BaseLayer checked name="Topographic (Kartverket)">
          <TileLayer url={BASEMAPS.topo.url} attribution={BASEMAPS.topo.attribution} maxZoom={BASEMAPS.topo.maxZoom} />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Satellite">
          <TileLayer url={BASEMAPS.satellite.url} attribution={BASEMAPS.satellite.attribution} maxZoom={BASEMAPS.satellite.maxZoom} />
        </LayersControl.BaseLayer>
        <LayersControl.Overlay name="Place + road labels (for hybrid view)">
          <TileLayer
            url={LABEL_OVERLAY.url}
            attribution={LABEL_OVERLAY.attribution}
            subdomains={LABEL_OVERLAY.subdomains}
            maxZoom={LABEL_OVERLAY.maxZoom}
          />
        </LayersControl.Overlay>
      </LayersControl>
      <FitBoundsAndPan points={fitPoints} selectedId={selectedId != null ? `g-${selectedId}` : null} />
      <ClickProbe />

      {pairLines.map((l) => (
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

      {gpsPoints.map((p) => (
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

      {(roadMarkers || []).map((r) => (
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
  );
}
