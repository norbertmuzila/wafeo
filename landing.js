// ════════════════════════════════════════════════════════════
//  WAFEO landing page
//  Smooth scroll (Lenis), a pinned three-stage hero driven by scroll
//  progress, reveal-on-view, and the hand-off into sign-in.
//  Loaded after app.js, so it can read currentUser.
// ════════════════════════════════════════════════════════════
(function () {
  const root = document.getElementById('landing');
  if (!root) return;

  const $ = (s, el = root) => el.querySelector(s);
  const $$ = (s, el = root) => Array.from(el.querySelectorAll(s));
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const loggedIn = () => typeof currentUser !== 'undefined' && !!currentUser;
  const realAccount = () => loggedIn() && currentUser.role !== 'demo';

  const hero = $('#lp-top');
  const stage = $('#lpStage');
  const img = $('#lpImg');
  const layerA = $('#lpLayerA');
  const layerB = $('#lpLayerB');
  const layerC = $('#lpLayerC');
  const descend = $('#lpDescend');
  const dim = $('#lpDim');
  const handoff = $('#lpHandoff');
  const field = $('#lpField');
  const pin = $('#lpPin');
  const hud = $('#lpHud');
  const statusEl = $('#lpStatus');
  const coordsEl = $('#lpCoords');
  const nav = $('#lpNav');
  const rail = $('#lpRail');
  const railFill = $('#lpRailFill');
  const finalBg = $('#lpFinalBg');

  let gone = false;
  let pendingPage = null;

  // ─── Smooth scrolling ───────────────────────────────────────
  let lenis = null;
  if (window.Lenis && !reduceMotion) {
    try {
      lenis = new window.Lenis({
        wrapper: root,
        content: $('#landingContent'),
        duration: 1.15,
        easing: t => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        smoothWheel: true
      });
      const raf = time => { if (!gone) lenis.raf(time); requestAnimationFrame(raf); };
      requestAnimationFrame(raf);
    } catch (e) {
      console.warn('Lenis unavailable, using native scroll', e);
      lenis = null;
    }
  }

  const heroMax = () => Math.max(1, hero.offsetHeight - root.clientHeight);

  // The field outline lives in pixel space so its stroke can be "drawn"
  // with stroke-dashoffset (pathLength breaks under non-uniform scaling).
  const FIELD_PCT = [[41, 47], [59, 47], [74, 96], [26, 96]];
  const fieldSvg = field.ownerSVGElement;
  function layoutField() {
    const w = img.clientWidth || 1, h = img.clientHeight || 1;
    fieldSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    field.setAttribute('points', FIELD_PCT.map(([x, y]) => `${(x / 100 * w).toFixed(1)},${(y / 100 * h).toFixed(1)}`).join(' '));
    pin.setAttribute('cx', (0.5 * w).toFixed(1));
    pin.setAttribute('cy', (0.7 * h).toFixed(1));
    pin.setAttribute('r', '5');
  }
  layoutField();
  window.addEventListener('resize', layoutField);

  function scrollToY(y) {
    if (lenis) lenis.scrollTo(y, { duration: 1.6 });
    else root.scrollTo({ top: y, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  // Named targets; "stakes" and "field" are points inside the pinned hero.
  function targetY(name) {
    if (name === 'top') return 0;
    if (name === 'stakes') return heroMax() * 0.47;
    if (name === 'field') return heroMax() * 0.84;
    const el = document.getElementById('lp-' + name);
    return el ? el.offsetTop : 0;
  }

  root.addEventListener('click', e => {
    const go = e.target.closest('[data-lp-goto]');
    if (go) { e.preventDefault(); scrollToY(targetY(go.dataset.lpGoto)); return; }
    const enterBtn = e.target.closest('[data-lp-enter]');
    if (enterBtn) { e.preventDefault(); enterPlatform(enterBtn.dataset.lpEnter || ''); return; }
    // "Try the demo": straight into the platform, no account or sign-in.
    const demoBtn = e.target.closest('[data-lp-demo]');
    if (demoBtn) { e.preventDefault(); enterPlatform(loggedIn() ? '' : 'demo'); }
  });

  // ─── Section rail ───────────────────────────────────────────
  const railItems = [
    { id: 'top', label: 'WAFEO' },
    { id: 'stakes', label: 'The stakes' },
    { id: 'field', label: 'One field' },
    { id: 'method', label: 'Method' },
    { id: 'platform', label: 'Platform' },
    { id: 'analyst', label: 'Analyst' },
    { id: 'about', label: 'About' },
    { id: 'start', label: 'Start' }
  ];
  railItems.forEach(item => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.lpGoto = item.id;
    b.setAttribute('aria-label', 'Go to ' + item.label);
    b.innerHTML = `<span>${item.label}</span><i></i>`;
    rail.appendChild(b);
    item.btn = b;
  });

  // ─── Count-up numbers ───────────────────────────────────────
  function countUp(el) {
    if (el.dataset.done) return;
    el.dataset.done = '1';
    const target = parseFloat(el.dataset.count);
    const decimals = parseInt(el.dataset.decimals || '0', 10);
    const suffix = el.dataset.suffix || '';
    const fmt = v => v.toFixed(decimals) + suffix;
    if (reduceMotion) { el.textContent = fmt(target); return; }
    const start = performance.now();
    const dur = 1700;
    const tick = now => {
      const t = clamp((now - start) / dur);
      el.textContent = fmt(target * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ─── Scroll-driven hero ─────────────────────────────────────
  let ticking = false;
  function onScroll() {
    if (ticking || gone) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; update(); });
  }
  root.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  function update() {
    const y = root.scrollTop;
    const vh = root.clientHeight;
    const p = clamp(y / heroMax());

    // Camera: slow push into the rows as you descend.
    const zoom = 1 + 0.5 * smooth(0, 1, p);
    img.style.transform = `translate3d(0, ${(-2.5 * p).toFixed(3)}%, 0) scale(${zoom.toFixed(4)})`;

    // Stage A: headline lifts away.
    const a = 1 - smooth(0.14, 0.27, p);
    layerA.style.opacity = a;
    layerA.style.transform = `translate3d(0, ${(-60 * (1 - a)).toFixed(1)}px, 0)`;
    layerA.style.pointerEvents = a > 0.5 ? 'auto' : 'none';
    descend.style.opacity = 1 - smooth(0.02, 0.1, p);

    // Stage B: the stakes.
    const bIn = smooth(0.29, 0.37, p);
    const bOut = 1 - smooth(0.55, 0.62, p);
    const b = Math.min(bIn, bOut);
    layerB.style.opacity = b;
    layerB.style.transform = `translate3d(0, ${(40 * (1 - bIn) - 40 * (1 - bOut)).toFixed(1)}px, 0)`;
    if (bIn > 0.5) $$('[data-count]', layerB).forEach(countUp);

    // Stage C: lock onto one field.
    const cIn = smooth(0.63, 0.72, p);
    const c = cIn * (1 - smooth(0.93, 0.985, p));
    layerC.style.opacity = c;
    layerC.style.transform = `translate3d(0, ${(30 * (1 - cIn)).toFixed(1)}px, 0)`;
    field.style.strokeDashoffset = (1 - smooth(0.6, 0.8, p)).toFixed(4);
    field.style.fillOpacity = smooth(0.76, 0.86, p).toFixed(3);
    pin.style.opacity = smooth(0.78, 0.84, p) * (1 - smooth(0.93, 0.98, p));
    if (cIn > 0.5) {
      countUp($('#lpNdvi'));
      $('#lpNdviMark').style.left = '78%';
    }
    stage.classList.toggle('lp-scanning', p > 0.6 && p < 0.94 && !reduceMotion);

    dim.style.opacity = (0.42 * b + 0.22 * c).toFixed(3);
    handoff.style.opacity = smooth(0.95, 1, p).toFixed(3);

    // HUD
    const status = p < 0.29 ? 'Acquiring' : p < 0.62 ? 'Tracking' : 'Locked';
    if (statusEl.textContent !== status) statusEl.textContent = status;
    hud.classList.toggle('locked', p >= 0.62);
    hud.style.opacity = hudReady ? String(0.92 * (1 - smooth(0.9, 0.97, p))) : '';
    if (coordsSettled) {
      const alt = 786 * Math.pow(1 - p, 3) + 0.4;
      coordsEl.textContent = `LAT -0.3031 · LON 36.0800 · ALT ${alt < 10 ? alt.toFixed(1) : Math.round(alt)} KM`;
    }

    // Nav and rail switch to the light theme once past the hero.
    const pastHero = y > hero.offsetHeight - vh * 0.5;
    nav.classList.toggle('solid', pastHero);

    let active = 'top';
    if (p >= 0.29) active = 'stakes';
    if (p >= 0.62) active = 'field';
    $$('[data-lp-section]').forEach(sec => {
      const id = sec.dataset.lpSection;
      if (id !== 'top' && sec.offsetTop - vh * 0.45 <= y) active = id;
    });
    railItems.forEach(item => item.btn.classList.toggle('on', item.id === active));
    rail.classList.toggle('lp-on-light', pastHero && active !== 'start');
    const docMax = Math.max(1, root.scrollHeight - vh);
    railFill.style.height = `calc(${(clamp(y / docMax) * 100).toFixed(2)}% - 12px)`;

    // Gentle parallax behind the final call to action.
    const fr = finalBg.parentElement.getBoundingClientRect();
    if (fr.top < vh && fr.bottom > 0) {
      const t = (fr.top + fr.height / 2 - vh / 2) / vh;
      finalBg.style.transform = `translate3d(0, ${(t * 60).toFixed(1)}px, 0) scale(1.1)`;
    }
  }

  // ─── Intro: "acquiring" the field ───────────────────────────
  let hudReady = false;
  let coordsSettled = false;

  function scrambleCoords() {
    if (reduceMotion) { coordsSettled = true; update(); return; }
    const start = performance.now();
    const rand = (n, d) => (Math.random() * n).toFixed(d);
    const tick = now => {
      if (now - start < 1500) {
        coordsEl.textContent = `LAT -${rand(9, 4)} · LON ${rand(90, 4)} · ALT ${rand(999, 0)} KM`;
        requestAnimationFrame(tick);
      } else {
        coordsSettled = true;
        update();
      }
    };
    requestAnimationFrame(tick);
  }

  function intro() {
    stage.classList.add('lp-ready');
    setTimeout(() => {
      $$('.lp-mask, .lp-reveal', layerA).forEach(el => el.classList.add('in'));
    }, reduceMotion ? 0 : 650);
    setTimeout(() => { hudReady = true; scrambleCoords(); }, reduceMotion ? 0 : 900);
  }
  const heroImg = $('img', img);
  let introStarted = false;
  const startIntro = () => { if (!introStarted) { introStarted = true; requestAnimationFrame(intro); } };
  if (heroImg.complete) startIntro();
  else { heroImg.addEventListener('load', startIntro); heroImg.addEventListener('error', startIntro); }
  setTimeout(startIntro, 1800); // never wait forever on a slow image

  // ─── Reveal on view ─────────────────────────────────────────
  const io = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('in');
      if (entry.target.id === 'lpChat') playChat();
      io.unobserve(entry.target);
    });
  }, { root, threshold: 0.15, rootMargin: '0px 0px -6% 0px' });

  // ─── Instruments ────────────────────────────────────────────
  const INSTRUMENTS = [
    { name: 'Sentinel-2', kind: 'Optical', source: 'Multispectral, 13 bands · 5-day revisit · Copernicus, ESA',
      measures: [['Vegetation health (NDVI)', '10 m · 5 day'], ['Crop type and growth stage', '20 m · 5 day'], ['Surface water (NDWI)', '10 m · 5 day']],
      powers: ['Crop Monitoring', 'Precision Farming', 'Water Resources', 'Global Dashboard'] },
    { name: 'Sentinel-1', kind: 'Radar', source: 'C-band SAR, sees through cloud · 6-day revisit · Copernicus, ESA',
      measures: [['Flood extent', '10 m · each pass'], ['Surface soil moisture', '1 km · 6 day'], ['Crop structure (backscatter)', '20 m · 6 day']],
      powers: ['Early Warning', 'Water Resources', 'Soil Analysis'] },
    { name: 'Landsat 8 / 9', kind: 'Thermal', source: 'Optical and thermal infrared · 8-day combined revisit · NASA / USGS',
      measures: [['Land surface temperature', '100 m · 8 day'], ['Evapotranspiration', '30 m · 8 day'], ['Land change since the 1980s', '30 m · archive']],
      powers: ['Drought Monitor', 'Soil Analysis', 'Reports'] },
    { name: 'SMAP', kind: 'L-band', source: 'Passive microwave radiometer · 2 to 3 day revisit · NASA',
      measures: [['Surface soil moisture', '9 km · 2 to 3 day'], ['Root-zone soil moisture', '9 km · 3 day'], ['Freeze and thaw state', '9 km · daily']],
      powers: ['Drought Monitor', 'Soil Analysis', 'Precision Farming'] },
    { name: 'NISAR', kind: 'L- & S-band SAR', source: 'Dual-band radar, cloud-penetrating · 12-day revisit · NASA / ISRO',
      measures: [['Soil moisture', '200 m · 12 day'], ['Crop and vegetation structure', 'high resolution · 12 day'], ['Ground deformation', 'high resolution · 12 day']],
      powers: ['Soil Analysis', 'Global Dashboard', 'Precision Farming'] },
    { name: 'GRACE-FO', kind: 'Gravity', source: 'Satellite gravimetry · monthly · NASA / GFZ',
      measures: [['Groundwater storage change', '~300 km · monthly'], ['Total water storage', '~300 km · monthly']],
      powers: ['Water Resources', 'Drought Monitor', 'Early Warning'] },
    { name: 'CHIRPS', kind: 'Rainfall', source: 'Satellite and station rainfall · daily · Climate Hazards Center, UCSB',
      measures: [['Rainfall', '5 km · daily'], ['Rainfall anomaly vs. normal', '5 km · 10-day'], ['Standardized Precipitation Index (SPI)', '5 km · monthly']],
      powers: ['Drought Monitor', 'Early Warning', 'Food Security'] }
  ];
  const tabs = $('#lpTabs');
  const panel = $('#lpPanel');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function showInstrument(i, focus) {
    $$('.lp-tab', tabs).forEach((t, j) => {
      t.setAttribute('aria-selected', String(i === j));
      t.tabIndex = i === j ? 0 : -1;
    });
    const ins = INSTRUMENTS[i];
    panel.setAttribute('aria-labelledby', 'lpTab' + i);
    panel.innerHTML = `
      <div class="lp-panel-head">
        <div><h3>${esc(ins.name)}</h3><p>${esc(ins.source)}</p></div>
        <span class="lp-tag lp-tag-leaf">${esc(ins.kind)}</span>
      </div>
      <div class="lp-panel-cols">
        <div><h4>Measures</h4>${ins.measures.map(m => `<div class="lp-measure"><span>${esc(m[0])}</span><span>${esc(m[1])}</span></div>`).join('')}</div>
        <div><h4>Powers in WAFEO</h4><div class="lp-tags">${ins.powers.map(p => `<span class="lp-tag">${esc(p)}</span>`).join('')}</div></div>
      </div>
      <div class="lp-note"><span aria-hidden="true">✓</span><span>Evidence for decisions, not a guarantee. Verify critical decisions with official sources.</span></div>`;
    panel.classList.remove('swap'); void panel.offsetWidth; panel.classList.add('swap');
    if (focus) $$('.lp-tab', tabs)[i].focus();
  }
  INSTRUMENTS.forEach((ins, i) => {
    const t = document.createElement('button');
    t.className = 'lp-tab';
    t.type = 'button';
    t.id = 'lpTab' + i;
    t.setAttribute('role', 'tab');
    t.innerHTML = `<b>${esc(ins.name)}</b><small>${esc(ins.kind)}</small>`;
    t.addEventListener('click', () => showInstrument(i));
    t.addEventListener('keydown', e => {
      const n = INSTRUMENTS.length;
      if (['ArrowDown', 'ArrowRight'].includes(e.key)) { e.preventDefault(); showInstrument((i + 1) % n, true); }
      if (['ArrowUp', 'ArrowLeft'].includes(e.key)) { e.preventDefault(); showInstrument((i - 1 + n) % n, true); }
    });
    tabs.appendChild(t);
  });
  showInstrument(0);

  // ─── Platform modules ───────────────────────────────────────
  const icon = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const MODULES = [
    ['dashboard', 'Global Dashboard', 'Live world map of crop health, water risk and alerts, continent by continent.', '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'],
    ['site-intelligence', 'Site Intelligence', 'Search any region for farming, water, agriculture and climate metrics, in 2D or 3D.', '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>'],
    ['precision-farming', 'Precision Farming', 'Field-by-field NDVI analysis, irrigation guidance and yield forecasts.', '<path d="M4 20 12 4l8 16"/><path d="M7 14h10"/>'],
    ['crop-monitoring', 'Crop Monitoring', 'NDVI time series and growth-stage tracking from Sentinel-2 and MODIS.', '<path d="M12 21V9"/><path d="M12 13c-4 0-6-3-6-7 4 0 6 3 6 7Z"/><path d="M12 11c0-4 2-7 6-7 0 4-2 7-6 7Z"/>'],
    ['soil-analysis', 'Soil Analysis', 'Soil moisture from NISAR, SMAP and Sentinel-1, with groundwater from GRACE-FO.', '<path d="M3 8h18M3 13h18M3 18h18"/>'],
    ['water-resources', 'Water Resources', 'Reservoirs, lakes, snow and groundwater storage tracked from orbit.', '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>'],
    ['drought-monitor', 'Drought Monitor', 'SPI, SPEI and vegetation condition indices that flag drought early.', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'],
    ['food-security', 'Food Security', 'IPC food-insecurity phases and the people affected, region by region.', '<path d="M4 11h16a8 8 0 0 1-16 0Z"/><path d="M8 7c0-2 1-3 2-3M12 7c0-2 1-3 2-3"/>'],
    ['early-warning', 'Early Warning', '90-day IPC-compatible forecasts from satellite, weather, price and conflict data.', '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/>'],
    ['reports', 'Reports', 'AI-assisted reports, saved briefings and live news from FAO, WFP, NASA and more.', '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>']
  ];
  const modulesEl = $('#lpModules');
  modulesEl.innerHTML = MODULES.map((m, i) => `
    <button type="button" class="lp-mod lp-reveal" style="--d:${(i % 3) * 90}ms" data-lp-module="${m[0]}">
      <div class="lp-ico">${icon(m[3])}</div>
      <h3>${esc(m[1])}</h3>
      <p>${esc(m[2])}</p>
    </button>`).join('');
  modulesEl.addEventListener('click', e => {
    const mod = e.target.closest('[data-lp-module]');
    if (!mod) return;
    pendingPage = mod.dataset.lpModule;
    enterPlatform('');
  });

  // ─── Analyst conversation (example) ─────────────────────────
  const CHAT = [
    { who: 'user', text: 'How is Field 07 doing this week?' },
    { who: 'bot', kind: 'Observation', text: 'Healthy. NDVI reads 0.78, up 6% in two weeks and above the five-year median for this growth stage.', src: 'NDVI · Sentinel-2 · 17 Oct 2026 · conf 0.92' },
    { who: 'bot', kind: 'Observation', text: 'Topsoil moisture is 31%, with 84 mm of rain over the last 30 days.', src: 'SMAP · CHIRPS' },
    { who: 'bot', kind: 'Recommendation', text: 'No irrigation needed before the next pass. Recheck if rainfall stays under 10 mm for the coming ten days.', src: 'WAFEO water balance' }
  ];
  let chatPlayed = false;
  function playChat() {
    if (chatPlayed) return;
    chatPlayed = true;
    const body = $('#lpChatBody');
    const wait = ms => new Promise(r => setTimeout(r, reduceMotion ? 0 : ms));
    const add = html => { const d = document.createElement('div'); d.innerHTML = html; const el = d.firstElementChild; body.appendChild(el); requestAnimationFrame(() => el.classList.add('in')); return el; };
    (async () => {
      await wait(400);
      for (const m of CHAT) {
        if (m.who === 'bot') {
          const typing = add('<div class="lp-msg bot"><span class="lp-typing"><i></i><i></i><i></i></span></div>');
          await wait(900);
          typing.remove();
          add(`<div class="lp-msg bot"><span class="lp-kind">${esc(m.kind.toUpperCase())}</span>${esc(m.text)}<span class="lp-src">${esc(m.src)}</span></div>`);
          await wait(500);
        } else {
          add(`<div class="lp-msg user">${esc(m.text)}</div>`);
          await wait(450);
        }
      }
    })();
  }

  // Observe after dynamic content exists.
  $$('.lp-reveal, .lp-mask, .lp-step, .lp-photo').forEach(el => {
    if (!layerA.contains(el)) io.observe(el);
  });

  // ─── Enter / return ─────────────────────────────────────────
  function updateCtas() {
    const signedIn = loggedIn();
    $$('[data-lp-cta-label]').forEach((el, i) => {
      el.textContent = signedIn ? 'Open dashboard' : (i === 0 ? 'Sign in' : 'Enter the platform');
    });
    $$('[data-lp-enter="register"]').forEach(el => { el.hidden = realAccount(); });
    $$('[data-lp-demo]').forEach(el => { el.hidden = signedIn; });
  }

  function openPendingPage() {
    if (!pendingPage || !loggedIn()) return;
    const link = document.querySelector(`.nav-link[data-page="${pendingPage}"]`);
    pendingPage = null;
    if (link) setTimeout(() => link.click(), 450);
  }

  function enterPlatform(mode) {
    if (gone) return;
    gone = true;
    if (lenis) lenis.stop();
    const login = document.getElementById('loginScreen');
    if (mode === 'demo') {
      root.classList.add('lp-gone');
      if (typeof window.wafeoStartDemo === 'function') window.wafeoStartDemo();
      return;
    }
    if (login && !loggedIn()) {
      login.classList.remove('lp-arrive'); void login.offsetWidth; login.classList.add('lp-arrive');
    }
    root.classList.add('lp-gone');
    if (mode === 'register' && !loggedIn()) {
      setTimeout(() => document.getElementById('registerModal').classList.add('show'), 500);
    }
    openPendingPage();
  }

  function showHome() {
    gone = false;
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}
    root.classList.remove('lp-gone');
    root.scrollTop = 0;
    if (lenis) { lenis.start(); lenis.scrollTo(0, { immediate: true }); }
    updateCtas();
    update();
  }
  window.wafeoShowHome = showHome;
  window.wafeoLanding = {
    hide: () => enterPlatform(''),
    // Used when the demo cannot start: fall back to the sign-in screen.
    showLogin: () => { gone = false; enterPlatform(''); }
  };

  document.addEventListener('wafeo:auth', () => { updateCtas(); openPendingPage(); });

  // The landing page always opens first. An old "#app" link is tidied away.
  if (window.location.hash === '#app') {
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}
  }
  // Leaving the demo to create an account goes straight to sign-up.
  try {
    if (sessionStorage.getItem('wafeo.openRegister')) {
      sessionStorage.removeItem('wafeo.openRegister');
      setTimeout(() => enterPlatform('register'), 300);
    }
  } catch (e) {}

  updateCtas();
  update();
})();
