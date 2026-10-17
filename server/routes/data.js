// ─── Dashboard data endpoints (all require sign-in) ──────────

const express = require('express');
const store = require('../store');
const { requireAuth } = require('../auth');
const { getNews, newsCacheTime } = require('../services/news');

const router = express.Router();
router.use(requireAuth);

// Wrap a handler so a thrown error becomes a JSON 500 instead of a hung request.
const handle = (label, fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    console.error(`[data] ${label}:`, err.message);
    res.status(500).json({ error: `${label} unavailable` });
  }
};

router.get('/dashboard/stats', handle('Stats', () => store.getDataset('stats')));

router.get('/alerts', handle('Alerts', async () => {
  const alerts = await store.getDataset('alerts');
  return { alerts, total: alerts.length };
}));

router.get('/satellites', handle('Satellite data', async () => {
  const satellites = await store.getDataset('satellites');
  return { satellites, count: satellites.length, lastUpdated: new Date().toISOString() };
}));

router.get('/analytics/ndvi-by-region', handle('NDVI data', async () => ({
  data: await store.getDataset('ndvi'),
  source: 'Sentinel-2 / MODIS',
  updatedAt: new Date().toISOString()
})));

router.get('/fields', handle('Field data', async () => {
  const fields = await store.getDataset('fields');
  return { fields, total: fields.length };
}));

router.get('/water', handle('Water data', () => store.getDataset('water')));
router.get('/food-security', handle('Food security data', () => store.getDataset('food-security')));
router.get('/countries', handle('Country data', () => store.getDataset('countries')));

router.get('/news', handle('News', async req => {
  const news = await getNews();
  const limit = Number.isFinite(+req.query.limit) && +req.query.limit > 0 ? +req.query.limit : null;
  return {
    articles: limit ? news.slice(0, limit) : news,
    total: news.length,
    cached: newsCacheTime() > 0,
    fetchedAt: new Date(newsCacheTime()).toISOString()
  };
}));

// Commercial imagery providers need paid keys that are not configured.
router.get('/satellite/external/:provider', (req, res) => {
  const provider = req.params.provider.toUpperCase();
  res.status(403).json({
    error: 'API_KEY_REQUIRED',
    provider,
    message: `Enterprise API Key configuration is missing for ${provider}. Please update your server environment variables to connect this live stream.`
  });
});

module.exports = router;
