import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createUploadKey, openOperatorPayload, publicUploadKey, sealOperatorPayload } from '../scripts/lib/ftw-operator-envelope.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const payload = JSON.stringify({ synthetic: true, records: [{ id: 'test-1' }] });
const base = Date.parse('2026-01-01T00:00:00.000Z');
const identifiers = { exchangeId: 'a'.repeat(32), bundleDigest: hash(payload.trim()), commit: 'b'.repeat(40), repository: 'spenceracaton/this-way' };
const issue = (overrides = {}) => createUploadKey({ ...identifiers, now: base, ...overrides });
const seal = pair => sealOperatorPayload(payload, pair.publicReceipt, { expectedCommit: identifiers.commit, now: base + 1_000 });
const open = (pair, envelope, options = {}) => openOperatorPayload(envelope, pair.privateRecord, { expectedCommit: identifiers.commit, expectedBundleDigest: identifiers.bundleDigest, now: base + 1_000, ...options });
const mutate = (envelope, field, value) => {
  const parsed = JSON.parse(envelope);
  parsed[field] = value;
  return JSON.stringify(parsed);
};

test('hybrid envelope round trips and public receipt never contains the private key', () => {
  const pair = issue();
  assert.equal(pair.publicReceipt.privateKey, undefined);
  assert.equal(pair.publicReceipt.publicKey.includes('PUBLIC KEY'), true);
  assert.deepEqual(publicUploadKey(pair.privateRecord, { now: base + 1_000 }), pair.publicReceipt);
  assert.equal(open(pair, seal(pair)), payload);
});

test('each seal uses fresh AES material and produces different ciphertext', () => {
  const pair = issue();
  const one = JSON.parse(seal(pair)), two = JSON.parse(seal(pair));
  assert.notEqual(one.ivBase64, two.ivBase64);
  assert.notEqual(one.wrappedKeyBase64, two.wrappedKeyBase64);
  assert.notEqual(one.ciphertextBase64, two.ciphertextBase64);
});

test('tampering with encrypted bytes, tag, wrapped key, or authenticated metadata fails closed', () => {
  const pair = issue();
  const original = seal(pair), parsed = JSON.parse(original);
  for (const [field, value] of [
    ['ciphertextBase64', Buffer.from(parsed.ciphertextBase64, 'base64').map(byte => byte ^ 1).toString('base64')],
    ['tagBase64', Buffer.from(parsed.tagBase64, 'base64').map(byte => byte ^ 1).toString('base64')],
    ['wrappedKeyBase64', Buffer.from(parsed.wrappedKeyBase64, 'base64').map(byte => byte ^ 1).toString('base64')],
    ['exchangeId', 'c'.repeat(32)], ['commit', 'd'.repeat(40)], ['bundleDigest', 'e'.repeat(64)],
    ['fingerprint', 'f'.repeat(64)], ['repository', 'attacker/other'], ['expiresAt', '2026-01-01T01:00:01.000Z']
  ]) assert.throws(() => open(pair, mutate(original, field, value)), { message: 'operator_envelope_invalid' });
});

test('wrong private key, expired key, wrong expected metadata, and mismatched plaintext digest fail', () => {
  const pair = issue(), other = issue({ exchangeId: 'c'.repeat(32) }), envelope = seal(pair);
  assert.throws(() => open(other, envelope), { message: 'operator_envelope_invalid' });
  assert.throws(() => open(pair, envelope, { expectedCommit: '0'.repeat(40) }), { message: 'operator_envelope_invalid' });
  assert.throws(() => openOperatorPayload(envelope, pair.privateRecord, { expectedCommit: identifiers.commit, expectedBundleDigest: '0'.repeat(64), now: base + 1_000 }), { message: 'operator_envelope_invalid' });
  assert.throws(() => open(pair, envelope, { now: base + 60 * 60 * 1000 }), { message: 'operator_envelope_invalid' });
  assert.throws(() => sealOperatorPayload('different payload', pair.publicReceipt, { expectedCommit: identifiers.commit, now: base + 1_000 }), { message: 'operator_envelope_invalid' });
});

test('invalid base64, extra fields, and oversized payloads are rejected', () => {
  const pair = issue(), envelope = seal(pair);
  assert.throws(() => open(pair, mutate(envelope, 'tagBase64', '!!!!')), { message: 'operator_envelope_invalid' });
  assert.throws(() => open(pair, JSON.stringify({ ...JSON.parse(envelope), extra: true })), { message: 'operator_envelope_invalid' });
  assert.throws(() => sealOperatorPayload('x'.repeat(40 * 1024 + 1), pair.publicReceipt, { now: base + 1_000 }), { message: 'operator_envelope_invalid' });
  assert.throws(() => open(pair, ' '.repeat(60 * 1024 + 1)), { message: 'operator_envelope_invalid' });
});
