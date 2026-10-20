// ─── Live news aggregator ───────────────────────────────────
// ReliefWeb API + RSS feeds, fetched in parallel and cached for 15 min.
// Falls back to a curated list so the news panel is never empty.

// ─── RSS PARSER (no extra library needed) ───────────────────
function parseRSS(xml, sourceName, tag) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const getTag = (t) => {
      const m = block.match(new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${t}>`, 'i'));
      return m ? m[1].trim().replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#\d+;/g,'') : '';
    };
    const title = getTag('title');
    const link  = getTag('link') || getTag('guid');
    const pubDate = getTag('pubDate') || getTag('dc:date');
    if (title) items.push({
      title,
      url: link,
      date: { created: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString() },
      source: [{ name: sourceName }],
      country: [],
      tag,
      sourceName
    });
  }
  return items;
}

// ─── NEWS CACHE (15-min TTL  Erefreshes daily content) ─────────
const newsCache = { data: null, fetchedAt: 0, ttl: 15 * 60 * 1000 };
const HDR = { 'User-Agent': 'WAFEO-Digital-Twin/2.0 (norbertmuzila.github.io/wafeo)', 'Accept': 'application/json, text/xml, */*' };

// ─── RELIEFWEB POST HELPER ───────────────────────────────────
async function rwFetch(themeName, tag, limit = 8) {
  const res = await fetch('https://api.reliefweb.int/v1/reports?appname=wafeo', {
    method: 'POST',
    headers: { ...HDR, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter: { field: 'theme.name', value: themeName },
      limit,
      sort: ['date:desc'],
      fields: { include: ['title', 'date', 'source', 'country', 'url'] }
    }),
    signal: AbortSignal.timeout(12000)
  });
  const d = await res.json();
  if (d?.data) return d.data.map(x => ({ ...x.fields, tag }));
  return [];
}

async function fetchLiveNews() {
  const now = Date.now();
  // Only serve cache if it has real data
  if (newsCache.data?.length > 0 && (now - newsCache.fetchedAt) < newsCache.ttl) {
    return newsCache.data;
  }

  const all = [];

  // Run ALL sources in parallel  Eeach is fully independent, failures silently skipped
  await Promise.allSettled([

    // ══ RELIEFWEB POST API (UN OCHA)  E8 themes ════════════════
    rwFetch('Food and Nutrition',           'Food Security', 15).then(r => all.push(...r)).catch(e => console.warn('[rw] food:', e.message)),
    rwFetch('Agriculture',                  'Agriculture',   15).then(r => all.push(...r)).catch(e => console.warn('[rw] agri:', e.message)),
    rwFetch('Water Sanitation Hygiene',     'Water',         15).then(r => all.push(...r)).catch(e => console.warn('[rw] water:', e.message)),
    rwFetch('Disaster Management',          'Disaster',      10).then(r => all.push(...r)).catch(e => console.warn('[rw] disaster:', e.message)),
    rwFetch('Climate Change and Environment','Agriculture',   10).then(r => all.push(...r)).catch(e => console.warn('[rw] climate:', e.message)),
    rwFetch('Drought',                      'Water',         10).then(r => all.push(...r)).catch(e => console.warn('[rw] drought:', e.message)),
    rwFetch('Flood',                        'Disaster',      10).then(r => all.push(...r)).catch(e => console.warn('[rw] flood:', e.message)),
    rwFetch('Food Safety',                  'Food Security', 10).then(r => all.push(...r)).catch(e => console.warn('[rw] foodsafety:', e.message)),

    // ══ REUTERS & BLOOMBERG (Proxy via Google News) ════════════
    fetch('https://news.google.com/rss/search?q=site:reuters.com+(agriculture+OR+food+security+OR+water+scarcity)&hl=en-US&gl=US&ceid=US:en', { headers: HDR, signal: AbortSignal.timeout(10000) })
      .then(r => r.text()).then(xml => all.push(...parseRSS(xml, 'Reuters', 'Global News')))
      .catch(e => console.warn('[rss] reuters:', e.message)),
    fetch('https://news.google.com/rss/search?q=site:bloomberg.com+(agriculture+OR+food+security+OR+water+scarcity)&hl=en-US&gl=US&ceid=US:en', { headers: HDR, signal: AbortSignal.timeout(10000) })
      .then(r => r.text()).then(xml => all.push(...parseRSS(xml, 'Bloomberg', 'Financials')))
      .catch(e => console.warn('[rss] bloomberg:', e.message)),

    // ══ DEVEX (Global Development) ══════════════════════════════
    fetch('https://news.google.com/rss/search?q=site:devex.com+(agriculture+OR+food+security+OR+water)&hl=en-US&gl=US&ceid=US:en', { headers: HDR, signal: AbortSignal.timeout(10000) })
      .then(r => r.text()).then(xml => all.push(...parseRSS(xml, 'Devex', 'Development')))
      .catch(e => console.warn('[rss] devex:', e.message)),

    // ══ CIRCLE OF BLUE & SCIENCEDAILY ══════════════════════════╁E
    fetch('https://www.circleofblue.org/feed/', { headers: HDR, signal: AbortSignal.timeout(10000) })
      .then(r => r.text()).then(xml => all.push(...parseRSS(xml, 'Circle of Blue', 'Water')))
      .catch(e => console.warn('[rss] circleofblue:', e.message)),
    fetch('https://www.sciencedaily.com/rss/earth_climate/agriculture.xml', { headers: HDR, signal: AbortSignal.timeout(10000) })
      .then(r => r.text()).then(xml => all.push(...parseRSS(xml, 'ScienceDaily', 'Research')))
      .catch(e => console.warn('[rss] sd-agri:', e.message)),
    fetch('https://www.sciencedaily.com/rss/earth_climate/water.xml', { headers: HDR, signal: AbortSignal.timeout(10000) })
      .then(r => r.text()).then(xml => all.push(...parseRSS(xml, 'ScienceDaily', 'Water')))
      .catch(e => console.warn('[rss] sd-water:', e.message)),

    // ══ FAO, WFP, UN News ══════════════════════════════════════
    fetch('https://www.fao.org/news/rss-feed/en/', { headers: HDR, signal: AbortSignal.timeout(9000) })
      .then(r => r.text()).then(xml => all.push(...parseRSS(xml, 'FAO', 'Agriculture')))
      .catch(e => console.warn('[rss] fao:', e.message)),
    fetch('https://www.wfp.org/rss/news', { headers: HDR, signal: AbortSignal.timeout(9000) })
      .then(r => r.text()).then(xml => all.push(...parseRSS(xml, 'WFP', 'Food Security')))
      .catch(e => console.warn('[rss] wfp:', e.message)),
    fetch('https://news.un.org/feed/subscribe/en/news/topic/food-and-agriculture/feed.rss', { headers: HDR, signal: AbortSignal.timeout(9000) })
      .then(r => r.text()).then(xml => all.push(...parseRSS(xml, 'UN News', 'Food Security')))
      .catch(e => console.warn('[rss] un-news:', e.message)),

    // ══ NASA & GDACS ══════════════════════════════════════════╁E
    fetch('https://earthobservatory.nasa.gov/feeds/earth-observatory.rss', { headers: HDR, signal: AbortSignal.timeout(9000) })
      .then(r => r.text()).then(xml => all.push(...parseRSS(xml, 'NASA Earth Observatory', 'Water')))
      .catch(e => console.warn('[rss] nasa-eo:', e.message)),
    fetch('https://www.gdacs.org/xml/rss_10.xml', { headers: HDR, signal: AbortSignal.timeout(9000) })
      .then(r => r.text()).then(xml => all.push(...parseRSS(xml, 'GDACS', 'Disaster')))
      .catch(e => console.warn('[rss] gdacs:', e.message)),

    // ══ ADDITIONAL: AgFunderNews & The Guardian ══════════════╁E
    fetch('https://agfundernews.com/feed', { headers: HDR, signal: AbortSignal.timeout(9000) })
      .then(r => r.text()).then(xml => all.push(...parseRSS(xml, 'AgFunder', 'Ag-Tech')))
      .catch(e => console.warn('[rss] agfunder:', e.message)),
    fetch('https://www.theguardian.com/environment/rss', { headers: HDR, signal: AbortSignal.timeout(9000) })
      .then(r => r.text()).then(xml => all.push(...parseRSS(xml, 'The Guardian', 'Environment')))
      .catch(e => console.warn('[rss] guardian:', e.message)),

    // ══ CGIAR, World Bank, IFAD ════════════════════════════════
    fetch('https://www.cgiar.org/feed/', { headers: HDR, signal: AbortSignal.timeout(9000) })
      .then(r => r.text()).then(xml => all.push(...parseRSS(xml, 'CGIAR', 'Agriculture')))
      .catch(e => console.warn('[rss] cgiar:', e.message)),
    fetch('https://blogs.worldbank.org/en/rss?blog=agriculture-and-food', { headers: HDR, signal: AbortSignal.timeout(9000) })
      .then(r => r.text()).then(xml => all.push(...parseRSS(xml, 'World Bank', 'Agriculture')))
      .catch(e => console.warn('[rss] worldbank:', e.message)),
    fetch('https://www.ifad.org/en/rss', { headers: HDR, signal: AbortSignal.timeout(9000) })
      .then(r => r.text()).then(xml => all.push(...parseRSS(xml, 'IFAD', 'Agriculture')))
      .catch(e => console.warn('[rss] ifad:', e.message)),
  ]);

  // Deduplicate + sort newest first
  const seen = new Set();
  const unique = all
    .filter(n => { if (!n.title || seen.has(n.title)) return false; seen.add(n.title); return true; })
    .sort((a, b) => new Date(b.date?.created || 0) - new Date(a.date?.created || 0));

  console.log(`[news] ${unique.length} unique articles (${all.length} raw)`);

  if (unique.length > 0) {
    newsCache.data = unique;
    newsCache.fetchedAt = now;
    return unique;
  }

  // Every live source failed: say so rather than show old articles.
  console.warn('[news] All live sources failed');
  return [];
}

module.exports = {
  getNews: fetchLiveNews,
  newsCacheTime: () => newsCache.fetchedAt
};
