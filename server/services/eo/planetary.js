// ─── Other Planetary Computer layers for the AOI ─────────────
// Landsat 8/9 thermal (heat stress), Copernicus DEM (terrain, erosion),
// ESA WorldCover (land use) and JRC Global Surface Water (water history).

const { stacSearch, signedHref, isoDay, daysAgo } = require('./net');
const { makeGrid, readBand, stats } = require('./raster');
const { centroid, pointInRing } = require('./geo');

const epsgOf = item => Number(item.properties['proj:epsg'] || String(item.properties['proj:code'] || '').replace('EPSG:', '')) || 4326;
const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

// Prefer the tile that contains the AOI centre.
function tileForCentre(items, aoi) {
  const [x, y] = centroid(aoi);
  return items.find(it => it.geometry?.type === 'Polygon' && pointInRing(x, y, it.geometry.coordinates[0])) || items[0];
}

// Hectares per pixel for a lon/lat grid at this latitude.
function haPerDegPixel(grid, lat) {
  return (grid.res * 111320 * Math.cos(lat * Math.PI / 180)) * (grid.res * 110540) / 10000;
}

// ─── Landsat 8/9 Collection 2 L2: land surface temperature ───
async function landsatLst(aoi, now = new Date()) {
  const items = await stacSearch({
    collections: ['landsat-c2-l2'], intersects: aoi,
    datetime: `${isoDay(daysAgo(40, now))}T00:00:00Z/${isoDay(now)}T23:59:59Z`,
    query: { 'eo:cloud_cover': { lt: 60 }, platform: { in: ['landsat-8', 'landsat-9'] } }, limit: 6
  });
  for (const item of items.slice(0, 4)) {
    if (!item.assets.lwir11 || !item.assets.qa_pixel) continue;
    const grid = makeGrid(aoi, epsgOf(item), 30);
    const [st, qa] = await Promise.all(['lwir11', 'qa_pixel'].map(async k => readBand(await signedHref('landsat-c2-l2', item.assets[k].href), grid, 0)));
    const v = [];
    let covered = 0;
    for (let i = 0; i < st.length; i++) {
      if (!grid.mask[i] || qa[i] === 0 || (qa[i] & 1)) continue;
      covered++;
      if (qa[i] & (2 | 8 | 16 | 128)) continue;     // dilated cloud, cloud, shadow, water
      if (st[i] > 0) v.push(st[i] * 0.00341802 + 149.0 - 273.15);
    }
    if (covered < grid.inside * 0.5 || v.length < covered * 0.4) continue;
    const s = stats(v);
    return {
      available: true,
      date: item.properties.datetime.slice(0, 10),
      platform: item.properties.platform,
      lstC: { mean: round(s.mean), p90: round(s.p90), max: round(s.max) },
      resolutionM: Math.round(grid.res)
    };
  }
  return { available: false, reason: 'No clear Landsat 8/9 pass over this area in the last 40 days.' };
}

// ─── Copernicus DEM GLO-30: elevation, slope ─────────────────
async function terrain(aoi) {
  const items = await stacSearch({ collections: ['cop-dem-glo-30'], intersects: aoi, limit: 4, sortDesc: false });
  if (!items.length) return { available: false, reason: 'No DEM tile found.' };
  const item = tileForCentre(items, aoi);
  const grid = makeGrid(aoi, 4326, 1 / 3600);
  const z = await readBand(await signedHref('cop-dem-glo-30', item.assets.data.href), grid, NaN);
  const lat = centroid(aoi)[1];
  const dx = grid.res * 111320 * Math.cos(lat * Math.PI / 180), dy = grid.res * 110540;
  const elev = [], slope = [];
  const W = grid.width;
  for (let r = 0; r < grid.height; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (!grid.mask[i] || !Number.isFinite(z[i])) continue;
      elev.push(z[i]);
      if (r > 0 && c > 0 && r < grid.height - 1 && c < W - 1) {
        const gx = (z[i + 1] - z[i - 1]) / (2 * dx), gy = (z[i + W] - z[i - W]) / (2 * dy);
        if (Number.isFinite(gx) && Number.isFinite(gy)) slope.push(Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI);
      }
    }
  }
  const e = stats(elev), s = stats(slope);
  if (!e) return { available: false, reason: 'DEM has no data here.' };
  const steep = slope.length ? slope.filter(v => v > 8).length / slope.length : 0;
  return {
    available: true,
    elevationM: { mean: round(e.mean, 0), min: round(e.min, 0), max: round(e.max, 0) },
    slopeDeg: s ? { mean: round(s.mean), p90: round(s.p90) } : null,
    steepPct: round(steep * 100),
    resolutionM: Math.round(dy)
  };
}

// ─── ESA WorldCover 2021: land-cover composition ─────────────
const WORLDCOVER = { 10: 'Tree cover', 20: 'Shrubland', 30: 'Grassland', 40: 'Cropland', 50: 'Built-up', 60: 'Bare / sparse vegetation', 70: 'Snow and ice', 80: 'Permanent water', 90: 'Herbaceous wetland', 95: 'Mangroves', 100: 'Moss and lichen' };

async function landCover(aoi) {
  const items = await stacSearch({ collections: ['esa-worldcover'], intersects: aoi, limit: 8, sortDesc: true });
  const latest = items.filter(i => String(i.properties['esa_worldcover:product_version'] || '').startsWith('2'));
  const pool = latest.length ? latest : items;
  if (!pool.length) return { available: false, reason: 'No WorldCover tile found.' };
  const item = tileForCentre(pool, aoi);
  const grid = makeGrid(aoi, 4326, 1 / 12000);
  const map = await readBand(await signedHref('esa-worldcover', item.assets.map.href), grid, 0);
  const counts = {};
  let n = 0;
  for (let i = 0; i < map.length; i++) {
    if (!grid.mask[i] || !map[i]) continue;
    counts[map[i]] = (counts[map[i]] || 0) + 1; n++;
  }
  if (!n) return { available: false, reason: 'WorldCover has no data here.' };
  const classes = Object.entries(counts)
    .map(([k, c]) => ({ code: Number(k), name: WORLDCOVER[k] || `Class ${k}`, pct: round((c / n) * 100) }))
    .sort((a, b) => b.pct - a.pct);
  return { available: true, year: Number(String(item.properties.datetime || item.properties.start_datetime || '2021').slice(0, 4)), classes, croplandPct: classes.find(c => c.code === 40)?.pct || 0 };
}

// ─── JRC Global Surface Water: historical water occurrence ───
async function surfaceWaterHistory(aoi) {
  const items = await stacSearch({ collections: ['jrc-gsw'], intersects: aoi, limit: 4, sortDesc: false });
  if (!items.length) return { available: false, reason: 'No surface-water history tile found.' };
  const item = tileForCentre(items, aoi);
  const grid = makeGrid(aoi, 4326, 0.00025);
  const occ = await readBand(await signedHref('jrc-gsw', item.assets.occurrence.href), grid, 255);
  const pxHa = haPerDegPixel(grid, centroid(aoi)[1]);
  let ever = 0, permanent = 0, seasonal = 0;
  for (let i = 0; i < occ.length; i++) {
    if (!grid.mask[i] || occ[i] === 255 || occ[i] === 0) continue;
    ever++;
    if (occ[i] >= 75) permanent++; else seasonal++;
  }
  return {
    available: true,
    period: '1984–2021',
    maxExtentHa: round(ever * pxHa, 2),
    permanentHa: round(permanent * pxHa, 2),
    seasonalHa: round(seasonal * pxHa, 2)
  };
}

module.exports = { landsatLst, terrain, landCover, surfaceWaterHistory };
