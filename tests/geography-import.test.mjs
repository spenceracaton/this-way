import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const repo = resolve(new URL('..', import.meta.url).pathname);
const importer = resolve(repo, 'scripts/import-ftw-geography.py');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function fixture({ expansion = false, countyRoads = false } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'this-way-import-'));
  const source = resolve(root, 'source');
  const reference = resolve(root, 'reference');
  const output = resolve(root, 'output');
  await Promise.all([mkdir(source), mkdir(reference), mkdir(output)]);

  const ids = ['alpha-map', 'zeta-map'];
  const maps = {};
  const buffers = {};
  const files = [];
  for (const [mapIndex, id] of ids.entries()) {
    const dir = resolve(source, id);
    await mkdir(dir);
    const points = [
      [100, 100], [400, 100], [700, 100], [1000, 100],
    ];
    const lines = points.map(([x, y], index) => `<path d="M ${x} ${y} L ${x + 10} ${y + 10}"/>`).join('');
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200"><defs><g id="geographyArtwork">${lines}</g><mask id="spotlight"><path d="M 0 0 L 1100 0 L 1100 1100 Z"/></mask></defs><g id="art">${lines}</g></svg>`);
    const mapData = {
      attribution: countyRoads
        ? 'Pinellas County eGIS; U.S. Geological Survey National Hydrography Dataset'
        : '© OpenStreetMap contributors',
      ...(expansion ? {
        license: null,
        sourceLicenses: [{ source: 'county imagery', terms: 'County and Esri terms apply' }],
        coverageDerivation: 'Reviewed from city GIS and county aerials.',
      } : { license: 'ODbL-1.0', licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/' }),
      ...(countyRoads ? {
        license: 'Mixed public geographic sources; see provenance',
        licenseUrl: 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer',
        coverageDerivation: { identity: 'Public source geography reference.', precision: 'Requested address: 101 QA Fixture Street' },
      } : {}),
      features: points.map(([x], index) => ({
        type: 'Feature', id: countyRoads ? `pinellas-road/${mapIndex * 10 + index + 1}/0` : `way/${mapIndex * 10 + index + 1}`,
        properties: countyRoads
          ? { highway: 'residential', source: 'Pinellas County RoadCenterline', sourceCenterlineId: `${mapIndex * 10 + index + 1}` }
          : expansion
          ? { highway: 'residential', sourceLicense: 'OpenStreetMap ODbL-1.0' }
          : { osmType: 'way', osmId: mapIndex * 10 + index + 1, highway: 'residential' },
        geometry: { type: 'LineString', coordinates: [[x / 10000, 0], [(x + 10) / 10000, -0.001]] },
      })).concat(countyRoads ? [{
        type: 'Feature', id: 'usgs-nhd/waterbody/1',
        properties: { source: 'USGS NHD', sourceObjectId: 1 },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0]]] },
      }] : []),
    };
    const buffer = { artwork: '<mask id="nearbyBlocksMask"><path d="M 0 0 L 1100 0 L 1100 1100 Z"/></mask><g id="nearbyBlocksArtwork"><path d="M 0 0 L 1100 0"/></g>' };
    const bufferModule = Buffer.from(`export default ${JSON.stringify(buffer)};\n`);
    await Promise.all([
      writeFile(resolve(dir, 'review-map.svg'), svg),
      writeFile(resolve(dir, 'map-data.json'), jsonBytes(mapData)),
      writeFile(resolve(dir, 'buffer.mjs'), bufferModule),
    ]);
    for (const [name, bytes] of [['review-map.svg', svg], ['map-data.json', jsonBytes(mapData)], ['buffer.mjs', bufferModule]]) {
      files.push({ id, file: name, sourcePath: `${id}/${name}`, sha256: sha256(bytes) });
    }
    maps[id] = {
      name: id === 'alpha-map' ? 'Alpha Map' : 'Zeta Map',
      projection: { xOrigin: 0, yOrigin: 100, lngOrigin: 0, latOrigin: 0, xScale: 10000, yScale: 100000 },
      bounds: { left: 0, right: 1100, top: 0, bottom: 1100 },
      ...(expansion ? { coverageSources: countyRoads ? [
        'https://services.arcgis.com/f5HgUpxURgEzTccH/ArcGIS/rest/services/Pinellas_RoadCenterline_view/FeatureServer/0',
        'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer',
      ] : ['https://egis.stpete.org/city-gis', 'https://egis.pinellas.gov/County2026'] } : {}),
    };
    buffers[id] = {
      bufferBounds: { left: -20, right: 1120, top: -20, bottom: 1120 },
      coreCoverage: [[0, 0], [0.1, 0], [0.1, -0.01], [0, -0.01]],
    };
  }
  const mapsBytes = jsonBytes(maps);
  const buffersBytes = jsonBytes(buffers);
  const manifest = {
    repository: 'fixture/maps', revision: 'fixture-rev', files,
    ...(expansion ? { normalizedSourceNotices: true } : {}),
    referenceFiles: {
      'neighborhood-maps.json': { sha256: sha256(mapsBytes) },
      'neighborhood-buffer-config.json': { sha256: sha256(buffersBytes) },
    },
  };
  await Promise.all([
    writeFile(resolve(source, 'manifest.json'), jsonBytes(manifest)),
    writeFile(resolve(reference, 'neighborhood-maps.json'), mapsBytes),
    writeFile(resolve(reference, 'neighborhood-buffer-config.json'), buffersBytes),
  ]);
  return { root, source, reference, output, ids, files, manifest };
}

function run(f, ids) {
  return spawnSync('python3', [importer, '--source', f.source, '--reference', f.reference,
    '--output-root', f.output, '--ids', ...ids], { encoding: 'utf8' });
}

test('incremental import adds a map while preserving prior map and raster bytes', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const priorConfig = Buffer.from('{"id":"alpha-map","name":"Alpha Map","fixture":"previous config"}\n');
  const priorSvg = Buffer.from('<svg>previous map</svg>');
  const priorRaster = Buffer.from('previous raster bytes');
  await mkdir(resolve(f.output, 'public/data/alpha-map'), { recursive: true });
  await mkdir(resolve(f.output, 'public/assets/neighborhoods'), { recursive: true });
  await Promise.all([
    writeFile(resolve(f.output, 'public/data/alpha-map/neighborhood.json'), priorConfig),
    writeFile(resolve(f.output, 'public/assets/neighborhoods/alpha-map.svg'), priorSvg),
    writeFile(resolve(f.output, 'public/assets/neighborhoods/alpha-map.webp'), priorRaster),
    writeFile(resolve(f.output, 'public/data/neighborhood-import.json'), jsonBytes({ importedIds: ['alpha-map'] })),
  ]);

  const result = run(f, ['zeta-map']);
  assert.equal(result.status, 0, result.stderr);
  for (const [path, expected] of [
    ['public/data/alpha-map/neighborhood.json', priorConfig],
    ['public/assets/neighborhoods/alpha-map.svg', priorSvg],
    ['public/assets/neighborhoods/alpha-map.webp', priorRaster],
  ]) assert.deepEqual(await readFile(resolve(f.output, path)), expected, path);
  const catalog = await readFile(resolve(f.output, 'public/neighborhood-catalog.mjs'), 'utf8');
  assert.match(catalog, /alpha-map/);
  assert.match(catalog, /zeta-map/);
  const summary = JSON.parse(await readFile(resolve(f.output, 'public/data/neighborhood-import.json'), 'utf8'));
  assert.deepEqual(summary.importedIds, ['alpha-map', 'zeta-map']);
});

test('a bad checksum late in a batch leaves the output tree untouched', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  f.files.find(file => file.id === 'zeta-map' && file.file === 'map-data.json').sha256 = '0'.repeat(64);
  await writeFile(resolve(f.source, 'manifest.json'), jsonBytes({ repository: 'fixture/maps', revision: 'fixture-rev', files: f.files }));
  const sentinel = Buffer.from('existing catalog bytes\n');
  await mkdir(resolve(f.output, 'public/data'), { recursive: true });
  await writeFile(resolve(f.output, 'public/neighborhood-catalog.mjs'), sentinel);
  await writeFile(resolve(f.output, 'public/data/neighborhood-import.json'), sentinel);

  const result = run(f, ['alpha-map', 'zeta-map']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch/i);
  assert.deepEqual(await readFile(resolve(f.output, 'public/neighborhood-catalog.mjs')), sentinel);
  assert.deepEqual(await readFile(resolve(f.output, 'public/data/neighborhood-import.json')), sentinel);
  await assert.rejects(readFile(resolve(f.output, 'public/data/alpha-map/neighborhood.json')), { code: 'ENOENT' });
});

test('unknown IDs and retained sample IDs are rejected without output changes', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const id of ['unknown-map', 'old-northeast']) {
    const result = run(f, [id]);
    assert.notEqual(result.status, 0, id);
    assert.match(result.stderr, /select nonempty prepared map ids/i, id);
  }
  await assert.rejects(readFile(resolve(f.output, 'public/neighborhood-catalog.mjs')), { code: 'ENOENT' });
});

test('expansion retains mixed source terms and supplies OSM IDs from feature IDs', async t => {
  const f = await fixture({ expansion: true });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = run(f, ['alpha-map']);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await readFile(resolve(f.output, 'public/data/alpha-map/neighborhood.json'), 'utf8'));
  const notices = JSON.parse(await readFile(resolve(f.output, 'public/data/alpha-map/source-notices.json'), 'utf8'));
  const anchors = JSON.parse(await readFile(resolve(f.output, 'public/data/alpha-map/anchors.json'), 'utf8'));
  assert.equal(config.license, null);
  assert.equal(config.sourceNotices, './data/alpha-map/source-notices.json');
  assert.equal(config.attribution.href, 'https://www.openstreetmap.org/copyright');
  assert.deepEqual(config.additionalAttributions.map(item => item.label), ['City of St. Petersburg GIS', 'Pinellas County imagery / Esri']);
  assert.deepEqual(notices.sourceLicenses, [{ source: 'county imagery', terms: 'County and Esri terms apply' }]);
  assert.equal(notices.coverageDerivation, 'Reviewed from city GIS and county aerials.');
  assert.deepEqual(notices.featureNotices, [{ sourceLicense: 'OpenStreetMap ODbL-1.0' }]);
  assert.deepEqual(notices.coverageSources, f.manifest.normalizedSourceNotices ? [
    'https://egis.stpete.org/city-gis', 'https://egis.pinellas.gov/County2026',
  ] : []);
  assert.deepEqual(anchors.map(anchor => anchor.osmId).sort(), ['1', '2', '3', '4']);
});

test('reviewed Pinellas and USGS bundle keeps source-specific credits and source anchor IDs', async t => {
  const f = await fixture({ expansion: true, countyRoads: true });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = run(f, ['alpha-map']);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await readFile(resolve(f.output, 'public/data/alpha-map/neighborhood.json'), 'utf8'));
  const notices = JSON.parse(await readFile(resolve(f.output, 'public/data/alpha-map/source-notices.json'), 'utf8'));
  const anchors = JSON.parse(await readFile(resolve(f.output, 'public/data/alpha-map/anchors.json'), 'utf8'));
  assert.equal(config.license, 'Mixed public geographic sources; see provenance');
  assert.deepEqual(config.attribution, {
    label: 'Pinellas County eGIS',
    href: 'https://services.arcgis.com/f5HgUpxURgEzTccH/ArcGIS/rest/services/Pinellas_RoadCenterline_view/FeatureServer/0',
  });
  assert.deepEqual(config.additionalAttributions, [{
    label: 'U.S. Geological Survey National Hydrography Dataset',
    href: 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer',
  }]);
  assert.equal(notices.attribution, 'Pinellas County eGIS; U.S. Geological Survey National Hydrography Dataset');
  assert.deepEqual(notices.coverageDerivation, { identity: 'Public source geography reference.' });
  assert.ok(notices.omittedSourceFields.includes('coverageDerivation.precision (request-specific QA note)'));
  for (const name of ['neighborhood.json', 'source-notices.json', 'provenance.json']) {
    assert.doesNotMatch(await readFile(resolve(f.output, 'public/data/alpha-map', name), 'utf8'), /101 QA Fixture Street/);
  }
  assert.equal(anchors.length, 4);
  assert.ok(anchors.every(anchor => anchor.sourceType === 'Pinellas County RoadCenterline' && !('osmId' in anchor)));
  assert.deepEqual(anchors.map(anchor => anchor.sourceId).sort(), ['1', '2', '3', '4']);
});

test('unreviewed source providers remain rejected', async t => {
  const f = await fixture({ expansion: true });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const dataPath = resolve(f.source, 'alpha-map/map-data.json');
  const data = JSON.parse(await readFile(dataPath, 'utf8'));
  data.attribution = 'Unknown local source';
  data.features = data.features.map((feature, index) => ({
    ...feature, id: `unknown-provider/${index + 1}`,
    properties: { highway: 'residential', source: 'Unknown provider', sourceObjectId: index + 1 },
  }));
  const bytes = jsonBytes(data);
  await writeFile(dataPath, bytes);
  f.files.find(file => file.id === 'alpha-map' && file.file === 'map-data.json').sha256 = sha256(bytes);
  await writeFile(resolve(f.source, 'manifest.json'), jsonBytes({ ...f.manifest, files: f.files }));
  const result = run(f, ['alpha-map']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unrecognized geography source/i);
  await assert.rejects(readFile(resolve(f.output, 'public/data/alpha-map/neighborhood.json')), { code: 'ENOENT' });
});

test('a changed prepared reference file is rejected before output writes', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const sentinel = Buffer.from('existing output\n');
  await mkdir(resolve(f.output, 'public'), { recursive: true });
  await writeFile(resolve(f.output, 'public/neighborhood-catalog.mjs'), sentinel);
  await writeFile(resolve(f.reference, 'neighborhood-maps.json'), jsonBytes({ changed: true }));
  const result = run(f, ['alpha-map']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reference checksum mismatch/i);
  assert.deepEqual(await readFile(resolve(f.output, 'public/neighborhood-catalog.mjs')), sentinel);
  await assert.rejects(readFile(resolve(f.output, 'public/data/alpha-map/neighborhood.json')), { code: 'ENOENT' });
});
