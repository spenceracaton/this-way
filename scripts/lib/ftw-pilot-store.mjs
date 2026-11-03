import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sanitizeImage } from '../../server/image.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_LISTINGS = 50;
const MAX_STATEMENTS = 250;
const TABLES = ['seasons', 'locations', 'listings', 'photos', 'source_mappings'];
const COLUMNS = {
  seasons: ['id','kind','year','name','config_json'],
  locations: ['id','neighborhood_id','address','latitude','longitude','address_match_json','created_at','updated_at'],
  listings: ['id','location_id','season_id','title','description','tags_json','custom_tags_json','level','featured','sharing_consent','status','version','approval_method','created_at','updated_at','reviewed_at','reviewed_by','review_reason','client_request_id','payload_hash','source_metadata_json'],
  photos: ['id','listing_id','status','client_request_id','object_key','content_hash','media_type','width','height','position','fit','version','created_at','reviewed_at','reviewed_by','review_reason','removed_at','source_metadata_json'],
  source_mappings: ['source_system','entity_type','source_id','source_season_id','canonical_id','source_version','source_checksum','source_snapshot_json','last_imported_version','imported_at']
};

function fail(message) { throw new TypeError(message); }
function list(value, name) { if (!Array.isArray(value)) fail(`plan.${name} must be an array`); return value; }
function bytesEqual(a, b) { return Buffer.from(a).equals(Buffer.from(b)); }
function sha256(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }

export async function readFtwPilotTarget(db) {
  if (!db || typeof db.prepare !== 'function') fail('a local D1 database is required');
  const [existingMappings, ...groups] = await Promise.all([
    db.prepare('SELECT * FROM source_mappings ORDER BY source_system,entity_type,source_id,source_season_id').all().then(x => x.results),
    ...['seasons','locations','listings','photos'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().then(x => x.results))
  ]);
  return { existingMappings, targetRows: groups.flat() };
}

function covered(neighborhood, latitude, longitude, geography) {
  const area = geography[neighborhood];
  if (!area || ![latitude, longitude].every(Number.isFinite) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return false;
  const p = area.projection;
  const x = p.xOrigin + (longitude - p.lngOrigin) * p.xScale;
  const y = p.yOrigin - (latitude - p.latOrigin) * p.yScale;
  const b = area.bounds;
  if (x < b.left || x > b.right || y < b.top || y > b.bottom) return false;
  const polygon = area.coreBoundary;
  if (!polygon?.length) return true;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
    if (Math.abs(cross) < 1e-6 && x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return true;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') fail('plan is required');
  const names = ['seasons','locations','listings','photos','source_mappings'];
  for (const name of names) list(plan[name], name);
  if (!Array.isArray(plan.decisions) || !Array.isArray(plan.conflicts)) fail('plan decisions and conflicts must be arrays');
  if (plan.conflicts.length) fail('pilot store refuses plans with conflicts');
  const actions = new Set(plan.decisions.map(d => d?.action));
  if (!actions.size) fail('pilot store requires explicit plan decisions');
  for (const action of actions) if (action !== 'insert' && action !== 'skip' && action !== 'mapped') fail(`pilot store refuses decision action ${String(action)}`);
  const rowCount = names.reduce((sum, name) => sum + plan[name].length, 0);
  if (rowCount > MAX_STATEMENTS || rowCount + 1 > MAX_STATEMENTS) fail(`plan exceeds ${MAX_STATEMENTS} SQL statements`);
  if (plan.listings.length > MAX_LISTINGS) fail(`pilot store accepts at most ${MAX_LISTINGS} listings`);
  if (actions.size === 1 && actions.has('skip')) {
    if (rowCount !== 0) fail('skip plan must not contain rows');
    return 'skip';
  }
  if (actions.has('skip') || !actions.has('insert') || [...actions].some(action => action !== 'insert' && action !== 'mapped')) fail('pilot store requires a complete insert or exact skip plan');
  if (plan.decisions.some(d => d.action === 'mapped' && d.entityType !== 'season')) fail('only explicit season mappings may use the mapped decision');
  if (!plan.listings.length || plan.listings.length !== plan.decisions.filter(d => d.entityType === 'listing').length) fail('insert plan must include one decision per listing');
  return 'insert';
}

function uniqueRows(plan) {
  const ids = new Set();
  for (const table of ['seasons','locations','listings','photos']) for (const row of plan[table]) {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id)) fail(`plan contains a duplicate or invalid row id ${row?.id ?? ''}`);
    ids.add(row.id);
  }
  const mappingKeys = new Set();
  for (const row of plan.source_mappings) {
    const key = [row.source_system,row.entity_type,row.source_id,row.source_season_id ?? ''].join('\u001f');
    if (mappingKeys.has(key)) fail('plan contains duplicate source mapping keys');
    mappingKeys.add(key);
  }
  const objectKeys = new Set();
  for (const row of plan.photos) {
    if (!row.object_key || objectKeys.has(row.object_key)) fail(`plan contains duplicate or invalid object key ${row.object_key ?? ''}`);
    objectKeys.add(row.object_key);
  }
}

async function objectBytes(object) {
  if (!object) return null;
  if (typeof object.arrayBuffer === 'function') return new Uint8Array(await object.arrayBuffer());
  if (object.body && typeof object.body.getReader === 'function') return new Uint8Array(await new Response(object.body).arrayBuffer());
  fail('R2 returned an unreadable object');
}

export async function applyFtwPilotPlan({ mode, db, bucket, plan, assets } = {}) {
  if (mode !== 'isolated-local') fail('FTW pilot store requires mode:"isolated-local"');
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') fail('a local D1 database with batch support is required');
  if (!bucket || typeof bucket.get !== 'function' || typeof bucket.put !== 'function' || typeof bucket.delete !== 'function') fail('a local R2 bucket is required');
  const action = validatePlan(plan);
  if (action === 'skip') return { action: 'skip', rowCounts: Object.fromEntries(TABLES.map(name => [name, 0])), reusedObjects: 0 };
  uniqueRows(plan);
  if (!Array.isArray(assets)) fail('assets must be an array');
  const byKey = new Map();
  for (const asset of assets) {
    if (!asset || typeof asset.objectKey !== 'string' || !asset.objectKey || byKey.has(asset.objectKey) || !(asset.bytes instanceof Uint8Array)) fail('assets must have unique objectKey values and Uint8Array bytes');
    byKey.set(asset.objectKey, asset.bytes);
  }
  if (byKey.size !== plan.photos.length || plan.photos.some(row => !byKey.has(row.object_key))) fail('assets must exactly match planned photo object keys');
  const geography = JSON.parse(await readFile(resolve(root, 'server/neighborhoods.json'), 'utf8'));
  const locations = new Map(plan.locations.map(row => [row.id, row]));
  for (const listing of plan.listings) {
    if (listing.status === 'published') {
      const location = locations.get(listing.location_id)
        ?? await db.prepare('SELECT * FROM locations WHERE id=?').bind(listing.location_id).first();
      if (!location || !covered(location.neighborhood_id, location.latitude, location.longitude, geography)) fail(`published listing ${listing.id} is outside its declared neighborhood coverage`);
    }
  }
  const checkedAssets = [];
  for (const photo of plan.photos) {
    const data = byKey.get(photo.object_key);
    if (sha256(data) !== photo.content_hash) fail(`asset hash does not match photo ${photo.id}`);
    const decoded = sanitizeImage(data, photo.media_type);
    if (!bytesEqual(decoded.bytes, data) || decoded.mediaType !== photo.media_type || decoded.width !== photo.width || decoded.height !== photo.height) fail(`asset metadata or sanitized bytes do not match photo ${photo.id}`);
    checkedAssets.push({ key: photo.object_key, bytes: data });
  }
  const existing = new Map();
  for (const asset of checkedAssets) {
    const data = await objectBytes(await bucket.get(asset.key));
    if (data && !bytesEqual(data, asset.bytes)) fail(`existing R2 object ${asset.key} has different bytes`);
    existing.set(asset.key, Boolean(data));
  }
  const added = [];
  try {
    for (const asset of checkedAssets) if (!existing.get(asset.key)) {
      await bucket.put(asset.key, asset.bytes);
      added.push(asset.key);
    }
    const statements = [];
    for (const table of TABLES) for (const row of plan[table]) {
      const columns = COLUMNS[table];
      statements.push(db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).bind(...columns.map(key => row[key] ?? null)));
    }
    await db.batch(statements);
  } catch (error) {
    await Promise.all(added.map(key => bucket.delete(key).catch(() => {})));
    throw error;
  }
  return { action: 'insert', rowCounts: Object.fromEntries(TABLES.map(name => [name, plan[name].length])), reusedObjects: [...existing.values()].filter(Boolean).length };
}
