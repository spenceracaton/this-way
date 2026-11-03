import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const original = resolve(root, 'docs/map-studies/placido-bayou');
const run = (study, output) => spawnSync('python3', [resolve(root, 'scripts/render-map-study.py'), '--study', study, '--output', output], { encoding: 'utf8' });

test('the cached study renders a clearly provisional bundle without production registration', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'map-study-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = resolve(dir, 'preview');
  const result = run(original, output);
  assert.equal(result.status, 0, result.stderr);
  const provenance = JSON.parse(await readFile(resolve(output, 'public/data/placido-bayou/provenance.json')));
  assert.equal(provenance.status, 'draft-source-review');
  assert.equal(provenance.acceptedForCatalog, false);
  assert.equal(provenance.coreFeatureId, 'way/468834847');
  assert.ok(provenance.knownLimitations.some(text => /missing streets/.test(text)));
  const anchors = JSON.parse(await readFile(resolve(output, 'public/data/placido-bayou/anchors.json')));
  assert.equal(anchors.length, 4);
  assert.equal(new Set(anchors.map(anchor => anchor.osmId)).size, 4);
  const catalog = await readFile(resolve(root, 'public/neighborhood-catalog.mjs'), 'utf8');
  const server = JSON.parse(await readFile(resolve(root, 'server/neighborhoods.json')));
  assert.doesNotMatch(catalog, /placido-bayou/);
  assert.equal(Object.hasOwn(server, 'placido-bayou'), false);
});

test('source checksum failure writes no study output', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'map-study-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const study = resolve(dir, 'study');
  await cp(original, study, { recursive: true });
  await writeFile(resolve(study, 'source-geometry.geojson'), '{}');
  const output = resolve(dir, 'preview');
  const result = run(study, output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch/);
  await assert.rejects(readFile(resolve(output, 'public/neighborhood-catalog.mjs')), { code: 'ENOENT' });
});

test('a park with the same name cannot replace the residential area identity', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'map-study-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const study = resolve(dir, 'study');
  await cp(original, study, { recursive: true });
  const source = JSON.parse(await readFile(resolve(study, 'source-geometry.geojson')));
  const core = source.features.find(feature => feature.id === 'way/468834847');
  delete core.properties.landuse;
  core.properties.leisure = 'park';
  const bytes = JSON.stringify(source);
  await writeFile(resolve(study, 'source-geometry.geojson'), bytes);
  const recipe = JSON.parse(await readFile(resolve(study, 'recipe.json')));
  recipe.sourceGeometrySha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(resolve(study, 'recipe.json'), JSON.stringify(recipe));
  const result = run(study, resolve(dir, 'preview'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /identity/);
});
