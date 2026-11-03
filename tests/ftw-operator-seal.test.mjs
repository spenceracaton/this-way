import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUploadKey } from '../scripts/lib/ftw-operator-envelope.mjs';
import { sealPayloadFromWorkflow } from '../scripts/seal-ftw-operator-payload.mjs';

const repository = 'spenceracaton/this-way';
const runId = '1234567890';
const commit = 'a'.repeat(40);
const releaseId = '1234567890-42';
const payload = JSON.stringify({ version: 1, bundle: { schemaVersion: 1, records: Array.from({ length: 5 }, (_, i) => ({ id: `synthetic-${i}` })) } });
const digest = createHash('sha256').update(payload.trim()).digest('hex');

async function fixture(t, artifactMode = 'valid') {
  const root = await mkdtemp(join(tmpdir(), 'ftw-seal-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'payload.json'), output = join(root, 'workflow-inputs.json');
  await writeFile(input, payload, { mode: 0o600 });
  const pair = createUploadKey({ exchangeId: 'b'.repeat(32), bundleDigest: digest, commit, repository, now: Date.now() });
  const wrapper = { operation: 'upload-key', repository, workflowRunId: runId,
    admission: { commit, releaseId }, receipt: pair.publicReceipt };
  const run = { id: Number(runId), repository: { full_name: repository }, head_repository: { full_name: repository },
    head_branch: 'main', head_sha: commit, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    path: '.github/workflows/ftw-import.yml@refs/heads/main' };
  const main = { sha: commit };
  const checks = { workflow_runs: [{ head_sha: commit, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' }] };
  const artifact = { id: 55, name: 'ftw-upload-key', expired: false, size_in_bytes: Buffer.byteLength(JSON.stringify(wrapper)) };
  const artifactList = { total_count: 1, artifacts: [artifact] };
  const live = { commit, release_id: releaseId };
  const calls = [];
  const gh = args => {
    calls.push(args);
    if (args[0] === 'api') {
      const path = args.at(-1);
      if (path === `repos/${repository}/actions/runs/${runId}`) return JSON.stringify(run);
      if (path === `repos/${repository}/commits/main`) return JSON.stringify(main);
      if (path.startsWith(`repos/${repository}/actions/workflows/check.yml/runs?`)) return JSON.stringify(checks);
      if (path === `repos/${repository}/actions/runs/${runId}/artifacts`) return JSON.stringify(artifactList);
      throw new Error(`unexpected API path ${path}`);
    }
    if (args[0] === 'run' && args[1] === 'download') {
      const dir = args[args.indexOf('--dir') + 1];
      if (artifactMode === 'symlink') return symlink(input, join(dir, 'ftw-upload-key.json'));
      if (artifactMode === 'extra') {
        return Promise.all([writeFile(join(dir, 'ftw-upload-key.json'), JSON.stringify(wrapper)), writeFile(join(dir, 'extra.txt'), 'extra')]);
      }
      if (artifactMode === 'oversize') return writeFile(join(dir, 'ftw-upload-key.json'), 'x'.repeat(16 * 1024 + 1));
      if (artifactMode === 'invalid-json') return writeFile(join(dir, 'ftw-upload-key.json'), '{');
      return writeFile(join(dir, 'ftw-upload-key.json'), JSON.stringify(wrapper));
    }
    throw new Error(`unexpected gh invocation ${args.join(' ')}`);
  };
  return { root, input, output, pair, wrapper, run, main, checks, artifact, artifactList, live, calls, gh };
}

test('seals only after authenticating a successful upload-key run and keeps plaintext out of output', async t => {
  const fx = await fixture(t);
  const result = await sealPayloadFromWorkflow({ input: fx.input, runId, expectedCommit: commit, output: fx.output, gh: fx.gh, getLive: () => fx.live });
  const serialized = await readFile(fx.output, 'utf8');
  const inputs = JSON.parse(serialized);
  assert.equal(result.uploadKeyRunId, runId);
  assert.equal(inputs.operation, 'prepare');
  assert.equal(inputs.bundle_sha256, digest);
  assert.equal(inputs.exchange_id, fx.pair.publicReceipt.exchangeId);
  assert.ok(inputs.encrypted_payload);
  assert.ok(!serialized.includes(payload));
  assert.ok(!JSON.stringify(result).includes(payload));
  assert.equal(fx.calls.filter(args => args[0] === 'run' && args[1] === 'download').length, 1);
});

for (const mode of ['symlink', 'extra', 'oversize', 'invalid-json']) {
  test(`rejects ${mode} upload-key artifact contents`, async t => {
    const fx = await fixture(t, mode);
    await assert.rejects(sealPayloadFromWorkflow({ input: fx.input, runId, expectedCommit: commit, output: fx.output, gh: fx.gh, getLive: () => fx.live }));
    await assert.rejects(readFile(fx.output));
  });
}

for (const invalid of ['wrong-run', 'wrong-check', 'wrong-live']) {
  test(`rejects ${invalid} provenance before downloading the artifact`, async t => {
    const fx = await fixture(t);
    if (invalid === 'wrong-run') fx.run.head_sha = 'c'.repeat(40);
    if (invalid === 'wrong-check') fx.checks.workflow_runs[0].conclusion = 'failure';
    if (invalid === 'wrong-live') fx.live.commit = 'd'.repeat(40);
    await assert.rejects(sealPayloadFromWorkflow({ input: fx.input, runId, expectedCommit: commit, output: fx.output, gh: fx.gh, getLive: () => fx.live }));
    assert.equal(fx.calls.some(args => args[0] === 'run' && args[1] === 'download'), false);
    await assert.rejects(readFile(fx.output));
  });
}

test('requires a unique, unexpired, bounded upload-key artifact', async t => {
  const fx = await fixture(t);
  fx.artifact.expired = true;
  await assert.rejects(sealPayloadFromWorkflow({ input: fx.input, runId, expectedCommit: commit, output: fx.output, gh: fx.gh, getLive: () => fx.live }));
  assert.equal(fx.calls.some(args => args[0] === 'run' && args[1] === 'download'), false);
});

for (const mode of ['missing', 'duplicate']) {
  test(`rejects ${mode} public-key artifacts before download`, async t => {
    const fx = await fixture(t);
    fx.artifactList.artifacts = mode === 'missing' ? [] : [fx.artifact, { ...fx.artifact, id: 56 }];
    fx.artifactList.total_count = fx.artifactList.artifacts.length;
    await assert.rejects(sealPayloadFromWorkflow({ input: fx.input, runId, expectedCommit: commit, output: fx.output, gh: fx.gh, getLive: () => fx.live }), e => e.code === 'upload_key_artifact_ambiguous');
    assert.equal(fx.calls.some(args => args[0] === 'run' && args[1] === 'download'), false);
  });
}
