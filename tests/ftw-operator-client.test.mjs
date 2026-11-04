import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FtwOperatorCloudflare, OperatorTransportError, executeOperatorRpc } from '../scripts/lib/ftw-operator-cloudflare.mjs';
import { materializeOperatorPayload, parseOperatorPayload } from '../scripts/lib/ftw-operator-payload.mjs';
import { verifyOperatorAdmission, verifyPublicPilot, verifyPublicRestore } from '../scripts/run-ftw-operator.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const acct = '60b5930216f6049236d2634115cbe0ce';
const script = `this-way-ftw-op-${'a'.repeat(32)}`;
const uuid = '12345678-1234-1234-1234-123456789abc';
const privateBucket = 'this-way-operator-private';
const ok = (result, status = 200) => new Response(JSON.stringify({ success: true, result }), { status, headers: { 'content-type': 'application/json' } });
const jsonError = status => new Response('', { status });

function cloudflare(fetcher, extra = {}) {
  return new FtwOperatorCloudflare({ accountId: acct, token: 'synthetic-test-token', fetcher, ...extra });
}

test('Cloudflare target uses account-scoped bearer requests and resolves one exact paginated D1 name', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer synthetic-test-token');
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'api.cloudflare.com');
    assert.ok(parsed.pathname.startsWith(`/client/v4/accounts/${acct}/`));
    if (parsed.pathname.endsWith('/d1/database') && parsed.searchParams.get('page') === '1') {
      return ok(Array.from({ length: 100 }, (_, i) => ({ name: `other-${i}`, uuid })));
    }
    if (parsed.pathname.endsWith('/d1/database') && parsed.searchParams.get('page') === '2') return ok([{ name: 'this-way-listings', uuid }]);
    if (parsed.pathname.endsWith(`/d1/database/${uuid}`)) return ok({ name: 'this-way-listings', uuid });
    if (parsed.pathname.endsWith('/r2/buckets/this-way-photos')) return ok({ name: 'this-way-photos' });
    if (parsed.pathname.endsWith(`/r2/buckets/${privateBucket}`)) return ok({ name: privateBucket });
    if (parsed.pathname.endsWith(`/r2/buckets/${privateBucket}/domains/managed`)) return ok({ enabled: false });
    if (parsed.pathname.endsWith(`/r2/buckets/${privateBucket}/domains/custom`)) return ok({ domains: [] });
    if (parsed.pathname.endsWith('/workers/subdomain')) return ok({ subdomain: 'test-account' });
    throw new Error(`unexpected URL ${url}`);
  };
  const target = await cloudflare(fetcher).target();
  assert.deepEqual(target, { accountId: acct, databaseId: uuid, databaseName: 'this-way-listings', bucketName: 'this-way-photos', controlBucketName: privateBucket, subdomain: 'test-account' });
  assert.deepEqual(calls.slice(0, 2).map(call => new URL(call.url).searchParams.get('page')), ['1', '2']);
  assert.ok(calls.every(call => new URL(call.url).hostname === 'api.cloudflare.com'));
});

test('target creates only a missing dedicated control bucket and rejects a public control domain before upload', async () => {
  const calls = [];
  const client = cloudflare(async (url, init) => {
    const path = new URL(url).pathname.replace(`/client/v4/accounts/${acct}`, '');
    calls.push({ path, method: init.method || 'GET', body: init.body });
    if (path === '/d1/database') return ok([{ name: 'this-way-listings', uuid }]);
    if (path === `/d1/database/${uuid}`) return ok({ name: 'this-way-listings', uuid });
    if (path === '/r2/buckets/this-way-photos') return ok({ name: 'this-way-photos' });
    if (path === '/workers/subdomain') return ok({ subdomain: 'test-account' });
    if (path === '/r2/buckets' && init.method === 'POST') return ok({ name: privateBucket });
    if (path === `/r2/buckets/${privateBucket}`) return jsonError(404);
    if (path.endsWith('/domains/managed')) return ok({ enabled: false });
    if (path.endsWith('/domains/custom')) return ok({ domains: [{ enabled: true }] });
    if (path.includes('/objects/')) return ok({});
    throw new Error(`unexpected ${init.method} ${path}`);
  });
  await assert.rejects(client.target(), error => error.code === 'control_storage_not_private');
  const creates = calls.filter(call => call.method === 'POST');
  assert.deepEqual(creates.map(call => [call.path, JSON.parse(call.body)]), [[`/r2/buckets`, { name: privateBucket }]]);
  assert.equal(calls.some(call => call.path.includes('/objects/')), false);
  assert.equal(calls.some(call => call.path === '/d1/database' && call.method === 'POST'), false);
  assert.equal(calls.some(call => call.path === '/r2/buckets/this-way-photos' && call.method === 'POST'), false);
});

test('Cloudflare target rejects duplicate exact D1 names and does not create a database', async () => {
  const calls = [];
  const client = cloudflare(async (url, init) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    return ok([{ name: 'this-way-listings', uuid }, { name: 'this-way-listings', uuid: '87654321-1234-1234-1234-123456789abc' }]);
  });
  await assert.rejects(client.target(), error => error.code === 'destination_database_ambiguous');
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.equal(calls.some(call => /\/d1\/database$/.test(new URL(call.url).pathname) && call.method !== 'GET'), false);
});

for (const [workerStatus, secretStatus] of [[200,200], [201,200], [200,201], [201,201]]) {
test(`deployment accepts Worker ${workerStatus}/secret ${secretStatus}, verifies private bytes, and enables only after authentication`, async () => {
  const events = [];
  let marker;
  let objectBytes;
  const client = cloudflare(async (url, init) => {
    const u = new URL(url), path = u.pathname.replace(`/client/v4/accounts/${acct}`, '');
    events.push({ path, method: init.method || 'GET', headers: init.headers, body: init.body });
    if (path.includes('/objects/')) {
      if (path.endsWith('/domains/managed')) return ok({ enabled: false });
      if (path.endsWith('/domains/custom')) return ok({ domains: [] });
      if (init.method === 'PUT') { objectBytes = new Uint8Array(await new Response(init.body).arrayBuffer()); return jsonError(200); }
      return new Response(objectBytes);
    }
    if (path.endsWith(`/r2/buckets/${privateBucket}/domains/managed`)) return ok({ enabled: false });
    if (path.endsWith(`/r2/buckets/${privateBucket}/domains/custom`)) return ok({ domains: [] });
    if (path.includes(`/r2/buckets/${privateBucket}/objects/`)) {
      if (init.method === 'PUT') { objectBytes = new Uint8Array(await new Response(init.body).arrayBuffer()); return jsonError(200); }
      return new Response(objectBytes);
    }
    if (path === `/workers/scripts/${script}` && !init.method) return jsonError(404);
    if (path === `/workers/scripts/${script}` && init.method === 'PUT') {
      assert.ok(init.body instanceof FormData);
      assert.equal(init.headers['content-type'], undefined, 'fetch must generate the multipart boundary');
      const metadata = JSON.parse(init.body.get('metadata'));
      marker = metadata.bindings.find(binding => binding.name === 'OPERATOR_OWNER_MARKER').text;
      assert.deepEqual(metadata.bindings.filter(binding => binding.type === 'r2_bucket').map(binding => [binding.name, binding.bucket_name]), [
        ['PHOTOS', 'this-way-photos'], ['CONTROL', privateBucket]
      ]);
      assert.equal(metadata.observability.enabled, false);
      return ok({}, workerStatus);
    }
    if (path === `/workers/scripts/${script}/secrets`) {
      assert.equal(init.method, 'PUT');
      assert.equal(JSON.parse(init.body).name, 'OPERATOR_TOKEN');
      return ok({}, secretStatus);
    }
    if (path === `/workers/scripts/${script}/subdomain`) {
      const enabled = JSON.parse(init.body).enabled;
      events.at(-1).enabled = enabled;
      return ok({});
    }
    throw new Error(`unexpected ${init.method} ${path}`);
  });
  // Marker is read from the deployment form; use a mutable binding for that mock.
  let actualMarker;
  const original = client.fetcher;
  client.fetcher = async (url, init) => {
    const result = await original(url, init);
    const path = new URL(url).pathname;
    if (path.endsWith(`/workers/scripts/${script}`) && init.method === 'PUT') actualMarker = marker;
    return result;
  };
  const bytes = Buffer.from('{"synthetic":true}');
  const key = `ftw-operator/${'b'.repeat(32)}/command.json`;
  const endpoint = await client.deploy({ scriptName: script, source: 'export default {}', target: { databaseId: uuid, bucketName: 'this-way-photos', controlBucketName: privateBucket, accountId: acct, subdomain: 'test-account' }, command: { runId: 'b'.repeat(32), expiresAt: 1 }, commandKey: key, commandBytes: bytes });
  assert.equal(sha(objectBytes), sha(bytes));
  assert.equal(endpoint.url, `https://${script}.test-account.workers.dev/execute`);
  assert.equal(actualMarker, client.ownershipMarkers.get(script));
  const steps = events.filter(event => event.path.endsWith('/subdomain') || event.path.endsWith('/secrets'));
  assert.deepEqual(steps.map(event => [event.path.endsWith('/secrets') ? 'secret' : 'subdomain', event.enabled]), [
    ['subdomain', false], ['secret', undefined], ['subdomain', true]
  ]);
  assert.equal(events.find(event => event.path.includes('/objects/') && event.method === 'PUT').headers['if-none-match'], '*');
});

}

test('cleanup requires the exact owner marker before disabling or deleting', async () => {
  const calls = [];
  const client = cloudflare(async (url, init) => {
    calls.push({ path: new URL(url).pathname, method: init.method || 'GET' });
    return ok({ bindings: [{ type: 'plain_text', name: 'OPERATOR_OWNER_MARKER', text: 'not-ours' }] });
  });
  client.claimedScripts.add(script);
  client.ownershipMarkers.set(script, 'ours');
  const outcome = await client.cleanup(script);
  assert.deepEqual(outcome, { verified: false, ownershipMismatch: true });
  assert.deepEqual(calls, [{ path: `/client/v4/accounts/${acct}/workers/scripts/${script}/settings`, method: 'GET' }]);
});

test('cleanup never deletes an existing unclaimed worker; lost upload response preserves a marker for recovery', async () => {
  let deletes = 0;
  const existing = cloudflare(async () => jsonError(200));
  await assert.rejects(existing.deploy({ scriptName: script, source: '', target: { accountId: acct, databaseId: uuid, bucketName: 'this-way-photos', controlBucketName: privateBucket }, command: {}, commandKey: '', commandBytes: Buffer.alloc(0) }), error => error.code === 'temporary_worker_already_exists');
  assert.deepEqual(await existing.cleanup(script), { verified: false });

  let marker;
  let commandObject;
  const client = cloudflare(async (url, init) => {
    const path = new URL(url).pathname.replace(`/client/v4/accounts/${acct}`, '');
    if (path.includes('/objects/')) { if (init.method === 'PUT') { commandObject = Buffer.from(init.body); return jsonError(200); } return new Response(commandObject); }
    if (path.endsWith(`/r2/buckets/${privateBucket}/domains/managed`)) return ok({ enabled: false });
    if (path.endsWith(`/r2/buckets/${privateBucket}/domains/custom`)) return ok({ domains: [] });
    if (path.includes(`/r2/buckets/${privateBucket}/objects/`)) { if (init.method === 'PUT') { commandObject = Buffer.from(init.body); return jsonError(200); } return new Response(commandObject); }
    if (path === `/workers/scripts/${script}` && !init.method) return jsonError(404);
    if (path === `/workers/scripts/${script}` && init.method === 'PUT') {
      const metadata = JSON.parse(init.body.get('metadata'));
      marker = metadata.bindings.find(binding => binding.name === 'OPERATOR_OWNER_MARKER').text;
      throw new TypeError('synthetic lost response after upload');
    }
    if (path === `/workers/scripts/${script}/settings`) return ok({ bindings: [{ type: 'plain_text', name: 'OPERATOR_OWNER_MARKER', text: marker }] });
    if (path === `/workers/scripts/${script}/subdomain`) return ok({});
    if (path === `/workers/scripts/${script}` && init.method === 'DELETE') { deletes++; return ok({}); }
    if (path === `/workers/scripts/${script}`) return jsonError(404);
    throw new Error(`unexpected ${path}`);
  });
  const commandBytes = Buffer.from('{}');
  await assert.rejects(client.deploy({ scriptName: script, source: '', target: { databaseId: uuid, bucketName: 'this-way-photos', controlBucketName: privateBucket, accountId: acct, subdomain: 'test-account' }, command: { runId: 'b'.repeat(32), expiresAt: 1 }, commandKey: `ftw-operator/${'b'.repeat(32)}/command.json`, commandBytes }));
  assert.ok(client.ownershipMarkers.has(script));
  assert.deepEqual(await client.cleanup(script), { verified: true });
  assert.equal(deletes, 1);
});

test('R2 upload failure prevents worker upload', async () => {
  const writes = [];
  const client = cloudflare(async (url, init) => {
    const path = new URL(url).pathname;
    writes.push({ path, method: init.method || 'GET' });
    if (path.endsWith(`/r2/buckets/${privateBucket}/domains/managed`)) return ok({ enabled: false });
    if (path.endsWith(`/r2/buckets/${privateBucket}/domains/custom`)) return ok({ domains: [] });
    if (path.endsWith(`/workers/scripts/${script}`) && !init.method) return jsonError(404);
    if (path.includes('/objects/')) return jsonError(403);
    throw new Error('worker must not be uploaded');
  });
  await assert.rejects(client.deploy({ scriptName: script, source: '', target: { databaseId: uuid, bucketName: 'this-way-photos', controlBucketName: privateBucket, accountId: acct, subdomain: 'test-account' }, command: { runId: 'b'.repeat(32), expiresAt: 1 }, commandKey: `ftw-operator/${'b'.repeat(32)}/command.json`, commandBytes: Buffer.from('{}') }), error => error.code === 'cloudflare_http_403');
  assert.equal(writes.some(write => write.path.endsWith(`/workers/scripts/${script}`) && write.method === 'PUT'), false);
});

test('RPC pins its workers.dev endpoint, rejects redirects, and retries transient 404 or unknown response', async () => {
  let calls = 0;
  const endpoint = { url: `https://${script}.test-account.workers.dev/execute`, token: 'private' };
  const result = await executeOperatorRpc({ endpoint, body: '{}', expiresAt: Date.now() + 60_000, wait: async () => {}, fetcher: async (url, init) => {
    calls++;
    assert.equal(init.redirect, 'error');
    assert.equal(new URL(url).hostname, `${script}.test-account.workers.dev`);
    if (calls === 1) return jsonError(404);
    if (calls === 2) throw new TypeError('response lost');
    return ok({ ok: true });
  } });
  assert.equal(calls, 3);
  assert.equal(result.data.result.ok, true);
  for (const url of [`https://attacker.example/execute`, `https://${script}.test-account.workers.dev/execute?x=1`, `https://${script}.test-account.workers.dev/other`]) {
    let fetched = false;
    await assert.rejects(executeOperatorRpc({ endpoint: { url, token: 'x' }, expiresAt: Date.now() + 60_000, fetcher: async () => { fetched = true; } }), error => error.code === 'invalid_operator_endpoint');
    assert.equal(fetched, false);
  }
  await assert.rejects(executeOperatorRpc({ endpoint, expiresAt: Date.now() + 60_000, wait: async () => {}, fetcher: async (_url, init) => { assert.equal(init.redirect, 'error'); return Response.redirect('https://attacker.example/'); } }), error => error.code === 'operator_outcome_unknown');
});

const checkedSha = 'c'.repeat(40);
function admissionEnv(overrides = {}) {
  return { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'spenceracaton/this-way', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: checkedSha, PUBLISHING_PAUSED: 'false', GITHUB_TOKEN: 'synthetic', ...overrides };
}
function admissionFetcher({ head = checkedSha, pipeline = true, live = checkedSha } = {}) {
  return async url => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.github.com' && parsed.pathname.endsWith('/commits/main')) return new Response(JSON.stringify({ sha: head }));
    if (parsed.hostname === 'api.github.com' && parsed.pathname.endsWith('/actions/workflows/check.yml/runs')) return new Response(JSON.stringify({ workflow_runs: pipeline ? [{ head_sha: checkedSha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' }] : [] }));
    if (parsed.hostname === 'this-way.spencercaton.workers.dev') return new Response(JSON.stringify({ commit: live, release_id: 'synthetic-release' }));
    throw new Error(`unexpected host ${parsed.hostname}`);
  };
}

test('operator admission rejects wrong repository, ref, pause state, main SHA, CI result, and live SHA', async () => {
  for (const env of [
    admissionEnv({ GITHUB_REPOSITORY: 'attacker/fork' }),
    admissionEnv({ GITHUB_REF: 'refs/heads/feature' }),
    admissionEnv({ PUBLISHING_PAUSED: 'true' })
  ]) await assert.rejects(verifyOperatorAdmission(env, admissionFetcher()), error => error.code === 'operator_admission_rejected');
  await assert.rejects(verifyOperatorAdmission(admissionEnv(), admissionFetcher({ head: 'd'.repeat(40) })), error => error.code === 'main_changed_before_operation');
  await assert.rejects(verifyOperatorAdmission(admissionEnv(), admissionFetcher({ pipeline: false })), error => error.code === 'checked_main_required');
  await assert.rejects(verifyOperatorAdmission(admissionEnv(), admissionFetcher({ live: 'd'.repeat(40) })), error => error.code === 'verified_main_not_live');
  const admitted = await verifyOperatorAdmission(admissionEnv(), admissionFetcher());
  assert.equal(admitted.commit, checkedSha);
});

const fixture = await readFile(new URL('./fixtures/metadata-test.jpg', import.meta.url));
function fixtureRecords() {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `synthetic-listing-${index + 1}`, season_year: 2026, address: `1${index} Synthetic St`, status: 'approved',
    created_at: 1790000000000 + index, title: `Synthetic theme ${index + 1}`, theme: `Synthetic theme ${index + 1}`,
    level: 1, tags: ['family'], custom_tags: [], featured: index === 0,
    address_match: { neighborhoodId: 'old-northeast' },
    photos: index === 0 ? [{ id: 'synthetic-photo-1', object_key: 'synthetic-source-object', status: 'approved', created_at: 1790000000001 }] : []
  }));
}

async function makePayload(t, { photoUrl = 'https://frightthisway.com/api/photos/synthetic-photo-1', hash = fixture, currentTheme, photoResponse, maxPhotoBytes } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ftw-operator-client-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const records = fixtureRecords();
  const payload = { version: 1, bundle: {
    schemaVersion: 1,
    provenance: { kind: 'authenticated-content-export', sourceSystem: 'fright-this-way', captureId: 'synthetic-capture', capturedAt: '2026-10-31T00:00:00Z', authoritativeSystem: 'synthetic fixture', exporterVersion: 'test', complete: true, timestampUnit: 'milliseconds', unavailableFields: [], scope: { seasons: [2026], neighborhoods: ['old-northeast'] } },
    records,
    locationManifest: Object.fromEntries(records.map((record, i) => [record.id, { neighborhoodId: 'old-northeast', latitude: 27.7 + i / 1000, longitude: -82.6 - i / 1000 }])),
    assetManifest: { assets: [{ sourceKey: 'synthetic-source-object', path: `assets/${sha('synthetic-source-object')}.jpg`, mediaType: 'image/jpeg', width: 96, height: 72, originalContentHash: `sha256:${sha(hash)}`, downloadUrl: photoUrl }] }
  } };
  const raw = JSON.stringify(payload);
  const publicRows = records.map((record, i) => ({ id: record.id, address: record.address,
    destination: { lat: 27.7 + i / 1000, lng: -82.6 - i / 1000 }, theme: i === 0 && currentTheme ? currentTheme : record.theme,
    level: record.level, tags: record.tags, customTags: record.custom_tags, featured: record.featured }));
  const fetcher = async (url, init = {}) => {
    if (typeof url === 'string' && url.includes('/api/displays?')) return new Response(JSON.stringify({ displays: publicRows }), { status: 200 });
    if (String(url).includes('/api/photos/')) {
      if (init.redirect !== 'error') throw new Error('photo fetch must reject redirects');
      const bytes = photoResponse ?? fixture;
      const served = maxPhotoBytes ? Buffer.alloc(maxPhotoBytes + 1) : bytes;
      return new Response(served, { status: 200, headers: maxPhotoBytes ? {} : { 'content-length': String(served.length) } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { payload, raw, directory, fetcher };
}

test('payload materialization verifies five approved records, current public DTO fields, JPEG bytes, hash, and source URL', async t => {
  const { payload, raw, directory, fetcher } = await makePayload(t);
  assert.equal(parseOperatorPayload(raw, sha(raw)).bundle.records.length, 5);
  const result = await materializeOperatorPayload(payload, { directory, fetcher });
  assert.equal(result.input.records.length, 5);
  assert.equal(result.revalidated.publicListingsRevalidated, 5);
  assert.equal(result.fetched[0].sha256, sha(fixture));
  assert.equal(result.input.records[0].photos.length, 1);
  assert.equal(result.input.assetManifest.assets.length, 1);
  assert.equal('downloadUrl' in payload.bundle.assetManifest.assets[0], true, 'materialization clones before removing private download URLs');
  const source = JSON.parse(await readFile(join(directory, 'bundle.json'), 'utf8'));
  assert.equal('downloadUrl' in source.assetManifest.assets[0], false);
});

test('payload and photo admission reject digest, source DTO drift, bad host/path/query, redirect, changed bytes, and size overflow', async t => {
  const good = await makePayload(t);
  assert.throws(() => parseOperatorPayload(good.raw, '0'.repeat(64)), error => error.code === 'pilot_payload_digest_mismatch');
  const changed = await makePayload(t, { currentTheme: 'changed synthetic theme' });
  await assert.rejects(materializeOperatorPayload(changed.payload, { directory: changed.directory, fetcher: changed.fetcher }), error => error.code === 'source_changed_since_pilot_review');
  for (const photoUrl of [
    'https://evil.example/api/photos/synthetic-photo-1',
    'https://frightthisway.com/api/photos/other-photo',
    'https://frightthisway.com/api/photos/synthetic-photo-1?download=1'
  ]) {
    const invalid = await makePayload(t, { photoUrl });
    await assert.rejects(materializeOperatorPayload(invalid.payload, { directory: invalid.directory, fetcher: invalid.fetcher }), error => error.code === 'source_photo_url_invalid');
  }
  const redirect = await makePayload(t);
  redirect.fetcher = async (url, init) => {
    if (String(url).includes('/api/photos/')) { assert.equal(init.redirect, 'error'); return Response.redirect('https://evil.example/'); }
    return good.fetcher(url, init);
  };
  await assert.rejects(materializeOperatorPayload(redirect.payload, { directory: redirect.directory, fetcher: redirect.fetcher }), error => error.code === 'remote_content_unavailable');
  const changedBytes = await makePayload(t, { photoResponse: Buffer.from('changed') });
  await assert.rejects(materializeOperatorPayload(changedBytes.payload, { directory: changedBytes.directory, fetcher: changedBytes.fetcher }), error => error.code === 'source_photo_changed');
  const oversized = await makePayload(t, { maxPhotoBytes: 2 * 1024 * 1024 });
  await assert.rejects(materializeOperatorPayload(oversized.payload, { directory: oversized.directory, fetcher: oversized.fetcher }), error => error.code === 'remote_content_too_large');
});

function replayFixture() {
  const listings = Array.from({ length: 5 }, (_, i) => ({ id: `replay-listing-${i + 1}`, title: `Replay ${i + 1}`, location_id: `replay-location-${i + 1}` }));
  const locations = listings.map((row, i) => ({ id: row.location_id, address: `${i + 1} Replay St`, neighborhood_id: 'old-northeast' }));
  const photoBytes = Buffer.from('synthetic selected photo bytes');
  const photo = { id: 'replay-photo-1', listing_id: listings[0].id, position: 0, content_hash: `sha256:${sha(photoBytes)}` };
  const checkpoint = { artifact: {
    baseline: { listings, locations, photos: [photo] },
    plan: { listings: [], locations: [], photos: [], decisions: [
      ...listings.map(row => ({ entityType: 'listing', canonicalId: row.id })),
      { entityType: 'photo', canonicalId: photo.id }
    ] }
  } };
  const publicListings = listings.map((row, i) => ({ id: row.id, title: row.title, address: locations[i].address,
    seasonId: 'halloween-2026', photos: i === 0 ? [{ id: photo.id }, { id: 'other-user-photo' }] : [] }));
  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/listings') return new Response(JSON.stringify({ listings: publicListings }));
    if (parsed.pathname === `/api/photos/${photo.id}`) return new Response(photoBytes);
    if (parsed.pathname === '/api/config') return new Response(JSON.stringify({ available: true, season: { id: 'christmas-2026' } }));
    throw new Error(`unexpected verification URL ${url}`);
  };
  return { checkpoint, fetcher, publicListings, photoBytes };
}

test('public replay verification covers baseline-only decisions, selected photo bytes, and tolerates unrelated gallery photos', async () => {
  const { checkpoint, fetcher } = replayFixture();
  assert.deepEqual(await verifyPublicPilot(checkpoint, fetcher), { listingsVerified: 5, photosVerified: 1, activeSeason: 'christmas-2026' });
});

test('public replay verification rejects missing listings, wrong selected photo bytes, and duplicate public source IDs', async () => {
  const missing = replayFixture();
  missing.publicListings.pop();
  await assert.rejects(verifyPublicPilot(missing.checkpoint, missing.fetcher), error => error.code === 'public_pilot_verification_failed');

  const wrongPhoto = replayFixture();
  wrongPhoto.fetcher = async url => String(url).includes('/api/photos/') ? new Response('wrong synthetic bytes') : replayFixture().fetcher(url);
  await assert.rejects(verifyPublicPilot(wrongPhoto.checkpoint, wrongPhoto.fetcher), error => error.code === 'public_photo_verification_failed');

  const duplicate = replayFixture();
  duplicate.publicListings.push({ ...duplicate.publicListings[0] });
  await assert.rejects(verifyPublicPilot(duplicate.checkpoint, duplicate.fetcher), error => error.code === 'duplicate_public_listing');
});

test('public restore verification checks inserted IDs and photo routes without deleting unrelated public data', async () => {
  const checkpoint = { artifact: {
    baseline: { locations: [] },
    plan: { locations: [{ id: 'restore-location', neighborhood_id: 'old-northeast' }] },
    ops: [
      { table: 'listings', kind: 'insert', after: { id: 'inserted-listing', location_id: 'restore-location' } },
      { table: 'photos', kind: 'insert', after: { id: 'inserted-photo' } }
    ]
  } };
  let listings = [{ id: 'another-user-listing' }], photoStatus = 404;
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (String(url).includes('/api/listings?')) return new Response(JSON.stringify({ listings }));
    if (String(url).endsWith('/api/photos/inserted-photo')) return new Response('', { status: photoStatus });
    throw new Error(`unexpected restore verification URL ${url}`);
  };
  assert.deepEqual(await verifyPublicRestore(checkpoint, fetcher), { insertedListingsAbsent: 1, insertedPhotoRoutesPrivate: 1 });
  listings = [...listings, { id: 'inserted-listing' }];
  await assert.rejects(verifyPublicRestore(checkpoint, fetcher), error => error.code === 'public_restore_verification_failed');
  listings = [{ id: 'another-user-listing' }];
  photoStatus = 200;
  await assert.rejects(verifyPublicRestore(checkpoint, fetcher), error => error.code === 'public_restore_photo_still_available');
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('private exchange reads enforce privacy, exact path, streamed limits and fixed parse errors', async () => {
  const exchange = 'e'.repeat(32), calls = [];
  let body = '{}', publicBucket = false;
  const client = cloudflare(async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method || 'GET' });
    if (path.endsWith('/domains/managed')) return ok({ enabled: publicBucket });
    if (path.endsWith('/domains/custom')) return ok({ domains: [] });
    assert.equal(path, `/client/v4/accounts/${acct}/r2/buckets/${privateBucket}/objects/ftw-operator/${exchange}/exchange.json`);
    return body === null ? jsonError(404) : new Response(body);
  });
  assert.deepEqual(await client.readPrivateExchange(exchange), {});
  body = null;
  assert.equal(await client.readPrivateExchange(exchange), null);
  for (body of ['invalid private data', 'x'.repeat(16 * 1024 + 1)]) {
    await assert.rejects(client.readPrivateExchange(exchange), error => error.code === 'private_exchange_invalid' && !error.message.includes('private data'));
  }
  publicBucket = true;
  const before = calls.filter(call => call.path.includes('/objects/')).length;
  await assert.rejects(client.readPrivateExchange(exchange), error => error.code === 'control_storage_not_private');
  assert.equal(calls.filter(call => call.path.includes('/objects/')).length, before);
  await assert.rejects(client.readPrivateExchange('../command'), error => error.code === 'invalid_exchange_id');
});

test('exchange revocation touches only its exact private key and requires confirmed absence', async () => {
  const exchange = 'e'.repeat(32), calls = [];
  let stillPresent = false;
  const client = cloudflare(async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/domains/managed')) return ok({ enabled: false });
    if (path.endsWith('/domains/custom')) return ok({ domains: [] });
    calls.push({ path, method: init.method || 'GET' });
    assert.equal(path, `/client/v4/accounts/${acct}/r2/buckets/${privateBucket}/objects/ftw-operator/${exchange}/exchange.json`);
    return init.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonError(stillPresent ? 200 : 404);
  });
  assert.deepEqual(await client.deletePrivateExchange(exchange), { verified: true });
  assert.deepEqual(calls.map(call => call.method), ['DELETE', 'GET']);
  stillPresent = true;
  await assert.rejects(client.deletePrivateExchange(exchange), error => error.code === 'exchange_revocation_unverified');
});
