import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/acquire-county-geography.py');
const shell = [[-82.80, 27.80, 5], [-82.80, 27.81, 6], [-82.79, 27.81, 7], [-82.79, 27.80, 8], [-82.80, 27.80, 5]];
const hole = [[-82.798, 27.802], [-82.798, 27.803], [-82.799, 27.803], [-82.799, 27.802], [-82.798, 27.802]];
const shell2 = [[-82.78, 27.80], [-82.78, 27.81], [-82.77, 27.81], [-82.77, 27.80], [-82.78, 27.80]];
const poly = { rings: [shell, hole, shell2], spatialReference: { wkid: 4326 } };

function fixture({ coreCount = 1, roads = [1, 2, 3], emptyWater = false, duplicate = false, missing = false, truncatedIds = false, coreError = false, mercator = false, ambiguousCoreFields = false, missingCoreSR = false, missingPageSR = false } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    calls.push(u);
    res.setHeader('content-type', 'application/json');
    const send = x => res.end(JSON.stringify(x));
    if (u.pathname === '/core' || u.pathname === '/core/query') {
      if (u.searchParams.get('f') === 'pjson') return send({ fields: [{ name: 'CDP_TITLE', alias: 'CDP Name', type: 'esriFieldTypeString' }, { name: 'OBJECTID', type: 'esriFieldTypeOID' }, ...(ambiguousCoreFields ? [{ name: 'STATE_NAME', type: 'esriFieldTypeString' }] : [])], geometryType: 'esriGeometryPolygon' });
      if (coreError) return send({ error: { code: 500, message: 'fixture failure' } });
      assert.equal(u.searchParams.get('outSR'), '4326');
      return send({ geometryType: 'esriGeometryPolygon', exceededTransferLimit: false, spatialReference: missingCoreSR ? undefined : { wkid: mercator ? 3857 : 4326 }, features: Array.from({ length: coreCount }, (_, i) => ({ attributes: { CDP_TITLE: 'Greenbriar', OBJECTID: i + 1 }, geometry: { ...poly, spatialReference: missingCoreSR ? undefined : { wkid: mercator ? 3857 : 4326 } } })) });
    }
    if (u.pathname === '/roads' || u.pathname === '/roads/query' || u.pathname.startsWith('/nhd/')) {
      const layer = u.pathname.startsWith('/roads') ? 'roads' : u.pathname.replace(/\/query$/, '');
      if (u.searchParams.get('f') === 'pjson') return send({ objectIdField: 'OID', maxRecordCount: 2, geometryType: layer === 'roads' ? 'esriGeometryPolyline' : 'esriGeometryPolygon', fields: [{ name: 'OID', type: 'esriFieldTypeOID' }, { name: 'STREET_NAME', alias: 'Street Name', type: 'esriFieldTypeString' }] });
      if (u.searchParams.get('returnIdsOnly') === 'true') { assert.equal(u.searchParams.get('inSR'), '4326'); assert.equal(u.searchParams.get('outSR'), '4326'); const objectIds = layer === 'roads' ? roads : emptyWater ? [] : [10]; return send({ objectIds: truncatedIds ? objectIds.slice(0, 1) : objectIds, ...(truncatedIds ? { exceededTransferLimit: true } : {}) }); }
      const wanted = u.searchParams.get('objectIds').split(',').map(Number);
      let ids = wanted;
      if (duplicate && ids.length > 1) ids = [ids[0], ids[0]];
      if (missing && ids.length > 0) ids = ids.slice(0, -1);
      assert.equal(u.searchParams.get('outSR'), '4326');
      return send({ spatialReference: missingPageSR ? undefined : { wkid: 4326 }, features: ids.map(id => ({ attributes: { OID: id, STREET_NAME: `Road ${id}` }, geometry: layer === 'roads' ? { paths: [[[-82.8, 27.8, 1], [-82.79, 27.81, 2]]] } : poly })) });
    }
    if (u.pathname === '/nhd') return send({ layers: [{ id: 4, name: 'NHDWaterbody' }, { id: 5, name: 'NHDArea' }, { id: 6, name: 'NotWaterbody' }] });
    res.statusCode = 404; send({ error: { code: 404 } });
  });
  return { server, calls };
}

async function invoke(opts = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'county-acq-'));
  const { server, calls } = fixture(opts);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const output = path.join(temp, 'snapshot');
  const result = await new Promise(resolve => {
    const child = spawn('python3', [script, '--name', 'Greenbriar', '--candidate-id', 'greenbriar-cdp', '--output', output, '--fdot-layer', `${root}/core`, '--roads-layer', `${root}/roads`, '--nhd-service', `${root}/nhd`, ...(opts.boundaryNameField ? ['--boundary-name-field', opts.boundaryNameField] : [])]);
    let stderr = '';
    child.stderr.on('data', b => stderr += b);
    child.on('close', code => resolve({ code, stderr }));
  });
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  return { ...result, output, calls, temp };
}

test('acquires exact core and complete ID-paged roads and NHD snapshots', async () => {
  const r = await invoke();
  try {
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(await readFile(path.join(r.output, 'manifest.json'), 'utf8'));
    const roads = JSON.parse(await readFile(path.join(r.output, 'roads.geojson'), 'utf8'));
    assert.equal(data.bindings.boundaryNameField, 'CDP_TITLE');
    assert.equal(data.bindings.roadObjectIdField, 'OID');
    assert.equal(data.bindings.roadNameField, 'STREET_NAME');
    const boundary = JSON.parse(await readFile(path.join(r.output, 'boundary.geojson'), 'utf8'));
    assert.equal(boundary.features[0].geometry.type, 'MultiPolygon');
    assert.equal(boundary.features[0].geometry.coordinates[0].length, 2, 'hole is attached to its containing shell');
    assert.equal(boundary.features[0].geometry.coordinates[0][0][0].length, 3, 'Z coordinate is preserved');
    assert.deepEqual(roads.features.map(f => f.properties.OID), [1, 2, 3]);
    assert.deepEqual(Object.keys(data.sources.nhdService.layers).sort(), ['nhdarea', 'nhdwaterbody']);
    const water = JSON.parse(await readFile(path.join(r.output, 'water.geojson'), 'utf8'));
    assert.deepEqual(water.features.map(f => f.id).sort(), ['nhdarea:10', 'nhdwaterbody:10']);
    assert.equal(new Set(water.features.map(f => f.id)).size, water.features.length);
    assert.ok(r.calls.some(u => u.searchParams.get('objectIds') === '1,2'));
    assert.ok(r.calls.some(u => u.searchParams.get('objectIds') === '3'));
    assert.equal(data.sources.roads.expectedFeatureCount, data.sources.roads.retrievedFeatureCount);
    for (const [name, digest] of Object.entries(data.filesSha256)) {
      const bytes = await readFile(path.join(r.output, name));
      const { createHash } = await import('node:crypto');
      assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
    }
    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(await readFile(path.join(r.output, 'raw/boundary-metadata.json'))).digest('hex'), data.sources.coreBoundary.metadataSha256);
    assert.equal(createHash('sha256').update(await readFile(path.join(r.output, 'raw/roads-metadata.json'))).digest('hex'), data.sources.roads.metadataSha256);
    assert.ok(r.calls.every(u => !u.searchParams.has('returnGeometry') || u.searchParams.get('returnGeometry') !== 'true' || u.searchParams.get('outSR') === '4326'));
  } finally { await rm(r.temp, { recursive: true, force: true }); }
});

for (const [label, opts] of [['zero core matches', { coreCount: 0 }], ['multiple core matches', { coreCount: 2 }], ['error JSON', { coreError: true }], ['duplicate page IDs', { duplicate: true }], ['missing page record', { missing: true }], ['truncated ID response', { truncatedIds: true }], ['Web Mercator response', { mercator: true }], ['missing core spatial reference', { missingCoreSR: true }], ['missing page spatial reference', { missingPageSR: true }]]) {
  test(`fails closed for ${label}`, async () => {
    const r = await invoke(opts);
    try { assert.notEqual(r.code, 0); } finally { await rm(r.temp, { recursive: true, force: true }); }
  });
}

test('permits empty water layers and rejects empty road result', async () => {
  const water = await invoke({ emptyWater: true });
  try { assert.equal(water.code, 0, water.stderr); } finally { await rm(water.temp, { recursive: true, force: true }); }
  const roads = await invoke({ roads: [] });
  try { assert.notEqual(roads.code, 0); } finally { await rm(roads.temp, { recursive: true, force: true }); }
});


test('ambiguous boundary metadata requires an explicit validated name field', async () => {
  const ambiguous = await invoke({ ambiguousCoreFields: true });
  try { assert.notEqual(ambiguous.code, 0); } finally { await rm(ambiguous.temp, { recursive: true, force: true }); }
  const selected = await invoke({ ambiguousCoreFields: true, boundaryNameField: 'CDP_TITLE' });
  try {
    assert.equal(selected.code, 0, selected.stderr);
    const manifest = JSON.parse(await readFile(path.join(selected.output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.bindings.boundaryNameField, 'CDP_TITLE');
  } finally { await rm(selected.temp, { recursive: true, force: true }); }
});
