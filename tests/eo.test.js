// Offline tests for the satellite analysis engine (no network).

const { test } = require('node:test');
const assert = require('node:assert');
const { usdaTexture, availableWater } = require('../server/services/eo/soil');
const { normalizeAoi, areaHa } = require('../server/services/eo/geo');
const { interpret } = require('../server/services/eo/analyze');

test('USDA texture classes', () => {
  assert.strictEqual(usdaTexture(90, 5, 5), 'Sand');
  assert.strictEqual(usdaTexture(66, 17, 17), 'Sandy loam');
  assert.strictEqual(usdaTexture(40, 40, 20), 'Loam');
  assert.strictEqual(usdaTexture(20, 30, 50), 'Clay');
  assert.strictEqual(usdaTexture(48, 26, 26), 'Sandy clay loam');
});

test('plant-available water is realistic', () => {
  const sandy = availableWater(85, 5, 5), loam = availableWater(40, 20, 15);
  assert.ok(sandy.awcMmPerM > 30 && sandy.awcMmPerM < 110, 'sand holds little water');
  assert.ok(loam.awcMmPerM > sandy.awcMmPerM, 'loam holds more than sand');
  assert.ok(loam.fieldCapacity > loam.wiltingPoint);
});

test('AOI validation: point+radius, bad input, size limit', () => {
  const aoi = normalizeAoi({ point: [31.35, -17.85], radius_m: 600 });
  const ha = areaHa(aoi);
  assert.ok(ha > 105 && ha < 120, `circle of 600 m ≈ 113 ha, got ${ha}`);
  assert.throws(() => normalizeAoi({}), /polygon/);
  assert.throws(() => normalizeAoi({ geometry: { type: 'Polygon', coordinates: [[[0, 0], [200, 0], [0, 1], [0, 0]]] } }), /not valid/);
  assert.throws(() => normalizeAoi({ geometry: { type: 'Polygon', coordinates: [[[30, -20], [32, -20], [32, -18], [30, -18], [30, -20]]] } }), /km²/);
});

const base = () => ({
  place: { country: 'Zimbabwe' },
  sentinel2: { available: true, scene: { date: '2026-10-17' }, indices: { ndvi: { mean: 0.6, p10: 0.4, p90: 0.75 }, ndre: { mean: 0.3 }, ndmi: { mean: 0.15 }, evi: { mean: 0.4 }, savi: { mean: 0.5 }, cire: { mean: 1.2 } }, cover: { vegetatedPct: 80, sparsePct: 15, barePct: 5 }, water: { areaHa: 0, pixels: 0 } },
  ndviHistory: { monthAgo: { date: '2026-09-17', ndvi: 0.58 }, lastYear: { date: '2025-10-17', ndvi: 0.6 } },
  landsat: null, terrain: null, landCover: null, surfaceWaterHistory: null,
  soil: { available: true, wrb: { name: 'Lixisols' }, layers: { '0-5cm': { phh2o: 6.2, soc: 14, nitrogen: 1.2, cec: 12, sand: 50, silt: 25, clay: 25, texture: 'Sandy clay loam' }, '15-30cm': { bdod: 1.4, water: { fieldCapacity: 0.3, wiltingPoint: 0.15, awcMmPerM: 150 } } } },
  weather: { available: true, past30: { rainMm: 80, et0Mm: 100 }, next16: { rainMm: 40, et0Mm: 60, hotDays: 0, maxTempC: 30 }, soilMoisture: { '9-27cm': 0.25 } },
  rainfall: { available: true, d30: { currentMm: 80, normalMm: 85, pctOfNormal: 94, zScore: -0.1 }, d90: { currentMm: 250, normalMm: 260, pctOfNormal: 96, zScore: -0.1 } },
  river: null, foodSecurity: null
});

test('healthy rainy-season farm: low risk, every audience gets guidance', () => {
  const r = interpret(base());
  assert.strictEqual(r.overall.riskLevel, 'Low');
  assert.strictEqual(r.domains.crop.status, 'Good');
  for (const who of ['farmers', 'government', 'public']) assert.ok(r.recommendations[who].length >= 1 && r.recommendations[who][0].priority === 1);
});

test('drought + crop decline + acid soil are flagged and ranked', () => {
  const d = base();
  d.rainfall.d90 = { currentMm: 90, normalMm: 260, pctOfNormal: 35, zScore: -1.8 };
  d.ndviHistory.lastYear.ndvi = 0.85;
  d.soil.layers['0-5cm'].phh2o = 4.8;
  const r = interpret(d);
  const titles = r.issues.map(i => i.title).join(' | ');
  assert.match(titles, /Severe rainfall deficit/);
  assert.match(titles, /weaker than the same season/);
  assert.match(titles, /Strongly acidic/);
  assert.strictEqual(r.issues[0].severity, 'critical', 'worst issue first');
  assert.strictEqual(r.overall.riskLevel, 'Critical');
  assert.match(r.recommendations.farmers.map(x => x.action).join(' '), /lime/i);
  assert.match(r.recommendations.government[0].action, /drought advisory/i);
});

test('open water with algae bloom triggers water-quality warnings', () => {
  const d = base();
  d.sentinel2.water = { areaHa: 900, pixels: 9000, ndti: { mean: -0.15 }, ndci: { mean: 0.3 } };
  const r = interpret(d);
  assert.strictEqual(r.domains.waterQuality.metrics.trophicState, 'Bloom-level');
  assert.ok(r.issues.some(i => i.domain === 'waterQuality' && i.severity === 'high'));
  assert.match(r.recommendations.public.map(x => x.action).join(' '), /boil/i);
});

test('dry season: bare fields are not reported as crop failure', () => {
  const d = base();
  d.rainfall.d90 = { currentMm: 5, normalMm: 9, pctOfNormal: 55, zScore: -0.4 };
  d.sentinel2.indices.ndvi.mean = 0.25;
  d.ndviHistory.lastYear.ndvi = 0.24;
  d.ndviHistory.monthAgo.ndvi = 0.24;
  const r = interpret(d);
  assert.ok(!r.issues.some(i => /deficit/i.test(i.title)), 'no drought alarm in dry season');
  assert.match(r.domains.crop.summary, /expected in the dry season/);
});

test('field outline: grows a field, fills holes, traces and simplifies', () => {
  const { grow, tidy, outline, simplify } = require('../server/services/eo/field')._internal;
  // 20 × 20 window: a 10 × 8 "field" (NDVI 0.7) on bare soil (NDVI 0.15), one cloud-free hole.
  const W = 20, H = 20, N = W * H;
  const f = { ndvi: new Float32Array(N).fill(0.15), nir: new Float32Array(N).fill(0.2), swir: new Float32Array(N).fill(0.3) };
  for (let r = 6; r < 14; r++) for (let c = 5; c < 15; c++) { const i = r * W + c; f.ndvi[i] = 0.7; f.nir[i] = 0.4; f.swir[i] = 0.15; }
  const hole = 9 * W + 9; f.ndvi[hole] = 0.1; f.nir[hole] = 0.2; f.swir[hole] = 0.3;
  const grid = { width: W, height: H, mask: new Uint8Array(N).fill(1) };
  const scl = new Uint8Array(N).fill(4);
  const seed = 10 * W + 10;
  const field = tidy(grow(grid, f, seed, scl), W, H, seed);
  assert.strictEqual(field.reduce((a, v) => a + v, 0), 80, 'field is 10 × 8 with its hole filled');
  const ring = simplify(outline(field, W, H), 1);
  assert.strictEqual(ring.length, 5, 'a rectangle simplifies to 4 corners + closing point');
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  assert.deepStrictEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [5, 15, 6, 14]);
});
