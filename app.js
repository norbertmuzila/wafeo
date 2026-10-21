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
  government: 'Gov / Policy', researcher: 'Researcher', demo: 'Demo visitor (no account)'
};
const isDemo = () => !!(currentUser && currentUser.role === 'demo');

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

  const navUsers = document.getElementById('navUsers');
  if (navUsers) navUsers.hidden = currentUser.role !== 'admin';
  const demoPill = document.getElementById('demoPill');
  if (demoPill) demoPill.hidden = !isDemo();
  const logoutBtn = document.getElementById('btnLogout');
  if (logoutBtn) logoutBtn.title = isDemo() ? 'Leave the demo' : 'Sign out';

  document.getElementById('loginScreen').classList.add('out');
  setTimeout(() => { document.getElementById('appShell').classList.add('on'); }, 400);
  // A broken panel must never block sign-in.
  Promise.resolve().then(loadDashboard).catch(err => console.error('Dashboard load failed:', err));
  setTimeout(() => { try { if (window.wafeoAtlas) { window.wafeoAtlas.init(); window.wafeoAtlas.resize(); } } catch (err) { console.error('Map init failed:', err); } }, 450);
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

// ─── DEMO (no account) ───
// "Try the demo" gets a short-lived session from the server; nothing the
// visitor does is stored, and it ends when the tab closes.
async function wafeoStartDemo() {
  if (authToken && !isDemo()) { if (window.wafeoLanding) window.wafeoLanding.hide(); return; }
  showLoginError('');
  try {
    const { res, data } = await postJson('/auth/demo', {});
    if (!res.ok) return showLoginError(data.error || 'The demo is busy right now. Please try again in a minute.');
    enterApp(data, { remember: false });
  } catch (err) {
    showLoginError(networkErrorMessage(err));
    if (window.wafeoLanding) window.wafeoLanding.showLogin();
  }
}
function wafeoLeaveDemo() {
  clearSession();
  try { localStorage.removeItem('wafeo.lastAnalysis'); } catch (e) {}
  try { sessionStorage.setItem('wafeo.openRegister', '1'); } catch (e) {}
  window.location.reload();
}
window.wafeoStartDemo = wafeoStartDemo;
window.wafeoLeaveDemo = wafeoLeaveDemo;

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

// ─── NAV ───
const titleMap = {
  'dashboard':'Global Dashboard', 'site-intelligence':'Site Intelligence', 'precision-farming':'Precision Farming',
  'crop-monitoring':'Crop Monitoring', 'soil-analysis':'Soil Analysis', 'water-resources':'Water Resources',
  'drought-monitor':'Drought Monitor', 'food-security':'Food Security', 'early-warning':'Early Warning',
  'reports':'Reports', 'users':'Users'
};
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
    link.classList.add('active');
    const pg = link.dataset.page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const el = document.getElementById('pg-' + pg);
    if (el) el.classList.add('active');
    
    document.getElementById('pgTitle').textContent = titleMap[pg] || pg;
    document.getElementById('pgCrumb').textContent = 'WAFEO / ' + (titleMap[pg] || pg);
    if (pg === 'reports') loadReports();
    if (pg === 'users' && currentUser && currentUser.role === 'admin') loadAdminUsers();
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
  if (window.wafeoLive) window.wafeoLive.dashboard();
}

// ─── REPORTS PAGE: live news is handled by livenews.js ───
function loadReports() {
  if (window.wafeoNews) window.wafeoNews.start();
}

const _ts = () => new Date().toISOString().split('T')[0];







function timeAgo(ts) {
  const d = Date.now() - new Date(ts).getTime();
  if(d<3600000) return Math.floor(d/60000)+'m ago';
  if(d<86400000) return Math.floor(d/3600000)+'h ago';
  return Math.floor(d/86400000)+'d ago';
}

// ─── TOOLTIP ───
function showTip(e, text) { const t=document.getElementById('ttp'); t.textContent=text; t.style.left=(e.clientX+14)+'px'; t.style.top=(e.clientY-12)+'px'; t.classList.add('on'); }
function hideTip() { document.getElementById('ttp').classList.remove('on'); }

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
  appendChatMsg('user', '<i data-lucide="user-round"></i>', text);
  chatHistory.push({ role: "user", content: text });
  
  const typingId = 'typing-' + Date.now();
  appendChatMsg('bot', '<i data-lucide="bot"></i>', '<em>Thinking...</em>', typingId);

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
    appendChatMsg('bot', '<i data-lucide="bot"></i>', htmlResponse, null, true);
    if (response.ok) chatHistory.push({ role: "assistant", content: botResponse });

  } catch (err) {
    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();
    appendChatMsg('bot', '<i data-lucide="bot"></i>', 'Sorry, I could not reach WAFEO Intelligence. Please try again.');
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
    if (badge) badge.textContent = `${users.length} users`;

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
            <span><i data-lucide="map-pin"></i>${escapeHtml(u.region || 'Global')}</span>
            <span><i data-lucide="calendar-days"></i>${registeredAt}</span>
            <span><i data-lucide="clock"></i>${u.lastLoginAt ? 'Last sign-in ' + new Date(u.lastLoginAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Never signed in'}</span>
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
    // The map is created while its page may be hidden or still laying out:
    // redraw it whenever its panel changes size, so it is never cut off.
    if (window.ResizeObserver) new ResizeObserver(() => siMap.invalidateSize()).observe(container);
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
  const dark = document.documentElement.classList.toggle('dark-theme');
  const btn = document.getElementById('themeToggle');
  if (btn) btn.innerHTML = `<i data-lucide="${dark ? 'sun' : 'moon'}"></i>`;
  try { localStorage.setItem('wafeo.theme', dark ? 'dark' : 'light'); } catch (e) {}
}
(function restoreTheme() {
  let saved = null;
  try { saved = localStorage.getItem('wafeo.theme'); } catch (e) {}
  if (saved === 'dark') toggleTheme();
})();

// ─── ICONS ──────────────────────────────────────────────────
// Every icon is a Lucide SVG written as <i data-lucide="name">. Content is
// rendered dynamically, so icons are swapped in whenever the page changes.
(function lucideIcons() {
  let queued = false;
  const draw = () => { queued = false; if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'aria-hidden': 'true' } }); };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(draw); } };
  draw();
  new MutationObserver(muts => { if (muts.some(m => [...m.addedNodes].some(n => n.nodeType === 1 && (n.matches('i[data-lucide]') || n.querySelector('i[data-lucide]'))))) queue(); })
    .observe(document.body, { childList: true, subtree: true });
})();

// ─── REPORTS ────────────────────────────────────────────────
// Preview the latest field analysis, save it to the user's records, or
// download it as a PDF (report.js).
const wafeoReportModal = document.getElementById('wafeoReportModal');
const btnGenerateReport = document.getElementById('btnGenerateReport');
const btnCloseReport = document.getElementById('btnCloseReport');
if (btnGenerateReport) btnGenerateReport.addEventListener('click', () => generateWafeoReport());
if (btnCloseReport) btnCloseReport.addEventListener('click', () => { wafeoReportModal.style.display = 'none'; });

// Written summary built from the analysis itself (no AI needed).
function siteSummary(site) {
  const d = site.domains, name = window.wafeoSite.siteName();
  const parts = [`${site.overall.riskLevel} risk for ${name} (${site.aoi.areaHa.toLocaleString()} ha). ${site.overall.headline}`];
  for (const k of ['crop', 'waterQuantity', 'waterQuality', 'soil']) if (d[k] && d[k].summary) parts.push(d[k].summary);
  const r = site.recommendations;
  parts.push(`Priority for farmers: ${r.farmers[0].action} Priority for government: ${r.government[0].action} Priority for the public: ${r.public[0].action}`);
  return parts.join('\n\n');
}

function generateWafeoReport() {
  const site = window.wafeoSite && window.wafeoSite.last();
  const body = document.getElementById('reportBody');
  const meta = document.getElementById('reportMeta');
  if (!wafeoReportModal || !body) return;
  if (!site) {
    body.innerHTML = '<p>No field has been analysed yet. Click a field on the dashboard map (zoom in close), or use Site Intelligence, then come back here.</p>';
    if (meta) meta.textContent = '';
    wafeoReportModal.style.display = 'flex';
    return;
  }
  const who = (currentUser && (currentUser.name || currentUser.username)) || 'WAFEO user';
  if (meta) meta.innerHTML = `Area: <strong>${escapeHtml(window.wafeoSite.siteName() || 'Selected area')}</strong> &middot; Analysed ${escapeHtml(new Date(site.generatedAt).toLocaleString())} &middot; By ${escapeHtml(who)}`;
  const text = siteSummary(site);
  body.innerHTML = '<h4>Summary</h4><div class="report-narrative">' + escapeHtml(text).replace(/\n/g, '<br>') + '</div>' + window.wafeoSite.reportHtml();
  wafeoReportModal.style.display = 'flex';
  const data = window.wafeoSite.reportData();
  window.__lastReport = { title: `Analysis_Report_WAFEO_${(data.region || 'Area').replace(/[^\w-]+/g, '_')}`, region: data.region, summary: text, metrics: data.metrics, sections: data.sections };
  const save = document.getElementById('btnSaveReport');
  if (save) save.hidden = isDemo();
  loadSavedReports();
}

async function saveCurrentReport() {
  const status = document.getElementById('reportSaveStatus');
  const rep = window.__lastReport;
  if (!rep) { if (status) status.textContent = 'Preview a report first.'; return; }
  if (isDemo()) { if (status) status.textContent = 'Create a free account to save reports.'; return; }
  if (!authToken) { if (status) status.textContent = 'Sign in to save reports.'; return; }
  if (status) status.textContent = 'Saving…';
  try {
    const r = await fetch(API + '/reports', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(rep) });
    const d = await r.json().catch(() => ({}));
    if (d.saved) { if (status) status.textContent = d.persistent === false ? 'Saved (local development: kept until the server restarts)' : 'Saved'; loadSavedReports(); }
    else if (status) status.textContent = d.error || 'Could not save the report.';
  } catch (e) { if (status) status.textContent = 'Save failed: ' + e.message; }
}

async function loadSavedReports() {
  const list = document.getElementById('savedReportsList');
  if (!list || !authToken || isDemo()) { if (list) list.innerHTML = ''; return; }
  try {
    const r = await fetch(API + '/reports', { headers: authHeaders() });
    const d = await r.json().catch(() => ({ reports: [] }));
    if (!d.reports || !d.reports.length) { list.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">No saved reports yet.</div>'; return; }
    list.innerHTML = '<h4 style="color:var(--accent-blue);font-size:14px;margin:8px 0;">Saved reports (' + d.reports.length + ')</h4>' +
      d.reports.map(x => `<div class="saved-report-row"><span><i data-lucide="file-text"></i> ${escapeHtml(x.title || 'Report')} · <em>${escapeHtml(x.region || '')}</em></span><span style="color:var(--text-muted)">${escapeHtml((x.createdAt || '').slice(0, 10))}</span></div>`).join('');
  } catch (e) { /* ignore */ }
}

(function bindReportButtons() {
  const s = document.getElementById('btnSaveReport');
  if (s) s.addEventListener('click', saveCurrentReport);
})();
