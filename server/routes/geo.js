// ─── /api/geo: map reference data (public, cached) ───────────
// Provinces, districts and local place names for the dashboard map. This is
// open reference data, so no sign-in is needed and the CDN may cache it.

const express = require('express');
const { rateLimit } = require('../auth');
const { adminAreas, placesInCell, KINDS } = require('../services/geo');

const router = express.Router();
router.use(rateLimit({ windowMs: 60 * 1000, max: 240, key: req => 'geo' + req.ip }));

const CACHE = 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800';

// Provinces (level 1) or districts (level 2) of one country.
router.get('/admin', async (req, res) => {
  const iso3 = String(req.query.iso3 || '').toUpperCase();
  const level = Number(req.query.level);
  if (!/^[A-Z]{3}$/.test(iso3) || ![1, 2].includes(level)) return res.status(400).json({ error: 'Give iso3 (e.g. ZWE) and level 1 or 2.' });
  try {
    const r = await adminAreas(iso3, level);
    res.set('Cache-Control', CACHE).json(r);
  } catch (err) {
    console.error('[geo] admin areas failed:', iso3, level, err.message);
    res.status(err.status || 502).json({ error: 'Boundaries are temporarily unavailable.' });
  }
});

// Local place names in one 1° × 1° cell of one country.
router.get('/places', async (req, res) => {
  const cc = String(req.query.cc || '').toUpperCase();
  const [x, y] = String(req.query.cell || '').split(',').map(Number);
  if (!/^[A-Z]{2}$/.test(cc) || !Number.isInteger(x) || !Number.isInteger(y) || Math.abs(x) > 180 || Math.abs(y) > 90) {
    return res.status(400).json({ error: 'Give cc (e.g. ZW) and cell as whole degrees "lon,lat".' });
  }
  try {
    const rows = await placesInCell(cc, x, y);
    res.set('Cache-Control', CACHE).json({ source: 'GeoNames', kinds: KINDS, available: rows !== null, places: rows || [] });
  } catch (err) {
    console.error('[geo] places failed:', cc, x, y, err.message);
    res.status(err.status || 502).json({ error: 'Place names are temporarily unavailable.' });
  }
});

module.exports = router;
