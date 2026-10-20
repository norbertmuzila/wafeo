// ─── Live news (requires sign-in) ───────────────────────────

const express = require('express');
const { requireAuth } = require('../auth');
const { getNews } = require('../services/news');

const router = express.Router();
router.use(requireAuth);

// GET /api/news            latest verified stories (refreshed every 3 minutes)
// GET /api/news?date=YYYY-MM-DD   verified stories published on that date
router.get('/news', async (req, res) => {
  try {
    const date = req.query.date ? String(req.query.date) : undefined;
    const result = await getNews({ date, tzMin: req.query.tz });
    const limit = Number.isFinite(+req.query.limit) && +req.query.limit > 0 ? +req.query.limit : null;
    res.set('Cache-Control', 'no-store');
    res.json({ ...result, articles: limit ? result.articles.slice(0, limit) : result.articles, total: result.articles.length });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[news]', err.message);
    res.status(502).json({ error: 'Live news is temporarily unavailable.' });
  }
});

module.exports = router;
