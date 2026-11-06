import { test, expect } from '@playwright/test';

const password = 'review-test-passphrase';
const seedPhotos = () => ({
  pending: [{ id: 'photo-1', status: 'pending', version: 1, createdAt: 1791000000000, url: '/api/admin/photos/photo-1/content', listing: { id: 'listing-1', address: '<img src=x onerror=alert(1)>', title: 'Warm porch', description: 'A few lights and greenery.', neighborhoodId: 'old-northeast', tags: ['Lights'], status: 'published', version: 2, contactEmail: 'private@example.test' } }, { id: 'photo-2', status: 'pending', version: 3, createdAt: 1791000000001, listing: { id: 'listing-2', address: '45 Example Ave', title: 'Window stars', description: 'Paper stars.', neighborhoodId: 'crescent-lake' } }],
  approved: [], rejected: []
});

async function installService(page, { conflictOnce = false } = {}) {
  const state = { authenticated: false, contentRequested: false, photos: seedPhotos(), listings: [
    { id: 'listing-1', address: '123 Test Street', title: 'Warm porch', description: 'A few lights and greenery.', neighborhoodId: 'old-northeast', tags: ['Lights'], status: 'published', version: 2, createdAt: 1791000000000, contactEmail: 'private@example.test' },
    { id: 'listing-hidden', address: '8 Hidden Lane', title: 'Lanterns', description: 'Small paper lanterns.', neighborhoodId: 'crescent-lake', tags: [], status: 'hidden', version: 4, createdAt: 1791000000001 }
  ], conflictOnce };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/config' && request.method() === 'GET') return json({ available: true, season: { id: '2026', name: 'Winter 2026' }, limits: { photos: 3, maxPhotoBytes: 2097152 } });
    if (path === '/api/session' && request.method() === 'GET') return json({ authenticated: state.authenticated });
    if (path === '/api/session' && request.method() === 'POST') {
      const body = request.postDataJSON();
      if (body.password !== password) return json({ error: { code: 'invalid_password', message: 'That password did not match.' } }, 401);
      state.authenticated = true; return json({ authenticated: true });
    }
    if (path === '/api/session' && request.method() === 'DELETE') { state.authenticated = false; return json({ authenticated: false }); }
    if (!state.authenticated) return json({ error: { code: 'sign_in_required', message: 'Sign in to review photos and manage displays.' } }, 401);
    const photoMatch = path.match(/^\/api\/admin\/photos\/([^/]+)\/decision$/);
    if (photoMatch && request.method() === 'POST') {
      const id = decodeURIComponent(photoMatch[1]);
      const body = request.postDataJSON();
      const currentStatus = Object.keys(state.photos).find(status => state.photos[status].some(photo => photo.id === id));
      const record = currentStatus && state.photos[currentStatus].find(photo => photo.id === id);
      if (state.conflictOnce) { state.conflictOnce = false; return json({ error: { code: 'stale_review', message: 'This photo changed. Refresh it before reviewing again.' } }, 409); }
      if (!record || record.version !== body.expectedVersion) return json({ error: { code: 'stale_review', message: 'This photo changed. Refresh it before reviewing again.' } }, 409);
      state.photos[currentStatus] = state.photos[currentStatus].filter(photo => photo.id !== id);
      record.status = body.decision; record.version += 1; state.photos[body.decision].push(record);
      return json({ photo: { id, status: body.decision, version: record.version } });
    }
    const listingMatch = path.match(/^\/api\/admin\/listings\/([^/]+)\/visibility$/);
    if (listingMatch && request.method() === 'POST') {
      const listing = state.listings.find(item => item.id === decodeURIComponent(listingMatch[1]));
      const body = request.postDataJSON();
      if (!listing || listing.version !== body.expectedVersion) return json({ error: { code: 'stale_review', message: 'This display changed. Refresh it before changing visibility.' } }, 409);
      listing.status = body.status; listing.version += 1;
      return json({ listing });
    }
    if (path === '/api/admin/listings') return json({ listings: state.listings });
    if (path === '/api/admin/reports') return json({ reports: [], nextCursor: null });
    if (path === '/api/admin/photos') return json({ photos: state.photos[url.searchParams.get('status')] || [] });
    if (/^\/api\/admin\/photos\/[^/]+\/content$/.test(path)) { state.contentRequested = true; return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('not-a-real-image') }); }
    return json({ error: { code: 'not_found', message: `Unexpected test request: ${path}` } }, 404);
  });
  return state;
}

test('live review signs in without storing the passphrase, shows private photo queue and separates visibility', async ({ page }) => {
  const state = await installService(page);
  await page.goto('/review.html');
  await expect(page.getByLabel('Owner passphrase')).toBeVisible();
  await page.getByLabel('Owner passphrase').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#login-error')).toContainText('did not match');
  await page.getByLabel('Owner passphrase').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: '<img src=x onerror=alert(1)>', exact: true })).toBeVisible();
  await expect(page.locator('#detail-title img')).toHaveCount(0);
  await expect(page.locator('.detail-image img')).toHaveAttribute('src', '/api/admin/photos/photo-1/content');
  await expect(page.locator('.detail-image img')).toHaveJSProperty('complete', true);
  expect(state.contentRequested).toBe(true);
  await expect(page.locator('body')).not.toContainText('private@example.test');
  await expect(page.locator('body')).toContainText('Approving a photo does not change this display’s visibility.');

  for (const [width, height] of [[320, 568], [390, 844], [664, 390]]) {
    await page.setViewportSize({ width, height });
    const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
  }

  await page.getByRole('button', { name: /Approve photo/ }).click();
  await expect(page.locator('.status-pill')).toContainText('approved');
  await expect(page.locator('.decision-bar')).toContainText('Text display: published');
  expect(state.photos.approved).toHaveLength(1);
  expect(state.listings[0].status).toBe('published');
  await page.getByRole('button', { name: 'Return to pending' }).click();
  await expect(page.locator('.status-pill')).toContainText('pending');
  await page.getByRole('button', { name: 'Reject photo' }).click();
  await expect(page.locator('.status-pill')).toContainText('rejected');
  expect(state.photos.rejected).toHaveLength(1);

  await page.getByRole('tab', { name: /Text displays/ }).click();
  await expect(page.locator('#detail-title')).toHaveText('123 Test Street');
  await page.getByRole('button', { name: 'Hide from map' }).click();
  await expect(page.locator('.status-pill')).toContainText('hidden');
  await page.getByRole('button', { name: 'Restore to map' }).click();
  await expect(page.locator('.status-pill')).toContainText('published');
  expect(state.listings[0].status).toBe('published');

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByLabel('Owner passphrase')).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});

test('stale photo decision reports conflict and reloads authoritative version for review', async ({ page }) => {
  const state = await installService(page, { conflictOnce: true });
  await page.goto('/review.html');
  await page.getByLabel('Owner passphrase').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /Approve photo/ }).click();
  await expect(page.locator('#service-alert')).toContainText('changed in another review');
  await expect(page.locator('.status-pill')).toContainText('pending');
  expect(state.photos.pending[0].version).toBe(1);
});

test('an expired owner session clears private details and asks for sign-in', async ({ page }) => {
  await installService(page);
  await page.goto('/review.html');
  await page.getByLabel('Owner passphrase').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.private-photo img')).toBeVisible();
  await page.route('**/api/admin/photos/photo-1/decision', route => route.fulfill({ status: 401, json: { error: { code: 'sign_in_required', message: 'Sign in again.' } } }));
  await page.getByRole('button', { name: /Approve photo/ }).click();
  await expect(page.getByLabel('Owner passphrase')).toBeVisible();
  await expect(page.locator('#login-error')).toContainText('session expired');
  await expect(page.locator('.private-photo img')).toHaveCount(0);
});

test('a configuration error shows a retry rather than a fictional queue or owner session', async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Service unavailable.' } } }));
  await page.goto('/review.html');
  await expect(page.getByRole('heading', { name: 'Review is unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(page.locator('.owner-badge')).toHaveCount(0);
  await expect(page.locator('.demo-banner')).toHaveCount(0);
  await expect(page.locator('[data-record]')).toHaveCount(0);
});

test('switching inbox filters during pagination keeps each cursor with its requested stream', async ({ page }) => {
  await installService(page);
  let pendingOpen;
  const cursors = [];
  await page.route('**/api/admin/reports?**', async route => {
    const url = new URL(route.request().url()), status = url.searchParams.get('status'), before = url.searchParams.get('before');
    if (!before) return route.fulfill({ json: { reports: [{ id: `${status}-one`, kind: 'feedback', message: `${status} message`, status, version: 1 }], nextCursor: `${status}-100` } });
    cursors.push({ status, before });
    if (status === 'open') { pendingOpen = route; return; }
    return route.fulfill({ json: { reports: [], nextCursor: null } });
  });
  await page.goto('/review.html');
  await page.getByLabel('Owner passphrase').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('tab', { name: /Reports & feedback/ }).click();
  const back = page.getByRole('button', { name: '← All messages', exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByRole('button', { name: 'Load more messages', exact: true }).click();
  await expect.poll(() => Boolean(pendingOpen)).toBe(true);
  await page.getByRole('button', { name: 'Dismissed', exact: true }).click();
  await pendingOpen.fulfill({ json: { reports: [{ id: 'open-two', kind: 'feedback', message: 'Older open message', status: 'open', version: 1 }], nextCursor: 'open-200' } });
  if (await back.isVisible()) await back.click();
  await expect(page.getByRole('button', { name: 'Load more messages', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Load more messages', exact: true }).click();
  await expect.poll(() => cursors.length).toBe(2);
  expect(cursors).toEqual([{ status: 'open', before: 'open-100' }, { status: 'dismissed', before: 'dismissed-100' }]);
});
