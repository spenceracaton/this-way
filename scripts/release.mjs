import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/workers/scripts/${config.name}`;
const site = 'https://this-way.spencercaton.workers.dev';

async function files(root, prefix = '') {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) found.push(...await files(root, name + '/'));
    else if (entry.isFile()) found.push(name);
    else throw new Error('Release contains a non-regular file');
  }
  return found.sort();
}

export async function prepareRelease(root = 'release') {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const release_id = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`
    : `local-${Date.now()}`;
  // Fail rather than accidentally mix a new release with a previous artifact.
  await mkdir(root);
  await cp('public', path.join(root, 'public'), { recursive: true });
  await writeFile(path.join(root, 'public/release.json'), JSON.stringify({ commit, release_id }) + '\n');
  const { $schema, ...deploymentConfig } = config;
  await writeFile(path.join(root, 'wrangler.jsonc'), JSON.stringify(deploymentConfig, null, 2) + '\n');
  const hashes = {};
  for (const file of await files(path.join(root, 'public'))) {
    hashes[file] = sha256(await readFile(path.join(root, 'public', file)));
  }
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ commit, release_id,
    config_sha256: sha256(await readFile(path.join(root, 'wrangler.jsonc'))), files: hashes }, null, 2) + '\n');
  console.log(`Prepared ${release_id} from ${commit}`);
}

export async function verifyArtifact(root, expectedCommit) {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.commit !== expectedCommit) throw new Error('Artifact commit does not match this run');
  const actualFiles = await files(path.join(root, 'public'));
  if (JSON.stringify(actualFiles) !== JSON.stringify(Object.keys(manifest.files).sort())) {
    throw new Error('Artifact file inventory changed');
  }
  for (const file of actualFiles) {
    if (sha256(await readFile(path.join(root, 'public', file))) !== manifest.files[file]) {
      throw new Error(`Artifact bytes changed: ${file}`);
    }
  }
  if (sha256(await readFile(path.join(root, 'wrangler.jsonc'))) !== manifest.config_sha256) {
    throw new Error('Artifact configuration changed');
  }
  const artifactConfig = JSON.parse(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
  const { $schema, ...expectedConfig } = config;
  if (JSON.stringify(artifactConfig) !== JSON.stringify(expectedConfig)) throw new Error('Unexpected deployment target/configuration');
  const identity = JSON.parse(await readFile(path.join(root, 'public/release.json'), 'utf8'));
  if (identity.commit !== manifest.commit || identity.release_id !== manifest.release_id) throw new Error('Release identity mismatch');
  return manifest;
}

export function rollbackTarget(history, target, expectedDeployment) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(target || '')) throw new Error('Supply an explicit version UUID');
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(expectedDeployment || '')) throw new Error('Supply the expected active deployment UUID');
  if (history[0]?.id !== expectedDeployment) throw new Error('Active deployment changed after rollback was requested');
  const current = history[0]?.versions;
  if (current?.length !== 1 || current[0].percentage !== 100) throw new Error('Expected one active version at 100%');
  if (current[0].version_id === target) throw new Error('Target is already active');
  if (!history.slice(1).some(d => d.versions?.some(v => v.version_id === target && v.percentage === 100))) {
    throw new Error('Target was not a previous full deployment in the retained history');
  }
  return target;
}

async function api(suffix, body) {
  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('Missing production deployment credential');
  const response = await fetch(endpoint + suffix, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(`Cloudflare API ${response.status}: ${JSON.stringify(data.errors)}`);
  return data.result;
}

async function waitForRelease(identity) {
  // Poll for the observable new release, including deployment propagation.
  let lastError;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const response = await fetch(`${site}/release.json?check=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Release metadata HTTP ${response.status}`);
      const actual = await response.json();
      if (actual.release_id !== identity.release_id || (identity.commit && actual.commit !== identity.commit)) throw new Error('Hosted release does not match target');
      const checks = [['/', 'text/html'], ['/app.mjs', 'javascript'], ['/assets/old-northeast.svg', 'image/svg+xml'], ['/data/neighborhood.json', 'application/json']];
      for (const [file, type] of checks) {
        const asset = await fetch(site + file);
        if (!asset.ok || !asset.headers.get('content-type')?.includes(type)) throw new Error(`Asset failed: ${file}`);
      }
      return actual;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw lastError;
}

export async function finalizeReceipt(root = 'release-results') {
  const receiptPath = path.join(root, 'receipt.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (receipt.verified) throw new Error('Receipt is already finalized');
  receipt.verified = true;
  receipt.outcome = 'verified';
  receipt.verified_at = new Date().toISOString();
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY,
    `Release: ${receipt.url}\n\nCommit: ${receipt.commit}\n\nCloudflare version: ${receipt.version_id}\n\nCloudflare deployment: ${receipt.deployment_id}\n\nPrevious version: ${receipt.previous_version_id || 'none'}\n`, { flag: 'a' });
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}

async function publish(operation) {
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Publishing requires the trusted main branch');
  let identity;
  const before = (await api('/deployments')).deployments;
  if (operation === 'deploy') {
    identity = await verifyArtifact('release', process.env.GITHUB_SHA);
    execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', 'release/wrangler.jsonc',
      '--tag', identity.release_id, '--message', `This Way ${identity.commit}`], { stdio: 'inherit', env: process.env });
  } else if (operation === 'rollback') {
    const target = rollbackTarget(before, process.env.ROLLBACK_VERSION, process.env.EXPECTED_CURRENT_DEPLOYMENT);
    const reason = process.env.ROLLBACK_REASON?.trim();
    if (!reason) throw new Error('Supply a rollback reason');
    const version = await api(`/versions/${target}`);
    const release_id = version.annotations?.['workers/tag'];
    if (!release_id) throw new Error('Target has no map release identity; access-check versions cannot be rollback targets');
    identity = { release_id };
    // Repoint traffic at existing code and assets; no upload, build or forced bypass.
    await api('/deployments', { strategy: 'percentage', versions: [{ version_id: target, percentage: 100 }],
      annotations: { 'workers/message': `Rollback to ${target}: ${reason}`.slice(0, 100) } });
  } else throw new Error('Unknown release operation');
  const after = (await api('/deployments')).deployments;
  const active = after[0];
  if (active?.versions?.length !== 1 || active.versions[0].percentage !== 100) throw new Error('Unexpected active deployment');
  const version_id = active.versions[0].version_id;
  if (operation === 'rollback' && version_id !== process.env.ROLLBACK_VERSION) throw new Error('Rollback version not active');
  const version = await api(`/versions/${version_id}`);
  if (version.annotations?.['workers/tag'] !== identity.release_id) throw new Error('Active version identity mismatch');
  // Persist the mutation receipt before smoke testing, even if the hosted check fails.
  await mkdir('release-results', { recursive: true });
  const receipt = { operation, url: site, release_id: identity.release_id,
    commit: identity.commit || null, version_id, deployment_id: active.id,
    previous_deployment_id: before[0]?.id || null,
    previous_version_id: before[0]?.versions?.[0]?.version_id || null,
    artifact_id: process.env.ARTIFACT_ID || null,
    artifact_digest: process.env.ARTIFACT_DIGEST || null,
    reason: operation === 'rollback' ? process.env.ROLLBACK_REASON.trim() : null,
    published_at: new Date().toISOString(), outcome: 'published_verification_pending', verified: false };
  await writeFile('release-results/receipt.json', JSON.stringify(receipt, null, 2) + '\n');
  receipt.hosted = await waitForRelease(identity);
  receipt.commit = receipt.hosted.commit;
  await writeFile('release-results/receipt.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const operation = process.argv[2];
  if (operation === 'prepare') await prepareRelease();
  else if (operation === 'verify') await verifyArtifact('release', process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  else if (operation === 'finalize') await finalizeReceipt();
  else await publish(operation);
}
