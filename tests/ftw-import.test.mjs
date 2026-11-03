import test from 'node:test';
import assert from 'node:assert/strict';
import { planFtwImport } from '../server/import-ftw.mjs';

const record = (overrides = {}) => ({
  id: 'legacy-17', season_year: 2026, address: '12 Maple St', status: 'approved',
  theme: 'Lanterns', description: 'Warm lights', tags: '["Lights"]', custom_tags: '["paper stars"]',
  x: 1234.5, y: 678.25, address_match: { neighborhoodId: 'old-northeast', source: 'county', latitude: 27.769, longitude: -82.639 },
  created_at: 1700000000, reviewed_at: 1700000100, version: 3,
  photos: [{ id: 'photo-1', object_key: 'legacy/photo-1.jpg', status: 'pending', position: 0 }],
  ...overrides
});
const assets = { assets: [{ sourceKey: 'legacy/photo-1.jpg', objectKey: 'ftw/photo-1.jpg', contentHash: 'sha256:abc', mediaType: 'image/jpeg', width: 640, height: 480 }] };

test('plans stable season-scoped listings while preserving source location provenance and tags', () => {
  const first = planFtwImport({ records: [record()], assetManifest: assets, now: 1800000000 });
  const second = planFtwImport({ records: [record()], assetManifest: assets, now: 1900000000 });
  assert.equal(first.listings[0].id, second.listings[0].id);
  assert.equal(first.listings[0].status, 'published');
  assert.equal(first.locations[0].latitude, 27.769);
  assert.equal(first.locations[0].longitude, -82.639);
  assert.equal(JSON.parse(first.listings[0].source_metadata_json).sourceX, 1234.5);
  assert.deepEqual(JSON.parse(first.listings[0].tags_json), ['Lights']);
  assert.deepEqual(JSON.parse(first.listings[0].custom_tags_json), ['paper stars']);
  assert.equal(first.photos[0].status, 'pending');
  assert.equal(first.photos[0].object_key, 'ftw/photo-1.jpg');
  assert.equal(first.photos[0].client_request_id, null);
  assert.equal(first.seasons[0].id, 'halloween-2026');
  assert.equal(first.seasons[0].kind, 'halloween');
  assert.equal(first.seasons[0].name, 'Halloween 2026');
});

test('keeps pending, hidden, rejected, and archived legacy visibility mapped without publication', () => {
  for (const status of ['pending', 'hidden', 'rejected', 'archived']) {
    const plan = planFtwImport({ records: [record({ status, photos: [] })], assetManifest: { assets: [] }, now: 10 });
    assert.equal(plan.listings[0].status, status);
  }
});

test('uses explicit asset manifests and never treats a legacy photo key as a copied object', () => {
  assert.throws(() => planFtwImport({ records: [record({ photos: [] , photo_key: 'old/key.jpg' })], assetManifest: { assets: [] }, now: 1 }), /missing source key old\/key.jpg/);
});

test('keeps photo-only contribution items pending and retains their source grouping metadata', () => {
  const contributionRecord = record({
    photos: [],
    photo_contributions: [{ id: 'contrib-9', payload_hash: 'payload-hash', address: '12 Maple St', created_at: 1700000200,
      items: [{ id: 'item-2', object_key: 'legacy/contributed.jpg', position: 0 }] }]
  });
  const plan = planFtwImport({
    records: [contributionRecord],
    assetManifest: { assets: [{ sourceKey: 'legacy/contributed.jpg', objectKey: 'ftw/contributed.jpg', contentHash: 'sha256:def', mediaType: 'image/jpeg', width: 400, height: 300 }] },
    now: 1800000000
  });
  assert.equal(plan.photos[0].status, 'pending');
  assert.match(plan.photos[0].id, /photo_/);
  const metadata = JSON.parse(plan.photos[0].source_metadata_json);
  assert.equal(metadata.sourceContributionId, 'contrib-9');
  assert.equal(metadata.sourceContributionHash, 'payload-hash');
  assert.equal(metadata.sourceContributionAddress, '12 Maple St');
});

test('maps removed house photos to removed and keeps ambiguous contribution photos pending', () => {
  const plan = planFtwImport({
    records: [record({ photos: undefined, house_photos: [{ id: 'removed-1', object_key: 'legacy/photo-1.jpg', removed_at: 1700000300 }] })],
    assetManifest: assets,
    now: 1800000000
  });
  assert.equal(plan.photos[0].status, 'removed');
  assert.equal(plan.photos[0].removed_at, 1700000300);
});

test('uses explicit season mappings and rejects Christmas metadata without one', () => {
  assert.throws(() => planFtwImport({ records: [record({ season_kind: 'christmas', photos: [] })], assetManifest: { assets: [] }, now: 1 }), /seasonMappings\[2026\] explicitly/);
  const plan = planFtwImport({
    records: [record({ season_kind: 'christmas', season_name: 'Christmas 2026', photos: [] })],
    assetManifest: { assets: [] },
    seasonMappings: { 2026: { id: 'holiday-xmas-2026', kind: 'christmas', year: 2026, name: 'Christmas 2026', config_json: { color: 'red' } } },
    targetRows: [{ id: 'holiday-xmas-2026' }],
    now: 1
  });
  assert.equal(plan.listings[0].season_id, 'holiday-xmas-2026');
  assert.equal(plan.seasons.length, 0);
  assert.equal(plan.source_mappings.find(item => item.entity_type === 'season').canonical_id, 'holiday-xmas-2026');
});

test('uses explicit timestamp units without guessing and retains raw source timestamp values', () => {
  const sourceRecord = record({ photos: [], created_at: 1700000000, updated_at: 1700000100 });
  const milliseconds = planFtwImport({ records: [sourceRecord], assetManifest: { assets: [] }, now: 2000000000000 });
  const seconds = planFtwImport({ records: [sourceRecord], assetManifest: { assets: [] }, timestampUnit: 'seconds', now: 2000000000000 });
  assert.equal(milliseconds.listings[0].created_at, 1700000000);
  assert.equal(seconds.listings[0].created_at, 1700000000000);
  assert.equal(JSON.parse(seconds.source_mappings.find(item => item.entity_type === 'listing').source_snapshot_json).created_at, 1700000000);
});

test('x/y-only approved records require reviewed geography before publication', () => {
  const sourceRecord = record({ address_match: null, photos: [] });
  const unresolved = planFtwImport({ records: [sourceRecord], assetManifest: { assets: [] }, now: 100 });
  assert.equal(unresolved.listings.length, 0);
  assert.equal(unresolved.conflicts[0].reason, 'unresolved_location');
  assert.deepEqual(unresolved.conflicts[0].missing, ['neighborhoodId', 'latitude', 'longitude']);

  const resolved = planFtwImport({
    records: [sourceRecord], assetManifest: { assets: [] },
    locationManifest: { 'legacy-17': { neighborhoodId: 'historic-park-street', latitude: 27.771, longitude: -82.641 } },
    now: 100
  });
  assert.equal(resolved.listings[0].status, 'published');
  assert.equal(resolved.locations[0].neighborhood_id, 'historic-park-street');
  assert.equal(resolved.locations[0].latitude, 27.771);
  assert.equal(resolved.locations[0].longitude, -82.641);
  assert.equal(JSON.parse(resolved.listings[0].source_metadata_json).sourceX, 1234.5);
});

test('skip and target-edit conflict decisions are idempotent and explicit', () => {
  const initial = planFtwImport({ records: [record({ photos: [] })], assetManifest: { assets: [] }, now: 100 });
  const listing = initial.listings[0];
  const mapping = initial.source_mappings.find(row => row.entity_type === 'listing');
  const skip = planFtwImport({ records: [record({ photos: [] })], assetManifest: { assets: [] }, now: 200, existingMappings: [mapping], targetRows: [{ id: listing.id, version: listing.version }] });
  assert.equal(skip.decisions[0].action, 'skip');
  assert.equal(skip.listings.length, 0);
  const conflict = planFtwImport({ records: [record({ photos: [] })], assetManifest: { assets: [] }, now: 200, existingMappings: [mapping], targetRows: [{ id: listing.id, version: listing.version + 1 }] });
  assert.equal(conflict.decisions[0].action, 'conflict');
  assert.equal(conflict.conflicts[0].reason, 'target_changed_since_last_import');
});

test('does not overwrite locally edited locations when source rows are replayed', () => {
  const initial = planFtwImport({ records: [record({ photos: [] })], assetManifest: { assets: [] }, now: 100 });
  const listing = initial.listings[0];
  const location = initial.locations[0];
  const mappings = initial.source_mappings;
  const targetRows = [
    { id: listing.id, version: listing.version },
    { ...location, address_match_json: JSON.parse(location.address_match_json) },
    initial.seasons[0]
  ];
  const replay = planFtwImport({ records: [record({ photos: [] })], assetManifest: { assets: [] }, now: 200, existingMappings: mappings, targetRows });
  assert.equal(replay.decisions.find(item => item.entityType === 'listing').action, 'skip');
  assert.equal(replay.decisions.find(item => item.entityType === 'location').action, 'skip');

  const locallyEditedRows = targetRows.map(row => row.id === location.id ? { ...row, address: '99 Locally Edited St' } : row);
  const conflict = planFtwImport({ records: [record({ photos: [] })], assetManifest: { assets: [] }, now: 200, existingMappings: mappings, targetRows: locallyEditedRows });
  assert.equal(conflict.decisions.find(item => item.entityType === 'listing').action, 'conflict');
  assert.equal(conflict.conflicts.some(item => item.reason === 'target_changed_since_last_import' && item.source.entityType === 'location'), true);
  assert.equal(conflict.locations.length, 0);
});

test('reuses existing canonical IDs for mapped listings and their foreign keys', () => {
  const initial = planFtwImport({ records: [record()], assetManifest: assets, now: 100 });
  const ids = { listing: 'thisway-listing-id', location: 'thisway-location-id', photo: 'thisway-photo-id' };
  const mappings = initial.source_mappings.map(mapping => ({
    ...mapping,
    canonical_id: ids[mapping.entity_type] ?? mapping.canonical_id
  }));
  const rows = [
    { ...initial.seasons[0] },
    { ...initial.locations[0], id: ids.location, address_match_json: JSON.parse(initial.locations[0].address_match_json) },
    { ...initial.listings[0], id: ids.listing, location_id: ids.location },
    { ...initial.photos[0], id: ids.photo, listing_id: ids.listing }
  ];
  const plan = planFtwImport({
    records: [record({ description: 'Source changed safely' })],
    assetManifest: { assets: [{ ...assets.assets[0], contentHash: 'sha256:updated' }] },
    existingMappings: mappings, targetRows: rows, now: 200
  });
  assert.equal(plan.listings[0].id, ids.listing);
  assert.equal(plan.listings[0].location_id, ids.location);
  assert.equal(plan.photos[0].id, ids.photo);
  assert.equal(plan.photos[0].listing_id, ids.listing);
  assert.equal(plan.decisions.find(item => item.entityType === 'photo').canonicalId, ids.photo);
});

test('mapped listings and photos with missing targets conflict instead of recreating under new IDs', () => {
  const initial = planFtwImport({ records: [record()], assetManifest: assets, now: 100 });
  const listingMapping = initial.source_mappings.find(item => item.entity_type === 'listing');
  const listingConflict = planFtwImport({ records: [record()], assetManifest: assets, existingMappings: [listingMapping], targetRows: [], now: 200 });
  assert.equal(listingConflict.listings.length, 0);
  assert.equal(listingConflict.conflicts[0].reason, 'mapped_target_missing');

  const mappings = initial.source_mappings.filter(item => item.entity_type !== 'photo');
  mappings.push(initial.source_mappings.find(item => item.entity_type === 'photo'));
  const rows = [initial.seasons[0], initial.locations[0], initial.listings[0]];
  const photoConflict = planFtwImport({ records: [record()], assetManifest: assets, existingMappings: mappings, targetRows: rows, now: 200 });
  assert.equal(photoConflict.photos.length, 0);
  assert.equal(photoConflict.conflicts.some(item => item.source.entityType === 'photo' && item.reason === 'mapped_target_missing'), true);

  const noListingVersion = planFtwImport({ records: [record({ photos: [] })], assetManifest: { assets: [] }, existingMappings: [listingMapping], targetRows: [{ id: listingMapping.canonical_id }], now: 200 });
  assert.equal(noListingVersion.conflicts[0].reason, 'target_version_missing');

  const photoMapping = initial.source_mappings.find(item => item.entity_type === 'photo');
  const photoMappings = initial.source_mappings.filter(item => item.entity_type !== 'photo').concat(photoMapping);
  const noPhotoVersion = planFtwImport({
    records: [record()], assetManifest: assets, existingMappings: photoMappings,
    targetRows: [initial.seasons[0], initial.locations[0], initial.listings[0], { ...initial.photos[0], version: undefined }], now: 200
  });
  assert.equal(noPhotoVersion.conflicts.some(item => item.source.entityType === 'photo' && item.reason === 'target_version_missing'), true);
});

test('rejects duplicate identities, unsupported statuses, malformed tags, and missing assets', () => {
  assert.throws(() => planFtwImport({ records: [record(), record()], assetManifest: assets, now: 1 }), /duplicate source listing/);
  assert.throws(() => planFtwImport({ records: [record({ status: 'mystery', photos: [] })], assetManifest: { assets: [] }, now: 1 }), /unsupported status/);
  assert.throws(() => planFtwImport({ records: [record({ tags: '{"not":"array"}', photos: [] })], assetManifest: { assets: [] }, now: 1 }), /JSON array/);
  assert.throws(() => planFtwImport({ records: [record()], assetManifest: { assets: [] }, now: 1 }), /asset manifest is missing/);
});
