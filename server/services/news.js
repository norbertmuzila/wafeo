// ─── Live news: water, agriculture and food systems ─────────
// Searches continuously across three kinds of source and keeps only
// verified, on-topic reporting:
//   1. Direct RSS/Atom feeds of trusted outlets (NewsDay Harare, BBC,
//      Al Jazeera, The Guardian, Daily Maverick, Nation Africa, ...).
//   2. Google News search (global, any date), limited to trusted outlets.
//      This also reaches sites that block direct feed access (The Herald,
//      Chronicle, ZBC News).
//   3. GDELT DOC 2.0 API (world media monitored every 15 minutes).
// Verification: the outlet must be on the trusted list, the link must be a
// real http(s) URL, the date must be valid and not in the future, and the
// headline must be about water, agriculture, food security or climate
// hazards. Stories carried by several outlets are merged and the number of
// independent outlets is reported as corroboration.

const UA = {
  'User-Agent': 'Mozilla/5.0 (compatible; WAFEO-News/3.0; +https://wafeo-webapplication.vercel.app)',
  Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, */*'
};

// ─── Trusted outlets (domain → name, home country) ───────────
const TRUSTED = {
  'newsday.co.zw': ['NewsDay', 'Zimbabwe'], 'herald.co.zw': ['The Herald', 'Zimbabwe'], 'chronicle.co.zw': ['The Chronicle', 'Zimbabwe'],
  'zbcnews.co.zw': ['ZBC News', 'Zimbabwe'], 'theindependent.co.zw': ['Zimbabwe Independent', 'Zimbabwe'], 'newzimbabwe.com': ['NewZimbabwe', 'Zimbabwe'],
  'thestandard.co.zw': ['The Standard', 'Zimbabwe'], 'sundaymail.co.zw': ['The Sunday Mail', 'Zimbabwe'], 'zimlive.com': ['ZimLive', 'Zimbabwe'],
  'farmersweekly.co.za': ["Farmer's Weekly", 'South Africa'], 'dailymaverick.co.za': ['Daily Maverick', 'South Africa'], 'news24.com': ['News24', 'South Africa'],
  'timeslive.co.za': ['TimesLIVE', 'South Africa'], 'iol.co.za': ['IOL', 'South Africa'], 'businesslive.co.za': ['BusinessLIVE', 'South Africa'],
  'nation.africa': ['Nation Africa', 'Kenya'], 'theeastafrican.co.ke': ['The EastAfrican', 'Kenya'], 'standardmedia.co.ke': ['The Standard (Kenya)', 'Kenya'],
  'monitor.co.ug': ['Daily Monitor', 'Uganda'], 'thecitizen.co.tz': ['The Citizen', 'Tanzania'], 'premiumtimesng.com': ['Premium Times', 'Nigeria'],
  'mg.co.za': ['Mail & Guardian', 'South Africa'], 'lusakatimes.com': ['Lusaka Times', 'Zambia'], 'nyasatimes.com': ['Nyasa Times', 'Malawi'],
  'allafrica.com': ['AllAfrica', 'Africa'], 'africanews.com': ['Africanews', 'Africa'], 'theafricareport.com': ['The Africa Report', 'Africa'],
  'bbc.co.uk': ['BBC News', 'Global'], 'bbc.com': ['BBC News', 'Global'], 'aljazeera.com': ['Al Jazeera', 'Global'], 'theguardian.com': ['The Guardian', 'Global'],
  'reuters.com': ['Reuters', 'Global'], 'apnews.com': ['AP News', 'Global'], 'bloomberg.com': ['Bloomberg', 'Global'], 'ft.com': ['Financial Times', 'Global'],
  'nytimes.com': ['The New York Times', 'Global'], 'washingtonpost.com': ['The Washington Post', 'Global'], 'economist.com': ['The Economist', 'Global'],
  'dw.com': ['DW', 'Global'], 'france24.com': ['France 24', 'Global'], 'voanews.com': ['VOA', 'Global'], 'npr.org': ['NPR', 'Global'], 'cnn.com': ['CNN', 'Global'],
  'abc.net.au': ['ABC News', 'Global'], 'thehindu.com': ['The Hindu', 'Global'], 'downtoearth.org.in': ['Down To Earth', 'Global'], 'scmp.com': ['SCMP', 'Global'],
  'theconversation.com': ['The Conversation', 'Global'], 'mongabay.com': ['Mongabay', 'Global'], 'circleofblue.org': ['Circle of Blue', 'Global'],
  'carbonbrief.org': ['Carbon Brief', 'Global'], 'nature.com': ['Nature', 'Global'], 'science.org': ['Science', 'Global'], 'sciencedaily.com': ['ScienceDaily', 'Global'],
  'nasa.gov': ['NASA', 'Global'], 'agfundernews.com': ['AgFunderNews', 'Global'], 'devex.com': ['Devex', 'Global'], 'un.org': ['United Nations', 'Global'],
  'fao.org': ['FAO', 'Global'], 'wfp.org': ['WFP', 'Global'], 'reliefweb.int': ['ReliefWeb', 'Global'], 'worldbank.org': ['World Bank', 'Global'],
  'ifad.org': ['IFAD', 'Global'], 'cgiar.org': ['CGIAR', 'Global'], 'ifpri.org': ['IFPRI', 'Global'], 'unicef.org': ['UNICEF', 'Global'], 'who.int': ['WHO', 'Global'],
  'gdacs.org': ['GDACS', 'Global'], 'fews.net': ['FEWS NET', 'Global'], 'icrc.org': ['ICRC', 'Global'], 'ipsnews.net': ['IPS News', 'Global']
};
const trustedOf = host => {
  host = String(host || '').toLowerCase().replace(/^www\./, '');
  for (const d of Object.keys(TRUSTED)) if (host === d || host.endsWith('.' + d)) return { domain: d, name: TRUSTED[d][0], home: TRUSTED[d][1] };
  return null;
};

// ─── Direct feeds (trusted by construction; general ones are topic-filtered) ──
const FEEDS = [
  ['https://www.newsday.co.zw/feed/', 'newsday.co.zw'],
  ['https://www.theindependent.co.zw/feed/', 'theindependent.co.zw'],
  ['https://www.newzimbabwe.com/feed/', 'newzimbabwe.com'],
  ['https://www.farmersweekly.co.za/feed/', 'farmersweekly.co.za'],
  ['https://www.dailymaverick.co.za/dmrss/', 'dailymaverick.co.za'],
  ['https://nation.africa/kenya/rss.xml', 'nation.africa'],
  ['https://allafrica.com/tools/headlines/rdf/agriculture/headlines.rdf', 'allafrica.com'],
  ['https://allafrica.com/tools/headlines/rdf/environment/headlines.rdf', 'allafrica.com'],
  ['https://feeds.bbci.co.uk/news/world/africa/rss.xml', 'bbc.co.uk'],
  ['https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', 'bbc.co.uk'],
  ['https://www.aljazeera.com/xml/rss/all.xml', 'aljazeera.com'],
  ['https://www.theguardian.com/environment/rss', 'theguardian.com'],
  ['https://www.theguardian.com/global-development/rss', 'theguardian.com'],
  ['https://theconversation.com/africa/articles.atom', 'theconversation.com'],
  ['https://news.mongabay.com/feed/', 'mongabay.com'],
  ['https://www.circleofblue.org/feed/', 'circleofblue.org'],
  ['https://earthobservatory.nasa.gov/feeds/earth-observatory.rss', 'nasa.gov'],
  ['https://www.sciencedaily.com/rss/earth_climate/water.xml', 'sciencedaily.com'],
  ['https://agfundernews.com/feed', 'agfundernews.com'],
  ['https://www.gdacs.org/xml/rss_10.xml', 'gdacs.org']
];

// Google News searches: global topics plus Zimbabwe's main outlets.
// Queries stay short: Google ignores date limits on very long queries.
const GN_QUERIES = [
  ['food', 'drought OR famine OR hunger OR "food security"'],
  ['farming', 'farmers OR harvest OR crops OR maize OR fertiliser'],
  ['water', 'irrigation OR "water scarcity" OR dam OR rainfall OR "El Nino"'],
  ['zimbabwe', 'Zimbabwe (farmers OR drought OR maize OR water OR food)'],
  ['africa', 'Africa (drought OR farmers OR "food security" OR harvest)'],
  ['zim-outlets', '(site:newsday.co.zw OR site:herald.co.zw OR site:chronicle.co.zw OR site:zbcnews.co.zw) (farmers OR drought OR water OR maize)'],
  ['zim-outlets-2', '(site:herald.co.zw OR site:chronicle.co.zw OR site:sundaymail.co.zw) (agriculture OR tobacco OR rainfall OR food)'],
  ['agencies', '(site:reuters.com OR site:apnews.com OR site:fao.org OR site:wfp.org) (drought OR farmers OR "food security")']
];

// ─── Topic filter and tags ────────────────────────────────────
const TOPICS = [
  ['Food security', /\b(food (security|insecurity|crisis|prices?|aid|shortages?|assistance|reserves?)|hunger|famine|malnutrition|malnourish\w*|ipc phase|world food programme|grain (reserves?|imports?|prices?|deficit|shortfall)|cereal (shortfall|deficit|production))\b/i],
  ['Water', /\b(water (scarcity|shortages?|supply|crisis|levels?|rationing|resources?|tables?|security)|drinking water|dams?|reservoirs?|boreholes?|irrigat\w*|river (levels?|flows?)|aquifers?|groundwater|lake (levels?|kariba))\b/i],
  ['Climate & hazards', /\b(droughts?|floods?|flooding|cyclones?|heatwaves?|heat wave|el ni[nñ]o|la ni[nñ]a|rainfall|rainy season|wildfires?|locusts?|climate change|desertification|dry spell)\b/i],
  ['Agriculture', /\b(agricultur\w*|farm(s|ers?|ing|land)?|crops?|harvest\w*|maize|wheat|rice|sorghum|millet|soya?beans?|tobacco|cotton|livestock|cattle|fertili[sz]ers?|planting season|agronom\w*|smallholders?|horticultur\w*|fall armyworm|soil health|agritex|grain marketing board)\b/i]
];
const EXCLUDE = /\b(football|soccer|cricket|rugby|premier league|olympics?|celebrity|recipe|restaurant|box office|nba|nfl|murder\w*|cult)\b/i;
const countHits = text => TOPICS.reduce((n, [, re]) => n + ((text.match(new RegExp(re.source, 'gi')) || []).length), 0);
// The headline must be on topic; failing that, the summary must mention
// the topics at least twice (one passing mention is not enough).
function topicOf(title, summary = '') {
  if (EXCLUDE.test(title)) return null;
  for (const [tag, re] of TOPICS) if (re.test(title)) return tag;
  if (countHits(summary) >= 2) for (const [tag, re] of TOPICS) if (re.test(summary)) return tag;
  return null;
}

// Region: Zimbabwe first, then the rest of Africa, else global.
const AFRICA = /\b(Africa|African|Algeria|Angola|Benin|Botswana|Burkina|Burundi|Cameroon|Cape Verde|Chad|Comoros|Congo|Djibouti|Egypt|Eritrea|Eswatini|Ethiopia|Gabon|Gambia|Ghana|Guinea|Ivory Coast|Côte d'Ivoire|Kenya|Lesotho|Liberia|Libya|Madagascar|Malawi|Mali|Mauritania|Mauritius|Morocco|Mozambique|Namibia|Niger|Nigeria|Rwanda|Senegal|Sierra Leone|Somalia|Sudan|Tanzania|Togo|Tunisia|Uganda|Zambia|Sahel|SADC|Horn of Africa)\b/i;
const ZIM = /\b(Zimbabwe\w*|Harare|Bulawayo|Mutare|Gweru|Masvingo|Kariba|Matabeleland|Mashonaland|Manicaland|Midlands|Chinhoyi|Marondera|Zimsec|Agritex|ZINWA|Grain Marketing Board|GMB)\b/i;
function regionOf(text, home) {
  if (ZIM.test(text) || home === 'Zimbabwe') return 'Zimbabwe';
  if (AFRICA.test(text) || (home && !['Global'].includes(home))) return 'Africa';
  return 'Global';
}

// ─── Parsing ──────────────────────────────────────────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}
function parseFeed(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map(b => {
    const tag = t => { const m = b.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${t}>`, 'i')); return m ? m[1] : ''; };
    const linkHref = (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1];
    const src = b.match(/<source[^>]*url="([^"]+)"[^>]*>([\s\S]*?)<\/source>/i);
    return {
      title: decode(tag('title')),
      url: decode(tag('link')) || linkHref || decode(tag('guid')),
      date: decode(tag('pubDate') || tag('dc:date') || tag('published') || tag('updated')),
      summary: decode(tag('description') || tag('summary') || tag('content')).slice(0, 400),
      sourceUrl: src ? src[1] : null,
      sourceName: src ? decode(src[2]) : null
    };
  });
}

const getText = (url, timeout = 9000) =>
  fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout), redirect: 'follow' }).then(r => {
    if (!r.ok) throw new Error(`${new URL(url).host} returned ${r.status}`);
    return r.text();
  });

const day = d => d.toISOString().slice(0, 10);
const addDays = (iso, n) => day(new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000));

// ─── Collectors ──────────────────────────────────────────────
async function fromFeeds() {
  const out = [];
  await Promise.allSettled(FEEDS.map(async ([url, domain]) => {
    const t = trustedOf(domain);
    const items = parseFeed(await getText(url));
    for (const it of items) out.push({ ...it, origin: 'feed', trusted: t });
  }));
  return out;
}

// Google throttles heavy use (it redirects to a "sorry" page), so every
// query is cached (15 min live, 24 h for a past date) and, once refused,
// Google is left alone for 15 minutes.
const gnCache = new Map();
let gnBlockedUntil = 0;
const googleBusy = () => Date.now() < gnBlockedUntil;
async function fromGoogleNews(date) {
  const out = [];
  const when = date ? ` after:${addDays(date, -1)} before:${addDays(date, 1)}` : ' when:2d';
  const ttl = date ? 24 * 3600 * 1000 : 15 * 60 * 1000;
  await Promise.allSettled(GN_QUERIES.map(async ([, q]) => {
    const key = q + when;
    const hit = gnCache.get(key);
    let items = hit && Date.now() - hit.at < ttl ? hit.items : null;
    if (!items) {
      if (googleBusy()) { if (hit) items = hit.items; else return; }
      else {
        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(key)}&hl=en&gl=US&ceid=US:en`;
        const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000), redirect: 'manual' });
        if (res.status !== 200) { gnBlockedUntil = Date.now() + 15 * 60 * 1000; if (hit) items = hit.items; else return; }
        else {
          items = parseFeed(await res.text());
          gnCache.set(key, { at: Date.now(), items });
          if (gnCache.size > 300) gnCache.delete(gnCache.keys().next().value);
        }
      }
    }
    for (const it of items) {
      let host = '';
      try { host = it.sourceUrl ? new URL(it.sourceUrl).host : ''; } catch {}
      // Google appends " - Outlet" to every headline.
      const title = it.sourceName && it.title.endsWith(' - ' + it.sourceName) ? it.title.slice(0, -(it.sourceName.length + 3)) : it.title;
      out.push({ ...it, title, summary: '', origin: 'google', trusted: trustedOf(host) });
    }
  }));
  return out;
}

// Archive by date straight from the outlets' own publishing systems
// (WordPress): any past day, independent of search engines.
const WP_SITES = ['newsday.co.zw', 'theindependent.co.zw', 'newzimbabwe.com', 'thestandard.co.zw', 'nyasatimes.com', 'farmersweekly.co.za', 'mongabay.com', 'agfundernews.com', 'circleofblue.org'];
const wpHost = d => (d === 'mongabay.com' ? 'news.mongabay.com' : d === 'agfundernews.com' ? 'agfundernews.com' : 'www.' + d);
async function fromWordPress(date) {
  const out = [];
  const from = addDays(date, -1), to = addDays(date, 2); // ±1 day covers every time zone
  await Promise.allSettled(WP_SITES.map(async domain => {
    const url = `https://${wpHost(domain)}/wp-json/wp/v2/posts?after=${from}T00:00:00&before=${to}T00:00:00&per_page=100&_fields=date_gmt,link,title,excerpt`;
    const posts = JSON.parse(await getText(url, 12000));
    if (!Array.isArray(posts)) return;
    for (const p of posts) out.push({ title: decode(p.title && p.title.rendered), url: p.link, date: p.date_gmt ? p.date_gmt + 'Z' : '', summary: decode(p.excerpt && p.excerpt.rendered).slice(0, 400), origin: 'archive', trusted: trustedOf(domain) });
  }));
  return out;
}

// GDELT allows one request every 5 s per client; one query per refresh.
let gdeltNext = 0;
async function fromGdelt(date) {
  if (Date.now() < gdeltNext) return [];
  gdeltNext = Date.now() + 6000;
  const q = '(drought OR "food security" OR famine OR farmers OR harvest OR irrigation OR "water scarcity" OR maize) sourcelang:english';
  const range = date ? `&startdatetime=${date.replace(/-/g, '')}000000&enddatetime=${date.replace(/-/g, '')}235959` : '&timespan=1d';
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&format=json&maxrecords=150&sort=datedesc${range}`;
  const text = await getText(url, 10000);
  if (!text.trim().startsWith('{')) return [];
  const j = JSON.parse(text);
  return (j.articles || []).map(a => {
    const s = String(a.seendate || '');
    const iso = s.length >= 15 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z` : '';
    return { title: decode(a.title), url: a.url, date: iso, summary: '', origin: 'gdelt', trusted: trustedOf(a.domain) };
  });
}

// ─── Verification, merging and ranking ───────────────────────
const words = t => new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3));
const similar = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.max(1, Math.min(a.size, b.size)); };

function verify(raw, { date, now, tzMin = 0 }) {
  const rejected = { untrusted: 0, offTopic: 0, badDate: 0, badUrl: 0 };
  const ok = [];
  for (const it of raw) {
    if (!it.trusted) { rejected.untrusted++; continue; }
    let u;
    try { u = new URL(it.url); } catch { rejected.badUrl++; continue; }
    if (!/^https?:$/.test(u.protocol) || !it.title || it.title.length < 15) { rejected.badUrl++; continue; }
    const t = Date.parse(it.date);
    if (!Number.isFinite(t) || t > now + 3600000) { rejected.badDate++; continue; }
    // A chosen date is matched in the reader's own time zone (tzMin = getTimezoneOffset()).
    if (date ? day(new Date(t - tzMin * 60000)) !== date : now - t > 7 * 86400000) { rejected.badDate++; continue; }
    const text = `${it.title} ${it.summary}`;
    const topic = topicOf(it.title, it.summary);
    if (!topic) { rejected.offTopic++; continue; }
    ok.push({ ...it, ts: t, topic, region: regionOf(text, it.trusted.home) });
  }
  // Merge the same story from several outlets; keep the earliest report.
  ok.sort((a, b) => a.ts - b.ts);
  const stories = [];
  for (const it of ok) {
    const w = words(it.title);
    const same = stories.find(s => s.url === it.url || similar(s._w, w) >= 0.75);
    if (same) {
      if (!same.outlets.includes(it.trusted.name)) same.outlets.push(it.trusted.name);
      if (!same.summary && it.summary) same.summary = it.summary;
      continue;
    }
    stories.push({ _w: w, title: it.title, url: it.url, ts: it.ts, summary: it.summary, topic: it.topic, region: it.region, source: it.trusted.name, domain: it.trusted.domain, outlets: [it.trusted.name], via: it.origin });
  }
  const articles = stories
    .sort((a, b) => b.ts - a.ts)
    .map(({ _w, ts, ...s }) => ({ ...s, id: Buffer.from(s.url).toString('base64url').slice(-24), publishedAt: new Date(ts).toISOString(), verified: true, corroboration: s.outlets.length }));
  return { articles, rejected };
}

// ─── Cache: serve instantly, refresh in the background ───────
const LIVE_TTL = 3 * 60 * 1000, PAST_TTL = 6 * 60 * 60 * 1000;
const cache = new Map(); // key: 'live' or a date → { at, value, pending }

async function collect(date, tzMin) {
  const now = Date.now();
  const [feeds, google, gdelt, archive] = await Promise.all([
    date ? Promise.resolve([]) : fromFeeds().catch(() => []),
    fromGoogleNews(date).catch(() => []),
    fromGdelt(date).catch(err => { console.warn('[news] GDELT:', err.message); return []; }),
    date ? fromWordPress(date).catch(() => []) : Promise.resolve([])
  ]);
  // Direct feeds also carry older items; for a past date use what matches.
  const pastFeeds = date && date >= day(new Date(now - 7 * 86400000)) ? await fromFeeds().catch(() => []) : [];
  const { articles, rejected } = verify([...feeds, ...pastFeeds, ...archive, ...google, ...gdelt], { date, now, tzMin });
  const sources = { feeds: feeds.length + pastFeeds.length + archive.length, google: google.length, gdelt: gdelt.length };
  console.log(`[news] ${date || 'live'}: ${articles.length} verified stories from ${sources.feeds + sources.google + sources.gdelt} items; rejected ${JSON.stringify(rejected)}`);
  // Tell the reader when a search service was busy, so a short list is not mistaken for no news.
  const partial = !sources.google && (googleBusy() || !!date);
  return { articles, checkedAt: new Date(now).toISOString(), date: date || null, scanned: sources, rejected, partial };
}

async function getNews({ date, tzMin = 0 } = {}) {
  tzMin = Math.max(-840, Math.min(840, Math.round(Number(tzMin) || 0)));
  const today = day(new Date(Date.now() - tzMin * 60000)); // the reader's local date
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today || date < '2015-02-19')) {
    const e = new Error('Choose a date between 19 Feb 2015 and today.'); e.status = 400; throw e;
  }
  if (date === today) date = null;
  const key = date ? `${date}@${tzMin}` : 'live';
  const ttl = date ? PAST_TTL : LIVE_TTL;
  const hit = cache.get(key);
  const refresh = () => {
    const p = collect(date, tzMin).then(value => {
      // Never replace good results with an empty set from a failed sweep, and
      // keep incomplete results only briefly so the next visit searches again.
      if (value.articles.length || !hit || !hit.value) cache.set(key, { at: value.partial ? Date.now() - ttl + 2 * 60 * 1000 : Date.now(), value });
      return value;
    }).finally(() => { const c = cache.get(key); if (c) c.pending = null; });
    cache.set(key, { ...(cache.get(key) || {}), pending: p });
    return p;
  };
  if (hit && hit.value) {
    if (Date.now() - hit.at > ttl && !hit.pending) refresh().catch(() => {});
    return hit.value;
  }
  if (hit && hit.pending) return hit.pending;
  const value = await refresh();
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return value;
}

module.exports = { getNews, _internal: { parseFeed, decode, verify, topicOf, regionOf, trustedOf } };
