import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const photoFixture = fileURLToPath(new URL('../fixtures/metadata-test.jpg', import.meta.url));
const metadataMarker = Buffer.from('SYNTHETIC_SERVICE_BROWSER_METADATA_MARKER');

test('a display publishes immediately, photos stay private until approval, and the approved photo appears on the public map', async ({ page }) => {
  const neighborhoodSeason = new URLSearchParams({ neighborhood: 'old-northeast', season: 'christmas-2026' });
  const before = await page.request.get(`/api/listings?${neighborhoodSeason}`).then(response => response.json());
  const startingListings = before.listings;
  await page.goto('/');
  await expect(page.locator('#loading')).toHaveCount(0);
  const startingCount = startingListings.length;
  await expect(page.locator('#sample-count')).toHaveText(`${startingCount} live ${startingCount === 1 ? 'display' : 'displays'}`);
  if (!startingCount) await expect(page.locator('#reference-list')).toHaveText('No live displays here yet.');
  for (const existing of startingListings) await expect(page.locator('#reference-list')).toContainText(existing.address);
  await expect(page.locator('.map-pin')).toHaveCount(startingCount);

  await page.getByRole('button', { name: 'Add a display', exact: true }).click();
  const random = randomUUID().slice(0, 8);
  const address = `900 ${random} Service Browser Ave NE, St Petersburg, FL`;
  await page.locator('#submission-address').fill(address);
  await page.locator('#submission-theme').fill('Service browser test lights');
  await page.locator('#submission-description').fill('A synthetic listing created by the isolated Worker browser test.');
  await page.locator('#submission-location-button').click();
  await expect(page.locator('#submission-location-map')).toBeVisible();
  await page.locator('#submission-location-confirm').click();
  await page.locator('#submission-location-match').check();
  await page.locator('summary').filter({ hasText: 'Add photos' }).click();
  await page.locator('#submission-photos').setInputFiles(photoFixture);
  await expect(page.locator('#submission-photo-previews img')).toHaveCount(1);

  const listingResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/listings');
  const photoResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && /^\/api\/listings\/[^/]+\/photos$/.test(new URL(response.url()).pathname));
  await page.getByRole('button', { name: 'Add to map', exact: true }).click();
  const [listingResponse, uiPhotoResponse] = await Promise.all([listingResponsePromise, photoResponsePromise]);
  expect(listingResponse.status()).toBe(201);
  expect(uiPhotoResponse.status()).toBe(201);
  const created = await listingResponse.json();
  const uiPhoto = await uiPhotoResponse.json();
  expect(created.listing).toMatchObject({ address, status: 'published', latitude: expect.any(Number), longitude: expect.any(Number) });
  expect(uiPhoto.photo.status).toBe('pending');
  await expect(page.locator('#submission-receipt')).toBeVisible();
  await expect(page.locator('#submission-receipt-title')).toHaveText('Your display is on the map');
  await expect(page.locator('#submission-photo-receipt')).toContainText('waiting for owner review');
  await expect(page.locator('#sample-count')).toHaveText(`${startingCount + 1} live ${(startingCount + 1) === 1 ? 'display' : 'displays'}`);
  await expect(page.locator('#references-title')).toHaveText('Live displays');
  await expect(page.locator('.canvas')).not.toHaveClass(/map-only/);
  await expect(page.locator('#reference-list')).toContainText(address);

  const privateUiPhoto = await page.request.get(`/api/photos/${uiPhoto.photo.id}`);
  expect(privateUiPhoto.status()).toBe(404);
  const query = neighborhoodSeason;
  const unpublishedPhotos = await page.request.get(`/api/listings?${query}`).then(response => response.json());
  const publishedListing = unpublishedPhotos.listings.find(listing => listing.id === created.listing.id);
  expect(publishedListing).toBeTruthy();
  expect(publishedListing.status).toBe('published');
  expect(publishedListing.photos).toEqual([]);

  // Send the fixture's original metadata-bearing bytes as a second pending
  // photo to exercise the Worker sanitizer independently of the browser's
  // canvas re-encoding step. The marker is synthetic and contains no GPS data.
  const rawFixture = await readFile(photoFixture);
  expect(rawFixture.includes(metadataMarker)).toBe(true);
  const directUpload = await page.evaluate(async ({ listingId, uploadToken, base64 }) => {
    const body = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const response = await fetch(`/api/listings/${encodeURIComponent(listingId)}/photos`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${uploadToken}`, 'Content-Type': 'image/jpeg', 'X-Photo-Request-Id': crypto.randomUUID() },
      body
    });
    return { status: response.status, body: await response.json() };
  }, { listingId: created.listing.id, uploadToken: created.uploadToken, base64: rawFixture.toString('base64') });
  expect(directUpload.status).toBe(201);
  expect(directUpload.body.photo.status).toBe('pending');
  expect((await page.request.get(`/api/photos/${directUpload.body.photo.id}`)).status()).toBe(404);

  const ownerPassword = process.env.SERVICE_BROWSER_OWNER_PASSWORD;
  expect(ownerPassword).toBeTruthy();
  const login = await page.evaluate(async password => {
    const response = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    return { status: response.status, body: await response.json() };
  }, ownerPassword);
  expect(login).toEqual({ status: 200, body: { authenticated: true } });
  const pending = await page.evaluate(async () => fetch('/api/admin/photos?status=pending').then(response => response.json()));
  const targetPhotos = pending.photos.filter(photo => photo.listing.id === created.listing.id);
  expect(targetPhotos.map(photo => photo.id).sort()).toEqual([uiPhoto.photo.id, directUpload.body.photo.id].sort());

  for (const photo of targetPhotos) {
    const decision = await page.evaluate(async ({ id, version }) => {
      const response = await fetch(`/api/admin/photos/${encodeURIComponent(id)}/decision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', expectedVersion: version })
      });
      return { status: response.status, body: await response.json() };
    }, { id: photo.id, version: photo.version });
    expect(decision.status).toBe(200);
    expect(decision.body.photo.status).toBe('approved');
  }

  const cleanedResponse = await page.request.get(`/api/photos/${directUpload.body.photo.id}`);
  expect(cleanedResponse.status()).toBe(200);
  expect(cleanedResponse.headers()['content-type']).toBe('image/jpeg');
  const cleanedBytes = await cleanedResponse.body();
  expect(cleanedBytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  expect(cleanedBytes.includes(metadataMarker)).toBe(false);

  const approved = await page.request.get(`/api/listings?${query}`).then(response => response.json());
  const approvedListing = approved.listings.find(listing => listing.id === created.listing.id);
  expect(approvedListing.photos.map(photo => photo.id).sort()).toEqual([uiPhoto.photo.id, directUpload.body.photo.id].sort());

  await page.goto(`/?listing=${encodeURIComponent(created.listing.id)}`);
  await expect(page.locator('#selection')).toBeVisible();
  await expect(page.locator('#detail-title')).toHaveText('Service browser test lights');
  await expect(page.locator('#selected-note')).toHaveText('A synthetic listing created by the isolated Worker browser test.');
  await expect(page.locator('#display-photos')).toBeVisible();
  await expect(page.locator('#display-photos img').first()).toBeVisible();
  await expect.poll(() => page.locator('#display-photos img').first().evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
});
