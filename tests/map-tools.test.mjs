import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { filterPins, normalizeFilters, filterStorageKey, classifyLocation, createNearMeController } from '../public/map-tools-state.mjs';
import { buildCoverage } from '../scripts/build-near-me-coverage.mjs';

const coverage = { version: 1, neighborhoods: [{ id: 'a', name: 'A', core: [[-82.65, 27.78], [-82.63, 27.78], [-82.63, 27.80], [-82.65, 27.80]] }] };
const position = { lat: 27.79, lng: -82.64, accuracy: 10 };
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const calls = [], states = [], located = [], neighborhoods = []; let reads = 0;
  const controller = createNearMeController({
    geolocation: { getCurrentPosition(success, error, options) { calls.push({ success, error, options }); } },
    fetchCoverage: () => { reads++; return options.fetchCoverage?.() ?? Promise.resolve(coverage); },
    neighborhoodId: options.neighborhoodId ?? 'a', onState: state => states.push(state),
    onLocate: point => located.push(point), onNeighborhood: area => neighborhoods.push(area)
  });
  return { controller, calls, states, located, neighborhoods, reads: () => reads,
    fix(point = position) { calls.at(-1).success({ coords: { latitude: point.lat, longitude: point.lng, accuracy: point.accuracy } }); } };
}

test('filters use trimmed titles and actual photos with AND semantics', () => {
  const pins = [{ id: 'neither', title: ' ', photos: [] }, { id: 'theme', title: ' Lanterns ', photos: [] }, { id: 'photo', title: '', photos: ['/photo'] }, { id: 'both', title: 'Stars', photos: ['/photo'] }];
  for (const [filters, ids] of [[{}, ['neither', 'theme', 'photo', 'both']], [{ themed: true }, ['theme', 'both']], [{ photos: true }, ['photo', 'both']], [{ themed: true, photos: true }, ['both']]]) assert.deepEqual(filterPins(pins, filters).map(pin => pin.id), ids);
  assert.deepEqual(normalizeFilters({ themed: 'true', photos: 1 }), { themed: false, photos: false });
  assert.notEqual(filterStorageKey('christmas-2026'), filterStorageKey('halloween-2026'));
});

test('location requires the full accuracy circle inside a unique core', () => {
  assert.equal(classifyLocation(position, coverage).kind, 'inside');
  assert.equal(classifyLocation({ ...position, accuracy: 2000 }, coverage).kind, 'approximate');
  assert.equal(classifyLocation({ ...position, lng: -82.63005 }, coverage).kind, 'approximate');
  assert.equal(classifyLocation({ ...position, lng: -82.63, accuracy: 0 }, coverage).kind, 'outside');
  assert.equal(classifyLocation({ ...position, lat: 27.81 }, coverage).kind, 'outside');
  assert.equal(classifyLocation(position, { ...coverage, neighborhoods: [...coverage.neighborhoods, { ...coverage.neighborhoods[0], id: 'b' }] }).kind, 'ambiguous');
  for (const accuracy of [-1, NaN, Infinity]) assert.equal(classifyLocation({ ...position, accuracy }, coverage).kind, 'approximate');
});

test('coverage is lazy, coordinate-free, cached after explicit use, and same-core fixes stay local', async () => {
  const h = harness();
  assert.equal(h.reads(), 0); assert.equal(h.calls.length, 0);
  const first = h.controller.start(); h.fix(); await first;
  assert.equal(h.reads(), 1); assert.deepEqual(h.located, [position]); assert.deepEqual(h.neighborhoods, []);
  assert.deepEqual(h.calls[0].options, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  const second = h.controller.start(); h.fix(); await second;
  assert.equal(h.reads(), 1); assert.equal(h.located.length, 2);
});

test('denial is recoverable without repeating the permission request', async () => {
  const h = harness(), pending = h.controller.start(); h.calls[0].error({ code: 1 }); await pending;
  assert.equal(h.states.at(-1).kind, 'denied'); h.controller.dismiss(); await h.controller.start();
  assert.equal(h.calls.length, 1); assert.equal(h.states.at(-1).kind, 'denied'); assert.deepEqual(h.located, []);
});

test('dismissal and a newer attempt defeat late native callbacks', async () => {
  const h = harness(), first = h.controller.start(); h.controller.dismiss();
  const second = h.controller.start(); h.calls[0].success({ coords: { latitude: position.lat, longitude: position.lng, accuracy: position.accuracy } }); await first;
  assert.deepEqual(h.located, []); assert.equal(h.states.at(-1).kind, 'locating');
  h.fix(); await second; assert.deepEqual(h.located, [position]);
  const third = h.controller.start(); h.controller.destroy(); h.fix(); await third; assert.equal(h.located.length, 1);
});

test('a failed metadata read retries and a precise different core requests a neighborhood change', async () => {
  let fail = true;
  const h = harness({ neighborhoodId: 'other', fetchCoverage: () => fail ? Promise.reject(new Error('Outage')) : Promise.resolve(coverage) });
  const first = h.controller.start(); h.fix(); await first;
  assert.equal(h.states.at(-1).kind, 'coverage-error'); assert.equal(h.neighborhoods.length, 0);
  fail = false; const second = h.controller.start(); h.fix(); await second;
  assert.equal(h.reads(), 2); assert.deepEqual(h.located, []); assert.equal(h.neighborhoods[0].id, 'a');
});

test('malformed cores are not cached as successful coverage', async () => {
  let malformed = true;
  const h = harness({ fetchCoverage: () => Promise.resolve(malformed ? { version: 1, neighborhoods: [{ id: 'a', name: 'A', core: [[0, 0]] }] } : coverage) });
  const first = h.controller.start(); h.fix(); await first;
  assert.equal(h.states.at(-1).kind, 'coverage-error');
  malformed = false; const second = h.controller.start(); h.fix(); await second;
  assert.equal(h.reads(), 2); assert.deepEqual(h.located, [position]);
});

test('native timeout and approximate fixes preserve the map for recovery', async () => {
  const h = harness(), first = h.controller.start(); h.calls[0].error({ code: 3 }); await first;
  assert.equal(h.states.at(-1).kind, 'timeout');
  const second = h.controller.start(); h.fix({ ...position, accuracy: 2000 }); await second;
  assert.equal(h.states.at(-1).kind, 'approximate'); assert.deepEqual(h.located, []); assert.deepEqual(h.neighborhoods, []);
  await settle();
});

test('generated public metadata uses registered core polygons and the reviewed Crescent Lake supplement', async () => {
  const registry = JSON.parse(await readFile(new URL('../server/neighborhoods.json', import.meta.url)));
  const supplement = JSON.parse(await readFile(new URL('../scripts/near-me-coverage-supplement.json', import.meta.url)));
  const actual = JSON.parse(await readFile(new URL('../public/data/neighborhood-coverage.json', import.meta.url)));
  assert.deepEqual(actual, buildCoverage(registry, supplement));
  assert.equal(actual.neighborhoods.length, Object.keys(registry).length);
  assert.equal(classifyLocation({ lat: 27.792, lng: -82.63, accuracy: 10 }, actual).neighborhood.id, 'old-northeast');
  assert.equal(classifyLocation({ lat: 27.787, lng: -82.643, accuracy: 10 }, actual).neighborhood.id, 'crescent-lake');
  // Visible Crescent Lake artwork padding is not location coverage.
  assert.equal(classifyLocation({ lat: 27.7928, lng: -82.642, accuracy: 10 }, { ...actual, neighborhoods: actual.neighborhoods.filter(area => area.id === 'crescent-lake') }).kind, 'outside');
  assert.throws(() => buildCoverage({ missing: { projection: registry['old-northeast'].projection, bounds: registry['old-northeast'].bounds } }, {}), /No reviewed core/);
});
