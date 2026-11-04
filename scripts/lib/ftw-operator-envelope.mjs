import {
  constants, createCipheriv, createDecipheriv, createHash, generateKeyPairSync,
  privateDecrypt, publicEncrypt, randomBytes, createPrivateKey, createPublicKey
} from 'node:crypto';

const DOMAIN = 'ftw-operator-upload-v1';
const PURPOSE = 'ftw-operator-upload-key';
const VERSION = 1;
const REPOSITORY = 'spenceracaton/this-way';
const KEY_TTL_MS = 60 * 60 * 1000;
const MAX_FUTURE_MS = 30 * 1000;
const MAX_PLAINTEXT = 40 * 1024;
const MAX_ENVELOPE = 60 * 1024;
const HEX32 = /^[a-f0-9]{32}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const fail = () => { throw new TypeError('operator_envelope_invalid'); };
const keys = (obj, expected) => obj && typeof obj === 'object' && !Array.isArray(obj)
  && Object.keys(obj).sort().join(',') === [...expected].sort().join(',');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const time = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) fail();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail();
  return parsed;
};
const nowMs = value => {
  const result = value === undefined ? Date.now() : value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(result)) fail();
  return result;
};
function metadataValid(record, now) {
  if (record.purpose !== PURPOSE || record.version !== VERSION || record.repository !== REPOSITORY
    || !HEX32.test(record.exchangeId || '') || !HEX64.test(record.bundleDigest || '') || !HEX40.test(record.commit || '')
    || !HEX64.test(record.fingerprint || '')) fail();
  const created = time(record.createdAt), expires = time(record.expiresAt), current = nowMs(now);
  if (expires - created !== KEY_TTL_MS || created > current + MAX_FUTURE_MS || expires <= current) fail();
  return { created, expires };
}
function publicFields(record) {
  return {
    purpose: record.purpose, version: record.version, repository: record.repository,
    exchangeId: record.exchangeId, bundleDigest: record.bundleDigest, commit: record.commit,
    createdAt: record.createdAt, expiresAt: record.expiresAt, fingerprint: record.fingerprint
  };
}
function parsePublicKey(pem) {
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 3072) fail();
    return key;
  } catch { fail(); }
}
function parsePrivateRecord(record, now) {
  if (!keys(record, [...Object.keys(publicFields(record)), 'publicKey', 'privateKey'])) fail();
  metadataValid(record, now);
  const publicKey = parsePublicKey(record.publicKey);
  let privateKey;
  try { privateKey = createPrivateKey(record.privateKey); } catch { fail(); }
  if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails?.modulusLength !== 3072) fail();
  const der = publicKey.export({ type: 'spki', format: 'der' });
  if (sha256(der) !== record.fingerprint) fail();
  let derived;
  try { derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }); } catch { fail(); }
  if (!der.equals(derived)) fail();
  return publicKey;
}
function aad(meta) {
  return Buffer.from(JSON.stringify([DOMAIN, meta.repository, meta.commit, meta.exchangeId, meta.bundleDigest, meta.fingerprint, meta.expiresAt]), 'utf8');
}
function strictBase64(value, length) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) fail();
  return bytes;
}

export function publicUploadKey(privateRecord, { now } = {}) {
  try {
    parsePrivateRecord(privateRecord, now);
    return { ...publicFields(privateRecord), publicKey: privateRecord.publicKey };
  } catch { fail(); }
}

export function createUploadKey({ exchangeId, bundleDigest, commit, repository, now } = {}) {
  try {
    const createdAt = new Date(nowMs(now)).toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + KEY_TTL_MS).toISOString();
    // Reject malformed or wrongly scoped requests before generating key material.
    metadataValid({ purpose: PURPOSE, version: VERSION, repository, exchangeId, bundleDigest, commit, createdAt, expiresAt, fingerprint: '0'.repeat(64) }, now);
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const der = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
    const record = {
      purpose: PURPOSE, version: VERSION, repository, exchangeId, bundleDigest, commit,
      createdAt, expiresAt, publicKey, privateKey, fingerprint: sha256(der)
    };
    metadataValid(record, now);
    return { privateRecord: record, publicReceipt: { ...publicFields(record), publicKey } };
  } catch { fail(); }
}

export function sealOperatorPayload(rawPayload, publicReceipt, { expectedCommit, now } = {}) {
  try {
    if (!keys(publicReceipt, [...Object.keys(publicFields(publicReceipt)), 'publicKey'])) fail();
    metadataValid(publicReceipt, now);
    if (expectedCommit !== undefined && publicReceipt.commit !== expectedCommit) fail();
    const publicKey = parsePublicKey(publicReceipt.publicKey);
    if (sha256(publicKey.export({ type: 'spki', format: 'der' })) !== publicReceipt.fingerprint) fail();
    if (typeof rawPayload !== 'string' || Buffer.byteLength(rawPayload, 'utf8') > MAX_PLAINTEXT
      || sha256(Buffer.from(rawPayload.trim(), 'utf8')) !== publicReceipt.bundleDigest) fail();
    const key = randomBytes(32), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(publicReceipt));
    const ciphertext = Buffer.concat([cipher.update(rawPayload, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const wrappedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: aad(publicReceipt) }, key);
    const envelope = {
      purpose: DOMAIN, version: VERSION, repository: publicReceipt.repository, commit: publicReceipt.commit,
      exchangeId: publicReceipt.exchangeId, bundleDigest: publicReceipt.bundleDigest,
      fingerprint: publicReceipt.fingerprint, expiresAt: publicReceipt.expiresAt,
      wrappedKeyBase64: wrappedKey.toString('base64'), ivBase64: iv.toString('base64'),
      ciphertextBase64: ciphertext.toString('base64'), tagBase64: tag.toString('base64')
    };
    const encoded = JSON.stringify(envelope);
    if (Buffer.byteLength(encoded) > MAX_ENVELOPE) fail();
    return encoded;
  } catch { fail(); }
}

export function openOperatorPayload(encodedEnvelope, privateRecord, { expectedCommit, expectedBundleDigest, now } = {}) {
  try {
    if (typeof encodedEnvelope !== 'string' || Buffer.byteLength(encodedEnvelope, 'utf8') > MAX_ENVELOPE) fail();
    const envelope = JSON.parse(encodedEnvelope);
    const expected = ['purpose','version','repository','commit','exchangeId','bundleDigest','fingerprint','expiresAt','wrappedKeyBase64','ivBase64','ciphertextBase64','tagBase64'];
    if (!keys(envelope, expected) || envelope.purpose !== DOMAIN || envelope.version !== VERSION) fail();
    const pub = publicFields(privateRecord);
    if (!keys(privateRecord, [...Object.keys(pub), 'publicKey', 'privateKey'])) fail();
    metadataValid(privateRecord, now);
    if (expectedCommit !== undefined && privateRecord.commit !== expectedCommit) fail();
    if (expectedBundleDigest !== undefined && privateRecord.bundleDigest !== expectedBundleDigest) fail();
    parsePrivateRecord(privateRecord, now);
    for (const name of ['repository','commit','exchangeId','bundleDigest','fingerprint','expiresAt']) {
      if (envelope[name] !== privateRecord[name]) fail();
    }
    const wrapped = strictBase64(envelope.wrappedKeyBase64, 384);
    const iv = strictBase64(envelope.ivBase64, 12);
    const ciphertext = strictBase64(envelope.ciphertextBase64);
    const tag = strictBase64(envelope.tagBase64, 16);
    if (ciphertext.length > MAX_PLAINTEXT) fail();
    const key = privateDecrypt({ key: createPrivateKey(privateRecord.privateKey), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: aad(privateRecord) }, wrapped);
    if (key.length !== 32) fail();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad(privateRecord));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT || sha256(Buffer.from(plaintext.trim(), 'utf8')) !== privateRecord.bundleDigest) fail();
    return plaintext;
  } catch { fail(); }
}
