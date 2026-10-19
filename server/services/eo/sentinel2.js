// ─── Sentinel-2 L2A (ESA Copernicus, 10–20 m, ~5-day revisit) ─
// Crop vigour, nitrogen, canopy water, bare soil, open-water extent and
// optical water quality for the AOI, from the newest scene that is clear
// over the AOI itself (not just clear on average across the 110 km tile).

const { stacSearch, signedHref, isoDay, daysAgo } = require('./net');
const { makeGrid, readBand, stats } = require('./raster');

const COLLECTION = 'sentinel-2-l2a';
const CLEAR = new Set([4, 5, 6, 7]);  // SCL: vegetation, bare soil, water, unclassified
const WATER_SCL = 6;

const epsgOf = item => Number(item.properties['proj:epsg'] || String(item.properties['proj:code'] || '').replace('EPSG:', ''));

// L2A baseline ≥ 04.00 stores reflectance with a +1000 offset.
function reflectanceFn(item) {
  const baseline = parseFloat(item.properties['s2:processing_baseline'] || '0');
  const offset = baseline >= 4 ? 1000 : 0;
  return dn => (dn === 0 ? NaN : (dn - offset) / 10000);
}

const sign = (item, key) => signedHref(COLLECTION, item.assets[key].href);

async function candidates(aoi, fromDays, toDays, maxCloud, now) {
  return stacSearch({
    collections: [COLLECTION],
    intersects: aoi,
    datetime: `${isoDay(daysAgo(fromDays, now))}T00:00:00Z/${isoDay(daysAgo(toDays, now))}T23:59:59Z`,
    query: { 'eo:cloud_cover': { lt: maxCloud } },
    limit: 12
  });
}

// Read the scene classification layer and measure how clear the AOI is.
async function clearness(item, aoi) {
  const grid = makeGrid(aoi, epsgOf(item), 20);
  const scl = await readBand(await sign(item, 'SCL'), grid, 0);
  let covered = 0, clear = 0;
  for (let i = 0; i < scl.length; i++) {
    if (!grid.mask[i] || scl[i] === 0) continue;
    covered++;
    if (CLEAR.has(scl[i])) clear++;
  }
  return { item, scl, grid, coverage: covered / grid.inside, clearFrac: covered ? clear / covered : 0 };
}

// Newest scene whose AOI is mostly cloud-free; checks up to `tries` scenes.
async function bestScene(aoi, fromDays, toDays, now, tries = 4) {
  const items = await candidates(aoi, fromDays, toDays, 60, now);
  let best = null;
  for (const item of items.slice(0, tries)) {
    const c = await clearness(item, aoi);
    if (c.coverage < 0.5) continue;           // AOI mostly outside this tile
    if (!best || c.clearFrac > best.clearFrac) best = c;
    if (c.clearFrac >= 0.8) break;
  }
  return best;
}

// Full analysis of the latest clear scene.
async function analyzeLatest(aoi, now = new Date()) {
  const pick = await bestScene(aoi, 60, 0, now, 5);
  if (!pick) return { available: false, reason: 'No Sentinel-2 scene in the last 60 days covers this area with usable sky.' };
  if (pick.clearFrac < 0.2) return { available: false, reason: 'Every recent Sentinel-2 pass over this area was cloudy.', scene: sceneInfo(pick) };

  // Scene chosen on the 20 m cloud mask; now read every band at full 10 m.
  const { item } = pick;
  const grid = makeGrid(aoi, epsgOf(item), 10);
  const keys = ['SCL', 'B02', 'B03', 'B04', 'B05', 'B08', 'B11'];
  const raw = await Promise.all(keys.map(async k => readBand(await sign(item, k), grid, 0)));
  const R = reflectanceFn(item);
  const [scl, B02, B03, B04, B05, B08, B11] = raw;

  const pxHa = (grid.res * grid.res) / 10000;
  const idx = { ndvi: [], evi: [], savi: [], ndre: [], cire: [], ndmi: [], bsi: [] };
  const water = { ndti: [], ndci: [], mndwi: [] };
  let land = 0, waterPx = 0, veg = 0, sparse = 0, bare = 0, cloudy = 0;

  for (let i = 0; i < grid.mask.length; i++) {
    if (!grid.mask[i] || scl[i] === 0) continue;
    if (!CLEAR.has(scl[i])) { cloudy++; continue; }
    const b2 = R(B02[i]), b3 = R(B03[i]), b4 = R(B04[i]), b5 = R(B05[i]), b8 = R(B08[i]), b11 = R(B11[i]);
    if (![b2, b3, b4, b5, b8, b11].every(Number.isFinite)) continue;
    const mndwi = (b3 - b11) / (b3 + b11);
    if (scl[i] === WATER_SCL || mndwi > 0.2) {
      waterPx++;
      water.mndwi.push(mndwi);
      water.ndti.push((b4 - b3) / (b4 + b3));   // turbidity / suspended sediment
      water.ndci.push((b5 - b4) / (b5 + b4));   // chlorophyll-a (algae)
      continue;
    }
    land++;
    const ndvi = (b8 - b4) / (b8 + b4);
    idx.ndvi.push(ndvi);
    idx.evi.push(2.5 * (b8 - b4) / (b8 + 6 * b4 - 7.5 * b2 + 1));
    idx.savi.push(1.5 * (b8 - b4) / (b8 + b4 + 0.5));
    idx.ndre.push((b8 - b5) / (b8 + b5));
    idx.cire.push(b8 / b5 - 1);
    idx.ndmi.push((b8 - b11) / (b8 + b11));
    idx.bsi.push(((b11 + b4) - (b8 + b2)) / ((b11 + b4) + (b8 + b2)));
    if (ndvi >= 0.4) veg++; else if (ndvi >= 0.2) sparse++; else bare++;
  }

  const clearPx = land + waterPx;
  const pct = n => (clearPx ? Math.round((n / clearPx) * 1000) / 10 : 0);
  const out = {
    available: true,
    scene: { ...sceneInfo(pick), resolutionM: Math.round(grid.res) },
    indices: Object.fromEntries(Object.entries(idx).map(([k, v]) => [k, stats(v)])),
    cover: { vegetatedPct: pct(veg), sparsePct: pct(sparse), barePct: pct(bare), waterPct: pct(waterPx), cloudPct: Math.round((cloudy / Math.max(1, cloudy + clearPx)) * 1000) / 10 },
    water: { areaHa: round(waterPx * pxHa, 2), pixels: waterPx, ndti: stats(water.ndti), ndci: stats(water.ndci), mndwi: stats(water.mndwi) },
    landHa: round(land * pxHa, 1)
  };
  return out;
}

// Mean NDVI of the clearest scene in a past window (for trends and anomalies).
async function ndviInWindow(aoi, fromDays, toDays, now = new Date()) {
  const pick = await bestScene(aoi, fromDays, toDays, now, 3);
  if (!pick || pick.clearFrac < 0.3) return null;
  const { item, grid, scl } = pick;
  const [B04, B08] = await Promise.all(['B04', 'B08'].map(async k => readBand(await sign(item, k), grid, 0)));
  const R = reflectanceFn(item);
  const v = [];
  for (let i = 0; i < grid.mask.length; i++) {
    if (!grid.mask[i] || scl[i] === 0 || scl[i] === WATER_SCL || !CLEAR.has(scl[i])) continue;
    const b4 = R(B04[i]), b8 = R(B08[i]);
    if (Number.isFinite(b4) && Number.isFinite(b8)) v.push((b8 - b4) / (b8 + b4));
  }
  const s = stats(v);
  return s && { date: item.properties.datetime.slice(0, 10), ndvi: round(s.mean, 3), clearPct: Math.round(pick.clearFrac * 100) };
}

// Monthly mean NDVI for the last `months` calendar months (clearest scene
// in each month). Months with no usable imagery come back as ndvi: null.
async function ndviSeries(aoi, months = 24, now = new Date()) {
  const DAY = 86400000;
  const windows = [];
  for (let m = months - 1; m >= 0; m--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m + 1, 0));
    windows.push({
      month: start.toISOString().slice(0, 7),
      fromDays: Math.ceil((now - start) / DAY),
      toDays: Math.max(0, Math.floor((now - end) / DAY))
    });
  }
  const out = new Array(windows.length);
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < windows.length) {
      const i = next++, w = windows[i];
      const r = await ndviInWindow(aoi, w.fromDays, w.toDays, now).catch(() => null);
      out[i] = { month: w.month, ndvi: r ? r.ndvi : null, date: r ? r.date : null, clearPct: r ? r.clearPct : null };
    }
  }));
  return out;
}

function sceneInfo(pick) {
  const p = pick.item.properties;
  return {
    id: pick.item.id,
    date: p.datetime.slice(0, 10),
    platform: p.platform || 'Sentinel-2',
    tileCloudPct: round(p['eo:cloud_cover'], 1),
    aoiClearPct: Math.round(pick.clearFrac * 100)
  };
}

const round = (v, d = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

module.exports = { analyzeLatest, ndviInWindow, ndviSeries };
