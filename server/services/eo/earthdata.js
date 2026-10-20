// ─── NASA Earthdata sources (need EARTHDATA_TOKEN) ───────────
// ECOSTRESS (70 m evaporative stress + daily ET, cloud-optimised GeoTIFF),
// SMAP L3 enhanced (9 km soil moisture, via OPeNDAP cell subset) and
// GRACE-FO JPL mascons (groundwater / total water storage, via OPeNDAP).
// Only the AOI's pixels or grid cell are requested, never whole files.

const proj4 = require('proj4');
const { UA, isoDay, daysAgo } = require('./net');
const { makeGrid, readBand, stats } = require('./raster');
const { bbox, centroid } = require('./geo');

const CMR = 'https://cmr.earthdata.nasa.gov/search';
const OPENDAP = 'https://opendap.earthdata.nasa.gov/collections';
const COLLECTIONS = {
  ESI: 'C2076104650-LPCLOUD',    // ECO_L4T_ESI v002
  JET: 'C2076106409-LPCLOUD',    // ECO_L3T_JET v002
  SMAP: 'C2938664763-NSIDC_CPRD', // SPL3SMP_E v006
  GRACE: 'C3195527175-POCLOUD'    // TELLUS GRACE/GRACE-FO mascon CRI RL06.3 v4
};

const token = () => (process.env.EARTHDATA_TOKEN || '').trim();
const configured = () => !!token();
const notConnected = { available: false, reason: 'Not connected: set EARTHDATA_TOKEN (free NASA Earthdata account).' };
const isEarthdataHost = host => /(^|\.)earthdata\.nasa\.gov$|(^|\.)earthdatacloud\.nasa\.gov$/.test(host);
const authHeaders = () => ({ Authorization: `Bearer ${token()}`, 'User-Agent': UA });
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

// Public catalogue search (no token needed), newest first.
async function cmrGranules(conceptId, { aoi, point, days, now = new Date(), pageSize = 10 } = {}) {
  const q = new URLSearchParams({ collection_concept_id: conceptId, sort_key: '-start_date', page_size: String(pageSize) });
  if (aoi) q.set('bounding_box', bbox(aoi).map(v => v.toFixed(5)).join(','));
  if (point) q.set('point', `${point[0].toFixed(5)},${point[1].toFixed(5)}`);
  if (days) q.set('temporal', `${isoDay(daysAgo(days, now))}T00:00:00Z,${now.toISOString().slice(0, 19)}Z`);
  const res = await fetch(`${CMR}/granules.umm_json?${q}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`NASA CMR returned ${res.status}`);
  const j = await res.json();
  return (j.items || []).map(g => ({
    id: g.umm.GranuleUR,
    start: g.umm.TemporalExtent?.RangeDateTime?.BeginningDateTime || g.umm.TemporalExtent?.SingleDateTime || null,
    urls: (g.umm.RelatedUrls || []).map(u => ({ url: u.URL, type: u.Type || '', subtype: u.Subtype || '' }))
  }));
}

function refused(status) {
  return new Error(`NASA Earthdata refused access (${status}). Check EARTHDATA_TOKEN and approve the data applications in your Earthdata profile.`);
}

// Authenticated GET that only sends the token to NASA hosts (redirects to
// S3 signed URLs must not carry it).
async function authFetch(url, { timeout = 20000, accept } = {}) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const host = new URL(current).host;
    const res = await fetch(current, {
      headers: { ...(isEarthdataHost(host) ? authHeaders() : { 'User-Agent': UA }), ...(accept ? { Accept: accept } : {}) },
      redirect: 'manual', signal: AbortSignal.timeout(timeout)
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).href;
      res.body?.cancel();
      continue;
    }
    if (res.status === 401 || res.status === 403) { res.body?.cancel(); throw refused(res.status); }
    if (!res.ok) { res.body?.cancel(); throw new Error(`${host} returned ${res.status}`); }
    return res;
  }
  throw new Error('Too many redirects from NASA Earthdata.');
}

// For range-reading a protected GeoTIFF: resolve the redirect once to the
// short-lived signed URL, then read it without credentials.
const signedCache = new Map();
async function signedTiff(url) {
  const hit = signedCache.get(url);
  if (hit && hit.expires > Date.now()) return hit;
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const host = new URL(current).host;
    const res = await fetch(current, {
      headers: { ...(isEarthdataHost(host) ? authHeaders() : { 'User-Agent': UA }), Range: 'bytes=0-0' },
      redirect: 'manual', signal: AbortSignal.timeout(15000)
    });
    res.body?.cancel();
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { current = new URL(res.headers.get('location'), current).href; continue; }
    if (res.status === 401 || res.status === 403) throw refused(res.status);
    if (!res.ok) throw new Error(`${host} returned ${res.status}`);
    break;
  }
  const direct = current === url;
  const entry = { url: current, headers: direct ? authHeaders() : null, expires: Date.now() + 40 * 60 * 1000 };
  signedCache.set(url, entry);
  if (signedCache.size > 300) signedCache.delete(signedCache.keys().next().value);
  return entry;
}

// ─── ECOSTRESS: evaporative stress index + daily evapotranspiration ──
// Tiles follow the Sentinel-2 MGRS grid; tile "36KUF" is UTM zone 36 south.
function mgrsEpsg(name) {
  const m = /_(\d{2})([C-X])[A-Z]{2}_/.exec(name);
  return m ? (m[2] < 'N' ? 32700 : 32600) + Number(m[1]) : null;
}
const tifUrl = (g, suffix) => (g.urls.find(u => /^https:/.test(u.url) && u.url.endsWith(`_${suffix}.tif`)) || {}).url;

async function readMasked(g, suffix, grid) {
  const [valS, cloudS, waterS] = await Promise.all([tifUrl(g, suffix), tifUrl(g, 'cloud'), tifUrl(g, 'water')].map(u => (u ? signedTiff(u) : null)));
  if (!valS) return null;
  const [val, cloud, water] = await Promise.all([
    readBand(valS.url, grid, NaN, valS.headers),
    cloudS ? readBand(cloudS.url, grid, 1, cloudS.headers) : null,
    waterS ? readBand(waterS.url, grid, 0, waterS.headers) : null
  ]);
  const v = [];
  let covered = 0;
  for (let i = 0; i < val.length; i++) {
    if (!grid.mask[i]) continue;
    if (Number.isFinite(val[i]) || (cloud && cloud[i])) covered++;
    if ((cloud && cloud[i]) || (water && water[i]) || !Number.isFinite(val[i])) continue;
    v.push(val[i]);
  }
  return { values: v, covered };
}

async function ecostress(aoi, now = new Date()) {
  if (!configured()) return notConnected;
  const granules = await cmrGranules(COLLECTIONS.ESI, { aoi, days: 90, now, pageSize: 10 });
  for (const g of granules.slice(0, 5)) {
    const epsg = mgrsEpsg(g.id);
    if (!epsg || !tifUrl(g, 'ESI')) continue;
    const grid = makeGrid(aoi, epsg, 70);
    const esi = await readMasked(g, 'ESI', grid);
    if (!esi || esi.covered < grid.inside * 0.5) continue;              // area off this tile
    const valid = esi.values.filter(x => x >= 0 && x <= 1.5);
    if (valid.length < Math.max(1, grid.inside * 0.3)) continue;        // too cloudy
    const s = stats(valid);
    // Daily ET from the matching JET granule (same overpass).
    let et = null;
    try {
      const jets = await cmrGranules(COLLECTIONS.JET, { aoi, days: 90, now, pageSize: 20 });
      const jet = jets.find(x => x.id === g.id.replace('L4T_ESI', 'L3T_JET'));
      const r = jet ? await readMasked(jet, 'ETdaily', grid) : null;
      const sv = r && stats(r.values.filter(x => x >= 0 && x < 20));
      et = sv ? round(sv.mean, 2) : null;
    } catch (e) { et = null; }
    return {
      available: true,
      date: (g.start || '').slice(0, 10),
      esi: { mean: round(s.mean), p10: round(s.p10) },
      etDailyMm: et,
      clearPct: Math.round((valid.length / grid.inside) * 100),
      resolutionM: 70
    };
  }
  return { available: false, reason: 'No clear ECOSTRESS pass over this area in the last 90 days.' };
}

// ─── SMAP L3 enhanced: satellite soil moisture (9 km EASE-Grid 2.0) ──
const EASE2 = { x0: -17367530.44516138, y0: 7314540.79258289, cell: 9008.055210146, cols: 3856, rows: 1624 };
const EASE2_DEF = '+proj=cea +lat_ts=30 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs';

function easeIndex([lon, lat]) {
  const [x, y] = proj4('EPSG:4326', EASE2_DEF).forward([lon, lat]);
  const col = Math.floor((x - EASE2.x0) / EASE2.cell), row = Math.floor((EASE2.y0 - y) / EASE2.cell);
  if (col < 0 || row < 0 || col >= EASE2.cols || row >= EASE2.rows) throw new Error('Outside the SMAP grid');
  return { row, col };
}

// DAP4 CSV: pull every number that follows a variable's line.
function parseDapCsv(text) {
  const out = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\/[^,]+?)\s*(?:,|$)(.*)$/.exec(line);
    if (m) { current = m[1].trim(); out[current] = out[current] || []; const rest = m[2]; if (rest) for (const n of rest.split(',')) { const v = parseFloat(n); if (Number.isFinite(v)) out[current].push(v); } continue; }
    if (current) for (const n of line.split(',')) { const v = parseFloat(n); if (Number.isFinite(v)) out[current].push(v); }
  }
  return out;
}

async function smapDay(g, { row, col }) {
  const od = (g.urls.find(u => /OPENDAP/i.test(u.subtype)) || {}).url;
  if (!od) return null;
  const ce = `/Soil_Moisture_Retrieval_Data_AM/soil_moisture[${row}][${col}];/Soil_Moisture_Retrieval_Data_PM/soil_moisture_pm[${row}][${col}]`;
  const res = await authFetch(`${od}.dap.csv?dap4.ce=${encodeURIComponent(ce)}`, { timeout: 25000 });
  const vals = Object.values(parseDapCsv(await res.text())).flat().filter(v => v >= 0 && v <= 1);
  if (!vals.length) return null;
  return { date: (g.start || '').slice(0, 10), sm: vals.reduce((a, b) => a + b, 0) / vals.length };
}

async function smap(aoi, now = new Date()) {
  if (!configured()) return notConnected;
  const c = centroid(aoi);
  const idx = easeIndex(c);
  const granules = (await cmrGranules(COLLECTIONS.SMAP, { point: c, days: 12, now, pageSize: 12 })).slice(0, 10);
  const days = (await Promise.all(granules.map(g => smapDay(g, idx).catch(err => { if (/refused/.test(err.message)) throw err; return null; })))).filter(Boolean);
  if (!days.length) return { available: false, reason: 'SMAP had no valid retrieval for this cell in the last 12 days (dense vegetation, frozen ground or gaps).' };
  days.sort((a, b) => b.date.localeCompare(a.date));
  const week = days.filter(d => d.date >= isoDay(daysAgo(7, now)));
  return {
    available: true,
    latest: { date: days[0].date, soilMoisture: round(days[0].sm, 3) },
    mean7d: week.length ? round(week.reduce((a, d) => a + d.sm, 0) / week.length, 3) : null,
    observations: days.length,
    resolutionKm: 9,
    cell: idx
  };
}

// ─── GRACE / GRACE-FO mascons: groundwater & total water storage ──
// Monthly liquid-water-equivalent anomaly (cm) vs the 2004–2009 mean, 0.5° grid.
const graceCache = new Map();
async function grace(aoi) {
  if (!configured()) return notConnected;
  const [lon, lat] = centroid(aoi);
  const latIdx = Math.round((lat + 89.75) / 0.5), lonIdx = Math.round((((lon % 360) + 360) % 360 - 0.25) / 0.5);
  const key = `${latIdx},${lonIdx}`;
  const hit = graceCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  // Each release is one file holding every month. The newest file can reach
  // OPeNDAP a few days after CMR, so fall back to the previous release.
  const granules = await cmrGranules(COLLECTIONS.GRACE, { pageSize: 4 });
  if (!granules.length) return { available: false, reason: 'No GRACE-FO granule found.' };
  let base = null, timeCsv = null, lastErr = null;
  for (const g of granules) {
    const opendap = g.urls.find(u => /opendap/i.test(u.url) && /^https:/.test(u.url));
    const candidate = opendap ? opendap.url.replace(/\.(html|dmr(\.xml)?)$/, '') : `${OPENDAP}/${COLLECTIONS.GRACE}/granules/${g.id}`;
    try {
      timeCsv = parseDapCsv(await (await authFetch(`${candidate}.dap.csv?dap4.ce=${encodeURIComponent('/time')}`, { timeout: 30000 })).text());
      base = candidate;
      break;
    } catch (err) { lastErr = err; }
  }
  if (!base) throw lastErr || new Error('GRACE-FO OPeNDAP unavailable');
  const times = Object.values(timeCsv).flat();
  if (!times.length) throw new Error('GRACE-FO time axis unavailable');
  const ce = `/lwe_thickness[0:1:${times.length - 1}][${latIdx}][${lonIdx}]`;
  const lwe = Object.values(parseDapCsv(await (await authFetch(`${base}.dap.csv?dap4.ce=${encodeURIComponent(ce)}`, { timeout: 30000 })).text())).flat();
  if (lwe.length !== times.length) throw new Error('GRACE-FO series length mismatch');

  // time = days since 2002-01-01
  const epoch = Date.UTC(2002, 0, 1);
  const series = times.map((t, i) => ({ date: new Date(epoch + t * 86400000).toISOString().slice(0, 10), cm: lwe[i] })).filter(p => Number.isFinite(p.cm) && Math.abs(p.cm) < 1000);
  const latest = series[series.length - 1];
  const yearAgo = series.slice().reverse().find(p => Math.abs(Date.parse(latest.date) - Date.parse(p.date) - 365 * 86400000) < 46 * 86400000);
  // Linear trend over the last 5 years (cm per year).
  const recent = series.filter(p => Date.parse(p.date) > Date.parse(latest.date) - 5 * 365.25 * 86400000);
  const xs = recent.map(p => Date.parse(p.date) / (365.25 * 86400000)), ys = recent.map(p => p.cm);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  const sorted = series.map(p => p.cm).sort((a, b) => a - b);
  const pct = Math.round((sorted.filter(v => v <= latest.cm).length / sorted.length) * 100);

  const value = {
    available: true,
    latest: { month: latest.date.slice(0, 7), anomalyCm: round(latest.cm, 1) },
    yearAgoAnomalyCm: yearAgo ? round(yearAgo.cm, 1) : null,
    changeVsYearAgoCm: yearAgo ? round(latest.cm - yearAgo.cm, 1) : null,
    trend5yCmPerYear: Number.isFinite(slope) ? round(slope, 2) : null,
    percentileOfRecord: pct,
    record: `${series[0].date.slice(0, 7)} to ${latest.date.slice(0, 7)}`,
    resolution: '~3° mascons on a 0.5° grid (regional, not farm-scale)'
  };
  graceCache.set(key, { value, expires: Date.now() + 12 * 60 * 60 * 1000 });
  return value;
}

module.exports = { configured, ecostress, smap, grace, cmrGranules, authFetch, signedTiff, mgrsEpsg, easeIndex, parseDapCsv, COLLECTIONS };
