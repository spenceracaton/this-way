import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { project, mapPoint, mapBounds } from '../public/coordinates.mjs';
import { samplePins } from '../public/sample-pins.mjs';
import { neighborhoods, neighborhoodFor } from '../public/neighborhoods.mjs';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const area = JSON.parse(await read('public/data/neighborhood.json'));
const geography = JSON.parse(await read('public/data/geography.json'));
const provenance = JSON.parse(await read('public/data/provenance.json'));
const svg = await read('public/assets/old-northeast.svg');
const crescentArea = JSON.parse(await read('public/data/crescent-lake/neighborhood.json'));
const crescentGeography = JSON.parse(await read('public/data/crescent-lake/geography.json'));
const crescentProvenance = JSON.parse(await read('public/data/crescent-lake/provenance.json'));
const crescentSvg = await read('public/assets/crescent-lake.svg');

// Retained OSM road vertices still guard the original geography independently of address samples.
const oldRoadReferences = [
  { id: 'a', label: 'A', name: '9th Avenue & Oak Street', lat: 27.781256, lng: -82.6315704,
    expected: [378.61, 824.39], osmWay: '11237875', note: 'Southern reference · road intersection' },
  { id: 'b', label: 'B', name: 'North Shore Drive', lat: 27.7849981, lng: -82.6250337,
    expected: [600.85, 680.32], osmWay: '83871993', note: 'Coastal reference · near the shoreline' },
  { id: 'c', label: 'C', name: 'Coffee Pot Boulevard', lat: 27.7924502, lng: -82.628787,
    expected: [473.24, 393.42], osmWay: '46691560', note: 'Northern reference · curved road' },
  { id: 'd', label: 'D', name: '18th Avenue & Locust Street', lat: 27.7889593, lng: -82.6302972,
    expected: [421.90, 527.82], osmWay: '11235187', note: 'Central reference · road intersection' }
];
const crescentRoadReferences = [
      { id: 'a', label: 'A', name: '21st Avenue North', lat: 27.7912981, lng: -82.6461788,
        expected: [186.55, 201.74], osmWay: '11247855', note: 'Northwest reference · road vertex' },
      { id: 'b', label: 'B', name: '18th Avenue & 5th Street', lat: 27.7887945, lng: -82.6400818,
        expected: [725.27, 451.79], osmWay: '11230466', note: 'Eastern reference · beside the lake park' },
      { id: 'c', label: 'C', name: '7th Street & 12th Avenue', lat: 27.7843828, lng: -82.6426216,
        expected: [500.86, 892.41], osmWay: '11224662', note: 'Southern reference · road intersection' },
      { id: 'd', label: 'D', name: 'Highland Street North', lat: 27.7866351, lng: -82.645669,
        expected: [231.60, 667.46], osmWay: '11233813', note: 'Western reference · road vertex' }
    ];

for (const [mapId, config, pins] of [
  ['Old Northeast', area, samplePins],
  ['Crescent Lake', crescentArea, neighborhoods['crescent-lake'].pins]
]) {
  for (const pin of pins) {
    test(`${mapId} sample ${pin.label}: public numbered address aligns with its map marker`, () => {
      assert.match(pin.name, /^\d+\s/);
      const source = new URL(pin.sourceUrl);
      assert.equal(source.hostname, 'frightthisway.com');
      assert.match(source.searchParams.get('house') || '', /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      const result = project(pin, config.projection);
      assert.ok(Math.abs(result.x - pin.expected[0]) < 0.01);
      assert.ok(Math.abs(result.y - pin.expected[1]) < 0.01);
      assert.deepEqual(mapPoint(result), [-result.y, result.x]);
    });
  }
}

for (const pin of oldRoadReferences) {
  test(`reference ${pin.label}: original road coordinate and independent artwork anchor agree`, () => {
    const road = geography.features.find(f => f.osm_way_id === pin.osmWay);
    assert.ok(road.coordinates_lat_lon.some(([lat, lng]) => lat === pin.lat && lng === pin.lng));
    const result = project(pin, area.projection);
    assert.ok(Math.abs(result.x - pin.expected[0]) < 0.01);
    assert.ok(Math.abs(result.y - pin.expected[1]) < 0.01);
    assert.deepEqual(mapPoint(result), [-result.y, result.x]);
  });
}

test('the north/south axis and full artwork extent remain correctly oriented', () => {
  const north = project({ lat: 27.80, lng: -82.63 }, area.projection);
  const south = project({ lat: 27.78, lng: -82.63 }, area.projection);
  assert.ok(mapPoint(north)[0] > mapPoint(south)[0]);
  assert.deepEqual(mapBounds(area.bounds), [[-1072, 30], [-15, 835]]);
  assert.match(svg, /viewBox="30 15 805 1057"/);
});

test('invalid coordinates cannot silently become a pin', () => {
  for (const point of [{ lat: NaN, lng: 0 }, { lat: 0, lng: Infinity }, { lat: 100, lng: 0 }, { lat: 0, lng: -200 }]) {
    assert.throws(() => project(point, area.projection), TypeError);
  }
});

test('core shoreline mask is preserved and the nearby mask retains its hole', () => {
  const mask = svg.match(/<mask\b[^>]*id="spotlight"[^>]*>([\s\S]*?)<\/mask>/)[1];
  const path = mask.match(/<path\b[^>]*d="([^"]+)"/)[1];
  assert.equal(createHash('sha256').update(path).digest('hex'), provenance.coreMaskPathSha256);
  assert.match(svg, /<mask\b[^>]*id="nearbyBlocksMask"/);
  assert.match(svg, /fill-rule="evenodd"/);
  assert.match(svg, /href="#nearbyBlocksArtwork" mask="url\(#nearbyBlocksMask\)"/);
  assert.doesNotMatch(svg, /feGaussianBlur|filter=|<script|onload=|id="(?:ghost|pumpkin|trees|markers|routeLayer)"/);
});

for (const pin of crescentRoadReferences) {
  test(`Crescent Lake reference ${pin.label}: OSM road coordinate and independent artwork anchor agree`, () => {
    const road = crescentGeography.features.find(feature => feature.id === `way/${pin.osmWay}`);
    assert.ok(road.geometry.coordinates.some(([lng, lat]) => lat === pin.lat && lng === pin.lng));
    const result = project(pin, crescentArea.projection);
    assert.ok(Math.abs(result.x - pin.expected[0]) < 0.01);
    assert.ok(Math.abs(result.y - pin.expected[1]) < 0.01);
    assert.deepEqual(mapPoint(result), [-result.y, result.x]);
  });
}

test('Crescent Lake keeps its independent extent, core mask, lake and raster source', () => {
  assert.deepEqual(mapBounds(crescentArea.bounds), [[-1040, 20], [-20, 980]]);
  assert.match(crescentSvg, /viewBox="20 20 960 1020"/);
  assert.equal(crescentArea.rasterArtwork, './assets/crescent-lake.webp');
  const mask = crescentSvg.match(/<mask\b[^>]*id="spotlight"[^>]*>([\s\S]*?)<\/mask>/)[1];
  const maskPath = mask.match(/<path\b[^>]*d="([^"]+)"/)[1];
  assert.equal(createHash('sha256').update(maskPath).digest('hex'), crescentProvenance.coreMaskPathSha256);
  const lakeTag = crescentSvg.match(/<path\b(?=[^>]*id="crescent-lake-water")[^>]*>/)[0];
  const lakePath = lakeTag.match(/d="([^"]+)"/)[1];
  assert.equal(createHash('sha256').update(lakePath).digest('hex'), crescentProvenance.lakePathSha256);
  assert.doesNotMatch(crescentSvg, /feGaussianBlur|filter=|<script|onload=|id="(?:ghost|pumpkin|trees|markers|routeLayer)"/);
});

test('neighborhood selection is explicit and rejects unknown map IDs', () => {
  assert.equal(neighborhoodFor('').id, 'old-northeast');
  assert.equal(neighborhoodFor('?neighborhood=crescent-lake').id, 'crescent-lake');
  assert.throws(() => neighborhoodFor('?neighborhood=not-real'), /Unknown neighborhood/);
});

test('vendored Leaflet bytes match the official stable-release integrity hashes', async () => {
  for (const [file, expected] of [['leaflet.js', '20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='], ['leaflet.css', 'p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=']]) {
    const bytes = await readFile(new URL('../public/vendor/leaflet/' + file, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('base64'), expected);
  }
});
