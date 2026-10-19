// ─── /api/eo: live satellite analysis of a farm or region ────

const express = require('express');
const { requireAuth, rateLimit } = require('../auth');
const { analyzeSite } = require('../services/eo/analyze');

const router = express.Router();
router.use(requireAuth);

// Each analysis fans out to ~12 data services, so keep it per-user limited.
const limiter = rateLimit({ windowMs: 60 * 1000, max: 6, key: req => 'eo' + req.user.id });

router.post('/eo/analyze', limiter, async (req, res) => {
  try {
    const result = await analyzeSite(req.body || {});
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[eo] analysis failed:', err);
    res.status(500).json({ error: 'Satellite analysis failed. Please try again.' });
  }
});

// 24 months of Sentinel-2 NDVI for the same AOI (feeds the LSTM forecast).
const { normalizeAoi } = require('../services/eo/geo');
const { ndviSeries } = require('../services/eo/sentinel2');
const seriesCache = new Map();

router.post('/eo/ndvi-series', limiter, async (req, res) => {
  try {
    const aoi = normalizeAoi(req.body || {});
    const key = JSON.stringify(aoi.coordinates[0].map(([x, y]) => [x.toFixed(4), y.toFixed(4)])) + new Date().toISOString().slice(0, 10);
    let series = seriesCache.get(key);
    if (!series) {
      series = await ndviSeries(aoi, 24);
      seriesCache.set(key, series);
      if (seriesCache.size > 40) seriesCache.delete(seriesCache.keys().next().value);
    }
    res.json({ source: 'Sentinel-2 L2A monthly mean NDVI (clearest scene each month)', series });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[eo] NDVI series failed:', err);
    res.status(500).json({ error: 'Could not build the NDVI time series. Please try again.' });
  }
});

// Live GDACS hazards worldwide (dashboard map), refreshed every 15 minutes.
const { gdacsEvents } = require('../services/eo/live');
router.get('/live/hazards', async (req, res) => {
  try {
    const events = await gdacsEvents();
    res.json({ source: 'GDACS (UN / European Commission)', checkedAt: new Date().toISOString(), events });
  } catch (err) {
    console.error('[live] GDACS failed:', err.message);
    res.status(502).json({ error: 'Live hazard feed is temporarily unavailable.' });
  }
});

module.exports = router;
