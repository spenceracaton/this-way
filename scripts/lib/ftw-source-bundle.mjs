import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { sanitizeImage } from '../../server/image.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(message) { throw new TypeError(message); }

async function containedFile(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name)) fail('Asset path must be relative to bundle');
  const file = await realpath(resolve(root, name));
  const rel = relative(root, file);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    fail('Asset path escapes bundle');
  }
  return file;
}

function validatePhoto(photo, label) {
  if (!photo || typeof photo !== 'object' || typeof photo.id !== 'string' || !photo.id) fail(`${label} requires actual source id`);
  const key = photo.object_key ?? photo.objectKey;
  if (typeof key !== 'string' || !key) fail(`${label} requires original object key`);
  if (typeof photo.status !== 'string' || !['approved','published','pending','rejected','removed','hidden'].includes(photo.status.toLowerCase())) {
    fail(`${label} requires supported actual source status`);
  }
  if (!Number.isSafeInteger(photo.created_at) || photo.created_at < 0) fail(`${label} requires actual created_at`);
  return key;
}

function validateRecord(record, identities) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('records must contain objects');
  if (typeof record.id !== 'string' || !record.id.trim()) fail('each record requires an actual source id');
  if (!Number.isInteger(record.season_year) || record.season_year < 1900 || record.season_year > 2200) fail(`record ${record.id} requires explicit season_year`);
  const identity = `${record.id}\0${record.season_year}`;
  if (identities.has(identity)) fail(`duplicate listing identity ${record.id}`);
  identities.add(identity);
  if (typeof record.status !== 'string' || !['approved','published','pending','hidden','rejected','archived'].includes(record.status.toLowerCase())) {
    fail(`record ${record.id} requires supported actual source status`);
  }
  if (!Number.isSafeInteger(record.created_at) || record.created_at < 0) fail(`record ${record.id} requires actual created_at`);
  if (record.photo_key || record.photoKey) fail(`record ${record.id} has legacy photo_key; canonicalize it into explicit photos`);
  if (!Array.isArray(record.photos)) fail(`record ${record.id} requires an explicit photos array`);
  if (record.house_photos !== undefined || record.housePhotos !== undefined || record.photoContributions !== undefined) {
    fail(`record ${record.id} has unsupported photo aliases; canonicalize them into photos and photo_contributions`);
  }
  const keys = record.photos.map(photo => validatePhoto(photo, `photo in ${record.id}`));
  if (record.photo_contributions !== undefined && !Array.isArray(record.photo_contributions)) fail(`record ${record.id} photo_contributions must be an array`);
  for (const contribution of record.photo_contributions ?? []) {
    if (!contribution || typeof contribution !== 'object' || !Array.isArray(contribution.items)) fail(`record ${record.id} contribution items must be explicit`);
    for (const photo of contribution.items) keys.push(validatePhoto(photo, 'contribution photo'));
  }
  return keys;
}

/** Validate a bounded operator-asserted bundle. Integrity checks do not prove authority or authenticity. */
export async function loadFtwSourceBundle(bundlePath) {
  const file = await realpath(bundlePath);
  const root = await realpath(dirname(file));
  const raw = await readFile(file);
  if (raw.length > 8 * 1024 * 1024) fail('bundle JSON exceeds 8 MiB');
  const bundle = JSON.parse(raw);
  const p = bundle.provenance;
  if (p?.sourceSystem === 'ftw-public-pilot' || p?.kind?.includes('public')) fail('public pilot bundles are not authenticated content exports');
  if (bundle.schemaVersion !== 1 || !p || p.kind !== 'authenticated-content-export' || p.sourceSystem !== 'fright-this-way') {
    fail('expected authenticated-content-export bundle schema v1');
  }
  for (const key of ['captureId','capturedAt','authoritativeSystem','exporterVersion']) {
    if (typeof p[key] !== 'string' || !p[key].trim()) fail(`provenance.${key} is required`);
  }
  if (!Number.isFinite(Date.parse(p.capturedAt)) || p.complete !== true || !['milliseconds','seconds'].includes(p.timestampUnit)) {
    fail('bundle must assert complete scope and explicit timestampUnit');
  }
  if (!Array.isArray(p.unavailableFields) || p.unavailableFields.some(field => typeof field !== 'string')) {
    fail('provenance.unavailableFields must explicitly list unavailable source fields (or be empty)');
  }
  if (!p.scope || !Array.isArray(p.scope.seasons) || !p.scope.seasons.length || !Array.isArray(p.scope.neighborhoods)) {
    fail('provenance.scope requires seasons and neighborhoods arrays');
  }
  if (!Array.isArray(bundle.records) || bundle.records.length < 1 || bundle.records.length > 25) fail('authenticated bundle supports 1 to 25 listings');
  if (Buffer.byteLength(JSON.stringify(bundle.records)) > 768 * 1024) fail('prepared record metadata exceeds 768 KiB');

  const identities = new Set(), photoKeys = [];
  for (const record of bundle.records) photoKeys.push(...validateRecord(record, identities));
  if (photoKeys.length > 100) fail('authenticated bundle supports at most 100 photos');
  const declaredSeasons = new Set(p.scope.seasons.map(value => Number(typeof value === 'object' ? value.year : value)));
  if (bundle.records.some(record => !declaredSeasons.has(record.season_year))) fail('record season falls outside declared export scope');
  const neighborhoods = new Set(p.scope.neighborhoods);
  if (bundle.locationManifest != null && (typeof bundle.locationManifest !== 'object' || Array.isArray(bundle.locationManifest))) {
    fail('locationManifest must be an object keyed by source id or source id:year');
  }
  for (const record of bundle.records) {
    const mapped = bundle.locationManifest?.[`${record.id}:${record.season_year}`] ?? bundle.locationManifest?.[record.id];
    const match = typeof (record.address_match ?? record.addressMatch) === 'string'
      ? JSON.parse(record.address_match ?? record.addressMatch) : record.address_match ?? record.addressMatch;
    const home = mapped?.neighborhoodId ?? mapped?.neighborhood_id ?? match?.neighborhoodId ?? match?.neighborhood_id;
    if (home && !neighborhoods.has(home)) fail(`record ${record.id} home neighborhood falls outside declared scope`);
  }
  if (!bundle.assetManifest || !Array.isArray(bundle.assetManifest.assets)) fail('assetManifest.assets is required, including when empty');
  if (bundle.assetManifest.assets.length > 100) fail('authenticated bundle supports at most 100 asset entries');
  const refs = new Set(photoKeys), seen = new Set(), assets = [];
  for (const entry of bundle.assetManifest.assets) {
    if (!entry || typeof entry.sourceKey !== 'string' || !entry.sourceKey || seen.has(entry.sourceKey)) fail('asset sourceKey must be unique and non-empty');
    seen.add(entry.sourceKey);
    if (!refs.has(entry.sourceKey)) fail(`orphan asset manifest entry ${entry.sourceKey}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(entry.originalContentHash ?? '')) fail(`asset ${entry.sourceKey} requires originalContentHash`);
    const path = await containedFile(root, entry.path);
    if ((await stat(path)).size > 2 * 1024 * 1024) fail(`source asset exceeds 2 MiB: ${entry.sourceKey}`);
    const bytes = await readFile(path);
    if (`sha256:${sha(bytes)}` !== entry.originalContentHash) fail(`source bytes hash mismatch for ${entry.sourceKey}`);
    const image = sanitizeImage(bytes, entry.mediaType);
    if (image.mediaType !== entry.mediaType) fail(`source image media type mismatch for ${entry.sourceKey}`);
    if (image.width !== entry.width || image.height !== entry.height) fail(`source image dimensions mismatch for ${entry.sourceKey}`);
    const contentHash = sha(image.bytes);
    const extension = { 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp' }[image.mediaType];
    const objectKey = `ftw-import/${sha(Buffer.from(entry.sourceKey))}/${contentHash}.${extension}`;
    assets.push({ sourceKey:entry.sourceKey, objectKey, contentHash:`sha256:${contentHash}`, mediaType:image.mediaType,
      width:image.width, height:image.height, bytes:image.bytes, originalContentHash:entry.originalContentHash });
  }
  for (const key of refs) if (!seen.has(key)) fail(`missing photo bytes/disposition for source key ${key}`);
  const sourceDigest = sha(raw);
  return {
    input: { sourceSystem:p.sourceSystem, records:bundle.records,
      assetManifest:{ assets:assets.map(({bytes,...asset})=>asset) }, timestampUnit:p.timestampUnit,
      seasonMappings:bundle.seasonMappings ?? {}, locationManifest:bundle.locationManifest ?? {} },
    assets, provenance:p, sourceDigest,
    reconciliation:{ listingCount:bundle.records.length, photoCount:photoKeys.length, assetCount:assets.length }
  };
}
