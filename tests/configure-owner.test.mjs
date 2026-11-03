import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOwnerSecrets, writeOwnerSecrets } from '../scripts/configure-owner.mjs';
import { passwordMatches } from '../server/auth.mjs';

test('owner credential file contains a valid verifier and private random secret without overwriting', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'this-way-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'private', 'owner-secrets.json');
  const secrets = createOwnerSecrets('a sufficiently long owner password');
  await writeOwnerSecrets(output, secrets);

  const saved = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(saved, secrets);
  assert.match(saved.OWNER_PASSWORD_HASH, /^pbkdf2-sha256\$100000\$/);
  assert.equal(await passwordMatches('a sufficiently long owner password', saved.OWNER_PASSWORD_HASH), true);
  assert.equal(saved.SERVICE_SECRET.length >= 32, true);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(writeOwnerSecrets(output, createOwnerSecrets('another sufficiently long password')), { code: 'EEXIST' });
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), secrets);
  assert.throws(() => createOwnerSecrets('short'), /between 12 and 256/);
});
