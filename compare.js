// ════════════════════════════════════════════════════════════
//  WAFEO — Change over time (then vs now)
//  A period slider (1 month to 8 years) and a split, swipeable view of
//  the analysed area: drag the divider to see how each part changed.
//  Modes: natural colour, vegetation health, and a change map.
//  Mounted on the Dashboard and in Site Intelligence; the PDF report
//  uses the same results. Loaded after app.js and eo.js.
// ════════════════════════════════════════════════════════════
(function () {
  const PERIODS = [1, 3, 6, 12, 24, 36, 48, 60, 72, 84, 96];
  const SHORT = m => (m < 12 ? `${m} mo` : `${m / 12} yr`);
  const LONG = m => (m < 12 ? `${m} month${m > 1 ? 's' : ''} ago` : `${m / 12} year${m > 12 ? 's' : ''} ago`);
  const esc = s => escapeHtml(s);
  const fmtDate = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const results = new Map();   // analysis key + months → result
  const pending = new Map();
  let months = 36;
  try { const m = Number(localStorage.getItem('wafeo.compareMonths')); if (PERIODS.includes(m)) months = m; } catch (e) {}

  const site = () => window.wafeoSite && window.wafeoSite.last();
  const keyOf = (a, m) => `${a.generatedAt}|${JSON.stringify(a.aoi.geometry.coordinates[0].slice(0, 3))}|${m}`;

  async function get(a, m = months) {
    const key = keyOf(a, m);
    if (results.has(key)) return results.get(key);
    if (pending.has(key)) return pending.get(key);
    const p = (async () => {
      const res = await fetch(API + '/eo/compare', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ geometry: a.aoi.geometry, months: m }), signal: AbortSignal.timeout(60000) });
      if (res.status === 401 && typeof handleExpiredSession === 'function') { handleExpiredSession(); throw new Error('Please sign in again.'); }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'The comparison could not be completed.');
      results.set(key, j);
      if (results.size > 20) results.delete(results.keys().next().value);
      return j;
    })().finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  }
  const cached = (a, m = months) => (a ? results.get(keyOf(a, m)) || null : null);

  // ─── One viewer instance ──────────────────────────────────
  const views = [];
  function mount(host, { compact = false, hideEmpty = false } = {}) {
    if (!host || host.dataset.cvReady) return;
    host.dataset.cvReady = '1';
    const v = { host, mode: 'tc', pos: 50, data: null, error: '', loading: false, compact, hideEmpty };
    views.push(v);
    host.innerHTML = `
      <section class="cv${compact ? ' cv-compact' : ''}">
        <div class="cv-head">
          <div>
            <h3><i data-lucide="history"></i>Change over time</h3>
            <p class="cv-sub">Compare this area today with the same place in the past. Drag the divider on the image to see what changed.</p>
          </div>
        </div>
        <div class="cv-controls">
          <div class="cv-period">
            <label>Compare today with <output class="cv-out">${esc(LONG(months))}</output></label>
            <input type="range" class="cv-range" min="0" max="${PERIODS.length - 1}" step="1" value="${PERIODS.indexOf(months)}" aria-label="Comparison period">
            <div class="cv-ticks">${PERIODS.map(m => `<span>${SHORT(m)}</span>`).join('')}</div>
          </div>
          <button type="button" class="lv-btn cv-run"><i data-lucide="git-compare-arrows"></i>Compare</button>
        </div>
        <div class="cv-modes" role="tablist">
          <button type="button" data-mode="tc" class="on">Natural colour</button>
          <button type="button" data-mode="veg">Vegetation health</button>
          <button type="button" data-mode="chg">Change map</button>
        </div>
        <div class="cv-body"></div>
      </section>`;
    const range = host.querySelector('.cv-range'), out = host.querySelector('.cv-out');
    range.addEventListener('input', () => { out.textContent = LONG(PERIODS[range.value]); });
    range.addEventListener('change', () => setMonths(PERIODS[range.value], true));
    host.querySelector('.cv-run').addEventListener('click', () => run(v, true));
    host.querySelector('.cv-modes').addEventListener('click', e => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      v.mode = b.dataset.mode;
      host.querySelectorAll('.cv-modes button').forEach(x => x.classList.toggle('on', x === b));
      draw(v);
    });
    host.addEventListener('input', e => {
      if (!e.target.classList.contains('cv-swipe')) return;
      v.pos = Number(e.target.value);
      place(v);
    });
    draw(v);
    return v;
  }

  function setMonths(m, runNow) {
    months = m;
    try { localStorage.setItem('wafeo.compareMonths', String(m)); } catch (e) {}
    views.forEach(v => {
      const r = v.host.querySelector('.cv-range'), o = v.host.querySelector('.cv-out');
      if (r) r.value = PERIODS.indexOf(m);
      if (o) o.textContent = LONG(m);
      v.data = null; v.error = '';
      if (runNow && visible(v)) run(v); else draw(v);
    });
  }

  const visible = v => v.host.offsetParent !== null;

  async function run(v, force) {
    const a = site();
    if (!a) { v.data = null; v.error = ''; draw(v); return; }
    const want = months;
    const hit = cached(a, want);
    if (hit && !force) { v.data = hit; v.error = ''; draw(v); return; }
    v.loading = true; v.error = ''; draw(v);
    try {
      const r = await get(a, want);
      if (want !== months) return;          // the slider moved on meanwhile
      v.data = r;
    } catch (e) {
      v.error = e.name === 'TimeoutError' ? 'The satellite archive took too long to answer. Please try again.' : e.message;
    } finally {
      v.loading = false;
      draw(v);
    }
  }

  function legendHtml(items) {
    return `<div class="cv-legend">${items.filter(l => l.pct > 0).map(l => `<span><i style="background:rgb(${l.color.join(',')})"></i>${esc(l.label)} · ${l.pct}%</span>`).join('')}</div>`;
  }

  function draw(v) {
    const body = v.host.querySelector('.cv-body');
    if (!body) return;
    const a = site();
    v.host.hidden = v.hideEmpty && !a;
    if (!a) { body.innerHTML = '<div class="cv-empty"><i data-lucide="mouse-pointer-click"></i>Analyse a field first: click a field on the dashboard map or in Site Intelligence. Its change over time then appears here.</div>'; return; }
    if (v.loading) { body.innerHTML = `<div class="cv-empty cv-busy"><span class="atlas-spin"></span>Finding the clearest satellite image from ${esc(LONG(months))} and comparing it with today…</div>`; return; }
    if (v.error) { body.innerHTML = `<div class="cv-empty cv-err"><i data-lucide="circle-alert"></i>${esc(v.error)}</div>`; return; }
    const d = v.data;
    if (!d) { body.innerHTML = `<div class="cv-empty"><i data-lucide="history"></i>Choose a period with the slider, then press Compare.</div>`; return; }
    if (!d.available) { body.innerHTML = `<div class="cv-empty cv-err"><i data-lucide="cloud"></i>${esc(d.reason)}</div>`; return; }
    const w = d.now.images.widthPx, h = d.now.images.heightPx;
    const pair = v.mode === 'veg' ? [d.then.images.ndviMap, d.now.images.ndviMap] : [d.then.images.trueColor, d.now.images.trueColor];
    const stage = v.mode === 'chg'
      ? `<div class="cv-stage" style="aspect-ratio:${w}/${h}"><img src="${d.change.image}" alt="Change map"><span class="cv-lbl cv-lbl-l">${esc(fmtDate(d.then.date))} → ${esc(fmtDate(d.now.date))}</span></div>${legendHtml(d.change.legend)}`
      : `<div class="cv-stage" style="aspect-ratio:${w}/${h}">
          <img class="cv-now" src="${pair[1]}" alt="Now, ${esc(fmtDate(d.now.date))}">
          <img class="cv-then" src="${pair[0]}" alt="Then, ${esc(fmtDate(d.then.date))}">
          <div class="cv-divider"><span class="cv-knob"><i data-lucide="chevrons-left-right"></i></span></div>
          <span class="cv-lbl cv-lbl-l">Then · ${esc(fmtDate(d.then.date))}</span>
          <span class="cv-lbl cv-lbl-r">Now · ${esc(fmtDate(d.now.date))}</span>
          <input type="range" class="cv-swipe" min="0" max="100" value="${v.pos}" aria-label="Drag to compare then and now">
        </div>${v.mode === 'veg' ? legendHtml(d.now.images.legend) : ''}`;
    const row = (label, a0, a1, unit, digits = 0) => {
      const ok = Number.isFinite(a0) && Number.isFinite(a1);
      const diff = ok ? Math.round((a1 - a0) * 10 ** digits) / 10 ** digits : null;
      const cls = !ok || Math.abs(diff) < (digits ? 0.05 : 2) ? '' : (label.startsWith('Bare') ? (diff > 0 ? 'down' : 'up') : diff > 0 ? 'up' : 'down');
      return `<tr><td>${esc(label)}</td><td>${ok ? a0 + unit : '—'}</td><td>${ok ? a1 + unit : '—'}</td><td class="cv-${cls}">${ok ? (diff === 0 ? 'no change' : (diff > 0 ? '+' : '') + diff + unit) : '—'}</td></tr>`;
    };
    const s0 = d.then.stats, s1 = d.now.stats;
    body.innerHTML = `${stage}
      <div class="cv-grid">
        <table class="cv-table"><thead><tr><th>Measure</th><th>${esc(fmtDate(d.then.date))}</th><th>${esc(fmtDate(d.now.date))}</th><th>Change</th></tr></thead><tbody>
          ${row('Average greenness (NDVI)', s0.meanNdvi, s1.meanNdvi, '', 2)}
          ${row('Well-vegetated cover', s0.greenCoverPct, s1.greenCoverPct, '%', 1)}
          ${row('Bare soil', s0.bareSoilPct, s1.bareSoilPct, '%', 1)}
          ${row('Open water', s0.openWaterHa, s1.openWaterHa, ' ha', 1)}
        </tbody></table>
        <div class="cv-split">
          <div class="cv-bar"><i style="width:${d.change.declinedPct}%;background:#e2603f" title="Less green"></i><i style="width:${d.change.stablePct}%;background:#d9d9cc" title="About the same"></i><i style="width:${d.change.improvedPct}%;background:#3f9a4f" title="Greener"></i></div>
          <div class="cv-bar-legend"><span><i style="background:#e2603f"></i>Less green ${d.change.declinedPct}%</span><span><i style="background:#d9d9cc"></i>Same ${d.change.stablePct}%</span><span><i style="background:#3f9a4f"></i>Greener ${d.change.improvedPct}%</span></div>
        </div>
      </div>
      <h4 class="cv-h4"><i data-lucide="lightbulb"></i>What changed</h4>
      <ul class="cv-findings">${d.findings.map(f => `<li>${esc(f)}</li>`).join('')}</ul>`;
    place(v);
  }

  function place(v) {
    const then = v.host.querySelector('.cv-then'), div = v.host.querySelector('.cv-divider');
    if (then) then.style.clipPath = `inset(0 ${100 - v.pos}% 0 0)`;
    if (div) div.style.left = v.pos + '%';
  }

  // Run automatically when a viewer becomes visible for a new analysis.
  function refreshVisible() { views.forEach(v => { if (visible(v) && site() && !v.loading && (!v.data || v.data !== cached(site()))) run(v); }); }
  document.addEventListener('wafeo:analysis', () => { views.forEach(v => { v.data = null; v.error = ''; draw(v); }); setTimeout(refreshVisible, 300); });
  document.addEventListener('click', e => { if (e.target.closest('.nav-link, .si-tab-btn')) setTimeout(refreshVisible, 400); });

  const dash = document.getElementById('dashCompare');
  if (dash) mount(dash, { hideEmpty: true });

  window.wafeoCompare = { mount, get, cached, months: () => months, label: LONG, refresh: refreshVisible, PERIODS };
})();
