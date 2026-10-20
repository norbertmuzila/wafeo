// ─── Live news (requires sign-in) ───────────────────────────

const express = require('express');
const { requireAuth } = require('../auth');
const { getNews, newsCacheTime } = require('../services/news');

const router = express.Router();
router.use(requireAuth);

router.get('/news', async (req, res) => {
  try {
    const news = await getNews();
    const limit = Number.isFinite(+req.query.limit) && +req.query.limit > 0 ? +req.query.limit : null;
    res.json({
      articles: limit ? news.slice(0, limit) : news,
      total: news.length,
      fetchedAt: newsCacheTime() ? new Date(newsCacheTime()).toISOString() : null
    });
  } catch (err) {
    console.error('[news]', err.message);
    res.status(502).json({ error: 'Live news is temporarily unavailable.' });
  }
});

module.exports = router;
