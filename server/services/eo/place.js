// ─── Where is this AOI? Reverse geocoding + national food-security context ──

const { getJson } = require('./net');
const store = require('../../store');

async function place([lon, lat]) {
  const j = await getJson(`https://nominatim.openstreetmap.org/reverse?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&format=json&zoom=10&accept-language=en`, { timeout: 10000 });
  const a = j.address || {};
  return {
    name: a.county || a.city || a.town || a.village || a.state_district || a.state || j.name || 'Selected area',
    admin1: a.state || null,
    country: a.country || null,
    countryCode: (a.country_code || '').toUpperCase() || null,
    displayName: j.display_name || null
  };
}

// IPC context from the platform's food-security dataset, when the country is covered.
async function foodSecurity(country) {
  if (!country) return { available: false, reason: 'Country unknown.' };
  const fs = await store.getDataset('food-security');
  const row = (fs.data || []).find(r => String(r.country).toLowerCase() === country.toLowerCase());
  if (!row) return { available: false, reason: `${country} is not in the WAFEO IPC list yet.` };
  return { available: true, country: row.country, phase: row.phase, label: row.label, popAffected: row.popAffected, driver: row.driver, harvest: row.harvest, trend: row.trend, source: 'IPC / FEWS NET (WAFEO dataset)' };
}

module.exports = { place, foodSecurity };
