// ════════════════════════════════════════════════════════════
//  WAFEO — Live News panel (Reports page)
//  Verified stories on water, agriculture, food security and climate
//  hazards from trusted outlets worldwide (NewsDay Harare, The Herald,
//  ZBC, BBC, Reuters, AP, Al Jazeera, ...). Refreshes itself every two
//  minutes while visible; pick any date to read that day's coverage.
//  Loaded after app.js (uses API, authHeaders, escapeHtml).
// ════════════════════════════════════════════════════════════
(function () {
  const REFRESH_MS = 2 * 60 * 1000;
  const esc = s => escapeHtml(s);
  const TOPIC_COLOR = { 'Food security': '#c0392b', Agriculture: '#2f8f46', Water: '#2b6cb0', 'Climate & hazards': '#b7791f' };
  const state = { date: '', region: 'all', topic: 'all', q: '', data: null, seen: new Set(), fresh: new Set(), loading: false, timer: null, tick: null, error: '' };

  const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const safeUrl = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
  const ago = iso => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };
  const dayLabel = iso => {
    const d = new Date(iso), t = new Date(), y = new Date(Date.now() - 86400000);
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, t)) return 'Today';
    if (same(d, y)) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };

  function panel() { return document.getElementById('newsPanel'); }

  function shell() {
    const p = panel();
    if (!p || p.dataset.ready) return;
    p.dataset.ready = '1';
    p.innerHTML = `
      <div class="panel-hdr ln-hdr">
        <h3><i data-lucide="newspaper"></i>Live News: water, agriculture and food systems</h3>
        <span class="ln-status" id="lnStatus"><i class="ln-dot"></i>Connecting…</span>
      </div>
      <div class="ln-controls">
        <label class="ln-search"><i data-lucide="search"></i><input type="search" id="lnQuery" placeholder="Search headlines, outlets or places" autocomplete="off"></label>
        <label class="ln-date"><i data-lucide="calendar-days"></i><input type="date" id="lnDate" aria-label="News for a date"></label>
        <button type="button" class="lv-btn-ghost" id="lnToday"><i data-lucide="radio"></i>Live today</button>
        <button type="button" class="lv-btn-ghost" id="lnRefresh" title="Search all sources again now"><i data-lucide="refresh-cw"></i>Refresh</button>
      </div>
      <div class="ln-chips" id="lnRegions">
        ${['all', 'Zimbabwe', 'Africa', 'Global'].map(r => `<button type="button" data-region="${r}" class="${r === 'all' ? 'on' : ''}">${r === 'all' ? 'All regions' : r}</button>`).join('')}
        <span class="ln-sep"></span>
        ${['all', 'Food security', 'Agriculture', 'Water', 'Climate & hazards'].map(t => `<button type="button" data-topic="${t}" class="${t === 'all' ? 'on' : ''}">${t === 'all' ? 'All topics' : t}</button>`).join('')}
      </div>
      <p class="ln-note" id="lnNote"></p>
      <div class="ln-list" id="lnList"><div class="ln-empty">Searching trusted news sources…</div></div>`;
    const dateEl = document.getElementById('lnDate');
    dateEl.max = today();
    dateEl.min = '2015-02-19';
    dateEl.addEventListener('change', () => { state.date = dateEl.value && dateEl.value !== today() ? dateEl.value : ''; state.seen.clear(); load(true); });
    document.getElementById('lnToday').addEventListener('click', () => { dateEl.value = ''; state.date = ''; load(true); });
    document.getElementById('lnRefresh').addEventListener('click', () => load(true));
    document.getElementById('lnQuery').addEventListener('input', e => { state.q = e.target.value.trim().toLowerCase(); render(); });
    document.getElementById('lnRegions').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.region) { state.region = b.dataset.region; document.querySelectorAll('#lnRegions [data-region]').forEach(x => x.classList.toggle('on', x === b)); }
      if (b.dataset.topic) { state.topic = b.dataset.topic; document.querySelectorAll('#lnRegions [data-topic]').forEach(x => x.classList.toggle('on', x === b)); }
      render();
    });
  }

  async function load(userAsked) {
    if (state.loading || !authToken) return;
    state.loading = true;
    setStatus('checking');
    const btn = document.getElementById('lnRefresh');
    if (btn && userAsked) btn.disabled = true;
    try {
      const res = await fetch(API + '/news' + (state.date ? `?date=${state.date}&tz=${new Date().getTimezoneOffset()}` : ''), { headers: authHeaders(), signal: AbortSignal.timeout(45000) });
      if (res.status === 401 && typeof handleExpiredSession === 'function') { handleExpiredSession(); return; }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Live news is temporarily unavailable.');
      // Highlight stories that appeared since the last check (live mode only).
      state.fresh = new Set();
      if (!state.date && state.seen.size) j.articles.forEach(a => { if (!state.seen.has(a.id)) state.fresh.add(a.id); });
      j.articles.forEach(a => state.seen.add(a.id));
      state.data = j;
      state.error = '';
    } catch (e) {
      state.error = e.name === 'TimeoutError' ? 'The news sources took too long to answer. Trying again shortly.' : e.message;
    } finally {
      state.loading = false;
      if (btn) btn.disabled = false;
      render();
      setStatus();
    }
  }

  function setStatus(mode) {
    const el = document.getElementById('lnStatus');
    if (!el) return;
    if (mode === 'checking') { el.className = 'ln-status checking'; el.innerHTML = '<i class="ln-dot"></i>Searching all sources…'; return; }
    const d = state.data;
    if (state.error && !d) { el.className = 'ln-status err'; el.innerHTML = `<i class="ln-dot"></i>${esc(state.error)}`; return; }
    if (state.date) { el.className = 'ln-status past'; el.innerHTML = `<i class="ln-dot"></i>Archive · ${esc(new Date(state.date + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}`; return; }
    const next = Math.max(0, Math.round((REFRESH_MS - (Date.now() - (state.lastLoad || Date.now()))) / 1000));
    el.className = 'ln-status live';
    el.innerHTML = `<i class="ln-dot"></i>Live · checked ${d ? esc(ago(d.checkedAt)) : '—'} · next search in ${next >= 60 ? Math.ceil(next / 60) + ' min' : next + ' s'}`;
  }

  function render() {
    const list = document.getElementById('lnList'), note = document.getElementById('lnNote');
    if (!list) return;
    const d = state.data;
    if (!d) { list.innerHTML = `<div class="ln-empty">${esc(state.error || 'Searching trusted news sources…')}</div>`; return; }
    const items = d.articles.filter(a =>
      (state.region === 'all' || a.region === state.region) &&
      (state.topic === 'all' || a.topic === state.topic) &&
      (!state.q || `${a.title} ${a.summary || ''} ${a.outlets.join(' ')} ${a.region}`.toLowerCase().includes(state.q)));
    const scanned = d.scanned ? d.scanned.feeds + d.scanned.google + d.scanned.gdelt : 0;
    if (note) note.innerHTML = `<i data-lucide="shield-check"></i>${items.length} of ${d.articles.length} verified stories · ${scanned.toLocaleString()} items scanned from trusted outlets worldwide${state.error ? ` · <span class="ln-warn">${esc(state.error)}</span>` : ''}${d.partial ? ' · <span class="ln-warn">Some search services are busy, so this list may be incomplete; it fills in automatically on the next search.</span>' : ''}`;
    if (!items.length) {
      list.innerHTML = `<div class="ln-empty">${d.articles.length ? 'No stories match these filters.' : state.date ? 'No verified stories on these topics were found for this date.' : 'No verified stories yet. The next search runs automatically.'}</div>`;
      return;
    }
    let lastDay = '';
    list.innerHTML = items.map(a => {
      const url = safeUrl(a.url);
      const dl = dayLabel(a.publishedAt);
      const head = dl !== lastDay ? `<div class="ln-day">${esc(dl)}</div>` : '';
      lastDay = dl;
      const color = TOPIC_COLOR[a.topic] || '#4a5568';
      const time = new Date(a.publishedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const corr = a.corroboration > 1 ? `<span class="ln-corr" title="${esc(a.outlets.join(', '))}"><i data-lucide="layers"></i>Reported by ${a.corroboration} outlets</span>` : '';
      return `${head}<article class="ln-item${state.fresh.has(a.id) ? ' ln-new' : ''}">
        <span class="ln-tag" style="background:${color}">${esc(a.topic)}</span>
        <div class="ln-body">
          ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a>` : `<b>${esc(a.title)}</b>`}
          ${a.summary ? `<p>${esc(a.summary.length > 220 ? a.summary.slice(0, 217) + '…' : a.summary)}</p>` : ''}
          <div class="ln-meta">
            ${state.fresh.has(a.id) ? '<span class="ln-newbadge">NEW</span>' : ''}
            <span class="ln-verified" title="Published by a trusted outlet; link and date checked"><i data-lucide="badge-check"></i>${esc(a.source)}</span>
            <span><i data-lucide="map-pin"></i>${esc(a.region)}</span>
            <span><i data-lucide="clock"></i>${esc(time)} · ${esc(ago(a.publishedAt))}</span>
            ${corr}
          </div>
        </div>
      </article>`;
    }).join('');
  }

  // Keep searching while the Reports page is open and the tab is visible.
  function start() {
    shell();
    stop();
    const run = () => { if (!document.hidden && !state.date) { state.lastLoad = Date.now(); load(false); } };
    if (!state.data || state.date) { state.lastLoad = Date.now(); load(false); } else { render(); setStatus(); }
    state.timer = setInterval(run, REFRESH_MS);
    state.tick = setInterval(() => setStatus(), 15000);
  }
  function stop() { clearInterval(state.timer); clearInterval(state.tick); state.timer = state.tick = null; }
  function onReports() { const p = document.getElementById('pg-reports'); return p && p.classList.contains('active'); }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && onReports() && !state.date && state.lastLoad && Date.now() - state.lastLoad > REFRESH_MS) { state.lastLoad = Date.now(); load(false); }
  });
  document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => {
    if (link.dataset.page !== 'reports') stop(); // app.js starts it via loadReports()
  }));

  window.wafeoNews = { start, stop, load, state };
})();
