// ════════════════════════════════════════════════════════════
//  WAFEO — live satellite site analysis (frontend)
//  Site Intelligence: choose a point + radius or draw a farm,
//  call /api/eo/analyze, and show results. The latest analysis
//  also feeds the domain pages and the report generator.
//  Loaded after app.js (uses API, authHeaders, escapeHtml, siMap).
// ════════════════════════════════════════════════════════════
(function () {
  const STORE_KEY = 'wafeo.lastAnalysis';
  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s ?? ''));
  const fmt = (v, d = 2) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'number' ? Number(v.toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d }) : esc(v));

  const state = { mode: 'point', radius: 1000, point: null, drawPts: [], busy: false, last: null };
  const layers = { aoi: null, draft: null, vertices: [] };

  try { state.last = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { state.last = null; }

  // ─── Labels ───────────────────────────────────────────────
  const DOMAINS = [
    ['crop', 'Crop condition', '🌱'],
    ['waterQuantity', 'Water quantity', '💧'],
    ['waterQuality', 'Water quality', '🧪'],
    ['soil', 'Soil', '🟫'],
    ['land', 'Land & terrain', '⛰️']
  ];
  const METRIC_LABELS = {
    ndvi: 'NDVI (vegetation vigour)', ndviP10: 'NDVI, weakest 10%', ndviP90: 'NDVI, best 10%', evi: 'EVI', savi: 'SAVI (soil-adjusted)',
    ndre: 'NDRE (nitrogen status)', chlorophyllIndexRedEdge: 'Red-edge chlorophyll index', ndmi: 'NDMI (canopy water)',
    ndviMonthAgo: 'NDVI one month ago', ndviLastYear: 'NDVI same season last year', ndviTrend: 'NDVI change, last month', ndviAnomaly: 'NDVI vs last year',
    vegetatedPct: 'Green cover (NDVI ≥ 0.4), %', sparsePct: 'Sparse vegetation, %', barePct: 'Bare soil, %',
    landSurfaceTempC: 'Land surface temperature, °C', landSurfaceTempP90C: 'Hottest 10% of area, °C',
    rain30Mm: 'Rain, last 30 days (mm)', rain30NormalMm: 'Normal for those 30 days (mm)', rain30PctNormal: 'Last 30 days, % of normal',
    rain90Mm: 'Rain, last 90 days (mm)', rain90NormalMm: 'Normal for those 90 days (mm)', rain90PctNormal: 'Last 90 days, % of normal', spi90: 'SPI-90 (drought index)',
    season: 'Season', waterBalance30Mm: 'Rain − evaporation, last 30 days (mm)', et0Past30Mm: 'Evaporative demand ET₀, last 30 days (mm)',
    rainNext16Mm: 'Rain forecast, next 16 days (mm)', et0Next16Mm: 'ET₀ forecast, next 16 days (mm)', waterBalanceNext16Mm: 'Rain − ET₀, next 16 days (mm)',
    hotDaysNext16: 'Days ≥ 35 °C, next 16 days', soilMoisture: 'Modelled soil moisture (m³/m³)', rootZoneAvailableWaterPct: 'Root-zone available water, %',
    openWaterNowHa: 'Open water now (ha)', waterHistoricalMaxHa: 'Largest water extent since 1984 (ha)', waterPermanentHa: 'Permanent water (ha)',
    openWaterPctOfHistoricalMax: 'Open water, % of historical max', riverDischargeM3s: 'River discharge (m³/s)', riverPctOfMedian: 'River flow, % of median',
    riverForecastPeakPctOfMedian: '14-day peak flow, % of median', groundwater: 'Groundwater',
    openWaterHa: 'Open water assessed (ha)', turbidity: 'Turbidity', chlorophyllAMgM3: 'Chlorophyll-a, approx. (mg/m³)', trophicState: 'Algae level', ndti: 'NDTI (turbidity index)', ndci: 'NDCI (chlorophyll index)',
    soilType: 'Soil type (WRB)', texture: 'Texture (USDA)', sandPct: 'Sand, %', siltPct: 'Silt, %', clayPct: 'Clay, %', pH: 'pH (water)', organicCarbonGkg: 'Organic carbon (g/kg)',
    nitrogenGkg: 'Total nitrogen (g/kg)', cec: 'CEC (cmol(+)/kg)', bulkDensity: 'Bulk density (g/cm³)', availableWaterMmPerM: 'Plant-available water (mm/m)',
    croplandPct: 'Cropland, %', elevationM: 'Elevation (m)', slopeMeanDeg: 'Mean slope (°)', steepPct: 'Area steeper than 8°, %', landCover: 'Land cover'
  };
  const KEY_METRICS = {
    crop: ['ndvi', 'ndviAnomaly', 'ndre', 'landSurfaceTempC'],
    waterQuantity: ['rain90PctNormal', 'rootZoneAvailableWaterPct', 'rainNext16Mm', 'openWaterPctOfHistoricalMax'],
    waterQuality: ['turbidity', 'trophicState', 'chlorophyllAMgM3', 'openWaterHa'],
    soil: ['soilType', 'texture', 'pH', 'organicCarbonGkg'],
    land: ['croplandPct', 'elevationM', 'slopeMeanDeg', 'steepPct']
  };
  const statusClass = s => (/good|low risk/i.test(s) ? 'optimal' : /fair|moderate/i.test(s) ? 'watch' : /poor|critical|high/i.test(s) ? 'concern' : 'neutral');
  const sevClass = s => ({ critical: 'concern', high: 'concern', medium: 'watch', low: 'neutral', info: 'optimal' }[s] || 'neutral');

  function metricValue(k, v) {
    if (k === 'soilMoisture' && v && typeof v === 'object') return Object.entries(v).map(([d, x]) => `${esc(d)}: ${fmt(x, 3)}`).join(' · ');
    if (k === 'landCover' && Array.isArray(v)) return v.map(c => `${esc(c.name)} ${fmt(c.pct, 1)}%`).join(', ');
    if (['ndviTrend', 'ndviAnomaly'].includes(k) && typeof v === 'number') return (v >= 0 ? '+' : '') + v.toFixed(2);
    return fmt(v);
  }

  // ─── Toolbar on the Site Intelligence page ────────────────
  function buildToolbar() {
    const header = document.querySelector('#pg-site-intelligence .site-intel-header');
    if (!header || document.getElementById('eoToolbar')) return;
    const bar = document.createElement('div');
    bar.id = 'eoToolbar';
    bar.className = 'eo-toolbar';
    bar.innerHTML = `
      <div class="eo-seg" role="group" aria-label="How to choose the area">
        <button type="button" class="eo-seg-btn active" data-mode="point">📍 Point + radius</button>
        <button type="button" class="eo-seg-btn" data-mode="draw">✏️ Draw farm boundary</button>
      </div>
      <label class="eo-radius" data-for="point">Radius
        <select id="eoRadius">
          <option value="250">250 m (small plot)</option><option value="500">500 m</option>
          <option value="1000" selected>1 km (farm)</option><option value="2000">2 km</option>
          <option value="5000">5 km (ward)</option><option value="10000">10 km</option><option value="25000">25 km (district)</option>
        </select>
      </label>
      <div class="eo-draw-actions" data-for="draw" hidden>
        <button type="button" class="eo-btn-ghost" id="eoUndo">Undo point</button>
        <button type="button" class="eo-btn-ghost" id="eoClear">Clear</button>
      </div>
      <button type="button" class="eo-btn" id="eoRun">Analyse with satellites</button>
      <span class="eo-hint" id="eoHint">Search a place or click the map to choose a farm, then press Analyse.</span>`;
    header.insertBefore(bar, header.querySelector('.si-tabs'));

    bar.querySelectorAll('.eo-seg-btn').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
    document.getElementById('eoRadius').addEventListener('change', e => { state.radius = Number(e.target.value); if (state.point) drawPointAoi(); });
    document.getElementById('eoUndo').addEventListener('click', () => { state.drawPts.pop(); drawDraft(); });
    document.getElementById('eoClear').addEventListener('click', () => { state.drawPts = []; drawDraft(); });
    document.getElementById('eoRun').addEventListener('click', () => run());

    // Tabs: rename "Regulatory" to Guidance and add Sources.
    const tabs = document.querySelector('#pg-site-intelligence .si-tabs');
    const reg = tabs && tabs.querySelector('[data-tab="regulatory"]');
    if (reg) reg.textContent = 'Guidance';
    if (tabs && !tabs.querySelector('[data-tab="sources"]')) {
      const b = document.createElement('button');
      b.className = 'si-tab-btn'; b.dataset.tab = 'sources'; b.textContent = 'Sources';
      tabs.appendChild(b);
      const pane = document.createElement('div');
      pane.className = 'si-tab-content'; pane.id = 'siTab-sources'; pane.style.cssText = 'padding:20px; display:none;';
      pane.innerHTML = '<div id="eoSources" class="eo-sources"></div>';
      document.querySelector('#pg-site-intelligence .si-data-panel').appendChild(pane);
      b.addEventListener('click', () => {
        document.querySelectorAll('.si-tab-btn').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.si-tab-content').forEach(c => { c.style.display = 'none'; });
        b.classList.add('active'); pane.style.display = 'block';
      });
    }
  }

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('#eoToolbar .eo-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    document.querySelector('#eoToolbar [data-for="point"]').hidden = mode !== 'point';
    document.querySelector('#eoToolbar [data-for="draw"]').hidden = mode !== 'draw';
    hint(mode === 'draw' ? 'Click the map at each corner of your farm (at least 3), then press Analyse.' : 'Search a place or click the map to choose a farm, then press Analyse.');
    if (mode === 'draw') { clearAoi(); drawDraft(); } else { clearDraft(); if (state.point) drawPointAoi(); }
  }

  function hint(text, isError) {
    const h = document.getElementById('eoHint');
    if (h) { h.textContent = text; h.classList.toggle('eo-hint-error', !!isError); }
  }

  // ─── Map drawing ──────────────────────────────────────────
  const mapReady = () => (typeof siMap !== 'undefined' && siMap) ? siMap : null;
  function clearAoi() { if (layers.aoi && mapReady()) siMap.removeLayer(layers.aoi); layers.aoi = null; }
  function clearDraft() {
    if (!mapReady()) return;
    if (layers.draft) siMap.removeLayer(layers.draft);
    layers.vertices.forEach(v => siMap.removeLayer(v));
    layers.draft = null; layers.vertices = [];
  }
  function drawPointAoi() {
    if (!mapReady() || !state.point) return;
    clearAoi();
    layers.aoi = L.circle([state.point.lat, state.point.lon], { radius: state.radius, color: '#9BE07A', weight: 2, fillOpacity: 0.12 }).addTo(siMap);
  }
  function drawDraft() {
    if (!mapReady()) return;
    clearDraft();
    const pts = state.drawPts.map(p => [p.lat, p.lon]);
    layers.vertices = pts.map(p => L.circleMarker(p, { radius: 5, color: '#fff', weight: 2, fillColor: '#3F8F3A', fillOpacity: 1 }).addTo(siMap));
    if (pts.length >= 2) layers.draft = (pts.length >= 3 ? L.polygon(pts, { color: '#9BE07A', weight: 2, dashArray: '6 4', fillOpacity: 0.1 }) : L.polyline(pts, { color: '#9BE07A', weight: 2, dashArray: '6 4' })).addTo(siMap);
    if (state.mode === 'draw') hint(state.drawPts.length < 3 ? `${state.drawPts.length} corner(s) placed. Add at least ${3 - state.drawPts.length} more.` : `${state.drawPts.length} corners. Press Analyse, or keep adding corners.`);
  }
  function showResultAoi(geometry) {
    if (!mapReady()) return;
    clearAoi(); clearDraft();
    const latlngs = geometry.coordinates[0].map(([x, y]) => [y, x]);
    layers.aoi = L.polygon(latlngs, { color: '#9BE07A', weight: 2, fillOpacity: 0.1 }).addTo(siMap);
    siMap.fitBounds(layers.aoi.getBounds(), { padding: [30, 30], maxZoom: 16 });
  }

  // ─── Entry point used by search, global search and map clicks ──
  async function analyze(query) {
    buildToolbar();
    if (typeof initSiGlobalMap === 'function') initSiGlobalMap();
    if (query && typeof query === 'object' && Number.isFinite(query.lat)) {
      if (state.mode === 'draw') { state.drawPts.push({ lat: query.lat, lon: query.lon }); drawDraft(); return; }
      state.point = { lat: query.lat, lon: query.lon };
      drawPointAoi();
      hint(`Area: ${query.lat.toFixed(4)}, ${query.lon.toFixed(4)} · radius ${state.radius >= 1000 ? state.radius / 1000 + ' km' : state.radius + ' m'}. Press Analyse.`);
      return;
    }
    if (typeof query === 'string' && query.trim()) {
      hint('Finding place…');
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`);
        const g = await res.json();
        if (!g.length) return hint(`"${query}" was not found. Try a nearby town or click the map.`, true);
        setMode('point');
        state.point = { lat: parseFloat(g[0].lat), lon: parseFloat(g[0].lon) };
        if (mapReady()) siMap.flyTo([state.point.lat, state.point.lon], 13, { duration: 1.2 });
        drawPointAoi();
        return run();
      } catch (e) {
        return hint('Place search is unavailable right now. Click the map instead.', true);
      }
    }
  }

  // ─── Run the analysis ─────────────────────────────────────
  const STEPS = ['Searching Sentinel-2 scenes…', 'Reading 10 m bands for your area…', 'Checking Landsat thermal and terrain…', 'Reading SoilGrids soil layers…', 'Comparing rainfall with 25 years of ERA5…', 'Checking rivers and the 16-day forecast…', 'Writing guidance…'];

  async function run() {
    if (state.busy) return;
    let body;
    if (state.mode === 'draw') {
      if (state.drawPts.length < 3) return hint('Place at least 3 corners on the map first.', true);
      const ring = state.drawPts.map(p => [p.lon, p.lat]);
      ring.push([...ring[0]]);
      body = { geometry: { type: 'Polygon', coordinates: [ring] } };
    } else {
      if (!state.point) return hint('Search a place or click the map to choose the area first.', true);
      body = { point: [state.point.lon, state.point.lat], radius_m: state.radius };
    }

    state.busy = true;
    const btn = document.getElementById('eoRun');
    btn.disabled = true; btn.textContent = 'Analysing…';
    const overlay = document.getElementById('siScanOverlay');
    const overlayText = overlay && overlay.querySelector('div:last-child');
    if (overlay) overlay.style.opacity = '1';
    let step = 0;
    const ticker = setInterval(() => { if (overlayText) overlayText.textContent = STEPS[Math.min(step++, STEPS.length - 1)]; }, 1600);
    if (overlayText) overlayText.textContent = STEPS[step++];

    try {
      const res = await fetch(API + '/eo/analyze', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
      if (res.status === 401 && typeof handleExpiredSession === 'function') return handleExpiredSession();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Analysis failed.');
      setLast(data);
      showResultAoi(data.aoi.geometry);
      renderSite(data);
      hint(`Analysed ${data.aoi.areaHa.toLocaleString()} ha. Results are also on the Crop, Soil, Water and Drought pages and in Reports.`);
    } catch (e) {
      hint(e.name === 'TimeoutError' ? 'The satellite services took too long. Please try again.' : e.message, true);
    } finally {
      clearInterval(ticker);
      if (overlay) overlay.style.opacity = '0';
      if (overlayText) overlayText.textContent = 'Acquiring Satellite Telemetry...';
      btn.disabled = false; btn.textContent = 'Analyse with satellites';
      state.busy = false;
    }
  }

  function setLast(data) {
    state.last = data;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) { /* storage full or blocked */ }
    document.dispatchEvent(new CustomEvent('wafeo:analysis', { detail: data }));
    renderAllContexts();
  }

  // ─── Rendering: Site Intelligence tabs ────────────────────
  function renderSite(a) {
    const p = a.data.place || {};
    document.getElementById('siSiteName').textContent = [p.name, p.country].filter(Boolean).join(', ') || 'Selected area';
    const s2 = a.data.sentinel2 && a.data.sentinel2.scene;
    document.getElementById('siSiteMeta').textContent = `${a.aoi.areaHa.toLocaleString()} ha · ${a.aoi.centroid[1].toFixed(4)}, ${a.aoi.centroid[0].toFixed(4)}` + (s2 ? ` · Sentinel-2 ${s2.date} (${s2.aoiClearPct}% clear)` : '');

    // Overview
    document.getElementById('siMetricsGrid').innerHTML = `
      <div class="si-card eo-overall eo-${statusClass(a.overall.riskLevel)}">
        <div class="si-card-hdr"><div class="si-card-title">Overall assessment</div><span class="si-badge ${statusClass(a.overall.riskLevel)}">${esc(a.overall.riskLevel)} risk</span></div>
        <div class="eo-headline">${esc(a.overall.headline)}</div>
        ${Number.isFinite(a.overall.score) ? `<div class="eo-score"><div class="eo-score-bar"><i style="width:${a.overall.score}%"></i></div><b>${a.overall.score}/100</b></div>` : ''}
      </div>
      ${DOMAINS.map(([k, title, icon]) => domainCard(a.domains[k], title, icon, KEY_METRICS[k])).join('')}`;

    // Evidence: issues + every reading
    const issues = a.issues.length ? a.issues.map(i => `
      <div class="si-compare-item ${i.severity === 'info' ? 'positive' : ['critical', 'high'].includes(i.severity) ? 'negative' : ''}">
        <div class="si-compare-title"><span class="si-badge ${sevClass(i.severity)}">${esc(i.severity)}</span> ${esc(i.title)}</div>
        <div class="si-compare-desc">${esc(i.detail)}</div>
        <div class="eo-evidence">Evidence: ${esc(i.evidence)}</div>
      </div>`).join('') : '<div class="si-card-desc">No warning signs detected.</div>';
    const tables = DOMAINS.map(([k, title]) => metricTable(title, a.domains[k])).join('');
    const fc = a.data.weather && a.data.weather.forecastDaily;
    const forecast = fc ? `<h4 class="eo-h4">16-day forecast</h4><div class="eo-table-wrap"><table class="eo-table"><thead><tr><th>Date</th><th>Rain (mm)</th><th>Max °C</th><th>ET₀ (mm)</th></tr></thead><tbody>${fc.map(r => `<tr><td>${esc(r.date.slice(5))}</td><td>${fmt(r.rainMm, 1)}</td><td>${fmt(r.tmaxC, 1)}</td><td>${fmt(r.et0Mm, 1)}</td></tr>`).join('')}</tbody></table></div>` : '';
    document.getElementById('siCompareList').innerHTML = `<h4 class="eo-h4">Findings (most urgent first)</h4>${issues}<h4 class="eo-h4">All readings</h4>${tables}${forecast}`;

    // Guidance
    document.getElementById('siRegList').innerHTML = guidanceHtml(a.recommendations);

    // Sources
    const srcEl = document.getElementById('eoSources');
    if (srcEl) srcEl.innerHTML = sourcesHtml(a.sources);
  }

  function domainCard(d, title, icon, keys) {
    if (!d) return '';
    // In the dry season, percent-of-normal rainfall is misleading: lead with the season note.
    if (d.metrics && d.metrics.season && keys && keys[0] === 'rain90PctNormal') keys = ['season', ...keys.slice(1)];
    const metrics = (keys || []).filter(k => d.metrics && d.metrics[k] !== undefined && d.metrics[k] !== null)
      .map(k => `<div><span>${esc(METRIC_LABELS[k] || k)}</span><b>${metricValue(k, d.metrics[k])}</b></div>`).join('');
    return `<div class="si-card">
      <div class="si-card-hdr"><div class="si-card-title">${icon} ${esc(title)}</div><span class="si-badge ${statusClass(d.status)}">${esc(d.status)}${Number.isFinite(d.score) ? ' · ' + d.score : ''}</span></div>
      <div class="si-card-desc">${esc(d.summary)}</div>
      ${metrics ? `<div class="eo-kv">${metrics}</div>` : ''}
    </div>`;
  }

  function metricTable(title, d) {
    if (!d || !d.metrics || !Object.keys(d.metrics).length) return '';
    const rows = Object.entries(d.metrics).filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `<tr><td>${esc(METRIC_LABELS[k] || k)}</td><td>${metricValue(k, v)}</td></tr>`).join('');
    return `<details class="eo-details" open><summary>${esc(title)}</summary><div class="eo-table-wrap"><table class="eo-table"><tbody>${rows}</tbody></table></div></details>`;
  }

  function guidanceHtml(rec) {
    const block = (who, title, icon) => `
      <div class="eo-guide">
        <h4 class="eo-h4">${icon} ${title}</h4>
        <ol class="eo-actions">${(rec[who] || []).map(r => `
          <li><div class="eo-action"><span class="si-badge ${sevClass(r.severity)}">${r.severity === 'info' ? 'routine' : esc(r.severity)}</span> ${esc(r.action)}</div>
          <div class="eo-why">Why: ${esc(r.why)}</div></li>`).join('')}</ol>
      </div>`;
    return block('farmers', 'Farmers', '👩🏾‍🌾') + block('government', 'Government & extension', '🏛️') + block('public', 'Public', '👥') +
      '<p class="eo-note">Guidance is generated from satellite, soil and weather data for this area. Confirm field decisions with local extension officers (e.g. AGRITEX) and official advisories.</p>';
  }

  function sourcesHtml(sources) {
    const chip = s => ({ live: 'optimal', unavailable: 'watch', failed: 'concern', 'not connected': 'neutral' }[s] || 'neutral');
    return `<p class="si-card-desc" style="margin-bottom:12px">Every figure comes from these sources. “Live” means data was fetched for this exact area just now.</p>` +
      sources.map(s => `<div class="si-reg-item">
        <div class="si-reg-title"><span>${esc(s.name)}</span> <span class="si-badge ${chip(s.status)}">${esc(s.status)}</span></div>
        <div class="si-card-desc">${esc(s.measures)}</div>
        <div class="eo-evidence">${esc(s.provider)}${s.detail ? ' · ' + esc(s.detail) : ''}</div>
      </div>`).join('');
  }

  // ─── Live context on the domain pages ─────────────────────
  const PAGE_CONTEXT = {
    'crop-monitoring': { title: 'Crop condition', domains: ['crop'] },
    'precision-farming': { title: 'Field condition', domains: ['crop', 'soil'] },
    'soil-analysis': { title: 'Soil and soil water', domains: ['soil'], extra: a => metricTable('Soil moisture & water', { metrics: pick(a.domains.waterQuantity.metrics, ['soilMoisture', 'rootZoneAvailableWaterPct']) }) },
    'water-resources': { title: 'Water quantity and quality', domains: ['waterQuantity', 'waterQuality'] },
    'drought-monitor': { title: 'Drought signals', domains: ['waterQuantity'], extra: a => metricTable('Vegetation response', { metrics: pick(a.domains.crop.metrics, ['ndvi', 'ndviAnomaly', 'ndmi', 'landSurfaceTempC']) }) },
    'early-warning': { title: 'Early warnings for this area', domains: [], extra: a => issuesShort(a) + `<h4 class="eo-h4">Top actions</h4>` + topActions(a) },
    'food-security': { title: 'Food-security outlook for this area', domains: ['crop', 'waterQuantity'], extra: a => issuesShort(a) }
  };
  const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined && o[k] !== null).map(k => [k, o[k]]));
  const issuesShort = a => a.issues.length ? `<ul class="eo-issue-list">${a.issues.slice(0, 6).map(i => `<li><span class="si-badge ${sevClass(i.severity)}">${esc(i.severity)}</span> <b>${esc(i.title)}</b> — ${esc(i.detail)}</li>`).join('')}</ul>` : '<p class="si-card-desc">No warning signs detected.</p>';
  const topActions = a => `<ol class="eo-actions">${['farmers', 'government', 'public'].map(w => a.recommendations[w][0]).filter(Boolean).map((r, i) => `<li><div class="eo-action"><b>${['Farmers', 'Government', 'Public'][i]}:</b> ${esc(r.action)}</div></li>`).join('')}</ol>`;

  function renderContext(pageId) {
    const conf = PAGE_CONTEXT[pageId];
    const page = document.getElementById('pg-' + pageId);
    if (!conf || !page) return;
    const host = page.querySelector('.pg-pad') || page;
    let box = host.querySelector(':scope > .eo-context');
    if (!box) { box = document.createElement('div'); box.className = 'eo-context panel'; host.insertBefore(box, host.firstChild); }
    const a = state.last;
    if (!a) {
      box.innerHTML = `<div class="eo-context-empty">📡 <b>Live satellite readings</b> — select a farm or region in <a href="#" data-eo-open>Site Intelligence</a> to see real Sentinel-2, Landsat, soil and rainfall data for it here.</div>`;
    } else {
      const p = a.data.place || {};
      const when = new Date(a.generatedAt).toLocaleString();
      box.innerHTML = `
        <div class="eo-context-hdr">
          <div><b>📡 ${esc(conf.title)}</b> · ${esc([p.name, p.country].filter(Boolean).join(', '))} · ${a.aoi.areaHa.toLocaleString()} ha</div>
          <div class="eo-context-meta">Analysed ${esc(when)} · <a href="#" data-eo-open>Open full analysis</a></div>
        </div>
        <div class="eo-context-cards">${conf.domains.map(k => domainCard(a.domains[k], DOMAINS.find(d => d[0] === k)[1], DOMAINS.find(d => d[0] === k)[2], KEY_METRICS[k])).join('')}</div>
        ${conf.extra ? conf.extra(a) : ''}`;
    }
    box.querySelectorAll('[data-eo-open]').forEach(l => l.addEventListener('click', e => {
      e.preventDefault();
      const link = document.querySelector('.nav-link[data-page="site-intelligence"]');
      if (link) link.click();
      setTimeout(() => { buildToolbar(); if (state.last) { showResultAoi(state.last.aoi.geometry); renderSite(state.last); } }, 350);
    }));
  }
  function renderAllContexts() { Object.keys(PAGE_CONTEXT).forEach(renderContext); }

  document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => {
    const pg = link.dataset.page;
    if (PAGE_CONTEXT[pg]) setTimeout(() => renderContext(pg), 50);
    if (pg === 'site-intelligence') setTimeout(() => {
      buildToolbar();
      if (state.last && !document.getElementById('siMetricsGrid').children.length) { showResultAoi(state.last.aoi.geometry); renderSite(state.last); }
    }, 200);
  }));

  // ─── Report integration ───────────────────────────────────
  function reportHtml() {
    const a = state.last;
    if (!a) return '';
    const p = a.data.place || {};
    const box = 'border:1px solid #dcdcdc;border-radius:8px;padding:12px;margin:8px 0';
    const domains = DOMAINS.map(([k, title, icon]) => {
      const d = a.domains[k];
      if (!d) return '';
      const rows = Object.entries(d.metrics || {}).filter(([, v]) => v !== null && v !== undefined).map(([mk, v]) => `<tr><td style="padding:3px 8px;color:#555">${esc(METRIC_LABELS[mk] || mk)}</td><td style="padding:3px 8px;font-weight:600">${metricValue(mk, v)}</td></tr>`).join('');
      return `<div style="${box}"><div style="font-weight:700">${icon} ${esc(title)} — ${esc(d.status)}${Number.isFinite(d.score) ? ` (${d.score}/100)` : ''}</div><p style="margin:6px 0">${esc(d.summary)}</p>${rows ? `<table style="border-collapse:collapse;font-size:12px">${rows}</table>` : ''}</div>`;
    }).join('');
    const issues = a.issues.map(i => `<li><b>[${esc(i.severity)}] ${esc(i.title)}</b> — ${esc(i.detail)} <i style="color:#777">(${esc(i.evidence)})</i></li>`).join('');
    const guide = ['farmers', 'government', 'public'].map((w, n) => `<h5 style="margin:10px 0 4px">${['For farmers', 'For government & extension', 'For the public'][n]}</h5><ol>${a.recommendations[w].map(r => `<li>${esc(r.action)} <span style="color:#777">— ${esc(r.why)}</span></li>`).join('')}</ol>`).join('');
    const src = a.sources.map(s => `<li>${esc(s.name)} (${esc(s.provider)}): <b>${esc(s.status)}</b>${s.detail ? ' · ' + esc(s.detail) : ''}</li>`).join('');
    return `
      <h4>Satellite Site Assessment — ${esc([p.name, p.admin1, p.country].filter(Boolean).join(', '))}</h4>
      <p style="font-size:12px;color:#666">${a.aoi.areaHa.toLocaleString()} ha · centre ${a.aoi.centroid[1].toFixed(4)}, ${a.aoi.centroid[0].toFixed(4)} · analysed ${esc(new Date(a.generatedAt).toLocaleString())}</p>
      <div style="${box};border-left:4px solid ${a.overall.riskLevel === 'Low' ? '#3F8F3A' : a.overall.riskLevel === 'Moderate' ? '#E8A33A' : '#C9463D'}"><b>${esc(a.overall.riskLevel)} risk.</b> ${esc(a.overall.headline)}${Number.isFinite(a.overall.score) ? ` Overall condition score ${a.overall.score}/100.` : ''}</div>
      <h4>Priority findings</h4>${issues ? `<ol>${issues}</ol>` : '<p>No warning signs detected.</p>'}
      <h4>Crop, water, soil and land</h4>${domains}
      <h4>Recommended actions (in priority order)</h4>${guide}
      <h4>Data sources</h4><ul style="font-size:12px">${src}</ul>
      <p style="font-size:11px;color:#777">Satellites measure sediment and algae in water but not bacteria, heavy metals, salinity or pH; confirm with field samples. Soil values are 250 m model estimates; confirm with a soil test before liming or fertilising.</p>`;
  }

  function reportPromptContext() {
    const a = state.last;
    if (!a) return '';
    const p = a.data.place || {};
    const dom = DOMAINS.map(([k, t]) => a.domains[k] ? `${t}: ${a.domains[k].status}. ${a.domains[k].summary}` : '').filter(Boolean).join(' ');
    const iss = a.issues.slice(0, 6).map(i => `${i.severity}: ${i.title} (${i.detail})`).join('; ');
    return `Site analysed with live satellite data: ${[p.name, p.country].filter(Boolean).join(', ')}, ${a.aoi.areaHa} ha. Overall: ${a.overall.riskLevel} risk. ${dom} Priority findings: ${iss || 'none'}. Top actions — farmers: ${a.recommendations.farmers[0]?.action}; government: ${a.recommendations.government[0]?.action}; public: ${a.recommendations.public[0]?.action}`;
  }

  function reportData() {
    const a = state.last;
    if (!a) return null;
    const p = a.data.place || {};
    return {
      region: [p.name, p.country].filter(Boolean).join(', '),
      metrics: { overall: a.overall, areaHa: a.aoi.areaHa, centroid: a.aoi.centroid, domains: Object.fromEntries(Object.entries(a.domains).map(([k, d]) => [k, { status: d.status, score: d.score, metrics: d.metrics }])) },
      sections: [
        { heading: 'Priority findings', items: a.issues.map(i => `[${i.severity}] ${i.title}: ${i.detail}`) },
        { heading: 'Actions for farmers', items: a.recommendations.farmers.map(r => r.action) },
        { heading: 'Actions for government', items: a.recommendations.government.map(r => r.action) },
        { heading: 'Actions for the public', items: a.recommendations.public.map(r => r.action) },
        { heading: 'Sources', items: a.sources.map(s => `${s.name}: ${s.status}${s.detail ? ' (' + s.detail + ')' : ''}`) }
      ]
    };
  }

  // 24-month Sentinel-2 NDVI series for the analysed area (cached per analysis).
  let seriesCache = null;
  async function ndviSeries() {
    const a = state.last;
    if (!a) throw new Error('Analyse a site in Site Intelligence first.');
    if (seriesCache && seriesCache.key === a.generatedAt) return seriesCache.data;
    const res = await fetch(API + '/eo/ndvi-series', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ geometry: a.aoi.geometry }), signal: AbortSignal.timeout(90000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load the NDVI series.');
    seriesCache = { key: a.generatedAt, data };
    return data;
  }
  const siteName = () => { const p = state.last && state.last.data.place; return p ? [p.name, p.country].filter(Boolean).join(', ') : null; };

  window.wafeoSite = { analyze, run, last: () => state.last, siteName, ndviSeries, reportHtml, reportPromptContext, reportData };

  // Draw saved results once the app is ready.
  document.addEventListener('wafeo:auth', () => setTimeout(renderAllContexts, 300));
  if (state.last) setTimeout(renderAllContexts, 1000);
})();
