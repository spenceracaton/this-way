import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function applyMigrations(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS test_schema_migrations(name TEXT PRIMARY KEY NOT NULL)').run();
  const names = (await readdir(resolve(root, 'migrations')))
    .filter(name => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of names) {
    if (await db.prepare('SELECT name FROM test_schema_migrations WHERE name=?').bind(name).first()) continue;
    const sql = (await readFile(resolve(root, 'migrations', name), 'utf8'))
      .replace(/^PRAGMA foreign_keys = ON;\s*/m, '');
    const triggers = [];
    const held = sql.replace(/CREATE TRIGGER[\s\S]*?\bEND;/gi,
      statement => `__TEST_TRIGGER_${triggers.push(statement) - 1}__;`);
    const statements = held.split(';').map(part => part.trim()).filter(Boolean).map(part => {
      const match = part.match(/__TEST_TRIGGER_(\d+)__/);
      return match ? triggers[Number(match[1])] : part;
    });
    await db.batch([...statements.map(statement => db.prepare(statement)), db.prepare('INSERT INTO test_schema_migrations(name) VALUES(?)').bind(name)]);
  }
}

export async function createFtwOperatorRuntime({
  token = 'local-only-operator-token-32-bytes-minimumx',
  commandKey = 'ftw-operator/test-run-0001/command.json',
  commandSha256 = '0'.repeat(64), runId = 'test-run-0001', expiresAt = String(Date.now() + 60_000),
  persistPath,
} = {}) {
  const bundled = await build({
    entryPoints: [resolve(root, 'operator/worker.mjs')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['node:*'],
  });
  const worker = bundled.outputFiles[0].text;
  const runtime = new Miniflare({
    workers: [{ config: {
      name: 'ftw-operator-test',
      compatibilityDate: '2026-10-30',
      compatibilityFlags: ['nodejs_compat'],
      manifest: { mainModule: 'operator.mjs', modulesRoot: '/', modules: {
        'operator.mjs': { type: 'esm', contents: worker },
      } },
      env: {
        OPERATOR_TOKEN: { type: 'text', value: token },
        COMMAND_KEY: { type: 'text', value: commandKey },
        COMMAND_SHA256: { type: 'text', value: commandSha256 },
        RUN_ID: { type: 'text', value: runId },
        EXPIRES_AT: { type: 'text', value: expiresAt },
        DB: { type: 'd1', id: 'ftw-operator-test-db' },
        PHOTOS: { type: 'r2', name: 'ftw-operator-test-photos' },
        CONTROL: { type: 'r2', name: 'ftw-operator-test-control' },
      },
    } }],
    ...(persistPath ? { resourcePersistencePath: persistPath } : {}),
  });
  try {
    const db = await runtime.getD1Database('DB');
    const bucket = await runtime.getR2Bucket('PHOTOS');
    const controlBucket = await runtime.getR2Bucket('CONTROL');
    await applyMigrations(db);
    async function request(path, init = {}) {
      const headers = new Headers(init.headers || {});
      if (init.body !== undefined && typeof init.body !== 'string' && !(init.body instanceof Uint8Array)) {
        init = { ...init, body: JSON.stringify(init.body) };
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
      return runtime.dispatchFetch(new URL(path, 'http://localhost').href, { ...init, headers });
    }
    return { runtime, db, bucket, controlBucket, request, dispose: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
