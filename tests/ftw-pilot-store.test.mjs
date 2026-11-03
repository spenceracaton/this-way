import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTestService } from './helpers/service-runtime.mjs';
import { planFtwImport } from '../server/import-ftw.mjs';
import { applyFtwPilotPlan, readFtwPilotTarget } from '../scripts/lib/ftw-pilot-store.mjs';

function crc32(bytes) { let crc = 0xffffffff; for (const value of bytes) { crc ^= value; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function validPng() {
  const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S0cAAAAASUVORK5CYII=', 'base64'));
  let offset = 8;
  while (offset < bytes.length) {
    const size = bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
    const end = offset + 8 + size;
    const sum = crc32(bytes.subarray(offset + 4, end));
    bytes[end] = sum >>> 24; bytes[end + 1] = sum >>> 16; bytes[end + 2] = sum >>> 8; bytes[end + 3] = sum;
    offset = end + 4;
  }
  return bytes;
}
const png = validPng();
const hash = `sha256:${createHash('sha256').update(png).digest('hex')}`;
const record = (status = 'hidden') => ({
  id: 'synthetic-pilot-listing-1', season_year: 2026, address: '12 Maple St', status,
  theme: 'Test display', description: 'Synthetic local pilot fixture', tags: '[]', custom_tags: '[]', version: 1,
  address_match: { neighborhoodId: 'old-northeast', latitude: 27.769, longitude: -82.639 },
  photos: [{ id: 'synthetic-pilot-photo-1', object_key: 'fixture/photo.png', status: 'pending', position: 0 }]
});
const makePlan = (status = 'hidden', options = {}) => planFtwImport({
  records: [record(status)], assetManifest: { assets: [{ sourceKey: 'fixture/photo.png', objectKey: 'pilot/photo.png', contentHash: hash, mediaType: 'image/png', width: 1, height: 1 }] },
  now: 1800000000000, ...options
});
const assets = [{ objectKey: 'pilot/photo.png', bytes: png }];

test('isolated local store inserts once, keeps hidden/pending data private, and exact replay skips', async t => {
  const service = await createTestService(); t.after(() => service.dispose());
  const plan = makePlan();
  const first = await applyFtwPilotPlan({ mode: 'isolated-local', db: service.db, bucket: service.bucket, plan, assets });
  assert.equal(first.action, 'insert');
  assert.equal(first.rowCounts.listings, 1);
  assert.equal((await service.db.prepare('SELECT status FROM listings').first()).status, 'hidden');
  assert.equal((await service.db.prepare('SELECT status FROM photos').first()).status, 'pending');
  const publicResponse = await service.request('/api/listings?neighborhood=old-northeast&season=halloween-2026');
  assert.equal((await publicResponse.json()).listings.length, 0);
  const photoResponse = await service.request(`/api/photos/${plan.photos[0].id}`);
  assert.equal(photoResponse.status, 404);
  const target = await readFtwPilotTarget(service.db);
  const replay = makePlan('hidden', { existingMappings: target.existingMappings, targetRows: target.targetRows, now: 1800000000001 });
  let puts = 0;
  const bucket = { get: (...args) => service.bucket.get(...args), put: (...args) => { puts++; return service.bucket.put(...args); }, delete: (...args) => service.bucket.delete(...args) };
  const result = await applyFtwPilotPlan({ mode: 'isolated-local', db: service.db, bucket, plan: replay, assets });
  assert.equal(result.action, 'skip');
  assert.equal(puts, 0);
  assert.equal((await service.db.prepare('SELECT COUNT(*) AS count FROM source_mappings').first()).count, plan.source_mappings.length);
});

test('rejects unsafe mode, unknown actions, duplicate identities, bad coverage and bad asset bytes before writes', async t => {
  const service = await createTestService(); t.after(() => service.dispose());
  const call = (plan, assetList = assets, mode = 'isolated-local') => applyFtwPilotPlan({ mode, db: service.db, bucket: service.bucket, plan, assets: assetList });
  await assert.rejects(call(makePlan(), assets, 'remote'), /isolated-local/);
  const unknown = makePlan(); unknown.decisions[0].action = 'update';
  await assert.rejects(call(unknown), /refuses decision action update/);
  const duplicate = makePlan(); duplicate.photos.push({ ...duplicate.photos[0] });
  await assert.rejects(call(duplicate), /duplicate or invalid row id/);
  const duplicateKey = makePlan(); duplicateKey.photos.push({ ...duplicateKey.photos[0], id: 'synthetic-other-photo' });
  await assert.rejects(call(duplicateKey), /duplicate or invalid object key/);
  const outside = makePlan('approved'); outside.locations[0].latitude = 27.9; outside.locations[0].longitude = -82.5;
  await assert.rejects(call(outside), /outside its declared neighborhood coverage/);
  await assert.rejects(call(makePlan(), [{ objectKey: assets[0].objectKey, bytes: Uint8Array.of(1, 2, 3) }]), /asset hash/);
  await service.bucket.put('pilot/photo.png', Uint8Array.of(9, 8, 7));
  await assert.rejects(call(makePlan()), /different bytes/);
  assert.equal((await service.db.prepare('SELECT COUNT(*) AS count FROM listings').first()).count, 0);
  assert.deepEqual(new Uint8Array(await (await service.bucket.get('pilot/photo.png')).arrayBuffer()), Uint8Array.of(9, 8, 7));
});

test('D1 batch failure rolls back rows and removes only newly created R2 objects', async t => {
  const service = await createTestService(); t.after(() => service.dispose());
  await service.bucket.put('pilot/photo.png', png);
  const newlyPut = [{ objectKey: 'pilot/other.png', bytes: png }];
  const plan = makePlan(); plan.photos[0].object_key = 'pilot/other.png';
  const wrappedDb = {
    prepare: (...args) => service.db.prepare(...args),
    batch: statements => service.db.batch([...statements, service.db.prepare('INSERT INTO seasons(id,kind,year,name,config_json) VALUES(?,?,?,?,?)').bind(null,'halloween',2026,'failure','{}')])
  };
  const original = plan.photos[0].object_key;
  await assert.rejects(applyFtwPilotPlan({ mode: 'isolated-local', db: wrappedDb, bucket: service.bucket, plan, assets: newlyPut }), /constraint|unique/i);
  assert.equal(await service.bucket.get(original), null);
  assert.ok(await service.bucket.get('pilot/photo.png'));
  assert.equal((await service.db.prepare('SELECT COUNT(*) AS count FROM seasons').first()).count, 0);
  assert.equal((await service.db.prepare('SELECT COUNT(*) AS count FROM listings').first()).count, 0);
});
