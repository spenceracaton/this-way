import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { neighborhoods } from '../public/neighborhoods.mjs';

test('server coverage validation stays synchronized with every client map configuration', async () => {
  const registry = JSON.parse(await readFile(new URL('../server/neighborhoods.json', import.meta.url)));
  assert.deepEqual(Object.keys(registry).sort(), Object.keys(neighborhoods).sort());
  for (const [id, entry] of Object.entries(neighborhoods)) {
    const client = JSON.parse(await readFile(new URL('../public/' + entry.config.replace(/^\.\//, ''), import.meta.url)));
    assert.deepEqual(registry[id], { name: entry.name, projection: client.projection, bounds: client.bounds, coreBoundary: client.coreBoundary || null }, `${id}: run node scripts/build-service-geography.mjs after a geography change`);
  }
});
