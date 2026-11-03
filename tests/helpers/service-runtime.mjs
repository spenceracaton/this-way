import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pbkdf2Sync } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ownerPassword = 'local-owner-password-for-tests';
const passwordSalt = Buffer.from('this-way-test-salt');
const passwordVerifier = `pbkdf2-sha256$100000$${passwordSalt.toString('base64')}$${pbkdf2Sync(ownerPassword, passwordSalt, 100000, 32, 'sha256').toString('base64')}`;

export const TEST_OWNER_PASSWORD = ownerPassword;
export const TEST_ORIGIN = 'http://localhost';

export async function createTestService({ persistPath, activeSeason } = {}) {
  const bundled = await build({
    entryPoints: [resolve(root, 'server/index.mjs')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    loader: { '.json': 'json' },
  });
  const worker = bundled.outputFiles[0].text;
  const migration = await readFile(resolve(root, 'migrations/0001_initial.sql'), 'utf8');
  const runtime = new Miniflare({
    workers: [{ config: {
      name: 'this-way-service-test',
      compatibilityDate: '2026-10-30',
      manifest: { mainModule: 'index.mjs', modulesRoot: '/', modules: { 'index.mjs': { type: 'esm', contents: worker } } },
      env: {
        OWNER_PASSWORD_HASH: { type: 'text', value: passwordVerifier },
        SERVICE_SECRET: { type: 'text', value: 'fixed-local-service-test-secret-with-more-than-32-bytes' },
        LOCAL_DEVELOPMENT: { type: 'text', value: '1' },
        ...(activeSeason ? { ACTIVE_SEASON: { type: 'text', value: activeSeason } } : {}),
        DB: { type: 'd1', id: 'this-way-test-db' },
        PHOTOS: { type: 'r2', name: 'this-way-test-photos' },
      },
    } }],
    ...(persistPath ? { resourcePersistencePath: persistPath } : {}),
  });
  try {
    const db = await runtime.getD1Database('DB');
    const bucket = await runtime.getR2Bucket('PHOTOS');
    const sql = migration.replace(/^PRAGMA foreign_keys = ON;\s*/m, '');
    const triggers = [];
    const held = sql.replace(/CREATE TRIGGER[\s\S]*?\bEND;/gi, statement => `__TEST_TRIGGER_${triggers.push(statement) - 1}__;`);
    const statements = held.split(';').map(part => part.trim()).filter(Boolean).map(part => {
      const match = part.match(/__TEST_TRIGGER_(\d+)__/);
      return match ? triggers[Number(match[1])] : part;
    });
    for (const statement of statements) await db.prepare(statement).run();
    async function request(path, init = {}) {
      const headers = new Headers(init.headers || {});
      if (init.origin !== false && !headers.has('origin')) headers.set('origin', new URL(init.url || TEST_ORIGIN).origin);
      let body = init.body;
      if (body !== undefined && body !== null && typeof body === 'object' && !(body instanceof Uint8Array) && !Buffer.isBuffer(body) && !(body instanceof ArrayBuffer)) {
        body = JSON.stringify(body);
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
      const url = init.url ? new URL(path, init.url).href : new URL(path, TEST_ORIGIN).href;
      const options = { ...init, body, headers };
      delete options.origin;
      delete options.url;
      return runtime.dispatchFetch(url, options);
    }
    return { runtime, db, bucket, request, dispose: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
