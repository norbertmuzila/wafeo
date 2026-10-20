// ─── Real-time context feeds (keyless) ───────────────────────
// FEWS NET Data Warehouse: current and projected IPC-compatible food
// insecurity by district, and people in Phase 3+ nationally.
// GDACS (UN/EC): live drought, flood, cyclone, earthquake, volcano and
// wildfire alerts.

const { getJson, isoDay, daysAgo } = require('./net');

const FDW = 'https://fdw.fews.net/api';
const PHASES = { 1: 'Minimal', 2: 'Stressed', 3: 'Crisis', 4: 'Emergency', 5: 'Famine' };
const phaseLabel = p => PHASES[p] || 'Unknown';

const fewsCache = new Map();

function pickUnitRows(rows, place) {
  const parts = r => String(r.geographic_unit_full_name || '').split(',').map(x => x.trim().toLowerCase());
  // OpenStreetMap says "Midlands Province" or "Gweru District"; FEWS NET says "Midlands", "Gweru".
  const clean = n => String(n || '').toLowerCase().replace(/\s+(province|district|region|county|rural district|urban)$/, '').trim();
  const has = name => name && rows.filter(r => parts(r).map(clean).includes(clean(name)));
  for (const [level, name] of [['district', place.name], ['province', place.admin1]]) {
    const found = has(name);
    if (found && found.length) return { level, name, rows: found };
  }
  const national = rows.filter(r => String(r.geographic_unit_name || '').toLowerCase() === String(place.country || '').toLowerCase());
  return { level: 'national', name: place.country, rows: national };
}

// Worst phase among the matched zones for one scenario, latest period first.
function latest(rows, scenarios, now) {
  const today = isoDay(now);
  const pool = rows.filter(r => scenarios.includes(String(r.scenario).trim()) && Number.isFinite(Number(r.value)));
  if (!pool.length) return null;
  const covering = pool.filter(r => r.projection_start <= today && r.projection_end >= today);
  const future = pool.filter(r => r.projection_start > today).sort((a, b) => a.projection_start.localeCompare(b.projection_start));
  const past = pool.slice().sort((a, b) => b.projection_start.localeCompare(a.projection_start));
  const set = covering.length ? covering : scenarios.includes('CS') ? past.filter(r => r.projection_start === past[0].projection_start) : future.filter(r => r.projection_start === (future[0] || {}).projection_start);
  if (!set.length) return null;
  const phase = Math.max(...set.map(r => Number(r.value)));
  return { phase, label: phaseLabel(phase), period: `${set[0].projection_start} to ${set[0].projection_end}`, zones: set.length };
}

async function foodSecurity(place, now = new Date()) {
  const cc = place && place.countryCode;
  if (!cc) return { available: false, reason: 'Country unknown.' };
  const key = `${cc}:${place.name}:${isoDay(now)}`;
  if (fewsCache.has(key)) return fewsCache.get(key);

  const [phases, pops] = await Promise.all([
    getJson(`${FDW}/ipcphase/?country_code=${cc}&format=json&start_date=${isoDay(daysAgo(150, now))}`, { timeout: 30000 }),
    getJson(`${FDW}/ipcpopulationsize/?country_code=${cc}&format=json&fields=simple&start_date=${isoDay(daysAgo(400, now))}`, { timeout: 30000 }).catch(() => [])
  ]);
  if (!Array.isArray(phases) || !phases.length) return { available: false, reason: `FEWS NET does not currently classify ${place.country || cc}.` };

  const unit = pickUnitRows(phases, place);
  const current = latest(unit.rows, ['CS'], now);
  const nearTerm = latest(unit.rows, ['ML1', 'ML'], now);
  const mediumTerm = latest(unit.rows, ['ML2'], now);

  const nat = (Array.isArray(pops) ? pops : []).filter(r => r.fnid === cc && String(r.phase) === '3+');
  const pick = sc => nat.filter(r => r.scenario === sc).sort((a, b) => b.projection_start.localeCompare(a.projection_start))[0];
  const people = r => r && { low: r.low_value ?? null, high: r.high_value ?? null, period: `${r.projection_start} to ${r.projection_end}`, keyDrivers: r.key_drivers || null };
  const today = isoDay(now);
  const natNow = people(pick('CS'));
  const natProj = people(nat.filter(r => r.scenario !== 'CS' && r.projection_end >= today).sort((a, b) => a.projection_start.localeCompare(b.projection_start))[0]);

  const result = {
    available: !!(current || nearTerm),
    source: 'FEWS NET Data Warehouse (IPC-compatible)',
    country: place.country,
    unitLevel: unit.level,
    unitName: unit.name,
    current, nearTerm, mediumTerm,
    nationalPhase3Plus: natNow,
    nationalPhase3PlusProjected: natProj,
    ...(current || nearTerm ? {} : { reason: 'No recent FEWS NET classification for this area.' })
  };
  fewsCache.set(key, result);
  if (fewsCache.size > 100) fewsCache.delete(fewsCache.keys().next().value);
  return result;
}

// ─── GDACS live hazard alerts ────────────────────────────────
const GDACS_TYPES = { DR: 'Drought', FL: 'Flood', TC: 'Tropical cyclone', EQ: 'Earthquake', VO: 'Volcano', WF: 'Wildfire' };
let gdacsCache = null;

async function gdacsEvents(now = new Date()) {
  if (gdacsCache && Date.now() - gdacsCache.at < 15 * 60 * 1000) return gdacsCache.events;
  const url = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH' +
    `?eventlist=DR;FL;TC;VO;WF&fromdate=${isoDay(daysAgo(45, now))}&todate=${isoDay(now)}&alertlevel=green;orange;red`;
  const j = await getJson(url, { timeout: 20000 });
  const events = (j.features || []).map(f => {
    const p = f.properties || {};
    const [lon, lat] = f.geometry?.coordinates || [];
    return {
      id: `${p.eventtype}${p.eventid}`,
      type: GDACS_TYPES[p.eventtype] || p.eventtype,
      alert: String(p.alertlevel || '').toLowerCase(),
      name: p.name || p.eventname || '',
      country: p.country || '',
      from: p.fromdate, to: p.todate,
      lat, lon,
      severity: p.severitydata?.severitytext || '',
      url: p.url?.report || null
    };
  }).filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lon));
  gdacsCache = { at: Date.now(), events };
  return events;
}

const km = (a, b) => {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// Hazards affecting the site: within 600 km, or reported for its country.
async function hazardsNear([lon, lat], country, now = new Date()) {
  const events = await gdacsEvents(now);
  const near = events
    .map(e => ({ ...e, distanceKm: Math.round(km([lon, lat], [e.lon, e.lat])) }))
    .filter(e => e.distanceKm <= 600 || (country && e.country.toLowerCase().includes(country.toLowerCase())))
    .sort((a, b) => (a.alert === 'red' ? 0 : a.alert === 'orange' ? 1 : 2) - (b.alert === 'red' ? 0 : b.alert === 'orange' ? 1 : 2) || a.distanceKm - b.distanceKm);
  return { available: true, source: 'GDACS (UN / European Commission)', events: near.slice(0, 15), checkedAt: now.toISOString() };
}

module.exports = { foodSecurity, gdacsEvents, hazardsNear, phaseLabel };
