// API smoke tests: `npm test`. Runs against a temp copy of users.json,
// so the real data/ folder is never modified.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpUsers = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wafeo-')), 'users.json');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'users.json'), tmpUsers);
process.env.WAFEO_USERS_FILE = tmpUsers;
process.env.JWT_SECRET = 'test-secret-at-least-16-chars';
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.GROQ_API_KEY;

const app = require('../server/app');
let server, base;

before(() => new Promise(resolve => {
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
after(() => server.close());

const call = async (method, p, { body, token } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
};
const login = async (username, password = 'wafeo2024') =>
  (await call('POST', '/api/auth/login', { body: { username, password } })).json.token;

test('health check reports ok', async () => {
  const r = await call('GET', '/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.status, 'ok');
  assert.strictEqual(r.json.store, 'json');
});

test('login: correct, wrong password, by email', async () => {
  assert.ok(await login('admin'));
  assert.ok(await login('j.mwangi@wafeo.org'));
  const bad = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'nope' } });
  assert.strictEqual(bad.status, 401);
  assert.ok(!('password' in ((await call('POST', '/api/auth/login', { body: { username: 'farmer', password: 'wafeo2024' } })).json.user)));
});

test('login records the last sign-in time', async () => {
  await login('researcher');
  await new Promise(r => setTimeout(r, 50));
  const u = JSON.parse(fs.readFileSync(tmpUsers, 'utf8')).find(x => x.username === 'researcher');
  assert.ok(u.lastLoginAt && Date.now() - Date.parse(u.lastLoginAt) < 60000);
});

test('legacy SHA-256 hashes are upgraded to scrypt on login', async () => {
  await login('policy');
  await new Promise(r => setTimeout(r, 50));
  const policy = JSON.parse(fs.readFileSync(tmpUsers, 'utf8')).find(u => u.username === 'policy');
  assert.match(policy.password, /^scrypt\$/);
  assert.ok(await login('policy'), 'still logs in after upgrade');
});

test('register creates a session and rejects duplicates', async () => {
  const body = { name: 'New Person', email: 'new@example.com', username: 'newperson', password: 'longenough1' };
  const r = await call('POST', '/api/auth/register', { body });
  assert.strictEqual(r.status, 201);
  assert.ok(r.json.token);
  assert.strictEqual(r.json.user.role, 'researcher');
  assert.strictEqual((await call('POST', '/api/auth/register', { body })).status, 409);
  assert.strictEqual((await call('POST', '/api/auth/register', { body: { ...body, username: 'x', email: 'y@z.io' } })).status, 400);
});

test('session restore via /api/auth/me', async () => {
  const token = await login('researcher');
  const r = await call('GET', '/api/auth/me', { token });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.user.username, 'researcher');
  assert.strictEqual((await call('GET', '/api/auth/me', { token: 'garbage' })).status, 401);
});

test('google endpoint rejects bad credentials', async () => {
  assert.strictEqual((await call('POST', '/api/auth/google', { body: {} })).status, 400);
  assert.strictEqual((await call('POST', '/api/auth/google', { body: { credential: 'not.a.jwt' } })).status, 401);
});

test('sample-data endpoints are gone; live endpoints need a token', async () => {
  const token = await login('farmer');
  for (const p of ['/api/dashboard/stats', '/api/alerts', '/api/satellites', '/api/fields', '/api/water', '/api/food-security']) {
    assert.strictEqual((await call('GET', p, { token })).status, 404, p + ' should no longer exist');
  }
  for (const p of ['/api/news', '/api/live/hazards']) assert.strictEqual((await call('GET', p)).status, 401, p + ' without token');
});

test('AI chat requires sign-in and explains missing key', async () => {
  const body = { messages: [{ role: 'user', content: 'hi' }] };
  assert.strictEqual((await call('POST', '/api/ai/chat', { body })).status, 401);
  const r = await call('POST', '/api/ai/chat', { body, token: await login('farmer') });
  assert.strictEqual(r.status, 503);
  assert.match(r.json.reply, /GROQ_API_KEY/);
});

test('reports save and list per user', async () => {
  const token = await login('researcher');
  const saved = await call('POST', '/api/reports', { token, body: { title: 'Test report', region: 'Kenya' } });
  assert.strictEqual(saved.json.saved, true);
  const list = await call('GET', '/api/reports', { token });
  assert.ok(list.json.reports.some(r => r.title === 'Test report'));
  const other = await call('GET', '/api/reports', { token: await login('farmer') });
  assert.ok(!other.json.reports.some(r => r.title === 'Test report'), 'reports are private');
});

test('admin routes are admin-only; role change works', async () => {
  const farmer = await login('farmer');
  assert.strictEqual((await call('GET', '/api/admin/users', { token: farmer })).status, 403);
  const admin = await login('admin');
  const users = await call('GET', '/api/admin/users', { token: admin });
  assert.strictEqual(users.status, 200);
  assert.ok(users.json.users.every(u => !('password' in u)));
  const r = await call('POST', '/api/admin/users/2/role', { token: admin, body: { role: 'policy' } });
  assert.strictEqual(r.json.user.role, 'policy');
});

test('satellite analysis endpoint requires sign-in and validates the area', async () => {
  assert.strictEqual((await call('POST', '/api/eo/analyze', { body: { point: [31.35, -17.85] } })).status, 401);
  const token = await login('farmer');
  const bad = await call('POST', '/api/eo/analyze', { token, body: {} });
  assert.strictEqual(bad.status, 400);
  const huge = await call('POST', '/api/eo/analyze', { token, body: { geometry: { type: 'Polygon', coordinates: [[[30, -20], [32, -20], [32, -18], [30, -18], [30, -20]]] } } });
  assert.strictEqual(huge.status, 400);
  assert.match(huge.json.error, /km²/);
});

test('private files are not served', async () => {
  for (const p of ['/data/users.json', '/server.js', '/.env', '/package.json', '/server/config.js', '/server/services/eo/live.js']) {
    const r = await call('GET', p);
    assert.ok(!/"password":\s*"/.test(r.text) && !r.text.includes('module.exports') && !r.text.includes('"dependencies"'), p + ' leaked');
  }
  assert.ok(!(await call('GET', '/data/stats.json')).text.includes('cropHealth'), 'no sample data served');
  const privacy = await call('GET', '/privacy');
  assert.ok(privacy.status === 200 && privacy.text.includes('Privacy Policy'), 'privacy page served');
  assert.ok([401, 404].includes((await call('GET', '/api/seed?secret=wafeo-admin-seed-2024')).status), 'seed route removed');
});

test('demo session: no account, can explore, cannot save or administer', async () => {
  const demo = await call('POST', '/api/auth/demo');
  assert.strictEqual(demo.status, 200);
  assert.strictEqual(demo.json.user.role, 'demo');
  const token = demo.json.token;
  const me = await call('GET', '/api/auth/me', { token });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.user.demo, true);
  assert.strictEqual((await call('POST', '/api/reports', { token, body: { title: 'x' } })).status, 403);
  assert.deepStrictEqual((await call('GET', '/api/reports', { token })).json.reports, []);
  assert.strictEqual((await call('GET', '/api/admin/users', { token })).status, 403);
  assert.strictEqual((await call('POST', '/api/eo/analyze', { token, body: {} })).status, 400, 'analysis open to demo');
  const users = JSON.parse(fs.readFileSync(tmpUsers, 'utf8'));
  assert.ok(!users.some(u => u.role === 'demo'), 'demo visitors are never stored');
});

test('field tracing validates the click', async () => {
  assert.strictEqual((await call('GET', '/api/eo/field?lon=10&lat=10')).status, 401);
  const token = await login('farmer');
  assert.strictEqual((await call('GET', '/api/eo/field?lon=abc&lat=1', { token })).status, 400);
});

test('news rejects invalid dates without calling sources', async () => {
  const token = await login('farmer');
  assert.strictEqual((await call('GET', '/api/news?date=2099-01-01', { token })).status, 400);
  assert.strictEqual((await call('GET', '/api/news?date=yesterday', { token })).status, 400);
  assert.strictEqual((await call('GET', '/api/news')).status, 401);
});
