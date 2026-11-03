import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyUploadKeyReceipt } from '../scripts/lib/ftw-upload-receipt.mjs';

const commit = 'a'.repeat(40);
const bundleDigest = 'b'.repeat(64);
const runId = '98765';
function fixture() {
  const releaseId = '123-456';
  const run = { id: Number(runId), repository: { full_name: 'spenceracaton/this-way' }, head_repository: { full_name: 'spenceracaton/this-way' }, head_branch: 'main', head_sha: commit, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', path: '.github/workflows/ftw-import.yml@refs/heads/main' };
  const main = { sha: commit };
  const checks = { workflow_runs: [{ head_sha: commit, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' }] };
  const live = { commit, release_id: releaseId };
  const artifact = { id: 13579, name: 'ftw-upload-key', expired: false, size_in_bytes: 1024, workflow_run: { id: Number(runId), head_sha: commit, head_branch: 'main' } };
  const wrapper = { operation: 'upload-key', repository: 'spenceracaton/this-way', workflowRunId: runId, admission: { commit, releaseId }, receipt: { purpose: 'ftw-operator-upload-key', version: 1, repository: 'spenceracaton/this-way', exchangeId: 'c'.repeat(32), bundleDigest, commit, createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T01:00:00.000Z', fingerprint: 'd'.repeat(64), publicKey: 'synthetic-public-key' } };
  return { runId, expectedCommit: commit, bundleDigest, run, main, checks, live, artifact, wrapper };
}

test('trust receipt accepts matching successful upload run, artifact, push checks, and live main provenance', () => {
  const input = fixture();
  assert.equal(verifyUploadKeyReceipt(input), input.wrapper.receipt);
});

test('trust receipt rejects ownership, workflow identity, keyless, and stale provenance mismatches', () => {
  const cases = [
    x => { x.run.repository.full_name = 'other/repo'; },
    x => { x.run.head_branch = 'feature'; },
    x => { x.run.event = 'pull_request'; },
    x => { x.run.status = 'in_progress'; },
    x => { x.run.conclusion = 'failure'; },
    x => { x.run.path = '.github/workflows/other.yml'; },
    x => { x.main.sha = 'e'.repeat(40); },
    x => { x.live.commit = 'e'.repeat(40); },
    x => { x.checks.workflow_runs[0].conclusion = 'failure'; },
    x => { x.artifact.name = 'different-artifact'; },
    x => { x.artifact.expired = true; },
    x => { x.artifact.workflow_run.head_sha = 'e'.repeat(40); },
    x => { x.wrapper.workflowRunId = '123'; },
    x => { x.wrapper.receipt.privateKey = 'must-never-escape'; },
    x => { x.wrapper.admission.releaseId = '999-111'; }
  ];
  for (const alter of cases) {
    const input = fixture();
    alter(input);
    assert.throws(() => verifyUploadKeyReceipt(input), e => e.code === 'upload_key_receipt_untrusted');
  }
});

test('trust receipt rejects oversized or ambiguously associated artifacts and incomplete checks', () => {
  for (const alter of [
    x => { x.artifact.size_in_bytes = 16 * 1024 + 1; },
    x => { x.artifact.id = 0; },
    x => { x.artifact.workflow_run.id = 111; },
    x => { x.checks.workflow_runs = []; },
    x => { x.run.id = 111; },
    x => { x.wrapper.extra = true; },
    x => { x.expectedCommit = 'bad'; },
    x => { x.bundleDigest = 'bad'; }
  ]) {
    const input = fixture();
    alter(input);
    assert.throws(() => verifyUploadKeyReceipt(input), e => e.code === 'upload_key_receipt_untrusted');
  }
});
