import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const original = resolve(root, 'geography/sources/greenbriar-cdp');
const run = (source, output) => spawnSync('python3', [resolve(root, 'scripts/build-county-map.py'), '--source', source, '--output-root', output], { encoding: 'utf8' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('a county bundle retains its non-OSM source identities and is reproducible without network access', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'county-map-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['first', 'second']) {
    const result = run(original, resolve(dir, name));
    assert.equal(result.status, 0, result.stderr);
  }
  for (const file of ['neighborhood.json', 'anchors.json', 'provenance.json', 'source-notices.json', 'geography.geojson']) {
    assert.deepEqual(await readFile(resolve(dir, 'first/public/data/greenbriar-cdp', file)), await readFile(resolve(dir, 'second/public/data/greenbriar-cdp', file)));
  }
  const data = JSON.parse(await readFile(resolve(dir, 'first/public/data/greenbriar-cdp/geography.geojson')));
  const core = data.features.find(feature => feature.id === 'census-cdp/1227360');
  assert.equal(core.properties.coverageType, 'Census designated place');
  const roads = new Map(data.features.filter(feature => feature.properties.source === 'Pinellas County RoadCenterline').map(feature => [feature.id, feature]));
  const anchors = JSON.parse(await readFile(resolve(dir, 'first/public/data/greenbriar-cdp/anchors.json')));
  assert.equal(anchors.length, 4);
  for (const anchor of anchors) {
    assert.equal(anchor.sourceType, 'Pinellas County RoadCenterline');
    assert.equal(anchor.osmId, undefined);
    const source = roads.get(anchor.sourceFeatureId);
    assert.ok(source);
    assert.equal(String(source.properties.sourceCenterlineId), anchor.sourceId);
    assert.ok(source.geometry.coordinates.some(([lng, lat]) => lng === anchor.sourceGeographic.lng && lat === anchor.sourceGeographic.lat));
  }
  const config = JSON.parse(await readFile(resolve(dir, 'first/public/data/greenbriar-cdp/neighborhood.json')));
  assert.equal(config.license, null);
  assert.equal(config.coverageKind, 'census-designated-place');
  assert.match(config.attribution.label, /Pinellas County/);
  assert.deepEqual(config.additionalAttributions.map(credit => credit.label), ['U.S. Census Bureau', 'USGS NHD']);
});

test('a changed geographic package is rejected before artwork is written', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'county-map-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = resolve(dir, 'source');
  await cp(original, source, { recursive: true });
  await writeFile(resolve(source, 'geography.geojson'), '{}');
  const result = run(source, resolve(dir, 'output'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch/);
  await assert.rejects(readFile(resolve(dir, 'output/public/assets/neighborhoods/greenbriar-cdp.svg')), { code: 'ENOENT' });
});

test('multipart or holed source coverage cannot be silently reduced to one ring', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'county-map-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const kind of ['hole', 'multipart']) {
    const source = resolve(dir, kind);
    await cp(original, source, { recursive: true });
    const geography = JSON.parse(await readFile(resolve(source, 'geography.geojson')));
    const core = geography.features.find(feature => feature.id === 'census-cdp/1227360');
    if (kind === 'hole') core.geometry.coordinates.push(core.geometry.coordinates[0]);
    else core.geometry = { type: 'MultiPolygon', coordinates: [core.geometry.coordinates] };
    const bytes = JSON.stringify(geography);
    await writeFile(resolve(source, 'geography.geojson'), bytes);
    const metadata = JSON.parse(await readFile(resolve(source, 'source.json')));
    metadata.geographySha256 = hash(bytes);
    await writeFile(resolve(source, 'source.json'), JSON.stringify(metadata));
    const result = run(source, resolve(dir, kind + '-output'));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /model update/);
  }
});
