// ─── SWOT (NASA/CNES): lake and reservoir water level ────────
// 1. Find the newest LakeSP "Prior" file (SWOT pass, ~8 MB zip) over the AOI.
// 2. Read its shapefile to find Prior Lake Database lakes inside the AOI.
// 3. Fetch each lake's water-surface-elevation history from Hydrocron.

const zlib = require('zlib');
const { cmrGranules, authFetch, configured } = require('./earthdata');
const { bbox, pointInRing, centroid } = require('./geo');
const { UA } = require('./net');

const PRIOR_D = 'C3233942291-POCLOUD'; // SWOT_L2_HR_LakeSP_prior_D
const HYDROCRON = 'https://soto.podaac.earthdatacloud.nasa.gov/hydrocron/v1/timeseries';
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

// ─── Minimal zip / shapefile / dBase readers ─────────────────
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files[name] = () => (method === 8 ? zlib.inflateRawSync(raw) : raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function readDbf(buf) {
  const records = buf.readUInt32LE(4), headerLen = buf.readUInt16LE(8), recLen = buf.readUInt16LE(10);
  const fields = [];
  for (let p = 32; buf[p] !== 0x0d && p < headerLen; p += 32) {
    fields.push({ name: buf.toString('latin1', p, p + 11).replace(/\0.*$/, '').toLowerCase(), type: String.fromCharCode(buf[p + 11]), len: buf[p + 16] });
  }
  const rows = [];
  for (let r = 0; r < records; r++) {
    let p = headerLen + r * recLen + 1;
    const row = {};
    for (const f of fields) {
      const s = buf.toString('latin1', p, p + f.len).trim();
      row[f.name] = f.type === 'N' || f.type === 'F' ? (s === '' ? null : parseFloat(s)) : s;
      p += f.len;
    }
    rows.push(row);
  }
  return rows;
}

// Polygon records → [{ bbox, rings }] in file order (matches dbf rows).
function readShp(buf) {
  const shapes = [];
  let p = 100;
  while (p + 8 <= buf.length) {
    const contentLen = buf.readInt32BE(p + 4) * 2;
    const c = p + 8;
    const type = buf.readInt32LE(c);
    if (type === 5 || type === 15 || type === 25) {
      const box = [buf.readDoubleLE(c + 4), buf.readDoubleLE(c + 12), buf.readDoubleLE(c + 20), buf.readDoubleLE(c + 28)];
      const numParts = buf.readInt32LE(c + 36), numPoints = buf.readInt32LE(c + 40);
      const parts = [];
      for (let i = 0; i < numParts; i++) parts.push(buf.readInt32LE(c + 44 + i * 4));
      const pts = c + 44 + numParts * 4;
      const rings = parts.map((s, i) => {
        const e = i + 1 < numParts ? parts[i + 1] : numPoints;
        const ring = [];
        for (let k = s; k < e; k++) ring.push([buf.readDoubleLE(pts + k * 16), buf.readDoubleLE(pts + k * 16 + 8)]);
        return ring;
      });
      shapes.push({ bbox: box, rings });
    } else {
      shapes.push(null);
    }
    p = c + contentLen;
  }
  return shapes;
}

// ─── Lake lookup per SWOT pass (cached) ──────────────────────
const passCache = new Map();
async function lakesInPass(granule) {
  if (passCache.has(granule.id)) return passCache.get(granule.id);
  const zipUrl = (granule.urls.find(u => /^https:.*\.zip$/.test(u.url) && /protected/.test(u.url)) || granule.urls.find(u => /^https:.*\.zip$/.test(u.url)) || {}).url;
  if (!zipUrl) throw new Error('SWOT pass has no download link');
  const buf = Buffer.from(await (await authFetch(zipUrl, { timeout: 40000 })).arrayBuffer());
  const files = unzip(buf);
  const name = ext => Object.keys(files).find(f => f.toLowerCase().endsWith(ext));
  const rows = readDbf(files[name('.dbf')]());
  const shapes = readShp(files[name('.shp')]());
  const lakes = rows.map((row, i) => ({ row, shape: shapes[i] })).filter(l => l.shape && l.row.lake_id);
  passCache.set(granule.id, lakes);
  if (passCache.size > 6) passCache.delete(passCache.keys().next().value);
  return lakes;
}

function overlaps(shape, aoi) {
  const [ax0, ay0, ax1, ay1] = bbox(aoi);
  const [x0, y0, x1, y1] = shape.bbox;
  if (x1 < ax0 || x0 > ax1 || y1 < ay0 || y0 > ay1) return false;
  const ring = aoi.coordinates[0];
  if (shape.rings.some(r => r.some(([x, y], k) => k % 5 === 0 && pointInRing(x, y, ring)))) return true;
  const [cx, cy] = centroid(aoi);
  if (shape.rings.some(r => pointInRing(cx, cy, r))) return true;
  return ring.some(([x, y]) => shape.rings.some(r => pointInRing(x, y, r)));
}

// ─── Water-level history per lake (Hydrocron, public) ────────
async function lakeHistory(lakeId, now) {
  const q = new URLSearchParams({ feature: 'PriorLake', feature_id: String(lakeId), start_time: '2023-07-01T00:00:00Z', end_time: now.toISOString().slice(0, 19) + 'Z', output: 'csv', fields: 'lake_id,time_str,wse,area_total' });
  const res = await fetch(`${HYDROCRON}?${q}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Hydrocron returned ${res.status}`);
  const csv = (await res.json()).results?.csv || '';
  const [head, ...lines] = csv.trim().split('\n');
  const cols = (head || '').split(',');
  const iT = cols.indexOf('time_str'), iW = cols.indexOf('wse'), iA = cols.indexOf('area_total');
  return lines.map(l => l.split(',')).map(c => ({ date: c[iT], wse: parseFloat(c[iW]), areaKm2: parseFloat(c[iA]) }))
    .filter(o => o.date && o.date !== 'no_data' && o.wse > -1000 && o.wse < 9000)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function summarise(obs) {
  if (obs.length < 2) return null;
  const last = obs[obs.length - 1];
  const t = Date.parse(last.date);
  const near = (days, tol) => obs.slice().reverse().find(o => Math.abs(t - Date.parse(o.date) - days * 86400000) <= tol * 86400000);
  const m1 = near(30, 20), y1 = near(365, 45);
  const levels = obs.map(o => o.wse);
  const min = Math.min(...levels), max = Math.max(...levels);
  return {
    latestDate: last.date.slice(0, 10), wseM: round(last.wse, 2), areaKm2: round(last.areaKm2, 3),
    change30dM: m1 ? round(last.wse - m1.wse, 2) : null,
    change1yM: y1 ? round(last.wse - y1.wse, 2) : null,
    levelPctOfRange: max - min > 0.05 ? Math.round(((last.wse - min) / (max - min)) * 100) : null,
    observations: obs.length, recordStart: obs[0].date.slice(0, 10)
  };
}

async function swotLakes(aoi, now = new Date()) {
  if (!configured()) return { available: false, reason: 'Not connected: set EARTHDATA_TOKEN (free NASA Earthdata account).' };
  const passes = await cmrGranules(PRIOR_D, { aoi, days: 60, now, pageSize: 4 });
  if (!passes.length) return { available: false, reason: 'No SWOT pass over this area in the last 60 days.' };
  const lakes = (await lakesInPass(passes[0])).filter(l => overlaps(l.shape, aoi));
  if (!lakes.length) return { available: false, reason: 'No lake or reservoir from the SWOT Prior Lake Database in this area.' };
  lakes.sort((a, b) => (b.row.area_total || 0) - (a.row.area_total || 0));
  const top = lakes.slice(0, 3);
  const out = await Promise.all(top.map(async l => {
    const hist = summarise(await lakeHistory(l.row.lake_id, now).catch(() => []));
    const nameField = Object.keys(l.row).find(k => /name/.test(k));
    return hist && { lakeId: String(l.row.lake_id), name: (nameField && l.row[nameField] && l.row[nameField] !== 'no_data') ? l.row[nameField] : null, ...hist };
  }));
  const found = out.filter(Boolean);
  if (!found.length) return { available: false, reason: 'SWOT lakes found, but no usable water-level observations yet.' };
  return { available: true, pass: passes[0].start ? passes[0].start.slice(0, 10) : null, lakes: found };
}

module.exports = { swotLakes, unzip, readDbf, readShp, summarise };
