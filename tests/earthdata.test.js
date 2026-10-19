// Offline tests for the NASA Earthdata and iSDAsoil integrations (no network).

const { test } = require('node:test');
const assert = require('node:assert');
const { mgrsEpsg, easeIndex, parseDapCsv, configured } = require('../server/services/eo/earthdata');
const { summarise } = require('../server/services/eo/swot');
const isda = require('../server/services/eo/isda');
const { interpret } = require('../server/services/eo/analyze');

test('ECOSTRESS tile names map to the right UTM projection', () => {
  assert.strictEqual(mgrsEpsg('ECOv002_L4T_ESI_46362_026_36KUF_20260908T141055_0713_01'), 32736); // Zimbabwe, south
  assert.strictEqual(mgrsEpsg('ECOv002_L4T_ESI_1_2_37NCB_20260908T141055_0713_01'), 32637);       // Kenya, north
});

test('SMAP EASE-Grid 2.0 9 km cell for Goromonzi is inside the grid', () => {
  const { row, col } = easeIndex([31.35, -17.85]);
  assert.ok(col > 2200 && col < 2320, `col ${col}`);
  assert.ok(row > 1000 && row < 1120, `row ${row}`);
  assert.throws(() => easeIndex([0, 89.9]), /Outside/);
});

test('OPeNDAP DAP4 CSV parsing', () => {
  const csv = '/Soil_Moisture_Retrieval_Data_AM/soil_moisture, 0.231\n/Soil_Moisture_Retrieval_Data_PM/soil_moisture_pm, -9999.0\n';
  const p = parseDapCsv(csv);
  assert.deepStrictEqual(p['/Soil_Moisture_Retrieval_Data_AM/soil_moisture'], [0.231]);
  assert.deepStrictEqual(p['/Soil_Moisture_Retrieval_Data_PM/soil_moisture_pm'], [-9999]);
  const multi = parseDapCsv('/time\n76.5, 107.5,\n137.5\n');
  assert.deepStrictEqual(multi['/time'], [76.5, 107.5, 137.5]);
});

test('SWOT lake summary: level change and position in range', () => {
  const obs = [
    { date: '2025-10-10T10:00:00Z', wse: 1361.8, areaKm2: 26 },
    { date: '2026-04-01T10:00:00Z', wse: 1363.0, areaKm2: 27 },
    { date: '2026-09-12T10:00:00Z', wse: 1361.9, areaKm2: 26 },
    { date: '2026-10-12T10:00:00Z', wse: 1361.4, areaKm2: 25.5 }
  ];
  const s = summarise(obs);
  assert.strictEqual(s.wseM, 1361.4);
  assert.strictEqual(s.change30dM, -0.5);
  assert.strictEqual(s.change1yM, -0.4);
  assert.strictEqual(s.levelPctOfRange, 0);
});

test('iSDA numbers can arrive as strings', () => {
  assert.strictEqual(isda.num({ ph: { value: '5.4' } }, 'ph'), 5.4);
  assert.strictEqual(isda.num({ ph: { value: 6.1 } }, 'ph'), 6.1);
  assert.strictEqual(isda.num({}, 'ph'), null);
});

test('sources report "not connected" without credentials', () => {
  const saved = process.env.EARTHDATA_TOKEN;
  delete process.env.EARTHDATA_TOKEN;
  assert.strictEqual(configured(), false);
  if (saved) process.env.EARTHDATA_TOKEN = saved;
});

const base = () => ({
  place: { country: 'Zimbabwe' },
  sentinel2: { available: true, scene: { date: '2026-01-17' }, indices: { ndvi: { mean: 0.6 }, ndre: { mean: 0.3 }, ndmi: { mean: 0.15 }, evi: {}, savi: {}, cire: {} }, cover: { vegetatedPct: 80, sparsePct: 15, barePct: 5 }, water: { areaHa: 0, pixels: 0 } },
  ndviHistory: { monthAgo: null, lastYear: null },
  soil: { available: true, wrb: { name: 'Lixisols' }, layers: { '0-5cm': { phh2o: 6.2, soc: 14, nitrogen: 1.2, cec: 12, texture: 'Sandy loam' }, '15-30cm': { bdod: 1.4, water: { fieldCapacity: 0.3, wiltingPoint: 0.15, awcMmPerM: 150 } } } },
  weather: { available: true, past30: { rainMm: 120, et0Mm: 100 }, next16: { rainMm: 60, et0Mm: 60, hotDays: 0 }, soilMoisture: { '9-27cm': 0.25 } },
  rainfall: { available: true, d30: {}, d90: { currentMm: 400, normalMm: 410, pctOfNormal: 98, zScore: 0 } },
  ecostress: null, smap: null, grace: null, swot: null, isda: null
});

test('ECOSTRESS stress, SMAP dryness, GRACE decline and SWOT drawdown are flagged', () => {
  const d = base();
  d.ecostress = { available: true, date: '2026-01-10', esi: { mean: 0.22, p10: 0.1 }, etDailyMm: 1.4 };
  d.smap = { available: true, latest: { date: '2026-01-16', soilMoisture: 0.05 }, mean7d: 0.055, observations: 6 };
  d.grace = { available: true, latest: { month: '2026-07', anomalyCm: -14.2 }, trend5yCmPerYear: -2.4, changeVsYearAgoCm: -3, percentileOfRecord: 6 };
  d.swot = { available: true, lakes: [{ lakeId: '1440001', name: 'Lake Chivero', wseM: 1361.4, latestDate: '2026-10-12', change30dM: -0.6, change1yM: -0.4, levelPctOfRange: 12, observations: 40, recordStart: '2023-08-01' }] };
  const r = interpret(d);
  const titles = r.issues.map(i => i.title).join(' | ');
  assert.match(titles, /water-stressed \(ECOSTRESS\)/);
  assert.match(titles, /very dry topsoil \(SMAP\)/);
  assert.match(titles, /Groundwater and water storage are declining/);
  assert.match(titles, /lowest on record/);
  assert.match(titles, /Lake Chivero: water level near its lowest/);
  assert.match(r.domains.waterQuantity.metrics.reservoirs, /Lake Chivero: 1361.4 m/);
  assert.match(r.recommendations.government.map(x => x.action).join(' '), /borehole/i);
});

test('iSDA phosphorus and potassium shortages lead to fertiliser guidance', () => {
  const d = base();
  d.isda = { available: true, topsoil: { ph: { value: 5.2 }, phosphorous_extractable: { value: 6 }, potassium_extractable: { value: 55 }, nitrogen_total: { value: 0.9 }, texture_class: { value: 'Sandy Loam' } }, subsoil: {} };
  const r = interpret(d);
  const titles = r.issues.map(i => i.title).join(' | ');
  assert.match(titles, /Low soil phosphorus/);
  assert.match(titles, /Low soil potassium/);
  assert.match(titles, /Acidic soil/);
  const farmer = r.recommendations.farmers.map(x => x.action).join(' ');
  assert.match(farmer, /phosphate/i);
  assert.match(farmer, /potassium/i);
  assert.strictEqual(r.domains.soil.metrics.isdaPhosphorusMgKg, 6);
  assert.match(r.domains.soil.summary, /iSDA 30 m: P 6 mg\/kg/);
});
