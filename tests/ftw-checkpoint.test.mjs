import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeImage } from '../server/image.mjs';
import { createTestService } from './helpers/service-runtime.mjs';
import {
  prepareFtwCheckpoint, applyFtwCheckpoint, restoreFtwCheckpoint, readFtwCheckpoint
} from '../scripts/lib/ftw-checkpoint-store.mjs';

const now = 1793740000000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const image = sanitizeImage(await readFile(new URL('./fixtures/metadata-test.jpg', import.meta.url)), 'image/jpeg');
const sourceKey = 'source/private-photo.jpg';
const objectKey = `ftw-import/${sha(sourceKey)}/${sha(image.bytes)}.jpg`;
const assets = [{ objectKey, bytes: image.bytes }];
function input({ status = 'approved', photoStatus = 'pending', version = 1, title = 'Source title', photo = true } = {}) {
  return {
    sourceSystem: 'fright-this-way', timestampUnit: 'milliseconds',
    records: [{ id: 'source-listing-one', season_year: 2026, address: '12 Maple St', status,
      theme: title, version, created_at: now - 1000, updated_at: now,
      address_match: { neighborhoodId: 'old-northeast', latitude: 27.7814624, longitude: -82.63175289 },
      photos: photo ? [{ id: 'source-photo-one', object_key: sourceKey, status: photoStatus,
        position: 0, fit: 'contain', created_at: now - 500, version: 1 }] : [] }],
    assetManifest: { assets: photo ? [{ sourceKey, objectKey, contentHash: `sha256:${sha(image.bytes)}`,
      mediaType: image.mediaType, width: image.width, height: image.height }] : [] }
  };
}
async function serviceFor(t, options = {}) {
  const service = await createTestService(options);
  t.after(() => service.dispose());
  return service;
}
const prepare = (service, options = {}) => prepareFtwCheckpoint({ db: service.db, input: input(options), now });
const apply = (service, checkpoint, overrides = {}) => applyFtwCheckpoint({
  db: service.db, bucket: service.bucket, checkpoint,
  assets: assets.filter(asset => checkpoint.artifact.plan.photos.some(photo => photo.object_key === asset.objectKey)),
  expectedId: checkpoint.id, ...overrides
});
const restore = (service, checkpoint, overrides = {}) => restoreFtwCheckpoint({
  db: service.db, bucket: service.bucket, checkpointId: checkpoint.id, expectedId: checkpoint.id,
  reason: 'Rehearsal recovery exercise', now: now + 2000, ...overrides
});
const count = async (db, table) => (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n;

test('checkpoint apply keeps pending photos private, persists, and exactly retries', async t => {
  const persistPath = await mkdtemp(join(tmpdir(), 'ftw-checkpoint-'));
  t.after(() => rm(persistPath, { recursive: true, force: true }));
  const service = await createTestService({ persistPath });
  let checkpoint;
  try {
    checkpoint = await prepare(service);
    assert.equal(checkpoint.state, 'prepared');
    assert.equal(await count(service.db, 'listings'), 0);
    assert.equal((await apply(service, checkpoint)).action, 'applied');
    assert.equal((await apply(service, checkpoint)).action, 'recovered');
    assert.equal(await count(service.db, 'listings'), 1);
    assert.equal(await count(service.db, 'photos'), 1);
    const photo = await service.db.prepare('SELECT * FROM photos').first();
    assert.equal((await service.request(`/api/photos/${photo.id}`)).status, 404);
    const response = await service.request('/api/listings?neighborhood=old-northeast&season=halloween-2026');
    const visible = await response.json();
    assert.equal(visible.listings.length, 1);
    assert.deepEqual(visible.listings[0].photos, []);
  } finally { await service.dispose(); }
  const restarted = await serviceFor(t, { persistPath });
  assert.equal((await readFtwCheckpoint(restarted.db, checkpoint.id)).state, 'applied');
  assert.deepEqual(Buffer.from(await (await restarted.bucket.get(objectKey)).arrayBuffer()), Buffer.from(image.bytes));
  assert.equal((await apply(restarted, checkpoint)).action, 'recovered');
  assert.equal(await count(restarted.db, 'ftw_import_guard_assertions'), 0);
});

test('same-version edits after preparation abort the entire apply without deleting staged blobs', async t => {
  const service = await serviceFor(t);
  const first = await prepare(service);
  await apply(service, first);
  const second = await prepare(service, { title: 'Upstream edit' });
  await service.db.prepare("UPDATE listings SET title='Owner edit without a version bump'").run();
  await assert.rejects(apply(service, second), /unresolved|stale|guard/i);
  assert.equal((await service.db.prepare('SELECT title FROM listings').first()).title, 'Owner edit without a version bump');
  assert.equal((await readFtwCheckpoint(service.db, second.id)).state, 'prepared');
  assert.ok(await service.bucket.get(objectKey));
  assert.equal(await count(service.db, 'ftw_import_guard_assertions'), 0);
});

test('upstream updates and compensating restore keep canonical versions monotonic and mappings replayable', async t => {
  const service = await serviceFor(t);
  const first = await prepare(service, { photoStatus: 'approved' });
  await apply(service, first);
  const second = await prepare(service, { title: 'Updated upstream', status: 'hidden', photoStatus: 'rejected' });
  await apply(service, second);
  const changed = await service.db.prepare('SELECT * FROM listings').first();
  assert.equal(changed.title, 'Updated upstream');
  assert.equal(changed.version, 2);
  assert.equal((await service.db.prepare('SELECT version FROM photos').first()).version, 2);
  assert.equal((await restore(service, second)).action, 'restored');
  const restored = await service.db.prepare('SELECT * FROM listings').first();
  assert.equal(restored.title, 'Source title');
  assert.equal(restored.status, 'published');
  assert.equal(restored.version, 3);
  assert.equal((await service.db.prepare('SELECT version FROM photos').first()).version, 3);
  const replay = await prepareFtwCheckpoint({ db: service.db, input: input({ photoStatus: 'approved' }), now: now + 3000 });
  assert.equal(replay.artifact.plan.listings.length, 0);
  assert.equal(replay.artifact.plan.photos.length, 0);
  assert.equal((await apply(service, replay, { assets: [] })).action, 'applied');
  assert.equal(await count(service.db, 'review_events'), 4);
  await assert.rejects(apply(service, second), /restored/i);
  assert.equal(await count(service.db, 'ftw_import_guard_assertions'), 0);
});

test('lost responses resolve against durable apply and restore checkpoints', async t => {
  const service = await serviceFor(t);
  const checkpoint = await prepare(service);
  const lostResponseDb = { prepare: sql => service.db.prepare(sql), batch: async statements => {
    await service.db.batch(statements);
    throw new Error('Simulated response lost after successful commit');
  } };
  assert.equal((await apply(service, checkpoint, { db: lostResponseDb })).action, 'recovered');
  assert.equal(await count(service.db, 'listings'), 1);
  assert.equal((await restore(service, checkpoint, { db: lostResponseDb })).action, 'recovered');
  assert.equal(await count(service.db, 'listings'), 0);
  assert.equal((await restore(service, checkpoint)).action, 'recovered');
  assert.ok(await service.bucket.get(objectKey));
  assert.equal(await count(service.db, 'ftw_import_guard_assertions'), 0);
});

test('a genuine SQL failure rolls back canonical writes and ledger state while preserving immutable blobs', async t => {
  const service = await serviceFor(t);
  const checkpoint = await prepare(service);
  const failingDb = { prepare: sql => service.db.prepare(sql), batch: statements => service.db.batch([
    ...statements, service.db.prepare('INSERT INTO seasons(id,kind,year,name) VALUES(NULL,?,?,?)').bind('halloween', 2026, 'Force constraint error')
  ]) };
  await assert.rejects(apply(service, checkpoint, { db: failingDb }), /unresolved|constraint/i);
  assert.equal(await count(service.db, 'listings'), 0);
  assert.equal(await count(service.db, 'source_mappings'), 0);
  assert.equal((await readFtwCheckpoint(service.db, checkpoint.id)).state, 'prepared');
  assert.ok(await service.bucket.get(objectKey));
  assert.equal(await count(service.db, 'ftw_import_guard_assertions'), 0);
});

test('immutable object creation races cannot commit a mismatched asset', async t => {
  const service = await serviceFor(t);
  const checkpoint = await prepare(service);
  const raceBucket = {
    get: key => service.bucket.get(key),
    put: async key => { await service.bucket.put(key, new Uint8Array([1, 2, 3])); return null; }
  };
  await assert.rejects(apply(service, checkpoint, { bucket: raceBucket }), /different|immutable|hash|race/i);
  assert.equal(await count(service.db, 'photos'), 0);
  assert.equal((await readFtwCheckpoint(service.db, checkpoint.id)).state, 'prepared');
});

test('a location-only correction cannot move a skipped published listing out of coverage', async t => {
  const service = await serviceFor(t);
  const first = await prepare(service);
  await apply(service, first);
  const movedInput = input();
  movedInput.locationManifest = { 'source-listing-one': { neighborhoodId: 'old-northeast', latitude: 0, longitude: 0 } };
  const moved = await prepareFtwCheckpoint({ db: service.db, input: movedInput, now: now + 10 });
  assert.equal(moved.artifact.plan.listings.length, 0);
  assert.equal(moved.artifact.plan.locations.length, 1);
  await assert.rejects(apply(service, moved), /outside|covered|bounds|core/i);
  assert.equal((await service.db.prepare('SELECT latitude FROM locations').first()).latitude, 27.7814624);
});

test('restore refuses newer user data or moderation history and never leaves partial deletes', async t => {
  const service = await serviceFor(t);
  const checkpoint = await prepare(service);
  await apply(service, checkpoint);
  const listing = await service.db.prepare('SELECT * FROM listings').first();
  await service.db.prepare("UPDATE listings SET title='Later owner edit'").run();
  await assert.rejects(restore(service, checkpoint), /unresolved|guard|constraint/i);
  assert.equal((await service.db.prepare('SELECT title FROM listings').first()).title, 'Later owner edit');
  await service.db.prepare('UPDATE listings SET title=?').bind(listing.title).run();
  await service.db.prepare('INSERT INTO heart_counts(listing_id,count) VALUES(?,?)').bind(listing.id, 1).run();
  await assert.rejects(restore(service, checkpoint), /unresolved|foreign|constraint/i);
  assert.equal(await count(service.db, 'listings'), 1);
  assert.equal(await count(service.db, 'source_mappings'), 4);
  await service.db.prepare('DELETE FROM heart_counts').run();
  await service.db.prepare("INSERT INTO review_events(entity_type,entity_id,new_status,created_at) VALUES('listing',?,'published',?)").bind(listing.id, now + 1).run();
  await assert.rejects(restore(service, checkpoint), /unresolved|guard|constraint/i);
  assert.equal(await count(service.db, 'listings'), 1);
  assert.equal(await count(service.db, 'ftw_import_guard_assertions'), 0);
});

test('checkpoint state is asserted inside the transaction even if its ledger row disappears', async t => {
  const service = await serviceFor(t);
  const checkpoint = await prepare(service);
  const disappearedDb = { prepare: sql => service.db.prepare(sql), batch: async statements => {
    await service.db.prepare('DELETE FROM ftw_import_checkpoints WHERE id=?').bind(checkpoint.id).run();
    return service.db.batch(statements);
  } };
  await assert.rejects(apply(service, checkpoint, { db: disappearedDb }), /unresolved|constraint/i);
  assert.equal(await count(service.db, 'listings'), 0);
  assert.equal(await count(service.db, 'source_mappings'), 0);
  assert.equal(await count(service.db, 'ftw_import_guard_assertions'), 0);
});

test('exact retry uses SQLite binary key ordering and concurrent duplicate applies converge', async t => {
  const service = await serviceFor(t);
  for (const id of ['Z', 'a', 'A', 'z']) {
    await service.db.prepare('INSERT INTO seasons(id,kind,year,name) VALUES(?,?,?,?)').bind(id, 'halloween', 2020, id).run();
  }
  const checkpoint = await prepare(service);
  const results = await Promise.all([apply(service, checkpoint), apply(service, checkpoint)]);
  assert.ok(results.some(result => result.action === 'applied'));
  assert.ok(results.every(result => ['applied', 'recovered'].includes(result.action)));
  assert.equal(await count(service.db, 'listings'), 1);
  assert.equal((await apply(service, checkpoint)).action, 'recovered');
  assert.equal(await count(service.db, 'ftw_import_guard_assertions'), 0);
});

test('invalid approval, altered artifacts, unsupported pilot inputs and uncovered published locations fail closed', async t => {
  const service = await serviceFor(t);
  const checkpoint = await prepare(service);
  await assert.rejects(apply(service, checkpoint, { expectedId: 'wrong' }), /expected|checkpoint/i);
  await assert.rejects(prepareFtwCheckpoint({ db: service.db, input: { ...input(), sourceSystem: 'ftw-public-pilot' } }), /pilot|sourceSystem/);
  const uncovered = input();
  uncovered.records[0].address_match.latitude = 28.8;
  const bad = await prepareFtwCheckpoint({ db: service.db, input: uncovered, now });
  await assert.rejects(apply(service, bad), /outside|covered|bounds|core/i);
  assert.equal(await count(service.db, 'listings'), 0);
  await service.db.prepare("UPDATE ftw_import_checkpoints SET artifact_json=json_set(artifact_json,'$.input.records[0].theme','altered') WHERE id=?").bind(checkpoint.id).run();
  await assert.rejects(apply(service, checkpoint), /hash|invalid|corrupt/i);
});
