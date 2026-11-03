import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rehearseFtwCheckpoint } from '../scripts/rehearse-ftw-checkpoint.mjs';
import { sanitizeImage } from '../server/image.mjs';

test('private checkpoint command prepares, applies, restarts, restores and refuses unsafe inputs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ftw-checkpoint-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = await readFile(new URL('./fixtures/metadata-test.jpg', import.meta.url));
  const decoded = sanitizeImage(image, 'image/jpeg');
  await writeFile(join(directory, 'photo.jpg'), image);
  const bundle = {
    schemaVersion: 1,
    provenance: { kind: 'authenticated-content-export', sourceSystem: 'fright-this-way', captureId: 'synthetic-cli-fixture',
      capturedAt: '2026-11-03T12:00:00Z', authoritativeSystem: 'synthetic-local-test', exporterVersion: 'test-1',
      timestampUnit: 'milliseconds', complete: true, scope: { seasons: [2026], neighborhoods: ['old-northeast'] },
      unavailableFields: ['reviewHistory'] },
    records: [{ id: 'synthetic-cli-listing', season_year: 2026, status: 'approved', address: 'Synthetic fixture',
      created_at: 1793740000000, updated_at: 1793740000000, version: 1,
      address_match: { neighborhoodId: 'old-northeast', latitude: 27.7814624, longitude: -82.63175289 },
      photos: [{ id: 'synthetic-cli-photo', object_key: 'source/photo.jpg', created_at: 1793740000000,
        status: 'pending', position: 0, version: 1 }] }],
    assetManifest: { assets: [{ sourceKey: 'source/photo.jpg', path: 'photo.jpg',
      originalContentHash: `sha256:${createHash('sha256').update(image).digest('hex')}`,
      mediaType: 'image/jpeg', width: decoded.width, height: decoded.height }] }
  };
  const bundlePath = join(directory, 'bundle.json');
  await writeFile(bundlePath, JSON.stringify(bundle));
  const output = join(directory, 'private-output');
  const options = { local: true, command: 'prepare', bundle: bundlePath, output };
  await assert.rejects(rehearseFtwCheckpoint({ ...options, local: false }), /--local/);
  await assert.rejects(rehearseFtwCheckpoint({ ...options, output: new URL('../private-should-not-exist', import.meta.url).pathname }), /outside/);
  const prepared = await rehearseFtwCheckpoint(options);
  assert.equal(prepared.state, 'prepared');
  assert.equal(prepared.counts.listings, 0);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.equal((await stat(join(output, 'workspace.json'))).mode & 0o777, 0o600);
  await assert.rejects(rehearseFtwCheckpoint(options), /EEXIST/);
  const subsequent = { local: true, workspace: output, expectedId: prepared.checkpointId };
  await assert.rejects(rehearseFtwCheckpoint({ ...subsequent, command: 'apply', expectedId: 'wrong' }), /exact reviewed/);
  const applied = await rehearseFtwCheckpoint({ ...subsequent, command: 'apply' });
  assert.equal(applied.state, 'applied');
  assert.equal(applied.counts.listings, 1);
  assert.equal(applied.counts.photos, 1);
  assert.equal(applied.productionWrites, 0);
  assert.equal((await rehearseFtwCheckpoint({ ...subsequent, command: 'status' })).state, 'applied');
  assert.equal((await rehearseFtwCheckpoint({ ...subsequent, command: 'apply' })).action, 'recovered');
  const manifestPath = join(output, 'workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const cachedImage = join(output, manifest.assets[0].path);
  await writeFile(cachedImage, Buffer.from('changed'));
  await assert.rejects(rehearseFtwCheckpoint({ ...subsequent, command: 'apply' }), /cache changed/);
  // Restore reads the durable checkpoint; source files and cached blobs are not its authority.
  const restored = await rehearseFtwCheckpoint({ ...subsequent, command: 'restore', reason: 'Synthetic recovery acceptance' });
  assert.equal(restored.state, 'restored');
  assert.equal(restored.counts.listings, 0);
  assert.equal(restored.counts.photos, 0);
  assert.equal((await rehearseFtwCheckpoint({ ...subsequent, command: 'restore', reason: 'Retry' })).action, 'recovered');
  await assert.rejects(rehearseFtwCheckpoint({ ...subsequent, command: 'apply' }), /cache changed|restored/);
  const escape = join(directory, 'checkout-link');
  await symlink(new URL('..', import.meta.url).pathname, escape);
  await assert.rejects(rehearseFtwCheckpoint({ ...options, output: join(escape, 'private-data') }), /outside/);
});
