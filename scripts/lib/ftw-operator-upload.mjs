import { createUploadKey, publicUploadKey, openOperatorPayload } from './ftw-operator-envelope.mjs';
import { OperatorTransportError } from './ftw-operator-cloudflare.mjs';

const repository = 'spenceracaton/this-way';
const fail = code => { throw new OperatorTransportError(code); };

export async function publishUploadKey({ client, exchangeId, bundleDigest, admission, workflowRunId, now = Date.now() }) {
  if (!/^\d+$/.test(String(workflowRunId || ''))) fail('workflow_identity_missing');
  const { privateRecord, publicReceipt } = createUploadKey({ exchangeId, bundleDigest,
    commit: admission.commit, repository, now });
  await client.privateObject(`ftw-operator/${exchangeId}/exchange.json`, Buffer.from(JSON.stringify(privateRecord)));
  // Only this explicitly selected public object may leave the protected job.
  return { operation: 'upload-key', repository, workflowRunId: String(workflowRunId), admission, receipt: publicReceipt };
}

export async function decryptUploadedPayload({ client, exchangeId, encoded, bundleDigest, commit, now = Date.now() }) {
  if (!/^[a-f0-9]{32}$/.test(exchangeId || '') || typeof encoded !== 'string' || Buffer.byteLength(encoded) > 60 * 1024) fail('encrypted_payload_invalid');
  const record = await client.readPrivateExchange(exchangeId);
  if (!record || record.exchangeId !== exchangeId) fail('upload_key_missing');
  try { return openOperatorPayload(encoded, record, { expectedCommit: commit, expectedBundleDigest: bundleDigest, now }); }
  catch { fail('encrypted_payload_invalid_or_expired'); }
}

export async function revokeUploadKey({ client, exchangeId, bundleDigest }) {
  if (!/^[a-f0-9]{32}$/.test(exchangeId || '')) fail('invalid_exchange_id');
  const record = await client.readPrivateExchange(exchangeId);
  if (!record) fail('upload_key_missing_revocation_unverified');
  // Expired keys must remain revocable. Validate their original lifetime and
  // purpose at creation time; decrypt never uses this historical clock.
  let receipt;
  try { receipt = publicUploadKey(record, { now: Date.parse(record.createdAt) }); }
  catch { fail('upload_key_identity_mismatch'); }
  if (receipt.exchangeId !== exchangeId || receipt.bundleDigest !== bundleDigest || receipt.repository !== repository) fail('upload_key_identity_mismatch');
  const outcome = await client.deletePrivateExchange(exchangeId);
  if (outcome.verified !== true) fail('exchange_revocation_unverified');
  return { operation: 'revoke-key', exchangeId, bundleDigest, revocationVerified: true, alreadyAbsent: false };
}
