import { readFile, writeFile } from 'node:fs/promises';
import { neighborhoods } from '../public/neighborhoods.mjs';
const registry = {};
for (const [id, entry] of Object.entries(neighborhoods)) {
  const area = JSON.parse(await readFile(new URL('../public/' + entry.config.replace(/^\.\//, ''), import.meta.url)));
  registry[id] = { name: entry.name, projection: area.projection, bounds: area.bounds, coreBoundary: area.coreBoundary || null };
}
await writeFile(new URL('../server/neighborhoods.json', import.meta.url), JSON.stringify(registry) + '\n');
console.log(`Prepared geography validation for ${Object.keys(registry).length} neighborhoods.`);
