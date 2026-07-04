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
// Different sub-API for vegobjekter (road object attributes like width,
// number of lanes, surface type, etc.). The /vegnett/ namespace handles
// the road network itself; /vegobjekter/ handles the catalogue of
// things attached to it.
const VEGOBJ_BASE = 'https://nvdbapiles.atlas.vegvesen.no/vegobjekter';
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
    const vs = best?.vegsystemreferanse || {};
    // Break out the road-address components so callers can compute
    // things like "are these two positions on the same delstrekning,
    // and if so what's the meter delta?" (used for road-follow
    // distance in the asphalt estimator).
    const vegsystem = vs.vegsystem || {};
    const strekning = vs.strekning || {};
    return {
      ref: kortform,
      kortform,
      veglenke: best?.veglenkesekvens?.kortform || null,
      lat: point?.lat ?? null,
      lon: point?.lon ?? null,
      distance_m: best?.avstand != null ? Number(best.avstand) : null,
      kommune: best?.kommune ?? null,
      // Structured address so downstream code can compare segments.
      vegkategori:  vegsystem.vegkategori ?? null,
      vegfase:      vegsystem.fase        ?? null,
      vegnummer:    vegsystem.nummer      ?? null,
      strekning:    strekning.strekning   ?? null,
      delstrekning: strekning.delstrekning ?? null,
      meter:        strekning.meter != null ? Number(strekning.meter) : null,
    };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// Query NVDB for road width at a vegsystemreferanse.
//
// Catalogue facts (verified against datakatalog v1):
//
//   VT 838 = "Vegbredde, beregnet"   — modern, NVDB-computed widths
//     • egenskap 9537  "Dekkebredde"            ← we want this (wearing course)
//     • egenskap 9538  "Dekkebredde, min"        ← skip
//     • egenskap 9536  "Dekkebredde, maks"       ← skip
//     • egenskap 10248 "Dekkebredde, median"     ← skip
//     • egenskap 10249 "Dekkebredde, normal"     ← skip
//     • egenskap 9797  "Vegbredde"               ← fallback if no Dekkebredde
//     • egenskap 9800  "Kjørebanebredde"         ← fallback if neither above
//
//   VT 583 = "Vegbredde, historisk" — older, used where 838 lacks data
//     • egenskap 5555  "Dekkebredde"
//     • egenskap 5264  "Vegbredde, totalt"
//     • egenskap 5556  "Kjørebanebredde"
//
// Per Vegvesen's own note in the catalogue, VT 838 should be preferred
// and VT 583 is the legacy fallback.
//
// Returns:
//   { width_m: number, samples: number, source: string, attribute: string }
//   { width_m: null, tried: [...] }   — NVDB returned no useful width
//   { error: string }                 — network / API error
const WIDTH_VEGOBJ_TYPES = [
  { typeId: 838, label: 'Vegbredde, beregnet' },  // modern (recommended by NVDB)
  { typeId: 583, label: 'Vegbredde, historisk' }, // legacy fallback
];

// Property-name priority. We pick the most specific match in order.
// Exact-equality match, NOT substring, so we don't accidentally take
// "Dekkebredde, min" instead of "Dekkebredde".
const WIDTH_PROP_PRIORITY = [
  'Dekkebredde',      // wearing-course surface — what asphalt jobs pay for
  'Vegbredde',        // full road incl. shoulders
  'Vegbredde, totalt',
  'Kjørebanebredde',  // sum of driving-lane widths
];

function extractWidthFromObject(obj) {
  const props = obj?.egenskaper || [];
  for (const wanted of WIDTH_PROP_PRIORITY) {
    const p = props.find((x) =>
      typeof x?.navn === 'string' && x.navn === wanted && typeof x.verdi === 'number'
    );
    if (p && isFinite(p.verdi) && p.verdi > 0) return { value: Number(p.verdi), navn: p.navn };
  }
  return null;
}

async function fetchWidthFromType(typeId, ref) {
  // `inkluder=alle` returns metadata + egenskaper + lokasjon. We need
  // egenskaper for the width value; `egenskaper` alone is technically
  // enough but `alle` is what we tested and is robust against NVDB
  // tweaking the default include set.
  const url =
    `${VEGOBJ_BASE}/${typeId}?vegsystemreferanse=${encodeURIComponent(ref)}` +
    `&inkluder=alle&srid=4326`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* ignore */ }
    throw new Error(`${res.status}: ${detail}`);
  }
  const data = await res.json();
  const objs = data?.objekter || [];
  const samples = []; // [{ value, navn }]
  for (const obj of objs) {
    const w = extractWidthFromObject(obj);
    if (w) samples.push(w);
  }
  return { objektCount: objs.length, samples };
}

export async function lookupWidth(ref) {
  if (!ref) return { error: 'ref required' };
  const tried = [];
  for (const { typeId, label } of WIDTH_VEGOBJ_TYPES) {
    try {
      const { objektCount, samples } = await fetchWidthFromType(typeId, ref);
      tried.push({ typeId, label, objektCount, widthSamples: samples.length });
      if (samples.length > 0) {
        const avg = samples.reduce((a, b) => a + b.value, 0) / samples.length;
        // Most common attribute name in the sample wins the label.
        const counts = {};
        for (const s of samples) counts[s.navn] = (counts[s.navn] || 0) + 1;
        const topAttr = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
        console.log(`[nvdb-width] ${ref} → VT${typeId} ${topAttr}=${avg.toFixed(2)}m (${samples.length} samples, ${objektCount} objekter)`);
        return {
          width_m: Number(avg.toFixed(2)),
          samples: samples.length,
          source: `${label} · ${topAttr}`,
          attribute: topAttr,
          tried,
        };
      }
    } catch (e) {
      tried.push({ typeId, label, error: String(e.message || e) });
      // Keep trying the next type unless they're all done.
    }
  }
  console.log(`[nvdb-width] ${ref} → no width data; tried ${JSON.stringify(tried)}`);
  return { width_m: null, tried };
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
