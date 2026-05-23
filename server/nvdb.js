// Thin client for the NVDB v4 "/veg" road-position endpoint.
//
// The API requires an X-Client header identifying the calling application.
// Per Vegvesen guidelines we set it to a stable identifier so they can
// reach out if our usage causes load issues.
//
// docs: https://nvdb-docs.atlas.vegvesen.no/nvdbapil/v4/Posisjon
//
// Note on geometry: when we ask for srid=4326 the API returns coordinates
// as WKT "POINT Z (lat lon elev)" — lat first, then lon. We parse that
// into { lat, lon } here.

const BASE = 'https://nvdbapiles.atlas.vegvesen.no/vegnett/api/v4';
const HEADERS = {
  'X-Client': 'pqi-viewer',
  Accept: 'application/json',
};

function parseWktPointZ(wkt) {
  if (!wkt) return null;
  // "POINT Z (60.45934258 5.30600497 90.93642963)"
  const m = wkt.match(/POINT\s+Z\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+(-?\d+(?:\.\d+)?))?\s*\)/i);
  if (!m) return null;
  return {
    lat: parseFloat(m[1]),
    lon: parseFloat(m[2]),
    elev: m[3] !== undefined ? parseFloat(m[3]) : null,
  };
}

// Look up one road reference. Returns { ref, lat, lon, kortform } on success,
// or { ref, error } on failure (404, network error, malformed response).
export async function lookupRef(ref) {
  const url = `${BASE}/veg?vegsystemreferanse=${encodeURIComponent(ref)}&srid=4326`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
      // NVDB returns 404 with JSON body { detail: "Fant ingen posisjon for veg" }
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch { /* ignore */ }
      return { ref, error: `${res.status}: ${detail}` };
    }
    const data = await res.json();
    const point = parseWktPointZ(data?.geometri?.wkt);
    if (!point) return { ref, error: 'no geometry in response' };
    return {
      ref,
      lat: point.lat,
      lon: point.lon,
      kortform: data?.vegsystemreferanse?.kortform || null,
    };
  } catch (e) {
    return { ref, error: String(e.message || e) };
  }
}

// Look up many references at once via the /veg/batch endpoint.
// Returns a Map<ref, result> where result matches lookupRef's shape.
//
// We dedupe inputs so identical refs only cost one slot, and chunk large
// requests to stay polite about URL length (NVDB allows large batches but
// some intermediaries don't).
export async function lookupRefsBatch(refs) {
  const result = new Map();
  const unique = Array.from(new Set(refs.filter(Boolean)));
  const CHUNK = 50;

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const url =
      `${BASE}/veg/batch?vegsystemreferanser=` +
      chunk.map(encodeURIComponent).join(',') +
      `&srid=4326`;
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) {
        for (const r of chunk) result.set(r, { ref: r, error: `${res.status}` });
        continue;
      }
      const data = await res.json();
      for (const r of chunk) {
        const entry = data[r];
        if (!entry) {
          result.set(r, { ref: r, error: 'not found' });
          continue;
        }
        const point = parseWktPointZ(entry?.geometri?.wkt);
        if (!point) {
          result.set(r, { ref: r, error: 'no geometry' });
          continue;
        }
        result.set(r, {
          ref: r,
          lat: point.lat,
          lon: point.lon,
          kortform: entry?.vegsystemreferanse?.kortform || null,
        });
      }
    } catch (e) {
      for (const r of chunk) result.set(r, { ref: r, error: String(e.message || e) });
    }
  }
  return result;
}

// Reverse lookup: given a lat/lon, ask NVDB for the nearest road position.
// Used when the user clicks on the map and wants to know what road marker
// is there. NVDB caps maks_avstand at 200 m by default; if no road is
// within that radius the API returns an empty list.
export async function lookupPosition(lat, lon, maxDistanceMetres = 200) {
  const url =
    `${BASE}/posisjon?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}` +
    `&maks_avstand=${Math.min(200, Math.max(1, maxDistanceMetres))}&srid=4326`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch { /* ignore */ }
      return { error: `${res.status}: ${detail}` };
    }
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) {
      return { error: 'no road within search radius' };
    }
    // NVDB returns matches sorted by distance ascending — take the closest.
    const best = arr[0];
    const point = parseWktPointZ(best?.geometri?.wkt);
    // Some road segments in NVDB don't have a vegsystemreferanse mapped
    // (typically newly built or untyped links). In that case we still
    // return the veglenkesekvens id so the UI can show something useful.
    const kortform = best?.vegsystemreferanse?.kortform || null;
    return {
      ref: kortform,
      kortform,
      veglenke: best?.veglenkesekvens?.kortform || null,
      lat: point?.lat ?? null,
      lon: point?.lon ?? null,
      distance_m: best?.avstand != null ? Number(best.avstand) : null,
      kommune: best?.kommune ?? null,
    };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// Haversine distance in metres between two WGS84 points. Used to display
// the gap between the recorded GPS and the road-marker position.
export function haversineMetres(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v == null || !isFinite(v))) return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
