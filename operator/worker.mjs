import { createHash, timingSafeEqual } from 'node:crypto';
import { applyFtwCheckpoint, prepareFtwCheckpoint, readFtwCheckpoint, restoreFtwCheckpoint } from '../scripts/lib/ftw-checkpoint-store.mjs';
import { assertCheckpointScope, assertPilotScope, OPERATOR_POLICY } from './policy.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const hidden = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};
const count = value => Array.isArray(value) ? value.length : 0;
const assertLive = command => {
  if (Date.now() >= command.expiresAt) throw new TypeError('operator command expired before the operation began');
};

function config(env) {
  const required = ['DB', 'PHOTOS', 'CONTROL', 'COMMAND_KEY', 'COMMAND_SHA256', 'RUN_ID', 'EXPIRES_AT', 'OPERATOR_TOKEN'];
  if (required.some(key => !env?.[key])) return false;
  if (!/^[a-f0-9]{64}$/.test(env.COMMAND_SHA256) || !/^ftw-operator\/[A-Za-z0-9._-]+\/command\.json$/.test(env.COMMAND_KEY)) return false;
  if (!/^[-A-Za-z0-9_]{8,128}$/.test(env.RUN_ID) || !/^\d{13}$/.test(String(env.EXPIRES_AT))) return false;
  if (!/^[A-Za-z0-9_-]{43,}$/.test(env.OPERATOR_TOKEN)) return false;
  if (env.EXPECTED_ACCOUNT_ID && env.ACCOUNT_ID !== env.EXPECTED_ACCOUNT_ID) return false;
  return true;
}

async function readCommand(env) {
  const object = await env.CONTROL.get(env.COMMAND_KEY);
  if (!object) throw new TypeError('private command object is missing');
  if (Number.isFinite(object.size) && object.size > OPERATOR_POLICY.maxCommandBytes) throw new TypeError('private command exceeds size limit');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength > OPERATOR_POLICY.maxCommandBytes || digest(bytes) !== env.COMMAND_SHA256) throw new TypeError('private command digest or size is invalid');
  let command;
  try { command = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new TypeError('private command is invalid JSON'); }
  const now = Date.now(), issuedAt = command?.issuedAt, expiresAt = command?.expiresAt;
  if (command?.version !== 1 || command.runId !== env.RUN_ID || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || String(expiresAt) !== String(env.EXPIRES_AT) || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > OPERATOR_POLICY.maxTtlMs || issuedAt > now + 30_000) throw new TypeError('private command identity or expiry is invalid');
  if (!['prepare', 'apply', 'status', 'restore'].includes(command.operation) || !/^[a-f0-9]{64}$/.test(command.bundleDigest || '')) throw new TypeError('private command operation or bundle digest is invalid');
  if (command.operation === 'prepare') {
    if (!command.input || !command.sourceEvidence || command.sourceEvidence.bundleDigest !== command.bundleDigest) throw new TypeError('private command is missing bound source evidence');
    assertPilotScope(command.input, command.sourceEvidence);
  }
  if ((command.operation === 'apply' || command.operation === 'status' || command.operation === 'restore') && !/^ftw_[a-f0-9]{32}$/.test(command.checkpointId || '')) throw new TypeError('private command checkpoint id is invalid');
  if (command.operation === 'restore' && (typeof command.reason !== 'string' || !command.reason.trim() || command.reason.trim().length > 1000)) throw new TypeError('private command restore reason is invalid');
  return command;
}

async function readAssets(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > OPERATOR_POLICY.maxRequestBytes) throw new TypeError('request body exceeds size limit');
  const bytes = await readStream(request.body, OPERATOR_POLICY.maxRequestBytes, 'request body');
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new TypeError('apply body is invalid JSON'); }
  if (!body || !Array.isArray(body.assets) || body.assets.length > OPERATOR_POLICY.maxPhotos) throw new TypeError('apply body must contain a bounded asset array');
  let total = 0;
  const assets = body.assets.map(asset => {
    if (!asset || typeof asset.objectKey !== 'string' || typeof asset.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.base64)) throw new TypeError('asset encoding is invalid');
    const data = Buffer.from(asset.base64, 'base64');
    if (data.toString('base64') !== asset.base64) throw new TypeError('asset encoding is not canonical');
    total += data.byteLength;
    if (total > OPERATOR_POLICY.maxAssetBytes) throw new TypeError('decoded assets exceed size limit');
    return { objectKey: asset.objectKey, bytes: new Uint8Array(data) };
  });
  return assets;
}

async function readStream(stream, maxBytes, label) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(), chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new TypeError(`${label} exceeds size limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function summary(checkpoint) {
  const artifact = checkpoint?.artifact;
  return {
    checkpointId: checkpoint?.id ?? null,
    state: checkpoint?.state ?? null,
    records: count(artifact?.input?.records),
    plannedListings: count(artifact?.plan?.listings),
    plannedPhotos: count(artifact?.plan?.photos),
    operations: count(artifact?.ops),
    inserted: count(artifact?.ops?.filter(op => op.kind === 'insert')),
    updated: count(artifact?.ops?.filter(op => op.kind === 'update')),
    atomicBatchRollbackVerified: artifact?.sourceEvidence?.atomicBatchRollbackVerified === true
  };
}

async function verifyAtomicBatchRollback(db, runId) {
  const ids = [`operator_probe:${runId}:good`, `operator_probe:${runId}:bad`];
  const countOwned = async () => {
    const rows = await db.prepare('SELECT assertion_id FROM ftw_import_guard_assertions WHERE assertion_id IN (?,?)').bind(...ids).all();
    return rows.results || [];
  };
  if ((await countOwned()).length) throw new TypeError('atomic batch probe identity is already in use');
  let failedAsExpected = false;
  try {
    await db.batch([
      db.prepare('INSERT INTO ftw_import_guard_assertions(assertion_id,ok) VALUES(?,1)').bind(ids[0]),
      db.prepare('INSERT INTO ftw_import_guard_assertions(assertion_id,ok) VALUES(?,0)').bind(ids[1])
    ]);
  } catch (error) {
    const detail = `${error?.message || ''} ${error?.cause?.message || ''}`;
    failedAsExpected = /CHECK constraint failed:\s*ok\s*=\s*1/i.test(detail);
  }
  const leftovers = await countOwned();
  if (leftovers.length) {
    await db.prepare('DELETE FROM ftw_import_guard_assertions WHERE assertion_id IN (?,?)').bind(...ids).run();
    if ((await countOwned()).length) throw new TypeError('atomic batch rollback probe cleanup failed');
  }
  if (!failedAsExpected || leftovers.length) throw new TypeError('D1 batch atomic rollback verification failed');
  return true;
}

async function execute(request, env) {
  const command = await readCommand(env);
  let result, checkpoint;
  if (command.operation !== 'apply' && Number(request.headers.get('content-length') || 0) !== 0) throw new TypeError('this operation does not accept a request body');
  if (command.operation !== 'apply' && request.body) {
    const reader = request.body.getReader(), { value } = await reader.read();
    if (value?.byteLength) { await reader.cancel(); throw new TypeError('this operation does not accept a request body'); }
  }
  if (command.operation === 'prepare') {
    assertLive(command);
    const atomicBatchRollbackVerified = await verifyAtomicBatchRollback(env.DB, command.runId);
    assertLive(command);
    const sourceEvidence = { ...command.sourceEvidence, bundleDigest: command.bundleDigest, operatorContract: OPERATOR_POLICY.contract, runId: command.runId, immutableIntent: true, atomicBatchRollbackVerified };
    checkpoint = await prepareFtwCheckpoint({ db: env.DB, input: command.input, sourceEvidence, now: command.issuedAt });
    assertCheckpointScope(checkpoint);
    result = checkpoint;
  } else {
    checkpoint = await readFtwCheckpoint(env.DB, command.checkpointId);
    if (!checkpoint || checkpoint.artifact?.sourceEvidence?.bundleDigest !== command.bundleDigest) throw new TypeError('checkpoint does not belong to this source bundle');
    assertCheckpointScope(checkpoint);
    if (command.operation === 'status') result = checkpoint;
    else if (command.operation === 'apply') {
      const assets = await readAssets(request);
      assertLive(command);
      const action = await applyFtwCheckpoint({ db: env.DB, bucket: env.PHOTOS, checkpoint, assets, expectedId: command.checkpointId });
      checkpoint = await readFtwCheckpoint(env.DB, command.checkpointId);
      assertCheckpointScope(checkpoint);
      result = { action: action.action, checkpoint };
    } else {
      assertLive(command);
      const action = await restoreFtwCheckpoint({ db: env.DB, bucket: env.PHOTOS, checkpointId: command.checkpointId, expectedId: command.checkpointId, reason: command.reason, now: command.issuedAt });
      checkpoint = await readFtwCheckpoint(env.DB, command.checkpointId);
      assertCheckpointScope(checkpoint);
      result = { action: action.action, checkpoint };
    }
  }
  return json({ ok: true, result, summary: summary(checkpoint) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/execute' || url.search) return hidden();
    if (!config(env)) return hidden();
    if (Number(env.EXPIRES_AT) <= Date.now()) return hidden();
    const authorization = request.headers.get('authorization') || '';
    if (!authorization.startsWith('Bearer ') || !safeEqual(authorization.slice(7), env.OPERATOR_TOKEN)) return hidden();
    try {
      return await execute(request, env);
    } catch (error) {
      return json({ ok: false, code: 'operator_failed', message: error instanceof Error ? error.message : 'operator request failed' }, 400);
    }
  }
};
