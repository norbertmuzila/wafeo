// Map reference data: simplification, label placement, place kinds, zip reading.
const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { _internal: { simplifyRing, labelPoint, kindOf, readZipText }, KINDS } = require('../server/services/geo');

test('district outlines are simplified but stay closed polygons', () => {
  const ring = [];
  for (let i = 0; i <= 200; i++) { const a = (i / 200) * 2 * Math.PI; ring.push([31 + Math.cos(a) + (i % 2) * 1e-5, -18 + Math.sin(a)]); }
  ring[ring.length - 1] = ring[0];
  const s = simplifyRing(ring, 0.01);
  assert.ok(s.length < ring.length / 3 && s.length >= 4, `kept ${s.length} of ${ring.length} points`);
  assert.deepStrictEqual(s[0], s[s.length - 1]);
});

test('labels sit inside the area, even for a C-shaped district', () => {
  // A "C": its centroid falls in the empty middle.
  const c = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 8], [10, 8], [10, 10], [0, 10], [0, 0]];
  const [x, y] = labelPoint({ type: 'Polygon', coordinates: [c] });
  const inside = (x >= 0 && x <= 2 && y >= 0 && y <= 10) || (y >= 0 && y <= 2 && x <= 10) || (y >= 8 && y <= 10 && x <= 10);
  assert.ok(inside, `label at ${x},${y} is outside`);
  // A multipolygon is labelled on its largest part.
  const [mx] = labelPoint({ type: 'MultiPolygon', coordinates: [[[[50, 0], [51, 0], [51, 1], [50, 0]]], [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]]] });
  assert.ok(mx < 5);
});

test('GeoNames entries become map kinds; historical places are dropped', () => {
  const k = (c, code, pop = 0) => KINDS[kindOf(c, code, pop)];
  assert.strictEqual(k('P', 'PPLC'), 'city');
  assert.strictEqual(k('P', 'PPL', 25000), 'town');
  assert.strictEqual(k('P', 'PPL'), 'village');
  assert.strictEqual(k('S', 'SCH'), 'school');           // e.g. Mhembere School, Mashonaland East
  assert.strictEqual(k('H', 'RSV'), 'water');
  assert.strictEqual(k('T', 'HLL'), 'hill');
  assert.strictEqual(k('L', 'CTRB'), 'area');            // communal lands
  assert.strictEqual(kindOf('P', 'PPLQ', 0), null);
  assert.strictEqual(kindOf('H', 'STM', 0), null);       // streams come from OpenStreetMap instead
});

test('country files are read line by line straight from the zip archive', async () => {
  const text = 'a\tMhembere School\nb\tSecond line\nlast line without newline';
  const data = zlib.deflateRawSync(Buffer.from(text));
  const name = Buffer.from('ZW.txt');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + data.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(cdOffset, 16);
  const zip = Buffer.concat([local, name, data, central, name, end]);
  const lines = [];
  await readZipText(zip, 'ZW.txt', l => lines.push(l));
  assert.deepStrictEqual(lines, text.split('\n'));
});
