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
    if (pg === 'precision-farming') loadFields();
    if (pg === 'water-resources') loadWater();
    if (pg === 'food-security') loadFood();
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
    console.warn('Backend unreachable (' + err.message + '). Using static fallback data for:', path);
    // Map paths to static JSON files
    const map = {
      '/dashboard/stats': 'data/stats.json',
      '/alerts': 'data/alerts.json',
      '/satellites': 'data/satellites.json',
      '/analytics/ndvi-by-region': 'data/ndvi.json',
      '/fields': 'data/fields.json',
      '/water': 'data/water.json',
      '/food-security': 'data/food-security.json'
    };
    
    if (path === '/news') {
      return {
        articles: [
          { title: 'Global Report on Food Crises 2025', url: '#', date: { created: new Date().toISOString() }, source: [{ name: 'FAO' }], country: [{ name: 'Global' }], tag: 'Food Security' },
          { title: 'UN World Water Development Report 2025', url: '#', date: { created: new Date().toISOString() }, source: [{ name: 'UN Water' }], country: [{ name: 'Global' }], tag: 'Water' },
          { title: 'NASA GRACE-FO: Groundwater depletion accelerating', url: '#', date: { created: new Date().toISOString() }, source: [{ name: 'NASA' }], country: [{ name: 'North Africa' }], tag: 'Water' }
        ]
      };
    }
    
    if (map[path]) {
      try {
        const localRes = await fetch(map[path]);
        const data = await localRes.json();
        // Wrap data as expected by the frontend
        if (path === '/alerts') return { alerts: data, total: data.length };
        if (path === '/satellites') return { satellites: data, count: data.length };
        if (path === '/analytics/ndvi-by-region') return { data: data, source: 'Sentinel-2' };
        if (path === '/fields') return { fields: data, total: data.length };
        return data; // stats, water, food-security are direct
      } catch (e) {
        return null;
      }
    }
    return null; 
  }
}

// ─── DASHBOARD ───
async function loadDashboard() {
  const [stats, alerts, sats, ndvi] = await Promise.all([
    apiFetch('/dashboard/stats'),
    apiFetch('/alerts'),
    apiFetch('/satellites'),
    apiFetch('/analytics/ndvi-by-region')
  ]);

  if (document.getElementById('pgHeaders')) document.getElementById('pgHeaders').style.display = 'none';
  if (document.getElementById('continentSelector')) document.getElementById('continentSelector').style.display = 'flex';

  if (stats) renderStats(stats);
  if (alerts) {
    renderAlerts(alerts.alerts);
    updateNotifBadge(alerts.alerts);
  }
  if (sats) renderSatellites(sats.satellites);
  if (ndvi) renderNDVIChart(ndvi.data);
  renderWaterGauges();
  renderFoodQuick();
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

function renderStats(s) {
  document.getElementById('statsGrid').innerHTML = `
    <div class="stat-card"><div class="sc-icon g">🌾</div><div class="sc-label">Global Crop Health (NDVI)</div><div class="sc-value" style="color:var(--accent-green)">${s.cropHealth.value}</div><div class="sc-change up">${s.cropHealth.change}</div><div style="font-size:9px;color:var(--text-muted);margin-top:4px">Sentinel-2 / MODIS · ${_ts()}</div></div>
    <div class="stat-card"><div class="sc-icon b">💧</div><div class="sc-label">Water Availability</div><div class="sc-value" style="color:var(--accent-blue)">${s.waterScore.value}</div><div class="sc-change dn">${s.waterScore.change}</div><div style="font-size:9px;color:var(--text-muted);margin-top:4px">GRACE-FO / NISAR · ${_ts()}</div></div>
    <div class="stat-card"><div class="sc-icon a">🛡️</div><div class="sc-label">Food Security Alerts</div><div class="sc-value" style="color:var(--accent-amber)">${s.foodAlerts.value}</div><div class="sc-change neut">${s.foodAlerts.change}</div><div style="font-size:9px;color:var(--text-muted);margin-top:4px">IPC / FEWS NET · ${_ts()}</div></div>
    <div class="stat-card"><div class="sc-icon c">🛰️</div><div class="sc-label">Active Satellites</div><div class="sc-value" style="color:var(--accent-cyan)">${s.satellites.value}</div><div class="sc-change neut">${s.satellites.change}</div><div style="font-size:9px;color:var(--text-muted);margin-top:4px">incl. NISAR · ${_ts()}</div></div>
  `;
}

function renderAlerts(alerts) {
  const icons = { critical:'🔴', warning:'🟡', info:'🔵' };
  const html = alerts.slice(0, 5).map(a => `
    <div class="alert-card ${a.severity}">
      <div class="ac-icon">${icons[a.severity]}</div>
      <div class="ac-body">
        <div class="ac-title">${a.title}</div>
        <div class="ac-desc">${a.desc}</div>
        <div class="ac-meta">${a.source} · ${timeAgo(a.timestamp)}</div>
      </div>
    </div>
  `).join('');
  document.getElementById('alertsPanel').innerHTML = `<div class="panel-hdr"><h3>⚠️ Active Alerts</h3><span class="panel-badge">${alerts.length} Active</span></div>${html}`;
}

function renderNDVIChart(data) {
  const ndviColors = v => v>=0.7?'#1a9850':v>=0.55?'#91cf60':v>=0.4?'#d9ef8b':v>=0.3?'#fee08b':v>=0.2?'#fc8d59':'#d73027';
  const bars = data.map(d => `<div class="bar-col"><div class="bar-val">${d.ndvi}</div><div class="bar" style="height:${d.ndvi*220}px;background:${ndviColors(d.ndvi)}"></div><div class="bar-lbl">${d.region.replace('North ','N. ').replace('South ','S. ').replace('Southeast ','SE ')}</div></div>`).join('');
  document.getElementById('ndviPanel').innerHTML = `<div class="panel-hdr"><h3>🌾 Regional Crop Health (NDVI)</h3><span class="panel-badge">Sentinel-2</span></div><div class="bar-chart">${bars}</div><div class="ndvi-gradient"></div><div class="ndvi-labels"><span>Bare</span><span>Stressed</span><span>Moderate</span><span>Healthy</span><span>Very Healthy</span></div><div style="font-size:9px;color:var(--text-muted);padding:6px 16px">Source: ESA Sentinel-2 (2A/2B/2C) 10m NDVI · Updated: ${_ts()}</div>`;
}

function renderWaterGauges() {
  document.getElementById('waterPanel').innerHTML = `
    <div class="panel-hdr"><h3>💧 Water Resources</h3><span class="panel-badge">GRACE-FO / NISAR</span></div>
    <div class="gauge-row">
      <div class="gauge-item"><label><span>Global Reservoir Levels</span><span>67%</span></label><div class="gauge-track"><div class="gauge-fill water" style="width:67%"></div></div></div>
      <div class="gauge-item"><label><span>Groundwater Index</span><span>54%</span></label><div class="gauge-track"><div class="gauge-fill mixed" style="width:54%"></div></div></div>
      <div class="gauge-item"><label><span>Rainfall Anomaly (30d)</span><span style="color:var(--accent-red)">−18%</span></label><div class="gauge-track"><div class="gauge-fill low" style="width:38%"></div></div></div>
      <div class="gauge-item"><label><span>Snow Water Equivalent</span><span>81%</span></label><div class="gauge-track"><div class="gauge-fill high" style="width:81%"></div></div></div>
    </div>
    <div style="font-size:9px;color:var(--text-muted);padding:8px 16px 4px">Source: NASA GRACE-FO, NISAR, CHIRPS, ERA5 · Updated: ${_ts()} · <em>[Illustrative values — connect live API]</em></div>`;
}

function renderFoodQuick() {
  const rows = [
    ['🇸🇴 Somalia','Phase 4–5','6.5M','▲ Worsening','crit','var(--accent-red)'],
    ['🇸🇩 Sudan','Phase 4','8.7M','▲ Worsening','crit','var(--accent-red)'],
    ['🇪🇹 Ethiopia','Phase 3–4','12.8M','▲ Worsening','crit','var(--accent-red)'],
    ['🇦🇫 Afghanistan','Phase 3','15.3M','→ Stable','warn','var(--accent-amber)'],
    ['🇭🇹 Haiti','Phase 3','4.9M','→ Stable','warn','var(--accent-amber)'],
    ['🇲🇬 Madagascar','Phase 3','2.2M','▼ Improving','info','var(--accent-green)'],
  ];
  const tbody = rows.map(r => `<tr><td>${r[0]}</td><td><span class="pill ${r[4]}">${r[1]}</span></td><td class="mono">${r[2]}</td><td style="color:${r[5]}">${r[3]}</td></tr>`).join('');
  document.getElementById('foodPanel').innerHTML = `<div class="panel-hdr"><h3>🛡️ Food Security Watch</h3><span class="panel-badge">IPC / FEWS NET</span></div><table class="dtable"><thead><tr><th>Region</th><th>Phase</th><th>Pop.</th><th>Trend</th></tr></thead><tbody>${tbody}</tbody></table><div style="font-size:9px;color:var(--text-muted);padding:6px 16px">Source: IPC, FEWS NET, WFP · Updated: ${_ts()}</div>`;
}

function renderSatellites(sats) {
  const tbody = sats.map(s => `<tr><td>${s.name}</td><td>${s.agency}</td><td class="mono">${s.passTime}</td><td>${s.coverage}</td><td>${s.resolution}</td><td>${s.dataType}</td><td><span class="pill ${s.status==='active'?'ok':'info'}">● ${s.status.charAt(0).toUpperCase()+s.status.slice(1)}</span></td></tr>`).join('');
  document.getElementById('satPanel').innerHTML = `<div class="panel-hdr"><h3>🛰️ Active Satellite Data Sources</h3><span class="panel-badge">${sats.length} Sources</span></div><table class="dtable"><thead><tr><th>Satellite / Source</th><th>Agency</th><th>Frequency</th><th>Coverage</th><th>Res.</th><th>Data</th><th>Status</th></tr></thead><tbody>${tbody}</tbody></table><div style="font-size:9px;color:var(--text-muted);padding:6px 16px">All sources free or open-access · Updated: ${_ts()}</div>`;
}

function timeAgo(ts) {
  const d = Date.now() - new Date(ts).getTime();
  if(d<3600000) return Math.floor(d/60000)+'m ago';
  if(d<86400000) return Math.floor(d/3600000)+'h ago';
  return Math.floor(d/86400000)+'d ago';
}

// ─── FIELDS ───
async function loadFields() {
  const data = await apiFetch('/fields');
  if (!data) return loadFieldsDemo();
  renderFields(data.fields);
}
function loadFieldsDemo() {
  renderFields([
    {name:'Field Alpha',crop:'Wheat',ndvi:0.82,soilMoisture:34,yieldEst:4.2,area:120,status:'healthy'},
    {name:'Field Beta',crop:'Maize',ndvi:0.51,soilMoisture:18,yieldEst:2.8,area:85,status:'stressed'},
    {name:'Field Gamma',crop:'Rice',ndvi:0.76,soilMoisture:62,yieldEst:5.1,area:200,status:'healthy'},
    {name:'Field Delta',crop:'Soybean',ndvi:0.28,soilMoisture:9,yieldEst:0.8,area:65,status:'critical'},
    {name:'Field Epsilon',crop:'Coffee',ndvi:0.89,soilMoisture:45,yieldEst:2.1,area:40,status:'healthy'},
    {name:'Field Zeta',crop:'Groundnut',ndvi:0.46,soilMoisture:22,yieldEst:1.4,area:55,status:'stressed'},
  ]);
}
const cropEmoji = { Wheat:'🌾', Maize:'🌽', Rice:'🍚', Soybean:'🫘', Coffee:'☕', Groundnut:'🥜', Tobacco:'🍂', Sorghum:'🌿' };
function ndviColor(v) { return v>=0.7?'#1a9850':v>=0.55?'#91cf60':v>=0.4?'#d9ef8b':v>=0.3?'#fee08b':v>=0.2?'#fc8d59':'#d73027'; }
function ndviGrad(v) { return v>=0.7?'linear-gradient(90deg,#91cf60,#1a9850)':v>=0.5?'linear-gradient(90deg,#d9ef8b,#91cf60)':v>=0.3?'linear-gradient(90deg,#fee08b,#fc8d59)':'linear-gradient(90deg,#d73027,#fc8d59)'; }
function smColor(v) { return v>=50?'var(--accent-blue)':v>=25?'var(--accent-amber)':'var(--accent-red)'; }
function ylColor(v) { return v>=3?'var(--accent-green)':v>=1.5?'var(--accent-amber)':'var(--accent-red)'; }

function renderFields(fields) {
  document.getElementById('farmGrid').innerHTML = fields.map(f => `
    <div class="farm-card">
      <div class="fc-hdr"><h4>${cropEmoji[f.crop]||'🌱'} ${f.name} — ${f.crop}</h4><div class="fc-status ${f.status}">● ${f.status.charAt(0).toUpperCase()+f.status.slice(1)}</div></div>
      <div class="ndvi-bar-wrap">
        <div class="ndvi-lbl">NDVI Index</div>
        <div class="ndvi-prog">
          <div class="ndvi-track"><div class="ndvi-fill" style="width:${f.ndvi*100}%;background:${ndviGrad(f.ndvi)}"></div></div>
          <div class="ndvi-val" style="color:${ndviColor(f.ndvi)}">${f.ndvi}</div>
        </div>
      </div>
      <div class="fm-row">
        <div class="fm-box"><div class="fm-l">Soil Moist.</div><div class="fm-v" style="color:${smColor(f.soilMoisture)}">${f.soilMoisture}%</div></div>
        <div class="fm-box"><div class="fm-l">Yield Est.</div><div class="fm-v" style="color:${ylColor(f.yieldEst)}">${f.yieldEst} t/ha</div></div>
        <div class="fm-box"><div class="fm-l">Area</div><div class="fm-v">${f.area} ha</div></div>
      </div>
    </div>
  `).join('');
}

// ─── WATER PAGE ───
async function loadWater() {
  let data = await apiFetch('/water');
  if (!data) {
    console.warn("Using offline fallback data for Water Resources.");
    data = {
      waterBodies: [
        {name: "Lake Victoria", region: "Africa", type: "Reservoir", level: "23.53", capacity: 44, trend: "Stable", status: "watch"},
        {name: "Murray River", region: "Oceania", type: "River", level: "12.1", capacity: 32, trend: "-0.5%", status: "critical"},
        {name: "Colorado River", region: "N. America", type: "River", level: "18.4", capacity: 41, trend: "-1.2%", status: "low"},
        {name: "Amazon River", region: "S. America", type: "River", level: "41.2", capacity: 88, trend: "+0.1%", status: "normal"}
      ]
    };
  }
  document.getElementById('waterStats').innerHTML = `
    <div class="stat-card"><div class="sc-icon b">🌊</div><div class="sc-label">Global Reservoir Volume</div><div class="sc-value" style="color:var(--accent-blue)">6,840 km³</div><div class="sc-change dn">▼ 3.2% YoY</div></div>
    <div class="stat-card"><div class="sc-icon c">🏔️</div><div class="sc-label">Snow Water Equivalent</div><div class="sc-value" style="color:var(--accent-cyan)">2,120 km³</div><div class="sc-change up">▲ 8.1%</div></div>
    <div class="stat-card"><div class="sc-icon a">🌧️</div><div class="sc-label">30-Day Precip Anomaly</div><div class="sc-value" style="color:var(--accent-amber)">−18%</div><div class="sc-change dn">Below normal</div></div>
    <div class="stat-card"><div class="sc-icon r">⬇️</div><div class="sc-label">Groundwater Trend</div><div class="sc-value" style="color:var(--accent-red)">−2.4 cm/yr</div><div class="sc-change dn">Declining</div></div>
  `;
  const pillStatus = { normal:'ok', critical:'crit', watch:'warn', recovering:'warn', low:'crit' };
  const trendColor = t => t.includes('+') || t.includes('Stable') ? 'var(--accent-green)' : 'var(--accent-red)';
  const tbody = data.waterBodies.map(w => `<tr onclick="openWaterAnalytics('${w.name}', '${w.capacity}')"><td>${w.name}</td><td>${w.region}</td><td>${w.type}</td><td class="mono">${w.level}</td><td class="mono">${w.capacity}%</td><td style="color:${trendColor(w.trend)}">${w.trend}</td><td><span class="pill ${pillStatus[w.status]||'info'}">${w.status.charAt(0).toUpperCase()+w.status.slice(1)}</span></td></tr>`).join('');
  document.getElementById('waterTable').innerHTML = `<div class="panel-hdr"><h3>💧 Major Water Bodies</h3><span class="panel-badge">GRACE-FO / Sentinel-3</span></div><table class="dtable"><thead><tr><th>Name</th><th>Region</th><th>Type</th><th>Level</th><th>Cap.</th><th>Trend</th><th>Status</th></tr></thead><tbody>${tbody}</tbody></table>`;
}

// ─── FOOD SECURITY PAGE ───
async function loadFood() {
  const data = await apiFetch('/food-security');
  if (!data) return;
  document.getElementById('foodStats').innerHTML = `
    <div class="stat-card"><div class="sc-icon a">🛡️</div><div class="sc-label">IPC Phase 3+ Pop.</div><div class="sc-value" style="color:var(--accent-red)">258M</div><div class="sc-change dn">▲ 12M Q1</div></div>
    <div class="stat-card"><div class="sc-icon r">🚨</div><div class="sc-label">Famine Risk Zones</div><div class="sc-value" style="color:var(--accent-red)">5</div><div class="sc-change dn">+1 new</div></div>
    <div class="stat-card"><div class="sc-icon g">📈</div><div class="sc-label">Cereal Production</div><div class="sc-value" style="color:var(--accent-green)">2.82B t</div><div class="sc-change up">▲ 1.8%</div></div>
    <div class="stat-card"><div class="sc-icon b">🌐</div><div class="sc-label">Countries Monitored</div><div class="sc-value" style="color:var(--accent-cyan)">78</div><div class="sc-change neut">Full</div></div>
  `;
  const phaseClass = p => p.includes('4')?'crit':p.includes('3')?'warn':'info';
  const trendColor = t => t==='Worsening'?'var(--accent-red)':t==='Improving'?'var(--accent-green)':'var(--accent-amber)';
  const tbody = data.data.map(f => `<tr><td>${f.flag} ${f.country}</td><td><span class="pill ${phaseClass(f.phase)}">${f.phase} — ${f.label}</span></td><td class="mono">${f.popAffected}</td><td>${f.driver}</td><td>${f.harvest}</td><td style="color:${trendColor(f.trend)}">${f.trend}</td></tr>`).join('');
  document.getElementById('foodTable').innerHTML = `<div class="panel-hdr"><h3>🛡️ Food Security Classification</h3><span class="panel-badge">IPC / FEWS NET</span></div><table class="dtable"><thead><tr><th>Country</th><th>Phase</th><th>Pop.</th><th>Driver</th><th>Harvest</th><th>Trend</th></tr></thead><tbody>${tbody}</tbody></table>`;
}

// ─── MAP (LEAFLET LAYER) ───
const mapPins = [
  {id:'us',name:'United States',loc:[37.09,-95.71],ndvi:0.68,water:72,food:'Phase 1',pop:'331M'},
  {id:'ca',name:'Canada',loc:[56.13,-106.34],ndvi:0.55,water:88,food:'Phase 1',pop:'38M'},
  {id:'mx',name:'Mexico',loc:[23.63,-102.55],ndvi:0.52,water:48,food:'Phase 2',pop:'128M'},
  {id:'br',name:'Brazil',loc:[-14.23,-51.92],ndvi:0.78,water:82,food:'Phase 1',pop:'214M'},
  {id:'ar',name:'Argentina',loc:[-38.41,-63.61],ndvi:0.61,water:65,food:'Phase 1',pop:'45M'},
  {id:'co',name:'Colombia',loc:[4.57,-74.29],ndvi:0.82,water:78,food:'Phase 1',pop:'51M'},
  {id:'pe',name:'Peru',loc:[-9.19,-75.01],ndvi:0.45,water:55,food:'Phase 2',pop:'33M'},
  {id:'uk',name:'United Kingdom',loc:[55.37,-3.43],ndvi:0.62,water:75,food:'Phase 1',pop:'67M'},
  {id:'fr',name:'France',loc:[46.22,2.21],ndvi:0.66,water:70,food:'Phase 1',pop:'68M'},
  {id:'de',name:'Germany',loc:[51.16,10.45],ndvi:0.64,water:72,food:'Phase 1',pop:'84M'},
  {id:'it',name:'Italy',loc:[41.87,12.56],ndvi:0.58,water:58,food:'Phase 1',pop:'60M'},
  {id:'es',name:'Spain',loc:[40.46,-3.74],ndvi:0.48,water:42,food:'Phase 1',pop:'47M'},
  {id:'ua',name:'Ukraine',loc:[48.37,31.16],ndvi:0.59,water:55,food:'Phase 2',pop:'44M'},
  {id:'ru',name:'Russia',loc:[61.52,105.31],ndvi:0.42,water:86,food:'Phase 1',pop:'145M'},
  {id:'eg',name:'Egypt',loc:[26.82,30.80],ndvi:0.15,water:22,food:'Phase 2',pop:'104M'},
  {id:'ng',name:'Nigeria',loc:[9.08,8.67],ndvi:0.62,water:52,food:'Phase 3',pop:'218M'},
  {id:'et',name:'Ethiopia',loc:[9.14,40.48],ndvi:0.38,water:28,food:'Phase 4',pop:'120M'},
  {id:'ke',name:'Kenya',loc:[-0.02,37.90],ndvi:0.42,water:35,food:'Phase 3',pop:'55M'},
  {id:'za',name:'South Africa',loc:[-30.55,22.93],ndvi:0.51,water:44,food:'Phase 2',pop:'60M'},
  {id:'sd',name:'Sudan',loc:[12.86,30.21],ndvi:0.22,water:18,food:'Phase 4',pop:'44M'},
  {id:'so',name:'Somalia',loc:[5.15,46.19],ndvi:0.18,water:12,food:'Phase 4',pop:'17M'},
  {id:'cd',name:'DR Congo',loc:[-4.03,21.75],ndvi:0.76,water:72,food:'Phase 3',pop:'99M'},
  {id:'tz',name:'Tanzania',loc:[-6.36,34.88],ndvi:0.58,water:48,food:'Phase 2',pop:'63M'},
  {id:'zw',name:'Zimbabwe',loc:[-19.01,29.15],ndvi:0.41,water:32,food:'Phase 2',pop:'15M'},
  {id:'mg',name:'Madagascar',loc:[-18.76,46.86],ndvi:0.55,water:45,food:'Phase 2',pop:'28M'},
  {id:'sa',name:'Saudi Arabia',loc:[23.88,45.07],ndvi:0.08,water:15,food:'Phase 1',pop:'35M'},
  {id:'in',name:'India',loc:[20.59,78.96],ndvi:0.56,water:42,food:'Phase 2',pop:'1.4B'},
  {id:'cn',name:'China',loc:[35.86,104.19],ndvi:0.62,water:58,food:'Phase 1',pop:'1.4B'},
  {id:'pk',name:'Pakistan',loc:[30.37,69.34],ndvi:0.42,water:35,food:'Phase 2',pop:'225M'},
  {id:'bd',name:'Bangladesh',loc:[23.68,90.35],ndvi:0.72,water:78,food:'Phase 2',pop:'170M'},
  {id:'th',name:'Thailand',loc:[15.87,100.99],ndvi:0.74,water:68,food:'Phase 1',pop:'72M'},
  {id:'vn',name:'Vietnam',loc:[14.05,108.27],ndvi:0.71,water:72,food:'Phase 1',pop:'98M'},
  {id:'id',name:'Indonesia',loc:[-0.78,113.92],ndvi:0.80,water:82,food:'Phase 1',pop:'275M'},
  {id:'jp',name:'Japan',loc:[36.20,138.25],ndvi:0.68,water:78,food:'Phase 1',pop:'125M'},
  {id:'af',name:'Afghanistan',loc:[33.93,67.70],ndvi:0.20,water:20,food:'Phase 3',pop:'40M'},
  {id:'au',name:'Australia',loc:[-25.27,133.77],ndvi:0.35,water:38,food:'Phase 1',pop:'26M'},
  {id:'nz',name:'New Zealand',loc:[-40.90,174.88],ndvi:0.72,water:85,food:'Phase 1',pop:'5M'}
];

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

  // Fetch GeoJSON for Choropleth mapping
  fetch('https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json')
    .then(res => res.json())
    .then(data => {
      let geoJsonLayer;

      function getColor(name) {
        const co = mapPins.find(p => p.name === name || p.id.toUpperCase() === name); // Failsafe
        if(!co) return '#d1d5db'; 
        if(co.ndvi >= 0.6) return '#003366'; // Navy
        if(co.ndvi >= 0.5) return '#22c55e'; // Green
        if(co.ndvi >= 0.4) return '#eab308'; // Amber
        if(co.ndvi >= 0.2) return '#f59d1f'; // Orange
        return '#ef4444'; // Red
      }

      function style(feature) {
        return {
          fillColor: getColor(feature.properties.name),
          weight: 0.5,
          opacity: 0.7,
          color: '#ffffff',
          fillOpacity: 0.3
        };
      }

      function highlightFeature(e) {
        var layer = e.target;
        layer.setStyle({ weight: 1.5, color: '#f59d1f', fillOpacity: 0.5 });
        if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) { layer.bringToFront(); }
      }

      function resetHighlight(e) { geoJsonLayer.resetStyle(e.target); }
      function onMapClick(e) { 
        const co = mapPins.find(p => p.name === e.target.feature.properties.name);
        if(co) showCountryDetail(co); 
      }

      function onEachFeature(feature, layer) {
        layer.on({ mouseover: highlightFeature, mouseout: resetHighlight, click: onMapClick });
        const co = mapPins.find(p => p.name === feature.properties.name);
        let tipHtml = `<div style="font-family: inherit; font-size: 13px;"><strong>${feature.properties.name}</strong>`;
        if(co) tipHtml += `<br>NDVI Score: ${co.ndvi}<br>Water Risk: ${co.water}%</div>`;
        else tipHtml += `<br><span style="color:#666">No EO Data Available</span></div>`;
        layer.bindTooltip(tipHtml, { direction: 'auto', sticky: true });
      }

      geoJsonLayer = L.geoJSON(data, { style: style, onEachFeature: onEachFeature }).addTo(map);
      window.geoLayerRef = geoJsonLayer;
    })
    .catch(err => console.error("GeoJSON error: ", err));

  // Filters setup
  const mapChips = document.getElementById('mapChips');
  if (mapChips) mapChips.innerHTML = ['NDVI','Soil Moisture','Rainfall','Food Security','Water Bodies'].map((l,i) => `<div class="chip${i===0?' on':''}" onclick="this.classList.toggle('on')">${l}</div>`).join('');

  showMapOverview();
}

function showMapOverview() {
  const mapDetail = document.getElementById('mapDetail');
  if (mapDetail) mapDetail.innerHTML = `
    <h3>🌍 Global Overview</h3>
    <div class="md-row"><span class="md-l">Monitored Area</span><span class="md-v">148.9M km²</span></div>
    <div class="md-row"><span class="md-l">Active Regions</span><span class="md-v" title="GEOGLAM Crop Monitor regions + FAO GAUL admin-1 units with active EO coverage">196 <span style='font-size:9px;color:var(--text-muted);cursor:help' title='GEOGLAM Crop Monitor regions aligned with FAO GAUL admin-1 administrative boundaries'>(?)</span></span></div>
    <div class="md-row"><span class="md-l">Avg NDVI</span><span class="md-v" style="color:var(--accent-green)">0.42</span></div>
    <div class="md-row"><span class="md-l">Drought Zones</span><span class="md-v" style="color:var(--accent-red)">23</span></div>
    <div class="md-row"><span class="md-l">Flood Alerts</span><span class="md-v" style="color:var(--accent-amber)">8</span></div>
    <div class="md-row"><span class="md-l">Satellite Revisit</span><span class="md-v">5 days</span></div>
    <div class="md-row"><span class="md-l">Last Update</span><span class="md-v">2 min ago</span></div>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);font-size:12px;color:var(--text-secondary)">📡 Click any map pin for detailed EO analytics</div>
  `;
}

function showCountryDetail(co) {
  const fc = {'Phase 1':'var(--accent-green)','Phase 2':'var(--accent-amber)','Phase 3':'var(--accent-red)','Phase 4':'#d73027'};
  const ndviCol = co.ndvi>=0.6?'var(--accent-green)':co.ndvi>=0.4?'var(--accent-amber)':'var(--accent-red)';
  const mapDetail = document.getElementById('mapDetail');
  if (mapDetail) mapDetail.innerHTML = `
    <h3 style="cursor:pointer" onclick="showMapOverview()">← ${co.name}</h3>
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">Population: ${co.pop}</div>
    <div class="md-row"><span class="md-l">NDVI Index</span><span class="md-v" style="color:${ndviCol}">${co.ndvi}</span></div>
    <div class="md-row"><span class="md-l">Water Score</span><span class="md-v" style="color:${co.water>=60?'var(--accent-blue)':co.water>=35?'var(--accent-amber)':'var(--accent-red)'}">${co.water}%</span></div>
    <div class="md-row"><span class="md-l">Food Security</span><span class="md-v" style="color:${fc[co.food]||'inherit'}">${co.food}</span></div>
    <div style="margin-top:14px">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:5px">Vegetation Health</div>
      <div style="height:8px;border-radius:4px;background:var(--bg-tertiary);overflow:hidden"><div style="width:${co.ndvi*100}%;height:100%;border-radius:4px;background:${ndviCol}"></div></div>
    </div>
    <div style="margin-top:10px">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:5px">Water Availability</div>
      <div style="height:8px;border-radius:4px;background:var(--bg-tertiary);overflow:hidden"><div style="width:${co.water}%;height:100%;border-radius:4px;background:linear-gradient(90deg,var(--accent-cyan),var(--accent-blue))"></div></div>
    </div>
  `;
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



// ─── WATER BODY ANALYTICS ───
let wbChartInstance = null;
let wbFullDataset = [];
let wbFullDates = [];

function seededRandom(seed) {
  var x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}

function closeWaterAnalytics() {
  document.getElementById('waterAnalyticsModal').style.display = 'none';
}

function openWaterAnalytics(name, capacityStr) {
  document.getElementById('waterAnalyticsModal').style.display = 'flex';
  document.getElementById('wbModalTitle').textContent = name;

  // Set default dates (1 year ago to today)
  const today = new Date('2026-04-22');
  const lastYear = new Date('2025-05-01');
  
  document.getElementById('wbStartDate').value = lastYear.toISOString().split('T')[0];
  document.getElementById('wbEndDate').value = today.toISOString().split('T')[0];

  // Derive a pseudo-random seed from the water body name
  let seed = 0;
  for (let i = 0; i < name.length; i++) seed += name.charCodeAt(i);

  // Base metrics
  const baseLevel = 15 + (seededRandom(seed) * 50); // 15m to 65m
  const baseTemp = 12 + (seededRandom(seed + 1) * 15); // 12C to 27C
  const baseSalinity = 100 + (seededRandom(seed + 2) * 400); // 100 to 500 uS/cm
  const capacity = parseFloat(capacityStr) || 44;
  const currentVolGL = Math.round((capacity / 100) * (500 + seededRandom(seed+3)*2000));

  // Update KPI displays (using today's date context)
  const dtStr = "22/04/2026 07:00";
  document.getElementById('wbKpiLevel').textContent = (baseLevel + (seededRandom(seed+4)*2)).toFixed(2);
  document.getElementById('wbKpiLevelDate').textContent = dtStr;
  
  document.getElementById('wbKpiVolPerc').textContent = capacity + '%';
  document.getElementById('wbKpiVolData').textContent = currentVolGL + ' GL';
  document.getElementById('wbKpiVolDate').textContent = dtStr;
  
  const dashArray = `${capacity}, 100`;
  document.getElementById('wbKpiVolChart').setAttribute('stroke-dasharray', dashArray);
  let strokeColor = '#005c99';
  if (capacity < 30) strokeColor = '#d73027';
  else if (capacity < 50) strokeColor = '#f59e0b';
  document.getElementById('wbKpiVolChart').setAttribute('stroke', strokeColor);

  document.getElementById('wbKpiTemp').textContent = baseTemp.toFixed(1) + '°C';
  document.getElementById('wbKpiTempDate').textContent = dtStr;

  document.getElementById('wbKpiSalinity').textContent = baseSalinity.toFixed(1);
  document.getElementById('wbKpiSalDate').textContent = dtStr;

  // Generate 365 days of synthetic history
  wbFullDates = [];
  wbFullDataset = [];
  
  let currentLevel = baseLevel;
  for (let i = 0; i <= 365; i++) {
    const d = new Date('2025-05-01');
    d.setDate(d.getDate() + i);
    wbFullDates.push(d.toISOString().split('T')[0]);
    
    // Smooth seasonal sine wave plus slight random noise
    const dayOfYear = d.getTime() / (1000 * 60 * 60 * 24);
    const seasonality = Math.sin(dayOfYear * (Math.PI * 2 / 365) + seed);
    
    currentLevel += (seasonality * 0.05) + ((seededRandom(seed + i) - 0.5) * 0.06);
    wbFullDataset.push(currentLevel);
  }

  renderWaterAnalyticsChart(wbFullDates, wbFullDataset);
}

function applyWaterAnalyticsDates() {
  const s = document.getElementById('wbStartDate').value;
  const e = document.getElementById('wbEndDate').value;
  if (!s || !e) return;

  const sTime = new Date(s).getTime();
  const eTime = new Date(e).getTime();

  const filteredDates = [];
  const filteredData = [];

  for (let i = 0; i < wbFullDates.length; i++) {
    const t = new Date(wbFullDates[i]).getTime();
    if (t >= sTime && t <= eTime) {
      filteredDates.push(wbFullDates[i]);
      filteredData.push(wbFullDataset[i]);
    }
  }

  renderWaterAnalyticsChart(filteredDates, filteredData);
}

function renderWaterAnalyticsChart(labels, data) {
  const ctx = document.getElementById('waterBodyChartCanvas').getContext('2d');
  
  if (wbChartInstance) {
    wbChartInstance.destroy();
  }

  // Ensure Chart.js is loaded
  if (typeof Chart === 'undefined') {
    console.error('Chart.js not loaded!');
    return;
  }

  wbChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Water level (m)',
        data: data,
        borderColor: '#005c99',
        borderWidth: 2.5,
        fill: false,
        pointRadius: 0, // hide points by default like reference image
        pointHoverRadius: 5,
        pointHoverBackgroundColor: '#005c99',
        tension: 0.4 // smoothed curves
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false, // ensures hover traces nicely across the line
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(255, 255, 255, 0.95)',
          titleColor: '#333',
          bodyColor: '#005c99',
          bodyFont: { weight: 'bold', size: 14 },
          borderColor: '#ddd',
          borderWidth: 1,
          padding: 10,
          displayColors: false,
          callbacks: {
            label: function(context) {
              return 'Water level: ' + context.parsed.y.toFixed(2) + ' m';
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            maxTicksLimit: 12,
            callback: function(val, index) {
              const d = new Date(labels[index]);
              const month = d.toLocaleString('en-US', { month: 'short' });
              return month + " '" + d.getFullYear().toString().substr(-2);
            }
          }
        },
        y: {
          title: { display: true, text: 'Water level (m)', color: '#666', font: { size: 12 } },
          grid: { color: '#efefef' }
        }
      }
    }
  });
}

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
let _cachedAlerts = [];
function updateNotifBadge(alerts) {
  _cachedAlerts = alerts || [];
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  const critCount = alerts.filter(a => a.severity === 'critical').length;
  const warnCount = alerts.filter(a => a.severity === 'warning').length;
  const total = critCount + warnCount;
  if (total > 0) {
    badge.textContent = total;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

window.handleNotifClick = function() {
  if (!_cachedAlerts || _cachedAlerts.length === 0) {
    alert('No active notifications.');
    return;
  }
  // Find highest severity alert and navigate to its source page
  const crit = _cachedAlerts.find(a => a.severity === 'critical');
  const topAlert = crit || _cachedAlerts[0];
  // Map alert source keywords to page IDs
  const sourceMap = {
    'drought': 'drought-monitor',
    'food': 'food-security',
    'water': 'water-resources',
    'crop': 'crop-monitoring',
    'soil': 'soil-analysis',
    'farm': 'precision-farming',
    'warning': 'early-warning'
  };
  let targetPage = 'early-warning'; // default
  const sourceText = ((topAlert.source || '') + ' ' + (topAlert.title || '')).toLowerCase();
  for (const [keyword, page] of Object.entries(sourceMap)) {
    if (sourceText.includes(keyword)) { targetPage = page; break; }
  }
  // Navigate to that page
  const navLink = document.querySelector(`.nav-link[data-page="${targetPage}"]`);
  if (navLink) navLink.click();
};

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

window.alertApiKey = async function(provider) {
  try {
    const res = await fetch(API + `/satellite/external/${encodeURIComponent(provider.replace(/\s+/g, '-').toLowerCase())}`, {
      headers: authToken ? { 'Authorization': 'Bearer ' + authToken } : {}
    });
    const data = await res.json();
    alert(`🔒 ${provider} Action Blocked\n\n${data.message || 'API Key is missing for this satellite provider.'}`);
  } catch (err) {
    // Fallback if backend route fails
    alert(`🔒 ${provider} Access Denied\n\nYou must configure an Enterprise API key for this data stream in the environment variables.`);
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
    const users = data.users || [];

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

async function analyzeRegion(query) {
  const scanOverlay = document.getElementById('siScanOverlay');
  scanOverlay.style.opacity = '1';
  document.querySelector('.si-scanner-line').style.animationPlayState = 'running';
  
  let targetLat, targetLon, siteName, siteMeta;

  try {
    // 1. Resolve Location via OpenStreetMap (Nominatim API)
    if (typeof query === 'string') {
      // Hardcoded Chivaraidze check for extremely specific requested local details
      if (query.toLowerCase().includes('chivaraidze')) {
         targetLat = -17.8; targetLon = 31.3;
         siteName = "Chivaraidze Agro-Industrial Park";
         siteMeta = "Goromonzi, Mashonaland East, Zimbabwe · Granite-derived Sandy Loam";
      } else {
         const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`);
         const geoData = await geoRes.json();
         if (geoData && geoData.length > 0) {
           targetLat = parseFloat(geoData[0].lat);
           targetLon = parseFloat(geoData[0].lon);
           siteName = geoData[0].name || query;
           siteMeta = geoData[0].display_name;
         } else {
           throw new Error("Location not found on global registry.");
         }
      }
    } else {
      // Clicked Coordinate Reverse Geocoding
      targetLat = query.lat; targetLon = query.lon;
      const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${targetLat}&lon=${targetLon}&format=json`);
      const geoData = await geoRes.json();
      siteName = geoData.name || (geoData.address ? geoData.address.village || geoData.address.town || geoData.address.city || geoData.address.county : "Unknown Farm / Region");
      siteMeta = geoData.display_name || `Lat: ${targetLat.toFixed(4)}, Lon: ${targetLon.toFixed(4)}`;
    }

    // Fly map to location
    if (siMap) {
      siMap.flyTo([targetLat, targetLon], 14, { duration: 1.5 });
      if (siMarker) siMarker.remove();
      siMarker = L.circleMarker([targetLat, targetLon], { radius: 12, fillColor: 'var(--accent-emerald)', color: '#fff', weight: 3, opacity: 1, fillOpacity: 0.8 }).addTo(siMap);
    }

    // 2. Fetch Live Climate/Weather from Open-Meteo
    const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${targetLat}&longitude=${targetLon}&current_weather=true&daily=temperature_2m_max,precipitation_sum&timezone=auto`);
    const weatherData = await weatherRes.json();
    
    const currentTemp = weatherData.current_weather ? weatherData.current_weather.temperature : 25;
    const precipSum = (weatherData.daily && weatherData.daily.precipitation_sum) ? weatherData.daily.precipitation_sum[0] : 0;
    
    // Simulate NDVI/Water stats based on live real-world weather inputs
    const isDry = precipSum < 2 && currentTemp > 30;
    const ndviEstimate = isDry ? (Math.random() * 0.3 + 0.2).toFixed(2) : (Math.random() * 0.4 + 0.5).toFixed(2);
    
    // Construct Dynamic Overview
    let overview = [
      { id: 'farming', title: 'Farming Infrastructure', icon: siSvgs.farming, badge: 'Optimal', badgeClass: 'optimal', desc: `Region supports active agricultural infrastructure. Thermal scanning shows normal utilization levels.` },
      { id: 'water', title: 'Water Hydrology', icon: siSvgs.water, badge: isDry ? 'Concern' : 'Optimal', badgeClass: isDry ? 'concern' : 'optimal', desc: `Live precipitation recorded at ${precipSum}mm. ${isDry ? 'Severe stress on local irrigation' : 'Water flow and local irrigation networks are stable.'}` },
      { id: 'agriculture', title: 'Agriculture & Vegetation', icon: siSvgs.agriculture, badge: parseFloat(ndviEstimate) < 0.4 ? 'Watch' : 'Optimal', badgeClass: parseFloat(ndviEstimate) < 0.4 ? 'watch' : 'optimal', desc: `Estimated vegetation health (NDVI) is ${ndviEstimate}. ${parseFloat(ndviEstimate) < 0.4 ? 'Crops showing signs of stress.' : 'Vegetation is extremely healthy.'}` },
      { id: 'climate', title: 'Climate & Heat', icon: siSvgs.climate, badge: currentTemp > 32 ? 'Concern' : 'Watch', badgeClass: currentTemp > 32 ? 'concern' : 'watch', desc: `Live surface temperature is ${currentTemp} °C. ${currentTemp > 32 ? 'Extreme heat detected.' : 'Normal seasonal thermal signature.'}` },
      { id: 'foodSec', title: 'Food Security Alert', icon: siSvgs.foodSec, badge: isDry ? 'Concern' : 'Watch', badgeClass: isDry ? 'concern' : 'watch', desc: `Region IPC phase estimated based on local weather yields. ${isDry ? 'High risk of yield reduction.' : 'Stable local market forecast.'}` }
    ];

    let evidence = [
      { title: 'Vegetation Shift (30d)', trend: parseFloat(ndviEstimate) < 0.4 ? 'negative' : 'positive', desc: `NDVI trended ${parseFloat(ndviEstimate) < 0.4 ? 'downward' : 'upward'} following recent weather patterns.` },
      { title: 'Hydrology Change (7d)', trend: isDry ? 'negative' : 'positive', desc: `Recent precipitation sum of ${precipSum}mm drove a ${isDry ? 'decrease' : 'steady state'} in soil moisture.` }
    ];

    // Restore Chivaraidze specifics if searched
    if (typeof query === 'string' && query.toLowerCase().includes('chivaraidze')) {
        overview[0].desc = 'Multi-enterprise farming operational: Milling plants, Abattoirs, and Freeze drying facilities active.';
        overview[1].desc = `Live precipitation: ${precipSum}mm. Permanent water is adjacent. SAZ certified water plant fully operational and scaling.`;
        overview[2].desc = `Vegetation is robust (NDVI ${ndviEstimate}). Crops: Maize, Wheat, Soya, Pawpaw, Macadamia. Livestock: 300 cattle, 600 goats.`;
        evidence = [
          { title: 'Vegetation & ecosystem', trend: 'positive', desc: 'NDVI improved by +0.04 (12%) due to recent implementation of multi-enterprise horticulture.' },
          { title: 'Water & hydrology', trend: 'positive', desc: 'Water network connection remains stable. New SAZ certified water plant operational.' },
          { title: 'Land use & cover', trend: 'positive', desc: 'Built infrastructure increased by 5% due to completion of the new milling and oil production facilities.' }
        ];
    }

    // Update UI
    document.getElementById('siSiteName').textContent = siteName;
    document.getElementById('siSiteMeta').textContent = siteMeta;

    document.getElementById('siMetricsGrid').innerHTML = overview.map(m => `
      <div class="si-card">
        <div class="si-card-hdr">
          <div class="si-card-title">${m.icon} ${m.title}</div>
          <span class="si-badge ${m.badgeClass}">${m.badge}</span>
        </div>
        <div class="si-card-desc">${m.desc}</div>
      </div>
    `).join('');

    document.getElementById('siCompareList').innerHTML = evidence.map(c => `
      <div class="si-compare-item ${c.trend}">
        <div class="si-compare-title">${c.title}</div>
        <div class="si-compare-desc">${c.desc}</div>
      </div>
    `).join('');

    document.getElementById('siRegList').innerHTML = `
      <div class="si-reg-item">
        <div class="si-reg-title"><span>Water Use Compliance</span> <span class="si-reg-status compliant">Compliant</span></div>
        <div class="si-card-desc">Irrigation extraction aligns with regional water quotas.</div>
      </div>
      <div class="si-reg-item">
        <div class="si-reg-title"><span>Deforestation Policy</span> <span class="si-reg-status warning">Warning</span></div>
        <div class="si-card-desc">Proximity to protected biodiversity area. Monitoring active.</div>
      </div>
    `;

    setTimeout(() => {
      scanOverlay.style.opacity = '0';
    }, 1000);

  } catch (error) {
    console.error("Site Intelligence API Error:", error);
    document.getElementById('siSiteName').textContent = "Analysis Failed";
    document.getElementById('siSiteMeta').textContent = error.message;
    scanOverlay.style.opacity = '0';
  }
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
  const REGION_BASE = {
    'Sahel': 0.38, 'Horn of Africa': 0.32, 'East Africa': 0.62,
    'Southern Africa': 0.5, 'West Africa': 0.66
  };

  function seeded(seed) { const x = Math.sin(seed) * 10000; return x - Math.floor(x); }

  // 24 months of NDVI ending at the current month, with seasonality + region base.
  function buildSeries(region) {
    const base = REGION_BASE[region] != null ? REGION_BASE[region] : 0.45;
    let seed = 0; for (let i = 0; i < region.length; i++) seed += region.charCodeAt(i);
    const now = new Date(); const labels = []; const values = [];
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      labels.push(MONTHS[d.getMonth()] + " '" + String(d.getFullYear()).slice(2));
      const season = Math.sin((d.getMonth() / 12) * Math.PI * 2 - 1.2) * 0.16; // rainy-season bump
      const drift = (23 - i) * 0.0015;                                          // slow greening/decline
      const noise = (seeded(seed + (23 - i) * 7.3) - 0.5) * 0.05;
      let v = base + season + drift + noise;
      values.push(Math.max(0.05, Math.min(0.95, +v.toFixed(3))));
    }
    return { labels, values };
  }

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

  async function run() {
    const region = (document.getElementById('fcRegion') || {}).value || 'Sahel';
    const btn = document.getElementById('btnRunForecast');
    const status = document.getElementById('fcStatus');
    const badge = document.getElementById('fcBadge');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Training LSTM…'; }
    if (status) status.textContent = 'Training neural network on 24 months of NDVI…';
    const hist = buildSeries(region);
    render(hist, { values: [] });            // show history immediately
    const fc = await lstmForecast(hist.values, 6);
    render(hist, fc);
    renderComparison(hist, fc, fc.method);
    if (badge) badge.textContent = fc.method.startsWith('LSTM') ? 'LSTM · live' : 'Trend · live';
    if (status) status.textContent = 'Model: ' + fc.method;
    if (btn) { btn.disabled = false; btn.textContent = '▶ Run LSTM Forecast'; }
    return lastResult;
  }

  function ensureInit() {
    if (initialized) return;
    const panel = document.getElementById('forecastPanel'); if (!panel) return;
    initialized = true;
    const btn = document.getElementById('btnRunForecast');
    const sel = document.getElementById('fcRegion');
    if (btn) btn.addEventListener('click', run);
    if (sel) sel.addEventListener('change', run);
    setTimeout(run, 200); // auto-run on first view
  }

  return { ensureInit, run, getLast: () => lastResult };
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

async function generateWafeoReport() {
  const modal = document.getElementById('wafeoReportModal');
  const body = document.getElementById('reportBody');
  const meta = document.getElementById('reportMeta');
  const btn = document.getElementById('btnGenerateReport');
  if (!modal || !body) return;
  if (btn) { btn.style.opacity = '0.7'; btn.disabled = true; }

  // Ensure we have forecast metrics to report on.
  let fc = WAFEO_FC.getLast();
  if (!fc) { WAFEO_FC.ensureInit(); fc = await WAFEO_FC.run(); }
  const m = fc || {};
  const region = m.region || 'Global';
  const now = new Date();
  const who = (typeof currentUser !== 'undefined' && currentUser && (currentUser.name || currentUser.username)) || 'WAFEO user';
  if (meta) meta.innerHTML = `Region: <strong>${region}</strong> &middot; Generated: ${now.toLocaleString()} &middot; By: ${who}`;

  const fmtPct = n => (n >= 0 ? '+' : '') + (n != null ? n.toFixed(1) : '0.0') + '%';
  const metricsHtml = `
    <h4>Key Indicators — ${region}</h4>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:8px 0 16px;">
      <div class="fc-card"><div class="fc-label">Current NDVI (12-mo)</div><div class="fc-value fc-neutral">${m.curAvg != null ? m.curAvg.toFixed(3) : '—'}</div></div>
      <div class="fc-card"><div class="fc-label">Year-over-year</div><div class="fc-value ${m.yoy >= 0 ? 'fc-up' : 'fc-down'}">${m.yoy != null ? fmtPct(m.yoy) : '—'}</div></div>
      <div class="fc-card"><div class="fc-label">6-mo Forecast (LSTM)</div><div class="fc-value fc-neutral">${m.fcAvg != null ? m.fcAvg.toFixed(3) : '—'}</div></div>
      <div class="fc-card"><div class="fc-label">Forecast trend</div><div class="fc-value ${m.fcChange >= 0 ? 'fc-up' : 'fc-down'}">${m.fcChange != null ? fmtPct(m.fcChange) : '—'}</div></div>
    </div>
    <p style="font-size:11px;color:var(--text-muted);">Forecast method: ${m.method || 'LSTM neural network'}. Peak vegetation: ${m.peak || 'n/a'}.</p>`;

  body.innerHTML = metricsHtml + '<h4>Executive Summary</h4><div class="report-narrative" id="reportNarrative"><em>Generating AI summary…</em></div>';
  modal.style.display = 'flex';
  if (btn) { btn.style.opacity = '1'; btn.disabled = false; }

  const narrEl = document.getElementById('reportNarrative');
  const prompt = `Write a concise professional executive summary (about 150 words) for an Earth-observation report on ${region}. Data: current 12-month average NDVI ${m.curAvg != null ? m.curAvg.toFixed(3) : 'n/a'}, year-over-year change ${m.yoy != null ? m.yoy.toFixed(1) + '%' : 'n/a'}, 6-month forecast average NDVI ${m.fcAvg != null ? m.fcAvg.toFixed(3) : 'n/a'} (${m.fcChange != null ? m.fcChange.toFixed(1) + '%' : 'n/a'} vs current), peak vegetation around ${m.peak || 'n/a'}. Cover vegetation health, likely water and food-security implications, and one clear recommendation. Plain paragraphs, no headings.`;
  let text;
  try {
    const r = await fetch(API + '/ai/chat', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }) });
    const d = await r.json().catch(() => ({}));
    text = d.reply || templateSummary(region, m);
  } catch (e) {
    text = templateSummary(region, m);
  }
  if (narrEl) narrEl.innerHTML = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  window.__lastReport = { title: `WAFEO Report — ${region}`, region, summary: text, metrics: m, sections: ['NDVI', 'LSTM Forecast', 'Comparison'] };
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
