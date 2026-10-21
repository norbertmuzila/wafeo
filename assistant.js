// ════════════════════════════════════════════════════════════
//  WAFEO — "Ask AI" assistant (floating button, bottom right)
//  Sends the conversation plus the live results of the analysed area,
//  so answers about the user's field use the real numbers. Replies are
//  rendered as safe, escaped Markdown. Loaded after app.js and eo.js.
// ════════════════════════════════════════════════════════════
(function () {
  const STORE = 'wafeo.chat';
  const esc = s => escapeHtml(s);
  const $ = id => document.getElementById(id);
  const panel = $('aiWidgetPanel'), fab = $('aiFabBtn'), win = $('aiChatWindow'), input = $('aiInput'), form = $('aiForm');
  if (!panel || !fab || !win || !input || !form) return;

  let history = [];
  try { history = JSON.parse(sessionStorage.getItem(STORE) || '[]').filter(m => m && m.role && m.content); } catch (e) { history = []; }
  let busy = false;
  const save = () => { try { sessionStorage.setItem(STORE, JSON.stringify(history.slice(-30))); } catch (e) {} };

  // ─── Context: the live analysis, as compact text ─────────
  const n = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : v);
  function buildContext() {
    const site = window.wafeoSite, a = site && site.last();
    if (!a) return '';
    const p = a.data.place || {};
    const lines = [];
    const dry = !!(a.domains.waterQuantity && a.domains.waterQuantity.metrics && a.domains.waterQuantity.metrics.season);
    lines.push(`Area: ${[p.name, p.admin1, p.country].filter(Boolean).join(', ') || 'selected area'}; ${a.aoi.areaHa} ha; centre ${a.aoi.centroid[1].toFixed(4)}, ${a.aoi.centroid[0].toFixed(4)}.`);
    lines.push(`Analysed: ${a.generatedAt.slice(0, 16).replace('T', ' ')} UTC. Satellite image: ${(a.data.sentinel2 && a.data.sentinel2.scene && a.data.sentinel2.scene.date) || 'n/a'}.`);
    lines.push(`Overall: ${a.overall.riskLevel} risk${Number.isFinite(a.overall.score) ? `, condition score ${a.overall.score}/100` : ''}. ${a.overall.headline}`);
    const labels = site.labels || {};
    // In the dry season percent-of-normal rainfall is misleading (tiny normals): leave it out, as the pages do.
    if (dry) lines.push('Season: dry season here, so little rain is normal; percentages of normal rainfall are not meaningful and are omitted.');
    const skip = new Set(dry ? ['rain30PctNormal', 'rain90PctNormal', 'spi90'] : []);
    for (const [k, d] of Object.entries(a.domains || {})) {
      if (!d) continue;
      const m = Object.entries(d.metrics || {}).filter(([mk, v]) => v !== null && v !== undefined && v !== '' && !skip.has(mk))
        .map(([mk, v]) => `${labels[mk] || mk}: ${typeof v === 'object' ? JSON.stringify(v) : n(v)}`).join('; ');
      lines.push(`[${k}] status ${d.status}${Number.isFinite(d.score) ? ` (${d.score}/100)` : ''}. ${d.summary}${m ? ` Readings: ${m}.` : ''}`);
    }
    // The platform's own reading of key numbers, so answers do not misread them.
    const W = (a.domains.waterQuantity && a.domains.waterQuantity.metrics) || {};
    const notes = [];
    const z = W.spi90;
    notes.push('Drought check: ' + (dry ? 'it is the dry season here, so little rain is normal; this is not a drought signal. Watch the start of the rains and soil water.'
      : !Number.isFinite(z) ? 'not enough rainfall history to judge drought.'
      : z <= -2 ? 'extreme drought (rainfall far below normal).' : z <= -1.5 ? 'severe drought.' : z <= -1 ? 'moderate drought: rainfall clearly below normal.' : z <= -0.5 ? 'slightly drier than normal, not a drought.' : z >= 1.5 ? 'much wetter than normal.' : 'rainfall is within the normal range; no drought.'));
    if (Number.isFinite(W.rootZoneAvailableWaterPct)) {
      const pct = W.rootZoneAvailableWaterPct, sp = W.rootZoneSeasonalPercentile;
      notes.push(`Soil water now: root-zone wetness is ${pct}% of this spot's own 10-year range (0% = driest, 100% = wettest), i.e. ${pct < 25 ? 'dry' : pct < 45 ? 'somewhat dry' : pct <= 70 ? 'about average' : 'wet'}${Number.isFinite(sp) ? `; compared with the same weeks in past years it is at the ${sp}th percentile (${sp >= 80 ? 'unusually wet for the season' : sp <= 20 ? 'unusually dry for the season' : 'normal for the season'})` : ''}.`);
    }
    if ((a.issues || []).some(i => /holds little water/i.test(i.title))) notes.push('"Soil holds little water" refers to the low water-holding CAPACITY of this soil type (how much it can store), not to how wet it is now.');
    const fsd = a.data.foodSecurity;
    if (fsd && fsd.available && fsd.current) notes.push(`Food security: IPC Phase ${fsd.current.phase} (${fsd.current.label}) now.`);
    lines.push('INTERPRETATION: ' + notes.join(' '));
    if (a.issues && a.issues.length) lines.push('Warnings (most urgent first): ' + a.issues.slice(0, 8).map(i => `${i.severity}: ${i.title} (${i.detail})`).join(' | '));
    for (const who of ['farmers', 'government', 'public']) {
      const r = (a.recommendations && a.recommendations[who]) || [];
      if (r.length) lines.push(`Actions for ${who}: ` + r.slice(0, 4).map(x => x.action).join(' | '));
    }
    const fc = a.data.weather && a.data.weather.forecastDaily;
    if (fc && fc.length) {
      const sum = k => n(fc.reduce((t, r) => t + (r[k] || 0), 0), 1);
      const wet = fc.filter(r => (r.rainMm || 0) >= 1).map(r => `${r.date.slice(5)} ${n(r.rainMm, 1)} mm`);
      lines.push(`16-day forecast ${fc[0].date} to ${fc[fc.length - 1].date}: rain ${sum('rainMm')} mm in total (days with 1 mm or more: ${wet.join(', ') || 'none'}); crop water need ${sum('et0Mm')} mm; hottest day ${n(Math.max(...fc.map(r => r.tmaxC ?? -99)), 0)} °C.`);
    }
    const hz = (a.data.hazards && a.data.hazards.events) || [];
    if (hz.length) lines.push('Hazard alerts within 600 km: ' + hz.slice(0, 5).map(e => `${e.type} ${e.alert} ${e.distanceKm} km (${e.country})`).join('; '));
    const f = a.data.foodSecurity;
    if (f && f.available) lines.push(`Food security (${f.unitLevel} ${f.unitName}): now ${f.current ? `Phase ${f.current.phase} ${f.current.label} (${f.current.period})` : 'n/a'}; coming months ${f.nearTerm ? `Phase ${f.nearTerm.phase} ${f.nearTerm.label} (${f.nearTerm.period})` : 'n/a'}.`);
    const cmpApi = window.wafeoCompare;
    const cmp = cmpApi && cmpApi.cached(a);
    if (cmp && cmp.available) lines.push(`Change over time (${cmpApi.label(cmp.months)}): ${cmp.then.date} vs ${cmp.now.date}. Then: mean NDVI ${cmp.then.stats.meanNdvi}, green cover ${cmp.then.stats.greenCoverPct}%, bare ${cmp.then.stats.bareSoilPct}%. Now: mean NDVI ${cmp.now.stats.meanNdvi}, green cover ${cmp.now.stats.greenCoverPct}%, bare ${cmp.now.stats.bareSoilPct}%. Less green ${cmp.change.declinedPct}%, greener ${cmp.change.improvedPct}%, same ${cmp.change.stablePct}%. ${cmp.findings.join(' ')}`);
    return lines.join('\n').slice(0, 9000);
  }

  // ─── Safe Markdown → HTML (escape first, then format) ─────
  function md(text) {
    const inline = t => esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    const out = [];
    let list = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of String(text).replace(/\r/g, '').split('\n')) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { close(); continue; }
      if ((m = line.match(/^\s*#{1,6}\s+(.*)$/))) { close(); out.push(`<h5>${inline(m[1])}</h5>`); continue; }
      if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
      if (/^\s*\|.*\|\s*$/.test(line)) {          // simple table row → readable line
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
        close(); out.push(`<p class="ai-row">${inline(line.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => c.trim()).join(' · '))}</p>`); continue;
      }
      close(); out.push(`<p>${inline(line)}</p>`);
    }
    close();
    return out.join('');
  }

  // ─── Rendering ────────────────────────────────────────────
  const AVATAR = '<img src="assets/ai-icon.webp?v=1" srcset="assets/ai-icon.webp?v=1 1x, assets/ai-icon-512.webp?v=1 2x" alt="" width="28" height="28">';
  function bubble(role, html, extra = '') {
    const div = document.createElement('div');
    div.className = `ai-msg ai-${role}${extra}`;
    div.innerHTML = role === 'assistant' ? `<span class="ai-av">${AVATAR}</span><div class="ai-bubble">${html}</div>` : `<div class="ai-bubble">${html}</div>`;
    win.appendChild(div);
    win.scrollTop = win.scrollHeight;
    return div;
  }
  function greeting() {
    const name = window.wafeoSite && window.wafeoSite.siteName();
    return name
      ? `Hello! I can answer questions about your analysed area, **${name}**, using its live satellite, weather, soil and food-security results, and explain anything on WAFEO. What would you like to know?`
      : 'Hello! I am Ask AI, the WAFEO assistant. Ask me about crops, water, drought, soil or food security, or how to use the platform. To get answers about your own field, zoom into the Dashboard map and click a field to analyse it first.';
  }
  function renderAll() {
    win.innerHTML = '';
    bubble('assistant', md(greeting()));
    history.forEach(m => bubble(m.role, m.role === 'assistant' ? md(m.content) : esc(m.content).replace(/\n/g, '<br>')));
    suggestions();
    note();
  }
  function note() {
    const el = $('aiContextNote'), name = window.wafeoSite && window.wafeoSite.siteName();
    if (el) el.textContent = name ? `Using live results for ${name}` : 'WAFEO assistant for water, farming and food security';
  }
  function suggestions() {
    const box = $('aiSuggest');
    if (!box) return;
    const has = !!(window.wafeoSite && window.wafeoSite.last());
    const list = history.length ? [] : has
      ? ['Summarise my field’s condition', 'What should I do this week?', 'Is there a drought risk here?', 'Explain my soil results', 'How has my field changed over time?']
      : ['What does NDVI mean?', 'How do I analyse my farm?', 'What is IPC Phase 3?', 'How can farmers cope with drought?'];
    box.innerHTML = list.map(q => `<button type="button">${esc(q)}</button>`).join('');
    box.hidden = !list.length;
  }

  // ─── Sending ──────────────────────────────────────────────
  async function send(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    if (!authToken) { bubble('assistant', md('Please sign in or press **Try the demo** to use Ask AI.')); return; }
    busy = true;
    $('aiSendBtn').disabled = true;
    input.value = ''; autosize();
    const sug = $('aiSuggest'); if (sug) sug.hidden = true;
    history.push({ role: 'user', content: text });
    save();
    bubble('user', esc(text).replace(/\n/g, '<br>'));
    const typing = bubble('assistant', '<span class="ai-dots"><i></i><i></i><i></i></span>', ' ai-typing');
    // Make sure a comparison the user may ask about is included when it is ready.
    const page = (document.getElementById('pgTitle') || {}).textContent || '';
    try {
      const res = await fetch(API + '/ai/chat', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ messages: history.slice(-12), context: buildContext(), page }),
        signal: AbortSignal.timeout(60000)
      });
      if (res.status === 401 && typeof handleExpiredSession === 'function') { handleExpiredSession(); throw new Error('Your session has ended. Please sign in again.'); }
      const data = await res.json().catch(() => ({}));
      typing.remove();
      if (!res.ok || !data.reply) throw new Error(data.reply || data.error || 'The AI service is unavailable right now.');
      history.push({ role: 'assistant', content: data.reply });
      save();
      bubble('assistant', md(data.reply));
    } catch (e) {
      typing.remove();
      history.pop();                      // let the user retry the same question
      save();
      // A busy service usually frees up within seconds: retry once automatically.
      if (!send._auto && /busy|try again/i.test(e.message)) {
        send._auto = true;
        win.lastElementChild && win.lastElementChild.classList.contains('ai-user') && win.lastElementChild.remove();
        busy = false;
        setTimeout(() => { send(text).finally(() => { send._auto = false; }); }, 4000);
        return;
      }
      send._auto = false;
      const div = bubble('assistant', `${esc(e.name === 'TimeoutError' ? 'The answer took too long.' : e.message)} <button type="button" class="ai-retry">Try again</button>`, ' ai-error');
      div.querySelector('.ai-retry').addEventListener('click', () => { div.remove(); win.lastElementChild && win.lastElementChild.classList.contains('ai-user') && win.lastElementChild.remove(); send(text); });
    } finally {
      busy = false;
      $('aiSendBtn').disabled = false;
      input.focus();
    }
  }

  // ─── Open / close and input handling ─────────────────────
  function open(on) {
    panel.classList.toggle('open', on);
    panel.setAttribute('aria-hidden', String(!on));
    fab.setAttribute('aria-expanded', String(on));
    fab.classList.toggle('active', on);
    if (on) { renderAll(); setTimeout(() => input.focus(), 50); }
  }
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; input.style.overflowY = input.scrollHeight > 120 ? 'auto' : 'hidden'; }

  fab.addEventListener('click', () => open(!panel.classList.contains('open')));
  $('aiCloseBtn').addEventListener('click', () => open(false));
  $('aiNewChat').addEventListener('click', () => { history = []; save(); renderAll(); input.focus(); });
  form.addEventListener('submit', e => { e.preventDefault(); send(input.value); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); } });
  input.addEventListener('input', autosize);
  $('aiSuggest').addEventListener('click', e => { const b = e.target.closest('button'); if (b) send(b.textContent); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel.classList.contains('open')) open(false); });
  document.addEventListener('wafeo:analysis', () => { note(); if (panel.classList.contains('open') && !history.length) renderAll(); });

  window.wafeoAssistant = { open, send, buildContext, md };
})();
