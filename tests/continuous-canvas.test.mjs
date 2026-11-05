import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { mergePublicFeeds, imageBoundsFromConfig, studyNeighborhoods, unobscuredPoint } from '../public/prototypes/continuous-map/canvas-model.mjs';

const first = { id: 'one', address: 'Test coordinate A', latitude: 27.79, longitude: -82.64 };
const feed = (listings, index = 0) => ({ neighborhood: studyNeighborhoods[index], listings });

test('an exposed marker stays still and an obstructed marker takes a short visible path around actual controls', () => {
  const size = {x:667,y:320};
  const obstacles = [{left:12,top:8,right:655,bottom:64},{left:12,top:140,right:322,bottom:208},{left:607,top:160,right:655,bottom:248}];
  assert.deepEqual(unobscuredPoint({x:450,y:120},size,obstacles),{x:450,y:120});
  const moved=unobscuredPoint({x:150,y:175},size,obstacles);
  assert.ok(moved.x>=25 && moved.x<=size.x-25 && moved.y>=25 && moved.y<=size.y-25);
  assert.ok(!obstacles.some(box=>moved.x+25>box.left&&moved.x-25<box.right&&moved.y+25>box.top&&moved.y-25<box.bottom));
  assert.ok(Math.hypot(moved.x-150,moved.y-175)<100);
});

test('canonical records dedupe across feeds without merging coincident distinct IDs', () => {
  const records = mergePublicFeeds([feed([first]), feed([first, { ...first, id: 'two' }], 1)]);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.id), ['one', 'two']);
  assert.equal(records[1].neighborhoodId, 'crescent-lake');
});

test('invalid or contradictory public coordinates never produce a silent count', () => {
  for (const listing of [{ ...first, latitude: NaN }, { ...first, longitude: 181 }, { ...first, id: '' }, { ...first, address: null }]) {
    assert.throws(() => mergePublicFeeds([feed([listing])]), /invalid coordinates or identity/);
  }
  assert.throws(() => mergePublicFeeds([feed(null)]), /invalid list/);
  assert.throws(() => mergePublicFeeds([feed([first]), feed([{ ...first, latitude: 28 }], 1)]), /conflicting coordinates/);
  assert.deepEqual(mergePublicFeeds([feed([]), feed([], 1)]), []);
});

test('art placement metadata remains tied to original per-map bounds and source-sized memory estimates', async () => {
  const base = new URL('../public/', import.meta.url);
  const artworks = JSON.parse(await readFile(new URL('prototypes/continuous-map/data/artwork.json', base)));
  assert.equal(artworks.length, 2);
  let total = 0;
  for (const art of artworks) {
    const configPath = art.id === 'old-northeast' ? 'data/neighborhood.json' : `data/${art.id}/neighborhood.json`;
    const config = JSON.parse(await readFile(new URL(configPath, base)));
    const expected = imageBoundsFromConfig(config);
    art.bounds.flat().forEach((value, index) => assert.ok(Math.abs(value - expected.flat()[index]) < 1e-9));
    assert.ok(art.width <= 2048 && art.height <= 2048);
    assert.equal(art.decodedBytes, art.width * art.height * 4);
    assert.equal(art.sourceSha256, createHash('sha256').update(await readFile(new URL(config.artwork, base))).digest('hex'));
    total += art.decodedBytes;
  }
  assert.ok(total < 32 * 1024 * 1024);
});

test('context bytes, safe fields and geographic clipping agree with their source notice', async () => {
  const base = new URL('../public/prototypes/continuous-map/data/', import.meta.url);
  const bytes = await readFile(new URL('context.geojson', base));
  const context = JSON.parse(bytes), notice = JSON.parse(await readFile(new URL('source-notices.json', base)));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), notice.publicFeatureCollectionSha256);
  assert.equal(bytes.length, notice.publicFeatureCollectionBytes);
  assert.equal(context.features.length, notice.featureCounts.total);
  const ids = new Set(), [w,s,e,n] = context.bbox;
  function checkCoordinates(coordinates) {
    if (typeof coordinates[0] === 'number') {
      assert.ok(coordinates[0] >= w && coordinates[0] <= e && coordinates[1] >= s && coordinates[1] <= n);
    } else coordinates.forEach(checkCoordinates);
  }
  for (const feature of context.features) {
    assert.deepEqual(Object.keys(feature.properties).sort(), ['kind','name','source','sourceId']);
    assert.ok(['road','water'].includes(feature.properties.kind));
    assert.ok(!ids.has(feature.properties.sourceId)); ids.add(feature.properties.sourceId);
    checkCoordinates(feature.geometry.coordinates);
  }
});
