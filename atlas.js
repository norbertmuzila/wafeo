// ════════════════════════════════════════════════════════════
//  WAFEO — World atlas map (dashboard)
//  MapLibre GL: a rotating globe or a flat map over Esri satellite
//  imagery, every country named with its flag, a searchable atlas
//  of 208 countries and territories with a country card, live GDACS
//  hazards, and click-to-select a field for satellite analysis.
//  Loaded after app.js (uses API, authHeaders, escapeHtml).
// ════════════════════════════════════════════════════════════
(function () {
  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s ?? ''));
  const FIELD_ZOOM = 12;           // from here a click traces the field under it
  const ALERT = { red: '#d93025', orange: '#f29900', green: '#34a853' };
  const flagUrl = (cc, w = 40) => `https://flagcdn.com/w${w}/${cc}.png`;

  let map = null, countries = [], byCc = new Map(), shapes = null, selectedCc = null, hoverId = null;
  let projection = 'globe', spinning = true, popup = null, hazards = [], aoi = null;
  const els = {};
  const api = { onAnalyse: null };

  // ─── Base style ────────────────────────────────────────────
  function baseStyle() {
    const gibsDay = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    return {
      version: 8,
      projection: { type: 'globe' },
      glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
      sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 5, 0.6, 7, 0] },
      sources: {
        imagery: {
          type: 'raster', tileSize: 256, maxzoom: 19,
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          attribution: 'Imagery © Esri, Maxar, Earthstar Geographics'
        },
        places: {
          type: 'raster', tileSize: 256, maxzoom: 19,
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}']
        },
        nasa: {
          type: 'raster', tileSize: 256, maxzoom: 9,
          tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${gibsDay}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`],
          attribution: 'NASA EOSDIS GIBS'
        },
        hazards: { type: 'geojson', data: empty() },
        aoi: { type: 'geojson', data: empty() },
        field: { type: 'geojson', data: empty() }
      },
      layers: [
        { id: 'imagery', type: 'raster', source: 'imagery', paint: { 'raster-fade-duration': 150 } },
        { id: 'nasa', type: 'raster', source: 'nasa', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.95 } },
        { id: 'places', type: 'raster', source: 'places', minzoom: 6 },
        { id: 'aoi-fill', type: 'fill', source: 'aoi', paint: { 'fill-color': '#9BE07A', 'fill-opacity': 0.2 } },
        { id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': '#9BE07A', 'line-width': 3 } },
        { id: 'field-fill', type: 'fill', source: 'field', paint: { 'fill-color': '#FFD54F', 'fill-opacity': 0.18 } },
        { id: 'field-line', type: 'line', source: 'field', paint: { 'line-color': '#FFD54F', 'line-width': 2.5, 'line-dasharray': [2, 1] } },
        {
          id: 'hazards', type: 'circle', source: 'hazards',
          paint: {
            'circle-color': ['match', ['get', 'alert'], 'red', ALERT.red, 'orange', ALERT.orange, ALERT.green],
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, ['match', ['get', 'alert'], 'red', 6, 'orange', 5, 3.5], 6, ['match', ['get', 'alert'], 'red', 12, 'orange', 10, 7]],
            'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5, 'circle-opacity': 0.92
          }
        }
      ]
    };
  }
  const empty = () => ({ type: 'FeatureCollection', features: [] });

  // ─── Setup ─────────────────────────────────────────────────
  function init() {
    if (map) return map;
    const root = document.getElementById('atlas');
    if (!root || typeof maplibregl === 'undefined') return null;
    ['atlasMap', 'atlasPanel', 'atlasList', 'atlasSearch', 'atlasCount', 'atlasCard', 'atlasHint', 'atlasRegions'].forEach(id => { els[id] = document.getElementById(id); });

    map = new maplibregl.Map({
      container: 'atlasMap', style: baseStyle(), center: [20, 8], zoom: 1.6, minZoom: 0.6, maxZoom: 19,
      attributionControl: { compact: true }, canvasContextAttributes: { antialias: true }, maxPitch: 60
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 110 }), 'bottom-left');
    map.on('styleimagemissing', loadFlag);
    map.on('load', () => { loadCountries(); spin(); });
    // Spin again only once every other camera movement has finished.
    map.on('moveend', () => setTimeout(spin, 60));
    map.on('zoomend', updateHint);
    map.on('click', onClick);
    map.on('mousemove', onHover);
    map.on('mouseleave', 'country-fill', () => setHover(null));
    // Any touch of the map stops the automatic rotation.
    ['mousedown', 'touchstart', 'wheel', 'dragstart'].forEach(ev => map.on(ev, () => stopSpin()));

    root.querySelectorAll('[data-proj]').forEach(b => b.addEventListener('click', () => setProjection(b.dataset.proj)));
    root.querySelector('[data-act="expand"]').addEventListener('click', toggleExpand);
    root.querySelector('[data-act="atlas"]').addEventListener('click', () => togglePanel());
    root.querySelector('[data-act="spin"]').addEventListener('click', () => { spinning ? stopSpin() : startSpin(); });
    root.querySelectorAll('[data-layer]').forEach(b => b.addEventListener('click', () => toggleLayer(b)));
    els.atlasSearch.addEventListener('input', renderList);
    els.atlasRegions.addEventListener('click', e => {
      const b = e.target.closest('[data-region]');
      if (!b) return;
      els.atlasRegions.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      renderList();
    });
    els.atlasList.addEventListener('click', e => { const li = e.target.closest('[data-cc]'); if (li) selectCountry(li.dataset.cc, true); });
    els.atlasCard.addEventListener('click', onCardClick);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && root.classList.contains('atlas-expanded')) toggleExpand(); });
    root.addEventListener('click', onPopupClick);
    if (window.matchMedia('(max-width: 760px)').matches) togglePanel(false);
    updateHint();
    return map;
  }

  // ─── Countries: list, labels with flags, borders ─────────
  async function loadCountries() {
    try {
      countries = await fetch('assets/countries.json').then(r => r.json());
      countries.forEach(c => byCc.set(c.cc, c));
      els.atlasCount.textContent = `All ${countries.length} countries and territories`;
      renderList();
      map.addSource('country-labels', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: countries.map(c => ({ type: 'Feature', properties: { cc: c.cc, name: c.name, rank: -(c.areaKm2 || 0) }, geometry: { type: 'Point', coordinates: [c.lon, c.lat] } })) }
      });
      map.addLayer({
        id: 'country-labels', type: 'symbol', source: 'country-labels', maxzoom: 7.5,
        layout: {
          'symbol-sort-key': ['get', 'rank'],
          'icon-image': ['concat', 'flag-', ['get', 'cc']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.75, 5, 1],
          'icon-anchor': 'bottom', 'icon-offset': [0, -2],
          'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 1, 10.5, 3, 12.5, 6, 15],
          'text-anchor': 'top', 'text-offset': [0, 0.25], 'text-max-width': 8, 'text-padding': 3
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.78)', 'text-halo-width': 1.4, 'icon-opacity': 0.98 }
      }, 'hazards');
    } catch (e) { console.warn('Atlas list failed to load:', e); }
    try {
      const topo = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json').then(r => r.json());
      const fc = topojson.feature(topo, topo.objects.countries);
      const byNum = new Map(countries.filter(c => c.num).map(c => [String(c.num).padStart(3, '0'), c]));
      const byName = new Map(countries.map(c => [c.name.toLowerCase(), c]));
      fc.features.forEach((f, i) => {
        const c = byNum.get(String(f.id || '')) || byName.get(String(f.properties.name || '').toLowerCase());
        f.id = i + 1;
        f.properties = { cc: c ? c.cc : '', name: c ? c.name : f.properties.name };
      });
      shapes = fc;
      map.addSource('countries', { type: 'geojson', data: fc });
      const before = 'aoi-fill';
      map.addLayer({
        id: 'country-fill', type: 'fill', source: 'countries', maxzoom: 10,
        paint: { 'fill-color': ['case', ['boolean', ['feature-state', 'selected'], false], 'rgba(155,224,122,0.22)', ['boolean', ['feature-state', 'hover'], false], 'rgba(255,255,255,0.14)', 'rgba(0,0,0,0)'] }
      }, before);
      map.addLayer({
        id: 'country-line', type: 'line', source: 'countries',
        paint: { 'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#9BE07A', 'rgba(255,255,255,0.55)'], 'line-width': ['interpolate', ['linear'], ['zoom'], 1, ['case', ['boolean', ['feature-state', 'selected'], false], 2.4, 0.4], 6, ['case', ['boolean', ['feature-state', 'selected'], false], 2.6, 1.1]] }
      }, before);
      if (selectedCc) paintSelected(selectedCc);
    } catch (e) { console.warn('Country borders failed to load:', e); }
  }

  // Flags load on demand, only for labels the map actually shows.
  const flagPending = new Set();
  function loadFlag(e) {
    const id = e.id;
    if (!id.startsWith('flag-') || flagPending.has(id)) return;
    flagPending.add(id);
    const img = new Image(40, 30);
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // Draw onto a canvas with a thin white frame, like a flag pin.
      const w = 40, h = Math.round(40 * img.naturalHeight / img.naturalWidth) || 27;
      const cv = document.createElement('canvas'); cv.width = w + 4; cv.height = h + 4;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w + 4, h + 4);
      ctx.drawImage(img, 2, 2, w, h);
      if (!map.hasImage(id)) map.addImage(id, ctx.getImageData(0, 0, w + 4, h + 4), { pixelRatio: 2 });
    };
    img.onerror = () => { if (!map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) }); };
    img.src = flagUrl(id.slice(5));
  }

  function renderList() {
    const q = (els.atlasSearch.value || '').trim().toLowerCase();
    const region = (els.atlasRegions.querySelector('.active') || {}).dataset?.region || 'all';
    const list = countries.filter(c => (region === 'all' || c.region === region) && (!q || c.name.toLowerCase().includes(q) || (c.capital || '').toLowerCase().includes(q) || c.iso3.toLowerCase() === q));
    els.atlasList.innerHTML = list.map(c => `
      <li data-cc="${c.cc}" class="${c.cc === selectedCc ? 'active' : ''}" tabindex="0">
        <img src="${flagUrl(c.cc)}" alt="" loading="lazy" width="28" height="20">
        <span><b>${esc(c.name)}</b><small>${esc(c.subregion || c.region)}</small></span>
      </li>`).join('') || '<li class="atlas-none">No country matches.</li>';
  }

  // ─── Country selection and card ───────────────────────────
  function featureOf(cc) { return shapes ? shapes.features.filter(f => f.properties.cc === cc) : []; }
  function paintSelected(cc) {
    if (!map.getSource('countries')) return;
    shapes.features.forEach(f => map.setFeatureState({ source: 'countries', id: f.id }, { selected: f.properties.cc === cc }));
  }
  function boundsOf(feats) {
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    const walk = a => { if (typeof a[0] === 'number') { minX = Math.min(minX, a[0]); maxX = Math.max(maxX, a[0]); minY = Math.min(minY, a[1]); maxY = Math.max(maxY, a[1]); } else a.forEach(walk); };
    feats.forEach(f => walk(f.geometry.coordinates));
    return maxX - minX > 180 ? null : [[minX, minY], [maxX, maxY]]; // crosses the date line
  }
  function selectCountry(cc, fly) {
    const c = byCc.get(cc);
    if (!c) return;
    stopSpin();
    selectedCc = cc;
    paintSelected(cc);
    els.atlasList.querySelectorAll('li').forEach(li => li.classList.toggle('active', li.dataset.cc === cc));
    if (fly) {
      const b = boundsOf(featureOf(cc));
      if (b) map.fitBounds(b, { padding: { top: 70, bottom: 60, left: els.atlasPanel.classList.contains('closed') ? 60 : 340, right: 380 }, maxZoom: 6.5, duration: 1600 });
      else map.flyTo({ center: [c.lon, c.lat], zoom: 3, duration: 1600 });
    }
    showCard(c);
  }

  const WB = [
    ['SP.POP.TOTL', 'Population', v => fmtBig(v)],
    ['SP.RUR.TOTL.ZS', 'Rural population', v => v.toFixed(0) + '%'],
    ['NY.GDP.PCAP.CD', 'GDP per person', v => 'US$ ' + Math.round(v).toLocaleString()],
    ['NV.AGR.TOTL.ZS', 'Agriculture share of GDP', v => v.toFixed(1) + '%'],
    ['AG.LND.AGRI.ZS', 'Agricultural land', v => v.toFixed(1) + '% of land'],
    ['AG.YLD.CREL.KG', 'Cereal yield', v => (v / 1000).toFixed(2) + ' t/ha'],
    ['SN.ITK.DEFC.ZS', 'Undernourishment', v => v.toFixed(1) + '% of people'],
    ['SH.H2O.BASW.ZS', 'Basic drinking water', v => v.toFixed(0) + '% of people'],
    ['ER.H2O.INTR.PC', 'Renewable fresh water', v => Math.round(v).toLocaleString() + ' m³/person/yr'],
    ['AG.LND.FRST.ZS', 'Forest', v => v.toFixed(1) + '% of land']
  ];
  const wbCache = new Map();
  const fmtBig = v => v >= 1e9 ? (v / 1e9).toFixed(2) + ' billion' : v >= 1e6 ? (v / 1e6).toFixed(1) + ' million' : Math.round(v).toLocaleString();
  async function worldBank(iso3) {
    const code = iso3 === 'UNK' ? 'XKX' : iso3;
    if (wbCache.has(code)) return wbCache.get(code);
    const p = Promise.all(WB.map(([id]) => fetch(`https://api.worldbank.org/v2/country/${code}/indicator/${id}?format=json&mrnev=1`, { signal: AbortSignal.timeout(15000) })
      .then(r => r.json()).then(j => (j && j[1] && j[1][0] && j[1][0].value !== null ? { value: j[1][0].value, year: j[1][0].date } : null)).catch(() => null)));
    wbCache.set(code, p);
    return p;
  }

  function showCard(c) {
    const inCountry = hazards.filter(h => h.country && h.country.toLowerCase().includes(c.name.toLowerCase()));
    els.atlasCard.hidden = false;
    els.atlasCard.innerHTML = `
      <button type="button" class="atlas-x" data-act="close-card" aria-label="Close"><i data-lucide="x"></i></button>
      <div class="atlas-card-head">
        <img src="${flagUrl(c.cc, 160)}" alt="Flag of ${esc(c.name)}" width="72">
        <div><h3>${esc(c.name)}</h3><p>${esc(c.official)}</p><span class="atlas-chip">${esc(c.status)}</span></div>
      </div>
      <dl class="atlas-facts">
        <div><dt>Region</dt><dd>${esc(c.subregion || c.region)}</dd></div>
        <div><dt>Capital</dt><dd>${esc(c.capital || '—')}</dd></div>
        <div><dt>Area</dt><dd>${Math.round(c.areaKm2 || 0).toLocaleString()} km²${c.landlocked ? ' · landlocked' : ''}</dd></div>
        <div><dt>Languages</dt><dd>${esc(c.languages.join(', ') || '—')}</dd></div>
      </dl>
      <h4>Farming, water and food</h4>
      <dl class="atlas-facts" id="atlasWb"><div class="atlas-loading">Loading latest national statistics…</div></dl>
      <h4>Live hazard alerts</h4>
      <ul class="atlas-hz">${inCountry.length ? inCountry.slice(0, 5).map(h => `<li><i style="background:${ALERT[h.alert] || '#999'}"></i>${esc(h.type)} · ${esc(h.alert)} alert · ${esc(String(h.from).slice(0, 10))}</li>`).join('') : '<li class="atlas-ok"><i data-lucide="check-circle-2"></i>No active GDACS alerts for this country.</li>'}</ul>
      <button type="button" class="lv-btn atlas-zoomfarm" data-act="zoom-farm"><i data-lucide="mouse-pointer-click"></i>Zoom in to choose a farm</button>`;
    worldBank(c.iso3).then(vals => {
      if (selectedCc !== c.cc) return;
      const rows = WB.map(([, label, f], i) => vals[i] ? `<div><dt>${label}</dt><dd>${f(vals[i].value)} <small>${vals[i].year}</small></dd></div>` : '').join('');
      const box = document.getElementById('atlasWb');
      if (box) box.innerHTML = rows || '<div class="atlas-loading">National statistics are not published for this territory.</div>';
    });
  }

  function onCardClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close-card') { els.atlasCard.hidden = true; selectedCc = null; paintSelected(null); renderList(); }
    if (b.dataset.act === 'zoom-farm') {
      const c = byCc.get(selectedCc);
      els.atlasCard.hidden = true;
      stopSpin();
      if (c) map.flyTo({ center: [c.lon, c.lat], zoom: 9, duration: 1800 });
      flash('Keep zooming in until you can see fields, then click one to select it.');
    }
  }

  // ─── Map interaction ──────────────────────────────────────
  function setHover(id) {
    if (hoverId !== null && map.getSource('countries')) map.setFeatureState({ source: 'countries', id: hoverId }, { hover: false });
    hoverId = id;
    if (id !== null) map.setFeatureState({ source: 'countries', id }, { hover: true });
  }
  function onHover(e) {
    const hz = map.getLayer('hazards') && map.queryRenderedFeatures(e.point, { layers: ['hazards'] }).length;
    const z = map.getZoom();
    const f = map.getLayer('country-fill') && z < 7 ? map.queryRenderedFeatures(e.point, { layers: ['country-fill'] })[0] : null;
    setHover(f ? f.id : null);
    map.getCanvas().style.cursor = hz || f ? 'pointer' : z >= FIELD_ZOOM ? 'crosshair' : '';
  }

  function onClick(e) {
    const hz = map.queryRenderedFeatures(e.point, { layers: ['hazards'] })[0];
    if (hz) return hazardPopup(hz);
    const z = map.getZoom();
    if (z >= FIELD_ZOOM) return traceField(e.lngLat);
    if (z < 6) {
      const f = map.getLayer('country-fill') && map.queryRenderedFeatures(e.point, { layers: ['country-fill'] })[0];
      if (f && f.properties.cc) return selectCountry(f.properties.cc, false);
      return;
    }
    openPopup(e.lngLat, `<div class="atlas-pop"><b>Choose a farm here</b>
      <p>Zoom in until you can see field edges, then click inside a field to select it.</p>
      <div class="atlas-pop-btns">
        <button type="button" class="lv-btn" data-pop="zoom" data-lon="${e.lngLat.lng}" data-lat="${e.lngLat.lat}"><i data-lucide="zoom-in"></i>Zoom to fields</button>
        <button type="button" class="lv-btn-ghost" data-pop="circle" data-r="2000" data-lon="${e.lngLat.lng}" data-lat="${e.lngLat.lat}">Analyse 2 km around here</button>
      </div></div>`);
  }

  function openPopup(lngLat, html) {
    if (popup) popup.remove();
    popup = new maplibregl.Popup({ maxWidth: '300px', className: 'atlas-popup' }).setLngLat(lngLat).setHTML(html).addTo(map);
  }

  function hazardPopup(f) {
    const p = f.properties;
    openPopup(f.geometry.coordinates, `<div class="atlas-pop"><b>${esc(p.type)} · ${esc(p.alert)} alert</b>
      <p>${esc(p.name || '')}${p.name ? '<br>' : ''}${esc(p.country)}<br>${esc(String(p.from).slice(0, 10))} → ${esc(String(p.to).slice(0, 10))}</p>
      ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">Read the GDACS report</a>` : ''}</div>`);
  }

  async function traceField(lngLat) {
    const lon = lngLat.lng, lat = lngLat.lat;
    openPopup(lngLat, '<div class="atlas-pop"><b>Finding the field edges…</b><p>Reading the latest clear Sentinel-2 image (10 m).</p><div class="atlas-spin"></div></div>');
    map.getSource('field').setData(empty());
    try {
      const res = await fetch(`${API}/eo/field?lon=${lon.toFixed(6)}&lat=${lat.toFixed(6)}`, { headers: authHeaders(), signal: AbortSignal.timeout(60000) });
      if (res.status === 401 && typeof handleExpiredSession === 'function') return handleExpiredSession();
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.error || 'Field tracing failed.');
      const circle = `<button type="button" class="lv-btn-ghost" data-pop="circle" data-r="500" data-lon="${lon}" data-lat="${lat}">Analyse 500 m around here</button>`;
      if (!r.found) return openPopup(lngLat, `<div class="atlas-pop"><b>No field edge found</b><p>${esc(r.reason)}</p><div class="atlas-pop-btns">${circle}</div></div>`);
      map.getSource('field').setData({ type: 'Feature', properties: {}, geometry: r.geometry });
      lastField = r.geometry;
      openPopup(lngLat, `<div class="atlas-pop"><b>Field selected · ${r.areaHa.toLocaleString()} ha</b>
        <p>Outline traced from the Sentinel-2 image of ${esc(r.sceneDate)}. Average greenness (NDVI) ${r.meanNdvi}.${r.note ? ' ' + esc(r.note) : ''}</p>
        <div class="atlas-pop-btns"><button type="button" class="lv-btn" data-pop="field"><i data-lucide="satellite"></i>Analyse this field</button>${circle}</div></div>`);
    } catch (e) {
      openPopup(lngLat, `<div class="atlas-pop"><b>Could not trace the field</b><p>${esc(e.name === 'TimeoutError' ? 'The satellite service took too long.' : e.message)}</p><div class="atlas-pop-btns"><button type="button" class="lv-btn-ghost" data-pop="circle" data-r="500" data-lon="${lon}" data-lat="${lat}">Analyse 500 m around here</button></div></div>`);
    }
  }
  let lastField = null;

  function onPopupClick(e) {
    const b = e.target.closest('[data-pop]');
    if (!b) return;
    const lon = Number(b.dataset.lon), lat = Number(b.dataset.lat);
    if (b.dataset.pop === 'zoom') { if (popup) popup.remove(); stopSpin(); map.flyTo({ center: [lon, lat], zoom: 14.5, duration: 1600 }); flash('Now click inside a field to select it.'); return; }
    if (popup) popup.remove();
    if (b.dataset.pop === 'field' && lastField) return analyse({ geometry: lastField }, 'Selected field');
    if (b.dataset.pop === 'circle') return analyse({ point: [lon, lat], radius_m: Number(b.dataset.r) }, 'Selected point');
  }

  function analyse(body, label) {
    if (typeof api.onAnalyse === 'function') api.onAnalyse(body, label);
  }

  // ─── Controls ─────────────────────────────────────────────
  function setProjection(p) {
    projection = p;
    map.setProjection({ type: p === 'globe' ? 'globe' : 'mercator' });
    document.querySelectorAll('#atlas [data-proj]').forEach(b => { b.classList.toggle('active', b.dataset.proj === p); b.setAttribute('aria-pressed', String(b.dataset.proj === p)); });
    if (p === 'flat' && map.getZoom() < 1.4) map.easeTo({ zoom: 1.6, duration: 600 });
    if (p === 'globe') spin(); else stopSpin();
  }

  function spin() {
    if (!map || !spinning || projection !== 'globe' || map.getZoom() > 3.5 || document.hidden || map.isMoving()) return;
    const c = map.getCenter();
    c.lng -= 6; // 6° every 1.5 s: a slow, steady turn
    map.easeTo({ center: c, duration: 1500, easing: n => n });
  }
  function stopSpin() { spinning = false; setSpinBtn(); }
  function startSpin() { spinning = true; setSpinBtn(); if (projection !== 'globe') setProjection('globe'); else spin(); }
  function setSpinBtn() {
    const b = document.querySelector('#atlas [data-act="spin"]');
    if (b) { b.classList.toggle('active', spinning); b.title = spinning ? 'Stop rotating' : 'Rotate the globe'; }
  }

  function toggleExpand() {
    const root = document.getElementById('atlas');
    const on = !root.classList.contains('atlas-expanded');
    root.classList.toggle('atlas-expanded', on);
    document.body.classList.toggle('atlas-lock', on);
    const b = root.querySelector('[data-act="expand"]');
    b.innerHTML = on ? '<i data-lucide="minimize-2"></i><span>Exit full screen</span>' : '<i data-lucide="maximize-2"></i><span>Expand</span>';
    setTimeout(() => map.resize(), 60);
  }

  function togglePanel(force) {
    const closed = force === undefined ? !els.atlasPanel.classList.contains('closed') : !force;
    els.atlasPanel.classList.toggle('closed', closed);
    document.querySelector('#atlas [data-act="atlas"]').classList.toggle('active', !closed);
  }

  function toggleLayer(b) {
    const on = !b.classList.contains('active');
    b.classList.toggle('active', on);
    b.dataset.layer.split(',').forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); });
  }

  function updateHint() {
    if (!els.atlasHint || !map) return;
    const z = map.getZoom();
    els.atlasHint.innerHTML = z >= FIELD_ZOOM
      ? '<i data-lucide="mouse-pointer-click"></i>Click inside a field to select it for analysis'
      : z >= 6 ? '<i data-lucide="zoom-in"></i>Zoom in further to pick a field, or click for options'
      : '<i data-lucide="globe-2"></i>Click a country for its profile · zoom in to choose a farm';
  }

  let flashTimer = null;
  function flash(text) {
    const el = els.atlasHint;
    if (!el) return;
    el.classList.add('flash');
    el.innerHTML = `<i data-lucide="info"></i>${esc(text)}`;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.classList.remove('flash'); updateHint(); }, 6000);
  }

  // ─── Data from pages.js ───────────────────────────────────
  function setHazards(events) {
    hazards = events || [];
    if (!map) return;
    const apply = () => map.getSource('hazards').setData({
      type: 'FeatureCollection',
      features: hazards.filter(h => h.type !== 'Earthquake').map(h => ({ type: 'Feature', properties: { type: h.type, alert: h.alert, name: h.name, country: h.country, from: h.from, to: h.to, url: h.url || '' }, geometry: { type: 'Point', coordinates: [h.lon, h.lat] } }))
    });
    map.isStyleLoaded() && map.getSource('hazards') ? apply() : map.once('load', apply);
  }

  function setAoi(geometry, fly) {
    aoi = geometry || null;
    if (!map) return;
    const apply = () => {
      map.getSource('aoi').setData(aoi ? { type: 'Feature', properties: {}, geometry: aoi } : empty());
      map.getSource('field').setData(empty());
      if (aoi && fly) {
        stopSpin();
        const b = boundsOf([{ geometry: aoi }]);
        if (b) map.fitBounds(b, { padding: 80, maxZoom: 15, duration: 1500 });
      }
    };
    map.getSource('aoi') ? apply() : map.once('load', apply);
  }

  function resize() { if (map) { map.resize(); setTimeout(() => map.resize(), 400); } }

  window.wafeoAtlas = Object.assign(api, { init, setHazards, setAoi, resize, selectCountry, setProjection, map: () => map });
})();
