#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, realpath, lstat, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { sealOperatorPayload } from './lib/ftw-operator-envelope.mjs';
import { verifyUploadKeyReceipt } from './lib/ftw-upload-receipt.mjs';
import { parseOperatorPayload } from './lib/ftw-operator-payload.mjs';
import { OperatorTransportError } from './lib/ftw-operator-cloudflare.mjs';

const repository = 'spenceracaton/this-way';
const repositoryUrl = `https://github.com/${repository}`;
const fail = code => { throw new OperatorTransportError(code); };
const defaultGh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });

export async function sealPayloadFromWorkflow({ input, runId, expectedCommit, output, operation = 'prepare', checkpointId = '', gh = defaultGh,
  getLive = () => JSON.parse(execFileSync('curl', ['-fsS', '--max-time', '30', 'https://this-way.spencercaton.workers.dev/release.json'], { encoding: 'utf8', maxBuffer: 4096 })) }) {
  if (!/^\d+$/.test(String(runId)) || !/^[a-f0-9]{40}$/.test(expectedCommit || '') || !['prepare','apply'].includes(operation)) fail('seal_arguments_invalid');
  if (operation === 'apply' && !/^ftw_[a-f0-9]{32}$/.test(checkpointId)) fail('approved_checkpoint_id_required');
  const raw = await readFile(input, 'utf8');
  if (Buffer.byteLength(raw) > 40 * 1024) fail('pilot_payload_exceeds_encrypted_limit');
  const digest = createHash('sha256').update(raw.trim()).digest('hex');
  parseOperatorPayload(raw, digest);
  const api = path => JSON.parse(gh(['api', '--hostname', 'github.com', `repos/${repository}${path}`]));
  const run = api(`/actions/runs/${runId}`), main = api('/commits/main');
  const checks = api(`/actions/workflows/check.yml/runs?head_sha=${expectedCommit}&event=push&status=success&per_page=10`);
  const list = api(`/actions/runs/${runId}/artifacts`);
  const matches = list.artifacts?.filter(item => item.name === 'ftw-upload-key') || [];
  if (matches.length !== 1 || list.total_count > 100) fail('upload_key_artifact_ambiguous');
  const artifact = matches[0], live = await getLive();
  // Reject untrusted runs before downloading their artifact. The final check
  // below additionally binds its public receipt to this same verified context.
  const preflight = { operation: 'upload-key', repository, workflowRunId: String(runId),
    admission: { commit: expectedCommit, releaseId: live.release_id },
    receipt: { repository, commit: expectedCommit, bundleDigest: digest } };
  verifyUploadKeyReceipt({ runId, expectedCommit, bundleDigest: digest, run, main, checks, live, artifact, wrapper: preflight });
  const temporary = await mkdtemp(resolve(tmpdir(), 'ftw-public-key-'));
  try {
    await gh(['run', 'download', String(runId), '--repo', repositoryUrl, '--name', 'ftw-upload-key', '--dir', temporary]);
    const names = await readdir(temporary);
    if (names.length !== 1 || names[0] !== 'ftw-upload-key.json') fail('upload_key_artifact_contents_invalid');
    const keyPath = resolve(temporary, names[0]), stat = await lstat(keyPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 || await realpath(keyPath) !== keyPath) fail('upload_key_artifact_contents_invalid');
    const wrapper = JSON.parse(await readFile(keyPath, 'utf8'));
    const receipt = verifyUploadKeyReceipt({ runId, expectedCommit, bundleDigest: digest, run, main, checks, live, artifact, wrapper });
    const encoded = sealOperatorPayload(raw, receipt, { expectedCommit });
    const inputs = { operation, bundle_sha256: digest, exchange_id: receipt.exchangeId, encrypted_payload: encoded,
      ...(checkpointId ? { checkpoint_id: checkpointId } : {}) };
    const serialized = JSON.stringify(inputs);
    if (Buffer.byteLength(serialized) > 65535) fail('workflow_inputs_exceed_limit');
    await writeFile(output, serialized, { mode: 0o600, flag: 'wx' });
    return { operation, bundleDigest: digest, exchangeId: receipt.exchangeId, expiresAt: receipt.expiresAt,
      uploadKeyRunId: String(runId), checkedCommit: expectedCommit, encryptedBytes: Buffer.byteLength(encoded) };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function parse(args) {
  const options = {}, names = { '--input': 'input', '--run-id': 'runId', '--expected-commit': 'expectedCommit', '--output': 'output', '--operation': 'operation', '--checkpoint-id': 'checkpointId' };
  for (let i = 0; i < args.length; i++) {
    const key = names[args[i]];
    if (!key || options[key] || !args[i+1] || args[i+1].startsWith('--')) fail('seal_arguments_invalid');
    options[key] = args[++i];
  }
  if (!options.input || !options.output || !options.runId || !options.expectedCommit) fail('seal_arguments_invalid');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await sealPayloadFromWorkflow(parse(process.argv.slice(2))))); }
  catch (error) { console.error(error instanceof OperatorTransportError ? error.code : 'payload_seal_failed'); process.exitCode = 1; }
}
