import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { sanitizeImage } from '../../server/image.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function containedFile(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name)) throw new TypeError('Source file must be relative to its snapshot');
  const base = await realpath(root), file = await realpath(resolve(base, name));
  const rel = relative(base, file);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new TypeError('Source file escapes its snapshot');
  return file;
}

// The public API does not expose database versions, home-neighborhood membership,
// private moderation states, timestamps or original storage keys. Preserve that
// distinction in both the source namespace and the imported record provenance.
export function publicPilotRecord({ display, query, gallery, year }) {
  if (!display || typeof display.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(display.id) || typeof display.address !== 'string') throw new TypeError('Invalid public display');
  if (typeof query !== 'string' || !query || !Number.isInteger(year)) throw new TypeError('Explicit query and active-year contract are required');
  if (!Array.isArray(gallery)) throw new TypeError('Public gallery must be an array');
  if (display.hasPhotos && !gallery.length) throw new TypeError(`Public photo inventory is missing for ${display.id}`);
  return {
    id: display.id, address: display.address, season_year: year,
    season_id: `halloween-${year}`, season_kind: 'halloween', status: 'approved',
    theme: display.theme ?? '', tags: display.tags, custom_tags: display.customTags,
    level: display.level, featured: display.featured, x: display.x, y: display.y,
    photos: gallery.map((photo, position) => {
      if (typeof photo.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(photo.id) || photo.url !== `/api/photos/${photo.id}`) throw new TypeError('Unrecognized public photo locator');
      return { id: photo.id, object_key: `public-api/photos/${photo.id}`, status: 'approved', position, fit: photo.fit ?? 'cover' };
    }),
    public_snapshot: display,
    public_snapshot_scope: {
      kind: 'approved-public-api-snapshot', query,
      inferredFromSourceContract: ['approved visibility', `active Halloween year ${year}`, 'gallery order'],
      unavailable: ['home neighborhood', 'source version', 'source timestamps', 'private moderation history', 'original object keys'],
      targetNeighborhoodIsSourceHome: false
    }
  };
}

export async function loadPublicPilotSnapshot(root) {
  root = await realpath(root);
  const evidenceBytes = await readFile(await containedFile(root, 'evidence-v2.json'));
  const evidence = JSON.parse(evidenceBytes);
  const selection = JSON.parse(await readFile(await containedFile(root, 'canonical/public-listing-sample.json')));
  const index = JSON.parse(await readFile(await containedFile(root, 'photo-assets-index.json')));
  const year = selection.publicStatusPolicy?.configuredActiveSeasonYearFromQASource;
  if (!Number.isInteger(year) || !Array.isArray(selection.records) || selection.records.length < 1 || selection.records.length > 50) throw new TypeError('Expected a bounded public selection and explicit source-year contract');
  const responses = new Map();
  for (const area of evidence.areas || []) {
    const bytes = await readFile(await containedFile(root, area.rawResponsePath));
    if (sha(bytes) !== area.rawResponseSha256) throw new TypeError(`Source response checksum mismatch: ${area.areaQuery}`);
    const displays = JSON.parse(bytes).displays;
    if (!Array.isArray(displays) || displays.length !== area.fullReturnedDisplayCount) throw new TypeError('Source response count mismatch');
    responses.set(area.areaQuery, new Map(displays.map(display => [display.id, display])));
  }
  const assetEntries = new Map();
  for (const asset of index.assets || []) {
    if (assetEntries.has(asset.photoId)) throw new TypeError('Duplicate public photo asset ID');
    assetEntries.set(asset.photoId, asset);
  }
  const records = [], locationManifest = {}, assets = [], seen = new Set(), consumed = new Set();
  for (const selected of selection.records) {
    if (seen.has(selected.id)) throw new TypeError('Public selection repeats a display ID; reconcile query scopes explicitly');
    seen.add(selected.id);
    const query = selected.sourceMapQuery;
    const display = responses.get(query)?.get(selected.id);
    if (!display) throw new TypeError('Selected display is absent from its checksum-pinned source response');
    let gallery = [];
    if (display.hasPhotos) {
      const wrapper = JSON.parse(await readFile(await containedFile(root, `raw-api/photo-galleries-round2/${display.id}.json`)));
      const url = `https://frightthisway.com/api/displays/${display.id}/photos`;
      const observed = evidence.apiRequests?.find(request => request.url === url && request.status === 200);
      // The retained wrapper preserves parsed fields; reconstruct the original
      // compact response and require its exact observed bytes/hash before using
      // membership, fit or order. A canonical selection is not source evidence.
      const body = Buffer.from(JSON.stringify({photos:wrapper.photos}));
      if (!Array.isArray(wrapper.photos) || wrapper.sourceResponseUrl !== url || !observed ||
          sha(body) !== wrapper.sourceResponseSha256 || sha(body) !== observed.sha256 ||
          body.length !== wrapper.sourceResponseBytes || body.length !== observed.byteLength) throw new TypeError('Public gallery source proof mismatch');
      gallery = wrapper.photos;
      if (JSON.stringify(selected.photoGallery ?? []) !== JSON.stringify(gallery)) throw new TypeError('Canonical gallery differs from source membership/order');
    } else if (selected.photoGallery?.length) throw new TypeError('Unexpected gallery on a source display without photos');
    const record = publicPilotRecord({ display, query, gallery, year });
    records.push(record);
    // This is a candidate TARGET placement, to be checked against target coverage
    // by the rehearsal. It does not assert a legacy home-neighborhood identity.
    locationManifest[record.id] = {
      neighborhoodId: query, latitude: display.destination?.lat, longitude: display.destination?.lng,
      provenance: { kind: 'public-destination-coordinates', query, originalHomeNeighborhood: 'unavailable' }
    };
    for (const photo of gallery) {
      if (consumed.has(photo.id)) throw new TypeError('Public photo is referenced more than once');
      consumed.add(photo.id);
      const entry = assetEntries.get(photo.id);
      if (!entry || entry.sourceListingId !== record.id || entry.sourceUrl !== `https://frightthisway.com/api/photos/${photo.id}`) throw new TypeError('Missing or mismatched public photo evidence');
      const bytes = await readFile(await containedFile(root, entry.path));
      if (sha(bytes) !== entry.sha256) throw new TypeError('Source photo checksum mismatch');
      const image = sanitizeImage(bytes, entry.mediaType);
      if (image.width !== entry.width || image.height !== entry.height || image.width !== photo.width || image.height !== photo.height) throw new TypeError('Source photo dimensions disagree with its decoded bytes');
      const hash = sha(image.bytes), sourceKey = `public-api/photos/${photo.id}`;
      assets.push({ sourceKey, objectKey: `ftw-public-pilot/${photo.id}/${hash}`, contentHash: `sha256:${hash}`,
        mediaType: image.mediaType, width: image.width, height: image.height, bytes: image.bytes,
        sourceSha256: entry.sha256, sourceUrl: entry.sourceUrl, sanitationChangedBytes: !Buffer.from(image.bytes).equals(bytes) });
    }
  }
  return {
    sourceSystem: 'ftw-public-pilot', previewSeason: `halloween-${year}`, timestampUnit: 'milliseconds',
    records, locationManifest, assets,
    evidence: { scope: 'public-approved-only', capturedAtUtc: evidence.capturedAtUtc, evidenceSha256: sha(evidenceBytes),
      qaReferenceCommit: evidence.qaSourceHeadSha, sourceResponses: evidence.areas.map(area => ({ query: area.areaQuery, sha256: area.rawResponseSha256, returnedCount: area.fullReturnedDisplayCount })),
      limitation: 'This is not a full FTW database export. Status/year follow the inspected public-route contract, not per-record fields. Private states, original keys, source timestamps/versions and legacy home neighborhoods remain unverified.' }
  };
}
