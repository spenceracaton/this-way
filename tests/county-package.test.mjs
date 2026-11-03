import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts/package-county-geography.py');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function snapshotFixture(root) {
  const snapshot = path.join(root, 'snapshot');
  const files = {};
  const content = {
    'boundary.geojson': { type: 'FeatureCollection', features: [{
      type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-82.8, 27.8], [-82.8, 27.81], [-82.79, 27.81], [-82.8, 27.8]]]},
      properties: { OBJECTID: 5, BASENAME: 'Greenbriar', GEOID: '1227360', NAME: 'Greenbriar CDP' },
    }]},
    'roads.geojson': { type: 'FeatureCollection', features: [{
      type: 'Feature', id: null, geometry: { type: 'LineString', coordinates: [[-82.8, 27.8], [-82.79, 27.81]] },
      properties: { OBJECTID: 7, FULLNAME: 'Test Road', ROADCLASS: 'Local', CENTERLINEID: 'CL-7' },
    }]},
    'water.geojson': { type: 'FeatureCollection', features: [{
      type: 'Feature', id: 'Waterbody - Large Scale:10',
      geometry: { type: 'Polygon', coordinates: [[[-82.805, 27.8], [-82.805, 27.81], [-82.795, 27.81], [-82.805, 27.8]]] },
      properties: { OBJECTID: 10, PERMANENT_IDENTIFIER: 'P-10', FDATE: 1, FTYPE: 436, FCODE: 43600 },
    }]},
    'raw/boundary-metadata.json': { fields: [{ name: 'OBJECTID', type: 'esriFieldTypeOID' }] },
    'raw/roads-metadata.json': { serviceItemId: 'item-123' },
    'raw/nhd-service-metadata.json': { copyrightText: 'USGS NHD' },
    'raw/Area - Large Scale-metadata.json': { name: 'Area - Large Scale' },
    'raw/Waterbody - Large Scale-metadata.json': { name: 'Waterbody - Large Scale' },
  };
  for (const [relative, value] of Object.entries(content)) {
    const bytes = jsonBytes(value);
    const file = path.join(snapshot, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    files[relative] = digest(bytes);
  }
  const manifest = {
    candidate: { id: 'greenbriar-cdp', name: 'Greenbriar' }, acquiredAt: '2026-11-03T00:00:00Z',
    spatialQuery: { extent: { xmin: -82.81, ymin: 27.79, xmax: -82.78, ymax: 27.82 } },
    filesSha256: files,
    sources: {
      coreBoundary: { serviceUrl: 'https://census.example/5', metadataSha256: 'c'.repeat(64), requestedId: '1227360', expectedFeatureCount: 1, retrievedFeatureCount: 1 },
      roads: { serviceUrl: 'https://county.example/0', metadataSha256: 'r'.repeat(64), expectedFeatureCount: 1, retrievedFeatureCount: 1 },
      nhdService: { serviceUrl: 'https://usgs.example/MapServer', metadataSha256: 'n'.repeat(64), layers: {
        'Area - Large Scale': { serviceUrl: 'https://usgs.example/MapServer/9', metadataSha256: 'a'.repeat(64), objectIdField: 'OBJECTID', expectedFeatureCount: 0, retrievedFeatureCount: 0, features: [] },
        'Waterbody - Large Scale': { serviceUrl: 'https://usgs.example/MapServer/12', metadataSha256: 'w'.repeat(64), objectIdField: 'OBJECTID', expectedFeatureCount: 1, retrievedFeatureCount: 1, features: [{
          attributes: { OBJECTID: 10, PERMANENT_IDENTIFIER: 'P-10', FDATE: 1, FTYPE: 436, FCODE: 43600 },
          geometry: { rings: [[[-82.805, 27.8], [-82.805, 27.81], [-82.795, 27.81], [-82.805, 27.8]]] },
        }] },
      }},
    },
    bindings: { roadObjectIdField: 'OBJECTID', roadNameField: 'FULLNAME', roadClassField: 'ROADCLASS', roadCenterlineIdField: 'CENTERLINEID' },
  };
  await writeFile(path.join(snapshot, 'manifest.json'), jsonBytes(manifest));
  return snapshot;
}

function invoke(snapshot, output, terms) {
  const args = [script, '--snapshot', snapshot, '--output', output, '--id', 'greenbriar-cdp', '--name', 'Greenbriar'];
  if (terms) args.push('--county-terms', terms);
  return spawnSync('python3', args, { encoding: 'utf8' });
}

async function updateSnapshotGeojson(snapshot, relative, mutate) {
  const file = path.join(snapshot, relative);
  const value = JSON.parse(await readFile(file, 'utf8'));
  mutate(value);
  const bytes = jsonBytes(value);
  await writeFile(file, bytes);
  const manifestPath = path.join(snapshot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.filesSha256[relative] = digest(bytes);
  await writeFile(manifestPath, jsonBytes(manifest));
}

test('county item terms must match the road layer service item and retain evidence hash', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'county-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await snapshotFixture(root);
  const terms = path.join(root, 'county-item.json');
  const valid = jsonBytes({ id: 'item-123', licenseInfo: 'As-is reference data; not survey precision.', accessInformation: 'Pinellas County GIS' });
  await writeFile(terms, valid);
  const output = path.join(root, 'valid-package');
  const result = invoke(snapshot, output, terms);
  assert.equal(result.status, 0, result.stderr);
  const source = JSON.parse(await readFile(path.join(output, 'source.json'), 'utf8'));
  const county = source.sourceNotices.originalMetadata.countyRoads;
  assert.equal(county.licenseInfo, 'As-is reference data; not survey precision.');
  assert.equal(county.accessInformation, 'Pinellas County GIS');
  assert.equal(county.serviceItemEvidence.url, 'https://www.arcgis.com/sharing/rest/content/items/item-123?f=pjson');
  assert.equal(county.serviceItemEvidence.rawFileSha256, digest(valid));
  assert.equal(source.license, null);

  await writeFile(terms, jsonBytes({ id: 'wrong-item', licenseInfo: 'Do not accept mismatched terms.' }));
  const rejectedOutput = path.join(root, 'rejected-package');
  const rejected = invoke(snapshot, rejectedOutput, terms);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /service item id does not match/i);
  await assert.rejects(readFile(path.join(rejectedOutput, 'source.json')), { code: 'ENOENT' });
});

test('rejects malformed, unclosed, dimension-inconsistent, or out-of-range geometry before output creation', async t => {
  const cases = [
    ['unclosed three-point polygon', 'boundary.geojson', value => {
      value.features[0].geometry.coordinates = [[[-82.8, 27.8], [-82.8, 27.81], [-82.79, 27.8]]];
    }],
    ['one-position line', 'roads.geojson', value => {
      value.features[0].geometry.coordinates = [[-82.8, 27.8]];
    }],
    ['unclosed water polygon', 'water.geojson', value => {
      value.features[0].geometry.coordinates = [[[-82.805, 27.8], [-82.805, 27.81], [-82.795, 27.8]]];
    }],
    ['out-of-range longitude', 'roads.geojson', value => {
      value.features[0].geometry.coordinates = [[190, 27.8], [-82.79, 27.81]];
    }],
    ['inconsistent coordinate dimensions', 'boundary.geojson', value => {
      value.features[0].geometry.coordinates = [[[-82.8, 27.8], [-82.8, 27.81, 4], [-82.79, 27.81], [-82.8, 27.8]]];
    }],
  ];
  for (const [label, file, mutate] of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'county-package-invalid-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const snapshot = await snapshotFixture(root);
    await updateSnapshotGeojson(snapshot, file, mutate);
    const output = path.join(root, 'invalid-package');
    const result = invoke(snapshot, output);
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, /geometry|coordinate|ring|line/i, label);
    await assert.rejects(readFile(path.join(output, 'geography.geojson')), { code: 'ENOENT' }, label);
  }
});

test('preserves valid multipolygon holes and polygon parts with Z coordinates', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'county-package-valid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await snapshotFixture(root);
  const multipolygon = { type: 'MultiPolygon', coordinates: [
    [
      [[-82.8, 27.8, 1], [-82.8, 27.81, 1], [-82.79, 27.81, 1], [-82.8, 27.8, 1]],
      [[-82.798, 27.802, 1], [-82.797, 27.802, 1], [-82.797, 27.803, 1], [-82.798, 27.802, 1]],
    ],
    [[[-82.785, 27.8, 1], [-82.785, 27.805, 1], [-82.78, 27.805, 1], [-82.785, 27.8, 1]]],
  ]};
  await updateSnapshotGeojson(snapshot, 'boundary.geojson', value => { value.features[0].geometry = multipolygon; });
  const output = path.join(root, 'valid-package');
  const result = invoke(snapshot, output);
  assert.equal(result.status, 0, result.stderr);
  const geography = JSON.parse(await readFile(path.join(output, 'geography.geojson'), 'utf8'));
  assert.deepEqual(geography.features[0].geometry, multipolygon);
  assert.equal(geography.features[0].geometry.coordinates.length, 2);
  assert.equal(geography.features[0].geometry.coordinates[0].length, 2, 'interior ring is retained');
  assert.equal(geography.features[0].geometry.coordinates[0][0][0].length, 3, 'Z values are retained');
});
