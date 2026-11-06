import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

// Rollback can serve a release from before the searchable picker was added.
async function chooseNeighborhood(page, id, name) {
  const native = page.getByRole('combobox', { name: 'Explore a neighborhood' });
  if (await native.count()) await native.selectOption(id);
  else {
    await page.getByRole('button', { name: 'Explore a neighborhood' }).click();
    await page.getByRole('option').filter({ hasText: name }).click();
  }
}

test('the expected release serves live service routes and the default map', async ({ page, request }) => {
  const receipt = JSON.parse(await readFile('release-results/receipt.json', 'utf8'));
  const metadata = await request.get(`/release.json?smoke=${Date.now()}`, {
    headers: { 'cache-control': 'no-cache' }
  });
  expect(metadata.ok()).toBe(true);
  expect(await metadata.json()).toMatchObject({
    commit: receipt.commit,
    release_id: receipt.release_id
  });

  const configResponse = await request.get('/api/config');
  if (configResponse.status() === 404) {
    expect(receipt.operation).toBe('rollback');
    const response = await page.goto(`/?smoke=${Date.now()}`);
    expect(response.ok()).toBe(true);
    await expect(page.locator('.map-pin')).toHaveCount(4);
    await chooseNeighborhood(page, 'crescent-lake', 'Crescent Lake');
    await expect(page.getByRole('heading', { name: 'Crescent Lake', exact: true })).toBeVisible();
    await page.locator('#reference-list button').filter({ hasText: '1930 Crescent Lake Dr N' }).click();
    await expect(page.locator('#selected-name')).toHaveText('1930 Crescent Lake Dr N');
    return;
  }
  expect(configResponse.ok()).toBe(true);
  const config = await configResponse.json();
  expect(config.available).toBe(true);
  expect(config.season.id).toBeTruthy();
  const response = await page.goto(`/?smoke=${Date.now()}`);
  expect(response.ok()).toBe(true);
  const siteSetting = page.locator('meta[name="display-season"]');
  const visibleSeasonId = await siteSetting.count() ? await siteSetting.getAttribute('content') : config.season.id;
  const historical = visibleSeasonId !== config.season.id;
  if (await siteSetting.count()) {
    await expect(page.locator('#season-select')).toBeHidden();
    if (historical) await expect(page.locator('#add-display')).toBeHidden();
  }
  const countText = count => historical ? `${count} Halloween 2026 displays` : `${count} live ${count === 1 ? 'display' : 'displays'}`;
  const listingsResponse = await request.get(`/api/listings?neighborhood=old-northeast&season=${encodeURIComponent(visibleSeasonId)}`);
  expect(listingsResponse.ok()).toBe(true);
  const { listings } = await listingsResponse.json();
  expect(Array.isArray(listings)).toBe(true);
  for (const listing of listings) {
    expect(Object.keys(listing)).not.toEqual(expect.arrayContaining(['object_key', 'content_hash', 'reviewed_by', 'review_reason']));
  }
  expect((await request.get('/api/admin/listings')).status()).toBe(401);

  await expect(page.getByRole('navigation', { name: 'Artwork comparison' })).toBeHidden();
  await expect(page.locator('#sample-count')).toHaveText(countText(listings.length));
  await expect(page.locator('.map-pin')).toHaveCount(listings.length);
  const expectedOldNortheastIds = listings.map(listing => listing.id).sort();
  const displayedOldNortheastIds = await page.locator('.map-pin').evaluateAll(markers => markers.map(marker => marker.dataset.pin).sort());
  const listedOldNortheastIds = await page.locator('#reference-list button').evaluateAll(buttons => buttons.map(button => button.dataset.id).sort());
  expect(displayedOldNortheastIds).toEqual(expectedOldNortheastIds);
  expect(listedOldNortheastIds).toEqual(expectedOldNortheastIds);
  expect(await page.locator('img#neighborhood-artwork').evaluate(image => [image.naturalWidth, image.naturalHeight]))
    .toEqual([3220, 4228]);

  await chooseNeighborhood(page, 'crescent-lake', 'Crescent Lake');
  await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('heading', { name: 'Crescent Lake', exact: true })).toBeVisible();
  const crescent = await request.get(`/api/listings?neighborhood=crescent-lake&season=${encodeURIComponent(visibleSeasonId)}`).then(response => response.json());
  await expect(page.locator('#sample-count')).toHaveText(countText(crescent.listings.length));
  await expect(page.locator('.map-pin')).toHaveCount(crescent.listings.length);
  const expectedCrescentIds = crescent.listings.map(listing => listing.id).sort();
  expect(await page.locator('.map-pin').evaluateAll(markers => markers.map(marker => marker.dataset.pin).sort())).toEqual(expectedCrescentIds);
  expect(await page.locator('#reference-list button').evaluateAll(buttons => buttons.map(button => button.dataset.id).sort())).toEqual(expectedCrescentIds);
  expect(await page.locator('img#neighborhood-artwork').evaluate(image => [image.naturalWidth, image.naturalHeight]))
    .toEqual([3840, 4080]);
});

test('explicit sample mode still shows the two original map studies', async ({ page, request }) => {
  const receipt = JSON.parse(await readFile('release-results/receipt.json', 'utf8'));
  if (receipt.operation === 'rollback' && (await request.get('/api/config')).status() === 404) test.skip();
  const oldNortheast = await page.goto('/?sample=a');
  expect(oldNortheast.ok()).toBe(true);
  await expect(page.locator('#sample-count')).toHaveText('4 sample addresses');
  await expect(page.locator('.map-pin')).toHaveCount(4);
  await expect(page.locator('#selected-name')).toHaveText('255 9th Ave NE');

  const crescent = await page.goto('/?neighborhood=crescent-lake&sample=a');
  expect(crescent.ok()).toBe(true);
  await expect(page.locator('#sample-count')).toHaveText('4 sample addresses');
  await expect(page.locator('.map-pin')).toHaveCount(4);
  await expect(page.locator('#selected-name')).toHaveText('861 19th Ave N');
});
