import { test, expect } from '@playwright/test';

const currentSeason = {
  id: 'christmas-2026', kind: 'christmas', year: 2026, name: 'Christmas 2026',
  submissionTitle: 'Add a display', themePlaceholder: 'For example: A winter wonderland',
  tags: ['Lights', 'Music']
};

const listings = {
  'christmas-2026': [{
    id: 'christmas-fixture', locationId: 'christmas-location', seasonId: 'christmas-2026',
    neighborhoodId: 'old-northeast', address: '18 Synthetic Christmas Lane, St Petersburg',
    title: 'Paper stars and porch lights', description: 'A synthetic current-season fixture.', tags: ['Lights'], customTags: [],
    latitude: 27.789, longitude: -82.63, status: 'published', version: 1, photos: []
  }],
  'halloween-2026': [{
    id: 'halloween-fixture', locationId: 'halloween-location', seasonId: 'halloween-2026',
    neighborhoodId: 'old-northeast', address: '24 Synthetic Halloween Lane, St Petersburg',
    title: 'Lanterns along the garden path', description: 'A synthetic past-season fixture.', tags: ['Spooky'], customTags: [],
    latitude: 27.790, longitude: -82.631, status: 'published', version: 1, photos: []
  }]
};

listings['halloween-2026'].push(
  { ...listings['halloween-2026'][0], id: 'halloween-left-edge', locationId: 'halloween-left-location', address: '12 Synthetic West Lane, St Petersburg', title: 'West edge fixture', latitude: 27.790, longitude: -82.6398 },
  { ...listings['halloween-2026'][0], id: 'halloween-right-edge', locationId: 'halloween-right-location', address: '98 Synthetic East Lane, St Petersburg', title: 'East edge fixture', latitude: 27.790, longitude: -82.6210 }
);

async function expectMobileMapControlsClear(page) {
  await expect.poll(async () => {
    const seasonBox = await page.locator('#season-select').boundingBox();
    const zoomBox = await page.locator('#map .leaflet-control-zoom').boundingBox();
    const attributionBox = await page.locator('#map .leaflet-control-attribution').boundingBox();
    const pinBox = await page.locator('#map .map-pin.is-selected').boundingBox();
    const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
      * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    return [overlapArea(seasonBox, zoomBox), overlapArea(attributionBox, zoomBox),
      overlapArea(pinBox, zoomBox), overlapArea(pinBox, attributionBox)];
  }).toEqual([0, 0, 0, 0]);
}

async function mockSeasonService(page) {
  const requested = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/config') {
      return route.fulfill({ json: { available: true, season: currentSeason, limits: { photos: 3, maxPhotoBytes: 2097152 } } });
    }
    if (url.pathname === '/api/listings' && route.request().method() === 'GET') {
      const season = url.searchParams.get('season');
      const neighborhood = url.searchParams.get('neighborhood');
      requested.push({ season, neighborhood });
      return route.fulfill({ json: { listings: (listings[season] || []).filter(listing => listing.neighborhoodId === neighborhood) } });
    }
    return route.fulfill({ status: 404, json: { error: { message: 'Unexpected API request.' } } });
  });
  return requested;
}

test('season links load their own listings and history actions keep the selected listing context', async ({ page }) => {
  const requested = await mockSeasonService(page);
  await page.goto('/?season=halloween-2026');
  await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#season-select')).toHaveValue('halloween-2026');
  await expect(page.locator('#references-title')).toHaveText('Halloween 2026 displays');
  await expect(page.locator('#reference-list')).toContainText('Synthetic Halloween Lane');
  expect(requested[0]).toEqual({ season: 'halloween-2026', neighborhood: 'old-northeast' });

  await page.locator('#reference-list button').first().click();
  await expect(page.locator('#detail-season')).toHaveText('Past season · Halloween 2026');
  await expect(page.locator('#detail-report')).toBeEnabled();
  await page.locator('#detail-heart').click();
  await expect(page.locator('#detail-heart')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#detail-report').click();
  const report = page.getByRole('dialog', { name: 'Report this display' });
  await expect(report).toContainText('24 Synthetic Halloween Lane');
  await report.getByRole('button', { name: 'Cancel' }).click();

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('Clipboard unavailable in this test.')) }, configurable: true });
  });
  await page.locator('#detail-share').click();
  await expect(page.locator('#share-url')).toHaveValue(/season=halloween-2026/);
  await expect(page.locator('#share-url')).toHaveValue(/listing=halloween-fixture/);
  const switchSeason = page.getByRole('button', { name: 'Switch to Christmas 2026 to add a display' });
  await expect(switchSeason).toBeEnabled();
  for (const id of ['halloween-left-edge', 'halloween-right-edge']) {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(`/?season=halloween-2026&listing=${id}`);
    await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
    await expectMobileMapControlsClear(page);
  }
  await switchSeason.click();
  await expect(page).toHaveURL(/season=christmas-2026/);
  await expect(page.locator('#references-title')).toHaveText('Live displays');
});

test('season selection and neighborhood navigation preserve the chosen season', async ({ page }) => {
  const requested = await mockSeasonService(page);
  await page.goto('/?season=halloween-2026');
  await page.getByRole('button', { name: 'Explore a neighborhood' }).click();
  await page.getByRole('option', { name: /Crescent Lake/ }).click();
  await expect(page).toHaveURL(/season=halloween-2026/);
  await expect(page).toHaveURL(/neighborhood=crescent-lake/);
  await expect.poll(() => requested.at(-1)?.neighborhood).toBe('crescent-lake');
  expect(requested.at(-1)?.season).toBe('halloween-2026');
  await expect(page).toHaveTitle(/Crescent Lake · Halloween 2026 · Past season/);
  await expect(page.locator('#reference-list')).toHaveText('No Halloween 2026 displays in this neighborhood.');

  await page.locator('#season-select').selectOption('christmas-2026');
  await expect(page).toHaveURL(/season=christmas-2026/);
  await expect(page).toHaveURL(/neighborhood=crescent-lake/);
  await expect(page.getByRole('button', { name: 'Add a display', exact: true })).toBeEnabled();
  expect(requested.at(-1)).toEqual({ season: 'christmas-2026', neighborhood: 'crescent-lake' });
});

test('unknown seasons fail clearly without requesting listings or showing sample addresses', async ({ page }) => {
  const requested = await mockSeasonService(page);
  await page.goto('/?season=not-a-season');
  await expect(page.locator('#loading')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#loading')).toContainText('Unknown season');
  expect(requested).toEqual([]);
  await expect(page.locator('#reference-list')).not.toContainText('sample addresses');
  await page.getByRole('link', { name: 'Open the map home' }).click();
  await expect(page).toHaveURL('http://127.0.0.1:5173/');
  await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
});

