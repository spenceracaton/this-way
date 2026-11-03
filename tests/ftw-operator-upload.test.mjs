import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decryptUploadedPayload, publishUploadKey, revokeUploadKey } from '../scripts/lib/ftw-operator-upload.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const payload = JSON.stringify({ synthetic: true, records: [{ id: 'fixture' }] });
const digest = sha(payload.trim());
const commit = 'a'.repeat(40);
const exchangeId = 'b'.repeat(32);
const now = Date.parse('2026-01-01T00:00:00.000Z');
function clientWithRecord(record = null) {
  const state = { record, writes: [], deletes: [], reads: 0 };
  return {
    state,
    async privateObject(path, bytes) { state.writes.push({ path, bytes: Buffer.from(bytes) }); },
    async readPrivateExchange(id) { state.reads++; return id === state.record?.exchangeId ? state.record : null; },
    async deletePrivateExchange(id) { state.deletes.push(id); state.record = null; return { verified: true }; }
  };
}

test('upload-key publishes only a public receipt and keeps recovery material in private storage', async () => {
  const client = clientWithRecord();
  const result = await publishUploadKey({ client, exchangeId, bundleDigest: digest, admission: { commit, releaseId: '123-456' }, workflowRunId: '98765', now });
  assert.equal(client.state.writes.length, 1);
  assert.equal(client.state.writes[0].path, `ftw-operator/${exchangeId}/exchange.json`);
  client.state.record = JSON.parse(client.state.writes[0].bytes.toString());
  assert.equal(client.state.record.exchangeId, exchangeId);
  assert.ok(client.state.record.privateKey);
  assert.equal(result.operation, 'upload-key');
  assert.equal(result.workflowRunId, '98765');
  assert.equal(result.receipt.privateKey, undefined);
  assert.ok(result.receipt.publicKey);
  assert.equal(JSON.stringify(result).includes(client.state.record.privateKey), false);
  assert.equal(JSON.stringify(result).includes('privateKey'), false);
});

test('payload recovery requires the private exchange record and returns plaintext only for its bound exchange', async () => {
  const privateClient = clientWithRecord();
  const keyClient = clientWithRecord();
  // Create a matching private record using the same public receipt context.
  const { createUploadKey, sealOperatorPayload } = await import('../scripts/lib/ftw-operator-envelope.mjs');
  const pair = createUploadKey({ exchangeId, bundleDigest: digest, commit, repository: 'spenceracaton/this-way', now });
  privateClient.state.record = pair.privateRecord;
  const encoded = sealOperatorPayload(payload, pair.publicReceipt, { expectedCommit: commit, now: now + 1000 });
  assert.equal(await decryptUploadedPayload({ client: privateClient, exchangeId, encoded, bundleDigest: digest, commit, now: now + 1000 }), payload);
  await assert.rejects(decryptUploadedPayload({ client: keyClient, exchangeId, encoded, bundleDigest: digest, commit, now: now + 1000 }), e => e.code === 'upload_key_missing');
  await assert.rejects(decryptUploadedPayload({ client: privateClient, exchangeId: 'c'.repeat(32), encoded, bundleDigest: digest, commit, now: now + 1000 }), e => e.code === 'upload_key_missing');
  await assert.rejects(decryptUploadedPayload({ client: privateClient, exchangeId, encoded, bundleDigest: digest, commit: 'd'.repeat(40), now: now + 1000 }), e => e.code === 'encrypted_payload_invalid_or_expired');
  await assert.rejects(decryptUploadedPayload({ client: privateClient, exchangeId, encoded, bundleDigest: digest, commit, now: now + 60 * 60 * 1000 }), e => e.code === 'encrypted_payload_invalid_or_expired');
});

test('expired keys remain revocable, while mismatched key identity blocks deletion', async () => {
  const { createUploadKey } = await import('../scripts/lib/ftw-operator-envelope.mjs');
  const expiredRecord = createUploadKey({ exchangeId, bundleDigest: digest, commit, repository: 'spenceracaton/this-way', now }).privateRecord;
  const expiredClient = clientWithRecord(expiredRecord);
  const result = await revokeUploadKey({ client: expiredClient, exchangeId, bundleDigest: digest });
  assert.deepEqual(result, { operation: 'revoke-key', exchangeId, bundleDigest: digest, revocationVerified: true, alreadyAbsent: false });
  assert.deepEqual(expiredClient.state.deletes, [exchangeId]);

  const wrong = createUploadKey({ exchangeId, bundleDigest: 'e'.repeat(64), commit, repository: 'spenceracaton/this-way', now }).privateRecord;
  const wrongClient = clientWithRecord(wrong);
  await assert.rejects(revokeUploadKey({ client: wrongClient, exchangeId, bundleDigest: digest }), e => e.code === 'upload_key_identity_mismatch');
  assert.deepEqual(wrongClient.state.deletes, []);

  const unverifiedClient = clientWithRecord(expiredRecord);
  unverifiedClient.deletePrivateExchange = async id => { unverifiedClient.state.deletes.push(id); return { verified: false }; };
  await assert.rejects(revokeUploadKey({ client: unverifiedClient, exchangeId, bundleDigest: digest }), e => e.code === 'exchange_revocation_unverified');
});

test('upload key publication rejects absent workflow identity before writing private material', async () => {
  const client = clientWithRecord();
  await assert.rejects(publishUploadKey({ client, exchangeId, bundleDigest: digest, admission: { commit }, workflowRunId: 'run-1', now }), e => e.code === 'workflow_identity_missing');
  assert.deepEqual(client.state.writes, []);
});
