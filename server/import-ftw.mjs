import { createHash } from 'node:crypto';

const DEFAULT_SOURCE = 'fright-this-way';
const LIMITS = Object.freeze({ records: 500, photos: 2000, bytes: 8 * 1024 * 1024, photosPerListing: 20 });
const LISTING_STATUS = Object.freeze({
  approved: 'published', published: 'published', pending: 'pending',
  hidden: 'hidden', rejected: 'rejected', archived: 'archived'
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function stableId(type, identity) {
  return `${type}_${digest(identity).slice(0, 28)}`;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function sourceSeason(record) {
  const value = record.season_year ?? record.seasonYear ?? record.year;
  if (!Number.isInteger(Number(value)) || Number(value) < 1900 || Number(value) > 2200) {
    throw new TypeError(`record ${record.id ?? '(missing id)'} has an invalid season year`);
  }
  return Number(value);
}

function configuredSeason(year, seasonMappings) {
  const config = seasonMappings instanceof Map ? seasonMappings.get(year) ?? seasonMappings.get(String(year)) : seasonMappings?.[year];
  if (config == null) return { id: `halloween-${year}`, kind: 'halloween', year, name: `Halloween ${year}`, config_json: '{}', explicit: false };
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError(`seasonMappings[${year}] must be an object`);
  const mappedYear = Number(config.year ?? year);
  if (mappedYear !== year) throw new TypeError(`seasonMappings[${year}].year must match ${year}`);
  const rawConfig = config.config_json ?? config.config ?? {};
  return {
    id: requiredString(String(config.id ?? ''), `seasonMappings[${year}].id`),
    kind: requiredString(String(config.kind ?? ''), `seasonMappings[${year}].kind`),
    year,
    name: requiredString(String(config.name ?? ''), `seasonMappings[${year}].name`),
    config_json: typeof rawConfig === 'string' ? (parseJsonObject(rawConfig, `seasonMappings[${year}].config_json`), rawConfig) : canonicalJson(rawConfig),
    explicit: true
  };
}

function parseJsonArray(value, field, fallback = []) {
  if (value == null || value === '') return fallback;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new TypeError(`${field} must be a JSON array`);
  return parsed;
}

function parseJsonObject(value, field) {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError(`${field} must be a JSON object`);
  return parsed;
}

function sourceEpoch(value, fallback, timestampUnit) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError('timestamps must be non-negative integer epoch values');
  const converted = timestampUnit === 'seconds' ? number * 1000 : number;
  if (!Number.isSafeInteger(converted)) throw new TypeError('converted timestamp exceeds the safe integer range');
  return converted;
}

function photoStatus(photo) {
  const removed = photo.removed_at ?? photo.removedAt;
  if (removed != null && removed !== '') return 'removed';
  const rawStatus = String(photo.status ?? (photo.source_contribution_id ? 'pending' : 'approved')).toLowerCase();
  const status = ({ approved: 'approved', published: 'approved', pending: 'pending', rejected: 'rejected', removed: 'removed', hidden: 'removed' })[rawStatus];
  if (!status) throw new TypeError(`photo ${photo.id ?? photo.object_key ?? '(unknown)'} has unsupported status ${rawStatus}`);
  return status;
}

function booleanInteger(value, fallback = 0) {
  if (value == null) return fallback;
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  throw new TypeError('boolean fields must be true/false or 1/0');
}

function positiveVersion(value, fallback = 1) {
  if (value == null) return fallback;
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError('versions must be positive integers');
  return version;
}

function mappingKey(item) {
  return [item.source_system, item.entity_type, item.source_id, item.source_season_id ?? ''].join('\u001f');
}

function normalizeMapping(item) {
  return {
    ...item,
    source_system: item.source_system ?? item.sourceSystem,
    entity_type: item.entity_type ?? item.entityType,
    source_id: String(item.source_id ?? item.sourceId),
    source_season_id: String(item.source_season_id ?? item.sourceSeasonId ?? '')
  };
}

function locationSnapshotMatches(target, snapshot) {
  if (!target || !snapshot) return false;
  let currentMatch = target.address_match_json ?? null;
  if (typeof currentMatch === 'string') {
    try { currentMatch = JSON.parse(currentMatch); } catch { return false; }
  }
  return target.address === snapshot.address
    && (target.neighborhood_id ?? null) === (snapshot.neighborhoodId ?? null)
    && (target.latitude ?? null) === (snapshot.latitude ?? null)
    && (target.longitude ?? null) === (snapshot.longitude ?? null)
    && canonicalJson(currentMatch) === canonicalJson(snapshot.addressMatch ?? null);
}

function locationManifestEntry(manifest, sourceId, seasonYear) {
  if (manifest == null) return null;
  if (manifest instanceof Map) return manifest.get(`${sourceId}:${seasonYear}`) ?? manifest.get(sourceId) ?? null;
  if (Array.isArray(manifest)) {
    const matches = manifest.filter(entry => String(entry.sourceId ?? entry.source_id) === sourceId
      && (entry.seasonYear == null && entry.season_year == null || Number(entry.seasonYear ?? entry.season_year) === seasonYear));
    if (matches.length > 1) throw new TypeError(`locationManifest has duplicate entries for ${sourceId} in ${seasonYear}`);
    return matches[0] ?? null;
  }
  if (typeof manifest !== 'object') throw new TypeError('locationManifest must be an object, Map, or array');
  const entry = manifest[`${sourceId}:${seasonYear}`] ?? manifest[sourceId] ?? null;
  return entry;
}

function parseAssets(assetManifest) {
  const entries = Array.isArray(assetManifest) ? assetManifest : assetManifest?.assets;
  if (!Array.isArray(entries)) throw new TypeError('assetManifest.assets must be an array, including when empty');
  const result = new Map();
  for (const asset of entries) {
    const sourceKey = requiredString(asset.sourceKey ?? asset.source_key, 'asset sourceKey');
    if (result.has(sourceKey)) throw new TypeError(`asset manifest repeats source key ${sourceKey}`);
    const objectKey = requiredString(asset.objectKey ?? asset.object_key, `asset ${sourceKey} objectKey`);
    const contentHash = requiredString(asset.contentHash ?? asset.content_hash, `asset ${sourceKey} contentHash`);
    const mediaType = requiredString(asset.mediaType ?? asset.media_type, `asset ${sourceKey} mediaType`);
    const width = Number(asset.width), height = Number(asset.height);
    if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
      throw new TypeError(`asset ${sourceKey} must have positive integer dimensions`);
    }
    result.set(sourceKey, { object_key: objectKey, content_hash: contentHash, media_type: mediaType, width, height });
  }
  return result;
}

function sourcePhotoRows(record) {
  const rows = [...parseJsonArray(record.photos ?? record.house_photos ?? record.housePhotos, `record ${record.id ?? '(missing id)'} photos`)];
  if (rows.some(photo => !photo || typeof photo !== 'object' || Array.isArray(photo))) {
    throw new TypeError(`record ${record.id ?? '(missing id)'} photos must contain objects`);
  }
  if (!rows.length && record.photo_key) rows.push({
    id: `legacy:${record.photo_key}`, object_key: record.photo_key, photo_key: record.photo_key,
    photo_type: record.photo_type, position: 0, status: 'approved', created_at: record.created_at
  });
  const contributions = parseJsonArray(record.photo_contributions ?? record.photoContributions, `record ${record.id ?? '(missing id)'} photo_contributions`);
  for (const contribution of contributions) {
    if (!contribution || typeof contribution !== 'object' || Array.isArray(contribution)) throw new TypeError('photo contributions must be objects');
    const contributionId = requiredString(String(contribution.id ?? contribution.contribution_id ?? contribution.contributionId ?? ''), 'photo contribution id');
    const items = parseJsonArray(contribution.items ?? contribution.photos, `photo contribution ${contributionId} items`);
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`photo contribution ${contributionId} items must be objects`);
      rows.push({
        ...item,
        id: `contribution:${contributionId}:${String(item.id ?? item.photo_id ?? item.object_key ?? item.objectKey ?? '')}`,
        status: item.status ?? 'pending',
        source_contribution_id: contributionId,
        source_contribution_hash: contribution.payload_hash ?? contribution.payloadHash ?? null,
        source_contribution_address: contribution.address ?? null,
        source_contribution_created_at: contribution.created_at ?? contribution.createdAt ?? null
      });
    }
  }
  if (rows.length > LIMITS.photosPerListing) throw new RangeError(`record ${record.id} exceeds ${LIMITS.photosPerListing} photos`);
  return rows;
}

function planPhoto({ photo, record, sourceSystem, seasonYear, index, assets, listingId, now, timestampUnit }) {
  const sourceKey = String(photo.object_key ?? photo.objectKey ?? photo.photo_key ?? photo.key ?? '');
  const asset = assets.get(sourceKey);
  if (!asset) throw new TypeError(`asset manifest is missing source key ${sourceKey || '(empty)'}`);
  const status = photoStatus(photo);
  const sourceId = String(photo.id ?? sourceKey);
  const identity = { sourceSystem, entityType: 'photo', sourceId, sourceSeasonId: String(seasonYear) };
  const id = stableId('photo', identity);
  const createdAt = sourceEpoch(photo.created_at ?? photo.createdAt, sourceEpoch(photo.source_contribution_created_at, sourceEpoch(record.created_at ?? record.createdAt, now, timestampUnit), timestampUnit), timestampUnit);
  const reviewedAt = sourceEpoch(photo.reviewed_at ?? photo.reviewedAt, null, timestampUnit);
  const removedAt = sourceEpoch(photo.removed_at ?? photo.removedAt, status === 'removed' ? reviewedAt ?? createdAt : null, timestampUnit);
  const snapshot = { ...photo };
  const importSnapshot = { photo: snapshot, resolvedAsset: asset };
  const position = photo.position == null ? index : Number(photo.position);
  if (!Number.isSafeInteger(position) || position < 0) throw new TypeError(`photo ${sourceId} must have a non-negative integer position`);
  const version = positiveVersion(photo.version);
  return {
    row: {
      id, listing_id: listingId, status, client_request_id: null, ...asset,
      position,
      fit: String(photo.fit ?? 'cover'), version, created_at: createdAt,
      reviewed_at: reviewedAt, reviewed_by: photo.reviewed_by ?? photo.reviewedBy ?? null,
      review_reason: photo.review_reason ?? photo.reviewReason ?? null, removed_at: removedAt,
      source_metadata_json: JSON.stringify({ sourceSystem, sourceId, sourceSeasonId: String(seasonYear), sourceVersion: photo.version ?? null, sourceObjectKey: sourceKey, sourceContributionId: photo.source_contribution_id ?? null, sourceContributionHash: photo.source_contribution_hash ?? null, sourceContributionAddress: photo.source_contribution_address ?? null, sourceContributionCreatedAt: photo.source_contribution_created_at ?? null })
    },
    mapping: { source_system: sourceSystem, entity_type: 'photo', source_id: sourceId, source_season_id: String(seasonYear), canonical_id: id, source_version: photo.version == null ? null : String(photo.version), source_checksum: digest(importSnapshot), source_snapshot_json: canonicalJson(importSnapshot) }
  };
}

/**
 * Build an idempotent, deterministic import plan from FTW records and an explicit
 * resource asset manifest. This function performs no I/O and never copies blobs.
 * Existing target rows/mappings are read-only conflict hints supplied by caller.
 */
export function planFtwImport({ sourceSystem = DEFAULT_SOURCE, records, assetManifest, existingMappings = [], targetRows = [], seasonMappings = {}, locationManifest = {}, timestampUnit = 'milliseconds', now = 0 } = {}) {
  sourceSystem = requiredString(sourceSystem, 'sourceSystem');
  if (!Array.isArray(records) || records.length > LIMITS.records) throw new RangeError(`records must be an array of at most ${LIMITS.records}`);
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('now must be a non-negative integer epoch value');
  if (!['milliseconds', 'seconds'].includes(timestampUnit)) throw new TypeError('timestampUnit must be milliseconds or seconds');
  const sourceBytes = Buffer.byteLength(canonicalJson(records), 'utf8');
  if (sourceBytes > LIMITS.bytes) throw new RangeError(`records exceed ${LIMITS.bytes} bytes`);
  const assets = parseAssets(assetManifest);
  const photoCount = records.reduce((sum, record) => sum + sourcePhotoRows(record).length, 0);
  if (photoCount > LIMITS.photos) throw new RangeError(`records exceed ${LIMITS.photos} photos`);

  const mappings = new Map();
  for (const raw of existingMappings) {
    const item = normalizeMapping(raw);
    const key = mappingKey(item);
    if (mappings.has(key)) throw new TypeError(`duplicate existing source mapping ${key}`);
    mappings.set(key, item);
  }
  const targetById = new Map();
  for (const row of targetRows) {
    if (targetById.has(row.id)) throw new TypeError(`duplicate target row ${row.id}`);
    targetById.set(row.id, row);
  }
  // Photo source identities and destination objects are unique across the whole
  // batch, including rows that might later skip or conflict. Do not return a
  // seemingly valid plan that can only fail a photo PK/object-key constraint.
  const seenPhotoListings = new Set(), seenPhotos = new Set(), seenPhotoIds = new Set(), objectOwners = new Map();
  for (const row of targetRows) {
    if (typeof row.object_key !== 'string' || !row.object_key) continue;
    const owner = objectOwners.get(row.object_key);
    if (owner != null && owner !== row.id) throw new TypeError(`duplicate destination photo object key ${row.object_key}`);
    objectOwners.set(row.object_key, row.id);
  }
  for (const record of records) {
    const seasonYear = sourceSeason(record);
    const listingSourceId = requiredString(String(record.id ?? record.source_id ?? ''), 'record id');
    const listingKey = mappingKey({ source_system: sourceSystem, entity_type: 'listing', source_id: listingSourceId, source_season_id: String(seasonYear) });
    if (seenPhotoListings.has(listingKey)) throw new TypeError(`duplicate source listing ${listingSourceId} in season ${seasonYear}`);
    seenPhotoListings.add(listingKey);
    for (const photo of sourcePhotoRows(record)) {
      const sourceKey = String(photo.object_key ?? photo.objectKey ?? photo.photo_key ?? photo.key ?? '');
      const sourceId = String(photo.id ?? sourceKey);
      const identity = { sourceSystem, entityType: 'photo', sourceId, sourceSeasonId: String(seasonYear) };
      const key = mappingKey({ source_system: sourceSystem, entity_type: 'photo', source_id: sourceId, source_season_id: String(seasonYear) });
      if (seenPhotos.has(key)) throw new TypeError(`duplicate source photo ${sourceId} in season ${seasonYear}`);
      seenPhotos.add(key);
      const id = requiredString(String(mappings.get(key)?.canonical_id ?? stableId('photo', identity)), 'canonical photo id');
      if (seenPhotoIds.has(id)) throw new TypeError(`duplicate canonical photo ${id}`);
      seenPhotoIds.add(id);
      const asset = assets.get(sourceKey);
      if (!asset) throw new TypeError(`asset manifest is missing source key ${sourceKey || '(empty)'}`);
      const owner = objectOwners.get(asset.object_key);
      if (owner != null && owner !== id) throw new TypeError(`duplicate destination photo object key ${asset.object_key}`);
      objectOwners.set(asset.object_key, id);
    }
  }
  const output = { seasons: [], locations: [], listings: [], photos: [], source_mappings: [], decisions: [], conflicts: [] };
  const seen = new Set();
  const emittedMappingKeys = new Set();
  const emittedSeasonIds = new Set();

  for (const record of records) {
    const sourceId = requiredString(String(record.id ?? record.source_id ?? ''), 'record id');
    const seasonYear = sourceSeason(record);
    const seasonSourceId = String(record.season_id ?? record.seasonId ?? `halloween-${seasonYear}`);
    const seasonConfig = configuredSeason(seasonYear, seasonMappings);
    const explicitSourceKind = String(record.season_kind ?? record.seasonKind ?? '').toLowerCase();
    const seasonLabel = String(record.season_name ?? record.seasonName ?? '').toLowerCase();
    if (!seasonConfig.explicit && (explicitSourceKind && explicitSourceKind !== 'halloween' || /christmas|xmas|winter/.test(`${seasonSourceId.toLowerCase()} ${seasonLabel}`))) {
      throw new TypeError(`record ${sourceId} has non-Halloween season metadata; supply seasonMappings[${seasonYear}] explicitly`);
    }
    const seasonIdentity = { sourceSystem, entityType: 'season', sourceId: seasonSourceId, sourceSeasonId: '' };
    const listingIdentity = { sourceSystem, entityType: 'listing', sourceId, sourceSeasonId: String(seasonYear) };
    const locationIdentity = { sourceSystem, entityType: 'location', sourceId, sourceSeasonId: String(seasonYear) };
    const identityKey = mappingKey({ source_system: sourceSystem, entity_type: 'listing', source_id: sourceId, source_season_id: String(seasonYear) });
    const locationMappingKey = mappingKey({ source_system: sourceSystem, entity_type: 'location', source_id: sourceId, source_season_id: String(seasonYear) });
    const seasonMappingKey = mappingKey({ source_system: sourceSystem, entity_type: 'season', source_id: seasonSourceId, source_season_id: '' });
    const existingListingMapping = mappings.get(identityKey);
    const locationMapping = mappings.get(locationMappingKey);
    const existingSeasonMapping = mappings.get(seasonMappingKey);
    if (existingSeasonMapping && seasonConfig.explicit && existingSeasonMapping.canonical_id !== seasonConfig.id) {
      output.conflicts.push({ source: { sourceSystem, entityType: 'season', sourceId: seasonSourceId }, canonicalId: existingSeasonMapping.canonical_id, reason: 'explicit_season_mapping_disagrees_with_existing_mapping', requestedCanonicalId: seasonConfig.id });
      output.decisions.push({ entityType: 'season', sourceId: seasonSourceId, seasonYear, canonicalId: existingSeasonMapping.canonical_id, action: 'conflict' });
      continue;
    }
    const seasonId = requiredString(String(existingSeasonMapping?.canonical_id ?? seasonConfig.id), 'canonical season id');
    const listingId = requiredString(String(existingListingMapping?.canonical_id ?? stableId('listing', listingIdentity)), 'canonical listing id');
    const locationId = requiredString(String(locationMapping?.canonical_id ?? stableId('location', locationIdentity)), 'canonical location id');
    if (seen.has(identityKey)) throw new TypeError(`duplicate source listing ${sourceId} in season ${seasonYear}`);
    seen.add(identityKey);

    const address = requiredString(record.address, `record ${sourceId} address`);
    const statusSource = String(record.status ?? 'pending').toLowerCase();
    const status = LISTING_STATUS[statusSource];
    if (!status) throw new TypeError(`record ${sourceId} has unsupported status ${statusSource}`);
    const sourceSnapshot = { ...record };
    const sourceChecksum = digest(sourceSnapshot);
    const createdAt = sourceEpoch(record.created_at ?? record.createdAt, now, timestampUnit);
    const updatedAt = sourceEpoch(record.updated_at ?? record.updatedAt, createdAt, timestampUnit);
    const reviewedAt = sourceEpoch(record.reviewed_at ?? record.reviewedAt, null, timestampUnit);
    const addressMatch = parseJsonObject(record.address_match ?? record.addressMatch, `record ${sourceId} address_match`);
    const locationOverride = locationManifestEntry(locationManifest, sourceId, seasonYear);
    if (locationOverride != null && (!locationOverride || typeof locationOverride !== 'object' || Array.isArray(locationOverride))) throw new TypeError(`location manifest entry for ${sourceId} must be an object`);
    const neighborhoodId = locationOverride?.neighborhoodId ?? locationOverride?.neighborhood_id ?? addressMatch?.neighborhoodId ?? addressMatch?.neighborhood_id ?? null;
    const latitudeValue = locationOverride?.latitude ?? record.latitude ?? addressMatch?.latitude;
    const longitudeValue = locationOverride?.longitude ?? record.longitude ?? addressMatch?.longitude;
    const latitude = latitudeValue == null ? null : Number(latitudeValue);
    const longitude = longitudeValue == null ? null : Number(longitudeValue);
    if (latitude != null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) throw new TypeError(`record ${sourceId} has invalid latitude`);
    if (longitude != null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) throw new TypeError(`record ${sourceId} has invalid longitude`);
    const tags = parseJsonArray(record.tags, `record ${sourceId} tags`);
    const customTags = parseJsonArray(record.custom_tags ?? record.customTags, `record ${sourceId} custom_tags`);
    const sourceVersion = record.version == null ? null : String(record.version);
    const seasonSnapshot = { id: seasonSourceId, year: seasonYear };
    const seasonChecksum = digest(seasonSnapshot);
    const listing = {
      id: listingId, location_id: locationId, season_id: seasonId,
      title: String(record.theme ?? record.title ?? ''), description: String(record.description ?? ''),
      tags_json: canonicalJson(tags), custom_tags_json: canonicalJson(customTags),
      level: Number.isInteger(Number(record.level)) && Number(record.level) >= 0 && Number(record.level) <= 3 ? Number(record.level) : 0,
      featured: record.featured == null ? null : booleanInteger(record.featured),
      sharing_consent: booleanInteger(record.sharing_consent ?? record.sharingConsent), status,
      version: positiveVersion(record.version),
      approval_method: record.approval_method ?? record.approvalMethod ?? null,
      created_at: createdAt, updated_at: updatedAt, reviewed_at: reviewedAt,
      reviewed_by: record.reviewed_by ?? record.reviewedBy ?? null,
      review_reason: record.review_reason ?? record.reviewReason ?? null,
      client_request_id: null, payload_hash: record.payload_hash ?? record.payloadHash ?? null,
      source_metadata_json: canonicalJson({ sourceSystem, sourceId, sourceSeasonId: String(seasonYear), sourceVersion, sourceStatus: statusSource, sourceX: record.x ?? null, sourceY: record.y ?? null, sourcePhotoKey: record.photo_key ?? null, sourcePhotoType: record.photo_type ?? null, sourceAddressMatch: addressMatch })
    };
    const { explicit: _explicitSeasonConfig, ...season } = seasonConfig;
    season.id = seasonId;
    const location = {
      id: locationId, neighborhood_id: neighborhoodId, address,
      latitude, longitude,
      address_match_json: addressMatch == null ? null : canonicalJson(addressMatch),
      created_at: createdAt, updated_at: updatedAt
    };

    const entities = [
      { entity_type: 'season', source_id: seasonSourceId, source_season_id: '', canonical_id: seasonId, source_version: null, source_checksum: seasonChecksum, source_snapshot_json: canonicalJson(seasonSnapshot), row: season },
      { entity_type: 'location', source_id: sourceId, source_season_id: String(seasonYear), canonical_id: locationId, source_version: sourceVersion, source_checksum: digest({ address, addressMatch, locationOverride, x: record.x ?? null, y: record.y ?? null, latitude, longitude, neighborhoodId }), source_snapshot_json: canonicalJson({ address, addressMatch, locationOverride, neighborhoodId, latitude, longitude, x: record.x ?? null, y: record.y ?? null }), row: location },
      { entity_type: 'listing', source_id: sourceId, source_season_id: String(seasonYear), canonical_id: listingId, source_version: sourceVersion, source_checksum: sourceChecksum, source_snapshot_json: canonicalJson(sourceSnapshot), row: listing }
    ];

    let listingAction = 'insert';
    if (existingListingMapping) {
      const target = targetById.get(existingListingMapping.canonical_id);
      const targetVersion = target?.version ?? null;
      const importedVersion = existingListingMapping.last_imported_version ?? null;
      if (!target) {
        output.conflicts.push({ source: { sourceSystem, entityType: 'listing', sourceId, seasonYear }, canonicalId: existingListingMapping.canonical_id, reason: 'mapped_target_missing' });
        listingAction = 'conflict';
      } else if (targetVersion == null || importedVersion == null) {
        output.conflicts.push({ source: { sourceSystem, entityType: 'listing', sourceId, seasonYear }, canonicalId: existingListingMapping.canonical_id, reason: 'target_version_missing', expectedTargetVersion: importedVersion, actualTargetVersion: targetVersion });
        listingAction = 'conflict';
      } else if (existingListingMapping.source_checksum === sourceChecksum && targetVersion === importedVersion) listingAction = 'skip';
      else if (targetVersion !== importedVersion) {
        output.conflicts.push({ source: { sourceSystem, entityType: 'listing', sourceId, seasonYear }, canonicalId: existingListingMapping.canonical_id, reason: 'target_changed_since_last_import', expectedTargetVersion: importedVersion, actualTargetVersion: targetVersion, existingChecksum: existingListingMapping.source_checksum, incomingChecksum: sourceChecksum });
        listingAction = 'conflict';
      } else listingAction = 'update';
    } else if (targetById.has(listingId)) {
      output.conflicts.push({ source: { sourceSystem, entityType: 'listing', sourceId, seasonYear }, canonicalId: listingId, reason: 'canonical_id_exists_without_source_mapping' });
      listingAction = 'conflict';
    }

    const hasUsableGeography = typeof neighborhoodId === 'string' && neighborhoodId.trim().length > 0
      && latitude != null && longitude != null;
    if (status === 'published' && !hasUsableGeography) {
      output.conflicts.push({ source: { sourceSystem, entityType: 'listing', sourceId, seasonYear }, canonicalId: listingId, reason: 'unresolved_location', missing: [
        ...(typeof neighborhoodId !== 'string' || !neighborhoodId.trim() ? ['neighborhoodId'] : []),
        ...(latitude == null ? ['latitude'] : []), ...(longitude == null ? ['longitude'] : [])
      ] });
      listingAction = 'conflict';
    }

    const seasonMapping = existingSeasonMapping;
    let seasonAction = 'insert';
    if (seasonMapping) {
      if (!targetById.has(seasonMapping.canonical_id)) {
        output.conflicts.push({ source: { sourceSystem, entityType: 'season', sourceId: seasonSourceId }, canonicalId: seasonMapping.canonical_id, reason: 'mapped_target_missing' });
        seasonAction = 'conflict';
        listingAction = 'conflict';
      } else seasonAction = 'skip'; // Season configuration is owner-managed after its first import.
    } else if (seasonConfig.explicit) {
      if (!targetById.has(seasonId)) {
        output.conflicts.push({ source: { sourceSystem, entityType: 'season', sourceId: seasonSourceId }, canonicalId: seasonId, reason: 'explicit_season_target_missing' });
        seasonAction = 'conflict';
        listingAction = 'conflict';
      } else seasonAction = 'mapped';
    } else if (targetById.has(seasonId)) {
      output.conflicts.push({ source: { sourceSystem, entityType: 'season', sourceId: seasonSourceId }, canonicalId: seasonId, reason: 'canonical_id_exists_without_source_mapping' });
      seasonAction = 'conflict';
      listingAction = 'conflict';
    }

    const locationSnapshot = JSON.parse(entities[1].source_snapshot_json);
    let locationAction = 'insert';
    if (locationMapping) {
      const targetLocation = targetById.get(locationMapping.canonical_id);
      let previousSnapshot = null;
      try { previousSnapshot = JSON.parse(locationMapping.source_snapshot_json); } catch { /* malformed mapping is a conflict */ }
      if (!targetLocation) {
        output.conflicts.push({ source: { sourceSystem, entityType: 'location', sourceId, seasonYear }, canonicalId: locationMapping.canonical_id, reason: 'mapped_target_missing' });
        locationAction = 'conflict';
        listingAction = 'conflict';
      } else if (!locationSnapshotMatches(targetLocation, previousSnapshot)) {
        output.conflicts.push({ source: { sourceSystem, entityType: 'location', sourceId, seasonYear }, canonicalId: locationMapping.canonical_id, reason: 'target_changed_since_last_import', existingChecksum: locationMapping.source_checksum, incomingChecksum: entities[1].source_checksum });
        locationAction = 'conflict';
        listingAction = 'conflict';
      } else if (locationMapping.source_checksum === entities[1].source_checksum) locationAction = 'skip';
      else locationAction = 'update';
    } else if (targetById.has(locationId)) {
      output.conflicts.push({ source: { sourceSystem, entityType: 'location', sourceId, seasonYear }, canonicalId: locationId, reason: 'canonical_id_exists_without_source_mapping' });
      locationAction = 'conflict';
      listingAction = 'conflict';
    }

    output.decisions.push({ entityType: 'listing', sourceId, seasonYear, canonicalId: listingId, sourceStatus: statusSource, visibility: status, action: listingAction, checksum: sourceChecksum });
    output.decisions.push({ entityType: 'season', sourceId: seasonSourceId, seasonYear, canonicalId: seasonId, action: seasonAction, checksum: seasonChecksum });
    output.decisions.push({ entityType: 'location', sourceId, seasonYear, canonicalId: locationId, action: locationAction, checksum: entities[1].source_checksum });
    if (listingAction !== 'conflict') {
      if (seasonAction === 'insert' && !emittedSeasonIds.has(season.id)) {
        emittedSeasonIds.add(season.id);
        output.seasons.push(season);
      }
      if (locationAction === 'insert' || locationAction === 'update') output.locations.push(location);
      if (listingAction !== 'skip') output.listings.push(listing);
      for (const entity of entities) {
        if (entity.entity_type === 'listing' && listingAction === 'skip') continue;
        if (entity.entity_type === 'season' && seasonAction !== 'insert' && seasonAction !== 'mapped') continue;
        if (entity.entity_type === 'location' && locationAction !== 'insert' && locationAction !== 'update') continue;
        const mapping = {
          source_system: sourceSystem, entity_type: entity.entity_type, source_id: entity.source_id,
          source_season_id: entity.source_season_id, canonical_id: entity.canonical_id,
          source_version: entity.source_version, source_checksum: entity.source_checksum,
          source_snapshot_json: entity.source_snapshot_json,
          last_imported_version: entity.entity_type === 'listing' ? listing.version : 1,
          imported_at: now
        };
        if (!emittedMappingKeys.has(mappingKey(mapping))) {
          emittedMappingKeys.add(mappingKey(mapping));
          output.source_mappings.push(mapping);
        }
      }
    }

    if (listingAction !== 'conflict') {
      const photos = sourcePhotoRows(record);
      photos.forEach((photo, index) => {
        const planned = planPhoto({ photo, record, sourceSystem, seasonYear, index, assets, listingId, now, timestampUnit });
        const photoMapKey = mappingKey(planned.mapping);
        const existingPhotoMapping = mappings.get(photoMapKey);
        if (existingPhotoMapping) {
          planned.row.id = requiredString(String(existingPhotoMapping.canonical_id), 'mapped canonical photo id');
          planned.mapping.canonical_id = planned.row.id;
        }
        const targetPhoto = existingPhotoMapping ? targetById.get(existingPhotoMapping.canonical_id) : targetById.get(planned.row.id);
        let photoAction = 'insert';
        if (existingPhotoMapping) {
          const expectedVersion = existingPhotoMapping.last_imported_version ?? null;
          const actualVersion = targetPhoto?.version ?? null;
          if (!targetPhoto) {
            output.conflicts.push({ source: { sourceSystem, entityType: 'photo', sourceId: planned.mapping.source_id, seasonYear }, canonicalId: existingPhotoMapping.canonical_id, reason: 'mapped_target_missing' });
            photoAction = 'conflict';
          } else if (expectedVersion == null || actualVersion == null) {
            output.conflicts.push({ source: { sourceSystem, entityType: 'photo', sourceId: planned.mapping.source_id, seasonYear }, canonicalId: existingPhotoMapping.canonical_id, reason: 'target_version_missing', expectedTargetVersion: expectedVersion, actualTargetVersion: actualVersion });
            photoAction = 'conflict';
          } else if (existingPhotoMapping.source_checksum === planned.mapping.source_checksum && actualVersion === expectedVersion) photoAction = 'skip';
          else if (actualVersion !== expectedVersion) {
            output.conflicts.push({ source: { sourceSystem, entityType: 'photo', sourceId: planned.mapping.source_id, seasonYear }, canonicalId: existingPhotoMapping.canonical_id, reason: 'target_changed_since_last_import', expectedTargetVersion: expectedVersion, actualTargetVersion: actualVersion, existingChecksum: existingPhotoMapping.source_checksum, incomingChecksum: planned.mapping.source_checksum });
            photoAction = 'conflict';
          } else photoAction = 'update';
        } else if (targetPhoto) {
          output.conflicts.push({ source: { sourceSystem, entityType: 'photo', sourceId: planned.mapping.source_id, seasonYear }, canonicalId: planned.row.id, reason: 'canonical_id_exists_without_source_mapping' });
          photoAction = 'conflict';
        }
        output.decisions.push({ entityType: 'photo', sourceId: planned.mapping.source_id, seasonYear, canonicalId: planned.row.id, sourceStatus: planned.row.status, action: photoAction, checksum: planned.mapping.source_checksum });
        if (photoAction === 'skip' || photoAction === 'conflict') return;
        output.photos.push(planned.row);
        const mapping = { source_system: sourceSystem, ...planned.mapping, last_imported_version: planned.row.version, imported_at: now };
        if (!emittedMappingKeys.has(mappingKey(mapping))) {
          emittedMappingKeys.add(mappingKey(mapping));
          output.source_mappings.push(mapping);
        }
      });
    }
  }

  return output;
}

export const ftwImportLimits = LIMITS;
