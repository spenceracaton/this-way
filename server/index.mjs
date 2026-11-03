import geography from './neighborhoods.json' with { type: 'json' };
import { activeSeasonId, seasonFor } from '../public/season-config.mjs';
import { sanitizeImage } from './image.mjs';
import { hash, now, token, problem, passwordMatches, sessionCookie, requestSession, ownerSession, requireOwner, requireOrigin, rateLimit, readBytes, readJson } from './auth.mjs';

const maxPhotoBytes = 2 * 1024 * 1024;
const listingSelect = 'SELECT l.*, p.neighborhood_id, p.address, p.latitude, p.longitude FROM listings l JOIN locations p ON p.id = l.location_id';
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const requestIdPattern = /^[a-zA-Z0-9_-]{20,100}$/;
const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });
const ready = env => Boolean(env.DB && env.PHOTOS && env.OWNER_PASSWORD_HASH && typeof env.SERVICE_SECRET === 'string' && env.SERVICE_SECRET.length >= 32);
const season = env => seasonFor(env.ACTIVE_SEASON || activeSeasonId);
const uuid = prefix => prefix + '_' + crypto.randomUUID();
const all = async statement => (await statement.all()).results;
function text(value, max, name, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw problem(400, 'invalid_field', `Check the ${name}.`);
  return value.trim();
}
function tags(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) throw problem(400, 'invalid_tags', `Choose up to 20 ${name}.`);
  return [...new Set(value.map(item => text(item, 64, name, true)))];
}
function clientId(value) {
  if (typeof value !== 'string' || !requestIdPattern.test(value)) throw problem(400, 'request_id_required', 'Refresh the form and try again.');
  return value;
}
function contains(area, latitude, longitude) {
  if (![latitude, longitude].every(Number.isFinite) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return false;
  const p = area.projection;
  const x = p.xOrigin + (longitude - p.lngOrigin) * p.xScale, y = p.yOrigin - (latitude - p.latOrigin) * p.yScale;
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
export function normalizeListing(input, env) {
  const active = season(env);
  if (!active || input.seasonId !== active.id) throw problem(400, 'season_unavailable', 'This season is not accepting new displays.');
  if (!Object.hasOwn(geography, input.neighborhoodId)) throw problem(400, 'invalid_neighborhood', 'Choose a supported neighborhood.');
  const area = geography[input.neighborhoodId];
  if (!contains(area, input.latitude, input.longitude)) throw problem(400, 'invalid_location', 'Place the pin inside this neighborhood’s map coverage.');
  const chosen = tags(input.tags, 'tags');
  if (chosen.some(value => !active.tags.includes(value))) throw problem(400, 'invalid_tags', 'Choose tags from the current season.');
  return { clientRequestId: clientId(input.clientRequestId), seasonId: active.id, neighborhoodId: input.neighborhoodId,
    address: text(input.address, 160, 'street address', true), title: text(input.title, 80, 'title'), description: text(input.description, 500, 'description'),
    tags: chosen, customTags: tags(input.customTags, 'custom tags'), latitude: input.latitude, longitude: input.longitude };
}
function photoDto(row, admin = false) {
  const dto = { id: row.id, url: admin ? `/api/admin/photos/${row.id}/content` : `/api/photos/${row.id}`, mediaType: row.media_type, width: row.width, height: row.height, position: row.position, fit: row.fit };
  return admin ? { ...dto, status: row.status, version: row.version, createdAt: row.created_at } : dto;
}
function listingDto(row, photos = []) {
  return { id: row.id, locationId: row.location_id, seasonId: row.season_id, neighborhoodId: row.neighborhood_id,
    address: row.address, title: row.title, description: row.description, latitude: row.latitude, longitude: row.longitude,
    tags: JSON.parse(row.tags_json), customTags: JSON.parse(row.custom_tags_json), status: row.status, version: row.version, createdAt: row.created_at, photos };
}
async function listingById(env, id) { return env.DB.prepare(listingSelect + ' WHERE l.id = ?').bind(id).first(); }
async function publicListing(env, row) {
  const photos = await all(env.DB.prepare("SELECT * FROM photos WHERE listing_id = ? AND status = 'approved' ORDER BY position, id").bind(row.id));
  return listingDto(row, photos.map(item => photoDto(item)));
}
async function issueUploadToken(env, listingId) {
  const value = token(), stamp = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM upload_tokens WHERE expires_at <= ?').bind(stamp),
    env.DB.prepare('INSERT INTO upload_tokens(token_hash,listing_id,created_at,expires_at) VALUES(?,?,?,?)').bind(await hash(value), listingId, stamp, stamp + 3600000)
  ]);
  return value;
}
async function validateUploadToken(request, env, listingId) {
  const value = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!value || !await env.DB.prepare('SELECT token_hash FROM upload_tokens WHERE token_hash=? AND listing_id=? AND expires_at>?').bind(await hash(value), listingId, now()).first()) {
    throw problem(403, 'upload_expired', 'Your upload session expired. Retry the photo to start a new one.');
  }
}
async function createListing(request, env) {
  const input = normalizeListing(await readJson(request), env), payloadHash = await hash(JSON.stringify(input));
  let existing = await env.DB.prepare(listingSelect + ' WHERE l.client_request_id = ?').bind(input.clientRequestId).first();
  if (!existing) {
    const locationId = uuid('loc'), listingId = uuid('lst'), stamp = now(), active = season(env);
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO seasons(id,kind,year,name,config_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(active.id, active.kind, active.year, active.name, JSON.stringify(active)),
        env.DB.prepare('INSERT INTO locations(id,neighborhood_id,address,latitude,longitude,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(locationId, input.neighborhoodId, input.address, input.latitude, input.longitude, stamp, stamp),
        env.DB.prepare("INSERT INTO listings(id,location_id,season_id,title,description,tags_json,custom_tags_json,status,version,approval_method,created_at,updated_at,client_request_id,payload_hash,sharing_consent) VALUES(?,?,?,?,?,?,?,'published',1,'automatic-text',?,?,?,?,1)").bind(listingId, locationId, input.seasonId, input.title, input.description, JSON.stringify(input.tags), JSON.stringify(input.customTags), stamp, stamp, input.clientRequestId, payloadHash)
      ]);
      const row = await listingById(env, listingId);
      return json({ listing: await publicListing(env, row), uploadToken: await issueUploadToken(env, listingId) }, 201);
    } catch (error) {
      existing = await env.DB.prepare(listingSelect + ' WHERE l.client_request_id = ?').bind(input.clientRequestId).first();
      if (!existing) throw error;
    }
  }
  if (existing.payload_hash !== payloadHash) throw problem(409, 'request_conflict', 'This submission was already saved with different details. Start a new submission.');
  return json({ listing: await publicListing(env, existing), uploadToken: await issueUploadToken(env, existing.id) });
}
async function uploadPhoto(request, env, id) {
  await validateUploadToken(request, env, id);
  const listing = await listingById(env, id);
  if (!listing || listing.status !== 'published') throw problem(404, 'not_found', 'This display is not available for photos.');
  const requestId = clientId(request.headers.get('x-photo-request-id'));
  const photo = sanitizeImage(await readBytes(request, maxPhotoBytes), request.headers.get('content-type')?.split(';')[0]);
  const checksum = await hash(photo.bytes);
  const prior = await env.DB.prepare('SELECT * FROM photos WHERE client_request_id = ?').bind(requestId).first();
  if (prior) {
    if (prior.listing_id !== id || prior.content_hash !== checksum) throw problem(409, 'request_conflict', 'This photo retry does not match the saved upload.');
    return json({ photo: { id: prior.id, status: prior.status, version: prior.version } });
  }
  const photoId = uuid('photo'), key = `photos/${id}/${photoId}`, stamp = now();
  await env.PHOTOS.put(key, photo.bytes, { httpMetadata: { contentType: photo.mediaType }, customMetadata: { photoId } });
  try {
    const result = await env.DB.prepare("INSERT INTO photos(id,listing_id,status,object_key,content_hash,media_type,width,height,position,created_at,client_request_id) SELECT ?,?,'pending',?,?,?,?,?,COALESCE((SELECT MAX(position)+1 FROM photos WHERE listing_id=?),0),?,? WHERE (SELECT COUNT(*) FROM photos WHERE listing_id=? AND status IN ('pending','approved')) < 3 RETURNING id,status,version")
      .bind(photoId, id, key, checksum, photo.mediaType, photo.width, photo.height, id, stamp, requestId, id).first();
    if (!result) throw problem(409, 'photo_limit', 'This display already has three approved or pending photos.');
    return json({ photo: result }, 201);
  } catch (error) {
    const saved = await env.DB.prepare('SELECT * FROM photos WHERE client_request_id=?').bind(requestId).first();
    if (saved?.listing_id === id && saved.content_hash === checksum) {
      if (saved.object_key !== key) await env.PHOTOS.delete(key);
      return json({ photo: { id: saved.id, status: saved.status, version: saved.version } });
    }
    await env.PHOTOS.delete(key);
    throw error;
  }
}
async function imageResponse(env, id, admin = false) {
  const row = await env.DB.prepare('SELECT p.* FROM photos p JOIN listings l ON l.id=p.listing_id WHERE p.id=?' + (admin ? '' : " AND p.status='approved' AND l.status='published'")).bind(id).first();
  if (!row) throw problem(404, 'not_found', 'Photo not found.');
  const object = await env.PHOTOS.get(row.object_key);
  if (!object) throw problem(404, 'not_found', 'Photo not found.');
  // Approved photos can later be rejected/hidden; never permit shared cache
  // copies to bypass the fresh moderation lookup above.
  return new Response(object.body, { headers: { 'content-type': row.media_type, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-origin' } });
}
async function login(request, env) {
  const input = await readJson(request), stamp = now();
  const key = await hash(env.SERVICE_SECRET + ':' + (request.headers.get('cf-connecting-ip') || 'local'));
  const attempt = await env.DB.prepare('INSERT INTO login_attempts(key,window_start,attempts) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start < ? THEN 1 ELSE attempts+1 END, window_start=CASE WHEN window_start < ? THEN excluded.window_start ELSE window_start END RETURNING attempts').bind(key, stamp, stamp - 900000, stamp - 900000).first();
  if (attempt.attempts > 10) throw problem(429, 'login_limit', 'Too many sign-in attempts. Try again in 15 minutes.');
  if (!await passwordMatches(input.password, env.OWNER_PASSWORD_HASH)) throw problem(401, 'invalid_password', 'That password did not match.');
  const value = token();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(stamp),
    env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key),
    env.DB.prepare('INSERT INTO sessions(token_hash,created_at,expires_at) VALUES(?,?,?)').bind(await hash(value), stamp, stamp + 8 * 3600000)
  ]);
  return json({ authenticated: true }, 200, { 'set-cookie': sessionCookie(request, env, value) });
}
function version(value) { if (!Number.isInteger(value) || value < 1) throw problem(400, 'version_required', 'Refresh the record before making a decision.'); return value; }
async function route(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (method === 'GET' && path === '/api/config') return json({ available: ready(env), season: season(env), limits: { photos: 3, maxPhotoBytes } });
  if (!ready(env)) throw problem(503, 'service_unavailable', 'Submissions are not available yet. Try again later.');
  if (!['GET', 'HEAD'].includes(method)) requireOrigin(request);
  if (path.startsWith('/api/admin/')) await requireOwner(request, env);
  if (path === '/api/session') {
    if (method === 'GET') return json({ authenticated: Boolean(await ownerSession(request, env)) });
    if (method === 'POST') return login(request, env);
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await hash(requestSession(request))).run();
      return json({ authenticated: false }, 200, { 'set-cookie': sessionCookie(request, env, '', 0) });
    }
  }
  if (path === '/api/listings' && method === 'POST') {
    await rateLimit(request, env, 'listing-create', 30);
    return createListing(request, env);
  }
  if ((path === '/api/listings' || path === '/api/admin/listings') && method === 'GET') {
    const admin = path.startsWith('/api/admin/'), requestedSeason = url.searchParams.get('season') || season(env).id;
    const neighborhood = url.searchParams.get('neighborhood');
    if (!admin && !Object.hasOwn(geography, neighborhood)) throw problem(400, 'invalid_neighborhood', 'Choose a supported neighborhood.');
    const clauses = ['l.season_id=?'], bindings = [requestedSeason];
    if (!admin) { clauses.push("l.status='published'", 'p.neighborhood_id=?'); bindings.push(neighborhood); }
    const rows = await all(env.DB.prepare(listingSelect + ' WHERE ' + clauses.join(' AND ') + ' ORDER BY l.created_at,l.id').bind(...bindings));
    // One query for this neighborhood's approved photos, never pending media.
    const photos = await all(env.DB.prepare("SELECT ph.* FROM photos ph JOIN listings l ON l.id=ph.listing_id JOIN locations p ON p.id=l.location_id WHERE ph.status='approved' AND " + clauses.join(' AND ') + ' ORDER BY ph.position,ph.id').bind(...bindings));
    const grouped = new Map();
    for (const photo of photos) { if (!grouped.has(photo.listing_id)) grouped.set(photo.listing_id, []); grouped.get(photo.listing_id).push(photoDto(photo)); }
    return json({ listings: rows.map(row => listingDto(row, grouped.get(row.id) || [])) });
  }
  let match = path.match(/^\/api\/listings\/([^/]+)\/photo-upload-token$/);
  if (match && method === 'POST') {
    clientId((await readJson(request)).clientRequestId);
    const listing = await listingById(env, match[1]);
    if (!listing || listing.status !== 'published') throw problem(404, 'not_found', 'Display not found.');
    // This is intentionally a public visitor contribution grant, not proof of
    // ownership. Photos still enter the private review queue. Bound both the
    // visitor's requests and grants targeting one display.
    await rateLimit(request, env, 'photo-grant', 30);
    await rateLimit(request, env, 'listing-photo-grant', 30, 3600000, listing.id);
    return json({ uploadToken: await issueUploadToken(env, listing.id) });
  }
  match = path.match(/^\/api\/listings\/([^/]+)\/photos$/);
  if (match && method === 'POST' && idPattern.test(match[1])) {
    await rateLimit(request, env, 'photo-upload', 90);
    return uploadPhoto(request, env, match[1]);
  }
  match = path.match(/^\/api\/photos\/([^/]+)$/);
  if (match && method === 'GET' && idPattern.test(match[1])) return imageResponse(env, match[1]);
  if (path === '/api/admin/photos' && method === 'GET') {
    const status = url.searchParams.get('status') || 'pending';
    if (!['pending', 'approved', 'rejected'].includes(status)) throw problem(400, 'invalid_status', 'Choose a photo review state.');
    const rows = await all(env.DB.prepare('SELECT * FROM photos WHERE status=? ORDER BY created_at,id').bind(status));
    const listingRows = await all(env.DB.prepare(listingSelect + ' WHERE EXISTS (SELECT 1 FROM photos ph WHERE ph.listing_id=l.id AND ph.status=?)').bind(status));
    const listings = new Map(listingRows.map(row => [row.id, row]));
    return json({ photos: rows.map(row => ({ ...photoDto(row, true), listing: listingDto(listings.get(row.listing_id)) })) });
  }
  match = path.match(/^\/api\/admin\/photos\/([^/]+)\/content$/);
  if (match && method === 'GET') return imageResponse(env, match[1], true);
  match = path.match(/^\/api\/admin\/photos\/([^/]+)\/decision$/);
  if (match && method === 'POST') {
    const input = await readJson(request);
    if (!['approved', 'rejected', 'pending'].includes(input.decision)) throw problem(400, 'invalid_decision', 'Choose approve, reject, or return to pending.');
    const expectedVersion = version(input.expectedVersion);
    let row = await env.DB.prepare("UPDATE photos SET status=?,version=version+1,reviewed_at=?,reviewed_by='owner',review_reason=? WHERE id=? AND version=? AND status<>'removed' AND status<>? RETURNING id,status,version").bind(input.decision, now(), text(input.reason, 500, 'review note'), match[1], expectedVersion, input.decision).first();
    if (!row) row = await env.DB.prepare('SELECT id,status,version FROM photos WHERE id=? AND version=? AND status=?').bind(match[1], expectedVersion, input.decision).first();
    if (!row) throw problem(409, 'stale_review', 'This photo changed. Refresh it before reviewing again.');
    return json({ photo: row });
  }
  match = path.match(/^\/api\/admin\/listings\/([^/]+)\/visibility$/);
  if (match && method === 'POST') {
    const input = await readJson(request);
    if (!['published', 'hidden'].includes(input.status)) throw problem(400, 'invalid_status', 'Choose published or hidden.');
    const stamp = now();
    const expectedVersion = version(input.expectedVersion);
    let row = await env.DB.prepare("UPDATE listings SET status=?,version=version+1,updated_at=?,reviewed_at=?,reviewed_by='owner',review_reason=? WHERE id=? AND version=? AND status<>? RETURNING id").bind(input.status, stamp, stamp, text(input.reason, 500, 'review note'), match[1], expectedVersion, input.status).first();
    if (!row) row = await env.DB.prepare('SELECT id FROM listings WHERE id=? AND version=? AND status=?').bind(match[1], expectedVersion, input.status).first();
    if (!row) throw problem(409, 'stale_review', 'This display changed. Refresh it before changing visibility.');
    return json({ listing: await publicListing(env, await listingById(env, row.id)) });
  }
  throw problem(404, 'not_found', 'This service endpoint was not found.');
}
export default {
  async fetch(request, env) {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try { return await route(request, env); }
    catch (error) {
      const status = error.status || 500;
      if (status === 500) console.error('Listing service error:', error.name);
      return json({ error: { code: error.code || (status === 400 ? 'invalid_photo' : 'service_error'), message: status === 500 ? 'The service could not finish that request. Try again.' : error.message } }, status);
    }
  }
};
