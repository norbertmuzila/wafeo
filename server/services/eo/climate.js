// ─── Weather, rainfall anomaly, soil moisture, river flow ─────
// Open-Meteo (keyless): forecast + recent days, ERA5 reanalysis archive
// for the 25-year rainfall baseline, and GloFAS river discharge.

const { getJson, isoDay, daysAgo } = require('./net');

const sum = a => a.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

async function weather([lon, lat], now = new Date()) {
  const url = 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    '&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m' +
    '&daily=precipitation_sum,et0_fao_evapotranspiration,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&hourly=soil_moisture_0_to_1cm,soil_moisture_3_to_9cm,soil_moisture_9_to_27cm,soil_moisture_27_to_81cm' +
    '&past_days=90&forecast_days=16&timezone=auto';
  const j = await getJson(url, { timeout: 15000 });
  const d = j.daily;
  const todayIdx = d.time.indexOf(isoDay(new Date(now.getTime() + (j.utc_offset_seconds || 0) * 1000)));
  const t = todayIdx >= 0 ? todayIdx : 90;
  const past = (arr, n) => arr.slice(Math.max(0, t - n), t);
  const next = (arr, n) => arr.slice(t, t + n);
  const hourIdx = Math.min(j.hourly.time.length - 1, t * 24 + new Date().getUTCHours());
  const sm = k => round(j.hourly[k]?.[hourIdx], 3);
  return {
    available: true,
    current: { tempC: j.current?.temperature_2m, humidityPct: j.current?.relative_humidity_2m, windKmh: j.current?.wind_speed_10m },
    past30: { rainMm: round(sum(past(d.precipitation_sum, 30))), et0Mm: round(sum(past(d.et0_fao_evapotranspiration, 30))) },
    past90: { rainMm: round(sum(past(d.precipitation_sum, 90))), et0Mm: round(sum(past(d.et0_fao_evapotranspiration, 90))) },
    next16: {
      rainMm: round(sum(next(d.precipitation_sum, 16))),
      et0Mm: round(sum(next(d.et0_fao_evapotranspiration, 16))),
      rainyDays: next(d.precipitation_sum, 16).filter(v => v >= 2).length,
      hotDays: next(d.temperature_2m_max, 16).filter(v => v >= 35).length,
      maxTempC: round(Math.max(...next(d.temperature_2m_max, 16).filter(Number.isFinite)))
    },
    soilMoisture: { '0-1cm': sm('soil_moisture_0_to_1cm'), '3-9cm': sm('soil_moisture_3_to_9cm'), '9-27cm': sm('soil_moisture_9_to_27cm'), '27-81cm': sm('soil_moisture_27_to_81cm') },
    forecastDaily: next(d.time, 16).map((date, i) => ({ date, rainMm: d.precipitation_sum[t + i], tmaxC: d.temperature_2m_max[t + i], et0Mm: d.et0_fao_evapotranspiration[t + i] }))
  };
}

// Rainfall in the last 30 / 90 days versus the same calendar window since 2001.
async function rainfallAnomaly([lon, lat], recent, now = new Date()) {
  const end = daysAgo(6, now); // ERA5 lags by ~5 days
  const url = 'https://archive-api.open-meteo.com/v1/archive' +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&start_date=2001-01-01&end_date=${isoDay(end)}&daily=precipitation_sum&timezone=auto`;
  const j = await getJson(url, { timeout: 25000 });
  const byDay = new Map(j.daily.time.map((t, i) => [t, j.daily.precipitation_sum[i]]));
  const windowSum = (endDate, days) => {
    let s = 0, n = 0;
    for (let k = 1; k <= days; k++) {
      const v = byDay.get(isoDay(daysAgo(k - 1, endDate)));
      if (Number.isFinite(v)) { s += v; n++; }
    }
    return n >= days * 0.9 ? s : null;
  };
  const result = {};
  for (const days of [30, 90]) {
    const years = [];
    for (let y = 2001; y < now.getUTCFullYear(); y++) {
      const shifted = new Date(Date.UTC(y, end.getUTCMonth(), end.getUTCDate()));
      const v = windowSum(shifted, days);
      if (v !== null) years.push(v);
    }
    const current = windowSum(end, days);
    const mean = years.reduce((a, b) => a + b, 0) / years.length;
    const sd = Math.sqrt(years.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, years.length - 1));
    result[`d${days}`] = {
      currentMm: round(current), normalMm: round(mean), pctOfNormal: mean > 1 ? Math.round((current / mean) * 100) : null,
      zScore: sd > 0.5 ? round((current - mean) / sd, 2) : null, years: years.length
    };
  }
  result.baseline = `ERA5 reanalysis, 2001–${now.getUTCFullYear() - 1}, window ending ${isoDay(end)}`;
  return { available: true, ...result };
}

async function riverFlow([lon, lat]) {
  const url = 'https://flood-api.open-meteo.com/v1/flood' +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    '&daily=river_discharge,river_discharge_median,river_discharge_max&past_days=7&forecast_days=14';
  const j = await getJson(url, { timeout: 15000 });
  const d = j.daily;
  const i = 7;
  const now = d.river_discharge?.[i], median = d.river_discharge_median?.[i];
  if (!Number.isFinite(now)) return { available: false, reason: 'No modelled river near this point.' };
  const fc = d.river_discharge.slice(i, i + 14).filter(Number.isFinite);
  const fcMed = d.river_discharge_median.slice(i, i + 14).filter(Number.isFinite);
  const peak = Math.max(...fc), peakIdx = fc.indexOf(peak);
  return {
    available: true,
    note: 'Nearest GloFAS river cell (~5 km grid); small streams are not modelled.',
    dischargeM3s: round(now, 2),
    medianM3s: round(median, 2),
    pctOfMedian: median > 0.01 ? Math.round((now / median) * 100) : null,
    forecastPeakM3s: round(peak, 2),
    forecastPeakPctOfMedian: fcMed[peakIdx] > 0.01 ? Math.round((peak / fcMed[peakIdx]) * 100) : null,
    forecastPeakDate: d.time[i + peakIdx]
  };
}

module.exports = { weather, rainfallAnomaly, riverFlow };
