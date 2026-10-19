// ─── iSDAsoil (iSDA Africa): 30 m soil nutrients for Africa ──
// Needs a free account: ISDA_USERNAME / ISDA_PASSWORD.
// API: POST /login (form) -> bearer token; GET /isdasoil/v2/soilproperty.

const { UA } = require('./net');
const { centroid } = require('./geo');

const BASE = 'https://api.isda-africa.com';
let tokenCache = null; // { token, expires }

const configured = () => !!(process.env.ISDA_USERNAME && process.env.ISDA_PASSWORD);

async function login() {
  if (tokenCache && tokenCache.expires > Date.now()) return tokenCache.token;
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams({ username: process.env.ISDA_USERNAME, password: process.env.ISDA_PASSWORD }),
    signal: AbortSignal.timeout(15000)
  });
  if (res.status === 401 || res.status === 422) throw new Error('iSDA rejected the username or password.');
  if (!res.ok) throw new Error(`iSDA login returned ${res.status}`);
  const j = await res.json();
  // Tokens last about an hour; refresh a little early.
  tokenCache = { token: j.access_token, expires: Date.now() + 50 * 60 * 1000 };
  return j.access_token;
}

async function depthQuery(lon, lat, depth) {
  const url = `${BASE}/isdasoil/v2/soilproperty?lon=${lon.toFixed(5)}&lat=${lat.toFixed(5)}&depth=${depth}`;
  let token = await login();
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (res.status === 401) { tokenCache = null; token = await login(); res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA }, signal: AbortSignal.timeout(20000) }); }
  if (!res.ok) throw new Error(`iSDA returned ${res.status}`);
  const j = await res.json();
  const out = {};
  for (const [prop, rows] of Object.entries(j.property || {})) {
    const r = Array.isArray(rows) ? rows[0] : null;
    if (!r || !r.value) continue;
    out[prop] = { value: r.value.value, unit: r.value.unit || null };
  }
  return out;
}

// Nutrients at the AOI centre for topsoil (0–20 cm) and subsoil (20–50 cm).
async function isdaSoil(aoi) {
  if (!configured()) return { available: false, reason: 'Not connected: set ISDA_USERNAME and ISDA_PASSWORD.' };
  const [lon, lat] = centroid(aoi);
  const [top, sub] = await Promise.all([depthQuery(lon, lat, '0-20'), depthQuery(lon, lat, '20-50')]);
  if (!Object.keys(top).length) return { available: false, reason: 'iSDAsoil has no data here (outside Africa or not soil).' };
  return { available: true, source: 'iSDAsoil 30 m (iSDA Africa)', topsoil: top, subsoil: sub };
}

// Pull a number out of an iSDA property (values can be numbers or numeric strings).
function num(layer, prop) {
  const v = layer && layer[prop] && layer[prop].value;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

module.exports = { isdaSoil, configured, num };
