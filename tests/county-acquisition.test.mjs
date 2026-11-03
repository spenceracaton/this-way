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

function fixture({ coreCount = 1, roads = [1, 2, 3], emptyWater = false, duplicate = false, missing = false, truncatedIds = false, coreError = false, mercator = false, ambiguousCoreFields = false, missingCoreSR = false, missingPageSR = false, actualNhdNames = false, ambiguousNhdRole = false, ambiguousRoadNames = false, missingBoundaryIdField = false, missingBoundaryIdAttribute = false, duplicateBoundaryName = false, nullWaterIds = false, waterCount = 0, missingWaterCount = false, exceedWaterCount = false, nullRoadIds = false } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    calls.push(u);
    res.setHeader('content-type', 'application/json');
    const send = x => res.end(JSON.stringify(x));
    if (u.pathname === '/core' || u.pathname === '/core/query') {
      if (u.searchParams.get('f') === 'pjson') return send({ objectIdField: 'OBJECTID', fields: [{ name: 'CDP_TITLE', alias: 'CDP Name', type: 'esriFieldTypeString' }, { name: 'OBJECTID', type: 'esriFieldTypeOID' }, ...(!missingBoundaryIdField ? [{ name: 'GEOID', alias: 'Geographic Identifier', type: 'esriFieldTypeString' }] : []), { name: 'created_user', alias: 'Internal Created User', type: 'esriFieldTypeString' }, ...(ambiguousCoreFields ? [{ name: 'STATE_NAME', type: 'esriFieldTypeString' }] : [])], geometryType: 'esriGeometryPolygon' });
      if (coreError) return send({ error: { code: 500, message: 'fixture failure' } });
      assert.equal(u.searchParams.get('outFields'), 'OBJECTID,CDP_TITLE,GEOID');
      assert.equal(u.searchParams.get('outSR'), '4326');
      // Deliberately ignore the WHERE expression: post-query name and GEOID
      // filtering must select the right feature even if a service is lax.
      return send({ geometryType: 'esriGeometryPolygon', exceededTransferLimit: false, spatialReference: missingCoreSR ? undefined : { wkid: mercator ? 3857 : 4326 }, features: Array.from({ length: coreCount }, (_, i) => ({ attributes: { CDP_TITLE: duplicateBoundaryName || i === 0 ? 'Greenbriar' : 'Different place', OBJECTID: i + 1, ...(!missingBoundaryIdAttribute ? { GEOID: i === 0 ? '1227360' : '9999999' } : {}) }, geometry: { ...poly, spatialReference: missingCoreSR ? undefined : { wkid: mercator ? 3857 : 4326 } } })) });
    }
    if (u.pathname === '/roads' || u.pathname === '/roads/query' || u.pathname.startsWith('/nhd/')) {
      const layer = u.pathname.startsWith('/roads') ? 'roads' : u.pathname.replace(/\/query$/, '');
      if (u.searchParams.get('f') === 'pjson') return send({ objectIdField: layer === 'roads' ? 'OID' : 'OID', maxRecordCount: 2, geometryType: layer === 'roads' ? 'esriGeometryPolyline' : 'esriGeometryPolygon', fields: layer === 'roads' ? [
        { name: 'OID', type: 'esriFieldTypeOID' }, { name: 'FULLNAME', alias: 'Full Road Name', type: 'esriFieldTypeString' }, { name: 'ROADCLASS', alias: 'Road Class', type: 'esriFieldTypeString' },
        { name: 'CENTERLINEID', alias: 'Centerline ID', type: 'esriFieldTypeString' }, { name: 'PRECENTERLINEID', alias: 'Previous Centerline ID', type: 'esriFieldTypeString' },
        { name: 'created_user', alias: 'Internal Created User', type: 'esriFieldTypeString' }, { name: 'COMMENTS', type: 'esriFieldTypeString' },
        ...(ambiguousRoadNames ? [{ name: 'ROAD_NAME', alias: 'Road Name', type: 'esriFieldTypeString' }] : []),
      ] : [{ name: 'OID', type: 'esriFieldTypeOID' }, { name: 'created_user', alias: 'Internal Created User', type: 'esriFieldTypeString' }] });
      if (u.searchParams.get('returnCountOnly') === 'true') {
        assert.equal(u.searchParams.get('where'), '1=1');
        assert.equal(u.searchParams.get('geometryType'), 'esriGeometryEnvelope');
        assert.equal(u.searchParams.get('spatialRel'), 'esriSpatialRelIntersects');
        assert.equal(u.searchParams.get('inSR'), '4326');
        assert.equal(u.searchParams.get('outSR'), '4326');
        return send({ ...(missingWaterCount ? {} : { count: waterCount }), ...(exceedWaterCount ? { exceededTransferLimit: true } : {}) });
      }
      if (u.searchParams.get('returnIdsOnly') === 'true') {
        assert.equal(u.searchParams.get('inSR'), '4326'); assert.equal(u.searchParams.get('outSR'), '4326');
        const objectIds = layer === 'roads' ? roads : emptyWater ? [] : [10];
        if ((layer === 'roads' && nullRoadIds) || (layer !== 'roads' && nullWaterIds)) return send({ objectIdFieldName: 'OID', objectIds: null });
        return send({ objectIds: truncatedIds ? objectIds.slice(0, 1) : objectIds, ...(truncatedIds ? { exceededTransferLimit: true } : {}) });
      }
      const wanted = u.searchParams.get('objectIds').split(',').map(Number);
      let ids = wanted;
      if (duplicate && ids.length > 1) ids = [ids[0], ids[0]];
      if (missing && ids.length > 0) ids = ids.slice(0, -1);
      assert.equal(u.searchParams.get('outSR'), '4326');
      const requested = u.searchParams.get('outFields').split(',');
      return send({ spatialReference: missingPageSR ? undefined : { wkid: 4326 }, features: ids.map(id => {
        const roadAttrs = { OID: id, FULLNAME: `Road ${id}`, ROADCLASS: 'Local', CENTERLINEID: `CL${id}`, PRECENTERLINEID: `OLD${id}`, created_user: 'private-user', COMMENTS: 'private comment', ROAD_NAME: `Alt ${id}` };
        const waterAttrs = { OID: id, created_user: 'private-user' };
        return { attributes: Object.fromEntries(Object.entries(layer === 'roads' ? roadAttrs : waterAttrs).filter(([key]) => requested.includes(key))), geometry: layer === 'roads' ? { paths: [[[-82.8, 27.8, 1], [-82.79, 27.81, 2]]] } : poly };
      }) });
    }
    if (u.pathname === '/nhd') {
      const base = actualNhdNames
        ? [{ id: 9, name: 'Area - Large Scale', geometryType: 'esriGeometryPolygon' }, { id: 12, name: 'Waterbody - Large Scale', geometryType: 'esriGeometryPolygon' }]
        : [{ id: 4, name: 'NHDWaterbody', geometryType: 'esriGeometryPolygon' }, { id: 5, name: 'NHDArea', geometryType: 'esriGeometryPolygon' }];
      if (ambiguousNhdRole) base.push({ id: 13, name: actualNhdNames ? 'Waterbody - Large Scale' : 'canonicalNHDWaterbody', geometryType: 'esriGeometryPolygon' });
      return send({ layers: [...base, { id: 6, name: 'NotWaterbody', geometryType: 'esriGeometryPolygon' }] });
    }
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
    const child = spawn('python3', [script, '--name', 'Greenbriar', '--candidate-id', 'greenbriar-cdp', '--output', output, '--fdot-layer', `${root}/core`, '--roads-layer', `${root}/roads`, '--nhd-service', `${root}/nhd`, ...(opts.boundaryNameField ? ['--boundary-name-field', opts.boundaryNameField] : []), ...(opts.boundaryIdField ? ['--boundary-id-field', opts.boundaryIdField] : []), ...(opts.boundaryId ? ['--boundary-id', opts.boundaryId] : []), ...(opts.roadNameField ? ['--road-name-field', opts.roadNameField] : []), ...(opts.roadClassField ? ['--road-class-field', opts.roadClassField] : [])]);
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
    assert.equal(data.bindings.roadNameField, 'FULLNAME');
    assert.equal(data.bindings.roadClassField, 'ROADCLASS');
    assert.equal(data.bindings.roadCenterlineIdField, 'CENTERLINEID');
    const boundary = JSON.parse(await readFile(path.join(r.output, 'boundary.geojson'), 'utf8'));
    assert.equal(boundary.features[0].geometry.type, 'MultiPolygon');
    assert.equal(boundary.features[0].geometry.coordinates[0].length, 2, 'hole is attached to its containing shell');
    assert.equal(boundary.features[0].geometry.coordinates[0][0][0].length, 3, 'Z coordinate is preserved');
    assert.deepEqual(roads.features.map(f => f.properties.OID), [1, 2, 3]);
    assert.equal(roads.features[0].properties.CENTERLINEID, 'CL1');
    assert.equal(roads.features[0].properties.ROADCLASS, 'Local');
    assert.equal('PRECENTERLINEID' in roads.features[0].properties, false);
    assert.deepEqual(Object.keys(data.sources.nhdService.layers).sort(), ['NHDArea', 'NHDWaterbody']);
    const water = JSON.parse(await readFile(path.join(r.output, 'water.geojson'), 'utf8'));
    assert.deepEqual(water.features.map(f => f.id).sort(), ['NHDArea:10', 'NHDWaterbody:10']);
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
    const roadQuery = r.calls.find(u => u.pathname === '/roads/query' && u.searchParams.has('objectIds'));
    assert.equal(roadQuery.searchParams.get('outFields'), 'OID,FULLNAME,ROADCLASS,CENTERLINEID');
    assert.equal(JSON.stringify(data.sources.roads.features).includes('private-user'), false);
    assert.equal(JSON.stringify(data.sources.roads.features).includes('COMMENTS'), false);
    assert.equal(JSON.stringify(data.sources.roads.features).includes('PRECENTERLINEID'), false);
    assert.equal(JSON.stringify(data.sources.roads.features).includes('OLD'), false);
    assert.equal(JSON.stringify(roads.features).includes('private-user'), false);
    assert.equal(JSON.stringify(boundary.features).includes('private-user'), false);
    assert.equal(JSON.stringify(water.features).includes('private-user'), false);
    const coreQuery = r.calls.find(u => u.pathname === '/core/query');
    assert.equal(coreQuery.searchParams.get('outFields'), 'OBJECTID,CDP_TITLE,GEOID');
  } finally { await rm(r.temp, { recursive: true, force: true }); }
});

for (const [label, opts] of [['zero core matches', { coreCount: 0 }], ['multiple core matches', { coreCount: 2, duplicateBoundaryName: true }], ['error JSON', { coreError: true }], ['duplicate page IDs', { duplicate: true }], ['missing page record', { missing: true }], ['truncated ID response', { truncatedIds: true }], ['Web Mercator response', { mercator: true }], ['missing core spatial reference', { missingCoreSR: true }], ['missing page spatial reference', { missingPageSR: true }]]) {
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

test('accepts null water object IDs only after an independent zero count for the same envelope', async () => {
  const r = await invoke({ nullWaterIds: true, waterCount: 0 });
  try {
    assert.equal(r.code, 0, r.stderr);
    const idQueries = r.calls.filter(u => u.searchParams.get('returnIdsOnly') === 'true' && !u.pathname.startsWith('/roads'));
    const countQueries = r.calls.filter(u => u.searchParams.get('returnCountOnly') === 'true');
    assert.equal(idQueries.length, 2);
    assert.equal(countQueries.length, 2);
    for (const ids of idQueries) {
      const count = countQueries.find(query => query.pathname === ids.pathname);
      assert.ok(count, `count query for ${ids.pathname}`);
      for (const key of ['where', 'geometry', 'geometryType', 'spatialRel', 'inSR', 'outSR']) {
        assert.equal(count.searchParams.get(key), ids.searchParams.get(key), `${key} matches exact query extent`);
      }
    }
  } finally { await rm(r.temp, { recursive: true, force: true }); }
});

test('null water object IDs fail for nonzero, missing, or exceeded independent counts', async () => {
  for (const opts of [{ waterCount: 2 }, { missingWaterCount: true }, { waterCount: 0, exceedWaterCount: true }]) {
    const r = await invoke({ nullWaterIds: true, ...opts });
    try { assert.notEqual(r.code, 0); } finally { await rm(r.temp, { recursive: true, force: true }); }
  }
});

test('null road object IDs fail closed without a water-layer empty fallback', async () => {
  const r = await invoke({ nullRoadIds: true });
  try {
    assert.notEqual(r.code, 0);
    assert.equal(r.calls.some(u => u.searchParams.get('returnCountOnly') === 'true'), false);
  } finally { await rm(r.temp, { recursive: true, force: true }); }
});

test('discovers actual NHD layer names and IDs while retaining exact names in provenance', async () => {
  const r = await invoke({ actualNhdNames: true });
  try {
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(await readFile(path.join(r.output, 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(data.sources.nhdService.layers).sort(), ['Area - Large Scale', 'Waterbody - Large Scale']);
    assert.equal(data.sources.nhdService.layers['Area - Large Scale'].serviceUrl.endsWith('/9'), true);
    assert.equal(data.sources.nhdService.layers['Waterbody - Large Scale'].serviceUrl.endsWith('/12'), true);
  } finally { await rm(r.temp, { recursive: true, force: true }); }
});

test('rejects ambiguous recognized NHD roles rather than guessing', async () => {
  const r = await invoke({ actualNhdNames: true, ambiguousNhdRole: true });
  try { assert.notEqual(r.code, 0); } finally { await rm(r.temp, { recursive: true, force: true }); }
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

test('stable Census GEOID disambiguates same-name places after exact-name filtering', async () => {
  const r = await invoke({ coreCount: 2, duplicateBoundaryName: true, boundaryIdField: 'GEOID', boundaryId: '1227360' });
  try {
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(await readFile(path.join(r.output, 'manifest.json'), 'utf8'));
    const boundary = JSON.parse(await readFile(path.join(r.output, 'boundary.geojson'), 'utf8'));
    const coreQuery = r.calls.find(u => u.pathname === '/core/query');
    assert.match(coreQuery.searchParams.get('where'), /CDP_TITLE='Greenbriar' AND GEOID='1227360'/);
    assert.equal(data.sources.coreBoundary.idField, 'GEOID');
    assert.equal(data.sources.coreBoundary.requestedId, '1227360');
    assert.equal(data.sources.coreBoundary.feature.attributes.GEOID, '1227360');
    assert.equal(boundary.features.length, 1);
    assert.equal(boundary.features[0].properties.GEOID, '1227360');
  } finally { await rm(r.temp, { recursive: true, force: true }); }
});

test('wrong or missing stable Census GEOID fails even when same-name rows are returned', async () => {
  const wrong = await invoke({ coreCount: 2, duplicateBoundaryName: true, boundaryIdField: 'GEOID', boundaryId: '1227999' });
  try { assert.notEqual(wrong.code, 0); } finally { await rm(wrong.temp, { recursive: true, force: true }); }
  const missing = await invoke({ boundaryIdField: 'GEOID', boundaryId: '1227360', missingBoundaryIdAttribute: true });
  try { assert.notEqual(missing.code, 0); } finally { await rm(missing.temp, { recursive: true, force: true }); }
});

test('stable geographic ID field must exist in boundary metadata', async () => {
  const r = await invoke({ boundaryIdField: 'GEOID', boundaryId: '1227360', missingBoundaryIdField: true });
  try { assert.notEqual(r.code, 0); } finally { await rm(r.temp, { recursive: true, force: true }); }
});

test('ambiguous road name metadata fails closed and explicit existing override works', async () => {
  const ambiguous = await invoke({ ambiguousRoadNames: true });
  try { assert.notEqual(ambiguous.code, 0); } finally { await rm(ambiguous.temp, { recursive: true, force: true }); }
  const selected = await invoke({ ambiguousRoadNames: true, roadNameField: 'FULLNAME', roadClassField: 'ROADCLASS' });
  try {
    assert.equal(selected.code, 0, selected.stderr);
    const manifest = JSON.parse(await readFile(path.join(selected.output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.bindings.roadNameField, 'FULLNAME');
    assert.equal(manifest.bindings.roadClassField, 'ROADCLASS');
  } finally { await rm(selected.temp, { recursive: true, force: true }); }
});
