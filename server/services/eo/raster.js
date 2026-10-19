// ─── Read only the pixels covering an AOI from cloud GeoTIFFs ─
// Uses HTTP range requests, so a farm costs kilobytes, not whole scenes.

// geotiff's CommonJS build require()s an ESM-only dependency, which Vercel's
// runtime rejects; load its ES module build instead.
let geotiffModule = null;
const geotiff = () => (geotiffModule ||= import('geotiff'));
const { projectRing, pointInRing } = require('./geo');

const MAX_PIXELS = 160000; // 400 × 400 per band keeps memory and time bounded

// A pixel grid in the raster's CRS covering the AOI, plus the AOI mask.
function makeGrid(aoi, epsg, nativeRes) {
  const ring = projectRing(aoi, epsg);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  const span = (maxX - minX) * (maxY - minY);
  const res = Math.max(nativeRes, Math.sqrt(span / MAX_PIXELS));
  // Small farms still get at least a few pixels across.
  const width = Math.max(3, Math.ceil((maxX - minX) / res));
  const height = Math.max(3, Math.ceil((maxY - minY) / res));
  const bbox = [minX, minY, minX + width * res, minY + height * res];
  const mask = new Uint8Array(width * height);
  let inside = 0;
  for (let r = 0; r < height; r++) {
    const y = bbox[3] - (r + 0.5) * res;
    for (let c = 0; c < width; c++) {
      const x = bbox[0] + (c + 0.5) * res;
      if (pointInRing(x, y, ring)) { mask[r * width + c] = 1; inside++; }
    }
  }
  // A tiny polygon may fall between pixel centres: keep the centre pixel.
  if (!inside) { mask[Math.floor(height / 2) * width + Math.floor(width / 2)] = 1; inside = 1; }
  return { epsg: Number(epsg), bbox, width, height, res, mask, inside };
}

const tiffCache = new Map();
function openTiff(href) {
  const key = href.split('?')[0];
  if (!tiffCache.has(key)) {
    tiffCache.set(key, geotiff().then(g => g.fromUrl(href, { allowFullFile: false })).catch(err => { tiffCache.delete(key); throw err; }));
    if (tiffCache.size > 200) tiffCache.delete(tiffCache.keys().next().value);
  }
  return tiffCache.get(key);
}

// Read one single-band COG onto the grid (nearest neighbour).
async function readBand(href, grid, fillValue = 0) {
  const tiff = await openTiff(href);
  const [band] = await tiff.readRasters({
    bbox: grid.bbox, width: grid.width, height: grid.height,
    resampleMethod: 'nearest', fillValue, interleave: false
  });
  return band;
}

// Decode a small GeoTIFF already downloaded (e.g. from a WCS service).
async function decodeSmallTiff(buffer) {
  const tiff = await (await geotiff()).fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const [band] = await image.readRasters();
  return { band, width: image.getWidth(), height: image.getHeight(), bbox: image.getBoundingBox(), nodata: image.getGDALNoData() };
}

function stats(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = p => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { mean, median: q(0.5), p10: q(0.1), p90: q(0.9), min: v[0], max: v[v.length - 1], n: v.length };
}

module.exports = { makeGrid, readBand, decodeSmallTiff, stats, MAX_PIXELS };
