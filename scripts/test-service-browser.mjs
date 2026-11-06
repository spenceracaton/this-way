import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = path.resolve(root, process.env.SERVICE_TEST_CONFIG || 'wrangler.jsonc');
const wranglerCli = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const playwrightCli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const startupLimitMs = 30_000;
const logLimit = 48_000;
let temporaryRoot;
let worker;
let browserRun;
let workerOutput = '';

function localOnlyEnvironment(additions = {}) {
  const keys = [
    'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'TERM',
    'FORCE_COLOR', 'NO_COLOR', 'LD_LIBRARY_PATH', 'PLAYWRIGHT_BROWSERS_PATH',
    'PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS', 'CHROMIUM_EXECUTABLE_PATH',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR'
  ];
  const environment = Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  return { ...environment, CI: '1', WRANGLER_SEND_METRICS: 'false', ...additions };
}

async function configDetails() {
  const source = await readFile(config, 'utf8');
  const json = source.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1');
  const value = JSON.parse(json);
  const databaseName = value.d1_databases?.[0]?.database_name;
  if (!databaseName) throw new Error(`The service config ${config} has no D1 database_name.`);
  return { databaseName };
}

function recordWorkerOutput(chunk) {
  workerOutput = (workerOutput + chunk.toString()).slice(-logLimit);
}

async function freePorts(count) {
  const servers = [];
  try {
    while (servers.length < count) {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      servers.push(server);
    }
    return servers.map(server => server.address().port);
  } finally {
    await Promise.all(servers.map(server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  }
}

async function makeCredentials(directory) {
  const password = `service-browser-${randomBytes(18).toString('hex')}`;
  const salt = randomBytes(16);
  const passwordHash = `pbkdf2-sha256$100000$${salt.toString('base64')}$${pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('base64')}`;
  const envPasswordHash = passwordHash.replaceAll('$', '\\$');
  const environmentFile = path.join(directory, 'service-test.env');
  await writeFile(environmentFile, [
    `OWNER_PASSWORD_HASH='${envPasswordHash}'`,
    `SERVICE_SECRET=${randomBytes(32).toString('hex')}`,
    'LOCAL_DEVELOPMENT=1',
    'ACTIVE_SEASON=halloween-2026',
    ''
  ].join('\n'), { mode: 0o600 });
  await chmod(environmentFile, 0o600);
  return { environmentFile, password };
}

async function waitForWorker(url, deadline) {
  let lastError = '';
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`Wrangler exited before the service became ready (code ${worker.exitCode}).`);
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const response = await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(Math.min(1000, remaining)) });
      if (response.ok) {
        const config = await response.json();
        if (config.available === true) return config;
        lastError = 'The Worker responded, but the service bindings are unavailable.';
      } else lastError = `The Worker returned HTTP ${response.status} from /api/config.`;
    } catch (error) { lastError = error.message; }
    await delay(200);
  }
  throw new Error(`The local Worker did not become ready within ${startupLimitMs / 1000} seconds. ${lastError}`);
}

function startWorker({ port, inspectorPort, persistence, environmentFile, xdgConfig }) {
  const args = [
    wranglerCli, 'dev', '--config', config,
    '--local', '--ip', '127.0.0.1', '--port', String(port),
    '--inspector-port', String(inspectorPort),
    '--persist-to', persistence, '--env-file', environmentFile,
    '--show-interactive-dev-session=false'
  ];
  worker = spawn(process.execPath, args, {
    cwd: root,
    env: localOnlyEnvironment({
      CI: '1',
      XDG_CONFIG_HOME: xdgConfig,
      WRANGLER_SEND_METRICS: 'false'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  worker.stdout.on('data', recordWorkerOutput);
  worker.stderr.on('data', recordWorkerOutput);
  return worker;
}

async function applyMigrations({ databaseName, persistence, xdgConfig }) {
  const result = spawn(process.execPath, [
    wranglerCli, 'd1', 'migrations', 'apply', databaseName,
    '--local', '--persist-to', persistence, '--config', config
  ], {
    cwd: root,
    env: localOnlyEnvironment({ XDG_CONFIG_HOME: xdgConfig }),
    stdio: 'inherit'
  });
  const [code] = await once(result, 'close');
  if (code !== 0) throw new Error(`Wrangler D1 migrations failed with exit code ${code}.`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, 'close').catch(() => {});
  child.kill('SIGTERM');
  await Promise.race([closed, delay(4000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([closed, delay(1000)]);
  }
}

function forwardSignal(signal) {
  if (browserRun && browserRun.exitCode === null) browserRun.kill(signal);
  else if (worker && worker.exitCode === null) worker.kill(signal);
}

process.once('SIGINT', forwardSignal);
process.once('SIGTERM', forwardSignal);
try {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'this-way-service-browser-'));
  const persistence = path.join(temporaryRoot, 'wrangler-state');
  const xdgConfig = path.join(temporaryRoot, 'xdg-config');
  const results = path.join(root, 'test-results', 'service-browser');
  await Promise.all([mkdir(persistence, { recursive: true }), mkdir(xdgConfig, { recursive: true }), mkdir(results, { recursive: true })]);
  const { databaseName } = await configDetails();
  await applyMigrations({ databaseName, persistence, xdgConfig });
  const { environmentFile, password } = await makeCredentials(temporaryRoot);
  const [port, inspectorPort] = await freePorts(2);
  const url = `http://127.0.0.1:${port}`;
  startWorker({ port, inspectorPort, persistence, environmentFile, xdgConfig });
  await waitForWorker(url, Date.now() + startupLimitMs);

  const cliArgs = process.argv.slice(2);
  browserRun = spawn(process.execPath, [playwrightCli, 'test', '--config', path.join(root, 'playwright.service.config.mjs'), ...cliArgs], {
    cwd: root,
    env: localOnlyEnvironment({
      SERVICE_BROWSER_BASE_URL: url,
      SERVICE_BROWSER_OWNER_PASSWORD: password
    }),
    stdio: 'inherit'
  });
  const [code] = await once(browserRun, 'close');
  process.exitCode = typeof code === 'number' ? code : 1;
  if (process.exitCode !== 0 && workerOutput) process.stderr.write(`\nWrangler output:\n${workerOutput}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  if (workerOutput) process.stderr.write(`\nWrangler output:\n${workerOutput}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', forwardSignal);
  process.removeListener('SIGTERM', forwardSignal);
  await stopProcess(browserRun);
  await stopProcess(worker);
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
}
