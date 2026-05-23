// Assemble an NVDB "vegsystemreferanse" string from a PQI measurement row.
//
// Sources used:
//   - "Sted på veien"  — may be just the road ("9999KV1234") OR road +
//                        embedded section ("9999KV1234KS1D1"). The
//                        section, when present, is parsed back out.
//   - "Beskrivelse2"   — meter, possibly with a lane suffix like "M100 F1"
//                        ("F1" = felt/lane 1, irrelevant to NVDB).
//
// "Beskrivelse1" is INTENTIONALLY IGNORED. In real-world PQI files it
// commonly holds device-internal identifiers (e.g. "<digits>\<digits>")
// that trip NVDB into a 400.
//
// Two extra robustness features driven by real operator behaviour:
//   - If Sted på veien gives a K/P/S road without the kommune prefix
//     ("KV1234S2D1"), and we have a file-level `defaultKommune` inferred
//     from sibling rows, we inject it.
//   - If standard columns produce nothing, we scan ALL cells in the row
//     for a fully-glued pattern like "9999KV1234S1D1M200" (some operators
//     paste the whole reference into a notes column).

// Parse a road string into { road, section, kommune, cat, num }.
// Examples (using fully anonymised placeholder values):
//   "9999KV1234"        → { road:"9999 KV1234", kommune:"9999", cat:"K", num:"1234", section:null }
//   "9999KV1234KS1D1"   → { road:"9999 KV1234", kommune:"9999", cat:"K", num:"1234", section:"S1D1" }
//   "KV1234S2D1"        → { road:"KV1234",      kommune:null,   cat:"K", num:"1234", section:"S2D1" }
//   "RV13"              → { road:"RV13",        kommune:null,   cat:"R", num:"13",   section:null }
//   "FV911S2D3"         → { road:"FV911",       kommune:null,   cat:"F", num:"911",  section:"S2D3" }
//   "EV6S54D1"          → { road:"EV6",         kommune:null,   cat:"E", num:"6",    section:"S54D1" }
// Returns null if it doesn't look like a road code.
export function parseRoadAndSection(s) {
  if (!s) return null;
  const raw = String(s).trim().toUpperCase().replace(/\s+/g, '');
  const m = raw.match(
    /^(\d{2,4})?([EFKPRS])V(\d+)([KG])?(S\d+(?:D\d+(?:-\d+)?)?)?$/
  );
  if (!m) return null;
  const kommune = m[1] || null;
  const cat = m[2];
  const num = m[3];
  const section = m[5] || null;
  const road = kommune ? `${kommune} ${cat}V${num}` : `${cat}V${num}`;
  return { road, section, kommune, cat, num };
}

// Strip lane / felt suffixes from a meter cell.
function parseMeter(s) {
  if (!s) return null;
  const m = String(s).trim().match(/M?\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// Inject the file-level default kommune into a parsed road, but only for
// K/P/S categories (E and R roads are nationwide, no kommune prefix).
function applyDefaultKommune(parsed, defaultKommune) {
  if (parsed.kommune) return parsed.road;
  if (!defaultKommune) return parsed.road;
  if (!['K', 'P', 'S'].includes(parsed.cat)) return parsed.road;
  return `${defaultKommune} ${parsed.cat}V${parsed.num}`;
}

// Last argument is an options object — kept optional so existing call
// sites without it still compile.
// eslint-disable-next-line no-unused-vars
export function assembleRoadRef(stedPaaVeien, beskrivelse1, beskrivelse2, options = {}) {
  if (!stedPaaVeien || !beskrivelse2) return null;

  const parsed = parseRoadAndSection(stedPaaVeien);
  if (!parsed) return null;

  const meter = parseMeter(beskrivelse2);
  if (meter == null) return null;

  const road = applyDefaultKommune(parsed, options.defaultKommune);
  const section = parsed.section || 'S1D1';
  return `${road} ${section} m${meter}`;
}

// True when we genuinely had to default S1D1 (Sted på veien had no
// embedded section). Beskrivelse1 is ignored — has no influence.
// eslint-disable-next-line no-unused-vars
export function isSectionDefaulted(stedPaaVeien, beskrivelse1) {
  const parsed = parseRoadAndSection(stedPaaVeien || '');
  return !(parsed && parsed.section);
}

// True when Sted på veien has a K/P/S road but no kommune — telling the
// caller we'd need a defaultKommune to make this row resolvable.
export function isKommuneMissing(stedPaaVeien) {
  const parsed = parseRoadAndSection(stedPaaVeien || '');
  if (!parsed) return false;
  if (parsed.kommune) return false;
  return ['K', 'P', 'S'].includes(parsed.cat);
}

// Scan every cell in a row for a fully-glued road reference (road +
// section + meter all in one cell), e.g. "9999KV1234S1D1M200" or
// "KV1234S2D1M100". Used as a fallback when the standard columns don't
// give us a usable reference.
export function scanCellsForCombinedRef(cells, options = {}) {
  if (!Array.isArray(cells)) return null;
  for (const cell of cells) {
    if (!cell) continue;
    const raw = String(cell).toUpperCase().replace(/\s+/g, '');
    // Require road + section + meter to count — section is what
    // disambiguates a meaningful ref from a random number.
    const m = raw.match(
      /(\d{4})?([EFKPRS])V(\d+)([KG])?(S\d+(?:D\d+(?:-\d+)?)?)M(\d+)/
    );
    if (!m) continue;
    const kommune = m[1] || (
      ['K', 'P', 'S'].includes(m[2]) && options.defaultKommune ? options.defaultKommune : null
    );
    const road = kommune ? `${kommune} ${m[2]}V${m[3]}` : `${m[2]}V${m[3]}`;
    const section = m[5];
    const meter = parseInt(m[6], 10);
    return `${road} ${section} m${meter}`;
  }
  return null;
}

// Scan a whole file's rows to pick the most common kommune number from
// any cell that contains one. Returns null if no kommunes seen.
export function inferDefaultKommune(allCells) {
  const counts = new Map();
  for (const cells of allCells || []) {
    if (!Array.isArray(cells)) continue;
    for (const cell of cells) {
      if (!cell) continue;
      const raw = String(cell).toUpperCase().replace(/\s+/g, '');
      // Look for any "<4 digits><E/F/K/P/R/S>V<digits>" — that 4-digit
      // prefix is the kommune.
      const m = raw.match(/(\d{4})[EFKPRS]V\d/);
      if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  let best = null, bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best;
}
