// ════════════════════════════════════════════════════════════
//  WAFEO — PDF field analysis report
//  Builds "Analysis_Report_WAFEO_<area>.pdf" from the latest live
//  analysis: overall result, coloured field maps, every reading
//  with its meaning, warnings, forecast and actions per audience.
//  Results only: data-source names are deliberately left out.
//  Font: Helvetica, the PDF standard font metrically identical to
//  Arial (shown as Arial on Windows); 12 pt, justified text.
// ════════════════════════════════════════════════════════════
(function () {
  const PT = 12;
  const MARGIN = 20, PAGE_W = 210, PAGE_H = 297, W = PAGE_W - 2 * MARGIN;
  const LINE = PT * 0.3528 * 1.38;            // 12 pt with comfortable leading, in mm
  const GREEN = [36, 104, 52], DARK = [33, 37, 41], GREY = [100, 106, 112];
  const SEV = { critical: [201, 70, 61], high: [217, 101, 48], medium: [232, 163, 58], low: [120, 144, 156], info: [63, 143, 58] };

  // Names of satellites, models and agencies are removed from the report text.
  const SRC = '(?:Sentinel-2(?: L2A)?|Sentinel-1|Landsat(?: 8/9| 8| 9)?|ECOSTRESS|SMAP|GRACE-FO|SWOT|iSDAsoil|iSDA|SoilGrids(?: 2\\.0)?|ERA5|Open-Meteo|GloFAS|FEWS NET|GDACS|JRC GSW|JRC|ESA WorldCover|WorldCover|Copernicus DEM|Copernicus|NASA|ISRIC|CHIRPS|MODIS|IPC-compatible)';
  // The standard PDF fonts cover Windows-1252 only: map the few symbols outside it.
  const safe = t => String(t ?? '').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/≈/g, '~').replace(/₀/g, '0').replace(/[→⟶]/g, ' to ').replace(/[↑↓]/g, '').replace(/[‐‑−]/g, '-').replace(/[^\n\t\u0020-\u00FF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g, '');
  function clean(t) {
    return safe(t)
      .replace(/FEWS NET does not currently classify/g, 'No current food-security classification is published for')
      .replace(/FEWS NET food-security data unavailable/g, 'Food-security data unavailable')
      .replace(/Sentinel-2 imagery unavailable/g, 'Satellite imagery unavailable')
      .replace(/(recent|latest|newest) Sentinel-2 (pass|scene|image)/gi, '$1 satellite $2')
      .replace(/Open-Meteo soil moisture \+ SoilGrids water capacity/g, 'modelled soil moisture and soil water capacity')
      .replace(new RegExp(`since ${SRC} began`, 'g'), 'since records began')
      .replace(new RegExp(`\\(\\s*${SRC}\\s*(?:,\\s*|\\s+)?`, 'g'), '(')
      .replace(new RegExp(`\\b${SRC}\\b\\s*`, 'g'), '')
      .replace(/\(\s*\)/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([,.;:)])/g, '$1')
      .replace(/^\s*[,;:]\s*/, '')
      .replace(/(^|[.!?]\s+)([a-z])(?!H\b)/g, (m, p, c) => p + c.toUpperCase()) // leaves "pH" alone
      .trim();
  }
  const PDF_LABELS = {
    evaporativeStressIndex: 'Evaporative stress index (0–1)', evapotranspirationMmDay: 'Evapotranspiration (mm/day)', ecostressDate: 'Plant water-stress image date',
    smapSoilMoisture: 'Surface soil moisture (m³/m³)', smapSoilMoisture7d: 'Surface soil moisture, 7-day mean (m³/m³)', smapDate: 'Soil moisture image date',
    groundwaterAnomalyCm: 'Total water storage anomaly (cm)', groundwaterMonth: 'Water storage month', reservoirs: 'Reservoir and lake levels',
    isdaPh: 'pH (30 m map)', isdaNitrogenGkg: 'Nitrogen, 30 m map (g/kg)', isdaPhosphorusMgKg: 'Phosphorus, 30 m map (mg/kg)', isdaPotassiumMgKg: 'Potassium, 30 m map (mg/kg)',
    isdaZincMgKg: 'Zinc, 30 m map (mg/kg)', isdaOrganicCarbonGkg: 'Organic carbon, 30 m map (g/kg)', isdaTexture: 'Texture (30 m map)'
  };

  // Plain-language meaning for readings the pages do not explain.
  const PDF_PLAIN = {
    ndviP10: 'Greenness of the weakest tenth of the field: the patches to check first.',
    ndviP90: 'Greenness of the best tenth of the field: what the whole field could reach.',
    evi: 'Enhanced vegetation index: like NDVI but more reliable over dense crops.',
    savi: 'Soil-adjusted vegetation index: NDVI corrected for bright bare soil between plants.',
    chlorophyllIndexRedEdge: 'Leaf chlorophyll content: higher means greener, better-fed leaves.',
    ndviMonthAgo: 'Field greenness about one month ago, for comparison.',
    ndviLastYear: 'Field greenness in the same weeks last year, for comparison.',
    sparsePct: 'Share of the area with thin, patchy plant cover.',
    rain30Mm: 'Rain that fell over the last 30 days.', rain30NormalMm: 'Rain normally expected over the same 30 days.',
    rain90Mm: 'Rain that fell over the last 90 days.', rain90NormalMm: 'Rain normally expected over the same 90 days.',
    season: 'Where the area is in its rainy or dry season.', waterBalance30Mm: 'Rain minus the water lost to evaporation over the last month; negative means the soil is drying.',
    et0Past30Mm: 'How much water crops could lose to sun, heat and wind over the last month.', et0Next16Mm: 'How much water crops are expected to need over the next 16 days.',
    soilMoisture: 'Modelled water content of the soil at several depths.', landSurfaceTempP90C: 'Temperature of the hottest tenth of the area.',
    waterHistoricalMaxHa: 'Largest area of open water ever recorded here.', waterPermanentHa: 'Water that is present all year round.',
    riverDischargeM3s: 'Volume of water flowing in the nearest river each second.', riverForecastPeakPctOfMedian: 'Highest river flow expected in the next two weeks, compared with usual.',
    openWaterHa: 'Area of open water that was checked for quality.', ndti: 'Turbidity index: higher means muddier water.', ndci: 'Chlorophyll index: higher means more algae.',
    soilType: 'Main soil type, which shapes fertility and drainage.', sandPct: 'Share of sand in the topsoil.', siltPct: 'Share of silt in the topsoil.', clayPct: 'Share of clay in the topsoil.',
    bulkDensity: 'How compact the soil is; above about 1.6 roots struggle to grow.', croplandPct: 'Share of the area used as cropland.', elevationM: 'Height above sea level.',
    slopeMeanDeg: 'Average steepness of the land.', steepPct: 'Share of the area steep enough to erode easily.', landCover: 'What covers the land: crops, trees, grass, buildings or water.',
    ecostressDate: 'Date of the plant water-stress image.', smapSoilMoisture: 'Wetness of the top 5 cm of soil on the latest pass.', smapDate: 'Date of the latest soil moisture pass.',
    groundwaterAnomalyCm: 'Water stored on and under the ground compared with the long-term average.', groundwaterMonth: 'Month of the latest water storage measurement.',
    groundwaterChange1yCm: 'Change in stored water compared with a year ago.', reservoirs: 'Water levels in nearby lakes and reservoirs.',
    isdaPh: 'Soil acidity from a detailed 30 m soil map.', isdaNitrogenGkg: 'Soil nitrogen from a detailed 30 m soil map.', isdaPhosphorusMgKg: 'Plant-available phosphorus; below about 15 mg/kg crops respond to phosphate.',
    isdaPotassiumMgKg: 'Plant-available potassium; below about 100 mg/kg crops respond to potash.', isdaZincMgKg: 'Plant-available zinc; below about 1 mg/kg zinc fertiliser helps.',
    isdaOrganicCarbonGkg: 'Organic matter from a detailed 30 m soil map.', isdaTexture: 'Soil texture from a detailed 30 m soil map.'
  };

  function plainValue(k, v) {
    if (k === 'soilMoisture' && v && typeof v === 'object') return Object.entries(v).map(([d, x]) => `${d}: ${Number(x).toFixed(3)}`).join(' · ');
    if (k === 'landCover' && Array.isArray(v)) return v.map(c => `${c.name} ${c.pct}%`).join(', ');
    if (['ndviTrend', 'ndviAnomaly'].includes(k) && typeof v === 'number') return (v >= 0 ? '+' : '') + v.toFixed(2);
    if (typeof v === 'number') return Number(v.toFixed(2)).toLocaleString('en-GB', { maximumFractionDigits: 2 });
    if (Array.isArray(v)) return v.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
    if (v && typeof v === 'object') return Object.entries(v).map(([a, b]) => `${a}: ${b}`).join(', ');
    return clean(v);
  }

  const areaName = a => {
    const p = (a.data && a.data.place) || {};
    return [p.name, p.admin1 !== p.name ? p.admin1 : null, p.country].filter(Boolean).join(', ') || 'Selected area';
  };
  const fileTitle = a => {
    const p = (a.data && a.data.place) || {};
    const short = [p.name, p.country].filter(Boolean).join(' ') || 'Selected area';
    return 'Analysis_Report_WAFEO_' + short.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '');
  };

  // ─── Layout helpers ───────────────────────────────────────
  function writer(doc, title) {
    let y = MARGIN;
    const font = (style = 'normal', color = DARK) => { doc.setFont('helvetica', style); doc.setFontSize(PT); doc.setTextColor(...color); };
    const ensure = h => { if (y + h > PAGE_H - MARGIN - 8) { doc.addPage(); y = MARGIN; } };

    // Justified paragraph: every line but the last is spread to the full width.
    function para(text, opts = {}) {
      const x = MARGIN + (opts.indent || 0), width = W - (opts.indent || 0);
      font(opts.style, opts.color);
      const words = clean(text).split(/\s+/).filter(Boolean);
      if (!words.length) return;
      const lines = [];
      let cur = [];
      for (const w of words) {
        const test = cur.concat(w).join(' ');
        if (cur.length && doc.getTextWidth(test) > width) { lines.push(cur); cur = [w]; } else cur.push(w);
      }
      if (cur.length) lines.push(cur);
      lines.forEach((ws, i) => {
        ensure(LINE);
        const last = i === lines.length - 1;
        if (last || ws.length === 1 || opts.align === 'left') doc.text(ws.join(' '), x, y);
        else {
          const widths = ws.map(w => doc.getTextWidth(w));
          const gap = (width - widths.reduce((s, v) => s + v, 0)) / (ws.length - 1);
          let cx = x;
          ws.forEach((w, j) => { doc.text(w, cx, y); cx += widths[j] + gap; });
        }
        y += LINE;
      });
      y += opts.after ?? 2;
    }
    function heading(text, level = 1) {
      ensure(LINE * 3);
      y += level === 1 ? 4 : 2;
      font('bold', level === 1 ? GREEN : DARK);
      doc.text(safe(text), MARGIN, y);
      if (level === 1) { doc.setDrawColor(...GREEN); doc.setLineWidth(0.4); doc.line(MARGIN, y + 1.8, MARGIN + W, y + 1.8); y += 3; }
      y += LINE;
    }
    function table(head, body, opts = {}) {
      doc.autoTable({
        startY: y, head: head ? [head.map(safe)] : undefined, body: body.map(r => r.map(safe)), margin: { left: MARGIN, right: MARGIN, bottom: MARGIN + 8 },
        theme: 'grid',
        styles: { font: 'helvetica', fontSize: PT, cellPadding: 1.8, textColor: DARK, lineColor: [210, 214, 218], lineWidth: 0.2, valign: 'top', overflow: 'linebreak' },
        headStyles: { fillColor: GREEN, textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [246, 248, 246] },
        columnStyles: opts.columnStyles || {},
        didParseCell: opts.didParseCell
      });
      y = doc.lastAutoTable.finalY + 5;
    }
    return { font, ensure, para, heading, table, get y() { return y; }, set y(v) { y = v; }, title };
  }

  // Monthly greenness over two years, drawn as a simple line chart.
  function ndviChart(doc, w, series) {
    const pts = series.filter(p => Number.isFinite(p.ndvi));
    if (pts.length < 3) return;
    const h = 52;
    w.ensure(h + 14);
    const x0 = MARGIN + 14, x1 = MARGIN + W - 2, y0 = w.y + 2, y1 = w.y + h;
    const max = Math.max(0.8, ...pts.map(p => p.ndvi)), min = Math.min(0, ...pts.map(p => p.ndvi));
    const X = i => x0 + (i / (series.length - 1)) * (x1 - x0), Y = v => y1 - ((v - min) / (max - min)) * (y1 - y0);
    doc.setDrawColor(200); doc.setLineWidth(0.2);
    w.font('normal', GREY);
    [0, 0.2, 0.4, 0.6, 0.8].filter(v => v <= max).forEach(v => { doc.line(x0, Y(v), x1, Y(v)); doc.text(v.toFixed(1), MARGIN, Y(v) + 1.5); });
    doc.setDrawColor(...GREEN); doc.setLineWidth(0.8);
    let prev = null;
    series.forEach((p, i) => {
      if (!Number.isFinite(p.ndvi)) { prev = null; return; }
      if (prev) doc.line(X(prev.i), Y(prev.v), X(i), Y(p.ndvi));
      doc.setFillColor(...GREEN); doc.circle(X(i), Y(p.ndvi), 0.8, 'F');
      prev = { i, v: p.ndvi };
    });
    [0, Math.floor(series.length / 2), series.length - 1].forEach(i => doc.text(String(series[i].month), Math.min(X(i), x1 - 16), y1 + 5.5));
    w.y = y1 + 10;
  }

  // ─── Report ───────────────────────────────────────────────
  async function build(a) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    const title = fileTitle(a);
    doc.setProperties({ title, subject: 'WAFEO field analysis report', creator: 'WAFEO', author: 'WAFEO' });
    const w = writer(doc, title);
    const site = window.wafeoSite, explain = (window.wafeoLive && window.wafeoLive.explain) || {};
    const label = k => PDF_LABELS[k] || clean((explain[k] && explain[k].label) || site.labels[k] || k);
    // Same number formats and units as the pages, as plain text.
    const valueWithUnit = (k, v) => {
      const x = explain[k];
      if (x && typeof v === 'number') {
        const f = x.fmt ? x.fmt(v) : plainValue(k, v);
        return String(f).includes('<') ? plainValue(k, v) : clean(f + (x.unit ? ' ' + x.unit : ''));
      }
      return plainValue(k, v);
    };
    const s2 = a.data.sentinel2 || {};
    const when = new Date(a.generatedAt);

    // Title at the very top of the first page.
    doc.setFillColor(...GREEN); doc.rect(0, 0, PAGE_W, 14, 'F');
    w.font('bold', [255, 255, 255]); doc.text(safe(title), MARGIN, 9.2);
    w.y = 24;
    w.table(null, [
      ['Area analysed', areaName(a)],
      ['Centre point', `${a.aoi.centroid[1].toFixed(5)}°, ${a.aoi.centroid[0].toFixed(5)}°`],
      ['Size', `${a.aoi.areaHa.toLocaleString('en-GB')} hectares`],
      ['Analysis date', when.toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })],
      ...(s2.scene ? [['Satellite image date', `${s2.scene.date} (${s2.scene.aoiClearPct}% of the area cloud-free, ${s2.scene.resolutionM} m pixels)`]] : [])
    ], { columnStyles: { 0: { fontStyle: 'bold', cellWidth: 48 } } });

    // 1. Overall result
    w.heading('1. Overall result');
    const ov = a.overall;
    w.para(`Risk level: ${ov.riskLevel}${Number.isFinite(ov.score) ? ` · Overall condition score ${ov.score} out of 100` : ''}.`, { style: 'bold', color: SEV[{ Low: 'info', Moderate: 'medium', High: 'high', Critical: 'critical' }[ov.riskLevel]] || DARK });
    w.para(ov.headline);
    w.table(['Theme', 'Status', 'Score', 'Summary'],
      site.domains.concat([['foodSecurity', 'Food security']]).filter(([k]) => a.domains[k]).map(([k, t]) => {
        const d = a.domains[k];
        return [t, clean(d.status), Number.isFinite(d.score) ? String(d.score) : '–', clean(d.summary)];
      }), { columnStyles: { 0: { cellWidth: 32, fontStyle: 'bold' }, 1: { cellWidth: 26 }, 2: { cellWidth: 16, halign: 'center' } } });

    // 2. Colour-analysed field
    const im = s2.images;
    if (im && im.ndviMap) {
      w.heading('2. Colour-analysed field');
      w.para('The left map colours every 10 m pixel of the field by vegetation health (NDVI): browns and yellows show bare or weak cover, light to dark greens show increasingly healthy, dense crops. The right image is the same area in natural colour, with the surroundings dimmed so the analysed area stands out.');
      const size = (W - 6) / 2, ratio = im.heightPx / im.widthPx, h = Math.min(size * ratio, 95);
      w.ensure(h + 12);
      const y0 = w.y;
      doc.setFillColor(240, 242, 240); doc.rect(MARGIN, y0, size, h, 'F');
      doc.addImage(im.ndviMap, 'PNG', MARGIN, y0, h / ratio, h, undefined, 'FAST');
      doc.addImage(im.trueColor, 'PNG', MARGIN + size + 6, y0, h / ratio, h, undefined, 'FAST');
      doc.setDrawColor(180); doc.setLineWidth(0.2); doc.rect(MARGIN, y0, h / ratio, h); doc.rect(MARGIN + size + 6, y0, h / ratio, h);
      // North marker
      doc.setFillColor(255, 255, 255); doc.circle(MARGIN + h / ratio - 6, y0 + 6, 3.4, 'F');
      w.font('bold'); doc.text('N', MARGIN + h / ratio - 6, y0 + 7.4, { align: 'center' });
      w.y = y0 + h + 6;
      w.font('normal', GREY);
      doc.text('Vegetation health (NDVI)', MARGIN, w.y); doc.text('Natural colour', MARGIN + size + 6, w.y);
      w.y += LINE + 2;
      const rows = im.legend.filter(l => l.pct > 0);
      w.table(['Colour', 'Class', 'Share of field'], rows.map(l => ['', l.label, `${l.pct}%`]), {
        columnStyles: { 0: { cellWidth: 18 }, 2: { cellWidth: 34, halign: 'right' } },
        didParseCell: d => { if (d.section === 'body' && d.column.index === 0) d.cell.styles.fillColor = rows[d.row.index].color; }
      });
    }

    // 3. Warnings
    w.heading(`${im && im.ndviMap ? 3 : 2}. Priority findings`);
    if (!a.issues.length) w.para('No warning signs were found in the current readings for this area.');
    a.issues.forEach((i, n) => {
      w.ensure(LINE * 3);
      w.para(`${n + 1}. ${clean(i.title)} (${i.severity === 'info' ? 'positive' : i.severity})`, { style: 'bold', color: SEV[i.severity] || DARK, after: 0.5, align: 'left' });
      w.para(i.detail, { indent: 5 });
    });

    // 4. Detailed results
    let sec = im && im.ndviMap ? 4 : 3;
    w.heading(`${sec++}. Detailed results`);
    site.domains.concat([['foodSecurity', 'Food security']]).forEach(([k, t]) => {
      const d = a.domains[k];
      if (!d) return;
      w.heading(`${t}: ${clean(d.status)}${Number.isFinite(d.score) ? ` (${d.score}/100)` : ''}`, 2);
      w.para(d.summary);
      const rows = Object.entries(d.metrics || {}).filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([mk, v]) => [label(mk), valueWithUnit(mk, v), clean((explain[mk] && explain[mk].plain) || PDF_PLAIN[mk] || '')]);
      if (rows.length) w.table(['Reading', 'Value', 'What it means'], rows, { columnStyles: { 0: { cellWidth: 55 }, 1: { cellWidth: 40 } } });
    });

    // 5. Vegetation over two years (if already loaded or quick to load)
    try {
      const s = await Promise.race([site.ndviSeries(), new Promise((_, r) => setTimeout(() => r(new Error('slow')), 25000))]);
      const series = (s && s.series) || [];
      if (series.filter(p => Number.isFinite(p.ndvi)).length >= 3) {
        w.heading(`${sec++}. Vegetation over the last two years`);
        w.para('Monthly greenness (NDVI) of this area, from the clearest satellite image of each month. Peaks show the growing season; compare this season with the same months last year.');
        ndviChart(doc, w, series);
      }
    } catch (e) { /* the chart is optional */ }

    // 6. Weather outlook
    const fc = a.data.weather && a.data.weather.forecastDaily;
    if (fc && fc.length) {
      w.heading(`${sec++}. Weather outlook, next 16 days`);
      const rain = fc.reduce((s, r) => s + (r.rainMm || 0), 0), et0 = fc.reduce((s, r) => s + (r.et0Mm || 0), 0);
      w.para(`About ${Math.round(rain)} mm of rain is expected against a crop water demand of about ${Math.round(et0)} mm, ${rain >= et0 ? 'so rain should cover crop needs' : `a shortfall of about ${Math.round(et0 - rain)} mm that irrigation or stored soil water must cover`}. The hottest forecast day reaches ${Math.max(...fc.map(r => r.tmaxC || -99)).toFixed(0)} °C.`);
      w.table(['Date', 'Rain (mm)', 'Max temperature (°C)', 'Crop water demand (mm)'], fc.map(r => [r.date, (r.rainMm ?? 0).toFixed(1), (r.tmaxC ?? 0).toFixed(1), (r.et0Mm ?? 0).toFixed(1)]),
        { columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } } });
    }

    // 7. Hazards
    const hz = (a.data.hazards && a.data.hazards.events) || [];
    w.heading(`${sec++}. Natural hazard alerts within 600 km`);
    if (!hz.length) w.para('There are no active drought, flood, cyclone, volcano or wildfire alerts within 600 km of this area.');
    else w.table(['Hazard', 'Alert', 'Where', 'Distance', 'Active'], hz.map(e => [e.type, e.alert, e.country, `${e.distanceKm} km`, `${String(e.from).slice(0, 10)} to ${String(e.to).slice(0, 10)}`]));

    // 8. Actions
    w.heading(`${sec++}. Recommended actions, most urgent first`);
    [['farmers', 'For farmers'], ['government', 'For government and extension services'], ['public', 'For the public']].forEach(([k, t]) => {
      const list = a.recommendations[k] || [];
      if (!list.length) return;
      w.heading(t, 2);
      list.forEach((r, n) => {
        w.ensure(LINE * 3);
        w.para(`${n + 1}. ${clean(r.action)}`, { style: 'bold', after: 0.5, color: SEV[r.severity] && r.severity !== 'info' ? SEV[r.severity] : DARK });
        w.para(`Why: ${r.why}`, { indent: 5 });
      });
    });

    // 9. Notes
    w.heading(`${sec++}. How to read this report`);
    w.para('All results were measured for this exact area from the newest available satellite images, soil maps, rainfall records, river and weather models, food-security assessments and hazard alerts at the time of analysis. Satellites can see sediment and algae in water, but not bacteria, heavy metals, salinity or pH; confirm drinking-water safety with laboratory tests. Soil values are modelled estimates; confirm with a soil test before liming or applying fertiliser. Use these findings together with advice from local extension officers.');

    // Footer on every page.
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      w.font('normal', GREY);
      doc.setDrawColor(220); doc.setLineWidth(0.2); doc.line(MARGIN, PAGE_H - 13, PAGE_W - MARGIN, PAGE_H - 13);
      doc.text('WAFEO · Water, Agriculture & Food systems Earth Observation', MARGIN, PAGE_H - 8);
      doc.text(`Page ${i} of ${pages}`, PAGE_W - MARGIN, PAGE_H - 8, { align: 'right' });
    }
    return { doc, title };
  }

  async function download(btn) {
    const a = window.wafeoSite && window.wafeoSite.last();
    if (!a) {
      const msg = 'Analyse a field first: zoom into the dashboard map and click a field, or use Site Intelligence.';
      if (btn) { const old = btn.innerHTML; btn.textContent = msg; setTimeout(() => { btn.innerHTML = old; }, 4000); }
      return;
    }
    if (!window.jspdf || !window.jspdf.jsPDF || !window.jspdf.jsPDF.API.autoTable) {
      if (btn) btn.textContent = 'PDF tools are still loading. Try again in a moment.';
      return;
    }
    const html = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-circle" class="spin"></i>Preparing PDF…'; }
    try {
      const { doc, title } = await build(a);
      doc.save(title + '.pdf');
    } catch (e) {
      console.error('PDF report failed:', e);
      if (btn) btn.textContent = 'Could not create the PDF. Please try again.';
      return;
    } finally {
      if (btn) setTimeout(() => { btn.disabled = false; if (btn.textContent.startsWith('Preparing')) btn.innerHTML = html; }, 50);
    }
    if (btn) btn.innerHTML = html;
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-report-pdf]');
    if (b) { e.preventDefault(); download(b); }
  });

  // Reports page: say which area the PDF will cover.
  function updateHero() {
    const el = document.getElementById('reportHeroText');
    const a = window.wafeoSite && window.wafeoSite.last();
    if (el && a) el.textContent = `Latest analysis: ${areaName(a)}, ${a.aoi.areaHa.toLocaleString('en-GB')} ha, ${new Date(a.generatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. The PDF includes the coloured field maps, every reading with its meaning, warnings, the 16-day outlook and actions for farmers, government and the public.`;
  }
  document.addEventListener('wafeo:analysis', updateHero);
  document.addEventListener('wafeo:auth', () => setTimeout(updateHero, 500));

  window.wafeoReport = { build, download, fileTitle, clean };
})();
