import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyArtifact, rollbackTarget, finalizeReceipt } from '../scripts/release.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'this-way-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'public'));
  const { $schema, ...config } = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const configBytes = JSON.stringify(config);
  const identity = JSON.stringify({ commit: 'known-commit', release_id: 'run-1' });
  await writeFile(path.join(root, 'wrangler.jsonc'), configBytes);
  await writeFile(path.join(root, 'public/index.html'), '<p>Map release A</p>');
  await writeFile(path.join(root, 'public/release.json'), identity);
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ commit: 'known-commit', release_id: 'run-1',
    config_sha256: digest(configBytes), files: { 'index.html': digest('<p>Map release A</p>'), 'release.json': digest(identity) } }));
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
