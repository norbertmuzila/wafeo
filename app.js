// ════════════════════════════════════════
//  WAFEO Platform — Frontend Application
// ════════════════════════════════════════

// Dynamic API URL: relative when served by our own backend, full URL on GitHub Pages
const API = /vercel\.app$|^localhost$|^127\.0\.0\.1$/.test(window.location.hostname)
  ? '/api'
  : 'https://wafeo-webapplication.vercel.app/api';
const GOOGLE_CLIENT_ID = '681642080635-fpqmjobr8hnt63adria7qmlk3kar8kej.apps.googleusercontent.com';
const SESSION_KEY = 'wafeo.session';
const ROLE_LABELS = {
  admin: 'Administrator', farmer: 'Farmer / Extension', policy: 'Gov / Policy',
  government: 'Gov / Policy', researcher: 'Researcher'
};

let authToken = null;
let currentUser = null;

// ─── SESSION STORAGE ───
// "Remember me" keeps the session in localStorage (survives closing the
// browser); otherwise sessionStorage (cleared when the tab closes).
function saveSession(remember) {
  const value = JSON.stringify({ token: authToken, user: currentUser, remember: !!remember });
  try {
    (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, value);
    (remember ? sessionStorage : localStorage).removeItem(SESSION_KEY);
  } catch (e) { /* storage blocked: session lasts until reload */ }
}

function readSavedSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
}

function authHeaders(extra = {}) {
  return authToken ? { ...extra, 'Authorization': 'Bearer ' + authToken } : { ...extra };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function postJson(path, body, timeoutMs = 20000) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function showLoginError(message) {
  const errEl = document.getElementById('loginError');
  if (!errEl) return;
  errEl.textContent = message || '';
  errEl.classList.toggle('show', !!message);
}

function networkErrorMessage(err) {
  return err && err.name === 'TimeoutError'
    ? 'The server took too long to respond. Please try again.'
    : 'Cannot reach the WAFEO server. Check your internet connection and try again.';
}

function logActivity(action, details) {
  if (!authToken) return;
  fetch(API + '/activity/log', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ action, details })
  }).catch(() => {});
}

// ─── ENTER / LEAVE THE APP ───
// One path for password login, Google sign-in, sign-up and session restore.
function enterApp(session, { remember = true, action = null } = {}) {
  authToken = session.token;
  currentUser = session.user;
  saveSession(remember);
  showLoginError('');

  const name = currentUser.name || currentUser.username || 'User';
  document.getElementById('sbName').textContent = name;
  document.getElementById('sbRole').textContent = ROLE_LABELS[currentUser.role] || 'Member';
  const avatar = document.getElementById('sbAvatar');
  const initials = name.split(/\s+/).map(n => n[0]).join('').substring(0, 2).toUpperCase();
  if (currentUser.picture) {
    avatar.innerHTML = `<img src="${escapeHtml(currentUser.picture)}" alt="" referrerpolicy="no-referrer" style="width:100%;height:100%;border-radius:50%;object-fit:cover" onerror="this.parentNode.textContent='${initials}'">`;
  } else {
    avatar.textContent = initials;
  }

  const adminPanel = document.getElementById('adminUsersPanel');
  if (adminPanel && currentUser.role !== 'admin') adminPanel.style.display = 'none';

  document.getElementById('loginScreen').classList.add('out');
  setTimeout(() => { document.getElementById('appShell').classList.add('on'); }, 400);
  // A broken panel must never block sign-in.
  Promise.resolve().then(loadDashboard).catch(err => console.error('Dashboard load failed:', err));
  try { initMapOnce(); } catch (err) { console.error('Map init failed:', err); }
  if (action) logActivity(action, `Signed in (${currentUser.email || currentUser.username})`);
  document.dispatchEvent(new CustomEvent('wafeo:auth'));
}

function doLogout() {
  logActivity('logout', 'User logged out');
  clearSession();
  try { localStorage.removeItem('wafeo.lastAnalysis'); } catch (e) {}
  try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch (e) {}
  // A reload gives the next user a clean slate (map, charts, caches).
  setTimeout(() => window.location.reload(), 150);
}

function handleExpiredSession() {
  if (!authToken) return;
  authToken = null;
  clearSession();
  try { sessionStorage.setItem('wafeo.expired', '1'); } catch (e) {}
  window.location.reload();
}

// Restore a saved session on page load.
(async function restoreSession() {
  try {
    if (sessionStorage.getItem('wafeo.expired')) {
      sessionStorage.removeItem('wafeo.expired');
      showLoginError('Your session expired. Please sign in again.');
    }
  } catch (e) {}
  const saved = readSavedSession();
  if (!saved || !saved.token) return;
  try {
    const res = await fetch(API + '/auth/me', {
      headers: { 'Authorization': 'Bearer ' + saved.token },
      signal: AbortSignal.timeout(15000)
    });
    if (res.ok) {
      enterApp(await res.json(), { remember: saved.remember });
    } else if (res.status === 401) {
      clearSession();
    }
  } catch (e) {
    // Offline or server cold-starting: keep the saved session, show login.
    console.warn('Session restore failed:', e);
  }
})();

// ─── AUTH ───
document.getElementById('btnLogin').addEventListener('click', doLogin);
document.getElementById('inPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('inUser').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('inPass').focus(); });

// ─── Google Sign-In ───
// Any Google account can sign in; the backend verifies the ID token and
// creates the WAFEO account on first use.
async function handleGoogleCredentialResponse(response) {
  showLoginError('');
  try {
    const { res, data } = await postJson('/auth/google', { credential: response.credential });
    if (!res.ok) return showLoginError(data.error || 'Google sign-in failed. Please try again.');
    const remember = document.getElementById('rememberMe');
    enterApp(data, { remember: remember ? remember.checked : true, action: 'google_login' });
  } catch (err) {
    console.error('Google Sign-In failed:', err);
    showLoginError(networkErrorMessage(err));
  }
}

function initGoogleSignIn() {
  const container = document.getElementById('googleButtonContainer');
  if (!container) return;
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleCredentialResponse,
    auto_select: false,
    cancel_on_tap_outside: true,
    ux_mode: 'popup'
  });
  const width = Math.min(330, Math.max(200, (container.parentElement && container.parentElement.clientWidth) || 330));
  google.accounts.id.renderButton(container, { theme: 'outline', size: 'large', width, text: 'signin_with', shape: 'rectangular' });
}

(function waitForGoogle(attempt = 0) {
  if (window.google && google.accounts && google.accounts.id) return initGoogleSignIn();
  if (attempt > 100) { // ~10 s: script blocked (ad blocker, offline)
    const c = document.getElementById('googleButtonContainer');
    if (c) c.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">Google sign-in is unavailable (script blocked or offline).</span>';
    return;
  }
  setTimeout(() => waitForGoogle(attempt + 1), 100);
})();

const aiFabBtn = document.getElementById('aiFabBtn');
const aiWidgetPanel = document.getElementById('aiWidgetPanel');
const aiCloseBtn = document.getElementById('aiCloseBtn');
const aiInput = document.getElementById('aiInput');
const aiSendBtn = document.getElementById('aiSendBtn');
const chatWindow = document.getElementById('aiChatWindow');

if (aiFabBtn && aiWidgetPanel && aiCloseBtn) {
  aiFabBtn.addEventListener('click', () => {
    aiWidgetPanel.style.display = aiWidgetPanel.style.display === 'flex' ? 'none' : 'flex';
    if (aiWidgetPanel.style.display === 'flex') aiInput.focus();
  });
  aiCloseBtn.addEventListener('click', () => {
    aiWidgetPanel.style.display = 'none';
  });
  if (aiSendBtn) {
    aiSendBtn.addEventListener('click', handleUserMsg);
  }
  if (aiInput) {
    aiInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleUserMsg();
    });
  }
}

async function doLogin() {
  const username = document.getElementById('inUser').value.trim();
  const password = document.getElementById('inPass').value;
  showLoginError('');

  if (!username || !password) return showLoginError('Please enter your username and password.');

  const loginBtn = document.getElementById('btnLogin');
  const originalText = loginBtn.textContent;
  loginBtn.textContent = 'Signing in...';
  loginBtn.disabled = true;

  try {
    const { res, data } = await postJson('/auth/login', { username, password });
    if (!res.ok) return showLoginError(data.error || 'Invalid username or password.');
    const remember = document.getElementById('rememberMe');
    document.getElementById('inPass').value = '';
    enterApp(data, { remember: remember ? remember.checked : true, action: 'login' });
  } catch (err) {
    console.error('Login request failed:', err);
    showLoginError(networkErrorMessage(err));
  } finally {
    loginBtn.textContent = originalText;
    loginBtn.disabled = false;
  }
}

// ─── REGISTRATION ───────────────────────────────────────
async function doRegister() {
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const username = document.getElementById('regUsername').value.trim();
  const password = document.getElementById('regPassword').value;
  const region = document.getElementById('regRegion').value;
  const errEl = document.getElementById('registerError');
  const btn = document.getElementById('btnRegister');
  const fail = msg => { errEl.className = 'register-error show'; errEl.style.display = 'block'; errEl.textContent = msg; };
  errEl.className = 'register-error';
  errEl.style.display = 'none';

  if (!name || !email || !username || !password) return fail('All fields are required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Please enter a valid email address.');
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) return fail('Username must be 3-32 letters, numbers, dots, dashes or underscores.');
  if (password.length < 8) return fail('Password must be at least 8 characters.');

  btn.disabled = true;
  try {
    const { res, data } = await postJson('/auth/register', { name, email, username, password, region });
    if (!res.ok) return fail(data.error || 'Registration failed. Please try again.');
    document.getElementById('registerModal').classList.remove('show');
    ['regName', 'regEmail', 'regUsername', 'regPassword'].forEach(id => { document.getElementById(id).value = ''; });
    enterApp(data, { remember: true, action: 'register' });
  } catch (err) {
    console.error('Registration failed:', err);
    fail(networkErrorMessage(err));
  } finally {
    btn.disabled = false;
  }
}
window.doRegister = doRegister;

// ─── NAV & THEME ───
const themeToggleBtn = document.getElementById('themeToggle');
let isDarkMode = true; // Default is dark (no data-theme attribute)
if(themeToggleBtn) {
  // Check initial state
  const initialTheme = document.documentElement.getAttribute('data-theme');
  if (initialTheme === 'light') {
    isDarkMode = false;
    themeToggleBtn.textContent = '☀️';
  } else {
    isDarkMode = true;
    themeToggleBtn.textContent = '🌙';
  }
  themeToggleBtn.addEventListener('click', () => {
    if (isDarkMode) {
      // Switch to LIGHT mode
      document.documentElement.setAttribute('data-theme', 'light');
      themeToggleBtn.textContent = '☀️';
      isDarkMode = false;
    } else {
      // Switch to DARK mode
      document.documentElement.removeAttribute('data-theme');
      themeToggleBtn.textContent = '🌙';
      isDarkMode = true;
    }
  });
}

const titleMap = {
  'dashboard':'Dashboard', 'world-map':'World Map — Digital Twin', 'precision-farming':'Precision Farming',
  'crop-monitoring':'Crop Monitoring', 'soil-analysis':'Soil Analysis', 'water-resources':'Water Resources',
  'drought-monitor':'Drought Monitor', 'food-security':'Food Security Index', 'early-warning':'Early Warning',
  'reports':'Reports & Analytics', 'settings':'Settings'
};
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
    link.classList.add('active');
    const pg = link.dataset.page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const el = document.getElementById('pg-' + pg);
    if (el) el.classList.add('active');
    
    if (pg === 'dashboard') {
       if (document.getElementById('pgHeaders')) document.getElementById('pgHeaders').style.display = 'none';
       if (document.getElementById('continentSelector')) document.getElementById('continentSelector').style.display = 'flex';
    } else {
       if (document.getElementById('pgHeaders')) document.getElementById('pgHeaders').style.display = 'block';
       if (document.getElementById('continentSelector')) document.getElementById('continentSelector').style.display = 'none';
    }

    document.getElementById('pgTitle').textContent = titleMap[pg] || pg;
    document.getElementById('pgCrumb').textContent = 'WAFEO / ' + (titleMap[pg] || pg);
    if (pg === 'world-map') initMapOnce();
    if (pg === 'reports') loadReports();
    if (pg === 'settings') {
      // Show admin panel if user is admin
      if (currentUser && currentUser.role === 'admin') {
        loadAdminUsers();
      }
    }
  });
});

// Tab buttons
document.querySelectorAll('.tab-bar').forEach(bar => {
  bar.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
});

// ─── FETCH HELPER ───
async function apiFetch(path) {
  try {
    // The news endpoint aggregates ~25 feeds on a cold cache, so it gets longer.
    const res = await fetch(API + path, { headers: authHeaders(), signal: AbortSignal.timeout(path === '/news' ? 30000 : 12000) });
    if (res.status === 401) { handleExpiredSession(); return null; }
    if (!res.ok) throw new Error('Backend returned ' + res.status);
    return await res.json();
  } catch (err) {
    console.warn('Request failed for', path, err.message);
    return null;
  }
}

// ─── DASHBOARD ───
async function loadDashboard() {
  if (document.getElementById('pgHeaders')) document.getElementById('pgHeaders').style.display = 'none';
  if (document.getElementById('continentSelector')) document.getElementById('continentSelector').style.display = 'flex';
  if (window.wafeoLive) window.wafeoLive.dashboard();
}

// ─── REPORTS PAGE (loads news here) ───
async function loadReports() {
  const news = await apiFetch('/news');
  if (news) renderNewsPanel(news.articles);
}

let _cachedNews = [];

// ─── NEWS PANEL RENDERER ─────────────────────────────────────
function renderNewsPanel(articles) {
  const panel = document.getElementById('newsPanel');
  if (!panel) return;

  _cachedNews = articles || []; // Store for filtering

  if (!articles || articles.length === 0) {
    panel.innerHTML = '<div class="panel-hdr"><h3>📰 Live News</h3><span class="panel-badge">No data</span></div><div style="padding:16px;font-size:13px;color:var(--text-muted)">No news articles available right now.</div>';
    return;
  }

  const tagColors = {
    'Food Security': '#e53e3e', 'Agriculture': '#38a169', 'Water': '#3182ce',
    'Disaster': '#d69e2e', 'Global News': '#003366', 'Financials': '#4a5568',
    'Development': '#805ad5', 'Research': '#319795', 'Ag-Tech': '#2b6cb0',
    'Environment': '#276749'
  };

  const renderItems = (list) => {
    if (!list || list.length === 0) return '<div style="padding:16px;font-size:13px;color:var(--text-muted)">No matching articles found.</div>';
    return list.map(a => {
      const date = a.date?.created ? new Date(a.date.created).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'}) : 'Today';
      const source = a.source && a.source.length > 0 ? a.source[0].name : (a.sourceName || 'Global');
      const countries = a.country && a.country.length > 0 ? a.country.map(c => c.name).slice(0,3).join(', ') : 'Global';
      const tc = tagColors[a.tag] || '#3182ce';
      return `<div class="news-item" style="padding:10px 16px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:flex-start">
        <div style="flex-shrink:0;margin-top:3px"><span style="background:${tc};color:#fff;font-size:9px;padding:2px 7px;border-radius:10px;font-weight:700;white-space:nowrap">${a.tag || 'News'}</span></div>
        <div style="flex:1;min-width:0">
          <a href="${a.url || '#'}" target="_blank" rel="noopener" style="font-weight:600;color:var(--text-primary);font-size:13px;text-decoration:none;display:block;margin-bottom:3px;line-height:1.35;transition:color .2s" onmouseover="this.style.color='var(--accent-blue)'" onmouseout="this.style.color='var(--text-primary)'">${a.title}</a>
          <div style="font-size:10px;color:var(--text-muted)">📍 ${countries} &nbsp;·&nbsp; 🏢 ${source} &nbsp;·&nbsp; 📅 ${date}</div>
        </div>
      </div>`;
    }).join('');
  };

  panel.innerHTML = `
    <div class="panel-hdr" style="flex-wrap: wrap; gap: 10px;">
      <h3 style="flex-shrink: 0;">📰 Live News — Water, Agriculture &amp; Food Systems</h3>
      <div class="news-search-box">
        <input type="text" id="newsQuery" placeholder="Search keywords..." oninput="handleNewsSearch(event)">
      </div>
      <span class="panel-badge" id="newsCount" style="background:var(--accent-blue)">${articles.length} Reports</span>
    </div>
    <div class="panel-scroll-content" id="newsList">
      ${renderItems(articles)}
    </div>
  `;
}

function handleNewsSearch(e) {
  const query = e.target.value.toLowerCase();
  const filtered = _cachedNews.filter(a => {
    const title = (a.title || '').toLowerCase();
    const source = (a.sourceName || (a.source && a.source[0] ? a.source[0].name : '')).toLowerCase();
    const countries = (a.country ? a.country.map(c => c.name).join(' ') : '').toLowerCase();
    return title.includes(query) || source.includes(query) || countries.includes(query);
  });

  const listContainer = document.getElementById('newsList');
  const countBadge = document.getElementById('newsCount');

  if (listContainer) {
    // Re-render only the list items to maintain input focus
    const tagColors = {
      'Food Security': '#e53e3e', 'Agriculture': '#38a169', 'Water': '#3182ce',
      'Disaster': '#d69e2e', 'Global News': '#003366', 'Financials': '#4a5568',
      'Development': '#805ad5', 'Research': '#319795', 'Ag-Tech': '#2b6cb0',
      'Environment': '#276749'
    };
    
    listContainer.innerHTML = filtered.map(a => {
      const date = a.date?.created ? new Date(a.date.created).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'}) : 'Today';
      const source = a.source && a.source.length > 0 ? a.source[0].name : (a.sourceName || 'Global');
      const countries = a.country && a.country.length > 0 ? a.country.map(c => c.name).slice(0,3).join(', ') : 'Global';
      const tc = tagColors[a.tag] || '#3182ce';
      return `<div class="news-item" style="padding:10px 16px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:flex-start">
        <div style="flex-shrink:0;margin-top:3px"><span style="background:${tc};color:#fff;font-size:9px;padding:2px 7px;border-radius:10px;font-weight:700;white-space:nowrap">${a.tag || 'News'}</span></div>
        <div style="flex:1;min-width:0">
          <a href="${a.url || '#'}" target="_blank" rel="noopener" style="font-weight:600;color:var(--text-primary);font-size:13px;text-decoration:none;display:block;margin-bottom:3px;line-height:1.35;transition:color .2s" onmouseover="this.style.color='var(--accent-blue)'" onmouseout="this.style.color='var(--text-primary)'">${a.title}</a>
          <div style="font-size:10px;color:var(--text-muted)">📍 ${countries} &nbsp;·&nbsp; 🏢 ${source} &nbsp;·&nbsp; 📅 ${date}</div>
        </div>
      </div>`;
    }).join('') || '<div style="padding:16px;font-size:13px;color:var(--text-muted)">No matching articles found.</div>';
  }

  if (countBadge) {
    countBadge.textContent = `${filtered.length} Reports`;
  }
}



const _ts = () => new Date().toISOString().split('T')[0];







function timeAgo(ts) {
  const d = Date.now() - new Date(ts).getTime();
  if(d<3600000) return Math.floor(d/60000)+'m ago';
  if(d<86400000) return Math.floor(d/3600000)+'h ago';
  return Math.floor(d/86400000)+'d ago';
}

// ─── FIELDS ───
const cropEmoji = { Wheat:'🌾', Maize:'🌽', Rice:'🍚', Soybean:'🫘', Coffee:'☕', Groundnut:'🥜', Tobacco:'🍂', Sorghum:'🌿' };


// ─── WATER PAGE ───

// ─── FOOD SECURITY PAGE ───

// ─── MAP (LEAFLET LAYER) ───

let mapInited = false;
let map;
let tileLayer;

function initMapOnce() {
  if (mapInited) return; mapInited = true;
  
  if (typeof L === 'undefined') {
    console.error("Leaflet.js not loaded. Required for rendering Map.");
    return;
  }
  
  map = L.map('worldMap', { zoomControl: false }).setView([20, 0], 2);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  
  // Create dedicated labels pane so names always render ON TOP of country polygons
  map.createPane('labels');
  map.getPane('labels').style.zIndex = 650;
  map.getPane('labels').style.pointerEvents = 'none';

  // Google Earth Engine Style Base Layers (Maximum Resolution)
  const baseOptions = { 
    maxZoom: 22, maxNativeZoom: 21, 
    tileSize: 256, zoomOffset: 0,
    detectRetina: true,
    attribution: '&copy; Google'
  };
  const labelOptions = { ...baseOptions, pane: 'labels' };
  
  const gmapStreets = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&hl=en&x={x}&y={y}&z={z}&scale=2', { ...baseOptions, subdomains: '0123' });
  const gmapTerrain = L.tileLayer('https://mt{s}.google.com/vt/lyrs=p&hl=en&x={x}&y={y}&z={z}&scale=2', { ...baseOptions, subdomains: '0123' });
  const gmapSat = L.tileLayer('https://mt{s}.google.com/vt/lyrs=s&hl=en&x={x}&y={y}&z={z}&scale=2', { ...baseOptions, subdomains: '0123' });
  // Transparent labels & roads overlay
  const gmapLabelsOverlay = L.tileLayer('https://mt{s}.google.com/vt/lyrs=h&hl=en&x={x}&y={y}&z={z}&scale=2', { ...labelOptions, subdomains: '0123' });

  // NASA GIBS MODIS True Color (Using T-2 days for confirmed global tile availability)
  const safeDate = new Date(Date.now() - 86400000*2).toISOString().split('T')[0];
  window.nasaGibsLayer = L.tileLayer(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${safeDate}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`, {
    ...baseOptions,
    maxNativeZoom: 9,
    attribution: '&copy; NASA EOSDIS GIBS'
  });

  let currentBase = gmapStreets;
  let currentLabels = gmapLabelsOverlay;
  currentBase.addTo(map);
  // Do NOT add labels overlay in initial Map/Streets mode — labels are already baked into the base tile
  // Only add labels overlay in Satellite mode (handled by updateGoogleLayer)

  function updateGoogleLayer() {
    if(map.hasLayer(currentBase)) map.removeLayer(currentBase);
    if(map.hasLayer(currentLabels)) map.removeLayer(currentLabels);
    
    const isMap = document.getElementById('gbtn-map').classList.contains('active');
    const terrain = document.getElementById('gchk-terrain').checked;
    const labels = document.getElementById('gchk-labels').checked;
    
    if (isMap) {
      currentBase = terrain ? gmapTerrain : gmapStreets;
    } else {
      currentBase = gmapSat;
    }
    
    currentBase.addTo(map);
    
    // In Satellite mode, add labels overlay perfectly.
    // In Map mode, DO NOT add labels overlay, because the base maps already contain labels. Adding it twice causes ugly bold shadows!
    if (!isMap && labels) {
      currentLabels.addTo(map);
    }
    
    if (window.geoLayerRef) { window.geoLayerRef.bringToFront(); }
  }

  // Bind UI Controls
  document.getElementById('gbtn-map-click').addEventListener('click', () => {
    document.getElementById('gbtn-map').classList.add('active');
    document.getElementById('gbtn-sat').classList.remove('active');
    updateGoogleLayer();
  });
  document.getElementById('gbtn-sat-click').addEventListener('click', () => {
    document.getElementById('gbtn-sat').classList.add('active');
    document.getElementById('gbtn-map').classList.remove('active');
    updateGoogleLayer();
  });
  document.getElementById('gchk-terrain').addEventListener('change', updateGoogleLayer);
  document.getElementById('gchk-labels').addEventListener('change', updateGoogleLayer);

  // Live hazard markers and click-to-analyse are added by pages.js.
  if (window.wafeoLive) window.wafeoLive.attachDashboardMap(map);
}




// ─── TOOLTIP ───
function showTip(e, text) { const t=document.getElementById('ttp'); t.textContent=text; t.style.left=(e.clientX+14)+'px'; t.style.top=(e.clientY-12)+'px'; t.classList.add('on'); }
function hideTip() { document.getElementById('ttp').classList.remove('on'); }

// ─── GLOBAL SEARCH ───
const globalSearch = document.getElementById('globalSearch');
if (globalSearch) {
  globalSearch.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      const query = globalSearch.value.trim();
      if (query) {
        document.querySelector('[data-page="site-intelligence"]').click();
        setTimeout(() => {
          document.getElementById('siSearchInput').value = query;
          analyzeRegion(query);
          globalSearch.value = '';
        }, 300);
      }
    }
  });
}

// ─── AI ASSISTANT LOGIC ───
// The API key is NOT stored in the browser. Requests go to the secure
// backend proxy (POST /api/ai/chat), which holds GROQ_API_KEY server-side.
let chatHistory = [
  { role: "system", content: "You are the WAFEO Digital Twin AI Assistant. You help users understand Earth Observation data, NDVI scores, agriculture, water resources, and food security warnings in Africa. Be concise, professional, and intelligent. Format clearly." }
];









async function handleUserMsg() {
  const text = aiInput.value.trim();
  if(!text) return;
  
  aiInput.value = '';
  appendChatMsg('user', '👤', text);
  chatHistory.push({ role: "user", content: text });
  
  const typingId = 'typing-' + Date.now();
  appendChatMsg('bot', '🤖', '<em>Thinking...</em>', typingId);

  try {
    const response = await fetch(API + '/ai/chat', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ messages: chatHistory.slice(-20) })
    });

    const data = await response.json().catch(() => ({}));
    const botResponse = data.reply || (response.ok ? 'No response generated.' : (data.error || 'The AI service is unavailable right now.'));

    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();

    // Parse basic markdown bolding & newlines
    let htmlResponse = botResponse.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    appendChatMsg('bot', '🤖', htmlResponse, null, true);
    if (response.ok) chatHistory.push({ role: "assistant", content: botResponse });

  } catch (err) {
    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();
    appendChatMsg('bot', '🤖', 'Sorry, I could not reach WAFEO Intelligence. Please try again.');
    console.error(err);
  }
}

function appendChatMsg(type, avatar, text, id = null, isHtml = false) {
  const div = document.createElement('div');
  div.className = `chat-msg ${type}`;
  if(id) div.id = id;
  if(id && id.startsWith('typing')) div.classList.add('typing');
  
  const content = isHtml ? text : text.replace(/\n/g, '<br>');
  div.innerHTML = `
    <div class="cm-avatar">${avatar}</div>
    <div class="cm-bubble">${content}</div>
  `;
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

window.flyToContinent = function(continentName) {
  if (!map) return;
  // Mark the active icon visually
  document.querySelectorAll('.cont-box').forEach(box => {
    box.classList.remove('active');
    const lbl = box.querySelector('.cont-lbl');
    if (lbl && lbl.textContent.trim().toUpperCase() === continentName.toUpperCase()) {
      box.classList.add('active');
    }
  });

  // Calculate zoom bounds [SouthWest, NorthEast]
  const bounds = {
    'Asia': [[-10, 35], [75, 145]],
    'Africa': [[-35, -20], [37, 51]],
    'NorthAmerica': [[10, -170], [72, -50]],
    'SouthAmerica': [[-56, -82], [13, -34]],
    'Antarctica': [[-90, -180], [-60, 180]],
    'Europe': [[35, -10], [70, 40]],
    'Oceania': [[-47, 110], [5, 180]]
  };

  const b = bounds[continentName];
  if (b) {
    try {
      // smooth fly animation
      map.flyToBounds(b, { padding: [20, 20], duration: 1.5 });
    } catch(e) {
      console.error("Map flyTo error:", e);
    }
  }
};

// ─── NOTIFICATION BELL HANDLER ───


window.toggleNasaGibs = function() {
  if (!map || !window.nasaGibsLayer) return;
  const chk = document.getElementById('sat-nasa');
  if (chk && chk.checked) {
    window.nasaGibsLayer.addTo(map);
    window.nasaGibsLayer.bringToFront();
    if (window.geoLayerRef) window.geoLayerRef.bringToFront();
  } else {
    map.removeLayer(window.nasaGibsLayer);
  }
};

// ─── ADMIN: Load User Profiles ───────────────────────────
async function loadAdminUsers() {
  const panel = document.getElementById('adminUsersPanel');
  const list = document.getElementById('userProfilesList');
  const badge = document.getElementById('userCountBadge');
  if (!panel || !list) return;

  try {
    const res = await fetch(API + '/admin/users', { headers: authHeaders() });
    if (!res.ok) {
      panel.style.display = 'block';
      list.innerHTML = '<div style="padding:12px;font-size:13px;color:var(--text-muted)">Unable to load user data. Admin access required.</div>';
      return;
    }
    const data = await res.json();
    const users = (data.users || []).slice().sort((a, b) => String(b.registeredAt || '').localeCompare(String(a.registeredAt || '')));

    panel.style.display = 'block';
    if (badge) badge.textContent = `${users.length} Users`;

    if (users.length === 0) {
      list.innerHTML = '<div style="padding:12px;font-size:13px;color:var(--text-muted)">No registered users yet.</div>';
      return;
    }

    list.innerHTML = users.map(u => {
      const initials = (u.name || 'U').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
      const roleBg = { admin: 'admin', farmer: 'farmer', policy: 'policy', researcher: 'researcher' };
      const roleClass = roleBg[u.role] || 'researcher';
      const registeredAt = u.registeredAt ? new Date(u.registeredAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Pre-registered';
      return `<div class="user-profile-card">
        <div class="upc-avatar">${escapeHtml(initials)}</div>
        <div class="upc-info">
          <div class="upc-name">${escapeHtml(u.name || u.username)}</div>
          <div class="upc-email">${escapeHtml(u.email || 'No email')}${u.authProvider === 'google' ? ' · Google' : ''}</div>
          <div class="upc-meta">
            <span>📍 ${escapeHtml(u.region || 'Global')}</span>
            <span>📅 ${registeredAt}</span>
            <span>🕒 ${u.lastLoginAt ? 'Last sign-in ' + new Date(u.lastLoginAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Never signed in'}</span>
          </div>
        </div>
        ${String(u.id) === String(currentUser && currentUser.id)
          ? `<span class="upc-badge ${roleClass}">${escapeHtml((u.role || 'user').toUpperCase())}</span>`
          : `<select class="emhare-select upc-role" style="width:auto;font-size:12px;padding:4px 8px" onchange="changeUserRole('${escapeHtml(u.id)}', this)" aria-label="Role for ${escapeHtml(u.name || u.username)}">
              ${['researcher', 'farmer', 'policy', 'admin'].map(r => `<option value="${r}"${u.role === r ? ' selected' : ''}>${ROLE_LABELS[r]}</option>`).join('')}
            </select>`}
      </div>`;
    }).join('');
  } catch (err) {
    console.warn('Failed to load admin users:', err.message);
    panel.style.display = 'block';
    list.innerHTML = '<div style="padding:12px;font-size:13px;color:var(--text-muted)">Server unavailable — user profiles cannot be loaded.</div>';
  }
}

async function changeUserRole(id, select) {
  select.disabled = true;
  try {
    const { res, data } = await postJson('/admin/users/' + encodeURIComponent(id) + '/role', { role: select.value });
    if (!res.ok) { alert(data.error || 'Could not change role.'); loadAdminUsers(); }
  } catch (err) {
    alert(networkErrorMessage(err));
    loadAdminUsers();
  } finally {
    select.disabled = false;
  }
}
window.changeUserRole = changeUserRole;

// ─── SITE INTELLIGENCE PAGE LOGIC ───
let siMap = null;
let siMarker = null;

const siSvgs = {
  farming: `<svg class="si-icon" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path></svg>`,
  water: `<svg class="si-icon" viewBox="0 0 24 24"><path d="M12 2.69l5.66 5.66a8 8 0 11-11.31 0z"></path></svg>`,
  agriculture: `<svg class="si-icon" viewBox="0 0 24 24"><path d="M11 20A7 7 0 014 13V4a9 9 0 0115 5 7 7 0 01-8 11z"></path></svg>`,
  climate: `<svg class="si-icon" viewBox="0 0 24 24"><path d="M14 14.76V3.5a2.5 2.5 0 00-5 0v11.26a4.5 4.5 0 105 0z"></path></svg>`,
  foodSec: `<svg class="si-icon" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>`
};

const siSearchBtn = document.getElementById('siSearchBtn');
const siSearchInput = document.getElementById('siSearchInput');

if (siSearchBtn && siSearchInput) {
  const triggerSISearch = () => {
    const query = siSearchInput.value.trim();
    if (query) analyzeRegion(query);
  };
  siSearchBtn.addEventListener('click', triggerSISearch);
  siSearchInput.addEventListener('keypress', e => { if (e.key === 'Enter') triggerSISearch(); });
}

// Tab Switching
document.querySelectorAll('.si-tab-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.si-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.si-tab-content').forEach(c => c.style.display = 'none');
    
    e.target.classList.add('active');
    document.getElementById('siTab-' + e.target.dataset.tab).style.display = 'block';
  });
});

// 2D/3D Map Logic
const siBtn2D = document.getElementById('siBtn2D');
const siBtn3D = document.getElementById('siBtn3D');
const siMapPanel = document.querySelector('.si-map-panel');

if (siBtn2D && siBtn3D) {
  siBtn2D.addEventListener('click', () => {
    siBtn2D.classList.add('active'); siBtn3D.classList.remove('active');
    siMapPanel.classList.remove('mode-3d');
  });
  siBtn3D.addEventListener('click', () => {
    siBtn3D.classList.add('active'); siBtn2D.classList.remove('active');
    siMapPanel.classList.add('mode-3d');
  });
}

// Map Initialization
function initSiGlobalMap() {
  const container = document.getElementById('siMapInstance');
  if(!container) return;
  
  if (!siMap) {
    siMap = L.map('siMapInstance', { zoomControl: false }).setView([15, 10], 2); // Global View
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri'
    }).addTo(siMap);
    
    // Map Click Interactivity
    siMap.on('click', async (e) => {
      const lat = e.latlng.lat;
      const lon = e.latlng.lng;
      analyzeRegion({ lat, lon });
    });
  }
}

// Re-init map when tab is clicked to fix Leaflet size rendering bugs
document.querySelector('[data-page="site-intelligence"]').addEventListener('click', () => {
  setTimeout(() => {
    initSiGlobalMap();
    if(siMap) siMap.invalidateSize();
  }, 100);
});

// Site analysis runs on live satellite, soil and weather data (see eo.js).
function analyzeRegion(query) {
  // Chivaraidze Agro-Industrial Park is not in OpenStreetMap: use its location.
  if (typeof query === 'string' && /chivaraidze/i.test(query)) query = { lat: -17.8, lon: 31.3, run: true };
  if (!window.wafeoSite) return;
  if (query && query.run) { window.wafeoSite.analyze(query).then(() => window.wafeoSite.run()); return; }
  window.wafeoSite.analyze(query);
}

function toggleTheme() {
  document.documentElement.classList.toggle('dark-theme');
  const btn = document.getElementById('themeToggle');
  if (document.documentElement.classList.contains('dark-theme')) {
    btn.textContent = '☀️';
  } else {
    btn.textContent = '🌙';
  }
}



// ─── WAFEO REPORT GENERATOR LOGIC ───────────────────────────────────────
const btnGenerateReport = document.getElementById('btnGenerateReport');
const wafeoReportModal = document.getElementById('wafeoReportModal');
const btnCloseReport = document.getElementById('btnCloseReport');

// Slider Elements
const ssRange = document.getElementById('ssRange');
const ssWrapper = document.getElementById('ssWrapper');
const ssHandle = document.getElementById('ssHandle');
const ssImgBefore = document.getElementById('ss-img-before');
const ssImgAfter = document.getElementById('ss-img-after');
const ssLabelLeft = document.querySelector('.ss-label-left');
const ssLabelRight = document.querySelector('.ss-label-right');

// Mode Data
const reportModes = {
  ndvi: {
    before: 'https://images.unsplash.com/photo-1594498653385-d5172c532c00?auto=format&fit=crop&w=800&q=80',
    after: 'https://images.unsplash.com/photo-1589419161642-cb33cd9f5a01?auto=format&fit=crop&w=800&q=80',
    label1: 'Pre-Season NDVI',
    label2: 'Current NDVI',
    dev: '-12.4%', devClass: 'negative',
    risk: 'Elevated', riskClass: 'warning',
    conf: 'High (94%)', confClass: 'positive'
  },
  temp: {
    before: 'https://images.unsplash.com/photo-1464617530960-93ed96fc9dfb?auto=format&fit=crop&w=800&q=80',
    after: 'https://images.unsplash.com/photo-1541845157-a6d2d100c931?auto=format&fit=crop&w=800&q=80',
    label1: 'Historical Avg',
    label2: 'Current Heatmap',
    dev: '+2.8°C', devClass: 'negative',
    risk: 'Severe', riskClass: 'negative',
    conf: 'High (91%)', confClass: 'positive'
  },
  water: {
    before: 'https://images.unsplash.com/photo-1433086966358-54859d0ed716?auto=format&fit=crop&w=800&q=80',
    after: 'https://images.unsplash.com/photo-1533556094269-e70a6c6a26d2?auto=format&fit=crop&w=800&q=80',
    label1: 'Previous Year',
    label2: 'Current Level',
    dev: '-4.1m', devClass: 'warning',
    risk: 'Moderate', riskClass: 'warning',
    conf: 'Med (82%)', confClass: 'warning'
  }
};

// Open Modal
if (btnGenerateReport) {
  btnGenerateReport.addEventListener('click', () => generateWafeoReport());
}

// Close Modal
if (btnCloseReport) {
  btnCloseReport.addEventListener('click', () => {
    wafeoReportModal.style.display = 'none';
  });
}

// Slider Drag Logic
if (ssRange) {
  ssRange.addEventListener('input', (e) => {
    const val = e.target.value;
    ssWrapper.style.width = `${val}%`;
    ssHandle.style.left = `${val}%`;
  });
}

// Handle Window Resize for Slider Background Image Match
window.addEventListener('resize', () => {
  if (wafeoReportModal && wafeoReportModal.style.display === 'flex') {
    const containerWidth = document.querySelector('.split-slider-container').offsetWidth;
    ssImgAfter.style.width = `${containerWidth}px`;
    ssImgAfter.style.maxWidth = `${containerWidth}px`;
  }
});

// Mode Toggle Logic
window.setSliderMode = function(mode) {
  // Update UI Tabs
  document.querySelectorAll('.rt-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelector(`.rt-btn[data-mode="${mode}"]`).classList.add('active');
  
  // Update Images & Labels
  const data = reportModes[mode];
  ssImgBefore.src = data.before;
  ssImgAfter.src = data.after;
  ssLabelLeft.textContent = data.label1;
  ssLabelRight.textContent = data.label2;
  
  // Fix overlay width
  const containerWidth = document.querySelector('.split-slider-container').offsetWidth;
  ssImgAfter.style.width = `${containerWidth}px`;
  ssImgAfter.style.maxWidth = `${containerWidth}px`;

  // Update Data Grid
  const rdVals = document.querySelectorAll('.rd-val');
  if (rdVals.length === 3) {
    rdVals[0].className = `rd-val ${data.devClass}`; rdVals[0].textContent = data.dev;
    rdVals[1].className = `rd-val ${data.riskClass}`; rdVals[1].textContent = data.risk;
    rdVals[2].className = `rd-val ${data.confClass}`; rdVals[2].textContent = data.conf;
  }
};

// Bind clicks for tabs
document.querySelectorAll('.rt-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    setSliderMode(e.target.getAttribute('data-mode'));
  });
});
// ────────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
//  NDVI TIME-SERIES + LSTM FORECAST + REAL-TIME COMPARISON
// ════════════════════════════════════════════════════════════════════════════
const WAFEO_FC = (function () {
  let chart = null;
  let initialized = false;
  let lastResult = null;

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];



  function trendForecast(series, steps) {
    const n = series.length;
    const recent = series.slice(-6);
    const slope = (recent[recent.length - 1] - recent[0]) / (recent.length - 1 || 1);
    const last = series[n - 1];
    const out = [];
    for (let s = 1; s <= steps; s++) {
      const seasonal = (n - 12 + s >= 0 && series[n - 12 + s] != null)
        ? (series[n - 12 + s] - series[n - 12]) * 0.3 : 0;
      out.push(+Math.max(0.05, Math.min(0.95, last + slope * s * 0.6 + seasonal)).toFixed(3));
    }
    return out;
  }

  async function lstmForecast(series, steps) {
    if (typeof tf === 'undefined') return { values: trendForecast(series, steps), method: 'Statistical trend (LSTM unavailable)' };
    try {
      const min = Math.min(...series), max = Math.max(...series), range = (max - min) || 1;
      const norm = series.map(v => (v - min) / range);
      const look = 6, xs = [], ys = [];
      for (let i = 0; i + look < norm.length; i++) { xs.push(norm.slice(i, i + look).map(v => [v])); ys.push([norm[i + look]]); }
      if (xs.length < 4) return { values: trendForecast(series, steps), method: 'Statistical trend (insufficient data)' };

      const xT = tf.tensor3d(xs), yT = tf.tensor2d(ys);
      const model = tf.sequential();
      model.add(tf.layers.lstm({ units: 16, inputShape: [look, 1] }));
      model.add(tf.layers.dense({ units: 1 }));
      model.compile({ optimizer: tf.train.adam(0.05), loss: 'meanSquaredError' });
      await model.fit(xT, yT, { epochs: 80, batchSize: 8, verbose: 0 });

      let window = norm.slice(-look); const out = [];
      for (let s = 0; s < steps; s++) {
        const inp = tf.tensor3d([window.map(v => [v])]);
        const p = model.predict(inp); const val = (await p.data())[0];
        inp.dispose(); p.dispose();
        out.push(val); window = window.slice(1).concat(val);
      }
      xT.dispose(); yT.dispose(); model.dispose();
      const denorm = out.map(v => +(Math.max(0, Math.min(1, v)) * range + min).toFixed(3));
      return { values: denorm, method: 'LSTM neural network (TensorFlow.js)' };
    } catch (e) {
      console.error('[forecast] LSTM failed, using fallback:', e);
      return { values: trendForecast(series, steps), method: 'Statistical trend (LSTM error)' };
    }
  }

  function futureLabels(steps) {
    const now = new Date(); const out = [];
    for (let s = 1; s <= steps; s++) { const d = new Date(now.getFullYear(), now.getMonth() + s, 1); out.push(MONTHS[d.getMonth()] + " '" + String(d.getFullYear()).slice(2)); }
    return out;
  }

  function render(hist, fc) {
    const canvas = document.getElementById('ndviForecastChart');
    if (!canvas || typeof Chart === 'undefined') return;
    const steps = fc.values.length;
    const labels = hist.labels.concat(futureLabels(steps));
    const histData = hist.values.concat(new Array(steps).fill(null));
    const fcData = new Array(hist.values.length - 1).fill(null)
      .concat([hist.values[hist.values.length - 1]]).concat(fc.values);

    if (chart) chart.destroy();
    chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'NDVI (observed)', data: histData, borderColor: '#0b8043', backgroundColor: 'rgba(16,185,129,0.12)', fill: true, tension: 0.35, pointRadius: 2, borderWidth: 2 },
          { label: 'LSTM forecast', data: fcData, borderColor: '#003366', borderDash: [6, 4], fill: false, tension: 0.35, pointRadius: 3, borderWidth: 2 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        scales: { y: { min: 0, max: 1, title: { display: true, text: 'NDVI' } }, x: { ticks: { maxRotation: 60, minRotation: 45, font: { size: 9 } } } },
        plugins: { legend: { position: 'top', labels: { boxWidth: 14, font: { size: 11 } } } }
      }
    });
  }

  function renderComparison(hist, fc, method) {
    const el = document.getElementById('fcComparison'); if (!el) return;
    const v = hist.values;
    const cur = v.slice(-12), prev = v.slice(-24, -12);
    const avg = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
    const curAvg = avg(cur), prevAvg = avg(prev.length ? prev : cur);
    const yoy = ((curAvg - prevAvg) / (prevAvg || 1)) * 100;
    const fcAvg = avg(fc.values);
    const fcChange = ((fcAvg - curAvg) / (curAvg || 1)) * 100;
    const peakIdx = v.indexOf(Math.max(...v));
    const cls = n => n > 0.5 ? 'fc-up' : (n < -0.5 ? 'fc-down' : 'fc-neutral');
    const arrow = n => n > 0.5 ? '▲' : (n < -0.5 ? '▼' : '–');
    el.innerHTML = [
      ['Current 12-mo avg', curAvg.toFixed(3), 'fc-neutral', ''],
      ['Year-over-year', (yoy >= 0 ? '+' : '') + yoy.toFixed(1) + '%', cls(yoy), arrow(yoy)],
      ['Forecast (next 6-mo)', fcAvg.toFixed(3), 'fc-neutral', ''],
      ['Forecast trend', (fcChange >= 0 ? '+' : '') + fcChange.toFixed(1) + '%', cls(fcChange), arrow(fcChange)],
      ['Peak season', hist.labels[peakIdx], 'fc-neutral', '']
    ].map(c => `<div class="fc-card"><div class="fc-label">${c[0]}</div><div class="fc-value ${c[2]}">${c[3]} ${c[1]}</div></div>`).join('');
    lastResult = { region: document.getElementById('fcRegion').value, curAvg, prevAvg, yoy, fcAvg, fcChange, peak: hist.labels[peakIdx], method, forecast: fc.values };
  }

  // Real Sentinel-2 monthly NDVI for the analysed site; cloudy months are
  // filled by linear interpolation between neighbouring months.
  function seriesToHist(series) {
    const labels = series.map(s => { const [y, m] = s.month.split('-'); return MONTHS[Number(m) - 1] + " '" + y.slice(2); });
    const raw = series.map(s => (Number.isFinite(s.ndvi) ? s.ndvi : null));
    const known = raw.map((v, i) => [i, v]).filter(([, v]) => v !== null);
    if (known.length < 6) throw new Error('Too few clear months of imagery for this site.');
    const values = raw.map((v, i) => {
      if (v !== null) return v;
      const before = [...known].reverse().find(([j]) => j < i), after = known.find(([j]) => j > i);
      if (!before) return after[1];
      if (!after) return before[1];
      return +(before[1] + (after[1] - before[1]) * ((i - before[0]) / (after[0] - before[0]))).toFixed(3);
    });
    return { labels, values, clearMonths: known.length };
  }

  // Offer the analysed site as the first, default choice.
  function syncSiteOption() {
    const sel = document.getElementById('fcRegion');
    const name = window.wafeoSite && window.wafeoSite.siteName();
    if (!sel || !name) return false;
    let opt = sel.querySelector('option[value="__site"]');
    const fresh = !opt;
    if (!opt) { opt = document.createElement('option'); opt.value = '__site'; sel.insertBefore(opt, sel.firstChild); }
    opt.textContent = `📡 ${name} (live Sentinel-2)`;
    if (fresh) sel.value = '__site';
    return true;
  }

  async function run() {
    const sel = document.getElementById('fcRegion');
    const region = (sel || {}).value || 'Sahel';
    const btn = document.getElementById('btnRunForecast');
    const status = document.getElementById('fcStatus');
    const badge = document.getElementById('fcBadge');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Training LSTM…'; }
    let hist, note, live = false;
    try {
      if (region === '__site' && window.wafeoSite && window.wafeoSite.last()) {
        if (status) status.textContent = 'Loading 24 months of Sentinel-2 NDVI for the selected site…';
        const s = await window.wafeoSite.ndviSeries();
        hist = seriesToHist(s.series);
        live = true;
        note = `Sentinel-2 monthly NDVI · ${hist.clearMonths} of 24 months had clear imagery`;
      } else {
        if (status) status.textContent = 'Analyse a farm or region first (any page’s search box or the Dashboard map). The forecast uses its real Sentinel-2 history.';
        if (btn) { btn.disabled = false; btn.textContent = '▶ Run LSTM Forecast'; }
        return lastResult;
      }
    } catch (e) {
      if (status) status.textContent = e.message;
      if (btn) { btn.disabled = false; btn.textContent = '▶ Run LSTM Forecast'; }
      return lastResult;
    }
    if (status) status.textContent = 'Training neural network on 24 months of NDVI…';
    render(hist, { values: [] });            // show history immediately
    const fc = await lstmForecast(hist.values, 6);
    render(hist, fc);
    renderComparison(hist, fc, fc.method);
    lastResult.live = live;
    lastResult.source = note;
    if (live) lastResult.region = window.wafeoSite.siteName();
    if (badge) {
      badge.textContent = live ? (fc.method.startsWith('LSTM') ? 'Sentinel-2 · LSTM' : 'Sentinel-2 · trend') : 'Illustrative';
      badge.style.background = live ? 'var(--accent-emerald)' : '#9ca3af';
    }
    if (status) status.textContent = `Model: ${fc.method} · ${note}`;
    if (btn) { btn.disabled = false; btn.textContent = '▶ Run LSTM Forecast'; }
    return lastResult;
  }

  // Used by the report: forecast the analysed site when there is one.
  async function runForReport() {
    ensureInit();
    if (syncSiteOption()) {
      const sel = document.getElementById('fcRegion');
      sel.value = '__site';
      if (!(lastResult && lastResult.live && lastResult.region === window.wafeoSite.siteName())) return run();
    }
    return lastResult || run();
  }

  function ensureInit() {
    if (initialized) return;
    const panel = document.getElementById('forecastPanel'); if (!panel) return;
    initialized = true;
    syncSiteOption();
    const btn = document.getElementById('btnRunForecast');
    const sel = document.getElementById('fcRegion');
    if (btn) btn.addEventListener('click', run);
    if (sel) sel.addEventListener('change', run);
    setTimeout(run, 200); // auto-run on first view
  }

  document.addEventListener('wafeo:analysis', () => { if (initialized && syncSiteOption()) { document.getElementById('fcRegion').value = '__site'; run(); } });

  return { ensureInit, run, runForReport, getLast: () => lastResult };
})();

// Initialise the forecast panel when the Reports page is opened.
document.querySelectorAll('[data-page="reports"]').forEach(link => {
  link.addEventListener('click', () => setTimeout(() => WAFEO_FC.ensureInit(), 150));
});

// ════════════════════════════════════════════════════════════════════════════
//  COMPREHENSIVE / PORTFOLIO REPORT  (AI narrative + NDVI/LSTM + Firestore)
// ════════════════════════════════════════════════════════════════════════════
function templateSummary(region, m) {
  const dir = (m.fcChange || 0) >= 0 ? 'improving' : 'declining';
  return `Vegetation conditions across ${region} show a current 12-month average NDVI of ${m.curAvg != null ? m.curAvg.toFixed(3) : 'n/a'}, with a year-over-year change of ${m.yoy != null ? m.yoy.toFixed(1) + '%' : 'n/a'}. The LSTM forecast projects an average NDVI of ${m.fcAvg != null ? m.fcAvg.toFixed(3) : 'n/a'} over the next six months (${dir} trend). Peak vegetation typically occurs around ${m.peak || 'the main rainy season'}. Continued monitoring of water resources and food-security indicators is recommended, particularly where the trend is declining.`;
}

// Written summary used when the AI assistant is unavailable.
function siteOrTemplateSummary(site, region, m) {
  if (!site) return templateSummary(region, m);
  const d = site.domains, name = window.wafeoSite.siteName();
  const parts = [`${site.overall.riskLevel} risk for ${name} (${site.aoi.areaHa.toLocaleString()} ha). ${site.overall.headline}`];
  for (const k of ['crop', 'waterQuantity', 'waterQuality', 'soil']) if (d[k] && d[k].summary) parts.push(d[k].summary);
  const r = site.recommendations;
  parts.push(`Priority for farmers: ${r.farmers[0].action} Priority for government: ${r.government[0].action} Priority for the public: ${r.public[0].action}`);
  return parts.join('\n\n');
}

async function generateWafeoReport() {
  const modal = document.getElementById('wafeoReportModal');
  const body = document.getElementById('reportBody');
  const meta = document.getElementById('reportMeta');
  const btn = document.getElementById('btnGenerateReport');
  if (!modal || !body) return;
  if (btn) { btn.style.opacity = '0.7'; btn.disabled = true; }

  // Forecast the analysed site from real Sentinel-2 NDVI when there is one.
  let fc = await WAFEO_FC.runForReport().catch(() => WAFEO_FC.getLast());
  const m = fc || {};
  const region = m.region || 'Global';
  const now = new Date();
  const who = (typeof currentUser !== 'undefined' && currentUser && (currentUser.name || currentUser.username)) || 'WAFEO user';
  const siteNow = window.wafeoSite && window.wafeoSite.last();
  const siteName = siteNow && siteNow.data.place ? [siteNow.data.place.name, siteNow.data.place.country].filter(Boolean).join(', ') : null;
  if (meta) meta.innerHTML = `${siteName ? `Site: <strong>${escapeHtml(siteName)}</strong> &middot; ` : ''}Region: <strong>${region}</strong> &middot; Generated: ${now.toLocaleString()} &middot; By: ${escapeHtml(who)}`;

  const fmtPct = n => (n >= 0 ? '+' : '') + (n != null ? n.toFixed(1) : '0.0') + '%';
  const metricsHtml = `
    <h4>NDVI Trend &amp; 6-Month Forecast — ${escapeHtml(region)}${m.live ? '' : ' (illustrative)'}</h4>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:8px 0 16px;">
      <div class="fc-card"><div class="fc-label">Current NDVI (12-mo)</div><div class="fc-value fc-neutral">${m.curAvg != null ? m.curAvg.toFixed(3) : '—'}</div></div>
      <div class="fc-card"><div class="fc-label">Year-over-year</div><div class="fc-value ${m.yoy >= 0 ? 'fc-up' : 'fc-down'}">${m.yoy != null ? fmtPct(m.yoy) : '—'}</div></div>
      <div class="fc-card"><div class="fc-label">6-mo Forecast (LSTM)</div><div class="fc-value fc-neutral">${m.fcAvg != null ? m.fcAvg.toFixed(3) : '—'}</div></div>
      <div class="fc-card"><div class="fc-label">Forecast trend</div><div class="fc-value ${m.fcChange >= 0 ? 'fc-up' : 'fc-down'}">${m.fcChange != null ? fmtPct(m.fcChange) : '—'}</div></div>
    </div>
    <p style="font-size:11px;color:var(--text-muted);">Forecast method: ${m.method || 'LSTM neural network'}. Peak vegetation: ${m.peak || 'n/a'}. Data: ${escapeHtml(m.source || 'n/a')}</p>`;

  const site = window.wafeoSite && window.wafeoSite.last();
  const siteHtml = site ? window.wafeoSite.reportHtml() : '<p style="font-size:12px;color:var(--text-muted)">Tip: analyse a farm or region in <b>Site Intelligence</b> first to add live satellite findings on crops, water quantity and quality, soil and guidance to this report.</p>';
  body.innerHTML = '<h4>Executive Summary</h4><div class="report-narrative" id="reportNarrative"><em>Generating AI summary…</em></div>' + siteHtml + metricsHtml;
  modal.style.display = 'flex';
  if (btn) { btn.style.opacity = '1'; btn.disabled = false; }

  const narrEl = document.getElementById('reportNarrative');
  const prompt = `Write a concise professional executive summary (about 150 words) for an Earth-observation report on ${region}. Data: current 12-month average NDVI ${m.curAvg != null ? m.curAvg.toFixed(3) : 'n/a'}, year-over-year change ${m.yoy != null ? m.yoy.toFixed(1) + '%' : 'n/a'}, 6-month forecast average NDVI ${m.fcAvg != null ? m.fcAvg.toFixed(3) : 'n/a'} (${m.fcChange != null ? m.fcChange.toFixed(1) + '%' : 'n/a'} vs current), peak vegetation around ${m.peak || 'n/a'}. Cover vegetation health, likely water and food-security implications, and one clear recommendation. Plain paragraphs, no headings.`
    + (site ? ` Focus mainly on this live satellite assessment of the selected area, and give separate one-line priorities for farmers, government and the public: ${window.wafeoSite.reportPromptContext()}` : '');
  let text;
  try {
    const r = await fetch(API + '/ai/chat', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }) });
    const d = await r.json().catch(() => ({}));
    text = r.ok && d.reply ? d.reply : siteOrTemplateSummary(site, region, m);
  } catch (e) {
    text = siteOrTemplateSummary(site, region, m);
  }
  if (narrEl) narrEl.innerHTML = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  const siteData = site ? window.wafeoSite.reportData() : null;
  window.__lastReport = siteData
    ? { title: `WAFEO Site Report — ${siteData.region}`, region: siteData.region, summary: text, metrics: { ...siteData.metrics, forecast: m }, sections: siteData.sections }
    : { title: `WAFEO Report — ${region}`, region, summary: text, metrics: m, sections: ['NDVI', 'LSTM Forecast', 'Comparison'] };
  loadSavedReports();
}

async function saveCurrentReport() {
  const status = document.getElementById('reportSaveStatus');
  const rep = window.__lastReport;
  if (!rep) { if (status) status.textContent = 'Generate a report first.'; return; }
  if (typeof authToken === 'undefined' || !authToken) { if (status) status.textContent = 'Log in to save reports.'; return; }
  if (status) status.textContent = 'Saving…';
  try {
    const r = await fetch(API + '/reports', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken }, body: JSON.stringify(rep) });
    const d = await r.json().catch(() => ({}));
    if (d.saved) { if (status) status.textContent = d.persistent === false ? '✓ Saved (local dev: kept until server restart)' : '✓ Saved'; loadSavedReports(); }
    else if (status) status.textContent = d.message || 'Firestore unavailable — not saved.';
  } catch (e) { if (status) status.textContent = 'Save failed: ' + e.message; }
}

async function loadSavedReports() {
  const list = document.getElementById('savedReportsList');
  if (!list || typeof authToken === 'undefined' || !authToken) return;
  try {
    const r = await fetch(API + '/reports', { headers: { 'Authorization': 'Bearer ' + authToken } });
    const d = await r.json().catch(() => ({ reports: [] }));
    if (!d.reports || !d.reports.length) { list.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">No saved reports yet.</div>'; return; }
    list.innerHTML = '<h4 style="color:var(--accent-blue);font-size:14px;margin:8px 0;">Saved Records (' + d.reports.length + ')</h4>' +
      d.reports.map(x => `<div class="saved-report-row"><span>📄 ${escapeHtml(x.title || 'Report')} — <em>${escapeHtml(x.region || '')}</em></span><span style="color:var(--text-muted)">${escapeHtml((x.createdAt || '').slice(0, 10))}</span></div>`).join('');
  } catch (e) { /* ignore */ }
}

function printReport() {
  const body = document.getElementById('reportBody');
  const meta = document.getElementById('reportMeta');
  if (!body) return;
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write('<html><head><title>WAFEO Report</title><style>body{font-family:Segoe UI,Arial,sans-serif;padding:30px;color:#222}h1{color:#003366}h4{color:#003366}.fc-card{display:inline-block;border:1px solid #ddd;border-radius:6px;padding:8px 12px;margin:4px}.fc-label{font-size:11px;color:#888}.fc-value{font-size:18px;font-weight:700}</style></head><body><h1>WAFEO Comprehensive Report</h1><p>' + (meta ? meta.innerText : '') + '</p>' + body.innerHTML + '</body></html>');
  w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
}

(function bindReportButtons() {
  const s = document.getElementById('btnSaveReport');
  const p = document.getElementById('btnPrintReport');
  if (s) s.addEventListener('click', saveCurrentReport);
  if (p) p.addEventListener('click', printReport);
})();
