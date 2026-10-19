// ─── Site analysis: fuse every source into findings and guidance ──
// Runs all sources in parallel, each with its own time limit, records
// what was used (date, resolution, status), then interprets the numbers
// into scored domains, ranked issues and audience-specific actions.

const geo = require('./geo');
const s2 = require('./sentinel2');
const pc = require('./planetary');
const soil = require('./soil');
const climate = require('./climate');
const where = require('./place');

const CACHE_TTL = 3 * 60 * 60 * 1000;
const cache = new Map();

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms))]);
}

async function settle(label, ms, fn) {
  const t = Date.now();
  try {
    const value = await withTimeout(fn(), ms, label);
    return { ok: value?.available !== false, value, ms: Date.now() - t };
  } catch (err) {
    console.warn(`[eo] ${label} failed:`, err.message);
    return { ok: false, error: err.message, ms: Date.now() - t };
  }
}

async function analyzeSite(body) {
  const aoi = geo.normalizeAoi(body);
  const now = new Date();
  const key = JSON.stringify(aoi.coordinates[0].map(([x, y]) => [x.toFixed(4), y.toFixed(4)])) + now.toISOString().slice(0, 10);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return { ...hit.result, cached: true };

  const c = geo.centroid(aoi);
  const [placeR, s2Now, s2Prev, s2LastYear, lst, dem, cover, gsw, soilR, wrbR, wx, rain, river] = await Promise.all([
    settle('Place', 10000, () => where.place(c)),
    settle('Sentinel-2', 45000, () => s2.analyzeLatest(aoi, now)),
    settle('Sentinel-2 (1 month ago)', 40000, () => s2.ndviInWindow(aoi, 50, 20, now)),
    settle('Sentinel-2 (last year)', 40000, () => s2.ndviInWindow(aoi, 385, 345, now)),
    settle('Landsat 8/9', 40000, () => pc.landsatLst(aoi, now)),
    settle('Copernicus DEM', 30000, () => pc.terrain(aoi)),
    settle('ESA WorldCover', 30000, () => pc.landCover(aoi)),
    settle('JRC Surface Water', 30000, () => pc.surfaceWaterHistory(aoi)),
    settle('SoilGrids', 35000, () => soil.soilProfile(aoi)),
    settle('SoilGrids soil type', 30000, () => soil.wrbClass(aoi)),
    settle('Open-Meteo weather', 20000, () => climate.weather(c, now)),
    settle('ERA5 rainfall baseline', 30000, () => climate.rainfallAnomaly(c, null, now)),
    settle('GloFAS river flow', 20000, () => climate.riverFlow(c))
  ]);
  const pl = placeR.value || {};
  const fsR = await settle('Food security', 5000, () => where.foodSecurity(pl.country));

  const data = {
    place: pl,
    sentinel2: s2Now.value || null,
    ndviHistory: { monthAgo: s2Prev.value || null, lastYear: s2LastYear.value || null },
    landsat: lst.value || null,
    terrain: dem.value || null,
    landCover: cover.value || null,
    surfaceWaterHistory: gsw.value || null,
    soil: soilR.value ? { ...soilR.value, wrb: wrbR.value || null } : (wrbR.value ? { available: false, reason: soilR.error || 'Soil properties unavailable.', wrb: wrbR.value } : null),
    weather: wx.value || null,
    rainfall: rain.value || null,
    river: river.value || null,
    foodSecurity: fsR.value || null
  };

  const sources = [
    src('Sentinel-2 L2A', 'ESA Copernicus via Microsoft Planetary Computer', 'Crop vigour (NDVI, EVI, SAVI), nitrogen (red-edge), canopy water (NDMI), bare soil (BSI), open water, turbidity (NDTI), chlorophyll-a (NDCI)', s2Now, v => v.scene && `${v.scene.date} · ${v.scene.resolutionM} m · ${v.scene.aoiClearPct}% clear`),
    src('Sentinel-2 history', 'ESA Copernicus via Microsoft Planetary Computer', 'NDVI one month ago and same season last year', s2Prev.ok || s2LastYear.ok ? { ok: true, value: {} } : s2Prev, () => [s2Prev.value?.date, s2LastYear.value?.date].filter(Boolean).join(' and ')),
    src('Landsat 8/9 TIRS', 'USGS / NASA via Microsoft Planetary Computer', 'Land surface temperature (crop heat stress)', lst, v => `${v.date} · ${v.resolutionM} m`),
    src('Copernicus DEM GLO-30', 'ESA via Microsoft Planetary Computer', 'Elevation, slope, erosion risk', dem, v => `${v.resolutionM} m`),
    src('ESA WorldCover', 'ESA via Microsoft Planetary Computer', 'Land cover: cropland, trees, built-up, water', cover, v => `${v.year} · 10 m`),
    src('JRC Global Surface Water', 'EC Joint Research Centre via Microsoft Planetary Computer', 'Historical water extent (1984–2021) to judge today’s water level', gsw, () => '30 m'),
    src('SoilGrids 2.0', 'ISRIC', 'Texture, pH, organic carbon, nitrogen, CEC, bulk density, plant-available water', soilR, () => '250 m · 0–5 cm and 15–30 cm'),
    src('SoilGrids WRB classification', 'ISRIC', 'Soil type (World Reference Base)', wrbR, v => v.name),
    src('Open-Meteo forecast', 'Open-Meteo (ECMWF, DWD and others)', 'Weather, 16-day forecast, evapotranspiration (ET₀), modelled soil moisture', wx, () => 'hourly · ~10 km'),
    src('ERA5 reanalysis', 'ECMWF Copernicus via Open-Meteo', 'Rainfall anomaly vs 25-year baseline (SPI-style)', rain, () => 'daily · ~25 km'),
    src('GloFAS river discharge', 'Copernicus Emergency Management via Open-Meteo', 'River flow vs long-term median, 14-day flow forecast', river, () => 'daily · ~5 km'),
    src('IPC food security', 'IPC / FEWS NET (WAFEO dataset)', 'National food-insecurity phase', fsR, v => v.phase),
    ...NOT_CONNECTED
  ];

  const analysis = interpret(data);
  const result = {
    generatedAt: now.toISOString(),
    aoi: { geometry: aoi, areaHa: Math.round(geo.areaHa(aoi) * 10) / 10, centroid: c },
    ...analysis,
    data,
    sources
  };
  cache.set(key, { at: Date.now(), result });
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return result;
}

function src(name, provider, measures, r, detail) {
  let status = r.ok ? 'live' : r.value?.available === false ? 'unavailable' : 'failed';
  let info = '';
  try { info = r.ok && detail ? detail(r.value) || '' : (r.value?.reason || r.error || ''); } catch { info = ''; }
  return { name, provider, measures, status, detail: info };
}

const NOT_CONNECTED = [
  ['SMAP', 'NASA', 'Satellite soil moisture (9 km)'],
  ['GRACE-FO', 'NASA / GFZ', 'Groundwater and total water storage (monthly)'],
  ['SWOT', 'NASA / CNES', 'Reservoir and river water height and volume'],
  ['ECOSTRESS', 'NASA', 'Evaporative stress index (70 m)'],
  ['NISAR', 'NASA / ISRO', 'L-band radar soil moisture (200 m)']
].map(([name, provider, measures]) => ({ name, provider, measures, status: 'not connected', detail: 'Needs a free NASA Earthdata account token (EARTHDATA_TOKEN).' }))
  .concat([{ name: 'iSDAsoil', provider: 'iSDA Africa', measures: '30 m African soil nutrients (N, P, K) and pH', status: 'not connected', detail: 'Needs a free iSDA account (ISDA_USERNAME / ISDA_PASSWORD).' }]);

// ═════════════════════════════════════════════════════════════
//  Interpretation
// ═════════════════════════════════════════════════════════════
const SEV = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const r1 = v => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function interpret(d) {
  const issues = [];
  const add = (domain, severity, title, detail, evidence) => issues.push({ domain, severity, title, detail, evidence });
  const domains = {};

  const drySeason = d.rainfall?.available && d.rainfall.d90.normalMm !== null && d.rainfall.d90.normalMm < 30;

  // ─── Crop condition ───
  const s = d.sentinel2;
  if (s?.available) {
    const ndvi = s.indices.ndvi?.mean, ndre = s.indices.ndre?.mean, ndmi = s.indices.ndmi?.mean;
    const prev = d.ndviHistory.monthAgo?.ndvi, ly = d.ndviHistory.lastYear?.ndvi;
    const trend = Number.isFinite(prev) ? ndvi - prev : null;
    const anomaly = Number.isFinite(ly) ? ndvi - ly : null;
    const ev = `Sentinel-2, ${s.scene.date}`;
    // Absolute greenness alone misleads between seasons (bare fields before
    // planting are normal), so lean on the change versus last year when known.
    const absolute = clamp(((ndvi - 0.1) / 0.6) * 100, 0, 100);
    const score = anomaly !== null ? clamp(0.4 * absolute + 0.6 * clamp(70 + anomaly * 200, 0, 100), 0, 100) : absolute;
    if (anomaly !== null && anomaly <= -0.1) add('crop', anomaly <= -0.2 ? 'high' : 'medium', 'Vegetation weaker than the same season last year', `NDVI ${r2(ndvi)} vs ${r2(ly)} last year (${r2(anomaly)}).`, `${ev} and ${d.ndviHistory.lastYear.date}`);
    if (anomaly !== null && anomaly >= 0.1) add('crop', 'info', 'Vegetation stronger than the same season last year', `NDVI ${r2(ndvi)} vs ${r2(ly)} last year (+${r2(anomaly)}).`, ev);
    if (trend !== null && trend <= -0.08) add('crop', 'medium', 'Vegetation declining over the last month', `NDVI fell from ${r2(prev)} to ${r2(ndvi)}. Check for water stress, pests or harvest.`, `${ev} vs ${d.ndviHistory.monthAgo.date}`);
    if (ndvi >= 0.35 && ndre < 0.2) add('crop', 'medium', 'Possible nitrogen shortage', `Red-edge index (NDRE ${r2(ndre)}) is low for this canopy density.`, ev);
    if (ndvi >= 0.4 && ndmi < 0) add('crop', 'medium', 'Crop canopy is drying', `Canopy moisture index NDMI ${r2(ndmi)} indicates water stress in leaves.`, ev);
    if (s.cover.barePct >= 40) add('land', 'low', 'Large share of bare soil', `${s.cover.barePct}% of the area is bare. Fine before planting; otherwise exposed to erosion.`, ev);
    domains.crop = {
      score: Math.round(score), status: label(score),
      metrics: { ndvi: r2(ndvi), ndviP10: r2(s.indices.ndvi?.p10), ndviP90: r2(s.indices.ndvi?.p90), evi: r2(s.indices.evi?.mean), savi: r2(s.indices.savi?.mean), ndre: r2(ndre), chlorophyllIndexRedEdge: r2(s.indices.cire?.mean), ndmi: r2(ndmi), ndviMonthAgo: r2(prev), ndviLastYear: r2(ly), ndviTrend: r2(trend), ndviAnomaly: r2(anomaly), vegetatedPct: s.cover.vegetatedPct, sparsePct: s.cover.sparsePct, barePct: s.cover.barePct },
      summary: cropSummary(ndvi, trend, anomaly) + (drySeason && ndvi < 0.4 ? ' Low greenness is expected in the dry season before planting.' : '')
    };
  } else {
    domains.crop = { score: null, status: 'No data', metrics: {}, summary: s?.reason || 'Sentinel-2 imagery unavailable.' };
  }
  if (d.landsat?.available) {
    const t = d.landsat.lstC;
    domains.crop.metrics.landSurfaceTempC = t.mean;
    domains.crop.metrics.landSurfaceTempP90C = t.p90;
    if (t.p90 >= 40) add('crop', t.p90 >= 45 ? 'high' : 'medium', 'Heat stress on the land surface', `Hottest 10% of the area reached ${t.p90} °C surface temperature.`, `Landsat ${d.landsat.date}`);
  }

  // ─── Water quantity ───
  const wq = { metrics: {}, score: 60 };
  const ra = d.rainfall, wx = d.weather;
  if (ra?.available) {
    const a30 = ra.d30, a90 = ra.d90;
    Object.assign(wq.metrics, { rain30Mm: a30.currentMm, rain30NormalMm: a30.normalMm, rain30PctNormal: a30.pctOfNormal, rain90Mm: a90.currentMm, rain90NormalMm: a90.normalMm, rain90PctNormal: a90.pctOfNormal, spi90: a90.zScore });
    if (!drySeason && a90.zScore !== null) {
      wq.score = clamp(60 + a90.zScore * 25, 0, 100);
      const cat = spiCategory(a90.zScore);
      if (a90.zScore <= -1) add('water', a90.zScore <= -1.5 ? 'critical' : 'high', `${cat} rainfall deficit (last 90 days)`, `${a90.currentMm} mm fell vs a normal of ${a90.normalMm} mm (${a90.pctOfNormal}% of normal, SPI ${a90.zScore}).`, 'ERA5 2001–present');
      else if (a90.zScore <= -0.5) add('water', 'medium', 'Rainfall below normal (last 90 days)', `${a90.pctOfNormal}% of normal (SPI ${a90.zScore}).`, 'ERA5 2001–present');
      else if (a90.zScore >= 1.5) add('water', 'medium', 'Much wetter than normal', `${a90.pctOfNormal}% of normal rainfall. Watch for waterlogging and floods.`, 'ERA5 2001–present');
    }
    if (drySeason) wq.metrics.season = 'Dry season: little rain is normal for this time of year.';
  }
  if (wx?.available) {
    const wb30 = r1(wx.past30.rainMm - wx.past30.et0Mm), wb16 = r1(wx.next16.rainMm - wx.next16.et0Mm);
    Object.assign(wq.metrics, { waterBalance30Mm: wb30, et0Past30Mm: wx.past30.et0Mm, rainNext16Mm: wx.next16.rainMm, et0Next16Mm: wx.next16.et0Mm, waterBalanceNext16Mm: wb16, hotDaysNext16: wx.next16.hotDays, soilMoisture: wx.soilMoisture });
    if (wx.next16.hotDays >= 3) add('climate', wx.next16.hotDays >= 6 ? 'high' : 'medium', 'Heatwave days ahead', `${wx.next16.hotDays} days ≥ 35 °C forecast in the next 16 days (max ${wx.next16.maxTempC} °C).`, 'Open-Meteo forecast');
    if (wb16 !== null && wb16 < -50 && !drySeason) add('water', 'medium', 'Crops will lose more water than rain supplies', `Forecast rain ${wx.next16.rainMm} mm vs evaporative demand ${wx.next16.et0Mm} mm over 16 days.`, 'Open-Meteo forecast');
    if (wx.next16.rainMm >= 120) add('water', 'medium', 'Heavy rain forecast', `${wx.next16.rainMm} mm expected over 16 days. Risk of flooding and nutrient wash-off.`, 'Open-Meteo forecast');
  }
  // Root-zone water relative to this soil's available-water range.
  const topSoil = d.soil?.layers?.['15-30cm'] || d.soil?.layers?.['0-5cm'];
  const theta = wx?.soilMoisture?.['9-27cm'];
  if (topSoil?.water && Number.isFinite(theta)) {
    const { fieldCapacity: fc, wiltingPoint: wp } = topSoil.water;
    const rel = clamp((theta - wp) / Math.max(0.01, fc - wp), 0, 1.2);
    wq.metrics.rootZoneAvailableWaterPct = Math.min(100, Math.round(rel * 100));
    if (rel < 0.3) add('water', rel < 0.15 ? 'high' : 'medium', 'Root-zone soil is near wilting point', `Only ~${Math.round(rel * 100)}% of plant-available water remains at 9–27 cm.`, 'Open-Meteo soil moisture + SoilGrids water capacity');
    wq.score = clamp(wq.score * 0.6 + rel * 100 * 0.4, 0, 100);
  }
  // Open water today vs its historical extent.
  const g = d.surfaceWaterHistory, sw = d.sentinel2?.water;
  if (g?.available) {
    Object.assign(wq.metrics, { waterHistoricalMaxHa: g.maxExtentHa, waterPermanentHa: g.permanentHa });
    if (sw && d.sentinel2?.available) {
      wq.metrics.openWaterNowHa = sw.areaHa;
      if (g.maxExtentHa >= 1) {
        const pct = Math.round((sw.areaHa / g.maxExtentHa) * 100);
        wq.metrics.openWaterPctOfHistoricalMax = pct;
        if (pct < 25 && g.permanentHa > 0.5) add('water', 'high', 'Dams and water bodies are very low', `Open water covers ${sw.areaHa} ha, ${pct}% of the largest extent recorded since 1984.`, `Sentinel-2 ${d.sentinel2.scene.date} vs JRC GSW`);
        else if (pct < 50) add('water', 'medium', 'Surface water below its usual extent', `${sw.areaHa} ha of open water, ${pct}% of the historical maximum.`, `Sentinel-2 ${d.sentinel2.scene.date} vs JRC GSW`);
      }
    }
  }
  if (d.river?.available) {
    Object.assign(wq.metrics, { riverDischargeM3s: d.river.dischargeM3s, riverPctOfMedian: d.river.pctOfMedian, riverForecastPeakPctOfMedian: d.river.forecastPeakPctOfMedian });
    if (d.river.pctOfMedian !== null && d.river.pctOfMedian < 50 && d.river.medianM3s > 1) add('water', 'medium', 'River flow well below normal', `Nearest modelled river runs at ${d.river.pctOfMedian}% of its median flow.`, 'GloFAS');
    if (d.river.forecastPeakPctOfMedian >= 300 && d.river.medianM3s > 1) add('water', 'high', 'River flood pulse forecast', `Flow may reach ${d.river.forecastPeakPctOfMedian}% of median around ${d.river.forecastPeakDate}.`, 'GloFAS forecast');
  }
  wq.metrics.groundwater = 'Not measured: GRACE-FO needs a NASA Earthdata token.';
  domains.waterQuantity = { score: Math.round(wq.score), status: label(wq.score), metrics: wq.metrics, summary: waterQuantitySummary(wq.metrics, drySeason) };

  // ─── Water quality (optical, open water only) ───
  if (sw && sw.pixels >= 5 && sw.ndti && sw.ndci) {
    const ndti = sw.ndti.mean, ndci = sw.ndci.mean;
    const chl = Math.max(0, 14.039 + 86.115 * ndci + 194.325 * ndci * ndci);
    const turb = turbidityClass(ndti), troph = trophicClass(ndci);
    let score = 100 - (SEV[turb.sev] * 15) - (SEV[troph.sev] * 15);
    if (turb.sev === 'high' || turb.sev === 'medium') add('waterQuality', turb.sev, `${turb.label} turbidity in open water`, `Turbidity index NDTI ${r2(ndti)}: suspended sediment, often from erosion or mining upstream.`, `Sentinel-2 ${d.sentinel2.scene.date}`);
    if (troph.sev === 'high' || troph.sev === 'medium') add('waterQuality', troph.sev, `${troph.label} algae (chlorophyll-a) in open water`, `NDCI ${r2(ndci)} (≈${Math.round(chl)} mg/m³ chlorophyll-a): nutrient pollution from sewage or fertiliser runoff.`, `Sentinel-2 ${d.sentinel2.scene.date}`);
    domains.waterQuality = {
      score: Math.round(clamp(score, 0, 100)), status: label(score),
      metrics: { openWaterHa: sw.areaHa, ndti: r2(ndti), turbidity: turb.label, ndci: r2(ndci), chlorophyllAMgM3: Math.round(chl), trophicState: troph.label },
      summary: `${turb.label} turbidity and ${troph.label.toLowerCase()} algae levels in ${sw.areaHa} ha of open water. Satellites see sediment and algae; they cannot see bacteria, heavy metals, salinity or pH, so test samples before drinking or irrigating.`
    };
  } else {
    domains.waterQuality = { score: null, status: 'No open water', metrics: { openWaterHa: sw?.areaHa ?? null }, summary: 'No open water large enough to assess in this area. Draw the area over a dam, river or lake to check sediment and algae.' };
  }

  // ─── Soil ───
  if (d.soil?.available) {
    const t = d.soil.layers['0-5cm'], z = d.soil.layers['15-30cm'];
    let score = 70;
    const sev = (lvl, title, detail) => { add('soil', lvl, title, detail, 'SoilGrids 2.0'); score -= SEV[lvl] * 8; };
    if (t.phh2o !== null && t.phh2o < 5.0) sev('high', 'Strongly acidic soil', `Topsoil pH ${t.phh2o}. Most crops lose yield below pH 5.5; aluminium toxicity likely.`);
    else if (t.phh2o !== null && t.phh2o < 5.5) sev('medium', 'Acidic soil', `Topsoil pH ${t.phh2o}. Liming would improve nutrient uptake.`);
    else if (t.phh2o !== null && t.phh2o > 8.0) sev('medium', 'Alkaline soil', `Topsoil pH ${t.phh2o}. Watch for zinc and iron deficiency; possible salinity.`);
    if (t.soc !== null && t.soc < 8) sev('medium', 'Low soil organic carbon', `${t.soc} g/kg in the topsoil: poor structure and water holding.`);
    if (t.nitrogen !== null && t.nitrogen < 0.8) sev('medium', 'Low soil nitrogen', `${t.nitrogen} g/kg total nitrogen in the topsoil.`);
    if (t.cec !== null && t.cec < 10) sev('low', 'Low nutrient-holding capacity', `CEC ${t.cec} cmol(+)/kg: fertiliser leaches quickly; split applications.`);
    if (z?.water?.awcMmPerM !== null && z?.water?.awcMmPerM < 100) sev('medium', 'Soil holds little water', `About ${z.water.awcMmPerM} mm of plant-available water per metre: crops wilt fast in dry spells.`);
    if (z?.bdod !== null && z?.bdod > 1.6) sev('low', 'Compaction risk', `Bulk density ${z.bdod} g/cm³ at 15–30 cm can restrict roots.`);
    domains.soil = {
      score: Math.round(clamp(score + 10, 0, 100)), status: label(score + 10),
      metrics: { soilType: d.soil.wrb?.name || null, texture: t.texture, sandPct: t.sand, siltPct: t.silt, clayPct: t.clay, pH: t.phh2o, organicCarbonGkg: t.soc, nitrogenGkg: t.nitrogen, cec: t.cec, bulkDensity: z?.bdod, availableWaterMmPerM: z?.water?.awcMmPerM },
      summary: `${d.soil.wrb?.name ? d.soil.wrb.name + ', ' : ''}${(t.texture || 'unknown texture').toLowerCase()} topsoil, pH ${t.phh2o ?? 'n/a'}, organic carbon ${t.soc ?? 'n/a'} g/kg.`
    };
  } else {
    domains.soil = { score: null, status: 'No data', metrics: { soilType: d.soil?.wrb?.name || null }, summary: (d.soil?.wrb?.name ? `Soil type: ${d.soil.wrb.name}. ` : '') + (d.soil?.reason || 'Soil properties unavailable.') };
  }

  // ─── Land & terrain ───
  const land = { metrics: {} };
  if (d.landCover?.available) Object.assign(land.metrics, { croplandPct: d.landCover.croplandPct, landCover: d.landCover.classes.slice(0, 5) });
  if (d.terrain?.available) {
    Object.assign(land.metrics, { elevationM: d.terrain.elevationM.mean, slopeMeanDeg: d.terrain.slopeDeg?.mean, steepPct: d.terrain.steepPct });
    if (d.terrain.steepPct >= 20) add('land', 'medium', 'Erosion-prone slopes', `${d.terrain.steepPct}% of the area is steeper than 8°. Contours and cover crops are needed.`, 'Copernicus DEM');
  }
  domains.land = { score: null, status: d.landCover?.available || d.terrain?.available ? 'Mapped' : 'No data', metrics: land.metrics, summary: landSummary(land.metrics) };

  // ─── Food security context ───
  if (d.foodSecurity?.available) {
    const f = d.foodSecurity;
    const ph = parseInt(String(f.phase).replace(/\D/g, ''), 10);
    if (ph >= 3) add('food', ph >= 4 ? 'critical' : 'high', `${f.country}: IPC ${f.phase} (${f.label})`, `${f.popAffected} people affected. Main drivers: ${f.driver}. Harvest outlook: ${f.harvest}.`, f.source);
  }

  issues.sort((a, b) => SEV[b.severity] - SEV[a.severity]);
  const scored = [domains.crop, domains.waterQuantity, domains.waterQuality, domains.soil].map(x => x.score).filter(Number.isFinite);
  const overallScore = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
  const worst = issues[0]?.severity || 'info';
  const riskLevel = worst === 'critical' ? 'Critical' : worst === 'high' ? 'High' : worst === 'medium' ? 'Moderate' : 'Low';

  return {
    overall: { score: overallScore, riskLevel, headline: headline(riskLevel, issues) },
    domains,
    issues,
    recommendations: recommend(issues, domains, d, drySeason)
  };
}

function label(score) {
  if (!Number.isFinite(score)) return 'No data';
  return score >= 70 ? 'Good' : score >= 50 ? 'Fair' : score >= 30 ? 'Poor' : 'Critical';
}
function spiCategory(z) { return z <= -2 ? 'Extreme' : z <= -1.5 ? 'Severe' : z <= -1 ? 'Moderate' : 'Mild'; }
function turbidityClass(n) { return n > 0.1 ? { label: 'Very high', sev: 'high' } : n > 0 ? { label: 'High', sev: 'medium' } : n > -0.1 ? { label: 'Moderate', sev: 'low' } : { label: 'Low', sev: 'info' }; }
function trophicClass(n) { return n > 0.2 ? { label: 'Bloom-level', sev: 'high' } : n > 0.1 ? { label: 'High', sev: 'medium' } : n > 0 ? { label: 'Moderate', sev: 'low' } : { label: 'Low', sev: 'info' }; }

function cropSummary(ndvi, trend, anomaly) {
  const lvl = ndvi >= 0.6 ? 'dense, healthy' : ndvi >= 0.4 ? 'moderate' : ndvi >= 0.2 ? 'sparse' : 'very little';
  let s = `Mean NDVI ${r2(ndvi)}: ${lvl} green vegetation.`;
  if (trend !== null) s += ` ${trend >= 0 ? 'Up' : 'Down'} ${Math.abs(r2(trend))} in the last month.`;
  if (anomaly !== null) s += ` ${anomaly >= 0 ? 'Above' : 'Below'} the same season last year by ${Math.abs(r2(anomaly))}.`;
  return s;
}
function waterQuantitySummary(m, drySeason) {
  const parts = [];
  if (m.rain90PctNormal !== undefined && m.rain90PctNormal !== null && !drySeason) parts.push(`Rainfall over 90 days is ${m.rain90PctNormal}% of normal`);
  if (drySeason) parts.push('It is the dry season here, so low rainfall is expected');
  if (Number.isFinite(m.rootZoneAvailableWaterPct)) parts.push(`root-zone soil holds ~${m.rootZoneAvailableWaterPct}% of its available water`);
  if (Number.isFinite(m.openWaterPctOfHistoricalMax)) parts.push(`open water is at ${m.openWaterPctOfHistoricalMax}% of its historical maximum`);
  if (Number.isFinite(m.rainNext16Mm)) parts.push(`${m.rainNext16Mm} mm of rain is forecast for the next 16 days`);
  return parts.length ? parts.join('; ') + '.' : 'Water data unavailable.';
}
function landSummary(m) {
  const parts = [];
  if (Number.isFinite(m.croplandPct)) parts.push(`${m.croplandPct}% cropland`);
  if (Number.isFinite(m.elevationM)) parts.push(`${m.elevationM} m elevation`);
  if (Number.isFinite(m.slopeMeanDeg)) parts.push(`mean slope ${m.slopeMeanDeg}°`);
  return parts.length ? parts.join(', ') + '.' : 'Land data unavailable.';
}
function headline(risk, issues) {
  if (!issues.length || SEV[issues[0].severity] < 2) return 'No major warning signs in the latest satellite and weather data.';
  const top = issues.filter(i => SEV[i.severity] >= 2).slice(0, 2).map(i => i.title);
  return `${risk} risk: ${top.join('; ')}.`;
}

// ─── Audience guidance, ranked by the severity of what triggered it ──
function recommend(issues, domains, d, drySeason) {
  const out = { farmers: [], government: [], public: [] };
  const push = (who, sev, action, why) => out[who].push({ severity: sev, action, why });
  const has = (pred) => issues.find(pred);

  const drought = has(i => i.domain === 'water' && /deficit|below normal|near wilting|lose more water/i.test(i.title));
  if (drought) {
    push('farmers', drought.severity, 'Save soil water now: mulch, keep crop residue on the surface, and dig planting basins or tied ridges.', drought.detail);
    push('farmers', drought.severity, 'Choose drought-tolerant, early-maturing varieties (sorghum, pearl millet, short-season maize) and stagger planting dates.', 'Rainfall and soil water are below what crops need.');
    push('government', drought.severity, 'Issue a drought advisory for this area and pre-position seed, feed and water support (anticipatory action).', drought.detail);
    push('public', drought.severity, 'Use water sparingly and store safe drinking water; expect higher food prices if the deficit continues.', drought.detail);
  }
  const lowWater = has(i => /very low|below its usual extent|River flow well below/i.test(i.title));
  if (lowWater) {
    push('government', lowWater.severity, 'Prioritise water allocation from dams for drinking and livestock; schedule irrigation rotations.', lowWater.detail);
    push('farmers', lowWater.severity, 'Switch to drip or furrow irrigation at night and irrigate by soil moisture, not by calendar.', lowWater.detail);
  }
  const flood = has(i => /flood|Heavy rain|wetter than normal/i.test(i.title));
  if (flood) {
    push('farmers', flood.severity, 'Clear drainage channels, delay top-dressing fertiliser until after heavy rain, and move livestock and stored grain to higher ground.', flood.detail);
    push('government', flood.severity, 'Alert communities along rivers and low ground; check dam spillways and evacuation routes.', flood.detail);
    push('public', flood.severity, 'Avoid crossing flooded rivers and boil drinking water after floods (cholera risk).', flood.detail);
  }
  const heat = has(i => /Heat/i.test(i.title));
  if (heat) {
    push('farmers', heat.severity, 'Irrigate early morning or evening, provide shade and water for livestock, and avoid spraying in the heat of the day.', heat.detail);
    push('public', heat.severity, 'Drink water often and avoid outdoor work at midday during the hot days ahead.', heat.detail);
  }
  const n = has(i => /nitrogen/i.test(i.title));
  if (n) push('farmers', n.severity, 'Apply nitrogen top-dressing (e.g. ammonium nitrate or urea) where the crop looks pale, split into two doses; plant legumes in rotation.', n.detail);
  const canopy = has(i => /canopy is drying/i.test(i.title));
  if (canopy) push('farmers', canopy.severity, 'Crops show leaf water stress: irrigate if possible within the next week and scout for wilting in the field.', canopy.detail);
  const decline = has(i => /declining|weaker than the same season/i.test(i.title));
  if (decline) {
    push('farmers', decline.severity, 'Walk the weakest parts of the field to check for pests, disease, weeds or waterlogging.', decline.detail);
    push('government', decline.severity, 'Send extension officers to verify crop condition and update the seasonal crop assessment.', decline.detail);
  }
  const acid = has(i => /acidic/i.test(i.title));
  if (acid) {
    push('farmers', acid.severity, `Apply agricultural lime (about ${acid.severity === 'high' ? '2–3' : '1–2'} t/ha dolomitic lime) before planting, and confirm with a soil test.`, acid.detail);
    push('government', acid.severity, 'Support lime distribution and subsidised soil testing for farmers in this area.', acid.detail);
  }
  const carbon = has(i => /organic carbon|holds little water/i.test(i.title));
  if (carbon) push('farmers', carbon.severity, 'Build organic matter: compost, manure, crop residue retention and minimum tillage (Pfumvudza/Intwasa basins).', carbon.detail);
  const lowN = has(i => /Low soil nitrogen/i.test(i.title));
  if (lowN && !n) push('farmers', lowN.severity, 'Budget for nitrogen fertiliser at planting and top-dressing, or intercrop with legumes (cowpea, groundnut, soybean).', lowN.detail);
  const erosion = has(i => /Erosion|bare soil/i.test(i.title));
  if (erosion) {
    push('farmers', erosion.severity, 'Build contour ridges or stone bunds and keep soil covered to stop erosion.', erosion.detail);
    push('government', erosion.severity, 'Include this area in catchment conservation works (contours, gully reclamation).', erosion.detail);
  }
  const quality = has(i => i.domain === 'waterQuality');
  if (quality) {
    push('government', quality.severity, 'Sample this water body (turbidity, nutrients, E. coli, heavy metals) and trace upstream pollution from mining, sewage or fertiliser.', quality.detail);
    push('farmers', quality.severity, 'Do not use this water for drinking or for vegetables eaten raw without treatment; filter and let sediment settle before irrigation.', quality.detail);
    push('public', quality.severity, 'Treat or boil water from this source before drinking.', quality.detail);
  }
  const food = has(i => i.domain === 'food');
  if (food) {
    push('government', food.severity, 'Align this area with food-assistance targeting and strategic grain reserve releases.', food.detail);
    push('public', food.severity, 'Support community food programmes and report food shortages to local authorities.', food.detail);
  }

  // Sensible defaults so every audience gets guidance.
  if (!out.farmers.length) push('farmers', 'info', drySeason ? 'Prepare land and inputs before the rains: test soil, plan rotations, and repair water-harvesting structures.' : 'Conditions look normal: keep monitoring crop vigour weekly and follow local extension advice.', 'No major warning signs in the latest data.');
  if (!out.government.length) push('government', 'info', 'Keep this area on routine satellite monitoring and update the early-warning bulletin each dekad.', 'No major warning signs in the latest data.');
  if (!out.public.length) push('public', 'info', 'No urgent action needed. Follow official weather and water advisories.', 'No major warning signs in the latest data.');

  for (const who of Object.keys(out)) {
    out[who].sort((a, b) => SEV[b.severity] - SEV[a.severity]);
    out[who] = out[who].map((r, i) => ({ priority: i + 1, ...r }));
  }
  return out;
}

module.exports = { analyzeSite, interpret };
