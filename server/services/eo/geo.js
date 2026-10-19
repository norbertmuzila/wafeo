// ─── Geometry helpers for areas of interest (AOI) ────────────
// All input geometry is GeoJSON in WGS84 lon/lat.

const proj4 = require('proj4');

const MAX_AREA_KM2 = 2500; // ~50 km × 50 km: a district, not a country

function circlePolygon([lon, lat], radiusM, steps = 48) {
  const ring = [];
  const dLat = radiusM / 110540;
  const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

// Accepts { geometry: Polygon } or { point: [lon, lat], radius_m }.
function normalizeAoi(body) {
  let geometry = body && body.geometry;
  if (!geometry && body && Array.isArray(body.point)) {
    const radius = Math.min(Math.max(Number(body.radius_m) || 1000, 50), 25000);
    geometry = circlePolygon(body.point.map(Number), radius);
  }
  if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates?.[0])) {
    throw httpError(400, 'Provide a farm polygon (GeoJSON Polygon) or a point with a radius.');
  }
  const ring = geometry.coordinates[0].map(([x, y]) => [Number(x), Number(y)]);
  if (ring.length < 4 || ring.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90)) {
    throw httpError(400, 'The area outline is not valid.');
  }
  const first = ring[0], last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  const aoi = { type: 'Polygon', coordinates: [ring] };
  const areaKm2 = areaHa(aoi) / 100;
  if (areaKm2 > MAX_AREA_KM2) throw httpError(400, `Area is ${Math.round(areaKm2)} km². Please select up to ${MAX_AREA_KM2} km² (a farm or district).`);
  if (areaKm2 < 0.001) throw httpError(400, 'Area is too small. Draw at least a few field-sized points.');
  return aoi;
}

function bbox(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of geom.coordinates[0]) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function centroid(geom) {
  const [a, b, c, d] = bbox(geom);
  return [(a + c) / 2, (b + d) / 2];
}

// Spherical-excess area of a lon/lat ring, in hectares.
function areaHa(geom) {
  const R = 6378137, ring = geom.coordinates[0];
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
    sum += (x2 - x1) * Math.PI / 180 * (2 + Math.sin(y1 * Math.PI / 180) + Math.sin(y2 * Math.PI / 180));
  }
  return Math.abs(sum * R * R / 2) / 10000;
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// proj4 definition for the EPSG codes satellite tiles use.
function projDef(epsg) {
  epsg = Number(epsg);
  if (epsg === 4326) return 'EPSG:4326';
  if (epsg >= 32601 && epsg <= 32660) return `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`;
  if (epsg >= 32701 && epsg <= 32760) return `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`;
  throw new Error('Unsupported projection EPSG:' + epsg);
}

// Reproject the AOI ring into a raster's CRS.
function projectRing(geom, epsg) {
  const def = projDef(epsg);
  if (def === 'EPSG:4326') return geom.coordinates[0];
  const fwd = proj4('EPSG:4326', def).forward;
  return geom.coordinates[0].map(p => fwd(p));
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { normalizeAoi, bbox, centroid, areaHa, pointInRing, projectRing, projDef, httpError, MAX_AREA_KM2 };
