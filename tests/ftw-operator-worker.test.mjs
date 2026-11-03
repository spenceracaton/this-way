import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFtwOperatorRuntime } from './helpers/ftw-operator-runtime.mjs';
import operatorWorker from '../operator/worker.mjs';

const now = 1793740000000;
const token = 'local-only-operator-token-32-bytes-minimumx';
const commandKey = runId => `ftw-operator/${runId}/command.json`;
const sha = value => createHash('sha256').update(value).digest('hex');
const counts = async db => Object.fromEntries(await Promise.all(
  ['listings', 'photos', 'ftw_import_checkpoints'].map(async table => [table,
    (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n])
));

function sourceInput() {
  return {
    sourceSystem: 'fright-this-way',
    timestampUnit: 'milliseconds',
    locationManifest: { 'source-listing-one': { neighborhoodId: 'old-northeast', latitude: 27.7814624, longitude: -82.63175289 } },
    records: [{
      id: 'source-listing-one', season_year: 2026, address: '12 Maple St', status: 'approved',
      theme: 'Synthetic test listing', version: 1, created_at: now - 1000, updated_at: now,
      address_match: { neighborhoodId: 'old-northeast', latitude: 27.7814624, longitude: -82.63175289 },
      photos: [],
    }],
    assetManifest: { assets: [] },
  };
}

async function execute(t, { operation, input, checkpointId, reason, body, runId = 'test-run-0001', expiresAt = String(Date.now() + 60_000), commandOverrides = {}, persistPath }) {
  const command = {
    version: 1, runId, operation, issuedAt: Date.now(), expiresAt: Number(expiresAt),
    bundleDigest: 'a'.repeat(64),
    ...(input ? { input } : {}),
    sourceEvidence: { source: 'synthetic-test-fixture', bundleDigest: 'a'.repeat(64), operatorContract: 'ftw-operator-v1' },
    ...(checkpointId ? { checkpointId } : {}), ...(reason ? { reason } : {}),
    ...commandOverrides,
  };
  const raw = Buffer.from(JSON.stringify(command));
  const key = commandKey(runId);
  const service = await createFtwOperatorRuntime({
    token, commandKey: key, commandSha256: sha(raw), runId, expiresAt,
    persistPath,
  });
  t.after(() => service.dispose());
  await service.controlBucket.put(key, raw, { httpMetadata: { contentType: 'application/json' } });
  const response = await service.request('/execute', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body }),
  });
  return { service, response, command };
}

test('operator endpoint authenticates before command lookup and execution', async t => {
  const service = await createFtwOperatorRuntime({ token, commandKey: commandKey('test-run-0001'), commandSha256: '0'.repeat(64) });
  t.after(() => service.dispose());
  const before = await counts(service.db);
  const response = await service.request('/execute', { method: 'POST', body: 'not-json' });
  assert.equal(response.status, 404);
  assert.deepEqual(await counts(service.db), before);
  assert.equal(await service.controlBucket.get(commandKey('test-run-0001')), null);
  const authenticated = await service.request('/execute', {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(authenticated.status, 400);
  assert.match((await authenticated.json()).message, /missing/i);
  assert.deepEqual(await counts(service.db), before);
});

test('operator command prepares a scoped checkpoint, applies its pinned command and restores after restart', async t => {
  const persistPath = await mkdtemp(join(tmpdir(), 'ftw-operator-'));
  t.after(() => rm(persistPath, { recursive: true, force: true }));
  const prepared = await execute(t, { operation: 'prepare', input: sourceInput(), persistPath });
  assert.equal(prepared.response.status, 200, await prepared.response.clone().text());
  const prepareJson = await prepared.response.json();
  assert.equal(prepareJson.ok, true);
  const checkpointId = prepareJson.result.id;
  assert.match(checkpointId, /^ftw_[a-f0-9]{32}$/);
  assert.equal(prepareJson.result.state, 'prepared');
  assert.equal((await counts(prepared.service.db)).listings, 0);
  await prepared.service.dispose();

  const applied = await execute(t, { operation: 'apply', input: sourceInput(), checkpointId, body: { assets: [] }, persistPath });
  assert.equal(applied.response.status, 200, await applied.response.clone().text());
  const applyJson = await applied.response.json();
  assert.equal(applyJson.ok, true);
  assert.equal(applyJson.result.action, 'applied');
  assert.equal(applyJson.result.checkpoint.state, 'applied');
  assert.equal((await counts(applied.service.db)).listings, 1);
  await applied.service.dispose();

  const status = await execute(t, { operation: 'status', checkpointId, persistPath });
  assert.equal(status.response.status, 200);
  assert.equal((await status.response.json()).result.state, 'applied');
  await status.service.dispose();

  const restored = await execute(t, { operation: 'restore', checkpointId, reason: 'Synthetic operator integration recovery', persistPath });
  assert.equal(restored.response.status, 200);
  const restoreJson = await restored.response.json();
  assert.equal(restoreJson.result.action, 'restored');
  assert.equal(restoreJson.result.checkpoint.state, 'restored');
  assert.equal((await counts(restored.service.db)).listings, 0);
  assert.equal((await counts(restored.service.db)).photos, 0);
});

test('expired or tampered operator commands fail closed without canonical writes', async t => {
  const persistPath = await mkdtemp(join(tmpdir(), 'ftw-operator-invalid-'));
  t.after(() => rm(persistPath, { recursive: true, force: true }));
  const expired = await execute(t, { operation: 'prepare', input: sourceInput(), expiresAt: String(Date.now() - 1), persistPath });
  assert.notEqual(expired.response.status, 200);
  assert.equal((await counts(expired.service.db)).listings, 0);
  await expired.service.dispose();

  const runtime = await createFtwOperatorRuntime({ token, commandKey: commandKey('test-run-0001'), commandSha256: '0'.repeat(64), persistPath });
  t.after(() => runtime.dispose());
  await runtime.controlBucket.put(commandKey('test-run-0001'), JSON.stringify({ version: 1, operation: 'prepare' }));
  const response = await runtime.request('/execute', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.notEqual(response.status, 200);
  assert.equal((await counts(runtime.db)).listings, 0);
});

test('operator rejects source records outside its approved neighborhood, season and count bounds', async t => {
  const persistPath = await mkdtemp(join(tmpdir(), 'ftw-operator-scope-'));
  t.after(() => rm(persistPath, { recursive: true, force: true }));
  const input = sourceInput();
  input.records[0].status = 'pending';
  const result = await execute(t, { operation: 'prepare', input, persistPath });
  assert.notEqual(result.response.status, 200);
  assert.equal((await counts(result.service.db)).listings, 0);
  assert.equal((await counts(result.service.db)).ftw_import_checkpoints, 0);
});

test('an unrelated D1 batch error cannot be recorded as successful rollback proof', async () => {
  const runId = 'probe-network-error', issuedAt = Date.now(), expiresAt = issuedAt + 60_000;
  const command = { version: 1, runId, operation: 'prepare', issuedAt, expiresAt,
    bundleDigest: 'a'.repeat(64), input: sourceInput(),
    sourceEvidence: { operatorContract: 'ftw-operator-v1', bundleDigest: 'a'.repeat(64) } };
  const bytes = Buffer.from(JSON.stringify(command));
  let batches = 0, writes = 0;
  const statement = {
    bind() { return this; },
    async all() { return { results: [] }; },
    async run() { writes++; return {}; },
    async first() { return null; }
  };
  const db = {
    prepare() { return statement; },
    async batch() {
      batches++;
      if (batches === 1) throw new Error('Transient D1 network failure');
      return Array.from({ length: 5 }, () => ({ results: [] }));
    }
  };
  const response = await operatorWorker.fetch(new Request('https://operator.example/execute', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }
  }), { DB: db, PHOTOS: {}, CONTROL: { get: async () => ({ size: bytes.length, arrayBuffer: async () => bytes }) },
    OPERATOR_TOKEN: token, COMMAND_KEY: commandKey(runId), COMMAND_SHA256: sha(bytes), RUN_ID: runId, EXPIRES_AT: String(expiresAt) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /atomic rollback verification failed/);
  assert.equal(batches, 1, 'checkpoint preparation must not start after an unproven probe');
  assert.equal(writes, 0);
});
