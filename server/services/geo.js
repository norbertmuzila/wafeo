// ─── Map reference data: districts, provinces and local place names ──
// Provinces and districts come from geoBoundaries (open administrative
// boundaries for every country). Village, school, hill, dam and other local
// names come from the GeoNames gazetteer, which lists far more rural places
// than most web maps. Both are cached in memory; responses are also cached
// by the CDN, so each file is downloaded rarely.

const zlib = require('zlib');
const { UA } = require('./eo/net');

const timeout = ms => AbortSignal.timeout(ms);
const httpError = (status, message) => Object.assign(new Error(message), { status });

// ─── Administrative areas (geoBoundaries) ───────────────────

const adminCache = new Map();           // 'ZWE-2' → Promise<result>
const MAX_ADMIN_BYTES = 1.6e6;          // keep each response light enough for phones

async function adminAreas(iso3, level) {
  const key = `${iso3}-${level}`;
  if (!adminCache.has(key)) {
    const p = loadAdmin(iso3, level).catch(err => { adminCache.delete(key); throw err; });
    adminCache.set(key, p);
    if (adminCache.size > 60) adminCache.delete(adminCache.keys().next().value);
  }
  return adminCache.get(key);
}

async function loadAdmin(iso3, level) {
  const meta = await fetch(`https://www.geoboundaries.org/api/current/gbOpen/${iso3}/ADM${level}/`, { headers: { 'User-Agent': UA }, signal: timeout(15000) });
  if (meta.status === 404) return { available: false, areas: emptyFc(), labels: emptyFc() };
  if (!meta.ok) throw httpError(502, `geoBoundaries returned ${meta.status}`);
  const info = await meta.json().catch(() => null);
  const url = info && (info.simplifiedGeometryGeoJSON || info.gjDownloadURL);
  if (!url) return { available: false, areas: emptyFc(), labels: emptyFc() };
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: timeout(30000) });
  if (!res.ok) throw httpError(502, `geoBoundaries file returned ${res.status}`);
  const gj = await res.json();

  // Simplify until the outlines fit the size budget (finer first).
  let areas;
  for (const tol of [0, 0.002, 0.005, 0.01, 0.02, 0.04]) {
    areas = gj.features.filter(f => f.geometry).map(f => ({
      type: 'Feature',
      properties: { n: cleanName(f.properties.shapeName) },
      geometry: simplifyGeometry(f.geometry, tol)
    })).filter(f => f.geometry);
    if (JSON.stringify(areas).length <= MAX_ADMIN_BYTES) break;
  }
  const labels = gj.features.filter(f => f.geometry && f.properties.shapeName).map(f => ({
    type: 'Feature', properties: { n: cleanName(f.properties.shapeName), a: Math.round(areaOf(f.geometry) * 1e4) }, geometry: { type: 'Point', coordinates: labelPoint(f.geometry).map(r4) }
  }));
  return {
    available: true,
    kind: info.boundaryCanonical || (level === 1 ? 'Province / state' : 'District'),
    source: 'geoBoundaries (' + (info.boundarySource || 'open data') + ')',
    areas: { type: 'FeatureCollection', features: areas },
    labels: { type: 'FeatureCollection', features: labels }
  };
}

const emptyFc = () => ({ type: 'FeatureCollection', features: [] });
const r4 = v => Math.round(v * 1e4) / 1e4;
const cleanName = s => String(s || '').trim();

// Douglas–Peucker per ring, coordinates rounded to ~11 m.
function simplifyRing(ring, tol) {
  const pts = ring.map(([x, y]) => [r4(x), r4(y)]);
  if (tol <= 0 || pts.length < 8) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  // A closed ring starts and ends on the same point, so also anchor it at the
  // point farthest from the start; otherwise the whole ring would collapse.
  let far = 0, farD = -1;
  pts.forEach(([x, y], i) => { const d = (x - pts[0][0]) ** 2 + (y - pts[0][1]) ** 2; if (d > farD) { farD = d; far = i; } });
  keep[far] = 1;
  const stack = [[0, far], [far, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = pts.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : null;
}
function simplifyGeometry(g, tol) {
  const poly = rings => { const r = rings.map(x => simplifyRing(x, tol)); return r[0] ? r.filter(Boolean) : null; };
  if (g.type === 'Polygon') { const p = poly(g.coordinates); return p && { type: 'Polygon', coordinates: p }; }
  if (g.type === 'MultiPolygon') {
    const ps = g.coordinates.map(poly).filter(Boolean);
    return ps.length ? { type: 'MultiPolygon', coordinates: ps } : null;
  }
  return null;
}

// A point inside the largest part of the area, for its name label.
function labelPoint(g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let best = polys[0], bestArea = -1;
  for (const p of polys) { const a = Math.abs(ringArea(p[0])); if (a > bestArea) { bestArea = a; best = p; } }
  const ring = best[0];
  // Centroid when it falls inside; otherwise the middle of the widest
  // horizontal span through the area at the centroid's latitude.
  let cx = 0, cy = 0, a6 = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f; a6 += f * 3;
  }
  const c = a6 ? [cx / a6, cy / a6] : ring[0];
  if (inside(c, ring)) return c;
  const xs = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j], [x2, y2] = ring[i];
    if ((y1 > c[1]) !== (y2 > c[1])) xs.push(x1 + (c[1] - y1) / (y2 - y1) * (x2 - x1));
  }
  xs.sort((p, q) => p - q);
  let span = null;
  for (let i = 0; i + 1 < xs.length; i += 2) if (!span || xs[i + 1] - xs[i] > span[1] - span[0]) span = [xs[i], xs[i + 1]];
  return span ? [(span[0] + span[1]) / 2, c[1]] : ring[0];
}
// Size in square degrees (outer rings): bigger areas get label priority.
const areaOf = geom => (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates).reduce((s, p) => s + Math.abs(ringArea(p[0])), 0);
function ringArea(r) { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return s / 2; }
function inside([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// ─── Local place names (GeoNames) ───────────────────────────

// Kinds the map styles differently. Index = kind code sent to the browser.
const KINDS = ['city', 'town', 'village', 'area', 'school', 'health', 'poi', 'water', 'hill', 'farm'];
const K = Object.fromEntries(KINDS.map((k, i) => [k, i]));
const S_CODES = {
  SCH: K.school, SCHC: K.school, SCHT: K.school, SCHA: K.school, SCHM: K.school, UNIV: K.school,
  HSP: K.health, HSPC: K.health, HSPD: K.health, HSPL: K.health, CTRM: K.health,
  MSSN: K.poi, MKT: K.poi, AIRP: K.poi, AIRF: K.poi, RSTN: K.poi, BUSTN: K.poi, PO: K.poi, ADMF: K.poi, PSTB: K.poi, CTRA: K.poi,
  DAM: K.water, FRM: K.farm, FRMS: K.farm, EST: K.farm, RNCH: K.farm
};
const H_CODES = { RSV: K.water, LK: K.water, LKS: K.water, LKN: K.water, LKI: K.water, LGN: K.water };
const T_CODES = { MT: K.hill, MTS: K.hill, PK: K.hill, PKS: K.hill, HLL: K.hill, HLLS: K.hill };
const L_CODES = { CTRB: K.area, TRB: K.area, AREA: K.area, RESN: K.area, PRK: K.area, RESF: K.area, RESW: K.area, LCTY: K.area, RGNL: K.area };

function kindOf(fclass, fcode, pop) {
  if (fclass === 'P') {
    if (/^PPL[HQW]$/.test(fcode)) return null;                  // historical, abandoned, destroyed
    if (fcode === 'PPLC' || fcode === 'PPLA' || pop >= 100000) return K.city;
    if (fcode === 'PPLA2' || pop >= 10000) return K.town;
    return K.village;
  }
  if (fclass === 'S') return S_CODES[fcode] ?? null;
  if (fclass === 'H') return H_CODES[fcode] ?? null;
  if (fclass === 'T') return T_CODES[fcode] ?? null;
  if (fclass === 'L') return L_CODES[fcode] ?? null;
  return null;
}

const MAX_DUMP_BYTES = 40e6;   // the United States dump (~70 MB) is left to OpenStreetMap
const placeCache = new Map();  // 'ZW' → Promise<Map<cell, rows>>

async function placesInCell(cc, x, y) {
  if (!placeCache.has(cc)) {
    const p = loadCountryPlaces(cc).catch(err => { placeCache.delete(cc); throw err; });
    placeCache.set(cc, p);
    if (placeCache.size > 4) placeCache.delete(placeCache.keys().next().value);
  }
  const cells = await placeCache.get(cc);
  return cells ? cells.get(`${x},${y}`) || [] : null;
}

async function loadCountryPlaces(cc) {
  const url = `https://download.geonames.org/export/dump/${cc}.zip`;
  const head = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: timeout(10000) });
  if (head.status === 404) return new Map();
  const size = Number(head.headers.get('content-length')) || 0;
  if (size > MAX_DUMP_BYTES) return null;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: timeout(40000) });
  if (!res.ok) throw httpError(502, `GeoNames returned ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const cells = new Map();
  await readZipText(zip, `${cc}.txt`, line => {
    const f = line.split('\t');
    if (f.length < 15) return;
    const pop = Number(f[14]) || 0;
    const kind = kindOf(f[6], f[7], pop);
    if (kind === null || !f[1]) return;
    const lat = Number(f[4]), lon = Number(f[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const key = `${Math.floor(lon)},${Math.floor(lat)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push([f[1], r4(lon), r4(lat), kind, pop]);
  });
  return cells;
}

// Stream one file out of a zip archive, line by line, without holding the
// whole unpacked text in memory (some country files are over 100 MB).
function readZipText(buf, name, onLine) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entry = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (entry !== name) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    return new Promise((resolve, reject) => {
      const src = method === 0 ? null : zlib.createInflateRaw();
      let rest = '';
      const eat = chunk => {
        const text = rest + chunk.toString('utf8');
        const lines = text.split('\n');
        rest = lines.pop();
        for (const l of lines) onLine(l);
      };
      if (!src) { eat(data); if (rest) onLine(rest); return resolve(); }
      src.on('data', eat);
      src.on('end', () => { if (rest) onLine(rest); resolve(); });
      src.on('error', reject);
      src.end(data);
    });
  }
  throw new Error(`${name} not found in archive`);
}

module.exports = { adminAreas, placesInCell, KINDS, _internal: { simplifyRing, labelPoint, kindOf, readZipText } };
