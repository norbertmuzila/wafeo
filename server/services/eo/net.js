// ─── Network helpers: timeouts and the Planetary Computer catalog ──

const UA = 'WAFEO-Digital-Twin/2.1 (+https://wafeo-webapplication.vercel.app)';
const PC = 'https://planetarycomputer.microsoft.com/api';

async function getJson(url, { timeout = 15000, method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return res.json();
}

async function getBuffer(url, { timeout = 20000 } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return res.arrayBuffer();
}

// Planetary Computer issues short-lived, keyless SAS tokens. A token is
// valid for one storage container, which does not always match the
// collection, so sign by container and reuse the token until it expires.
const sasCache = new Map();
async function signedHref(_collection, href) {
  const u = new URL(href);
  const container = `${u.host}/${u.pathname.split('/')[1]}`;
  const hit = sasCache.get(container);
  if (hit && hit.expires - Date.now() > 5 * 60 * 1000) return `${href}?${hit.token}`;
  const j = await getJson(`${PC}/sas/v1/sign?href=${encodeURIComponent(href)}`, { timeout: 10000 });
  const token = new URL(j.href).search.slice(1);
  sasCache.set(container, { token, expires: Date.parse(j['msft:expiry']) || Date.now() + 30 * 60 * 1000 });
  return j.href;
}

// STAC search, newest first.
async function stacSearch({ collections, intersects, datetime, query, limit = 10, sortDesc = true }) {
  const body = { collections, intersects, limit };
  if (datetime) body.datetime = datetime;
  if (query) body.query = query;
  if (sortDesc) body.sortby = [{ field: 'properties.datetime', direction: 'desc' }];
  const j = await getJson(`${PC}/stac/v1/search`, { method: 'POST', body, timeout: 20000 });
  return j.features || [];
}

const isoDay = d => d.toISOString().slice(0, 10);
const daysAgo = (n, from = new Date()) => new Date(from.getTime() - n * 86400000);

module.exports = { getJson, getBuffer, signedHref, stacSearch, isoDay, daysAgo, UA };
