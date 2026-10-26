// End-to-end check of a running WAFEO site (live data, real services).
//   npm run e2e                       → https://wafeo-webapplication.vercel.app
//   npm run e2e -- http://localhost:8080
// Exercises every page asset and API the platform uses, with a demo
// session, and checks that the results are complete and plausible.

const BASE = (process.argv[2] || 'https://wafeo-webapplication.vercel.app').replace(/\/$/, '');
const results = [];
let token = null;

async function check(name, fn) {
  const t = Date.now();
  try {
    const note = await fn();
    results.push({ ok: true, name, ms: Date.now() - t, note: note || '' });
    console.log(`  ✓ ${name} (${Date.now() - t} ms)${note ? ' · ' + note : ''}`);
  } catch (e) {
    results.push({ ok: false, name, ms: Date.now() - t, note: e.message });
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
async function req(method, path, body, { auth = true, timeout = 90000 } = {}) {
  const res = await fetch(BASE + path, {
    method, signal: AbortSignal.timeout(timeout),
    headers: { 'Content-Type': 'application/json', ...(auth && token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, type: res.headers.get('content-type') || '' };
}

(async () => {
  console.log(`WAFEO end-to-end check · ${BASE}\n`);

  console.log('Pages and assets');
  await check('home page: title is WAFEO, no creator line, logo and scripts linked', async () => {
    const r = await req('GET', '/', null, { auth: false });
    expect(r.status === 200, 'status ' + r.status);
    expect(/<title>WAFEO<\/title>/.test(r.text), 'title is not "WAFEO"');
    expect(!/Created by Norbert|CREATED BY/i.test(r.text), 'creator line still present');
    for (const f of ['app.js', 'eo.js', 'atlas.js', 'compare.js', 'report.js', 'livenews.js', 'pages.js', 'landing.js', 'icons.js', 'assistant.js', 'style.css', 'landing.css', 'assets/wafeo-logo.svg']) expect(r.text.includes(f), f + ' not linked');
  });
  for (const [f, type] of [['/app.js', 'javascript'], ['/eo.js', 'javascript'], ['/atlas.js', 'javascript'], ['/compare.js', 'javascript'], ['/report.js', 'javascript'], ['/livenews.js', 'javascript'], ['/pages.js', 'javascript'], ['/landing.js', 'javascript'], ['/icons.js', 'javascript'], ['/assistant.js', 'javascript'], ['/style.css', 'css'], ['/landing.css', 'css'], ['/assets/wafeo-logo.svg', 'svg'], ['/assets/wafeo-icon.svg', 'svg'], ['/assets/countries.json', 'json'], ['/privacy', 'html']]) {
    await check(`asset ${f}`, async () => {
      const r = await req('GET', f, null, { auth: false, timeout: 30000 });
      expect(r.status === 200 && r.type.includes(type), `${r.status} ${r.type}`);
      if (f === '/assets/countries.json') {
        expect(r.json.length === 208, 'expected 208 countries, got ' + r.json.length);
        // Main languages come from Unicode CLDR: national languages first, no foreign or minority mix-ups.
        const langs = cc => (r.json.find(c => c.cc === cc) || {}).languages || [];
        expect(langs('zw').join() === 'Shona,English,Ndebele', 'Zimbabwe: ' + langs('zw').join(', '));
        expect(!langs('zw').some(l => /Chibarwe|Chewa/i.test(l)), 'Zimbabwe lists a minority language as main');
        const zw = r.json.find(c => c.cc === 'zw');
        expect(/Zimbabwean Gold/.test(zw.currency) && !/pula/i.test(zw.currency), 'Zimbabwe currency: ' + zw.currency);
        expect(langs('ke').includes('Swahili') && langs('ke').includes('English'), 'Kenya: ' + langs('ke').join(', '));
        expect(langs('za').includes('isiZulu') && langs('za').length <= 4, 'South Africa: ' + langs('za').join(', '));
        expect(r.json.filter(c => c.cc !== 'aq').every(c => c.languages.length >= 1 && c.languages.length <= 4), 'a country has no or too many languages');
        return 'Zimbabwe: ' + langs('zw').join(', ');
      }
    });
  }

  console.log('\nAccounts and security');
  await check('health check', async () => { const r = await req('GET', '/api/health', null, { auth: false }); expect(r.status === 200 && r.json.status === 'ok', r.text.slice(0, 120)); return `store ${r.json.store}, AI ${r.json.aiConfigured ? 'on' : 'off'}`; });
  await check('private files are not served', async () => {
    for (const [p, secret] of [['/.env', /^(JWT_SECRET|GROQ_API_KEY|EARTHDATA_TOKEN)=/m], ['/server/config.js', /module\.exports/], ['/data/users.json', /"password":\s*"/], ['/package.json', /"dependencies":/]]) {
      const r = await req('GET', p, null, { auth: false, timeout: 20000 });
      expect(!secret.test(r.text), p + ' leaked');
    }
  });
  await check('APIs refuse requests without a session', async () => {
    for (const [m, p] of [['GET', '/api/news'], ['POST', '/api/eo/analyze'], ['POST', '/api/eo/compare'], ['GET', '/api/eo/field?lon=1&lat=1'], ['GET', '/api/admin/users']]) {
      const r = await req(m, p, m === 'POST' ? {} : null, { auth: false, timeout: 20000 });
      expect(r.status === 401, `${p} gave ${r.status}`);
    }
  });
  await check('Try the demo: session without an account', async () => {
    const r = await req('POST', '/api/auth/demo', {}, { auth: false });
    expect(r.status === 200 && r.json.token && r.json.user.role === 'demo', r.text.slice(0, 120));
    token = r.json.token;
  });
  await check('demo cannot save reports or open admin pages', async () => {
    expect((await req('POST', '/api/reports', { title: 'x' })).status === 403, 'report save allowed');
    expect((await req('GET', '/api/admin/users')).status === 403, 'admin allowed');
  });

  console.log('\nSatellite analysis');
  let field = null, analysis = null;
  await check('click-to-select: traces a centre-pivot field (~47 ha)', async () => {
    const r = await req('GET', '/api/eo/field?lon=-100.7786&lat=37.9497');
    expect(r.status === 200 && r.json.found, r.text.slice(0, 160));
    expect(r.json.areaHa > 35 && r.json.areaHa < 60, 'area ' + r.json.areaHa + ' ha');
    field = r.json.geometry;
    return `${r.json.areaHa} ha, image ${r.json.sceneDate}`;
  });
  await check('open sea is refused with a clear message', async () => {
    const r = await req('POST', '/api/eo/analyze', { point: [-30.2, 0.2], radius_m: 1000 });
    expect(r.status === 400 && /sea/.test(r.json.error), `${r.status} ${r.text.slice(0, 120)}`);
  });
  await check('full analysis of a field: every domain, pictures, guidance', async () => {
    const r = await req('POST', '/api/eo/analyze', { point: [31.35, -17.85], radius_m: 600 }, { timeout: 120000 });
    expect(r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
    const a = r.json;
    analysis = a;
    expect(a.schema === 4, 'schema ' + a.schema);
    for (const k of ['crop', 'waterQuantity', 'waterQuality', 'soil', 'land', 'foodSecurity']) expect(a.domains[k], 'missing domain ' + k);
    expect(a.data.sentinel2 && a.data.sentinel2.images && a.data.sentinel2.images.ndviMap.startsWith('data:image/png'), 'no field pictures');
    for (const who of ['farmers', 'government', 'public']) expect(a.recommendations[who].length > 0, 'no guidance for ' + who);
    const live = a.sources.filter(s => s.status === 'live').map(s => s.name);
    expect(live.length >= 12, 'only ' + live.length + ' live sources');
    return `${a.overall.riskLevel} risk · ${live.length}/${a.sources.length} sources live · not live: ${a.sources.filter(s => s.status !== 'live').map(s => s.name).join(', ') || 'none'}`;
  });
  await check('results are plausible (ranges and consistency)', async () => {
    const a = analysis; expect(a, 'no analysis');
    const c = a.domains.crop.metrics, w = a.domains.waterQuantity.metrics, s = a.domains.soil.metrics;
    const inRange = (v, lo, hi, n) => expect(v === undefined || v === null || (v >= lo && v <= hi), `${n} = ${v} outside ${lo}–${hi}`);
    inRange(c.ndvi, -1, 1, 'NDVI'); inRange(c.vegetatedPct, 0, 100, 'green cover'); inRange(w.rootZoneAvailableWaterPct, 0, 100, 'root-zone water');
    inRange(w.rootZoneSeasonalPercentile, 0, 100, 'seasonal percentile'); inRange(s.pH, 3, 10, 'pH'); inRange(w.smapSoilMoisture7d, 0, 0.7, 'SMAP');
    expect(Math.abs((s.sandPct || 0) + (s.siltPct || 0) + (s.clayPct || 0) - 100) <= 2, 'texture does not add to 100%');
    if (w.season) expect(!a.issues.some(i => /rainfall deficit/i.test(i.title)), 'dry season reported as drought');
    const legend = a.data.sentinel2.images.legend.reduce((t, l) => t + l.pct, 0);
    expect(Math.abs(legend - 100) <= 1, 'picture legend adds to ' + legend + '%');
  });
  await check('two-year greenness history', async () => {
    const r = await req('POST', '/api/eo/ndvi-series', { point: [31.35, -17.85], radius_m: 600 }, { timeout: 120000 });
    expect(r.status === 200 && r.json.series.length === 24, `${r.status} ${r.text.slice(0, 120)}`);
    return `${r.json.series.filter(p => p.ndvi !== null).length}/24 months with a clear image`;
  });
  for (const months of [36, 12, 3]) {
    await check(`change over time: ${months} months, then vs now`, async () => {
      const r = await req('POST', '/api/eo/compare', { geometry: field || undefined, point: field ? undefined : [31.35, -17.85], radius_m: 600, months }, { timeout: 120000 });
      expect(r.status === 200 && r.json.available, `${r.status} ${r.text.slice(0, 160)}`);
      const c = r.json;
      expect(c.then.date < c.now.date, 'dates out of order');
      const gapDays = (Date.parse(c.now.date) - Date.parse(c.then.date)) / 86400000;
      expect(Math.abs(gapDays - months * 30.44) < 50, `images ${Math.round(gapDays)} days apart for ${months} months`);
      const share = c.change.declinedPct + c.change.improvedPct + c.change.stablePct;
      expect(Math.abs(share - 100) <= 1, 'change shares add to ' + share);
      expect(c.findings.length >= 2, 'no findings');
      return `${c.then.date} → ${c.now.date}, less green ${c.change.declinedPct}%, greener ${c.change.improvedPct}%`;
    });
  }
  await check('change over time refuses an invalid period', async () => {
    const r = await req('POST', '/api/eo/compare', { point: [31.35, -17.85], radius_m: 500, months: 200 });
    expect(r.status === 400, 'status ' + r.status);
  });
  await check('live hazards feed', async () => { const r = await req('GET', '/api/live/hazards'); expect(r.status === 200 && Array.isArray(r.json.events), r.text.slice(0, 120)); return `${r.json.events.length} events`; });

  console.log('\nMap detail');
  await check('provinces of Zimbabwe, without signing in', async () => {
    const r = await req('GET', '/api/geo/admin?iso3=ZWE&level=1', null, { auth: false, timeout: 60000 });
    const names = (r.json.labels?.features || []).map(f => f.properties.n);
    expect(r.status === 200 && names.includes('Mashonaland East') && names.length === 10, `${r.status} ${names.join(', ')}`);
    return names.length + ' provinces';
  });
  await check('districts of Zimbabwe', async () => {
    const r = await req('GET', '/api/geo/admin?iso3=ZWE&level=2', null, { auth: false, timeout: 60000 });
    const names = (r.json.labels?.features || []).map(f => f.properties.n);
    expect(r.status === 200 && ['Goromonzi', 'Murehwa', 'Marondera'].every(n => names.includes(n)), `${r.status} ${names.length} districts`);
    expect(r.json.areas.features.length === names.length, 'some district outlines are missing');
    return `${names.length} districts, ${Math.round(r.text.length / 1024)} KB`;
  });
  await check('local names around Mhembere, Mashonaland East', async () => {
    const r = await req('GET', '/api/geo/places?cc=ZW&cell=31,-18', null, { auth: false, timeout: 60000 });
    const hit = (r.json.places || []).find(p => p[0] === 'Mhembere School');
    expect(r.status === 200 && hit && Math.abs(hit[1] - 31.571) < 0.01 && Math.abs(hit[2] + 17.63) < 0.01, `${r.status} ${r.text.slice(0, 120)}`);
    return `${r.json.places.length} names in the 1° cell`;
  });
  await check('map data refuses bad requests', async () => {
    const a = await req('GET', '/api/geo/admin?iso3=Z&level=9', null, { auth: false });
    const b = await req('GET', '/api/geo/places?cc=ZWE&cell=x', null, { auth: false });
    expect(a.status === 400 && b.status === 400, `${a.status} ${b.status}`);
  });

  console.log('\nNews');
  await check('live news: verified, on-topic, recent, includes Zimbabwe', async () => {
    const r = await req('GET', '/api/news');
    expect(r.status === 200 && r.json.articles.length >= 20, `${r.status} ${r.json && r.json.articles && r.json.articles.length}`);
    const a = r.json.articles;
    expect(a.every(x => x.verified && /^https?:/.test(x.url) && Date.parse(x.publishedAt) <= Date.now() + 3600e3), 'unverified or bad article');
    expect(a.some(x => x.region === 'Zimbabwe'), 'no Zimbabwe story');
    return `${a.length} stories · ${a.filter(x => x.region === 'Zimbabwe').length} Zimbabwe · outlets: ${[...new Set(a.map(x => x.source))].length}`;
  });
  await check('news archive for a past date', async () => {
    const d = new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10);
    const r = await req('GET', `/api/news?date=${d}&tz=-120`);
    expect(r.status === 200 && r.json.articles.length > 0, `${r.status} ${r.text.slice(0, 120)}`);
    return `${r.json.articles.length} stories on ${d}`;
  });
  await check('AI assistant answers', async () => {
    const r = await req('POST', '/api/ai/chat', { messages: [{ role: 'user', content: 'In one sentence: what does NDVI measure?' }] });
    expect(r.status === 200 && r.json.reply && r.json.reply.length > 20, `${r.status} ${r.text.slice(0, 160)}`);
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ' · FAILED: ' + failed.map(f => f.name).join('; ') : ''}`);
  process.exit(failed.length ? 1 : 0);
})();
