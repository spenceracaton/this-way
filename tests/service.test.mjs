import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestService, TEST_ORIGIN, TEST_OWNER_PASSWORD } from './helpers/service-runtime.mjs';

const seasonId = 'christmas-2026';
const neighborhoodId = 'old-northeast';
const baseListing = (overrides = {}) => ({
  clientRequestId: 'listing-request-000000000001', seasonId, neighborhoodId,
  address: '123 Test Street', title: 'Front yard lights', description: 'A welcoming winter display.',
  tags: ['Lights'], customTags: [], latitude: 27.7923, longitude: -82.631,
  ...overrides,
});
const redPng = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S0cAAAAASUVORK5CYII=', 'base64'));
function fixPngCrc(source) {
  const out = source.slice();
  let p = 8;
  while (p < out.length) {
    const size = out[p] * 0x1000000 + (out[p + 1] << 16) + (out[p + 2] << 8) + out[p + 3];
    let crc = 0xffffffff;
    for (let i = p + 4; i < p + 8 + size; i++) {
      crc ^= out[i];
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const at = p + 8 + size;
    out[at] = crc >>> 24; out[at + 1] = crc >>> 16; out[at + 2] = crc >>> 8; out[at + 3] = crc;
    p = at + 4;
  }
  return out;
}
const validPng = fixPngCrc(redPng);
const asJson = response => response.json();
async function createListing(service, overrides = {}) {
  const response = await service.request('/api/listings', { method: 'POST', body: baseListing(overrides) });
  const body = await asJson(response);
  assert.equal(response.status, 201, JSON.stringify(body));
  return { listing: body.listing, uploadToken: body.uploadToken };
}
async function upload(service, listingId, uploadToken, requestId, bytes = validPng, type = 'image/png') {
  return service.request(`/api/listings/${listingId}/photos`, {
    method: 'POST',
    headers: { authorization: `Bearer ${uploadToken}`, 'content-type': type, 'x-photo-request-id': requestId },
    body: bytes,
  });
}
async function login(service, url = TEST_ORIGIN) {
  const response = await service.request('/api/session', { method: 'POST', body: { password: TEST_OWNER_PASSWORD }, url });
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function owner(service) {
  const result = await login(service);
  assert.equal(result.response.status, 200);
  return result.cookie;
}
async function decide(service, cookie, id, decision, expectedVersion, reason = 'Test moderation') {
  return service.request(`/api/admin/photos/${id}/decision`, {
    method: 'POST', headers: { cookie }, body: { decision, expectedVersion, reason },
  });
}

test('text listings publish immediately, retries are idempotent, and conflicting retries fail', async t => {
  const service = await createTestService(); t.after(() => service.dispose());
  const created = await createListing(service);
  assert.equal(created.listing.status, 'published');
  assert.equal(created.listing.photos.length, 0);
  const replay = await service.request('/api/listings', { method: 'POST', body: baseListing() });
  assert.equal(replay.status, 200);
  assert.equal((await asJson(replay)).listing.id, created.listing.id);
  assert.equal((await service.db.prepare('SELECT COUNT(*) AS n FROM listings').first()).n, 1);
  const conflict = await service.request('/api/listings', { method: 'POST', body: baseListing({ title: 'Different title' }) });
  assert.equal(conflict.status, 409);
  assert.equal((await service.db.prepare('SELECT COUNT(*) AS n FROM listings').first()).n, 1);
});

test('uploads remain private until owner approval; reject, undo, stale review, and hiding preserve listing text', async t => {
  const service = await createTestService(); t.after(() => service.dispose());
  const { listing, uploadToken } = await createListing(service);
  const submitted = await upload(service, listing.id, uploadToken, 'photo-request-000000000001');
  assert.equal(submitted.status, 201);
  const photo = (await asJson(submitted)).photo;
  assert.equal(photo.status, 'pending');
  assert.equal((await service.request(`/api/photos/${photo.id}`)).status, 404);
  const publicListings = await asJson(await service.request(`/api/listings?neighborhood=${neighborhoodId}&season=${seasonId}`));
  assert.equal(publicListings.listings[0].id, listing.id);
  assert.deepEqual(publicListings.listings[0].photos, []);
  assert.equal((await service.bucket.list({ prefix: 'photos/' })).objects.length, 1);

  assert.equal((await service.request('/api/admin/photos')).status, 401);
  const cookie = await owner(service);
  const pending = await asJson(await service.request('/api/admin/photos?status=pending', { headers: { cookie } }));
  assert.equal(pending.photos.length, 1);
  assert.equal((await service.request(pending.photos[0].url, { headers: { cookie } })).status, 200);

  const approved = await decide(service, cookie, photo.id, 'approved', 1);
  assert.equal(approved.status, 200);
  assert.deepEqual((await asJson(await decide(service, cookie, photo.id, 'approved', 2, 'Changed retry note'))).photo, { id: photo.id, status: 'approved', version: 2 });
  const photoReview = await service.db.prepare('SELECT reviewed_at,review_reason FROM photos WHERE id=?').bind(photo.id).first();
  assert.equal(photoReview.review_reason, 'Test moderation');
  assert.equal((await service.db.prepare("SELECT COUNT(*) AS n FROM review_events WHERE entity_type='photo' AND entity_id=?").bind(photo.id).first()).n, 1);
  const publicImage = await service.request(`/api/photos/${photo.id}`);
  assert.equal(publicImage.status, 200);
  assert.deepEqual(new Uint8Array(await publicImage.arrayBuffer()), validPng);
  assert.equal((await service.request(`/api/photos/${photo.id}`)).status, 200);
  let visible = await asJson(await service.request(`/api/listings?neighborhood=${neighborhoodId}&season=${seasonId}`));
  assert.equal(visible.listings[0].photos.length, 1);
  const stale = await decide(service, cookie, photo.id, 'rejected', 1);
  assert.equal(stale.status, 409);
  assert.equal((await service.db.prepare("SELECT COUNT(*) AS n FROM review_events WHERE entity_type='photo' AND entity_id=?").bind(photo.id).first()).n, 1);

  assert.equal((await decide(service, cookie, photo.id, 'rejected', 2)).status, 200);
  assert.equal((await service.request(`/api/photos/${photo.id}`)).status, 404);
  assert.equal((await decide(service, cookie, photo.id, 'pending', 3)).status, 200);
  assert.equal((await service.request(`/api/photos/${photo.id}`)).status, 404);
  visible = await asJson(await service.request(`/api/listings?neighborhood=${neighborhoodId}&season=${seasonId}`));
  assert.equal(visible.listings.length, 1);
  assert.deepEqual(visible.listings[0].photos, []);
  assert.equal((await service.db.prepare("SELECT COUNT(*) AS n FROM review_events WHERE entity_type='photo' AND entity_id=?").bind(photo.id).first()).n, 3);

  await decide(service, cookie, photo.id, 'approved', 4);
  assert.equal((await service.request(`/api/photos/${photo.id}`)).status, 200);
  const listingRow = await service.db.prepare('SELECT version,updated_at,review_reason FROM listings WHERE id=?').bind(listing.id).first();
  const samePublished = await service.request(`/api/admin/listings/${listing.id}/visibility`, { method: 'POST', headers: { cookie }, body: { status: 'published', expectedVersion: listingRow.version, reason: 'Should be ignored' } });
  assert.equal(samePublished.status, 200);
  assert.equal((await asJson(samePublished)).listing.version, listingRow.version);
  const stillPublished = await service.db.prepare('SELECT version,updated_at,review_reason FROM listings WHERE id=?').bind(listing.id).first();
  assert.deepEqual(stillPublished, listingRow);
  assert.equal((await service.db.prepare("SELECT COUNT(*) AS n FROM review_events WHERE entity_type='listing' AND entity_id=?").bind(listing.id).first()).n, 0);
  const hidden = await service.request(`/api/admin/listings/${listing.id}/visibility`, { method: 'POST', headers: { cookie }, body: { status: 'hidden', expectedVersion: listingRow.version, reason: 'Hide for test' } });
  assert.equal(hidden.status, 200);
  const sameHidden = await service.request(`/api/admin/listings/${listing.id}/visibility`, { method: 'POST', headers: { cookie }, body: { status: 'hidden', expectedVersion: listingRow.version + 1, reason: 'Should also be ignored' } });
  assert.equal(sameHidden.status, 200);
  assert.equal((await asJson(sameHidden)).listing.version, listingRow.version + 1);
  assert.equal((await service.db.prepare("SELECT COUNT(*) AS n FROM review_events WHERE entity_type='listing' AND entity_id=?").bind(listing.id).first()).n, 1);
  assert.equal((await service.request(`/api/photos/${photo.id}`)).status, 404);
  visible = await asJson(await service.request(`/api/listings?neighborhood=${neighborhoodId}&season=${seasonId}`));
  assert.deepEqual(visible.listings, []);
});

test('authentication enforces owner access, origin checks, failed-login limit, and cookie flags', async t => {
  const service = await createTestService(); t.after(() => service.dispose());
  assert.equal((await service.request('/api/admin/photos')).status, 401);
  const noOrigin = await service.request('/api/session', { method: 'POST', origin: false, body: { password: TEST_OWNER_PASSWORD } });
  assert.equal(noOrigin.status, 403);
  for (let i = 0; i < 10; i++) {
    const wrong = await service.request('/api/session', { method: 'POST', body: { password: 'incorrect-password' } });
    assert.equal(wrong.status, 401);
  }
  const limited = await service.request('/api/session', { method: 'POST', body: { password: TEST_OWNER_PASSWORD } });
  assert.equal(limited.status, 429);
  // Use a separate client IP key to verify cookie attributes independently of the limit bucket.
  const local = await service.request('/api/session', { method: 'POST', headers: { 'cf-connecting-ip': '127.0.0.2' }, body: { password: TEST_OWNER_PASSWORD } });
  assert.equal(local.status, 200);
  const localCookie = local.headers.get('set-cookie');
  assert.match(localCookie, /HttpOnly/); assert.match(localCookie, /SameSite=Strict/); assert.doesNotMatch(localCookie, /Secure/);
  const prod = await service.request('/api/session', { method: 'POST', url: 'https://service.example', headers: { 'cf-connecting-ip': '203.0.113.1' }, body: { password: TEST_OWNER_PASSWORD } });
  assert.equal(prod.status, 200);
  assert.match(prod.headers.get('set-cookie'), /; Secure/);
  assert.equal((await service.request('/api/admin/photos', { headers: { cookie: localCookie.split(';')[0] } })).status, 200);
});

test('bad MIME and malformed uploads create neither photo rows nor R2 objects', async t => {
  const service = await createTestService(); t.after(() => service.dispose());
  const { listing, uploadToken } = await createListing(service);
  assert.equal((await upload(service, listing.id, uploadToken, 'photo-request-badtype00001', validPng, 'image/jpeg')).status, 400);
  assert.equal((await upload(service, listing.id, uploadToken, 'photo-request-malformed01', validPng.subarray(0, validPng.length - 3))).status, 400);
  assert.equal((await service.db.prepare('SELECT COUNT(*) AS n FROM photos').first()).n, 0);
  assert.equal((await service.bucket.list({ prefix: 'photos/' })).objects.length, 0);
});

test('same photo retry returns one record and concurrent uploads never exceed three active photos', async t => {
  const service = await createTestService(); t.after(() => service.dispose());
  const { listing, uploadToken } = await createListing(service);
  const replayId = 'photo-request-replay000001';
  const first = await upload(service, listing.id, uploadToken, replayId);
  assert.equal(first.status, 201);
  const firstPhoto = (await asJson(first)).photo;
  const replay = await upload(service, listing.id, uploadToken, replayId);
  assert.equal(replay.status, 200);
  assert.equal((await asJson(replay)).photo.id, firstPhoto.id);
  const concurrent = await Promise.all([2, 3, 4].map(n => upload(service, listing.id, uploadToken, `photo-request-concurrent${String(n).padStart(4, '0')}`)));
  assert.equal(concurrent.filter(r => r.status === 201).length, 2);
  assert.equal(concurrent.filter(r => r.status === 409).length, 1);
  assert.equal((await service.db.prepare("SELECT COUNT(*) AS n FROM photos WHERE status IN ('pending','approved')").first()).n, 3);
  assert.equal((await service.bucket.list({ prefix: 'photos/' })).objects.length, 3);
});

test('D1 and private R2 data survive a Worker restart using the same persistence path', async t => {
  const persistPath = await mkdtemp(join(tmpdir(), 'this-way-service-'));
  t.after(() => rm(persistPath, { recursive: true, force: true }));
  const firstService = await createTestService({ persistPath });
  const created = await createListing(firstService, { clientRequestId: 'listing-request-persistent0001' });
  const uploaded = await upload(firstService, created.listing.id, created.uploadToken, 'photo-request-persistent0001');
  const photo = (await asJson(uploaded)).photo;
  const cookie = await owner(firstService);
  assert.equal((await decide(firstService, cookie, photo.id, 'approved', 1)).status, 200);
  await firstService.dispose();

  const secondService = await createTestService({ persistPath });
  t.after(() => secondService.dispose());
  assert.equal((await secondService.db.prepare('SELECT COUNT(*) AS n FROM listings').first()).n, 1);
  assert.equal((await secondService.db.prepare('SELECT COUNT(*) AS n FROM photos').first()).n, 1);
  assert.equal((await secondService.bucket.list({ prefix: 'photos/' })).objects.length, 1);
  assert.equal((await secondService.request(`/api/photos/${photo.id}`)).status, 200);
  const publicAfterRestart = await asJson(await secondService.request(`/api/listings?neighborhood=${neighborhoodId}&season=${seasonId}`));
  assert.equal(publicAfterRestart.listings[0].photos[0].id, photo.id);
  assert.equal((await secondService.request(`/api/listings/${created.listing.id}/photos`, { method: 'POST', headers: { authorization: `Bearer ${created.uploadToken}`, 'content-type': 'image/png', 'x-photo-request-id': 'photo-request-persistent0001' }, body: validPng })).status, 200);
});

test('public visitor photo grants stay private and their limits prevent extra listings, grants, or objects', async t => {
  const service = await createTestService(); t.after(() => service.dispose());
  const listingIp = '198.51.100.90';
  for (let n = 1; n <= 30; n++) {
    const response = await service.request('/api/listings', {
      method: 'POST', headers: { 'cf-connecting-ip': listingIp },
      body: baseListing({ clientRequestId: `rate-listing-request-${String(n).padStart(8, '0')}`, address: `${n} Test Street` }),
    });
    assert.equal(response.status, 201, `listing request ${n}`);
  }
  const blockedListing = await service.request('/api/listings', {
    method: 'POST', headers: { 'cf-connecting-ip': listingIp },
    body: baseListing({ clientRequestId: 'rate-listing-request-00000031', address: '31 Test Street' }),
  });
  assert.equal(blockedListing.status, 429);
  assert.equal((await service.db.prepare('SELECT COUNT(*) AS n FROM listings').first()).n, 30);
  assert.equal((await service.db.prepare('SELECT COUNT(*) AS n FROM upload_tokens').first()).n, 30);
  const storedRateKeys = await service.db.prepare('SELECT key FROM request_limits').all();
  assert.ok(storedRateKeys.results.every(row => /^[a-f0-9]{64}$/.test(row.key)));

  async function createOtherListing(ip, requestId) {
    const response = await service.request('/api/listings', { method: 'POST', headers: { 'cf-connecting-ip': ip }, body: baseListing({ clientRequestId: requestId, address: `${requestId} Test Street` }) });
    assert.equal(response.status, 201);
    return (await asJson(response)).listing;
  }
  const listing = await service.db.prepare('SELECT l.id FROM listings l ORDER BY l.created_at,l.id LIMIT 1').first();
  const secondListing = await createOtherListing('198.51.100.91', 'extra-listing-request-000001');
  const thirdListing = await createOtherListing('198.51.100.92', 'extra-listing-request-000002');
  async function grant(targetListingId, ip, n) {
    return service.request(`/api/listings/${targetListingId}/photo-upload-token`, {
      method: 'POST', headers: { 'cf-connecting-ip': ip },
      body: { clientRequestId: `visitor-grant-request-${String(n).padStart(8, '0')}` },
    });
  }
  const visitorIp = '203.0.113.101';
  let visitorToken;
  for (let n = 1; n <= 30; n++) {
    const response = await grant(listing.id, visitorIp, n);
    assert.equal(response.status, 200, `visitor grant ${n}`);
    assert.equal(response.headers.get('set-cookie'), null);
    visitorToken = (await asJson(response)).uploadToken;
  }
  assert.equal((await grant(secondListing.id, visitorIp, 31)).status, 429);
  assert.equal((await service.db.prepare('SELECT COUNT(*) AS n FROM upload_tokens WHERE listing_id=?').bind(secondListing.id).first()).n, 1);
  assert.equal((await service.db.prepare('SELECT COUNT(*) AS n FROM upload_tokens WHERE listing_id=?').bind(listing.id).first()).n, 31);

  // Different visitors still share a per-listing ceiling.
  for (let n = 1; n <= 30; n++) assert.equal((await grant(thirdListing.id, `192.0.2.${n}`, n + 100)).status, 200);
  assert.equal((await grant(thirdListing.id, '192.0.2.31', 131)).status, 429);
  assert.equal((await service.db.prepare('SELECT COUNT(*) AS n FROM upload_tokens WHERE listing_id=?').bind(thirdListing.id).first()).n, 31);

  const submitted = await upload(service, listing.id, visitorToken, 'visitor-photo-request-0001');
  assert.equal(submitted.status, 201);
  const photo = (await asJson(submitted)).photo;
  assert.equal(photo.status, 'pending');
  assert.equal((await service.request(`/api/photos/${photo.id}`)).status, 404);
  const display = await asJson(await service.request(`/api/listings?neighborhood=${neighborhoodId}&season=${seasonId}`));
  assert.ok(display.listings.some(item => item.id === listing.id && item.photos.length === 0));
  assert.equal((await service.db.prepare('SELECT COUNT(*) AS n FROM photos WHERE listing_id=?').bind(listing.id).first()).n, 1);
});

test('upload rate limit rejects excess traffic without placing objects in private R2', async t => {
  const service = await createTestService(); t.after(() => service.dispose());
  const { listing } = await createListing(service);
  for (let n = 1; n <= 90; n++) {
    const response = await service.request(`/api/listings/${listing.id}/photos`, {
      method: 'POST', headers: { authorization: 'Bearer ' + '0'.repeat(64), 'content-type': 'image/png', 'x-photo-request-id': `limited-upload-request-${String(n).padStart(8, '0')}`, 'cf-connecting-ip': '203.0.113.222' },
      body: validPng,
    });
    assert.equal(response.status, 403, `upload request ${n}`);
  }
  const blocked = await service.request(`/api/listings/${listing.id}/photos`, {
    method: 'POST', headers: { authorization: 'Bearer ' + '0'.repeat(64), 'content-type': 'image/png', 'x-photo-request-id': 'limited-upload-request-00000091', 'cf-connecting-ip': '203.0.113.222' },
    body: validPng,
  });
  assert.equal(blocked.status, 429);
  assert.equal((await service.db.prepare('SELECT COUNT(*) AS n FROM photos').first()).n, 0);
  assert.equal((await service.bucket.list({ prefix: 'photos/' })).objects.length, 0);
});

test('source geography rejects a pin outside the selected neighborhood map coverage', async t => {
  const service = await createTestService(); t.after(() => service.dispose());
  const invalid = await service.request('/api/listings', { method: 'POST', body: baseListing({ latitude: 40, longitude: -73 }) });
  assert.equal(invalid.status, 400);
  assert.equal((await asJson(invalid)).error.code, 'invalid_location');
  assert.equal((await service.db.prepare('SELECT COUNT(*) AS n FROM listings').first()).n, 0);
});
