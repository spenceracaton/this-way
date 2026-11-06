import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createTestService, TEST_OWNER_PASSWORD } from './helpers/service-runtime.mjs';

const seasonId = 'christmas-2026';
const feedback = (overrides = {}) => ({ clientRequestId: randomUUID(), seasonId, message: '<script>Visitor feedback</script>', email: 'visitor@example.test', ...overrides });
const post = (service, path, body, headers = {}) => service.request(path, { method: 'POST', body, headers });
async function owner(service) {
  const response = await post(service, '/api/session', { password: TEST_OWNER_PASSWORD });
  assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie').split(';')[0] };
}
async function listing(service) {
  const response = await post(service, '/api/listings', { clientRequestId: randomUUID(), seasonId, neighborhoodId: 'old-northeast', address: '123 Reporting Test Street', title: 'Lights', tags: ['Lights'], latitude: 27.7923, longitude: -82.631 });
  assert.equal(response.status, 201);
  return (await response.json()).listing;
}

test('community messages validate, stay private, reuse identical requests, and preserve display visibility', async t => {
  const service = await createTestService(); t.after(() => service.dispose());
  const display = await listing(service), headers = await owner(service);
  const input = { clientRequestId: randomUUID(), seasonId, listingId: display.id, reason: 'incorrect-address', details: '<img src=x onerror=alert(1)>' };
  const created = await post(service, '/api/reports', input);
  assert.equal(created.status, 201); const receipt = await created.json();
  assert.deepEqual(Object.keys(receipt).sort(), ['id', 'recorded']);
  assert.deepEqual(await (await post(service, '/api/reports', input)).json(), receipt);
  assert.equal((await post(service, '/api/reports', { ...input, details: 'Changed' })).status, 409);
  const idea = feedback();
  const [first, second] = await Promise.all([post(service, '/api/feedback', idea), post(service, '/api/feedback', idea)]);
  assert.deepEqual((await first.json()).id, (await second.json()).id);
  assert.equal((await service.db.prepare('SELECT COUNT(*) AS n FROM reports').first()).n, 2);
  assert.equal((await post(service, '/api/reports', { ...input, seasonId: 'halloween-2026', clientRequestId: randomUUID() })).status, 404);
  for (const patch of [{ message: ' ' }, { message: 'x'.repeat(1001) }, { message: 'bad\u0000message' }, { email: 'broken' }, { seasonId: '__proto__' }, { forged: 'value' }]) {
    assert.equal((await post(service, '/api/feedback', feedback(patch))).status, 400);
  }
  assert.equal((await service.request('/api/feedback', { method: 'POST', origin: false, body: idea })).status, 403);
  assert.equal((await service.request('/api/feedback', { method: 'POST', body: 'x'.repeat(17000), headers: { 'content-type': 'application/json' } })).status, 413);
  assert.equal((await service.request('/api/admin/reports')).status, 401);
  assert.equal((await post(service, `/api/admin/reports/${receipt.id}/decision`, { status: 'dismissed', expectedVersion: 1 })).status, 401);
  const inbox = await (await service.request('/api/admin/reports', { headers })).json();
  assert.equal(inbox.reports.length, 2);
  const report = inbox.reports.find(row => row.kind === 'report');
  assert.equal(report.message, input.details); assert.equal(report.listing.address, display.address);
  const publicResponse = await service.request(`/api/listings?season=${seasonId}&neighborhood=old-northeast`);
  const publicText = await publicResponse.text();
  assert.equal(publicText.includes(idea.email), false); assert.equal(publicText.includes('onerror'), false);
  assert.equal(JSON.parse(publicText).listings[0].status, 'published');
});

test('owner dismiss/reopen uses versions, records audit events, and rejects concurrent stale decisions', async t => {
  const service = await createTestService(); t.after(() => service.dispose());
  const created = await (await post(service, '/api/feedback', feedback())).json(), headers = await owner(service);
  const path = `/api/admin/reports/${created.id}/decision`;
  assert.equal((await post(service, path, { status: 'dismissed' }, headers)).status, 400);
  const decisions = await Promise.all([post(service, path, { status: 'dismissed', expectedVersion: 1 }, headers), post(service, path, { status: 'dismissed', expectedVersion: 1 }, headers)]);
  assert.deepEqual(decisions.map(row => row.status).sort(), [200, 409]);
  assert.equal((await post(service, path, { status: 'open', expectedVersion: 1 }, headers)).status, 409);
  const dismissed = await (await service.request('/api/admin/reports?status=dismissed', { headers })).json();
  assert.equal(dismissed.reports[0].version, 2);
  assert.equal((await post(service, path, { status: 'open', expectedVersion: 2 }, headers)).status, 200);
  const events = (await service.db.prepare('SELECT status,version FROM report_review_events ORDER BY id').all()).results;
  assert.deepEqual(events, [{ status: 'dismissed', version: 2 }, { status: 'open', version: 3 }]);
  const counts = await (await service.request(`/api/neighborhood-counts?season=${seasonId}`)).json();
  assert.equal(counts.counts['old-northeast'], 0);
});

test('message limits allow safe retries and counts reflect only published displays in the requested season', async t => {
  const service = await createTestService(); t.after(() => service.dispose());
  const first = feedback();
  for (let i = 0; i < 12; i++) assert.equal((await post(service, '/api/feedback', i === 0 ? first : feedback())).status, 201);
  assert.equal((await post(service, '/api/feedback', feedback())).status, 429);
  assert.equal((await post(service, '/api/feedback', first)).status, 200);
  const display = await listing(service);
  const counts = async selected => (await (await service.request(`/api/neighborhood-counts?season=${selected}`)).json()).counts;
  assert.equal((await counts(seasonId))['old-northeast'], 1);
  assert.equal((await counts('halloween-2026'))['old-northeast'], 0);
  assert.ok(Object.keys(await counts(seasonId)).length > 2);
  assert.equal((await counts(seasonId))['crescent-lake'], 0);
  assert.equal((await service.request('/api/neighborhood-counts?season=__proto__')).status, 400);
  await service.db.prepare("UPDATE listings SET status='hidden' WHERE id=?").bind(display.id).run();
  assert.equal((await counts(seasonId))['old-northeast'], 0);
});

test('inbox migration preserves legacy reports and supports nullable feedback targets', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
    db.exec("INSERT INTO seasons(id,kind,name) VALUES('test','test','Test'); INSERT INTO locations(id,address,created_at,updated_at) VALUES('loc','Test',1,1); INSERT INTO listings(id,location_id,season_id,created_at,updated_at) VALUES('lst','loc','test',1,1); INSERT INTO reports(id,listing_id,season_id,message,created_at,dismissed_at,version) VALUES('legacy','lst','test','Original message',1,2,4)");
    db.exec(await readFile(new URL('../migrations/0003_community_inbox.sql', import.meta.url), 'utf8'));
    const saved = db.prepare('SELECT * FROM reports').get();
    assert.equal(saved.kind, 'report'); assert.equal(saved.message, 'Original message'); assert.equal(saved.dismissed_at, 2); assert.equal(saved.version, 4);
    db.exec("INSERT INTO reports(id,kind,season_id,message,created_at) VALUES('idea','feedback','test','Idea',3)");
    assert.equal(db.prepare("SELECT listing_id FROM reports WHERE id='idea'").get().listing_id, null);
  } finally { db.close(); }
});

test('owner inbox pagination stays bounded and returns each stored message once', async t => {
  const service = await createTestService(); t.after(() => service.dispose());
  await post(service, '/api/feedback', feedback());
  await service.db.batch(Array.from({ length: 103 }, (_, index) => service.db.prepare("INSERT INTO reports(id,kind,season_id,message,created_at) VALUES(?,'feedback',?,'Synthetic paginated message',?)").bind(`page-${String(index).padStart(3, '0')}`, seasonId, 100 + Math.floor(index / 2))));
  const headers = await owner(service);
  const first = await (await service.request('/api/admin/reports?status=open', { headers })).json();
  assert.equal(first.reports.length, 100); assert.ok(first.nextCursor);
  const second = await (await service.request(`/api/admin/reports?status=open&before=${first.nextCursor}`, { headers })).json();
  assert.equal(second.reports.length, 4); assert.equal(second.nextCursor, null);
  const rows = [...first.reports, ...second.reports];
  assert.equal(new Set(rows.map(row => row.id)).size, 104);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].createdAt >= rows[i].createdAt);
  assert.equal((await service.request('/api/admin/reports?before=invalid%20cursor', { headers })).status, 400);
});
