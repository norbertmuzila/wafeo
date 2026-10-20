// ─── Where is this AOI? Reverse geocoding ───────────────────

const { getJson } = require('./net');

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

module.exports = { place };
