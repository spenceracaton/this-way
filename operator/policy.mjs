export const OPERATOR_POLICY = Object.freeze({
  version: 1,
  contract: 'ftw-operator-v1',
  sourceSystem: 'fright-this-way',
  seasonYear: 2026,
  seasonId: 'halloween-2026',
  neighborhoods: Object.freeze(['old-northeast', 'crescent-lake']),
  maxRecords: 10,
  maxPhotos: 20,
  maxCommandBytes: 256 * 1024,
  maxRequestBytes: 8 * 1024 * 1024,
  maxAssetBytes: 6 * 1024 * 1024,
  maxTtlMs: 15 * 60 * 1000
});

export function assertPilotScope(input, sourceEvidence) {
  const fail = message => { throw new TypeError(message); };
  if (!input || input.sourceSystem !== OPERATOR_POLICY.sourceSystem || !Array.isArray(input.records) || input.records.length < 1 || input.records.length > OPERATOR_POLICY.maxRecords) fail('command is outside the approved pilot scope');
  if (!sourceEvidence || sourceEvidence.operatorContract !== OPERATOR_POLICY.contract) fail('command lacks the operator source contract');
  let photos = 0;
  for (const record of input.records) {
    if (Number(record.season_year ?? record.seasonYear) !== OPERATOR_POLICY.seasonYear) fail('record season is outside the approved pilot scope');
    if (String(record.status || '').toLowerCase() !== 'approved') fail('record source status is outside the approved pilot scope');
    if (!Array.isArray(record.photos) || record.photo_key || record.photoKey || record.house_photos !== undefined || record.housePhotos !== undefined || record.photoContributions !== undefined) fail('record photo fields are outside the curated pilot format');
    if (Array.isArray(record.photo_contributions) && record.photo_contributions.length) fail('photo contributions are outside the curated pilot scope');
    if (record.photo_contributions !== undefined && !Array.isArray(record.photo_contributions)) fail('photo contributions must be an array');
    photos += record.photos.length;
    for (const photo of record.photos) {
      if (!photo || String(photo.status || '').toLowerCase() !== 'approved' || photo.removed_at != null || photo.removedAt != null) fail('photo source status is outside the approved pilot scope');
    }
    const manifest = input.locationManifest || {};
    const mapped = manifest[`${record.id}:${record.season_year ?? record.seasonYear}`] ?? manifest[record.id];
    let addressMatch = record.address_match ?? record.addressMatch;
    if (typeof addressMatch === 'string') {
      try { addressMatch = JSON.parse(addressMatch); } catch { fail('record address match is invalid'); }
    }
    const neighborhood = mapped?.neighborhoodId ?? mapped?.neighborhood_id ?? addressMatch?.neighborhoodId ?? addressMatch?.neighborhood_id ?? record.neighborhood_id;
    if (!OPERATOR_POLICY.neighborhoods.includes(neighborhood)) fail('record location is outside the approved pilot scope');
  }
  if (photos > OPERATOR_POLICY.maxPhotos) fail('command exceeds the approved photo limit');
}

export function assertCheckpointScope(checkpoint) {
  const fail = message => { throw new TypeError(message); };
  const artifact = checkpoint?.artifact;
  if (!artifact || artifact.sourceSystem !== OPERATOR_POLICY.sourceSystem || artifact.sourceEvidence?.operatorContract !== OPERATOR_POLICY.contract) fail('checkpoint is outside the approved pilot scope');
  assertPilotScope(artifact.input, artifact.sourceEvidence);
  if (artifact.input.records.some(r => Number(r.season_year ?? r.seasonYear) !== OPERATOR_POLICY.seasonYear)) fail('checkpoint season is outside the approved pilot scope');
  const ops = artifact.ops || [];
  if (ops.some(op => op.kind === 'update')) fail('checkpoint contains an update outside the approved pilot policy');
  if (ops.some(op => op.kind !== 'insert' && op.kind !== 'update')) fail('checkpoint operation is outside the approved pilot policy');
  for (const op of ops.filter(op => op.table === 'seasons')) {
    if (op.kind !== 'insert' || op.after?.id !== OPERATOR_POLICY.seasonId || op.after?.kind !== 'halloween' || op.after?.year !== OPERATOR_POLICY.seasonYear || op.after?.name !== 'Halloween 2026') fail('checkpoint season is outside the approved pilot policy');
  }
  const scopedLocations = new Set(OPERATOR_POLICY.neighborhoods);
  for (const row of artifact.plan?.locations || []) if (!scopedLocations.has(row.neighborhood_id)) fail('checkpoint location is outside the approved pilot scope');
  for (const row of artifact.plan?.listings || []) if (row.status !== 'published' || row.season_id !== OPERATOR_POLICY.seasonId) fail('checkpoint target listing is outside the approved pilot scope');
  for (const row of artifact.plan?.photos || []) if (!['approved', 'published'].includes(String(row.status).toLowerCase())) fail('checkpoint photo is outside the approved pilot scope');
  if ((artifact.plan?.photos || []).length > OPERATOR_POLICY.maxPhotos) fail('checkpoint exceeds the approved photo limit');
  return checkpoint;
}
