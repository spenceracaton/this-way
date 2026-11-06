import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function buildCoverage(registry, supplements) {
  return { version: 1, neighborhoods: Object.entries(registry).map(([id, area]) => {
    const p = area.projection;
    const core = area.coreBoundary?.map(([x, y]) => [
      Number((p.lngOrigin + (x - p.xOrigin) / p.xScale).toFixed(7)),
      Number((p.latOrigin - (y - p.yOrigin) / p.yScale).toFixed(7))
    ]) || supplements[id]?.core;
    if (!Array.isArray(core) || core.length < 3) throw new Error(`No reviewed core for ${id}; artwork rectangles are not location coverage.`);
    return { id, name: area.name, core };
  }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const registry = JSON.parse(await readFile(new URL('../server/neighborhoods.json', import.meta.url)));
  const supplements = JSON.parse(await readFile(new URL('./near-me-coverage-supplement.json', import.meta.url)));
  const coverage = buildCoverage(registry, supplements);
  await writeFile(new URL('../public/data/neighborhood-coverage.json', import.meta.url), JSON.stringify(coverage) + '\n');
  console.log(`Prepared ${coverage.neighborhoods.length} reviewed cores for Near me.`);
}
