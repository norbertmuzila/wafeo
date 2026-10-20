// ─── Click-to-select a field ─────────────────────────────────
// Given one point, find the field it falls in from the newest clear
// Sentinel-2 scene (10 m): grow a region of spectrally similar pixels
// from the click, tidy it, and trace its outline as a lon/lat polygon.

const proj4 = require('proj4');
const { stacSearch, signedHref, isoDay, daysAgo } = require('./net');
const { makeGrid, readBand } = require('./raster');
const { normalizeAoi, projDef, areaHa, httpError } = require('./geo');

const COLLECTION = 'sentinel-2-l2a';
const CLEAR = new Set([4, 5, 6, 7]);
const WINDOW_M = 900;     // search radius around the click
const cache = new Map();

const epsgOf = item => Number(item.properties['proj:epsg'] || String(item.properties['proj:code'] || '').replace('EPSG:', ''));
const reflectance = item => {
  const offset = parseFloat(item.properties['s2:processing_baseline'] || '0') >= 4 ? 1000 : 0;
  return dn => (dn === 0 ? NaN : (dn - offset) / 10000);
};

// Newest scene in which the click itself and most of the window are clear.
async function pickScene(win, now) {
  const items = await stacSearch({
    collections: [COLLECTION], intersects: win,
    datetime: `${isoDay(daysAgo(90, now))}T00:00:00Z/${isoDay(now)}T23:59:59Z`,
    query: { 'eo:cloud_cover': { lt: 50 } }, limit: 10
  });
  if (!items.length) return { none: true };
  for (const item of items.slice(0, 5)) {
    const grid = makeGrid(win, epsgOf(item), 10);
    const scl = await readBand(await signedHref(COLLECTION, item.assets.SCL.href), grid, 0);
    const centre = Math.floor(grid.height / 2) * grid.width + Math.floor(grid.width / 2);
    let clear = 0, covered = 0;
    for (let i = 0; i < scl.length; i++) if (grid.mask[i] && scl[i]) { covered++; if (CLEAR.has(scl[i])) clear++; }
    if (covered / grid.inside > 0.8 && clear / covered > 0.85 && CLEAR.has(scl[centre])) return { item, grid, scl };
  }
  return null;
}

// Region growing on NDVI + NIR + SWIR, comparing each candidate with the
// running mean of the field and with its neighbour (stops at field edges).
function grow(grid, f, seed, scl) {
  const { width: W, height: H } = grid;
  const inField = new Uint8Array(W * H);
  const sum = [0, 0, 0];
  let n = 0;
  // Seed statistics from the 3 × 3 block around the click.
  const sr = Math.floor(seed / W), sc = seed % W;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const i = (sr + dr) * W + sc + dc;
    if (Number.isFinite(f.ndvi[i])) { sum[0] += f.ndvi[i]; sum[1] += f.nir[i]; sum[2] += f.swir[i]; n++; }
  }
  if (!n) return null;
  const mean = () => [sum[0] / n, sum[1] / n, sum[2] / n];
  const add = i => { inField[i] = 1; sum[0] += f.ndvi[i]; sum[1] += f.nir[i]; sum[2] += f.swir[i]; n++; };
  add(seed);
  const queue = [seed];
  const tol = TOL;
  while (queue.length) {
    const i = queue.shift();
    const r = Math.floor(i / W), c = i % W;
    const m = mean();
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
      const j = rr * W + cc;
      if (inField[j] || !grid.mask[j] || !CLEAR.has(scl[j]) || !Number.isFinite(f.ndvi[j])) continue;
      if (Math.abs(f.ndvi[j] - f.ndvi[i]) > tol.step) continue;
      if (Math.abs(f.ndvi[j] - m[0]) > tol.ndvi || Math.abs(f.nir[j] - m[1]) > tol.nir || Math.abs(f.swir[j] - m[2]) > tol.swir) continue;
      add(j); queue.push(j);
    }
  }
  return inField;
}

const TOL = { ndvi: 0.09, nir: 0.05, swir: 0.04, step: 0.05 };

function smooth(a, W, H) {
  const out = new Float32Array(a.length);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    let s = 0, n = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
      const v = a[rr * W + cc];
      if (Number.isFinite(v)) { s += v; n++; }
    }
    out[r * W + c] = n ? s / n : NaN;
  }
  return out;
}

// Fill holes (anything not reachable from the border) and shave thin spurs.
function tidy(grown, W, H, seed) {
  const mask = morph(morph(grown, W, H, nb => nb.some(Boolean)), W, H, nb => nb.every(Boolean)); // closing
  mask[seed] = 1;
  const outside = new Uint8Array(W * H), stack = [];
  for (let c = 0; c < W; c++) stack.push(c, (H - 1) * W + c);
  for (let r = 0; r < H; r++) stack.push(r * W, r * W + W - 1);
  while (stack.length) {
    const i = stack.pop();
    if (outside[i] || mask[i]) continue;
    outside[i] = 1;
    const r = Math.floor(i / W), c = i % W;
    if (r > 0) stack.push(i - W); if (r < H - 1) stack.push(i + W);
    if (c > 0) stack.push(i - 1); if (c < W - 1) stack.push(i + 1);
  }
  const filled = new Uint8Array(W * H);
  for (let i = 0; i < filled.length; i++) filled[i] = outside[i] ? 0 : 1;
  // Opening (erode then dilate) removes thin bridges into neighbouring fields.
  let opened = morph(morph(filled, W, H, nb => nb.every(Boolean)), W, H, nb => nb.some(Boolean));
  if (!opened[seed]) opened = filled; // a very narrow field: keep it as grown
  // Keep only the piece connected to the click.
  const out = new Uint8Array(W * H), st = [seed];
  while (st.length) {
    const i = st.pop();
    if (out[i] || !opened[i]) continue;
    out[i] = 1;
    const r = Math.floor(i / W), c = i % W;
    if (r > 0) st.push(i - W); if (r < H - 1) st.push(i + W);
    if (c > 0) st.push(i - 1); if (c < W - 1) st.push(i + 1);
  }
  return out;
}

// 3 × 3 binary morphology step.
function morph(src, W, H, keep) {
  const out = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const nb = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      nb.push(rr >= 0 && cc >= 0 && rr < H && cc < W ? src[rr * W + cc] : 0);
    }
    out[r * W + c] = keep(nb) ? 1 : 0;
  }
  return out;
}

// Trace the outer outline along pixel edges (region kept on the right).
function outline(mask, W, H) {
  const at = (r, c) => r >= 0 && c >= 0 && r < H && c < W && mask[r * W + c] === 1;
  const edges = new Map(); // "x,y" -> list of [x2,y2]
  const addEdge = (x1, y1, x2, y2) => {
    const k = x1 + ',' + y1;
    if (!edges.has(k)) edges.set(k, []);
    edges.get(k).push([x2, y2]);
  };
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (!at(r, c)) continue;
    if (!at(r - 1, c)) addEdge(c, r, c + 1, r);
    if (!at(r, c + 1)) addEdge(c + 1, r, c + 1, r + 1);
    if (!at(r + 1, c)) addEdge(c + 1, r + 1, c, r + 1);
    if (!at(r, c - 1)) addEdge(c, r + 1, c, r);
  }
  let best = [];
  while (edges.size) {
    const startKey = edges.keys().next().value;
    let [x, y] = startKey.split(',').map(Number);
    const loop = [[x, y]];
    let prev = null;
    for (;;) {
      const k = x + ',' + y, outs = edges.get(k);
      if (!outs || !outs.length) break;
      // At a pinch point prefer turning right, which keeps loops simple.
      let idx = 0;
      if (outs.length > 1 && prev) {
        const dir = [x - prev[0], y - prev[1]];
        const right = [-dir[1], dir[0]];
        idx = Math.max(0, outs.findIndex(([nx, ny]) => nx - x === right[0] && ny - y === right[1]));
      }
      const [nx, ny] = outs.splice(idx, 1)[0];
      if (!outs.length) edges.delete(k);
      prev = [x, y]; x = nx; y = ny;
      loop.push([x, y]);
      if (x + ',' + y === startKey) break;
    }
    if (loop.length > best.length) best = loop;
  }
  return best;
}

// Douglas–Peucker simplification (tolerance in pixels).
function simplify(pts, tol) {
  if (pts.length < 4) return pts;
  const d = (p, a, b) => {
    const [x, y] = p, [x1, y1] = a, [x2, y2] = b;
    const L = Math.hypot(x2 - x1, y2 - y1) || 1e-9;
    return Math.abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1) / L;
  };
  const rec = (s, e, out) => {
    let max = 0, idx = -1;
    for (let i = s + 1; i < e; i++) { const v = d(pts[i], pts[s], pts[e]); if (v > max) { max = v; idx = i; } }
    if (max > tol) { rec(s, idx, out); out.pop(); rec(idx, e, out); } else out.push(pts[s], pts[e]);
    return out;
  };
  // Split the closed ring at its far point so both halves simplify cleanly.
  const far = pts.reduce((b, p, i) => (Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) > Math.hypot(pts[b][0] - pts[0][0], pts[b][1] - pts[0][1]) ? i : b), 0);
  const a = rec(0, far, []); a.pop();
  const b = rec(far, pts.length - 1, []);
  return a.concat(b);
}

async function traceField([lon, lat], now = new Date()) {
  if (![lon, lat].every(Number.isFinite) || Math.abs(lat) > 85 || Math.abs(lon) > 180) throw httpError(400, 'Click a point on land.');
  const key = `${lon.toFixed(4)},${lat.toFixed(4)},${isoDay(now)}`;
  if (cache.has(key)) return cache.get(key);

  const win = normalizeAoi({ point: [lon, lat], radius_m: WINDOW_M });
  const pick = await pickScene(win, now);
  if (pick && pick.none) return { found: false, reason: 'No recent satellite images cover this spot (open sea or a polar area). Click a field on land.' };
  if (!pick) return { found: false, reason: 'Recent satellite passes over this spot were cloudy, so its edges could not be traced. Use the circle or draw the field instead.' };

  const { item, grid, scl } = pick;
  const R = reflectance(item);
  const [B04, B08, B11] = await Promise.all(['B04', 'B08', 'B11'].map(async k => readBand(await signedHref(COLLECTION, item.assets[k].href), grid, 0)));
  const N = grid.width * grid.height;
  const f = { ndvi: new Float32Array(N), nir: new Float32Array(N), swir: new Float32Array(N) };
  for (let i = 0; i < N; i++) {
    const r = R(B04[i]), n = R(B08[i]), s = R(B11[i]);
    f.ndvi[i] = (n - r) / (n + r); f.nir[i] = n; f.swir[i] = s;
  }
  // Light 3 × 3 smoothing so crop rows and texture do not stop the growth.
  for (const k of Object.keys(f)) f[k] = smooth(f[k], grid.width, grid.height);
  const seed = Math.floor(grid.height / 2) * grid.width + Math.floor(grid.width / 2);
  if (scl[seed] === 6) return { found: false, reason: 'That point is open water. Click inside a field.' };
  const grown = grow(grid, f, seed, scl);
  if (!grown) return { found: false, reason: 'No clear pixels at that point.' };
  const field = tidy(grown, grid.width, grid.height, seed);
  let px = 0, ndviSum = 0;
  for (let i = 0; i < N; i++) if (field[i]) { px++; ndviSum += f.ndvi[i]; }
  if (px < 6) return { found: false, reason: 'No distinct field was found at that point (it may be a road, building or field edge). Click nearer the middle of a field.' };

  const ring = simplify(outline(field, grid.width, grid.height), 1.2);
  const inv = proj4('EPSG:4326', projDef(grid.epsg)).inverse;
  const coords = ring.map(([c, r]) => inv([grid.bbox[0] + c * grid.res, grid.bbox[3] - r * grid.res]).map(v => Math.round(v * 1e6) / 1e6));
  const first = coords[0], last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coords.push([...first]);
  const geometry = { type: 'Polygon', coordinates: [coords] };
  // A region that fills most of the search window has no clear edge.
  const touchesEdge = px > grid.inside * 0.6;
  const result = {
    found: true,
    geometry,
    areaHa: Math.round(areaHa(geometry) * 100) / 100,
    meanNdvi: Math.round((ndviSum / px) * 100) / 100,
    pixels: px,
    sceneDate: String(item.properties.datetime).slice(0, 10),
    note: touchesEdge ? 'This area has no sharp edge nearby, so the outline was limited to about 1 km around your click.' : null
  };
  cache.set(key, result);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return result;
}

module.exports = { traceField, _internal: { grow, tidy, outline, simplify, TOL } };
