#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, appendFile, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { FtwOperatorCloudflare, executeOperatorRpc, OperatorTransportError } from './lib/ftw-operator-cloudflare.mjs';
import { parseOperatorPayload, materializeOperatorPayload, limitedBytes } from './lib/ftw-operator-payload.mjs';
import { OPERATOR_POLICY } from '../operator/policy.mjs';
import { publishUploadKey, decryptUploadedPayload, revokeUploadKey } from './lib/ftw-operator-upload.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'spenceracaton/this-way';
const accountId = '60b5930216f6049236d2634115cbe0ce';
const site = 'https://this-way.spencercaton.workers.dev';
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new OperatorTransportError(code); };
const privateJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

export async function verifyOperatorAdmission(env, fetcher = fetch) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')
    || env.PUBLISHING_PAUSED !== 'false' || !env.GITHUB_TOKEN) fail('operator_admission_rejected');
  async function github(path) {
    const response = await fetcher(`https://api.github.com/repos/${repository}${path}`, {
      redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
    });
    return JSON.parse((await limitedBytes(response, 1024 * 1024)).toString('utf8'));
  }
  const head = await github('/commits/main');
  if (head.sha !== env.GITHUB_SHA) fail('main_changed_before_operation');
  const runs = await github(`/actions/workflows/check.yml/runs?head_sha=${env.GITHUB_SHA}&event=push&status=success&per_page=10`);
  if (!runs.workflow_runs?.some(run => run.head_sha === env.GITHUB_SHA && run.head_branch === 'main'
    && run.event === 'push' && run.status === 'completed' && run.conclusion === 'success')) fail('checked_main_required');
  const response = await fetcher(`${site}/release.json?operator=${env.GITHUB_SHA}`, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'cache-control': 'no-cache' } });
  const receipt = JSON.parse((await limitedBytes(response, 4096)).toString('utf8'));
  if (receipt.commit !== env.GITHUB_SHA) fail('verified_main_not_live');
  return { commit: env.GITHUB_SHA, releaseId: receipt.release_id };
}

export async function verifyPublicPilot(checkpoint, fetcher = fetch) {
  const artifact = checkpoint.artifact;
  const merged = table => new Map([...artifact.baseline[table], ...artifact.plan[table]].map(row => [row.id, row]));
  const locations = merged('locations'), listings = merged('listings'), photos = merged('photos');
  const selected = artifact.plan.decisions.filter(row => row.entityType === 'listing');
  const expected = selected.map(row => listings.get(row.canonicalId));
  const selectedPhotoIds = new Set(artifact.plan.decisions.filter(row => row.entityType === 'photo').map(row => row.canonicalId));
  if (expected.some(row => !row)) fail('public_pilot_verification_failed');
  const expectedPhotos = [...photos.values()].filter(row => selectedPhotoIds.has(row.id));
  const observed = new Map();
  for (const area of new Set(expected.map(row => locations.get(row.location_id)?.neighborhood_id))) {
    const response = await fetcher(`${site}/api/listings?neighborhood=${area}&season=halloween-2026`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const body = JSON.parse((await limitedBytes(response, 2 * 1024 * 1024)).toString('utf8'));
    if (!Array.isArray(body.listings)) fail('public_pilot_verification_failed');
    for (const row of body.listings) {
      if (observed.has(row.id)) fail('duplicate_public_listing');
      observed.set(row.id, row);
    }
  }
  for (const row of expected) {
    const current = observed.get(row.id), location = locations.get(row.location_id);
    if (!current || current.address !== location.address || current.title !== row.title || current.seasonId !== 'halloween-2026') fail('public_pilot_verification_failed');
    const gallery = expectedPhotos.filter(photo => photo.listing_id === row.id).sort((a,b) => a.position - b.position || a.id.localeCompare(b.id));
    if (!Array.isArray(current.photos) || JSON.stringify(current.photos.filter(photo => selectedPhotoIds.has(photo.id)).map(photo => photo.id)) !== JSON.stringify(gallery.map(photo => photo.id))) fail('public_gallery_verification_failed');
    for (const photo of gallery) {
      const response = await fetcher(`${site}/api/photos/${photo.id}`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (`sha256:${sha(await limitedBytes(response, 2 * 1024 * 1024))}` !== photo.content_hash) fail('public_photo_verification_failed');
    }
  }
  const configResponse = await fetcher(`${site}/api/config`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  const config = JSON.parse((await limitedBytes(configResponse, 16 * 1024)).toString('utf8'));
  if (config.available !== true || config.season?.id !== 'christmas-2026') fail('active_season_changed');
  return { listingsVerified: expected.length, photosVerified: expectedPhotos.length, activeSeason: config.season.id };
}

export async function verifyPublicRestore(checkpoint, fetcher = fetch) {
  const artifact = checkpoint.artifact;
  const insertedListings = artifact.ops.filter(op => op.table === 'listings' && op.kind === 'insert').map(op => op.after);
  const insertedPhotos = artifact.ops.filter(op => op.table === 'photos' && op.kind === 'insert').map(op => op.after);
  const locations = new Map([...artifact.baseline.locations, ...artifact.plan.locations].map(row => [row.id,row]));
  const insertedIds = new Set(insertedListings.map(row => row.id));
  for (const area of new Set(insertedListings.map(row => locations.get(row.location_id)?.neighborhood_id))) {
    const response = await fetcher(`${site}/api/listings?neighborhood=${area}&season=halloween-2026`, {
      redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'cache-control': 'no-cache' }
    });
    const body = JSON.parse((await limitedBytes(response, 2 * 1024 * 1024)).toString('utf8'));
    if (!Array.isArray(body.listings) || body.listings.some(row => insertedIds.has(row.id))) fail('public_restore_verification_failed');
  }
  for (const photo of insertedPhotos) {
    const response = await fetcher(`${site}/api/photos/${photo.id}`, {
      redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'cache-control': 'no-cache' }
    });
    await response.body?.cancel();
    if (response.status !== 404) fail('public_restore_photo_still_available');
  }
  return { insertedListingsAbsent: insertedListings.length, insertedPhotoRoutesPrivate: insertedPhotos.length };
}

function publicSummary(operation, digest, response, receiptKey, cleanup, verification) {
  const source = response?.data?.summary || {};
  const summary = { operation, bundleDigest: digest, receiptKey, cleanupVerified: cleanup.verified };
  if (/^ftw_[a-f0-9]{32}$/.test(source.checkpointId || '')) summary.checkpointId = source.checkpointId;
  if (['prepared','applied','restored'].includes(source.state)) summary.state = source.state;
  for (const key of ['records','plannedListings','plannedPhotos','operations','inserted','updated']) {
    if (Number.isSafeInteger(source[key]) && source[key] >= 0) summary[key] = source[key];
  }
  summary.atomicBatchRollbackVerified = source.atomicBatchRollbackVerified === true;
  if (verification) summary.publicVerification = verification;
  return summary;
}

export async function runFtwOperator(env = process.env, fetcher = fetch) {
  const operation = env.OPERATOR_OPERATION;
  if (!['upload-key','prepare','apply','status','restore','revoke-key'].includes(operation)) fail('operator_operation_invalid');
  if (!/^[a-f0-9]{64}$/.test(env.EXPECTED_BUNDLE_SHA256 || '')) fail('pilot_payload_digest_invalid');
  const approvedId = env.APPROVED_CHECKPOINT_ID || '';
  if (['apply','status','restore'].includes(operation) && !/^ftw_[a-f0-9]{32}$/.test(approvedId)) fail('approved_checkpoint_id_required');
  if (operation === 'restore' && (!env.RESTORE_REASON?.trim() || env.RESTORE_REASON.length > 1000)) fail('restore_reason_required');
  const admission = await verifyOperatorAdmission(env, fetcher);
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== admission.commit
    || execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) fail('checkout_not_checked_main');
  const config = JSON.parse(await readFile(resolve(root, 'wrangler.jsonc'), 'utf8'));
  if (config.name !== 'this-way' || config.account_id !== accountId) fail('destination_config_changed');
  const tempRoot = await realpath(env.RUNNER_TEMP);
  const directory = await mkdtemp(resolve(tempRoot, 'ftw-operator-'));
  const runId = randomUUID().replaceAll('-', '');
  const ownershipPath = resolve(tempRoot, 'this-way-ftw-operator-owned.json');
  const client = new FtwOperatorCloudflare({ accountId, token: env.CLOUDFLARE_API_TOKEN, fetcher,
    onClaimed: (name, ownershipMarker) => privateJson(ownershipPath, { version: 1, scriptName: name, ownershipMarker, accountId, runId, checkedCommit: admission.commit }) });
  const target = await client.target();
  if (operation === 'upload-key' || operation === 'revoke-key') {
    await verifyOperatorAdmission(env, fetcher);
    const result = operation === 'upload-key'
      ? await publishUploadKey({ client, exchangeId: runId, bundleDigest: env.EXPECTED_BUNDLE_SHA256, admission, workflowRunId: env.GITHUB_RUN_ID })
      : await revokeUploadKey({ client, exchangeId: env.UPLOAD_EXCHANGE_ID, bundleDigest: env.EXPECTED_BUNDLE_SHA256 });
    if (operation === 'upload-key') {
      await writeFile(resolve(tempRoot, 'ftw-upload-key.json'), JSON.stringify(result), { mode: 0o600, flag: 'wx' });
    }
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `### FTW encrypted handoff\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
    console.log(`${operation === 'upload-key' ? 'FTW_UPLOAD_KEY=' : 'FTW_KEY_REVOKED='}${JSON.stringify(result)}`);
    return result;
  }
  let materialized;
  if (operation === 'prepare' || operation === 'apply') {
    const raw = await decryptUploadedPayload({ client, exchangeId: env.UPLOAD_EXCHANGE_ID, encoded: env.ENCRYPTED_PAYLOAD,
      bundleDigest: env.EXPECTED_BUNDLE_SHA256, commit: admission.commit });
    const payload = parseOperatorPayload(raw, env.EXPECTED_BUNDLE_SHA256);
    materialized = await materializeOperatorPayload(payload, { directory, fetcher });
  }
  const scriptName = `this-way-ftw-op-${runId}`;
  const commandKey = `ftw-operator/${runId}/command.json`, receiptKey = `ftw-operator/${runId}/receipt.json`;
  const issuedAt = Date.now(), expiresAt = issuedAt + 10 * 60 * 1000;
  const command = { version: 1, runId, operation, issuedAt, expiresAt, bundleDigest: env.EXPECTED_BUNDLE_SHA256,
    ...(approvedId ? { checkpointId: approvedId } : {}), ...(operation === 'restore' ? { reason: env.RESTORE_REASON.trim() } : {}),
    ...(materialized ? { input: materialized.input, sourceEvidence: { operatorContract: OPERATOR_POLICY.contract,
      bundleDigest: env.EXPECTED_BUNDLE_SHA256, provenance: materialized.provenance, sourceDigest: materialized.sourceDigest,
      reconciliation: materialized.reconciliation, sourceRevalidation: materialized.revalidated, checkedCommit: admission.commit } } : {}) };
  const commandBytes = Buffer.from(JSON.stringify(command));
  if (commandBytes.byteLength > OPERATOR_POLICY.maxCommandBytes) fail('private_command_too_large');
  const compiled = await build({ entryPoints: [resolve(root, 'operator/worker.mjs')], bundle: true, write: false,
    platform: 'node', format: 'esm', target: 'es2022', external: ['node:*'], loader: { '.json': 'json' } });
  let response, errorCode, verification, cleanup = { verified: false };
  try {
    const endpoint = await client.deploy({ scriptName, source: compiled.outputFiles[0].text, target,
      command, commandKey, commandBytes });
    await verifyOperatorAdmission(env, fetcher);
    response = await executeOperatorRpc({ endpoint, body: operation === 'apply' ? materialized.body : undefined,
      expiresAt, fetcher });
    await privateJson(resolve(directory, 'rpc-result.json'), response);
    if (response.data?.ok !== true) errorCode = 'private_operator_failure';
    else if (operation === 'prepare' && response.data.summary?.atomicBatchRollbackVerified !== true) errorCode = 'atomic_batch_proof_missing';
    else if (operation === 'apply') verification = await verifyPublicPilot(response.data.result.checkpoint, fetcher);
    else if (operation === 'restore') verification = await verifyPublicRestore(response.data.result.checkpoint, fetcher);
  } catch (error) {
    errorCode = error instanceof OperatorTransportError ? error.code : 'operator_failed_private_details_retained';
    await privateJson(resolve(directory, 'private-error.json'), { message: error instanceof Error ? error.message : 'unknown operator error' });
  } finally {
    if (client.claimedScripts.has(scriptName)) cleanup = await client.cleanup(scriptName);
  }
  const summary = publicSummary(operation, env.EXPECTED_BUNDLE_SHA256, response, receiptKey, cleanup, verification);
  try {
    await client.privateObject(receiptKey, Buffer.from(JSON.stringify({ version: 1, commandKey, checkedCommit: admission.commit,
      operation, bundleDigest: env.EXPECTED_BUNDLE_SHA256, response, errorCode, cleanup, verification, finishedAt: new Date().toISOString() })));
    summary.privateReceiptVerified = true;
  } catch { summary.privateReceiptVerified = false; errorCode ||= 'private_receipt_persistence_unverified'; }
  await privateJson(resolve(directory, 'summary.json'), summary);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `### FTW operator result\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`);
  console.log(JSON.stringify(summary));
  if (!cleanup.verified) fail('temporary_worker_cleanup_unverified');
  if (errorCode) fail(errorCode);
  return summary;
}

async function cleanupOwned(env = process.env) {
  const path = resolve(await realpath(env.RUNNER_TEMP), 'this-way-ftw-operator-owned.json');
  let owned;
  try { owned = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (owned.version !== 1 || owned.accountId !== accountId || owned.checkedCommit !== env.GITHUB_SHA
    || !/^[a-f0-9]{32}$/.test(owned.runId) || !/^[a-f0-9]{64}$/.test(owned.ownershipMarker || '') || owned.scriptName !== `this-way-ftw-op-${owned.runId}`) fail('cleanup_ownership_invalid');
  const client = new FtwOperatorCloudflare({ accountId, token: env.CLOUDFLARE_API_TOKEN });
  client.claimedScripts.add(owned.scriptName);
  client.ownershipMarkers.set(owned.scriptName, owned.ownershipMarker);
  if (!(await client.cleanup(owned.scriptName)).verified) fail('temporary_worker_cleanup_unverified');
  console.log(JSON.stringify({ cleanupVerified: true }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'cleanup') await cleanupOwned();
    else if (process.argv.length === 2) await runFtwOperator();
    else fail('operator_cli_arguments_invalid');
  } catch (error) {
    // Only fixed codes leave this process. Cloudflare/RPC messages and source
    // records remain in private receipts; never print arbitrary error objects.
    console.error(error instanceof OperatorTransportError ? error.code : 'operator_failed');
    process.exitCode = 1;
  }
}
