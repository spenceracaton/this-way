import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdir, open, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const defaultOutputPath = path.join(os.homedir(), '.config', 'this-way', 'owner-secrets.json');

async function readLine(prompt) {
  if (!process.stdin.isTTY) {
    const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const lines = [];
    for await (const line of readline) lines.push(line);
    if (lines.length !== 2) throw new Error('For stdin input, provide exactly two lines: owner password, then confirmation.');
    return lines;
  }
  const readHidden = message => new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stderr;
    let value = '';
    output.write(message);
    input.setRawMode(true);
    input.resume();
    const finish = (error, result) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(result);
    };
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') return finish(new Error('Cancelled.'));
        if (character === '\r' || character === '\n') return finish(null, value);
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    input.on('data', onData);
  });
  return [await readHidden(prompt), await readHidden('Confirm owner password: ')];
}

export function createOwnerSecrets(password) {
  if (password.length < 12 || password.length > 256) throw new Error('Choose an owner password between 12 and 256 characters.');
  const salt = randomBytes(16);
  const verifier = `pbkdf2-sha256$100000$${salt.toString('base64')}$${pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('base64')}`;
  const serviceSecret = randomBytes(32).toString('base64url');
  return { OWNER_PASSWORD_HASH: verifier, SERVICE_SECRET: serviceSecret };
}

export async function writeOwnerSecrets(outputPath, secrets) {
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const file = await open(outputPath, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(secrets, null, 2) + '\n');
    await file.sync();
  } finally { await file.close(); }
  await chmod(outputPath, 0o600);
}

function outputPathFromArgs(args) {
  if (args.length === 0) return defaultOutputPath;
  if (args.length !== 2 || args[0] !== '--output' || !args[1]) throw new Error('Usage: node scripts/configure-owner.mjs [--output path]');
  return path.resolve(args[1]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const outputPath = outputPathFromArgs(process.argv.slice(2));
    const [password, confirmation] = await readLine('Owner password: ');
    if (password !== confirmation) throw new Error('The password entries did not match.');
    await writeOwnerSecrets(outputPath, createOwnerSecrets(password));
    process.stdout.write(`Owner verifier and service secret saved with private file permissions to ${outputPath}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
