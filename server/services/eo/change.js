// ─── Change over time: then vs now for one area ─────────────
// Picks the clearest Sentinel-2 scene near a past date (e.g. three years
// ago) and the newest clear scene, reads both on the same 10 m grid, and
// returns matching pictures (natural colour and vegetation health), a
// change map (greener / less green) and plain-language findings.

const { stacSearch, signedHref, isoDay } = require('./net');
const { makeGrid, readBand } = require('./raster');
const { toDataUrl } = require('./png');
const { areaHa, httpError } = require('./geo');
const s2 = require('./sentinel2');

const COLLECTION = 'sentinel-2-l2a';
const CLEAR = new Set([4, 5, 6, 7]);
// Choosing a scene is stricter: "unclassified" (7) is often thin cloud or haze edges.
const SURE = new Set([4, 5, 6]);
const WATER_SCL = 6;
const DAY = 86400000;
const MAX_MONTHS = 96;
const cache = new Map();

const epsgOf = item => Number(item.properties['proj:epsg'] || String(item.properties['proj:code'] || '').replace('EPSG:', ''));
const sign = (item, key) => signedHref(COLLECTION, item.assets[key].href);
const when = item => Date.parse(item.properties.datetime);

// The picture frame: the area plus an 18% margin, like the report pictures.
function frameOf(aoi) {
  const ring = aoi.coordinates[0];
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const px = (x1 - x0) * 0.18, py = (y1 - y0) * 0.18;
  return { type: 'Polygon', coordinates: [[[x0 - px, y0 - py], [x1 + px, y0 - py], [x1 + px, y1 + py], [x0 - px, y1 + py], [x0 - px, y0 - py]]] };
}

async function search(aoi, from, to) {
  return stacSearch({
    collections: [COLLECTION], intersects: aoi,
    datetime: `${isoDay(new Date(from))}T00:00:00Z/${isoDay(new Date(to))}T23:59:59Z`,
    query: { 'eo:cloud_cover': { lt: 60 } }, limit: 40
  });
}

// First candidate (in the given order) whose area is clear; else the clearest.
// newest: take the first (newest) pass that is clean enough instead of the cleanest.
async function pickClear(items, gridFor, aoi, tries = 6, newest = false) {
  let best = null;
  for (const item of items.slice(0, tries)) {
    const grid = gridFor(epsgOf(item));
    if (!grid) continue;
    const scl = await readBand(await sign(item, 'SCL'), grid, 0);
    let covered = 0, clear = 0;
    for (let i = 0; i < scl.length; i++) if (grid.mask[i] && scl[i]) { covered++; if (SURE.has(scl[i])) clear++; }
    const c = { item, grid, scl, coverage: covered / grid.inside, clearFrac: covered ? clear / covered : 0, haze: 0 };
    if (c.coverage < 0.9 || c.clearFrac < 0.6) continue;
    // Thin cloud and haze the mask misses are bright and whitish-blue.
    const R = s2._internal.reflectanceFn(item);
    const [blue, red] = await Promise.all([readBand(await sign(item, 'B02'), grid, 0), readBand(await sign(item, 'B04'), grid, 0)]);
    let bright = 0, land = 0;
    for (let i = 0; i < blue.length; i++) {
      if (!scl[i] || scl[i] === WATER_SCL) continue;
      const b = R(blue[i]), r = R(red[i]);
      if (!Number.isFinite(b) || !Number.isFinite(r)) continue;
      land++;
      // Whitish-blue and bright: haze or thin cloud (bare soil is redder).
      if (b > 0.12 && b > 0.85 * r) bright++;
    }
    c.haze = land ? bright / land : 0;
    c.score = c.clearFrac - 3 * c.haze;
    if (!best || c.score > best.score) best = c;
    if (newest && c.clearFrac >= 0.9 && c.haze < 0.02) return c;
    if (c.clearFrac >= 0.99 && c.haze < 0.005) break;   // clean enough: stop looking
  }
  return best && best.clearFrac >= 0.6 ? best : null;
}

async function readScene(pick) {
  const { item, grid, scl } = pick;
  const R = s2._internal.reflectanceFn(item);
  const [B02, B03, B04, B08, B11] = await Promise.all(['B02', 'B03', 'B04', 'B08', 'B11'].map(async k => readBand(await sign(item, k), grid, 0)));
  const n = grid.width * grid.height;
  const ndvi = new Float32Array(n).fill(NaN), water = new Uint8Array(n), clear = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!CLEAR.has(scl[i])) continue;
    const b3 = R(B03[i]), b4 = R(B04[i]), b8 = R(B08[i]), b11 = R(B11[i]);
    if (![b3, b4, b8, b11].every(Number.isFinite)) continue;
    clear[i] = 1;
    if (scl[i] === WATER_SCL || (b3 - b11) / (b3 + b11) > 0.2) water[i] = 1;
    else ndvi[i] = (b8 - b4) / (b8 + b4);
  }
  const images = s2._internal.fieldImages(grid, scl, { B02, B03, B04, B08, B11 }, R);
  return { date: String(item.properties.datetime).slice(0, 10), ndvi, water, clear, images, rgb: { B02, B03, B04, R } };
}

function statsOf(scene, grid) {
  const pxHa = (grid.res * grid.res) / 10000;
  let land = 0, sum = 0, green = 0, bare = 0, water = 0, clear = 0;
  for (let i = 0; i < scene.ndvi.length; i++) {
    if (!grid.mask[i]) continue;
    if (scene.clear[i]) clear++;
    if (scene.water[i]) { water++; continue; }
    const v = scene.ndvi[i];
    if (!Number.isFinite(v)) continue;
    land++; sum += v;
    if (v >= 0.4) green++;
    if (v < 0.2) bare++;
  }
  const pct = x => (land ? Math.round((x / land) * 1000) / 10 : null);
  return {
    meanNdvi: land ? Math.round((sum / land) * 100) / 100 : null,
    greenCoverPct: pct(green), bareSoilPct: pct(bare),
    openWaterHa: Math.round(water * pxHa * 10) / 10,
    clearPct: Math.round((clear / grid.inside) * 100)
  };
}

// Change classes and colours for the change map.
const CHANGE = [
  [-Infinity, -0.3, [165, 0, 38], 'Much less green (fall of more than 0.3)'],
  [-0.3, -0.1, [244, 109, 67], 'Less green (fall of 0.1 to 0.3)'],
  [-0.1, 0.1, [238, 238, 228], 'About the same (within ±0.1)'],
  [0.1, 0.3, [120, 198, 121], 'Greener (rise of 0.1 to 0.3)'],
  [0.3, Infinity, [0, 104, 55], 'Much greener (rise of more than 0.3)']
];

function changeMap(grid, then, now) {
  const n = grid.width * grid.height, W = grid.width, H = grid.height;
  const rgba = new Uint8Array(n * 4), counts = new Array(CHANGE.length).fill(0);
  const { B02, B03, B04, R } = now.rgb;
  const grey = v => Math.max(0, Math.min(255, Math.round(255 * Math.pow(Math.max(0, v) * 3.6, 0.8))));
  let sumD = 0, nD = 0;
  for (let i = 0; i < n; i++) {
    const inside = grid.mask[i] === 1;
    const a = then.ndvi[i], b = now.ndvi[i];
    if (inside && Number.isFinite(a) && Number.isFinite(b)) {
      const d = b - a;
      const k = CHANGE.findIndex(([lo, hi]) => d >= lo && d < hi);
      counts[k]++; sumD += d; nD++;
      rgba.set([...CHANGE[k][2], 255], i * 4);
    } else {
      // Context: the newest image in grey, faded.
      const g = Math.round((grey(R(B04[i])) + grey(R(B03[i])) + grey(R(B02[i]))) / 3);
      rgba.set([g, g, g, inside ? 255 : 120], i * 4);
    }
  }
  const edge = i => { const r = Math.floor(i / W), c = i % W; return [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].some(([rr, cc]) => rr < 0 || cc < 0 || rr >= H || cc >= W || !grid.mask[rr * W + cc]); };
  for (let i = 0; i < n; i++) if (grid.mask[i] && edge(i)) rgba.set([255, 213, 79, 255], i * 4);
  const pxHa = (grid.res * grid.res) / 10000;
  const pct = c => (nD ? Math.round((c / nD) * 1000) / 10 : 0);
  return {
    image: toDataUrl(W, H, rgba),
    legend: CHANGE.map(([, , color, label], k) => ({ label, color, pct: pct(counts[k]), ha: Math.round(counts[k] * pxHa * 10) / 10 })),
    meanChange: nD ? Math.round((sumD / nD) * 100) / 100 : null,
    comparedPct: Math.round((nD / grid.inside) * 100),
    declinedPct: pct(counts[0] + counts[1]), improvedPct: pct(counts[3] + counts[4]), stablePct: pct(counts[2])
  };
}

const monthName = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function findings(then, now, s0, s1, ch, months, ha) {
  const out = [];
  const span = months >= 12 && months % 12 === 0 ? `${months / 12} year${months > 12 ? 's' : ''}` : `${months} month${months > 1 ? 's' : ''}`;
  if (s0.meanNdvi !== null && s1.meanNdvi !== null) {
    const d = Math.round((s1.meanNdvi - s0.meanNdvi) * 100) / 100;
    const verb = d <= -0.1 ? 'fell' : d >= 0.1 ? 'rose' : 'stayed about the same';
    out.push(`Average greenness (NDVI) ${verb}${Math.abs(d) >= 0.1 ? ` from ${s0.meanNdvi} to ${s1.meanNdvi} (${d > 0 ? '+' : ''}${d})` : ` (${s0.meanNdvi} then, ${s1.meanNdvi} now)`} between ${monthName(then.date)} and ${monthName(now.date)}, ${span} apart.`);
  }
  out.push(`${ch.declinedPct}% of the area is less green than then (about ${Math.round(ha * ch.declinedPct / 100 * 10) / 10} ha), ${ch.improvedPct}% is greener and ${ch.stablePct}% is about the same.`);
  if (s0.greenCoverPct !== null && s1.greenCoverPct !== null && Math.abs(s1.greenCoverPct - s0.greenCoverPct) >= 5) {
    out.push(`Well-vegetated cover ${s1.greenCoverPct > s0.greenCoverPct ? 'grew' : 'shrank'} from ${s0.greenCoverPct}% to ${s1.greenCoverPct}% of the area.`);
  }
  if (Math.abs(s1.openWaterHa - s0.openWaterHa) >= 0.5) {
    out.push(`Open water ${s1.openWaterHa > s0.openWaterHa ? 'increased' : 'decreased'} from ${s0.openWaterHa} ha to ${s1.openWaterHa} ha.`);
  }
  const gap = Math.abs((Date.parse(now.date) - Date.parse(then.date)) / DAY) % 365.25;
  const sameSeason = Math.min(gap, 365.25 - gap) <= 45;
  out.push(sameSeason
    ? 'Both images are from the same time of year, so the difference reflects real change rather than the normal growing cycle.'
    : 'The two images are from different times of year, so part of the difference is the normal growing cycle (planting, growth and harvest). Choose a whole number of years to compare the same season.');
  return out;
}

async function compare(aoi, months, now = new Date()) {
  months = Math.round(Number(months));
  if (!Number.isFinite(months) || months < 1 || months > MAX_MONTHS) throw httpError(400, `Choose a period between 1 month and ${MAX_MONTHS / 12} years.`);
  const key = JSON.stringify(aoi.coordinates[0].map(([x, y]) => [x.toFixed(4), y.toFixed(4)])) + `|${months}|${isoDay(now)}`;
  if (cache.has(key)) return cache.get(key);

  const frame = frameOf(aoi);
  const grids = new Map();
  const gridFor = epsg => {
    if (!grids.has(epsg)) grids.set(epsg, makeGrid(frame, epsg, 10, aoi));
    return grids.get(epsg);
  };

  // Newest clear scene in the last 60 days.
  const recent = await search(aoi, now.getTime() - 60 * DAY, now.getTime());
  const nowPick = await pickClear(recent, gridFor, aoi, 6, true);
  if (!nowPick) return { available: false, reason: 'Every satellite pass over this area in the last 60 days was cloudy. Try again after the next clear pass.' };

  // Past scene: closest clear pass to the target date, on the same grid.
  const target = now.getTime() - months * 30.4375 * DAY;
  const span = months >= 12 ? 40 : 20;
  const past = (await search(aoi, target - span * DAY, target + span * DAY))
    .filter(it => epsgOf(it) === nowPick.grid.epsg)
    .sort((a, b) => Math.abs(when(a) - target) - Math.abs(when(b) - target));
  const thenPick = await pickClear(past, gridFor, aoi, 5);
  if (!thenPick) return { available: false, reason: `No clear satellite image of this area was found around ${monthName(isoDay(new Date(target)))}. Try a slightly different period.` };

  const [then, nowScene] = await Promise.all([readScene(thenPick), readScene(nowPick)]);
  const grid = nowPick.grid;
  const s0 = statsOf(then, grid), s1 = statsOf(nowScene, grid);
  const ch = changeMap(grid, then, nowScene);
  const ha = Math.round(areaHa(aoi) * 100) / 100;
  const result = {
    available: true,
    months,
    areaHa: ha,
    then: { date: then.date, images: then.images, stats: s0 },
    now: { date: nowScene.date, images: nowScene.images, stats: s1 },
    change: ch,
    findings: findings(then, nowScene, s0, s1, ch, months, ha),
    pixelM: Math.round(grid.res),
    generatedAt: new Date().toISOString()
  };
  cache.set(key, result);
  if (cache.size > 30) cache.delete(cache.keys().next().value);
  return result;
}

module.exports = { compare, MAX_MONTHS, _internal: { changeMap, findings, statsOf, CHANGE } };
