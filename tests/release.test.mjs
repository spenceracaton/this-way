import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyArtifact, rollbackTarget, finalizeReceipt, ensureServiceResources, validateOwnerSecrets } from '../scripts/release.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'this-way-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'public'));
  await mkdir(path.join(root, 'server'));
  await mkdir(path.join(root, 'migrations'));
  const { $schema, ...config } = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const configBytes = JSON.stringify(config);
  const identity = JSON.stringify({ commit: 'known-commit', release_id: 'run-1' });
  const worker = 'export default { fetch() { return new Response("ok"); } };';
  const migration = 'CREATE TABLE example (id TEXT PRIMARY KEY);';
  await writeFile(path.join(root, 'wrangler.jsonc'), configBytes);
  await writeFile(path.join(root, 'public/index.html'), '<p>Map release A</p>');
  await writeFile(path.join(root, 'public/release.json'), identity);
  await writeFile(path.join(root, 'server/index.mjs'), worker);
  await writeFile(path.join(root, 'migrations/0001_initial.sql'), migration);
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ commit: 'known-commit', release_id: 'run-1',
    config_sha256: digest(configBytes), files: {
      'public/index.html': digest('<p>Map release A</p>'), 'public/release.json': digest(identity),
      'server/index.mjs': digest(worker), 'migrations/0001_initial.sql': digest(migration)
    } }));
  return root;
}

test('release verifier accepts matching bytes and rejects a different source commit', async t => {
  const root = await fixture(t);
  await verifyArtifact(root, 'known-commit');
  await assert.rejects(verifyArtifact(root, 'different-commit'), /commit does not match/);
});

test('release verifier rejects a changed asset and an added file', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'public/index.html'), '<p>Unverified replacement</p>');
  await assert.rejects(verifyArtifact(root, 'known-commit'), /bytes changed/);
  await writeFile(path.join(root, 'public/extra.html'), 'not in manifest');
  await assert.rejects(verifyArtifact(root, 'known-commit'), /inventory changed/);
});

test('release verifier rejects altered, missing, and extra Worker and migration files', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'server/index.mjs'), 'changed worker');
  await assert.rejects(verifyArtifact(root, 'known-commit'), /bytes changed: server\/index.mjs/);
  await writeFile(path.join(root, 'server/index.mjs'), 'export default { fetch() { return new Response("ok"); } };');
  await rm(path.join(root, 'migrations/0001_initial.sql'));
  await assert.rejects(verifyArtifact(root, 'known-commit'), /inventory changed/);
  await writeFile(path.join(root, 'migrations/0001_initial.sql'), 'CREATE TABLE example (id TEXT PRIMARY KEY);');
  await writeFile(path.join(root, 'server/extra.mjs'), 'unexpected');
  await assert.rejects(verifyArtifact(root, 'known-commit'), /inventory changed/);
});

test('release verifier rejects a changed deployment configuration', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'wrangler.jsonc'), '{}');
  await assert.rejects(verifyArtifact(root, 'known-commit'), /configuration changed/);
});

test('rollback requires an explicitly previously deployed version, not current or merely uploaded code', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const c = '33333333-3333-4333-8333-333333333333';
  const activeDeployment = '44444444-4444-4444-8444-444444444444';
  const history = [b, a].map((version_id, index) => ({
    id: index ? '55555555-5555-4555-8555-555555555555' : activeDeployment,
    versions: [{ version_id, percentage: 100 }]
  }));
  assert.equal(rollbackTarget(history, a, activeDeployment), a);
  assert.throws(() => rollbackTarget(history, b, activeDeployment), /already active/);
  assert.throws(() => rollbackTarget(history, c, activeDeployment), /not a previous full deployment/);
  assert.throws(() => rollbackTarget(history, '', activeDeployment), /explicit version UUID/);
  assert.throws(() => rollbackTarget(history, a, c), /changed after rollback was requested/);
  assert.throws(() => rollbackTarget(history, a, ''), /expected active deployment UUID/);
});

test('production receipt remains pending until browser verification finalizes it', async t => {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  delete process.env.GITHUB_STEP_SUMMARY;
  t.after(() => {
    if (summaryPath === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = summaryPath;
  });
  const root = await mkdtemp(path.join(tmpdir(), 'this-way-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'receipt.json'), JSON.stringify({
    url: 'https://example.test', commit: 'known-commit', version_id: 'version-1',
    deployment_id: 'deployment-1', previous_version_id: 'version-0',
    outcome: 'published_verification_pending', verified: false
  }));
  const receipt = await finalizeReceipt(root);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.outcome, 'verified');
  assert.match(receipt.verified_at, /^\d{4}-\d{2}-\d{2}T/);
  await assert.rejects(finalizeReceipt(root), /already finalized/);
});

test('owner secret validation requires the configured PBKDF2 verifier and a long service secret', () => {
  const verifier = `pbkdf2-sha256$100000$${Buffer.alloc(16, 1).toString('base64')}$${Buffer.alloc(32, 2).toString('base64')}`;
  assert.equal(validateOwnerSecrets(verifier, 's'.repeat(32)), true);
  assert.throws(() => validateOwnerSecrets('plaintext-password', 's'.repeat(32)), /PBKDF2-SHA256 verifier/);
  assert.throws(() => validateOwnerSecrets(verifier, 'short'), /at least 32 characters/);
});

test('service resource provisioning creates only the exact named D1 database and R2 bucket', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ url: pathname, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    const creating = options.method === 'POST';
    const isD1 = pathname.startsWith('/client/v4/accounts/') && pathname.includes('/d1/database');
    const result = isD1 ? { name: 'this-way-listings', uuid: 'db-real-id' } : { name: 'this-way-photos' };
    if (!creating) return { ok: false, status: 404, json: async () => ({ success: false, errors: [{ message: 'not found' }] }) };
    return { ok: true, status: 200, json: async () => ({ success: true, result }) };
  };
  const created = await ensureServiceResources('test-token', fetcher);
  assert.deepEqual(created, {
    database_id: 'db-real-id', database_name: 'this-way-listings', bucket_name: 'this-way-photos',
    created_database: true, created_bucket: true
  });
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.body), [
    { name: 'this-way-listings' }, { name: 'this-way-photos' }
  ]);
  assert.deepEqual(calls.map(call => [call.method, call.url]), [
    ['GET', '/client/v4/accounts/60b5930216f6049236d2634115cbe0ce/d1/database/this-way-listings'],
    ['POST', '/client/v4/accounts/60b5930216f6049236d2634115cbe0ce/d1/database'],
    ['GET', '/client/v4/accounts/60b5930216f6049236d2634115cbe0ce/r2/buckets/this-way-photos'],
    ['POST', '/client/v4/accounts/60b5930216f6049236d2634115cbe0ce/r2/buckets']
  ]);
});

test('service resource provisioning reuses exact existing resources without creating duplicates', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push(options.method || 'GET');
    const result = new URL(url).pathname.includes('/d1/database/')
      ? { name: 'this-way-listings', uuid: 'existing-db-id' }
      : { name: 'this-way-photos' };
    return { ok: true, status: 200, json: async () => ({ success: true, result }) };
  };
  const found = await ensureServiceResources('test-token', fetcher);
  assert.deepEqual(found, {
    database_id: 'existing-db-id', database_name: 'this-way-listings', bucket_name: 'this-way-photos',
    created_database: false, created_bucket: false
  });
  assert.deepEqual(calls, ['GET', 'GET']);
});

test('resource provisioning rejects a mismatched name in a Cloudflare response', async () => {
  let calls = 0;
  const fetcher = async (_url, options = {}) => {
    calls++;
    const result = options.method === 'POST'
      ? { name: 'different-database', uuid: 'wrong-id' }
      : { name: 'different-database', uuid: 'wrong-id' };
    return { ok: true, status: 200, json: async () => ({ success: true, result }) };
  };
  await assert.rejects(ensureServiceResources('test-token', fetcher), /unexpected resource for this-way-listings/);
  assert.equal(calls, 1);
});

test('resource provisioning only creates after exact-name lookup returns 404', async () => {
  for (const status of [403, 500]) {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { ok: false, status, json: async () => ({ success: false, errors: [{ message: 'lookup failed' }] }) };
    };
    await assert.rejects(ensureServiceResources('test-token', fetcher), new RegExp(`Cloudflare API ${status}: lookup failed`));
    assert.equal(calls, 1);
  }
});
