// ════════════════════════════════════════════════════════════
//  WAFEO — live pages
//  Every domain page and the dashboard are rendered from the latest
//  live site analysis (satellites, soil, weather, FEWS NET, GDACS).
//  Each result is explained twice: in plain words for farmers and the
//  public, and with the method and source for specialists.
//  Loaded after app.js and eo.js.
// ════════════════════════════════════════════════════════════
(function () {
  const site = () => window.wafeoSite;
  const A = () => (site() ? site().last() : null);
  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s ?? ''));
  const num = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d }) : '—');
  const signed = (v, d = 2) => (Number.isFinite(v) ? (v > 0 ? '+' : '') + num(v, d) : '—');
  const ago = iso => {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  };
  const charts = new Map();
  const maps = new Map();
  let busy = false;

  // ─── Simple / expert view ─────────────────────────────────
  const VIEW_KEY = 'wafeo.view';
  let expert = false;
  try { expert = localStorage.getItem(VIEW_KEY) === 'expert'; } catch (e) {}
  function applyView() {
    document.body.classList.toggle('lv-expert', expert);
    document.querySelectorAll('.lv-view button').forEach(b => b.classList.toggle('on', (b.dataset.view === 'expert') === expert));
    document.querySelectorAll('.lv-science').forEach(d => { d.open = expert; });
  }

  // ─── What each number means (plain) and how it is made (expert) ──
  const X = {
    ndvi: { label: 'Plant greenness (NDVI)', unit: '', plain: 'How green and dense the plants are: 0 is bare ground, about 0.3 is sparse, 0.6+ is a thick healthy crop.', tech: 'NDVI = (B8 − B4)/(B8 + B4) from Sentinel-2 L2A at 10 m; clouds and shadows removed with the scene classification layer (SCL).', tone: v => v >= 0.5 ? 'good' : v >= 0.3 ? 'watch' : 'bad' },
    ndviAnomaly: { label: 'Greenness vs last year', unit: '', fmt: v => signed(v), plain: 'Compared with the same weeks last year. Above zero means greener than last year; below zero means weaker.', tech: 'Mean NDVI minus the mean NDVI of the clearest Sentinel-2 scene 345–385 days earlier, same area and mask.', tone: v => v >= 0 ? 'good' : v > -0.1 ? 'watch' : 'bad' },
    ndviTrend: { label: 'Change in the last month', unit: '', fmt: v => signed(v), plain: 'Is the crop getting greener or weaker over the past month?', tech: 'Mean NDVI minus the clearest scene 20–50 days earlier.', tone: v => v >= 0 ? 'good' : v > -0.08 ? 'watch' : 'bad' },
    ndre: { label: 'Nitrogen signal (NDRE)', unit: '', plain: 'Shows how much nitrogen is in the leaves. A green crop with a low value here is likely short of nitrogen.', tech: 'NDRE = (B8 − B5)/(B8 + B5) using the Sentinel-2 red-edge band B5 (20 m).', tone: v => v >= 0.25 ? 'good' : v >= 0.18 ? 'watch' : 'bad' },
    ndmi: { label: 'Leaf water (NDMI)', unit: '', plain: 'How much water is inside the leaves. Below zero on a green crop means the plants are drying.', tech: 'NDMI = (B8 − B11)/(B8 + B11), Sentinel-2 SWIR band B11 (20 m).', tone: v => v >= 0.1 ? 'good' : v >= 0 ? 'watch' : 'bad' },
    evaporativeStressIndex: { label: 'Crop thirst (ECOSTRESS)', unit: '', plain: 'How much water crops use compared with what they could use. Below 0.4 means thirsty crops, often 1–2 weeks before leaves wilt.', tech: 'ECOSTRESS L4T ESI = actual ET / potential ET (PT-JPL), 70 m, cloud and water masked.', tone: v => v >= 0.6 ? 'good' : v >= 0.4 ? 'watch' : 'bad' },
    evapotranspirationMmDay: { label: 'Water used by crops', unit: 'mm/day', plain: 'How much water the land and crops gave off to the air in a day.', tech: 'ECOSTRESS L3T JET daily evapotranspiration (ETdaily), 70 m.' },
    landSurfaceTempC: { label: 'Ground temperature', unit: '°C', fmt: v => num(v, 1), plain: 'How hot the soil and crop surface are. Above about 40 °C most crops suffer.', tech: 'Landsat 8/9 TIRS band 10, Collection 2 Level-2 surface temperature, QA-masked for cloud, shadow and water.', tone: v => v < 35 ? 'good' : v < 40 ? 'watch' : 'bad' },
    vegetatedPct: { label: 'Area with green cover', unit: '%', fmt: v => num(v, 0), plain: 'Share of the area with well-growing plants.', tech: 'Share of clear land pixels with NDVI ≥ 0.4.' },
    barePct: { label: 'Bare soil', unit: '%', fmt: v => num(v, 0), plain: 'Share of the area with bare soil, which is normal before planting but erodes in heavy rain.', tech: 'Share of clear land pixels with NDVI < 0.2.' },
    rain90PctNormal: { label: 'Rain, last 3 months', unit: '% of normal', fmt: v => num(v, 0), plain: 'Rain over the last 90 days compared with an average year (100% = normal).', tech: 'ERA5 reanalysis 90-day total vs the same calendar window in 2001–last year (Open-Meteo archive API).', tone: v => v >= 80 ? 'good' : v >= 60 ? 'watch' : 'bad' },
    rain30PctNormal: { label: 'Rain, last month', unit: '% of normal', fmt: v => num(v, 0), plain: 'Rain over the last 30 days compared with an average year.', tech: 'ERA5 30-day total vs the same window 2001–last year.', tone: v => v >= 80 ? 'good' : v >= 60 ? 'watch' : 'bad' },
    spi90: { label: 'Drought index (SPI-90)', unit: '', fmt: v => signed(v), plain: '0 is normal. Below −1 is drought, below −1.5 severe, below −2 extreme. Above +1.5 is very wet.', tech: 'Standardised anomaly (z-score) of 90-day rainfall against 2001–present at this location (SPI-style).', tone: v => v > -0.5 ? 'good' : v > -1 ? 'watch' : 'bad' },
    rootZoneAvailableWaterPct: { label: 'Soil water around roots', unit: '% of usual range', fmt: v => num(v, 0), plain: 'How wet the soil around the roots is compared with this place’s own record: 0% is the driest and 100% the wettest it has been in the last 10 years.', tech: 'ERA5 reanalysis soil moisture at 7–28 cm (3-day mean), scaled between its 2nd and 98th percentile over the last 10 years at this location.', tone: v => v >= 50 ? 'good' : v >= 25 ? 'watch' : 'bad' },
    rootZoneSeasonalPercentile: { label: 'Soil water vs this time of year', unit: 'percentile', fmt: v => num(v, 0), plain: 'Compared with the same weeks in past years: 50 is normal, below 20 is unusually dry, above 80 unusually wet.', tech: 'Percentile of the current ERA5 7–28 cm soil moisture among all days within ±15 days of today’s date in the previous 10 years.', tone: v => v >= 40 ? 'good' : v >= 20 ? 'watch' : 'bad' },
    smapSoilMoisture7d: { label: 'Topsoil wetness (SMAP)', unit: 'm³/m³', fmt: v => num(v, 3), plain: 'Satellite-measured wetness of the top 5 cm of soil. Below about 0.10 is very dry.', tech: 'SMAP L3 enhanced (SPL3SMP_E) 9 km EASE-Grid 2.0, AM/PM retrievals averaged over 7 days.', tone: v => v >= 0.2 ? 'good' : v >= 0.1 ? 'watch' : 'bad' },
    rainNext16Mm: { label: 'Rain expected, next 16 days', unit: 'mm', fmt: v => num(v, 0), plain: 'Forecast rain over the next 16 days.', tech: 'Open-Meteo best-match forecast (ECMWF, DWD and others), daily totals.' },
    waterBalanceNext16Mm: { label: 'Rain minus crop water need', unit: 'mm', fmt: v => signed(v, 0), plain: 'Forecast rain minus the water crops will lose to heat and wind. Negative means irrigation or stored water will be needed.', tech: 'Σ precipitation − Σ FAO-56 reference evapotranspiration (ET₀), next 16 days.', tone: v => v >= 0 ? 'good' : v > -50 ? 'watch' : 'bad' },
    hotDaysNext16: { label: 'Very hot days ahead', unit: 'days ≥ 35 °C', fmt: v => num(v, 0), plain: 'Days in the next 16 with temperatures of 35 °C or more.', tech: 'Count of forecast daily maxima ≥ 35 °C (Open-Meteo).', tone: v => v === 0 ? 'good' : v < 3 ? 'watch' : 'bad' },
    openWaterPctOfHistoricalMax: { label: 'Dams and lakes fullness', unit: '% of largest', fmt: v => num(v, 0), plain: 'How much open water there is now compared with the largest extent seen since 1984.', tech: 'Sentinel-2 water pixels (SCL = 6 or MNDWI > 0.2) vs JRC Global Surface Water occurrence > 0 (1984–2021).', tone: v => v >= 50 ? 'good' : v >= 25 ? 'watch' : 'bad' },
    openWaterNowHa: { label: 'Open water now', unit: 'ha', fmt: v => num(v, 1), plain: 'Area of open water (dams, lakes, rivers) visible today.', tech: 'Sentinel-2 water pixels × pixel area.' },
    riverPctOfMedian: { label: 'River flow', unit: '% of usual', fmt: v => num(v, 0), plain: 'Flow in the nearest large river compared with the usual for this time of year.', tech: 'GloFAS v4 river discharge vs its median (Copernicus EMS via Open-Meteo), ~5 km grid.', tone: v => v >= 60 && v <= 250 ? 'good' : v >= 40 ? 'watch' : 'bad' },
    groundwaterTrendCmYr: { label: 'Groundwater trend', unit: 'cm per year', fmt: v => signed(v, 1), plain: 'Is the water stored underground in this region rising or falling each year?', tech: 'GRACE/GRACE-FO JPL mascon CRI RL06.3: 5-year linear trend of the liquid-water-equivalent anomaly (regional, ~300 km).', tone: v => v >= 0 ? 'good' : v > -1 ? 'watch' : 'bad' },
    groundwaterPercentile: { label: 'Water storage vs history', unit: 'percentile', fmt: v => num(v, 0), plain: 'Where today’s regional water storage sits compared with every month since 2002 (low numbers = unusually low).', tech: 'Percentile of the latest GRACE-FO anomaly within the full 2002–present record.', tone: v => v >= 30 ? 'good' : v >= 10 ? 'watch' : 'bad' },
    turbidity: { label: 'Muddiness of water', unit: '', plain: 'How muddy the water is. High values come from soil erosion or mining upstream.', tech: 'NDTI = (B4 − B3)/(B4 + B3) over Sentinel-2 water pixels.', tone: v => /low/i.test(v) ? 'good' : /moderate/i.test(v) ? 'watch' : 'bad' },
    trophicState: { label: 'Algae in water', unit: '', plain: 'Algae levels. High levels mean sewage or fertiliser is polluting the water.', tech: 'NDCI = (B5 − B4)/(B5 + B4) over water pixels; chlorophyll-a ≈ 14.04 + 86.12·NDCI + 194.33·NDCI² mg/m³ (Mishra & Mishra 2012).', tone: v => /low/i.test(v) ? 'good' : /moderate/i.test(v) ? 'watch' : 'bad' },
    chlorophyllAMgM3: { label: 'Chlorophyll-a (approx.)', unit: 'mg/m³', fmt: v => num(v, 0), plain: 'Approximate algae concentration. Above about 25 mg/m³ is polluted water.', tech: 'Empirical NDCI–chlorophyll relation; calibrate with field samples.', tone: v => v < 10 ? 'good' : v < 25 ? 'watch' : 'bad' },
    soilType: { label: 'Soil type', unit: '', plain: 'The soil family found here.', tech: 'Most probable World Reference Base group, ISRIC SoilGrids 2.0 (250 m).' },
    texture: { label: 'Soil texture', unit: '', plain: 'Whether the soil is sandy, loamy or clayey, which controls drainage and water holding.', tech: 'USDA texture class from SoilGrids sand/silt/clay at 0–5 cm.' },
    pH: { label: 'Soil acidity (pH)', unit: '', fmt: v => num(v, 1), plain: 'Most crops grow best at pH 5.5–7. Below 5.5 the soil is acidic and needs lime.', tech: 'SoilGrids 2.0 pH in water, 0–5 cm, 250 m.', tone: v => v >= 5.5 && v <= 7.5 ? 'good' : v >= 5 && v <= 8 ? 'watch' : 'bad' },
    organicCarbonGkg: { label: 'Organic matter (carbon)', unit: 'g/kg', fmt: v => num(v, 1), plain: 'Organic matter holds water and nutrients. Below about 8 g/kg is low.', tech: 'SoilGrids 2.0 soil organic carbon, 0–5 cm.', tone: v => v >= 12 ? 'good' : v >= 8 ? 'watch' : 'bad' },
    nitrogenGkg: { label: 'Soil nitrogen', unit: 'g/kg', fmt: v => num(v, 2), plain: 'Nitrogen already in the soil. Below about 0.8 g/kg crops need nitrogen fertiliser.', tech: 'SoilGrids 2.0 total nitrogen, 0–5 cm.', tone: v => v >= 1.2 ? 'good' : v >= 0.8 ? 'watch' : 'bad' },
    cec: { label: 'Fertiliser holding (CEC)', unit: 'cmol(+)/kg', fmt: v => num(v, 1), plain: 'How well the soil holds on to fertiliser. Low values mean fertiliser washes away, so apply in smaller doses.', tech: 'SoilGrids 2.0 cation exchange capacity, 0–5 cm.', tone: v => v >= 15 ? 'good' : v >= 10 ? 'watch' : 'bad' },
    availableWaterMmPerM: { label: 'Water the soil can store', unit: 'mm per metre', fmt: v => num(v, 0), plain: 'How much water this soil can store for plants. Under 100 mm per metre dries out fast.', tech: 'Field capacity − wilting point from SoilGrids sand, clay and carbon (Saxton & Rawls 2006), 15–30 cm.', tone: v => v >= 140 ? 'good' : v >= 100 ? 'watch' : 'bad' },
    isdaPhosphorusMgKg: { label: 'Phosphorus (iSDA)', unit: 'mg/kg', fmt: v => num(v, 1), plain: 'Phosphorus available to roots. Below about 15 mg/kg crops need phosphate fertiliser.', tech: 'iSDAsoil extractable P (Mehlich-3), 0–20 cm, 30 m.', tone: v => v >= 20 ? 'good' : v >= 15 ? 'watch' : 'bad' },
    isdaPotassiumMgKg: { label: 'Potassium (iSDA)', unit: 'mg/kg', fmt: v => num(v, 0), plain: 'Potassium available to roots. Below about 80 mg/kg crops need potash.', tech: 'iSDAsoil extractable K (Mehlich-3), 0–20 cm, 30 m.', tone: v => v >= 120 ? 'good' : v >= 80 ? 'watch' : 'bad' },
    isdaPh: { label: 'pH (iSDA 30 m)', unit: '', fmt: v => num(v, 1), plain: 'Soil acidity from the more detailed 30 m African soil map.', tech: 'iSDAsoil pH, 0–20 cm, 30 m.', tone: v => v >= 5.5 && v <= 7.5 ? 'good' : v >= 5 ? 'watch' : 'bad' },
    croplandPct: { label: 'Cropland', unit: '%', fmt: v => num(v, 0), plain: 'Share of the area used for crops.', tech: 'ESA WorldCover 2021 class 40, 10 m.' },
    slopeMeanDeg: { label: 'Average slope', unit: '°', fmt: v => num(v, 1), plain: 'How steep the land is. Fields steeper than about 8° need contours to stop erosion.', tech: 'Copernicus DEM GLO-30, central-difference slope.', tone: v => v < 5 ? 'good' : v < 8 ? 'watch' : 'bad' },
    elevationM: { label: 'Elevation', unit: 'm', fmt: v => num(v, 0), plain: 'Height above sea level.', tech: 'Copernicus DEM GLO-30 mean.' }
  };

  // In the dry season tiny rainfall totals make percent-of-normal and SPI misleading.
  const DRY_SEASON_HIDDEN = ['rain90PctNormal', 'rain30PctNormal', 'spi90'];

  function card(key, metrics, opts = {}) {
    const v = metrics ? metrics[key] : undefined;
    if (v === undefined || v === null) return '';
    if (metrics.season && DRY_SEASON_HIDDEN.includes(key)) return '';
    const x = X[key] || { label: (site() && site().labels[key]) || key, plain: '' };
    const val = x.fmt ? x.fmt(v) : typeof v === 'number' ? num(v) : esc(v);
    const tone = x.tone ? x.tone(v) : 'neutral';
    return `<div class="lv-card lv-${tone}${opts.big ? ' lv-big' : ''}">
      <div class="lv-card-top"><span class="lv-card-label">${esc(x.label)}</span>
        <button type="button" class="lv-info" aria-expanded="false" title="What is this?"><i data-lucide="info"></i></button></div>
      <div class="lv-card-value">${val}${x.unit ? `<small> ${esc(x.unit)}</small>` : ''}</div>
      <div class="lv-card-plain">${esc(x.plain)}</div>
      <div class="lv-card-tech" hidden><b>How it is measured:</b> ${esc(x.tech || '')}</div>
    </div>`;
  }
  const cards = (keys, metrics) => `<div class="lv-cards">${keys.map(k => card(k, metrics)).join('')}</div>`;

  function plainBox(title, text, tone) {
    return `<div class="lv-plain lv-${tone || 'neutral'}"><div class="lv-plain-icon"><i data-lucide="message-square-text"></i></div><div><div class="lv-plain-title">${esc(title)}</div><div class="lv-plain-text">${esc(text)}</div></div></div>`;
  }

  // Recommendations for this page, tabbed by audience.
  function actions(a, pattern) {
    const who = [['farmers', '<i data-lucide="tractor"></i>Farmers'], ['government', '<i data-lucide="landmark"></i>Government'], ['public', '<i data-lucide="users"></i>Public']];
    const lists = who.map(([k]) => (a.recommendations[k] || []).filter(r => !pattern || pattern.test(r.action + ' ' + r.why)));
    const first = Math.max(0, lists.findIndex(l => l.length));
    return `<div class="lv-actions">
      <div class="lv-tabs" role="tablist">${who.map(([k, l], i) => `<button type="button" role="tab" class="${i === first ? 'on' : ''}" data-tab="${k}">${l} <span>${lists[i].length}</span></button>`).join('')}</div>
      ${who.map(([k], i) => `<ol class="lv-action-list" data-panel="${k}" ${i === first ? '' : 'hidden'}>${lists[i].length ? lists[i].map(r => `<li class="lv-sev-${r.severity}"><div>${esc(r.action)}</div><div class="lv-why">Why: ${esc(r.why)}</div></li>`).join('') : '<li class="lv-sev-info"><div>No specific action from this page’s data.</div></li>'}</ol>`).join('')}
    </div>`;
  }

  function issuesList(a, domains) {
    const list = a.issues.filter(i => !domains || domains.includes(i.domain));
    if (!list.length) return `<div class="lv-ok"><i data-lucide="circle-check"></i>No warning signs in this data right now.</div>`;
    return `<div class="lv-issues">${list.map(i => `<div class="lv-issue lv-sev-${i.severity}"><span class="lv-chip lv-sev-${i.severity}">${esc(i.severity)}</span><div><b>${esc(i.title)}</b><div>${esc(i.detail)}</div><div class="lv-evidence">Evidence: ${esc(i.evidence)}</div></div></div>`).join('')}</div>`;
  }

  function science(a, domainKey, sourceNames, note) {
    const d = a.domains[domainKey];
    const rows = d ? Object.entries(d.metrics || {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `<tr><td>${esc((X[k] && X[k].label) || site().labels[k] || k)}</td><td>${site().metricValue(k, v)}</td><td class="lv-tech-cell">${esc((X[k] && X[k].tech) || '')}</td></tr>`).join('') : '';
    const srcs = a.sources.filter(s => sourceNames.some(n => s.name.includes(n)));
    return `<details class="lv-science lv-expert-open">
      <summary><i data-lucide="microscope"></i>Show the science: every reading, method and source</summary>
      ${note ? `<p class="lv-note">${esc(note)}</p>` : ''}
      ${rows ? `<div class="lv-table-wrap"><table class="lv-table"><thead><tr><th>Reading</th><th>Value</th><th>Method</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
      <div class="lv-sources">${srcs.map(s => `<div><span class="lv-chip lv-src-${s.status.replace(/\s/g, '')}">${esc(s.status)}</span> <b>${esc(s.name)}</b> · ${esc(s.provider)}${s.detail ? ' · ' + esc(s.detail) : ''}</div>`).join('')}</div>
    </details>`;
  }

  // ─── Site bar: choose / refresh the area from any page ────
  function siteBar(a) {
    const p = a && a.data.place;
    return `<div class="lv-sitebar">
      <div class="lv-site-now">${a ? `<i data-lucide="map-pin"></i> <b>${esc([p && p.name, p && p.country].filter(Boolean).join(', ') || 'Selected area')}</b> · ${a.aoi.areaHa.toLocaleString()} ha · analysed ${ago(a.generatedAt)}
        <button type="button" class="lv-link" data-lv="refresh" title="Fetch the newest satellite and weather data"><i data-lucide="refresh-cw"></i>Refresh now</button>
        <button type="button" class="lv-link" data-lv="open-si"><i data-lucide="map"></i>Map &amp; full analysis</button>
        <button type="button" class="lv-btn report-pdf-btn lv-pdf" data-report-pdf><i data-lucide="file-down"></i>PDF report</button>` : '<i data-lucide="map-pin"></i> <b>No area selected yet.</b> Click a field on the dashboard map, or search a farm, town or coordinates.'}</div>
      <form class="lv-search" data-lv="search">
        <input type="search" name="q" placeholder="Farm, town or coordinates (e.g. Goromonzi or -17.85, 31.35)" aria-label="Place to analyse">
        <select name="r" aria-label="Area size"><option value="500">500 m</option><option value="1000" selected>1 km</option><option value="2000">2 km</option><option value="5000">5 km</option><option value="10000">10 km</option><option value="25000">25 km</option></select>
        <button type="submit" class="lv-btn">Analyse</button>
        <button type="button" class="lv-btn-ghost" data-lv="locate" title="Use my current location"><i data-lucide="locate-fixed"></i>My location</button>
      </form>
      <div class="lv-view" role="group" aria-label="Level of detail"><button type="button" data-view="simple">Simple</button><button type="button" data-view="expert">Expert</button></div>
      <div class="lv-progress" hidden></div>
    </div>`;
  }

  const STEPS = ['Finding the area…', 'Reading Sentinel-2 10 m imagery…', 'Checking Landsat and ECOSTRESS thermal data…', 'Reading SoilGrids and iSDA soil maps…', 'Comparing rainfall with 25 years of records…', 'Checking rivers, dams, groundwater and forecast…', 'Checking FEWS NET food security and GDACS hazards…', 'Writing guidance…'];

  async function runFrom(host, body, label) {
    if (busy) return;
    busy = true;
    const prog = host.querySelector('.lv-progress');
    let i = 0;
    const tick = () => { if (prog) { prog.hidden = false; prog.innerHTML = `<span class="lv-spinner"></span>${esc(label ? `${label}: ` : '')}${esc(STEPS[Math.min(i++, STEPS.length - 1)])}`; } };
    tick();
    const t = setInterval(tick, 1700);
    host.querySelectorAll('.lv-search button, .lv-search input').forEach(el => { el.disabled = true; });
    try {
      await site().analyzeArea(body);
    } catch (e) {
      if (prog) { prog.hidden = false; prog.classList.add('lv-error'); prog.textContent = e.name === 'TimeoutError' ? 'The data services took too long. Please try again.' : e.message; }
      return;
    } finally {
      clearInterval(t);
      busy = false;
      host.querySelectorAll('.lv-search button, .lv-search input').forEach(el => { el.disabled = false; });
    }
  }

  function parseCoords(q) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(q);
    if (!m) return null;
    const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
  }

  // One delegated listener per page for all interactive bits.
  function wire(host) {
    if (host.dataset.lvWired) return;
    host.dataset.lvWired = '1';
    host.addEventListener('submit', async e => {
      const form = e.target.closest('[data-lv="search"]');
      if (!form) return;
      e.preventDefault();
      const q = form.q.value.trim(), r = Number(form.r.value);
      if (!q) return;
      const prog = host.querySelector('.lv-progress');
      if (prog) prog.classList.remove('lv-error');
      try {
        const c = parseCoords(q) || await site().geocode(q);
        await runFrom(host, { point: [c.lon, c.lat], radius_m: r }, q);
      } catch (err) {
        if (prog) { prog.hidden = false; prog.classList.add('lv-error'); prog.textContent = err.message; }
      }
    });
    host.addEventListener('click', e => {
      const t = e.target.closest('button, a');
      if (!t) return;
      if (t.classList.contains('lv-info')) {
        const tech = t.closest('.lv-card').querySelector('.lv-card-tech');
        tech.hidden = !tech.hidden;
        t.setAttribute('aria-expanded', String(!tech.hidden));
        return;
      }
      if (t.dataset.view) { expert = t.dataset.view === 'expert'; try { localStorage.setItem(VIEW_KEY, expert ? 'expert' : 'simple'); } catch (er) {} applyView(); return; }
      if (t.dataset.tab) {
        const box = t.closest('.lv-actions');
        box.querySelectorAll('.lv-tabs button').forEach(b => b.classList.toggle('on', b === t));
        box.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== t.dataset.tab; });
        return;
      }
      const act = t.dataset.lv;
      if (act === 'refresh' && A()) { runFrom(host, { geometry: A().aoi.geometry }, 'Refreshing'); }
      else if (act === 'open-si') { e.preventDefault(); site().openSiteIntelligence(); }
      else if (act === 'locate') {
        if (!navigator.geolocation) return;
        const prog = host.querySelector('.lv-progress');
        if (prog) { prog.hidden = false; prog.classList.remove('lv-error'); prog.textContent = 'Getting your location…'; }
        navigator.geolocation.getCurrentPosition(
          pos => runFrom(host, { point: [pos.coords.longitude, pos.coords.latitude], radius_m: 1000 }, 'Your location'),
          () => { if (prog) { prog.classList.add('lv-error'); prog.textContent = 'Location permission was refused. Search a place instead.'; } },
          { timeout: 15000 }
        );
      } else if (act === 'goto') { const l = document.querySelector(`.nav-link[data-page="${t.dataset.page}"]`); if (l) l.click(); }
    });
  }

  // ─── Charts and mini maps ─────────────────────────────────
  function chart(id, config) {
    const canvas = document.getElementById(id);
    if (!canvas || typeof Chart === 'undefined') return;
    if (charts.has(id)) charts.get(id).destroy();
    charts.set(id, new Chart(canvas.getContext('2d'), config));
  }

  async function ndviChart(id, note) {
    const el = document.getElementById(id);
    if (!el) return;
    const status = document.getElementById(note);
    try {
      const s = await site().ndviSeries();
      const series = s.series;
      const labels = series.map(x => x.month);
      const thisYear = series.slice(-12), lastYear = series.slice(-24, -12);
      chart(id, {
        type: 'line',
        data: {
          labels: thisYear.map(x => new Date(x.month + '-01').toLocaleString(undefined, { month: 'short' })),
          datasets: [
            { label: 'Last 12 months', data: thisYear.map(x => x.ndvi), borderColor: '#2f8f46', backgroundColor: 'rgba(47,143,70,0.12)', fill: true, tension: 0.35, spanGaps: true, pointRadius: 3 },
            { label: 'The 12 months before', data: lastYear.map(x => x.ndvi), borderColor: '#9aa5b1', borderDash: [5, 4], fill: false, tension: 0.35, spanGaps: true, pointRadius: 2 }
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { y: { min: 0, max: 1, title: { display: true, text: 'NDVI (greenness)' } } }, plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y === null ? 'cloudy month' : c.parsed.y.toFixed(2)}` } } } }
      });
      const clear = series.filter(x => x.ndvi !== null).length;
      if (status) status.textContent = `Real Sentinel-2 monthly greenness for this area (${clear} of ${labels.length} months had a clear view). Peaks show the growing season.`;
    } catch (e) {
      if (status) status.textContent = e.message;
    }
  }

  function aoiMap(id, a, extra) {
    const el = document.getElementById(id);
    if (!el || typeof L === 'undefined') return null;
    if (maps.has(id)) { maps.get(id).remove(); maps.delete(id); }
    const m = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Imagery © Esri', maxZoom: 18 }).addTo(m);
    const poly = L.polygon(a.aoi.geometry.coordinates[0].map(([x, y]) => [y, x]), { color: '#9BE07A', weight: 2, fillOpacity: 0.12 }).addTo(m);
    if (extra) extra(m);
    m.fitBounds(poly.getBounds(), { padding: [20, 20], maxZoom: 16 });
    maps.set(id, m);
    setTimeout(() => m.invalidateSize(), 200);
    return m;
  }

  const ALERT_COLOR = { red: '#d93025', orange: '#f29900', green: '#34a853' };
const HAZARD_ICON = { Drought: 'sun', Flood: 'waves', 'Tropical cyclone': 'tornado', Volcano: 'mountain-snow', Wildfire: 'flame', Earthquake: 'activity' };
  const hazardIcon = new Proxy({}, { get: (_, t) => `<i data-lucide="${HAZARD_ICON[t] || 'triangle-alert'}"></i>` });

  // ─── Page renderers ───────────────────────────────────────
  const PAGES = {
    'crop-monitoring': a => {
      const c = a.domains.crop, m = c.metrics || {};
      return `${plainBox(`Crops are ${c.status.toLowerCase()} here`, c.summary, toneOf(c.status))}
        ${cards(['ndvi', 'ndviAnomaly', 'ndviTrend', 'evaporativeStressIndex', 'ndre', 'landSurfaceTempC'], m)}
        <div class="lv-panel"><h3>Greenness over two years</h3><div class="lv-chart"><canvas id="lvCropChart"></canvas></div><p class="lv-note" id="lvCropNote">Loading 24 months of Sentinel-2 data…</p></div>
        <div class="lv-panel"><h3>How the area is covered</h3>${coverBar(m)}</div>
        <div class="lv-panel"><h3>What to do</h3>${actions(a, /crop|nitrogen|irrigat|pest|weed|scout|variet|plant|field/i)}</div>
        <div class="lv-panel"><h3>Warnings</h3>${issuesList(a, ['crop'])}</div>
        ${science(a, 'crop', ['Sentinel-2', 'Landsat', 'ECOSTRESS'], 'Greenness indices come from the newest Sentinel-2 scene that is clear over this exact area; history compares the same area one month and one year earlier.')}`;
    },
    'precision-farming': a => {
      const c = a.domains.crop, m = c.metrics || {}, s = a.domains.soil.metrics || {}, w = a.domains.waterQuantity.metrics || {};
      const need = Number.isFinite(w.et0Next16Mm) && Number.isFinite(w.rainNext16Mm) ? Math.max(0, Math.round(w.et0Next16Mm * 0.8 - w.rainNext16Mm)) : null;
      return `${plainBox('Your field at a glance', `${c.summary} ${need !== null ? (need > 0 ? `A growing crop will need about ${need} mm of extra water (irrigation or stored soil water) over the next 16 days.` : 'Forecast rain should cover crop water needs for the next 16 days.') : ''}`, toneOf(c.status))}
        <div class="lv-grid2">
          <div class="lv-panel"><h3>Your area on the map</h3><div class="lv-map" id="lvFarmMap"></div></div>
          <div class="lv-panel"><h3>Field zones</h3>
            <div class="lv-zones">
              ${zone('Weakest 10% of the field', m.ndviP10, 'Walk these parts first: look for pests, weeds, waterlogging or poor emergence.', 'bad')}
              ${zone('Typical part of the field', m.ndvi, 'The usual condition across the field.', 'watch')}
              ${zone('Best 10% of the field', m.ndviP90, 'What the whole field could look like with the same care.', 'good')}
            </div>
            <p class="lv-note">The gap between the weakest and best parts shows how uneven the field is; a big gap means targeted inputs pay off.</p>
          </div>
        </div>
        <div class="lv-panel"><h3>Water and soil for this field</h3>${cards(['waterBalanceNext16Mm', 'rootZoneAvailableWaterPct', 'pH', 'isdaPhosphorusMgKg', 'isdaPotassiumMgKg', 'availableWaterMmPerM'], { ...w, ...s })}
          ${need !== null ? `<div class="lv-tech lv-expert-only">Irrigation need ≈ max(0, 0.8 × ET₀ − rain) over 16 days = max(0, 0.8 × ${num(w.et0Next16Mm, 0)} − ${num(w.rainNext16Mm, 0)}) = ${need} mm (crop coefficient 0.8 assumed for a mid-season field crop).</div>` : ''}</div>
        <div class="lv-panel"><h3>What to do on this field</h3>${actions(a)}</div>
        ${science(a, 'crop', ['Sentinel-2', 'SoilGrids', 'iSDA', 'Open-Meteo'], 'Zones use the 10th, 50th and 90th percentile of NDVI across clear pixels inside your boundary.')}`;
    },
    'soil-analysis': a => {
      const s = a.domains.soil, m = s.metrics || {}, w = a.domains.waterQuantity.metrics || {};
      return `${plainBox(`Soil condition: ${s.status.toLowerCase()}`, s.summary, toneOf(s.status))}
        ${cards(['soilType', 'texture', 'pH', 'organicCarbonGkg', 'nitrogenGkg', 'cec', 'availableWaterMmPerM', 'isdaPhosphorusMgKg', 'isdaPotassiumMgKg'], m)}
        <div class="lv-grid2">
          <div class="lv-panel"><h3>What the soil is made of</h3>${textureBar(m)}</div>
          <div class="lv-panel"><h3>Acidity scale</h3>${phScale(m.pH ?? m.isdaPh)}</div>
        </div>
        <div class="lv-panel"><h3>Soil water right now</h3>${cards(['rootZoneAvailableWaterPct', 'smapSoilMoisture7d'], w)}${w.soilMoisture ? `<p class="lv-note">Modelled moisture by depth: ${site().metricValue('soilMoisture', w.soilMoisture)} m³/m³.</p>` : ''}</div>
        <div class="lv-panel"><h3>What to do</h3>${actions(a, /lime|fertil|phosph|potass|zinc|nitrogen|organic|compost|manure|soil|contour|erosion|legume/i)}</div>
        <div class="lv-panel"><h3>Warnings</h3>${issuesList(a, ['soil'])}</div>
        ${science(a, 'soil', ['SoilGrids', 'iSDA', 'SMAP', 'Open-Meteo'], 'Soil maps are model estimates (250 m SoilGrids, 30 m iSDAsoil). Confirm with a laboratory soil test before liming or buying fertiliser.')}`;
    },
    'water-resources': a => {
      const q = a.domains.waterQuantity, m = q.metrics || {}, wq = a.domains.waterQuality;
      return `${plainBox(`Water supply: ${q.status.toLowerCase()}`, q.summary, toneOf(q.status))}
        ${cards(['rain90PctNormal', 'rootZoneAvailableWaterPct', 'smapSoilMoisture7d', 'openWaterPctOfHistoricalMax', 'riverPctOfMedian', 'groundwaterTrendCmYr', 'groundwaterPercentile'], m)}
        ${m.reservoirs ? `<div class="lv-panel"><h3>Dam and lake levels (SWOT satellite)</h3><p>${esc(m.reservoirs)}</p></div>` : ''}
        <div class="lv-grid2">
          <div class="lv-panel"><h3>Rain compared with normal</h3><div class="lv-chart lv-chart-sm"><canvas id="lvRainChart"></canvas></div></div>
          <div class="lv-panel"><h3>Next 16 days: rain vs crop water need</h3><div class="lv-chart lv-chart-sm"><canvas id="lvFcChart"></canvas></div></div>
        </div>
        <div class="lv-panel"><h3>Water quality</h3>${wq.score === null ? `<p>${esc(wq.summary)}</p>` : `${plainBox(`Water quality: ${wq.status.toLowerCase()}`, wq.summary, toneOf(wq.status))}${cards(['turbidity', 'trophicState', 'chlorophyllAMgM3'], wq.metrics)}`}</div>
        <div class="lv-panel"><h3>What to do</h3>${actions(a, /water|irrigat|dam|borehole|river|flood|drink|boil|rain|sample|drain/i)}</div>
        <div class="lv-panel"><h3>Warnings</h3>${issuesList(a, ['water', 'waterQuality'])}</div>
        ${science(a, 'waterQuantity', ['ERA5', 'Open-Meteo', 'GloFAS', 'JRC', 'Sentinel-2', 'SMAP', 'GRACE', 'SWOT'], 'Rainfall anomalies compare the same calendar window in every year since 2001. Satellites see sediment and algae in water, not bacteria, metals or salinity.')}`;
    },
    'drought-monitor': a => {
      const q = a.domains.waterQuantity.metrics || {}, c = a.domains.crop.metrics || {};
      const z = q.spi90;
      const verdict = q.season ? 'It is the dry season here, so little rain is normal. Watch the soil water and the forecast for the start of the rains.'
        : !Number.isFinite(z) ? 'Not enough rainfall history to judge drought here.'
        : z <= -2 ? 'Extreme drought: rainfall is far below normal.' : z <= -1.5 ? 'Severe drought conditions.' : z <= -1 ? 'Moderate drought: rainfall is clearly below normal.' : z <= -0.5 ? 'Slightly drier than normal.' : z >= 1.5 ? 'Much wetter than normal: watch for floods and waterlogging.' : 'Rainfall is close to normal.';
      return `${plainBox('Drought check', verdict, Number.isFinite(z) && !q.season ? (z <= -1 ? 'bad' : z <= -0.5 ? 'watch' : 'good') : 'neutral')}
        <div class="lv-meters">${q.season ? '' : meter('Drought index (SPI-90)', z, -3, 3, ['Extreme drought', 'Normal', 'Very wet'])}${meter('Soil water around roots', q.rootZoneAvailableWaterPct, 0, 100, ['Driest', 'Middle', 'Wettest'], '%')}${meter('Crop thirst (ECOSTRESS)', c.evaporativeStressIndex, 0, 1, ['Very thirsty', '', 'No stress'])}</div>
        ${cards(['rain90PctNormal', 'rain30PctNormal', 'waterBalanceNext16Mm', 'hotDaysNext16', 'ndviAnomaly', 'smapSoilMoisture7d', 'groundwaterTrendCmYr'], { ...q, ...c })}
        <div class="lv-panel"><h3>Next 16 days</h3><div class="lv-chart lv-chart-sm"><canvas id="lvFcChart"></canvas></div></div>
        <div class="lv-panel"><h3>What to do</h3>${actions(a, /drought|water|mulch|variet|plant|heat|irrigat|basin|ridge|advisory|anticipat/i)}</div>
        <div class="lv-panel"><h3>Warnings</h3>${issuesList(a, ['water', 'climate', 'crop'])}</div>
        ${science(a, 'waterQuantity', ['ERA5', 'Open-Meteo', 'ECOSTRESS', 'SMAP', 'GRACE', 'Sentinel-2'], 'SPI-90 here is the z-score of 90-day rainfall against the same window in 2001–present (ERA5). In the dry season, low totals are expected and not treated as drought.')}`;
    },
    'early-warning': a => {
      const hz = (a.data.hazards && a.data.hazards.events) || [];
      const top = ['farmers', 'government', 'public'].map((k, i) => [['<i data-lucide="tractor"></i>Farmers', '<i data-lucide="landmark"></i>Government', '<i data-lucide="users"></i>Public'][i], a.recommendations[k][0]]).filter(([, r]) => r);
      return `${plainBox(`${a.overall.riskLevel} risk`, a.overall.headline, toneOf(a.overall.riskLevel))}
        <div class="lv-panel"><h3>Do this first</h3><div class="lv-first">${top.map(([w, r]) => `<div class="lv-first-item lv-sev-${r.severity}"><div class="lv-first-who">${w}</div><div>${esc(r.action)}</div></div>`).join('')}</div></div>
        <div class="lv-panel"><h3>All warnings for this area, most urgent first</h3>${issuesList(a)}</div>
        <div class="lv-grid2">
          <div class="lv-panel"><h3>Live hazards within 600 km (GDACS)</h3>${hz.length ? `<ul class="lv-hazards">${hz.map(e => `<li><span class="lv-dot" style="background:${ALERT_COLOR[e.alert] || '#999'}"></span>${hazardIcon[e.type]} <b>${esc(e.type)}</b> · ${esc(e.country)} · ${num(e.distanceKm, 0)} km · ${esc(e.alert)} alert${e.url ? ` · <a href="${esc(e.url)}" target="_blank" rel="noopener">report</a>` : ''}</li>`).join('')}</ul>` : '<div class="lv-ok"><i data-lucide="circle-check"></i>No active GDACS hazards within 600 km.</div>'}</div>
          <div class="lv-panel"><h3>Map</h3><div class="lv-map" id="lvWarnMap"></div></div>
        </div>
        ${science(a, 'waterQuantity', ['GDACS', 'Open-Meteo', 'ERA5', 'GloFAS', 'FEWS NET', 'Sentinel-2'], 'Warnings are generated from the live readings for this area; hazards come from GDACS and are checked every 15 minutes.')}`;
    },
    'food-security': a => {
      const f = a.data.foodSecurity, d = a.domains.foodSecurity || {};
      const phase = p => p ? `<div class="lv-ipc lv-ipc-${p.phase}"><b>Phase ${p.phase}</b><span>${esc(p.label)}</span><small>${esc(p.period)}</small></div>` : '';
      const people = n => n && n.low !== null ? `${(n.low / 1e6).toFixed(1)}–${((n.high ?? n.low) / 1e6).toFixed(1)} million` : '—';
      return `${plainBox('Food security', d.summary || 'No FEWS NET data for this area.', /Phase [345]/.test(d.status || '') ? 'bad' : /Phase 2/.test(d.status || '') ? 'watch' : 'good')}
        ${f && f.available ? `<div class="lv-panel"><h3>${esc(f.unitName)} (${esc(f.unitLevel)}): from now to the coming months</h3>
          <div class="lv-ipc-row">${phase(f.current)}${f.nearTerm ? '<span class="lv-arrow">→</span>' + phase(f.nearTerm) : ''}${f.mediumTerm ? '<span class="lv-arrow">→</span>' + phase(f.mediumTerm) : ''}</div>
          <p class="lv-note">IPC phases: 1 Minimal · 2 Stressed · 3 Crisis · 4 Emergency · 5 Famine. Phase 3 or worse means families cannot meet food needs without selling assets or receiving help.</p></div>
          <div class="lv-cards">
            <div class="lv-card lv-${f.nationalPhase3Plus && f.nationalPhase3Plus.low >= 1e6 ? 'bad' : 'watch'}"><div class="lv-card-top"><span class="lv-card-label">People in crisis nationally (Phase 3+)</span></div><div class="lv-card-value">${people(f.nationalPhase3Plus)}</div><div class="lv-card-plain">${f.nationalPhase3Plus ? esc(f.nationalPhase3Plus.period) : ''}</div></div>
            <div class="lv-card lv-watch"><div class="lv-card-top"><span class="lv-card-label">Projected at the peak</span></div><div class="lv-card-value">${people(f.nationalPhase3PlusProjected)}</div><div class="lv-card-plain">${f.nationalPhase3PlusProjected ? esc(f.nationalPhase3PlusProjected.period) : ''}</div></div>
          </div>` : ''}
        <div class="lv-panel"><h3>What the satellites say about the next harvest here</h3>${cards(['ndviAnomaly', 'rain90PctNormal', 'rootZoneAvailableWaterPct', 'evaporativeStressIndex'], { ...a.domains.crop.metrics, ...a.domains.waterQuantity.metrics })}</div>
        <div class="lv-panel"><h3>What to do</h3>${actions(a, /food|grain|assist|market|harvest|seed|ration|programme/i)}</div>
        ${science(a, 'crop', ['FEWS NET', 'Sentinel-2', 'ERA5'], 'District classifications come live from the FEWS NET Data Warehouse (IPC-compatible); satellite crop and rainfall signals show the drivers of the next harvest.')}`;
    }
  };

  const toneOf = s => (/good|low|minimal/i.test(s) ? 'good' : /fair|moderate|stressed/i.test(s) ? 'watch' : /poor|critical|high|crisis|emergency/i.test(s) ? 'bad' : 'neutral');
  function zone(title, v, text, tone) { return `<div class="lv-zone lv-${tone}"><div class="lv-zone-v">${num(v)}</div><div><b>${esc(title)}</b><div>${esc(text)}</div></div></div>`; }
  function coverBar(m) {
    const g = m.vegetatedPct || 0, s = m.sparsePct || 0, b = m.barePct || 0;
    return `<div class="lv-bar"><i style="width:${g}%;background:#2f8f46" title="Green ${g}%"></i><i style="width:${s}%;background:#c9b458" title="Sparse ${s}%"></i><i style="width:${b}%;background:#a0725a" title="Bare ${b}%"></i></div>
      <div class="lv-legend"><span><i style="background:#2f8f46"></i>Green crops ${num(g, 0)}%</span><span><i style="background:#c9b458"></i>Sparse ${num(s, 0)}%</span><span><i style="background:#a0725a"></i>Bare ${num(b, 0)}%</span></div>`;
  }
  function textureBar(m) {
    if (!Number.isFinite(m.sandPct)) return '<p class="lv-note">No texture data.</p>';
    return `<div class="lv-bar lv-bar-tall"><i style="width:${m.sandPct}%;background:#e2c08d">Sand ${num(m.sandPct, 0)}%</i><i style="width:${m.siltPct}%;background:#b9a38a">Silt ${num(m.siltPct, 0)}%</i><i style="width:${m.clayPct}%;background:#8a5a44;color:#fff">Clay ${num(m.clayPct, 0)}%</i></div>
      <p class="lv-note"><b>${esc(m.texture || '')}</b>: ${m.sandPct > 60 ? 'sandy soils drain fast and need water and fertiliser more often.' : m.clayPct > 35 ? 'clay soils hold water and nutrients but can waterlog and crack.' : 'a balanced soil that holds water and drains reasonably well.'}</p>`;
  }
  function phScale(ph) {
    if (!Number.isFinite(ph)) return '<p class="lv-note">No pH data.</p>';
    const pos = Math.min(100, Math.max(0, ((ph - 4) / 5) * 100));
    return `<div class="lv-ph"><div class="lv-ph-bar"></div><div class="lv-ph-mark" style="left:${pos}%"><b>${num(ph, 1)}</b></div></div>
      <div class="lv-ph-labels"><span>4 Very acidic</span><span>5.5</span><span>7 Neutral</span><span>9 Alkaline</span></div>
      <p class="lv-note">${ph < 5 ? 'Strongly acidic: lime is needed before planting.' : ph < 5.5 ? 'Acidic: liming will improve fertiliser uptake.' : ph <= 7.5 ? 'Good range for most crops.' : 'Alkaline: watch for zinc and iron shortage.'}</p>`;
  }
  function meter(label, v, min, max, ticks, unit = '') {
    if (!Number.isFinite(v)) return ''; // only show readings we actually have
    const pos = Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100));
    return `<div class="lv-meter"><div class="lv-meter-label">${esc(label)}</div><div class="lv-meter-bar"><i style="left:${pos}%"></i></div><div class="lv-meter-ticks">${ticks.map(t => `<span>${esc(t)}</span>`).join('')}</div><div class="lv-meter-value">${num(v, 2)}${unit}</div></div>`;
  }

  function afterRender(pageId, a) {
    if (pageId === 'crop-monitoring') ndviChart('lvCropChart', 'lvCropNote');
    if (pageId === 'precision-farming') aoiMap('lvFarmMap', a);
    if (pageId === 'water-resources') {
      const q = a.domains.waterQuantity.metrics || {};
      chart('lvRainChart', { type: 'bar', data: { labels: ['Last 30 days', 'Last 90 days'], datasets: [{ label: 'This year (mm)', data: [q.rain30Mm, q.rain90Mm], backgroundColor: '#3a86c8' }, { label: 'Normal (mm)', data: [q.rain30NormalMm, q.rain90NormalMm], backgroundColor: '#c7d2dc' }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' } } } });
    }
    if (pageId === 'water-resources' || pageId === 'drought-monitor') {
      const fc = (a.data.weather && a.data.weather.forecastDaily) || [];
      chart('lvFcChart', { data: { labels: fc.map(d => d.date.slice(5)), datasets: [{ type: 'bar', label: 'Rain (mm)', data: fc.map(d => d.rainMm), backgroundColor: '#3a86c8' }, { type: 'line', label: 'Crop water need ET₀ (mm)', data: fc.map(d => d.et0Mm), borderColor: '#e8a33a', tension: 0.3, pointRadius: 2 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' } } } });
    }
    if (pageId === 'early-warning') aoiMap('lvWarnMap', a, m => {
      ((a.data.hazards && a.data.hazards.events) || []).forEach(e => L.circleMarker([e.lat, e.lon], { radius: 8, color: '#fff', weight: 2, fillColor: ALERT_COLOR[e.alert] || '#999', fillOpacity: 0.95 }).bindPopup(`${hazardIcon[e.type]} <b>${esc(e.type)}</b><br>${esc(e.country)}<br>${esc(e.alert)} alert · ${num(e.distanceKm, 0)} km away`).addTo(m));
    });
  }

  function render(pageId) {
    const page = document.getElementById('pg-' + pageId);
    if (!page) return;
    const host = page.querySelector('.lv-host');
    if (!host) return;
    wire(host);
    const a = A();
    if (!a) {
      host.innerHTML = `${siteBar(null)}<div class="lv-empty"><div class="lv-empty-icon"><i data-lucide="satellite"></i></div><h3>See live satellite results for any farm or region</h3><p>Zoom into the Dashboard map and click a field, or search a place above, or use your location. WAFEO reads the newest Sentinel-2 and Landsat imagery, soil maps, rainfall records, river flow, food-security and hazard alerts for that exact area, then explains what they mean and what to do.</p></div>`;
    } else {
      const fn = PAGES[pageId];
      host.innerHTML = siteBar(a) + (fn ? fn(a) : '');
      afterRender(pageId, a);
    }
    applyView();
  }

  // ─── Dashboard ────────────────────────────────────────────
  let hazardLayer = null, siteLayer = null, hazardsAt = 0, liveHazards = [];

  async function loadHazards() {
    if (Date.now() - hazardsAt < 10 * 60 * 1000 && liveHazards.length) return liveHazards;
    const res = await fetch(API + '/live/hazards', { headers: authHeaders() });
    if (!res.ok) throw new Error('Live hazard feed unavailable');
    const j = await res.json();
    liveHazards = j.events || [];
    hazardsAt = Date.now();
    return liveHazards;
  }

  // The dashboard map is the world atlas (atlas.js); clicks there start analyses here.
  function attachDashboardMap() {
    const atlas = window.wafeoAtlas;
    if (!atlas || atlas._wafeoLive) return;
    atlas._wafeoLive = true;
    atlas.onAnalyse = (body, label) => {
      const host = document.querySelector('#pg-dashboard .lv-host');
      runFrom(host, body, label);
      host.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }

  async function drawDashboardMap(fly) {
    const atlas = window.wafeoAtlas;
    if (!atlas) return;
    try { atlas.setHazards(await loadHazards()); } catch (e) { /* hazard layer is optional */ }
    const a = A();
    atlas.setAoi(a ? a.aoi.geometry : null, fly);
  }

  function renderDashboard() {
    const host = document.querySelector('#pg-dashboard .lv-host');
    if (!host) return;
    wire(host);
    const a = A();
    const kpi = (title, d, page, extra) => d ? `<button type="button" class="lv-kpi lv-${toneOf(d.status)}" data-lv="goto" data-page="${page}"><span>${esc(title)}</span><b>${esc(d.status)}${Number.isFinite(d.score) ? ` · ${d.score}` : ''}</b><small>${esc(extra || d.summary || '').slice(0, 120)}</small></button>` : '';
    const red = liveHazards.filter(e => e.alert === 'red').length, orange = liveHazards.filter(e => e.alert === 'orange').length;
    host.innerHTML = siteBar(a) + (a ? `
      <div class="lv-kpis">
        <button type="button" class="lv-kpi lv-${toneOf(a.overall.riskLevel)}" data-lv="goto" data-page="early-warning"><span>Overall</span><b>${esc(a.overall.riskLevel)} risk</b><small>${esc(a.overall.headline)}</small></button>
        ${kpi('Crops', a.domains.crop, 'crop-monitoring')}
        ${kpi('Water', a.domains.waterQuantity, 'water-resources')}
        ${kpi('Soil', a.domains.soil, 'soil-analysis')}
        ${kpi('Food security', a.domains.foodSecurity, 'food-security')}
      </div>
      <div class="lv-grid2">
        <div class="lv-panel"><h3>What to do now</h3>${actions(a)}</div>
        <div class="lv-panel"><h3>Greenness over two years</h3><div class="lv-chart lv-chart-sm"><canvas id="lvDashNdvi"></canvas></div><p class="lv-note" id="lvDashNdviNote">Loading Sentinel-2 history…</p></div>
      </div>` : `<div class="lv-empty"><div class="lv-empty-icon"><i data-lucide="mouse-pointer-click"></i></div><h3>Zoom into the map and click a field to analyse it</h3><p>Spin the globe or switch to the flat map, open any country from the Atlas, then zoom in until you can see fields. Clicking inside a field traces its outline from the latest satellite image, ready for a full analysis. You can also search a place above. Coloured dots are live hazard alerts (red is most severe).</p></div>`) + `
      <div class="lv-panel"><h3>Live hazard alerts worldwide (GDACS)</h3>
        <p class="lv-note">${red} red and ${orange} orange alerts in the last 45 days · checked ${hazardsAt ? ago(new Date(hazardsAt).toISOString()) : 'now'} · click a dot on the map for details.</p>
        <ul class="lv-hazards">${liveHazards.filter(e => e.alert !== 'green').slice(0, 8).map(e => `<li><span class="lv-dot" style="background:${ALERT_COLOR[e.alert]}"></span>${hazardIcon[e.type]} <b>${esc(e.type)}</b> · ${esc(e.country)} · ${esc(String(e.from).slice(0, 10))}${e.url ? ` · <a href="${esc(e.url)}" target="_blank" rel="noopener">report</a>` : ''}</li>`).join('') || '<li>No orange or red alerts right now.</li>'}</ul>
      </div>`;
    if (a) ndviChart('lvDashNdvi', 'lvDashNdviNote');
    applyView();
    updateFreshness();
  }

  async function dashboard() {
    // The map is created while its page may be hidden; resize once visible.
    if (window.wafeoAtlas) { window.wafeoAtlas.init(); window.wafeoAtlas.resize(); }
    renderDashboard();
    try { await loadHazards(); } catch (e) {}
    renderDashboard();
    attachDashboardMap();
    drawDashboardMap();
  }

  // ─── Header: freshness and notifications ──────────────────
  function updateFreshness() {
    const a = A();
    // Sidebar badges follow the live analysis.
    const setBadge = (page, text, cls) => {
      const link = document.querySelector(`.nav-link[data-page="${page}"]`);
      if (!link) return;
      let b = link.querySelector('.badge');
      if (!text) { if (b) b.remove(); return; }
      if (!b) { b = document.createElement('span'); link.appendChild(b); }
      b.className = 'badge ' + cls;
      b.textContent = text;
    };
    const dry = a ? a.issues.filter(i => ['water', 'climate'].includes(i.domain) && ['critical', 'high', 'medium'].includes(i.severity)).length : 0;
    setBadge('drought-monitor', dry ? String(dry) : '', 'crit');
    const fsd = a && a.domains.foodSecurity;
    const ph = fsd && /Phase (\d)/.exec(fsd.status || '');
    setBadge('food-security', ph ? `IPC ${ph[1]}` : '', ph && Number(ph[1]) >= 3 ? 'crit' : 'warn');
  }

  // ─── Wiring ───────────────────────────────────────────────
  const PAGE_IDS = Object.keys(PAGES);
  function currentPage() { const el = document.querySelector('.page.active'); return el ? el.id.replace('pg-', '') : null; }

  document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => {
    const pg = link.dataset.page;
    if (PAGE_IDS.includes(pg)) setTimeout(() => render(pg), 30);
    if (pg === 'dashboard') setTimeout(dashboard, 30);
  }));

  document.addEventListener('wafeo:analysis', () => {
    const pg = currentPage();
    if (PAGE_IDS.includes(pg)) render(pg);
    if (pg === 'dashboard') renderDashboard();
    drawDashboardMap(pg === 'dashboard');
    updateFreshness();
  });
  // Keep results current: an analysis older than 6 hours refreshes itself.
  const STALE_MS = 6 * 60 * 60 * 1000;
  function refreshIfStale() {
    const a = A();
    if (!a || busy || Date.now() - Date.parse(a.generatedAt) < STALE_MS) return;
    const pg = currentPage();
    const host = document.querySelector(`#pg-${pg} .lv-host`) || document.querySelector('#pg-dashboard .lv-host');
    if (host) runFrom(host, { geometry: a.aoi.geometry }, 'Updating to the latest data');
  }
  document.addEventListener('wafeo:auth', () => setTimeout(() => { updateFreshness(); if (currentPage() === 'dashboard') dashboard(); refreshIfStale(); }, 400));
  setInterval(() => { updateFreshness(); if (currentPage() === 'dashboard') dashboard(); refreshIfStale(); }, 15 * 60 * 1000);

  window.wafeoLive = { render, dashboard, attachDashboardMap, explain: X };
})();
