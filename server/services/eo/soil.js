// ─── Soil: ISRIC SoilGrids 2.0 (250 m, machine-learned from soil profiles) ──
// Read through ISRIC's WCS map service (the REST properties API is often
// unavailable). Topsoil 0–5 cm and root zone 15–30 cm.

const { getBuffer } = require('./net');
const { decodeSmallTiff } = require('./raster');
const { bbox, pointInRing } = require('./geo');

// property -> [divide-by to get target unit, unit label]
const PROPS = {
  clay: [10, '%'], sand: [10, '%'], silt: [10, '%'],
  phh2o: [10, 'pH'], soc: [10, 'g/kg'], nitrogen: [100, 'g/kg'],
  cec: [10, 'cmol(+)/kg'], bdod: [100, 'g/cm³']
};
const DEPTHS = ['0-5cm', '15-30cm'];

async function wcsTile(map, coverage, aoi) {
  let [minX, minY, maxX, maxY] = bbox(aoi);
  const pad = 0.006; // ensure at least a few 250 m cells
  if (maxX - minX < 2 * pad) { const cx = (minX + maxX) / 2; minX = cx - pad; maxX = cx + pad; }
  if (maxY - minY < 2 * pad) { const cy = (minY + maxY) / 2; minY = cy - pad; maxY = cy + pad; }
  const url = `https://maps.isric.org/mapserv?map=/map/${map}.map&SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage` +
    `&COVERAGEID=${coverage}&FORMAT=image/tiff` +
    `&SUBSET=long(${minX.toFixed(5)},${maxX.toFixed(5)})&SUBSET=lat(${minY.toFixed(5)},${maxY.toFixed(5)})` +
    `&SUBSETTINGCRS=http://www.opengis.net/def/crs/EPSG/0/4326&OUTPUTCRS=http://www.opengis.net/def/crs/EPSG/0/4326`;
  const t = await decodeSmallTiff(await getBuffer(url, { timeout: 20000 }));
  const ring = aoi.coordinates[0];
  const [bx0, , bx1, by1] = t.bbox;
  const rx = (bx1 - bx0) / t.width, ry = (by1 - t.bbox[1]) / t.height;
  const cells = [];
  for (let r = 0; r < t.height; r++) for (let c = 0; c < t.width; c++) {
    cells.push({ v: t.band[r * t.width + c], inAoi: pointInRing(bx0 + (c + 0.5) * rx, by1 - (r + 0.5) * ry, ring) });
  }
  return { cells, nodata: t.nodata };
}

async function wcsMean(prop, depth, aoi) {
  const t = await wcsTile(prop, `${prop}_${depth}_mean`, aoi);
  const valid = t.cells.filter(({ v }) => v > 0 && v !== t.nodata);
  const inside = valid.filter(c => c.inAoi);
  const use = inside.length ? inside : valid;
  if (!use.length) return null;
  return use.reduce((a, c) => a + c.v, 0) / use.length / PROPS[prop][0];
}

// Run tasks with limited parallelism to stay polite to the service.
async function pool(tasks, size) {
  const out = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i]().catch(() => null); }
  }));
  return out;
}

// USDA texture triangle.
function usdaTexture(sand, silt, clay) {
  if (![sand, silt, clay].every(Number.isFinite)) return null;
  if (silt + 1.5 * clay < 15) return 'Sand';
  if (silt + 1.5 * clay >= 15 && silt + 2 * clay < 30) return 'Loamy sand';
  if ((clay >= 7 && clay < 20 && sand > 52 && silt + 2 * clay >= 30) || (clay < 7 && silt < 50 && silt + 2 * clay >= 30)) return 'Sandy loam';
  if (clay >= 7 && clay < 27 && silt >= 28 && silt < 50 && sand <= 52) return 'Loam';
  if ((silt >= 50 && clay >= 12 && clay < 27) || (silt >= 50 && silt < 80 && clay < 12)) return 'Silt loam';
  if (silt >= 80 && clay < 12) return 'Silt';
  if (clay >= 20 && clay < 35 && silt < 28 && sand > 45) return 'Sandy clay loam';
  if (clay >= 27 && clay < 40 && sand > 20 && sand <= 45) return 'Clay loam';
  if (clay >= 27 && clay < 40 && sand <= 20) return 'Silty clay loam';
  if (clay >= 35 && sand > 45) return 'Sandy clay';
  if (clay >= 40 && silt >= 40) return 'Silty clay';
  if (clay >= 40 && sand <= 45 && silt < 40) return 'Clay';
  return 'Loam';
}

// Plant-available water (mm per metre of soil), Saxton & Rawls (2006).
function availableWater(sand, clay, socGkg) {
  if (![sand, clay, socGkg].every(Number.isFinite)) return null;
  const S = sand / 100, C = clay / 100, OM = Math.min(8, (socGkg / 10) * 1.724);
  const t1500 = -0.024 * S + 0.487 * C + 0.006 * OM + 0.005 * S * OM - 0.013 * C * OM + 0.068 * S * C + 0.031;
  const wp = t1500 + (0.14 * t1500 - 0.02);
  const t33 = -0.251 * S + 0.195 * C + 0.011 * OM + 0.006 * S * OM - 0.027 * C * OM + 0.452 * S * C + 0.299;
  const fc = t33 + (1.283 * t33 * t33 - 0.374 * t33 - 0.015);
  return { fieldCapacity: round(fc, 3), wiltingPoint: round(wp, 3), awcMmPerM: Math.round((fc - wp) * 1000) };
}

// World Reference Base soil groups, in SoilGrids' class-code order.
const WRB = ['Acrisols', 'Albeluvisols', 'Alisols', 'Andosols', 'Arenosols', 'Calcisols', 'Cambisols', 'Chernozems', 'Cryosols', 'Durisols',
  'Ferralsols', 'Fluvisols', 'Gleysols', 'Gypsisols', 'Histosols', 'Kastanozems', 'Leptosols', 'Lixisols', 'Luvisols', 'Nitisols',
  'Phaeozems', 'Planosols', 'Plinthosols', 'Podzols', 'Regosols', 'Solonchaks', 'Solonetz', 'Stagnosols', 'Umbrisols', 'Vertisols'];

// Most probable soil group over the AOI, via the WCS layer (fast and reliable).
async function wrbClass(aoi) {
  const t = await wcsTile('wrb', 'MostProbable', aoi);
  const counts = new Map();
  const tally = inside => {
    for (const { v, inAoi } of t.cells) if (v < WRB.length && (!inside || inAoi)) counts.set(v, (counts.get(v) || 0) + 1);
  };
  tally(true);
  if (!counts.size) tally(false);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (!total) throw new Error('No soil class here');
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v, c]) => ({ name: WRB[v], pct: Math.round((c / total) * 100) }));
  return { name: ranked[0].name, probabilities: ranked.slice(0, 3) };
}

async function soilProfile(aoi) {
  const tasks = [];
  for (const depth of DEPTHS) for (const prop of Object.keys(PROPS)) tasks.push(() => wcsMean(prop, depth, aoi));
  const values = await pool(tasks, 6);
  const layers = {};
  let k = 0;
  for (const depth of DEPTHS) {
    const l = {};
    for (const prop of Object.keys(PROPS)) l[prop] = round(values[k++], prop === 'nitrogen' || prop === 'bdod' ? 2 : 1);
    l.texture = usdaTexture(l.sand, l.silt, l.clay);
    l.water = availableWater(l.sand, l.clay, l.soc);
    layers[depth] = l;
  }
  const top = layers['0-5cm'];
  if (!['clay', 'phh2o', 'soc'].some(p => top[p] !== null)) return { available: false, reason: 'SoilGrids returned no data for this area (open water, urban or service unavailable).' };
  return { available: true, source: 'ISRIC SoilGrids 2.0 (250 m)', units: Object.fromEntries(Object.entries(PROPS).map(([k2, v]) => [k2, v[1]])), layers };
}

const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

module.exports = { soilProfile, wrbClass, usdaTexture, availableWater };
