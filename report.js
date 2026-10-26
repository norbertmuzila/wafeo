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
    rootZoneSeasonalPercentile: 'Compared with the same weeks in past years: 50 is normal, below 20 unusually dry, above 80 unusually wet.',
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
        styles: { font: 'helvetica', fontSize: PT, fillColor: false, cellPadding: 1.8, textColor: DARK, lineColor: [210, 214, 218], lineWidth: 0.2, valign: 'top', overflow: 'linebreak' },
        headStyles: { fillColor: GREEN, textColor: 255, fontStyle: 'bold' },
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

  // ─── Logo watermark ───────────────────────────────────────
  // The WAFEO logo as vector paths (same shapes as assets/wafeo-logo.svg),
  // so the watermark stays sharp at any zoom or print size.
  const LOGO = {
    box: [185, 352, 1075, 390],
    parts: [
      ['#0070C0', 'M197 366H315L482 613L521 565L575 643C560 679 530 718 490 727C462 732 436 718 420 698Z'],
      ['#0070C0', 'M604 430L644 364H758C730 410 690 468 661 515Z'],
      ['#0070C0', 'M945 500H1152L1086 595H938V723H847V647Z'],
      ['#000000', 'M415 366H536L690 605C693 610 696 613 698 613C702 609 718 580 730 563C760 522 800 465 842 407C860 382 888 366 920 366H1247L1180 460H923C918 460 914 463 912 466L768 685C752 708 735 728 700 728C672 728 660 716 650 702Z'],
      ['#000000', 'M642 527L745 530V539L648 538Z']
    ]
  };
  function drawLogo(doc, x, y, width, opacity) {
    const [bx, by, bw] = LOGO.box, k = width / bw;
    const X = v => x + (v - bx) * k, Y = v => y + (v - by) * k;
    doc.saveGraphicsState();
    doc.setGState(new doc.GState({ opacity, 'stroke-opacity': opacity }));
    for (const [color, d] of LOGO.parts) {
      doc.setFillColor(color);
      const t = d.match(/[MHVLCZ]|-?\d+(?:\.\d+)?/g);
      let i = 0, cx = 0, cy = 0, cmd = null;
      const n = () => Number(t[i++]);
      while (i < t.length) {
        if (/^[MHVLCZ]$/.test(t[i])) cmd = t[i++];
        if (cmd === 'M') { cx = n(); cy = n(); doc.moveTo(X(cx), Y(cy)); cmd = 'L'; }
        else if (cmd === 'L') { cx = n(); cy = n(); doc.lineTo(X(cx), Y(cy)); }
        else if (cmd === 'H') { cx = n(); doc.lineTo(X(cx), Y(cy)); }
        else if (cmd === 'V') { cy = n(); doc.lineTo(X(cx), Y(cy)); }
        else if (cmd === 'C') { const a = [n(), n(), n(), n(), n(), n()]; doc.curveTo(X(a[0]), Y(a[1]), X(a[2]), Y(a[3]), X(a[4]), Y(a[5])); cx = a[4]; cy = a[5]; }
        else if (cmd === 'Z') { doc.close(); if (i < t.length && !/^[MHVLCZ]$/.test(t[i])) break; }
        else break;
      }
      doc.fill();
    }
    doc.restoreGraphicsState();
  }
  // Large and faint, centred on the page, drawn before the page content.
  const WATERMARK_W = 160;
  const watermark = doc => drawLogo(doc, (PAGE_W - WATERMARK_W) / 2, (PAGE_H - WATERMARK_W * LOGO.box[3] / LOGO.box[2]) / 2, WATERMARK_W, 0.07);

  // ─── Chart helpers (vector, 12 pt text) ───────────────────
  const hex = c => (Array.isArray(c) ? c : [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]);
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const num = (v, d = 0) => (Number.isFinite(v) ? Number(v.toFixed(d)).toLocaleString('en-GB', { maximumFractionDigits: d }) : '–');

  // Horizontal bars: [{ label, value, max, color, text }]
  function hbars(doc, w, rows, { labelW = 58 } = {}) {
    const rowH = 9;
    w.ensure(rows.length * rowH + 4);
    const x0 = MARGIN + labelW, x1 = MARGIN + W - 26;
    rows.forEach((r, i) => {
      const y = w.y + i * rowH;
      w.font('normal', DARK); doc.text(safe(r.label), MARGIN, y + 5.2);
      doc.setFillColor(236, 239, 236); doc.rect(x0, y + 1, x1 - x0, 5.5, 'F');
      const frac = Math.max(0, Math.min(1, (r.value || 0) / (r.max || 1)));
      doc.setFillColor(...hex(r.color)); doc.rect(x0, y + 1, (x1 - x0) * frac, 5.5, 'F');
      w.font('bold', DARK); doc.text(safe(r.text ?? num(r.value)), MARGIN + W, y + 5.2, { align: 'right' });
    });
    w.y += rows.length * rowH + 3;
  }

  // One full-width stacked bar with a legend: [{ label, pct, color }]
  function stackBar(doc, w, segs) {
    w.ensure(28);
    const y = w.y, h = 9;
    let x = MARGIN;
    const total = segs.reduce((s, g) => s + (g.pct || 0), 0) || 1;
    segs.forEach(g => {
      const ww = W * (g.pct || 0) / total;
      doc.setFillColor(...hex(g.color)); doc.rect(x, y, ww, h, 'F');
      x += ww;
    });
    doc.setDrawColor(200); doc.setLineWidth(0.2); doc.rect(MARGIN, y, W, h);
    w.y = y + h + 6;
    let lx = MARGIN;
    segs.forEach(g => {
      const t = `${g.label} ${num(g.pct, 0)}%`;
      w.font('normal', DARK);
      const tw = doc.getTextWidth(t) + 9;
      if (lx + tw > MARGIN + W) { lx = MARGIN; w.y += LINE; }
      doc.setFillColor(...hex(g.color)); doc.rect(lx, w.y - 3.2, 4, 4, 'F');
      doc.text(safe(t), lx + 5.5, w.y);
      lx += tw + 4;
    });
    w.y += LINE + 1;
  }

  // Colour scale with a marker: stops [[0..1, color]], ticks [[value, label]]
  function scale(doc, w, { label, min, max, value, stops, ticks, valueText }) {
    if (!Number.isFinite(value)) return;
    w.ensure(30);
    w.font('bold', DARK); doc.text(safe(label), MARGIN, w.y);
    w.font('bold', DARK); doc.text(safe(valueText), MARGIN + W, w.y, { align: 'right' });
    const y = w.y + 3, h = 6, n = 80;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
      doc.setFillColor(...mix(hex(c0), hex(c1), Math.max(0, Math.min(1, (t - t0) / ((t1 - t0) || 1)))));
      doc.rect(MARGIN + (W * i) / n, y, W / n + 0.2, h, 'F');
    }
    const px = MARGIN + W * Math.max(0, Math.min(1, (value - min) / (max - min)));
    doc.setFillColor(...DARK); doc.triangle(px - 2.4, y - 2.6, px + 2.4, y - 2.6, px, y + 0.6, 'F');
    doc.setDrawColor(...DARK); doc.setLineWidth(0.6); doc.line(px, y, px, y + h);
    w.font('normal', GREY);
    ticks.forEach(([v, t], i) => {
      const tx = MARGIN + W * (v - min) / (max - min);
      doc.text(safe(t), tx, y + h + 5, { align: i === 0 ? 'left' : i === ticks.length - 1 ? 'right' : 'center' });
    });
    w.y = y + h + 11;
  }

  // Vertical grouped bars: groups [{ label, bars: [{ value, color }] }], series [{ name, color }]
  function groupBars(doc, w, groups, series, unit) {
    const h = 50;
    w.ensure(h + 22);
    const x0 = MARGIN + 16, x1 = MARGIN + W, y0 = w.y + 2, y1 = w.y + h;
    const max = Math.max(1, ...groups.flatMap(g => g.bars.map(b => b.value || 0))) * 1.15;
    const Y = v => y1 - (v / max) * (y1 - y0);
    doc.setDrawColor(215); doc.setLineWidth(0.2);
    w.font('normal', GREY);
    [0, 0.5, 1].forEach(f => { const v = max / 1.15 * f; doc.line(x0, Y(v), x1, Y(v)); doc.text(num(v, 0), MARGIN, Y(v) + 1.5); });
    const gw = (x1 - x0) / groups.length, bw = Math.min(16, (gw - 10) / series.length);
    groups.forEach((g, gi) => {
      const gx = x0 + gi * gw + (gw - bw * series.length) / 2;
      g.bars.forEach((b, bi) => {
        doc.setFillColor(...hex(series[bi].color));
        doc.rect(gx + bi * bw, Y(b.value || 0), bw - 1.5, y1 - Y(b.value || 0), 'F');
        w.font('bold', DARK); doc.text(`${num(b.value, 0)}`, gx + bi * bw + (bw - 1.5) / 2, Y(b.value || 0) - 1.5, { align: 'center' });
      });
      w.font('normal', DARK); doc.text(safe(g.label), x0 + gi * gw + gw / 2, y1 + 5.5, { align: 'center' });
    });
    w.y = y1 + 11;
    let lx = MARGIN;
    series.forEach(s => { doc.setFillColor(...hex(s.color)); doc.rect(lx, w.y - 3.2, 4, 4, 'F'); w.font('normal', DARK); doc.text(safe(s.name + (unit ? ` (${unit})` : '')), lx + 5.5, w.y); lx += doc.getTextWidth(s.name + (unit ? ` (${unit})` : '')) + 14; });
    w.y += LINE + 1;
  }

  // 16-day outlook: rain bars and crop water need line.
  function forecastChart(doc, w, fc) {
    const h = 52;
    w.ensure(h + 22);
    const x0 = MARGIN + 12, x1 = MARGIN + W, y0 = w.y + 2, y1 = w.y + h;
    const max = Math.max(5, ...fc.map(r => Math.max(r.rainMm || 0, r.et0Mm || 0))) * 1.15;
    const Y = v => y1 - (v / max) * (y1 - y0);
    const step = (x1 - x0) / fc.length;
    doc.setDrawColor(215); doc.setLineWidth(0.2); w.font('normal', GREY);
    [0, 0.5, 1].forEach(f => { const v = max / 1.15 * f; doc.line(x0, Y(v), x1, Y(v)); doc.text(num(v, 0), MARGIN, Y(v) + 1.5); });
    fc.forEach((r, i) => { doc.setFillColor(58, 134, 200); doc.rect(x0 + i * step + step * 0.18, Y(r.rainMm || 0), step * 0.64, y1 - Y(r.rainMm || 0), 'F'); });
    doc.setDrawColor(232, 163, 58); doc.setLineWidth(0.9);
    fc.forEach((r, i) => { if (i) doc.line(x0 + (i - 0.5) * step, Y(fc[i - 1].et0Mm || 0), x0 + (i + 0.5) * step, Y(r.et0Mm || 0)); });
    w.font('normal', DARK);
    fc.forEach((r, i) => { if (i % 3 === 0) doc.text(r.date.slice(8, 10) + '/' + r.date.slice(5, 7), x0 + (i + 0.5) * step, y1 + 5.5, { align: 'center' }); });
    w.y = y1 + 11;
    doc.setFillColor(58, 134, 200); doc.rect(MARGIN, w.y - 3.2, 4, 4, 'F'); doc.text('Rain (mm)', MARGIN + 5.5, w.y);
    doc.setDrawColor(232, 163, 58); doc.setLineWidth(0.9); doc.line(MARGIN + 40, w.y - 1.2, MARGIN + 46, w.y - 1.2); doc.text('Crop water need (mm)', MARGIN + 48, w.y);
    w.y += LINE + 1;
  }

  // IPC phase boxes: now -> coming months.
  const IPC = { 1: [205, 250, 205], 2: [250, 230, 30], 3: [230, 120, 0], 4: [200, 0, 0], 5: [100, 0, 0] };
  function ipcRow(doc, w, steps) {
    const list = steps.filter(Boolean);
    if (!list.length) return;
    w.ensure(30);
    const bw = Math.min(54, (W - (list.length - 1) * 8) / list.length), y = w.y;
    list.forEach((s, i) => {
      const x = MARGIN + i * (bw + 8);
      doc.setFillColor(...(IPC[s.phase] || [220, 220, 220])); doc.roundedRect(x, y, bw, 22, 2, 2, 'F');
      const txt = s.phase >= 4 ? [255, 255, 255] : DARK;
      w.font('bold', txt); doc.text(`Phase ${s.phase}: ${safe(s.label)}`, x + 3, y + 7);
      w.font('normal', txt); doc.text(safe(s.when), x + 3, y + 13); doc.text(safe(s.period.replace(' to ', ' – ').slice(0, 26)), x + 3, y + 19);
      if (i < list.length - 1) { w.font('bold', DARK); doc.text('>', x + bw + 2.5, y + 13); }
    });
    w.y = y + 28;
  }

  // Location map from imagery tiles (about 60 km across) with the area outlined.
  async function locationMap(a) {
    const z = 11, T = 256;
    const [lon, lat] = a.aoi.centroid;
    const wx = l => ((l + 180) / 360) * T * 2 ** z;
    const wy = p => { const s = Math.sin(p * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * T * 2 ** z; };
    const cx = wx(lon), cy = wy(lat), W2 = 720, H2 = 430;
    const left = cx - W2 / 2, top = cy - H2 / 2;
    const cv = document.createElement('canvas'); cv.width = W2; cv.height = H2;
    const ctx = cv.getContext('2d');
    const tile = (url) => new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = rej; im.src = url; setTimeout(() => rej(new Error('tile timeout')), 12000); });
    const jobs = [];
    for (let tx = Math.floor(left / T); tx <= Math.floor((left + W2) / T); tx++) {
      for (let ty = Math.floor(top / T); ty <= Math.floor((top + H2) / T); ty++) {
        const x = tx * T - left, y = ty * T - top;
        jobs.push(tile(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`).then(im => ctx.drawImage(im, x, y)));
        jobs.push(tile(`https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${ty}/${tx}`).then(im => ({ im, x, y })));
      }
    }
    const done = await Promise.all(jobs.map(j => j.catch(() => null)));
    if (done.filter(d => d === undefined).length < 2) throw new Error('imagery unavailable');
    done.filter(d => d && d.im).forEach(d => ctx.drawImage(d.im, d.x, d.y));
    ctx.lineWidth = 3; ctx.strokeStyle = '#FFD54F'; ctx.fillStyle = 'rgba(255,213,79,0.25)';
    ctx.beginPath();
    a.aoi.geometry.coordinates[0].forEach(([x, y], i) => { const px = wx(x) - left, py = wy(y) - top; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(W2 / 2, H2 / 2, 9, 0, 2 * Math.PI); ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    // 10 km scale bar
    const mPerPx = 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** z, bar = 10000 / mPerPx;
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(14, H2 - 34, bar + 60, 22);
    ctx.fillStyle = '#222'; ctx.fillRect(20, H2 - 22, bar, 4); ctx.font = 'bold 14px Arial'; ctx.fillText('10 km', bar + 26, H2 - 17);
    return cv.toDataURL('image/jpeg', 0.86);
  }

  function addImg(doc, w, src, ratio, maxH = 110) {
    const h = Math.min(W * ratio, maxH), wd = h / ratio;
    w.ensure(h + 4);
    doc.addImage(src, src.startsWith('data:image/png') ? 'PNG' : 'JPEG', MARGIN + (W - wd) / 2, w.y, wd, h, undefined, 'FAST');
    doc.setDrawColor(180); doc.setLineWidth(0.2); doc.rect(MARGIN + (W - wd) / 2, w.y, wd, h);
    w.y += h + 5;
  }

  // ─── Report ───────────────────────────────────────────────
  const PDF_LIBS = ['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'];
  async function pdfTools() {
    for (const u of PDF_LIBS) await window.loadAsset(u);           // autotable needs jsPDF first
    if (!window.jspdf || !window.jspdf.jsPDF || !window.jspdf.jsPDF.API.autoTable) throw new Error('PDF tools did not load');
  }

  async function build(a) {
    await pdfTools();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    const title = fileTitle(a);
    doc.setProperties({ title, subject: 'WAFEO field analysis report', creator: 'WAFEO', author: 'WAFEO' });
    watermark(doc);
    doc.internal.events.subscribe('addPage', () => watermark(doc));
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
    const D = a.domains, crop = (D.crop && D.crop.metrics) || {}, water = (D.waterQuantity && D.waterQuantity.metrics) || {}, soil = (D.soil && D.soil.metrics) || {};
    const dry = !!water.season;

    // Slow extras load in parallel, each optional.
    const within = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('slow')), ms))]);
    const [seriesR, compareR, mapR] = await Promise.allSettled([
      within(site.ndviSeries(), 30000),
      window.wafeoCompare ? within(window.wafeoCompare.get(a, window.wafeoCompare.months()), 55000) : Promise.reject(new Error('none')),
      within(locationMap(a), 20000)
    ]);

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

    let sec = 1;
    // Keep a heading on the same page as the start of its section (need = mm).
    const H = (t, need = 0) => { w.ensure(need + LINE * 3); w.heading(`${sec++}. ${t}`); };

    // Overall result with a score chart
    H('Overall result');
    const ov = a.overall;
    w.para(`Risk level: ${ov.riskLevel}${Number.isFinite(ov.score) ? ` · Overall condition score ${ov.score} out of 100` : ''}.`, { style: 'bold', color: SEV[{ Low: 'info', Moderate: 'medium', High: 'high', Critical: 'critical' }[ov.riskLevel]] || DARK });
    w.para(ov.headline);
    const themes = site.domains.concat([['foodSecurity', 'Food security']]).filter(([k]) => D[k]);
    const scored = themes.filter(([k]) => Number.isFinite(D[k].score));
    if (scored.length) {
      const col = s => (s >= 70 ? '#2f8f46' : s >= 50 ? '#e8a33a' : '#c9463d');
      hbars(doc, w, scored.map(([k, t]) => ({ label: t, value: D[k].score, max: 100, color: col(D[k].score), text: `${D[k].score}/100` })));
      const sorted = scored.slice().sort((x, y) => D[x[0]].score - D[y[0]].score);
      w.para(`Condition scores run from 0 (critical) to 100 (good). The weakest theme is ${sorted[0][1].toLowerCase()} (${D[sorted[0][0]].score}/100), which needs attention first${sorted.length > 1 ? `; the strongest is ${sorted[sorted.length - 1][1].toLowerCase()} (${D[sorted[sorted.length - 1][0]].score}/100)` : ''}.`);
    }
    w.table(['Theme', 'Status', 'Score', 'Summary'],
      themes.map(([k, t]) => [t, clean(D[k].status), Number.isFinite(D[k].score) ? String(D[k].score) : '–', clean(D[k].summary)]),
      { columnStyles: { 0: { cellWidth: 32, fontStyle: 'bold' }, 1: { cellWidth: 26 }, 2: { cellWidth: 16, halign: 'center' } } });

    // Location
    if (mapR.status === 'fulfilled') {
      H('Location', 105);
      addImg(doc, w, mapR.value, 430 / 720, 100);
      w.para(`The analysed area (outlined in yellow) lies in ${areaName(a)}, centred at ${a.aoi.centroid[1].toFixed(4)}°, ${a.aoi.centroid[0].toFixed(4)}°. The map shows about 60 km of the surrounding landscape.`);
    }

    // Colour-analysed field, cover and zones
    const im = s2.images;
    if (im && im.ndviMap) {
      H('Colour-analysed field', 130);
      w.para('The left map colours every 10 m pixel of the field by vegetation health (NDVI): browns and yellows show bare or weak cover, light to dark greens show increasingly healthy, dense crops. The right image is the same area in natural colour, with the surroundings faded so the analysed area stands out.');
      const size = (W - 6) / 2, ratio = im.heightPx / im.widthPx, h = Math.min(size * ratio, 95);
      w.ensure(h + 12);
      const y0 = w.y;
      doc.addImage(im.ndviMap, 'PNG', MARGIN, y0, h / ratio, h, undefined, 'FAST');
      doc.addImage(im.trueColor, 'PNG', MARGIN + size + 6, y0, h / ratio, h, undefined, 'FAST');
      doc.setDrawColor(180); doc.setLineWidth(0.2); doc.rect(MARGIN, y0, h / ratio, h); doc.rect(MARGIN + size + 6, y0, h / ratio, h);
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
    if (Number.isFinite(crop.vegetatedPct) || Number.isFinite(crop.ndviP10)) {
      w.ensure(70); w.heading('Plant cover and field zones', 2);
      if (Number.isFinite(crop.vegetatedPct)) {
        stackBar(doc, w, [{ label: 'Green crops', pct: crop.vegetatedPct, color: '#2f8f46' }, { label: 'Sparse', pct: crop.sparsePct, color: '#c9b458' }, { label: 'Bare', pct: crop.barePct, color: '#a0725a' }]);
      }
      if (Number.isFinite(crop.ndviP10) && Number.isFinite(crop.ndviP90)) {
        hbars(doc, w, [
          { label: 'Weakest 10% of the field', value: crop.ndviP10, max: 1, color: '#c9463d', text: num(crop.ndviP10, 2) },
          { label: 'Typical part of the field', value: crop.ndvi, max: 1, color: '#e8a33a', text: num(crop.ndvi, 2) },
          { label: 'Best 10% of the field', value: crop.ndviP90, max: 1, color: '#2f8f46', text: num(crop.ndviP90, 2) }
        ]);
        const gap = crop.ndviP90 - crop.ndviP10;
        w.para(`${num(crop.vegetatedPct, 0)}% of the area has well-growing plants, ${num(crop.sparsePct, 0)}% is sparse and ${num(crop.barePct, 0)}% is bare. The gap between the weakest and best parts of the field is ${num(gap, 2)} NDVI: ${gap >= 0.25 ? 'the field is uneven, so walk the weakest patches first and target inputs there.' : gap >= 0.12 ? 'some unevenness; check the weaker patches for pests, weeds or waterlogging.' : 'the field is fairly even.'}${dry ? ' Low greenness is normal in the dry season before planting.' : ''}`);
      }
    }

    // Change over time
    const cmp = compareR.status === 'fulfilled' ? compareR.value : null;
    if (cmp && cmp.available) {
      H(`Change over time: ${window.wafeoCompare.label(cmp.months)} versus now`, 110);
      w.para(`The same area on ${cmp.then.date} (left) and ${cmp.now.date} (right), followed by a map of where it became greener or less green.`);
      const size = (W - 6) / 2, ratio = cmp.now.images.heightPx / cmp.now.images.widthPx, h = Math.min(size * ratio, 80);
      w.ensure(h + 12);
      const y0 = w.y;
      doc.addImage(cmp.then.images.trueColor, 'PNG', MARGIN, y0, h / ratio, h, undefined, 'FAST');
      doc.addImage(cmp.now.images.trueColor, 'PNG', MARGIN + size + 6, y0, h / ratio, h, undefined, 'FAST');
      doc.setDrawColor(180); doc.setLineWidth(0.2); doc.rect(MARGIN, y0, h / ratio, h); doc.rect(MARGIN + size + 6, y0, h / ratio, h);
      w.y = y0 + h + 6; w.font('normal', GREY);
      doc.text(`Then: ${cmp.then.date}`, MARGIN, w.y); doc.text(`Now: ${cmp.now.date}`, MARGIN + size + 6, w.y);
      w.y += LINE + 2;
      addImg(doc, w, cmp.change.image, ratio, 80);
      const cl = cmp.change.legend.filter(l => l.pct > 0);
      w.table(['Colour', 'Change in greenness', 'Share', 'Area'], cl.map(l => ['', l.label, `${l.pct}%`, `${l.ha} ha`]), {
        columnStyles: { 0: { cellWidth: 18 }, 2: { cellWidth: 24, halign: 'right' }, 3: { cellWidth: 26, halign: 'right' } },
        didParseCell: d => { if (d.section === 'body' && d.column.index === 0) d.cell.styles.fillColor = cl[d.row.index].color; }
      });
      const s0 = cmp.then.stats, s1 = cmp.now.stats, dlt = (x, y, d = 1) => (Number.isFinite(x) && Number.isFinite(y) ? (Math.abs(y - x) < 0.5 * 10 ** -d ? 'no change' : `${y - x > 0 ? '+' : ''}${num(y - x, d)}`) : '–');
      w.table(['Measure', `Then (${cmp.then.date})`, `Now (${cmp.now.date})`, 'Change'], [
        ['Average greenness (NDVI)', num(s0.meanNdvi, 2), num(s1.meanNdvi, 2), dlt(s0.meanNdvi, s1.meanNdvi, 2)],
        ['Well-vegetated cover', `${num(s0.greenCoverPct, 1)}%`, `${num(s1.greenCoverPct, 1)}%`, dlt(s0.greenCoverPct, s1.greenCoverPct)],
        ['Bare soil', `${num(s0.bareSoilPct, 1)}%`, `${num(s1.bareSoilPct, 1)}%`, dlt(s0.bareSoilPct, s1.bareSoilPct)],
        ['Open water', `${num(s0.openWaterHa, 1)} ha`, `${num(s1.openWaterHa, 1)} ha`, dlt(s0.openWaterHa, s1.openWaterHa)]
      ], { columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } } });
      cmp.findings.forEach(f => w.para(`• ${f}`, { indent: 2 }));
    }

    // Priority findings
    H('Priority findings');
    if (!a.issues.length) w.para('No warning signs were found in the current readings for this area.');
    a.issues.forEach((i, n) => {
      w.ensure(LINE * 3);
      w.para(`${n + 1}. ${clean(i.title)} (${i.severity === 'info' ? 'positive' : i.severity})`, { style: 'bold', color: SEV[i.severity] || DARK, after: 0.5, align: 'left' });
      w.para(i.detail, { indent: 5 });
    });

    // Crops: two-year greenness
    const series = seriesR.status === 'fulfilled' ? ((seriesR.value && seriesR.value.series) || []) : [];
    const pts = series.filter(p => Number.isFinite(p.ndvi));
    if (pts.length >= 3) {
      H('Crops: greenness over the last two years', 75);
      ndviChart(doc, w, series);
      const last = pts[pts.length - 1], peak = pts.reduce((m, p) => (p.ndvi > m.ndvi ? p : m), pts[0]);
      const yearAgo = series.find(p => p.month === `${Number(last.month.slice(0, 4)) - 1}${last.month.slice(4)}`);
      w.para(`Monthly greenness (NDVI) from the clearest image of each month. The latest reading (${last.month}) is ${num(last.ndvi, 2)}; the highest in the period was ${num(peak.ndvi, 2)} in ${peak.month}, which marks the peak of the growing season.${yearAgo && Number.isFinite(yearAgo.ndvi) ? ` A year earlier (${yearAgo.month}) it was ${num(yearAgo.ndvi, 2)}, so the area is ${last.ndvi - yearAgo.ndvi >= 0.05 ? 'greener' : last.ndvi - yearAgo.ndvi <= -0.05 ? 'less green' : 'about as green'} than at the same time last year.` : ''}`);
    }

    // Water: rain, outlook, meters
    const fc = a.data.weather && a.data.weather.forecastDaily;
    if (Number.isFinite(water.rain30Mm) || (fc && fc.length)) {
      H('Water: rainfall, outlook and soil water', 85);
      if (Number.isFinite(water.rain30Mm) && Number.isFinite(water.rain90Mm)) {
        w.ensure(75); w.heading('Rain compared with normal', 2);
        groupBars(doc, w, [
          { label: 'Last 30 days', bars: [{ value: water.rain30Mm }, { value: water.rain30NormalMm }] },
          { label: 'Last 90 days', bars: [{ value: water.rain90Mm }, { value: water.rain90NormalMm }] }
        ], [{ name: 'This year', color: '#3a86c8' }, { name: 'Normal', color: '#b8c4cf' }], 'mm');
        w.para(dry
          ? `${num(water.rain90Mm, 0)} mm fell over the last 90 days against a normal of ${num(water.rain90NormalMm, 0)} mm. It is the dry season here, so totals are small and percentages of normal are not meaningful; watch the start of the rains instead.`
          : `${num(water.rain90Mm, 0)} mm fell over the last 90 days against a normal of ${num(water.rain90NormalMm, 0)} mm (${num(water.rain90PctNormal, 0)}% of normal), and ${num(water.rain30Mm, 0)} mm over the last 30 days (normal ${num(water.rain30NormalMm, 0)} mm).`);
      }
      if (fc && fc.length) {
        w.ensure(80); w.heading('Next 16 days: rain versus crop water need', 2);
        forecastChart(doc, w, fc);
        const rain = fc.reduce((s, r) => s + (r.rainMm || 0), 0), et0 = fc.reduce((s, r) => s + (r.et0Mm || 0), 0);
        const wet = fc.filter(r => (r.rainMm || 0) >= 2).map(r => r.date.slice(8, 10) + '/' + r.date.slice(5, 7));
        w.para(`About ${Math.round(rain)} mm of rain is expected against a crop water need of about ${Math.round(et0)} mm, ${rain >= et0 ? 'so rain should cover crop needs' : `a shortfall of about ${Math.round(et0 - rain)} mm that irrigation or stored soil water must cover`}. ${wet.length ? `Rain days: ${wet.slice(0, 8).join(', ')}.` : 'No day with meaningful rain is forecast.'} The hottest forecast day reaches ${Math.max(...fc.map(r => r.tmaxC ?? -99)).toFixed(0)} °C.`);
        w.table(['Date', 'Rain (mm)', 'Max temperature (°C)', 'Crop water need (mm)'], fc.map(r => [r.date, (r.rainMm ?? 0).toFixed(1), (r.tmaxC ?? 0).toFixed(1), (r.et0Mm ?? 0).toFixed(1)]),
          { columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } } });
      }
      const esi = crop.evaporativeStressIndex;
      if ((!dry && Number.isFinite(water.spi90)) || Number.isFinite(water.rootZoneAvailableWaterPct) || Number.isFinite(esi)) {
        w.ensure(60); w.heading('Drought and soil water gauges', 2);
        if (!dry) scale(doc, w, { label: 'Drought index (SPI-90)', min: -3, max: 3, value: water.spi90, valueText: num(water.spi90, 2), stops: [[0, '#8b1a1a'], [0.33, '#e8a33a'], [0.5, '#e9e4c8'], [0.75, '#7fbf7b'], [1, '#2b6cb0']], ticks: [[-3, 'Extreme drought'], [0, 'Normal'], [3, 'Very wet']] });
        scale(doc, w, { label: 'Soil water around roots', min: 0, max: 100, value: water.rootZoneAvailableWaterPct, valueText: `${num(water.rootZoneAvailableWaterPct, 0)}% of usual range`, stops: [[0, '#c9463d'], [0.4, '#e8a33a'], [1, '#2b6cb0']], ticks: [[0, 'Driest in 10 years'], [50, 'Middle'], [100, 'Wettest']] });
        scale(doc, w, { label: 'Crop thirst (evaporative stress index)', min: 0, max: 1, value: esi, valueText: num(esi, 2), stops: [[0, '#c9463d'], [0.4, '#e8a33a'], [1, '#2f8f46']], ticks: [[0, 'Very thirsty'], [0.4, 'Stressed'], [1, 'No stress']] });
        const bits = [];
        if (!dry && Number.isFinite(water.spi90)) bits.push(water.spi90 <= -1 ? `The drought index (${num(water.spi90, 2)}) shows drought conditions.` : water.spi90 >= 1.5 ? `The drought index (${num(water.spi90, 2)}) shows much wetter than normal conditions.` : `The drought index (${num(water.spi90, 2)}) is within the normal range.`);
        if (Number.isFinite(water.rootZoneAvailableWaterPct)) bits.push(`Soil water around the roots is at ${num(water.rootZoneAvailableWaterPct, 0)}% of its usual range here (0% is the driest and 100% the wettest in the last 10 years)${Number.isFinite(water.rootZoneSeasonalPercentile) ? `, and ${water.rootZoneSeasonalPercentile >= 60 ? 'wetter than usual' : water.rootZoneSeasonalPercentile <= 40 ? 'drier than usual' : 'about normal'} for this time of year` : ''}${water.rootZoneAvailableWaterPct < 25 ? '; plants will soon run short of water without rain or irrigation' : ''}.`);
        if (Number.isFinite(esi)) bits.push(esi < 0.4 ? `Crops are using only about ${Math.round(esi * 100)}% of the water they could, a sign of water stress 1–2 weeks before leaves wilt.` : `Crops are not showing water stress (index ${num(esi, 2)}).`);
        if (bits.length) w.para(bits.join(' '));
      }
    }

    // Soil: texture and acidity
    const ph = Number.isFinite(soil.pH) ? soil.pH : soil.isdaPh;
    if (Number.isFinite(soil.sandPct) || Number.isFinite(ph)) {
      H('Soil: what it is made of and its acidity', 50);
      if (Number.isFinite(soil.sandPct)) {
        stackBar(doc, w, [{ label: 'Sand', pct: soil.sandPct, color: '#e2c08d' }, { label: 'Silt', pct: soil.siltPct, color: '#b9a38a' }, { label: 'Clay', pct: soil.clayPct, color: '#8a5a44' }]);
        w.para(`${clean(soil.texture || 'This soil')}${soil.soilType ? ` (${clean(soil.soilType)})` : ''}: ${soil.sandPct > 60 ? 'sandy soils drain fast and need water and fertiliser more often, in smaller doses.' : soil.clayPct > 35 ? 'clay soils hold water and nutrients well but can waterlog and crack; avoid working them wet.' : 'a balanced soil that holds water and nutrients reasonably well.'}`);
      }
      if (Number.isFinite(ph)) {
        scale(doc, w, { label: 'Soil acidity (pH)', min: 4, max: 9, value: ph, valueText: num(ph, 1), stops: [[0, '#c9463d'], [0.3, '#e8a33a'], [0.5, '#2f8f46'], [0.7, '#2f8f46'], [1, '#5db8da']], ticks: [[4, '4 Very acidic'], [5.5, '5.5'], [7, '7 Neutral'], [9, '9 Alkaline']] });
        w.para(ph < 5 ? `pH ${num(ph, 1)} is strongly acidic: apply lime before planting, or fertiliser will be wasted.` : ph < 5.5 ? `pH ${num(ph, 1)} is acidic: liming will improve how well crops use fertiliser.` : ph <= 7.5 ? `pH ${num(ph, 1)} is in the good range for most crops.` : `pH ${num(ph, 1)} is alkaline: watch for zinc and iron shortage.`);
      }
    }

    // Food security
    const f = a.data.foodSecurity;
    if (f && f.available) {
      H('Food security', 45);
      ipcRow(doc, w, [
        f.current && { ...f.current, when: 'Now' },
        f.nearTerm && { ...f.nearTerm, when: 'Coming months' },
        f.mediumTerm && { ...f.mediumTerm, when: 'Later' }
      ]);
      const people = n => (n && n.low !== null ? `${(n.low / 1e6).toFixed(1)}–${((n.high ?? n.low) / 1e6).toFixed(1)} million` : null);
      const nat = people(f.nationalPhase3Plus), proj = people(f.nationalPhase3PlusProjected);
      w.para(`${clean(D.foodSecurity && D.foodSecurity.summary)} IPC phases run from 1 (minimal) to 5 (famine); phase 3 or worse means families cannot meet their food needs without selling assets or receiving help.${nat ? ` Nationally, ${nat} people are in phase 3 or worse${proj ? `, projected ${proj} at the peak` : ''}.` : ''}`);
    }

    // All readings
    H('Detailed results: every reading');
    themes.forEach(([k, t]) => {
      const d = D[k];
      w.heading(`${t}: ${clean(d.status)}${Number.isFinite(d.score) ? ` (${d.score}/100)` : ''}`, 2);
      w.para(d.summary);
      // In the dry season, percent-of-normal rainfall is misleading (tiny normals), as on the pages.
      const dryHidden = d.metrics && d.metrics.season ? ['rain90PctNormal', 'rain30PctNormal', 'spi90'] : [];
      const rows = Object.entries(d.metrics || {}).filter(([mk, v]) => v !== null && v !== undefined && v !== '' && !dryHidden.includes(mk))
        .map(([mk, v]) => [label(mk), valueWithUnit(mk, v), clean((explain[mk] && explain[mk].plain) || PDF_PLAIN[mk] || '')]);
      if (rows.length) w.table(['Reading', 'Value', 'What it means'], rows, { columnStyles: { 0: { cellWidth: 55 }, 1: { cellWidth: 40 } } });
    });

    // Hazards
    const hz = (a.data.hazards && a.data.hazards.events) || [];
    H('Natural hazard alerts within 600 km');
    if (!hz.length) w.para('There are no active drought, flood, cyclone, volcano or wildfire alerts within 600 km of this area.');
    else {
      w.table(['Hazard', 'Alert', 'Where', 'Distance', 'Active'], hz.map(e => [e.type, e.alert, e.country, `${e.distanceKm} km`, `${String(e.from).slice(0, 10)} to ${String(e.to).slice(0, 10)}`]));
      const severe = hz.filter(e => e.alert === 'red' || e.alert === 'orange');
      w.para(severe.length ? `${severe.length} orange or red alert${severe.length > 1 ? 's are' : ' is'} active within 600 km; the nearest is a ${severe.sort((x, y) => x.distanceKm - y.distanceKm)[0].type.toLowerCase()} ${severe[0].distanceKm} km away. Follow official warnings.` : 'Only minor (green) alerts are active nearby.');
    }

    // Actions
    H('Recommended actions, most urgent first');
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

    H('How to read this report');
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
      const msg = tapText('Analyse a field first: zoom into the dashboard map and click a field, or use Site Intelligence.');
      if (btn) { const old = btn.innerHTML; btn.textContent = msg; setTimeout(() => { btn.innerHTML = old; }, 4000); }
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
    if (el && a) el.textContent = `Latest analysis: ${areaName(a)}, ${a.aoi.areaHa.toLocaleString('en-GB')} ha, ${new Date(a.generatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. The PDF includes a location map, the coloured field maps, change over time, every chart from the platform with what it means, warnings, the 16-day outlook and actions for farmers, government and the public.`;
  }
  document.addEventListener('wafeo:analysis', updateHero);
  document.addEventListener('wafeo:auth', () => setTimeout(updateHero, 500));

  window.wafeoReport = { build, download, fileTitle, clean };
})();
