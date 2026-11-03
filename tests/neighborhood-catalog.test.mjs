import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { importedNeighborhoods } from '../public/neighborhood-catalog.mjs';
import { neighborhoods } from '../public/neighborhoods.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFile(resolve(root, path));
const json = async path => JSON.parse(await read(path));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const finite = value => Number.isFinite(value);
const boundsValid = bounds => bounds && ['left', 'right', 'top', 'bottom'].every(key => finite(bounds[key])) && bounds.left < bounds.right && bounds.top < bounds.bottom;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const rel = path => path.replace(/^\.\//, 'public/');

test('catalog matches the supported fixed-neighborhood set and preserves the two sample maps', async () => {
  const summary = await json('public/data/neighborhood-import.json');
  const ids = Object.keys(neighborhoods);
  assert.equal(ids.length, 78);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), [...summary.supportedIds].sort());
  assert.deepEqual(summary.retainedSampleMaps, ['old-northeast', 'crescent-lake']);
  assert.equal(neighborhoods['old-northeast'].pins.length, 4);
  assert.equal(neighborhoods['crescent-lake'].pins.length, 4);
  assert.equal(importedNeighborhoods.length, 76);
  const sourcePlan = await json('scripts/ftw-expansion-sources.json');
  for (const id of Object.keys(sourcePlan.mapPrefixes)) assert.ok(ids.includes(id), `${id} recovered map`);
  for (const id of ['mystic-lake', 'stonesthrow', 'holiday-park']) assert.ok(ids.includes(id), `${id} verified source map`);
});

test('every imported map configuration, artwork, provenance and anchor is internally consistent', async () => {
  for (const item of importedNeighborhoods) {
    const configPath = rel(item.config);
    const config = await json(configPath);
    const dir = configPath.slice(0, configPath.lastIndexOf('/'));
    const [provenance, anchors, svgBytes, webp] = await Promise.all([
      json(`${dir}/provenance.json`), json(`${dir}/anchors.json`), read(rel(config.artwork)), read(rel(config.rasterArtwork))
    ]);
    const svg = svgBytes.toString('utf8');
    assert.equal(item.pins.length, 0, `${item.id} should have no invented sample pins`);
    assert.equal(config.id, item.id);
    assert.ok(config.name && item.name);
    assert.ok(finite(config.width) && config.width > 0 && finite(config.height) && config.height > 0);
    assert.ok(boundsValid(config.bounds), `${item.id} bounds`);
    assert.ok(boundsValid(config.overviewBounds), `${item.id} overview bounds`);
    assert.ok(config.projection && Object.values(config.projection).every(finite), `${item.id} projection`);
    const vb = svg.match(/<svg\b[^>]*\bviewBox="([^"]+)"/i)?.[1].trim().split(/[ ,]+/).map(Number);
    assert.deepEqual(vb, [config.bounds.left, config.bounds.top, config.bounds.right - config.bounds.left, config.bounds.bottom - config.bounds.top], `${item.id} SVG viewBox`);
    for (const [x, y] of config.coreBoundary) {
      assert.ok(x >= config.overviewBounds.left - .1 && x <= config.overviewBounds.right + .1 && y >= config.overviewBounds.top - .1 && y <= config.overviewBounds.bottom + .1, `${item.id} core fits overview`);
    }
    assert.ok(config.bounds.left <= config.overviewBounds.left + .1 && config.bounds.right >= config.overviewBounds.right - .1 && config.bounds.top <= config.overviewBounds.top + .1 && config.bounds.bottom >= config.overviewBounds.bottom - .1, `${item.id} overview fits full bounds`);
    assert.doesNotMatch(svg, /<\s*(script|image|symbol|filter|pattern)\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*(?!#)/i, `${item.id} SVG contains active/external content`);
    assert.doesNotMatch(svg, /seasonal|christmas|holiday|overlay/i, `${item.id} SVG has seasonal overlay content`);
    const ids = new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
    for (const [, reference] of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.has(reference), `${item.id} unresolved SVG reference #${reference}`);
    assert.match(provenance.coreMaskGeometrySha256, /^[a-f\d]{64}$/i);
    assert.match(provenance.nearbyMaskGeometrySha256, /^[a-f\d]{64}$/i);
    for (const [maskId, hash] of [['spotlight', provenance.coreMaskGeometrySha256], ['nearbyBlocksMask', provenance.nearbyMaskGeometrySha256]]) {
      const mask = svg.match(new RegExp(`<mask\\b[^>]*\\bid="${maskId}"[^>]*>([\\s\\S]*?)</mask>`))?.[1];
      assert.ok(mask, `${item.id} missing ${maskId}`);
      const pathData = [...mask.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)].map(match => match[1]);
      assert.ok(pathData.length, `${item.id} ${maskId} has no path geometry`);
      assert.equal(sha256(pathData.join('\n')), hash, `${item.id} ${maskId} geometry hash`);
    }
    assert.equal(provenance.rasterArtwork.sourceSha256, sha256(svgBytes), `${item.id} source SVG hash`);
    assert.equal(provenance.rasterArtwork.sha256, sha256(webp), `${item.id} raster hash`);
    assert.equal(provenance.rasterArtwork.bytes, webp.length);
    assert.ok(provenance.rasterArtwork.width <= 3072 && provenance.rasterArtwork.height <= 3072, `${item.id} raster dimensions`);
    assert.equal(webp.toString('ascii', 0, 4), 'RIFF');
    assert.equal(webp.toString('ascii', 8, 12), 'WEBP');
    assert.equal(provenance.rasterArtwork.encoding, 'lossless WebP');
    assert.match(config.attribution.label, /© OpenStreetMap contributors/);
    assert.match(config.attribution.href, /^https:\/\//);
    if (config.sourceNotices) {
      const notices = await json(rel(config.sourceNotices));
      assert.equal(sha256(await read(rel(config.sourceNotices))), provenance.sourceNoticesSha256, `${item.id} source notice checksum`);
      assert.ok(notices.coverageSources.length, `${item.id} source coverage references`);
      assert.ok(notices.attribution || notices.featureNotices.length, `${item.id} source-specific notices`);
      if (notices.coverageSources.some(url => url.includes('egis.stpete.org'))) {
        assert.ok(config.additionalAttributions.some(credit => /City of St. Petersburg/.test(credit.label)), `${item.id} City source credit`);
      }
      // Missing source-wide license metadata must remain unspecified. A map
      // with several sources must not acquire an invented blanket ODbL grant.
      assert.equal(config.license, notices.license ?? null, `${item.id} original license statement`);
    }
    assert.equal(anchors.length, 4, `${item.id} must have four independent anchors`);

    const p = config.projection;
    for (const anchor of anchors) {
      const { lat, lng } = anchor.sourceGeographic;
      const projected = [p.xOrigin + (lng - p.lngOrigin) * p.xScale, p.yOrigin - (lat - p.latOrigin) * p.yScale];
      assert.ok(distance(projected, anchor.expectedSourcePoint) <= .1, `${item.id} anchor projection`);
      const coordinate = value => `${String(Number(value.toFixed(2))).replace('.', '\\.')}(?:\\.0+)?`;
      const [x, y] = anchor.expectedSourcePoint;
      assert.ok(new RegExp(`${coordinate(x)}(?:[, ]|[A-Za-z])+${coordinate(y)}0*(?=[^\\d.]|$)`).test(svg), `${item.id} anchor point ${x},${y} absent from SVG paths`);
    }
  }
});
