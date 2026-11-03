#!/usr/bin/env node
// Exercise the guarded binding-based executor in private local D1/R2 only.
// This command intentionally has no remote adapter or credential path.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTestService } from '../tests/helpers/service-runtime.mjs';
import { loadFtwSourceBundle } from './lib/ftw-source-bundle.mjs';
import { containedFile } from './lib/ftw-public-pilot.mjs';
import {
  prepareFtwCheckpoint, applyFtwCheckpoint, restoreFtwCheckpoint, readFtwCheckpoint
} from './lib/ftw-checkpoint-store.mjs';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const under = (base, path) => {
  const rel = relative(base, path);
  return rel === '' || rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
};
async function privateJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function privateOutput(path) {
  if (!path) throw new TypeError('A new --output directory is required');
  const parent = await realpath(dirname(resolve(path)));
  const output = resolve(parent, resolve(path).split('/').at(-1));
  if (under(checkout, output) || under(output, checkout)) throw new TypeError('Output must be outside the checkout');
  await mkdir(output, { mode: 0o700 }); // Refuse existing directories, including symlinks.
  return output;
}

async function openWorkspace(path) {
  if (!path) throw new TypeError('--workspace is required');
  const directory = await realpath(path);
  if (under(checkout, directory) || under(directory, checkout)) throw new TypeError('Workspace must be outside the checkout');
  const manifest = JSON.parse(await readFile(await containedFile(directory, 'workspace.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.mode !== 'isolated-local' || !/^ftw_[a-f0-9]{32}$/.test(manifest.checkpointId)) {
    throw new TypeError('Not an isolated checkpoint workspace');
  }
  const persistPath = await realpath(resolve(directory, 'local-state'));
  if (!under(directory, persistPath) || persistPath === directory) throw new TypeError('Persistence path escapes workspace');
  return { directory, manifest, persistPath };
}

async function report(service, id, action) {
  const checkpoint = await readFtwCheckpoint(service.db, id);
  const counts = {};
  for (const table of ['seasons', 'locations', 'listings', 'photos', 'source_mappings', 'review_events']) {
    counts[table] = (await service.db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n;
  }
  return { mode: 'isolated-local', productionWrites: 0, checkpointId: id,
    action, state: checkpoint?.state ?? null, counts };
}

export async function rehearseFtwCheckpoint(options) {
  if (options.local !== true) throw new TypeError('Explicit --local is required; no remote mode is available');
  const { command } = options;
  if (!['prepare', 'apply', 'status', 'restore'].includes(command)) throw new TypeError('Expected prepare, apply, status or restore');
  if (command === 'prepare') {
    if (!options.bundle) throw new TypeError('--bundle is required');
    const bundle = await loadFtwSourceBundle(options.bundle);
    const directory = await privateOutput(options.output);
    await mkdir(resolve(directory, 'assets'), { mode: 0o700 });
    await mkdir(resolve(directory, 'local-state'), { mode: 0o700 });
    const storedAssets = [];
    for (const asset of bundle.assets) {
      const path = `assets/${sha(asset.bytes)}.bin`;
      await writeFile(resolve(directory, path), asset.bytes, { mode: 0o600 });
      storedAssets.push({ objectKey: asset.objectKey, contentHash: asset.contentHash, path });
    }
    const service = await createTestService({ persistPath: resolve(directory, 'local-state') });
    try {
      const checkpoint = await prepareFtwCheckpoint({ db: service.db, input: bundle.input,
        sourceEvidence: { provenance: bundle.provenance, sourceDigest: bundle.sourceDigest, reconciliation: bundle.reconciliation } });
      await privateJson(resolve(directory, 'checkpoint.json'), checkpoint);
      await privateJson(resolve(directory, 'workspace.json'), { schemaVersion: 1, mode: 'isolated-local',
        checkpointId: checkpoint.id, assets: storedAssets });
      const result = await report(service, checkpoint.id, 'prepared');
      await privateJson(resolve(directory, 'last-result.json'), result);
      return result;
    } finally { await service.dispose(); }
  }
  const { directory, manifest, persistPath } = await openWorkspace(options.workspace);
  if (command !== 'status' && options.expectedId !== manifest.checkpointId) throw new TypeError('Supply the exact reviewed --expected-id from prepare');
  const service = await createTestService({ persistPath });
  try {
    const checkpoint = await readFtwCheckpoint(service.db, manifest.checkpointId);
    if (!checkpoint) throw new TypeError('Durable checkpoint is missing');
    let action = 'status';
    if (command === 'apply') {
      const assets = [];
      const needed = new Set(checkpoint.artifact.plan.photos.map(photo => photo.object_key));
      for (const asset of manifest.assets) {
        if (!needed.has(asset.objectKey)) continue;
        const bytes = new Uint8Array(await readFile(await containedFile(directory, asset.path)));
        if (`sha256:${sha(bytes)}` !== asset.contentHash) throw new TypeError('Private asset cache changed since preparation');
        assets.push({ objectKey: asset.objectKey, bytes });
      }
      ({ action } = await applyFtwCheckpoint({ db: service.db, bucket: service.bucket,
        checkpoint, expectedId: options.expectedId, assets }));
    } else if (command === 'restore') {
      ({ action } = await restoreFtwCheckpoint({ db: service.db, bucket: service.bucket,
        checkpointId: checkpoint.id, expectedId: options.expectedId, reason: options.reason }));
    }
    const result = await report(service, checkpoint.id, action);
    await privateJson(resolve(directory, 'last-result.json'), result);
    return result;
  } finally { await service.dispose(); }
}

function parse(args) {
  const options = { command: args[0] };
  const names = { '--bundle': 'bundle', '--output': 'output', '--workspace': 'workspace', '--expected-id': 'expectedId', '--reason': 'reason' };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--local') { options.local = true; continue; }
    const name = names[args[i]];
    if (!name || !args[i + 1] || args[i + 1].startsWith('--') || options[name] !== undefined) throw new TypeError(`Unknown, repeated or incomplete option ${args[i]}`);
    options[name] = args[++i];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await rehearseFtwCheckpoint(parse(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
