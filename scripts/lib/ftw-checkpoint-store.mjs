import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sanitizeImage } from '../../server/image.mjs';
import { planFtwImport } from '../../server/import-ftw.mjs';

const TABLES = ['seasons', 'locations', 'listings', 'photos', 'source_mappings'];
const COLUMNS = {
  seasons: ['id','kind','year','name','config_json'],
  locations: ['id','neighborhood_id','address','latitude','longitude','address_match_json','created_at','updated_at'],
  listings: ['id','location_id','season_id','title','description','tags_json','custom_tags_json','level','featured','sharing_consent','status','version','approval_method','created_at','updated_at','reviewed_at','reviewed_by','review_reason','client_request_id','payload_hash','source_metadata_json'],
  photos: ['id','listing_id','status','client_request_id','object_key','content_hash','media_type','width','height','position','fit','version','created_at','reviewed_at','reviewed_by','review_reason','removed_at','source_metadata_json'],
  source_mappings: ['source_system','entity_type','source_id','source_season_id','canonical_id','source_version','source_checksum','source_snapshot_json','last_imported_version','imported_at']
};
const LIMITS = { records: 25, photos: 100, rows: 1000, jsonBytes: 768 * 1024, statements: 250 };
const fail = message => { throw new TypeError(message); };
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha = value => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : canonical(value)).digest('hex');

async function readTables(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') fail('a D1 database with batch support is required');
  const results = await db.batch(TABLES.map(t => db.prepare(`SELECT * FROM ${t} ORDER BY ${t === 'source_mappings' ? 'source_system,entity_type,source_id,source_season_id' : 'id'} LIMIT ${LIMITS.rows + 1}`)));
  const snapshot = Object.fromEntries(TABLES.map((t, i) => [t, results[i].results || []]));
  if (flatRows(snapshot).length > LIMITS.rows) fail('target exceeds checkpoint row limit');
  return snapshot;
}
const flatRows = tables => TABLES.flatMap(t => tables[t]);
const mappingList = tables => tables.source_mappings;
function assertBounds(input, baseline) {
  if (!input || !Array.isArray(input.records) || !input.records.length || input.records.length > LIMITS.records) fail(`records must contain 1-${LIMITS.records} records`);
  if (input.sourceSystem === 'ftw-public-pilot' || !input.sourceSystem || !input.assetManifest || !Array.isArray(input.assetManifest.assets)) fail('an explicit non-pilot sourceSystem and asset manifest are required');
  if (['existingMappings','targetRows','now'].some(k => Object.hasOwn(input, k))) fail('input cannot override planner target snapshots or timestamp');
  if (flatRows(baseline).length > LIMITS.rows) fail('target exceeds checkpoint row limit');
  if (Buffer.byteLength(canonical(baseline)) > LIMITS.jsonBytes) fail('target snapshot exceeds checkpoint size limit');
  const photos = input.records.reduce((n, r) => n + (Array.isArray(r.photos) ? r.photos.length : 0), 0);
  if (photos > LIMITS.photos) fail('input exceeds checkpoint photo limit');
}

function assertOperationLimits(plan, ops) {
  if (plan.decisions.filter(decision => decision.entityType === 'photo').length > LIMITS.photos) fail('input exceeds checkpoint photo limit');
  const insertedEntities = ops.filter(op => op.kind === 'insert' && ['listings', 'photos'].includes(op.table)).length;
  const updatedEntities = ops.filter(op => op.kind === 'update' && ['listings', 'photos'].includes(op.table)).length;
  // Five snapshot assertions, one ledger assertion, one state write and cleanup.
  // Restore also checks inserted entities' history and advances restored versions/mappings.
  if (8 + ops.length + insertedEntities + 2 * updatedEntities > LIMITS.statements) fail('checkpoint exceeds D1 statement limit');
}
function normalizePlanVersions(plan, baseline) {
  const old = new Map(baseline.photos.concat(baseline.listings).map(r => [r.id, r]));
  for (const table of ['listings', 'photos']) for (const row of plan[table]) {
    const prior = old.get(row.id);
    if (prior) row.version = Math.max(Number(row.version) || 1, Number(prior.version) + 1);
  }
  const updated = new Map(plan.listings.concat(plan.photos).map(r => [r.id, r.version]));
  for (const m of plan.source_mappings) if (updated.has(m.canonical_id)) m.last_imported_version = updated.get(m.canonical_id);
}

function buildOperations(plan, baseline) {
  const ops = [];
  for (const table of TABLES) for (const row of plan[table]) {
    const old = table === 'source_mappings' ? baseline.source_mappings.find(m => m.source_system === row.source_system && m.entity_type === row.entity_type && m.source_id === row.source_id && m.source_season_id === row.source_season_id) : baseline[table].find(prior => prior.id === row.id);
    if (table === 'seasons' && old) continue; // Explicitly owner-managed.
    if (table === 'source_mappings' && old) ops.push({ table, kind: 'update', before: old, after: row });
    else if (old) ops.push({ table, kind: 'update', before: old, after: row });
    else ops.push({ table, kind: 'insert', before: null, after: row });
  }
  return ops;
}

function sqliteValue(v) { return v === undefined ? null : v; }
function insertSql(db, table, row) {
  const cols = COLUMNS[table];
  return db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).bind(...cols.map(c => sqliteValue(row[c])));
}
function updateSql(db, table, row) {
  const cols = COLUMNS[table].filter(c => !(table === 'source_mappings' && ['source_system','entity_type','source_id','source_season_id'].includes(c)) && !(table !== 'source_mappings' && c === 'id'));
  const keys = table === 'source_mappings' ? ['source_system','entity_type','source_id','source_season_id'] : ['id'];
  return db.prepare(`UPDATE ${table} SET ${cols.map(c => `${c}=?`).join(',')} WHERE ${keys.map(k => `${k}=?`).join(' AND ')}`).bind(...cols.map(c => sqliteValue(row[c])), ...keys.map(k => row[k]));
}

function guardBatch(db, snapshot, id, prefix, checkpoint) {
  const guard = [];
  for (const table of TABLES) {
    const rows = snapshot[table];
    const keys = table === 'source_mappings' ? ['source_system','entity_type','source_id','source_season_id'] : ['id'];
    const identity = keys.map(k => `t.${k}=json_extract(e.value,'$.${k}')`).join(' AND ');
    const eq = COLUMNS[table].map(c => `t.${c} IS json_extract(e.value,'$.${c}')`).join(' AND ');
    const sql = `INSERT INTO ftw_import_guard_assertions(assertion_id,ok) SELECT ?, CASE WHEN (SELECT count(*) FROM ${table})=? AND NOT EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (SELECT 1 FROM ${table} t WHERE ${identity} AND ${eq})) THEN 1 ELSE 0 END`;
    guard.push(db.prepare(sql).bind(`${prefix}:${id}:${table}`, rows.length, canonical(rows)));
  }
  guard.push(db.prepare("INSERT INTO ftw_import_guard_assertions(assertion_id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM ftw_import_checkpoints WHERE id=? AND state=? AND artifact_hash=? AND artifact_json=?) THEN 1 ELSE 0 END").bind(`${prefix}:${id}:state`, id, prefix === 'apply' ? 'prepared' : 'applied', checkpoint.artifact_hash, checkpoint.artifact_json));
  return guard;
}

function cleanupGuards(db, id, prefix) { return db.prepare('DELETE FROM ftw_import_guard_assertions WHERE assertion_id LIKE ?').bind(`${prefix}:${id}:%`); }

export async function prepareFtwCheckpoint({ db, input, sourceEvidence = null, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) fail('now must be a non-negative safe integer epoch value');
  const baseline = await readTables(db);
  assertBounds(input, baseline);
  const plan = planFtwImport({ ...input, existingMappings: mappingList(baseline), targetRows: ['seasons','locations','listings','photos'].flatMap(t => baseline[t]), now });
  if (plan.conflicts.length) fail(`planner found ${plan.conflicts.length} conflict(s)`);
  normalizePlanVersions(plan, baseline);
  const ops = buildOperations(plan, baseline);
  assertOperationLimits(plan, ops);
  const artifact = { version: 1, plannerContract: 'ftw-plan-v1', schemaContract: 'this-way-content-v1-checkpoints-v1', sourceSystem: input.sourceSystem, input, sourceEvidence, baseline, plan, ops, createdAt: now };
  if (Buffer.byteLength(canonical(artifact)) > LIMITS.jsonBytes) fail('checkpoint artifact exceeds size limit');
  const id = `ftw_${sha(artifact).slice(0, 32)}`;
  const artifactJson = canonical(artifact), artifactHash = sha(artifactJson);
  await db.prepare("INSERT OR IGNORE INTO ftw_import_checkpoints(id,artifact_hash,state,artifact_json,created_at) VALUES(?,?,'prepared',?,?)").bind(id, artifactHash, artifactJson, now).run();
  const saved = await readFtwCheckpoint(db, id);
  if (!saved || saved.artifact_hash !== artifactHash) fail('checkpoint identity collision');
  return saved;
}

function rederive(artifact) {
  if (artifact.version !== 1 || artifact.plannerContract !== 'ftw-plan-v1' || artifact.schemaContract !== 'this-way-content-v1-checkpoints-v1') fail('unsupported checkpoint contract');
  const baseline = artifact.baseline, input = artifact.input;
  assertBounds(input, baseline);
  const plan = planFtwImport({ ...input, existingMappings: mappingList(baseline), targetRows: ['seasons','locations','listings','photos'].flatMap(t => baseline[t]), now: artifact.createdAt });
  if (plan.conflicts.length) fail('checkpoint replan now contains conflicts');
  normalizePlanVersions(plan, baseline);
  const ops = buildOperations(plan, baseline);
  assertOperationLimits(plan, ops);
  return { plan, ops };
}
export async function readFtwCheckpoint(db, id) {
  const row = await db.prepare('SELECT * FROM ftw_import_checkpoints WHERE id=?').bind(id).first();
  if (!row) return null;
  let artifact;
  try { artifact = JSON.parse(row.artifact_json); } catch { fail('checkpoint artifact is corrupt'); }
  if (sha(canonical(artifact)) !== row.artifact_hash || `ftw_${row.artifact_hash.slice(0, 32)}` !== row.id) fail('checkpoint artifact hash or id is invalid');
  const derived = rederive(artifact);
  if (canonical(derived.plan) !== canonical(artifact.plan) || canonical(derived.ops) !== canonical(artifact.ops)) fail('checkpoint operations do not match the stored input and baseline');
  return { ...row, artifact };
}

async function validatedAssets(bucket, plan, assets) {
  if (!bucket || typeof bucket.get !== 'function' || typeof bucket.put !== 'function') fail('an R2 bucket is required');
  if (!Array.isArray(assets)) fail('assets must be an array');
  const byKey = new Map(assets.map(a => [a.objectKey, a.bytes]));
  if (byKey.size !== assets.length || plan.photos.some(p => !byKey.has(p.object_key))) fail('asset bytes must cover every planned photo');
  const valid = [];
  const suffix = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  for (const p of plan.photos) {
    const bytes = byKey.get(p.object_key);
    if (!(bytes instanceof Uint8Array) || `sha256:${sha(bytes)}` !== p.content_hash) fail(`asset hash mismatch for ${p.id}`);
    const decoded = sanitizeImage(bytes, p.media_type);
    if (decoded.width !== p.width || decoded.height !== p.height || decoded.mediaType !== p.media_type || !Buffer.from(decoded.bytes).equals(Buffer.from(bytes))) fail(`asset metadata mismatch for ${p.id}`);
    const m = p.object_key.match(/^ftw-import\/([a-f0-9]{64})\/([a-f0-9]{64})\.(jpg|png|webp)$/);
    if (!m || m[2] !== p.content_hash.slice(7) || m[3] !== suffix[p.media_type]) fail(`photo ${p.id} must use an immutable content-hash object key`);
    valid.push({ key: p.object_key, bytes });
  }
  const absent = [];
  for (const a of valid) {
    const old = await bucket.get(a.key);
    if (old) {
      const bytes = new Uint8Array(await old.arrayBuffer());
      if (!Buffer.from(bytes).equals(Buffer.from(a.bytes))) fail(`immutable object ${a.key} already has different bytes`);
    } else absent.push(a);
  }
  for (const a of absent) {
    await bucket.put(a.key, a.bytes, { onlyIf: { etagDoesNotMatch: '*' } });
    const saved = await bucket.get(a.key);
    if (!saved || !Buffer.from(new Uint8Array(await saved.arrayBuffer())).equals(Buffer.from(a.bytes))) fail(`immutable object ${a.key} could not be verified after put`);
  }
}

function assertCoverage(snapshot) {
  return readFile(new URL('../../server/neighborhoods.json', import.meta.url), 'utf8').then(raw => {
    const geography = JSON.parse(raw);
    const locations = new Map(snapshot.locations.map(x => [x.id, x]));
    for (const listing of snapshot.listings) if (listing.status === 'published') {
      const loc = locations.get(listing.location_id);
      const area = geography[loc?.neighborhood_id];
      if (!loc || !area || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) fail(`published listing ${listing.id} lacks a covered location`);
      const p = area.projection, x = p.xOrigin + (loc.longitude - p.lngOrigin) * p.xScale, y = p.yOrigin - (loc.latitude - p.latOrigin) * p.yScale, b = area.bounds;
      if (x < b.left || x > b.right || y < b.top || y > b.bottom) fail(`published listing ${listing.id} is outside neighborhood bounds`);
      if (area.coreBoundary?.length) {
        let inside = false;
        for (let i = 0, j = area.coreBoundary.length - 1; i < area.coreBoundary.length; j = i++) {
          const [xi, yi] = area.coreBoundary[i], [xj, yj] = area.coreBoundary[j];
          const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
          if (Math.abs(cross) < 1e-6 && x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) { inside = true; break; }
          if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        if (!inside) fail(`published listing ${listing.id} is outside neighborhood core`);
      }
    }
  });
}

export async function applyFtwCheckpoint({ db, bucket, checkpoint, assets, expectedId } = {}) {
  if (!checkpoint || checkpoint.id !== expectedId) fail('expected checkpoint id is required');
  const saved = await readFtwCheckpoint(db, expectedId);
  if (!saved || saved.artifact_hash !== checkpoint.artifact_hash) fail('checkpoint does not match durable artifact');
  if (saved.state === 'applied') {
    const actual = await readTables(db), expected = postSnapshot(saved.artifact);
    if (canonical(actual) !== canonical(expected)) fail('applied checkpoint no longer matches canonical target state');
    return { action: 'recovered', id: saved.id };
  }
  if (saved.state !== 'prepared') fail(`checkpoint is ${saved.state}`);
  const { artifact } = saved, { ops } = artifact;
  const batch = guardBatch(db, artifact.baseline, saved.id, 'apply', saved);
  for (const op of ops) batch.push(op.kind === 'insert' ? insertSql(db, op.table, op.after) : updateSql(db, op.table, op.after));
  batch.push(db.prepare("UPDATE ftw_import_checkpoints SET state='applied',applied_at=? WHERE id=? AND state='prepared'").bind(Date.now(), saved.id));
  batch.push(cleanupGuards(db, saved.id, 'apply'));
  if (batch.length > LIMITS.statements) fail('apply exceeds D1 statement limit');
  await assertCoverage(postSnapshot(artifact));
  await validatedAssets(bucket, artifact.plan, assets);
  try { await db.batch(batch); }
  catch (error) {
    const latest = await readFtwCheckpoint(db, saved.id).catch(() => null);
    if (latest?.state === 'applied') return { action: 'recovered', id: saved.id };
    throw new Error(`checkpoint apply outcome is unresolved; preserve blobs and inspect ${saved.id}`, { cause: error });
  }
  return { action: 'applied', id: saved.id, operations: ops.length };
}

function postSnapshot(artifact) {
  const snap = structuredClone(artifact.baseline);
  for (const op of artifact.ops) {
    const rows = snap[op.table];
    const key = op.table === 'source_mappings' ? ['source_system','entity_type','source_id','source_season_id'] : ['id'];
    const index = rows.findIndex(r => key.every(k => r[k] === op.after[k]));
    if (op.kind === 'insert') rows.push(op.after);
    else if (index >= 0) rows[index] = op.after;
  }
  for (const table of TABLES) snap[table].sort((a, b) => {
    const keys = table === 'source_mappings' ? ['source_system','entity_type','source_id','source_season_id'] : ['id'];
    for (const key of keys) {
      const compared = Buffer.compare(Buffer.from(String(a[key])), Buffer.from(String(b[key])));
      if (compared) return compared;
    }
    return 0;
  });
  return snap;
}

export async function restoreFtwCheckpoint({ db, bucket, checkpointId, expectedId, reason, now = Date.now() } = {}) {
  if (!expectedId || checkpointId !== expectedId || typeof reason !== 'string' || !reason.trim() || reason.trim().length > 1000 || !Number.isSafeInteger(now) || now < 0) fail('expected checkpoint id, bounded restore reason, and valid time are required');
  const saved = await readFtwCheckpoint(db, expectedId);
  if (saved?.state === 'restored') return { action: 'recovered', id: saved.id };
  if (!saved || saved.state !== 'applied') fail('only an applied checkpoint can be restored');
  const artifact = saved.artifact;
  const target = postSnapshot(artifact);
  const batch = guardBatch(db, target, saved.id, 'restore', saved);
  const reverse = [...artifact.ops].reverse();
  for (const op of reverse) {
    if (op.kind === 'insert') {
      if (op.table === 'listings' || op.table === 'photos') {
        const entity = op.table === 'listings' ? 'listing' : 'photo';
        batch.push(db.prepare('INSERT INTO ftw_import_guard_assertions(assertion_id,ok) SELECT ?,CASE WHEN NOT EXISTS(SELECT 1 FROM review_events WHERE entity_type=? AND entity_id=?) THEN 1 ELSE 0 END').bind(`restore:${saved.id}:history:${op.after.id}`, entity, op.after.id));
      }
      const keys = op.table === 'source_mappings' ? ['source_system','entity_type','source_id','source_season_id'] : ['id'];
      batch.push(db.prepare(`DELETE FROM ${op.table} WHERE ${keys.map(k => `${k}=?`).join(' AND ')}`).bind(...keys.map(k => op.after[k])));
    } else batch.push(updateSql(db, op.table, op.before));
  }
  // Versions remain monotonic after a compensating restore.
  for (const op of reverse) if (op.kind === 'update' && ['listings','photos'].includes(op.table)) {
    const before = op.before, post = op.after;
    batch.push(db.prepare(`UPDATE ${op.table} SET version=? WHERE id=?`).bind(Math.max(before.version, post.version) + 1, before.id));
    const mapping = artifact.plan.source_mappings.find(m => m.canonical_id === before.id);
    if (mapping) batch.push(db.prepare('UPDATE source_mappings SET last_imported_version=? WHERE source_system=? AND entity_type=? AND source_id=? AND source_season_id=?').bind(Math.max(before.version, post.version) + 1, mapping.source_system, mapping.entity_type, mapping.source_id, mapping.source_season_id));
  }
  batch.push(db.prepare("UPDATE ftw_import_checkpoints SET state='restored',restored_at=?,restore_reason=? WHERE id=? AND state='applied'").bind(now, reason.trim(), saved.id));
  batch.push(cleanupGuards(db, saved.id, 'restore'));
  if (batch.length > LIMITS.statements) fail('restore exceeds D1 statement limit');
  try { await db.batch(batch); }
  catch (error) {
    const latest = await readFtwCheckpoint(db, saved.id).catch(() => null);
    if (latest?.state === 'restored') return { action: 'recovered', id: saved.id };
    throw new Error(`checkpoint restore outcome is unresolved; inspect ${saved.id}`, { cause: error });
  }
  return { action: 'restored', id: saved.id };
}
