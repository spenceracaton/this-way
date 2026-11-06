import { test, expect } from '@playwright/test';

const season = { id: 'christmas-2026', kind: 'christmas', year: 2026, name: 'Christmas 2026', tags: [] };
const listing = { id: 'tools-neither', neighborhoodId: 'old-northeast', seasonId: season.id, address: '100 Synthetic Avenue N', title: '', description: 'A synthetic display.', latitude: 27.792, longitude: -82.63, tags: [], photos: [] };
const listings = [listing, { ...listing, id: 'tools-themed', title: ' Lanterns ', address: '102 Synthetic Avenue N' }, { ...listing, id: 'tools-photos', title: ' ', address: '104 Synthetic Avenue N', photos: [{ url: '/api/photos/tools-fixture' }] }, { ...listing, id: 'tools-both', title: 'Stars', address: '106 Synthetic Avenue N', photos: [{ url: '/api/photos/tools-fixture' }] }];
async function mock(page) {
  await page.addInitScript(() => {
    window.__locationCalls = [];
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition(success, error, options) { window.__locationCalls.push({ success, error, options }); } } });
  });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/config') return route.fulfill({ json: { available: true, season, limits: { photos: 3, maxPhotoBytes: 2097152 } } });
    if (url.pathname === '/api/listings') return route.fulfill({ json: { listings } });
    if (url.pathname === '/api/photos/tools-fixture') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#49354f"/></svg>' });
    return route.fulfill({ json: {} });
  });
}
async function open(page, query = '') { await page.goto('/' + query); await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false'); }
const shown = page => page.locator('#map [data-pin]').evaluateAll(nodes => nodes.map(node => node.dataset.pin));
const calls = page => page.evaluate(() => window.__locationCalls.length);
const fix = (page, point = {}) => page.evaluate(point => window.__locationCalls.at(-1).success({ coords: { latitude: 27.792, longitude: -82.63, accuracy: 10, ...point } }), point);

test('filter drafts, AND semantics, focus, persistence, empty recovery, and incoming listings', async ({ page }) => {
  await mock(page); await open(page);
  const toggle = page.locator('#display-filters-toggle'), dialog = page.locator('#display-filters-dialog');
  const themed = page.locator('#display-filter-themed'), photos = page.locator('#display-filter-photos');
  const allIds = listings.map(pin => pin.id);
  expect(await shown(page)).toEqual(allIds);
  await toggle.click(); await expect(page.locator('#display-filters-title')).toBeFocused();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await themed.focus(); await page.keyboard.press('Space'); await photos.focus(); await page.keyboard.press('Enter');
  expect(await shown(page)).toEqual(allIds);
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(toggle).toBeFocused();
  await toggle.click(); await expect(themed).toHaveAttribute('aria-pressed', 'false');
  await themed.click(); await photos.click(); await page.locator('#display-filters-apply').click();
  expect(await shown(page)).toEqual(['tools-both']); await expect(toggle).toHaveAccessibleName('Filters · 2'); await expect(toggle).toBeFocused();
  await toggle.click(); await page.locator('#display-filters-reset').click(); await page.locator('#display-filters-close').click();
  expect(await shown(page)).toEqual(['tools-both']);
  await open(page, '?neighborhood=crescent-lake'); expect(await shown(page)).toEqual(['tools-both']);
  await open(page, '?listing=tools-neither');
  await expect(page.locator('#selection')).toBeVisible(); expect(await shown(page)).toEqual(allIds);
  await expect(toggle).toHaveAccessibleName('Filters');
  // An actual zero-match feed leaves a direct reset target on the map.
  await page.route('**/api/listings?**', route => route.fulfill({ json: { listings: [listing] } }));
  await open(page); await toggle.click(); await themed.click(); await page.locator('#display-filters-apply').click();
  expect(await shown(page)).toEqual([]); await expect(page.locator('.map-filter-empty')).toBeVisible();
  await page.locator('#display-filters-empty-reset').click(); expect(await shown(page)).toEqual(['tools-neither']);
});

test('Near me is explicit and private; recovery preserves shared listings and ignores late callbacks', async ({ page }) => {
  await mock(page);
  const requests = []; page.on('request', request => { if (new URL(request.url()).pathname === '/data/neighborhood-coverage.json') requests.push({ url: request.url(), method: request.method(), data: request.postData() }); });
  await open(page, '?listing=tools-neither&source=near-me');
  expect(await calls(page)).toBe(0); expect(requests).toEqual([]);
  const incoming = page.url(), near = page.locator('#near-me'), feedback = page.locator('#near-me-feedback');
  await near.focus(); await page.keyboard.press('Enter'); await expect(near).toBeDisabled();
  await fix(page, { accuracy: 2000 }); await expect(page.locator('#near-me-status')).toContainText('approximate');
  await expect(page.locator('#selection')).toBeVisible(); expect(page.url()).toBe(incoming);
  await page.keyboard.press('Escape'); await expect(feedback).not.toBeVisible(); await expect(near).toBeFocused();
  await near.click(); const cancelled = await calls(page) - 1;
  await page.locator('#near-me-close').click();
  await page.evaluate(index => window.__locationCalls[index].success({ coords: { latitude: 27.787, longitude: -82.643, accuracy: 10 } }), cancelled);
  await expect(feedback).not.toBeVisible(); expect(page.url()).toBe(incoming);
  await near.click(); await fix(page); await expect(feedback).not.toBeVisible();
  await expect(page.locator('#selection')).not.toBeVisible(); await expect(page.locator('#map .location-dot')).toBeVisible();
  await near.click(); await page.evaluate(() => window.__locationCalls.at(-1).error({ code: 1 }));
  await expect(page.locator('#near-me-status')).toContainText('access is off');
  await page.locator('#near-me-keep').click(); const deniedCalls = await calls(page);
  await near.click(); await expect(page.locator('#near-me-status')).toContainText('access is off'); expect(await calls(page)).toBe(deniedCalls);
  await page.locator('#near-me-choose').click(); await expect(page.locator('#neighborhood-dialog')).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1); await expect(page.locator('#neighborhood-picker-title')).toBeFocused();
  await page.locator('#neighborhood-search').fill('Crescent'); await page.keyboard.press('Escape');
  await expect(page.locator('#neighborhood-dialog')).not.toBeVisible(); await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  expect(requests).toHaveLength(1); expect(new URL(requests[0].url).search).toBe(''); expect(requests[0].method).toBe('GET'); expect(requests[0].data).toBeNull();
});

test('coverage outage recovers and a precise different core changes only the neighborhood URL', async ({ page }) => {
  await mock(page);
  await page.route('**/data/neighborhood-coverage.json', route => route.fulfill({ status: 503, json: {} }), { times: 1 });
  await open(page, '?listing=tools-neither&source=near-me');
  await page.locator('#near-me').click(); await fix(page);
  await expect(page.locator('#near-me-status')).toContainText('couldn’t load'); await expect(page.locator('#selection')).toBeVisible();
  await page.locator('#near-me-close').click();
  await page.locator('#near-me').click(); await fix(page, { latitude: 27.787, longitude: -82.643 });
  await expect(page).toHaveURL(/neighborhood=crescent-lake/); await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
  const url = new URL(page.url()); expect([...url.searchParams.keys()].sort()).toEqual(['neighborhood', 'source']);
  expect(await calls(page)).toBe(0);
});

for (const viewport of [{ width: 320, height: 568 }, { width: 667, height: 375 }]) test(`controls and location recovery stay reachable at ${viewport.width}×${viewport.height}`, async ({ page }) => {
  await page.setViewportSize(viewport); await mock(page); await open(page, '?listing=tools-both');
  for (const id of ['near-me', 'display-filters-toggle']) {
    const control = page.locator('#' + id); await expect(control).toBeInViewport({ ratio: 1 });
    expect(await control.evaluate(node => { const r = node.getBoundingClientRect(), target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return node.contains(target); })).toBe(true);
  }
  await page.locator('#near-me').click(); await fix(page, { accuracy: 2000 });
  for (const id of ['near-me-choose', 'near-me-close', 'near-me-keep']) {
    const control = page.locator('#' + id); await control.scrollIntoViewIfNeeded(); await expect(control).toBeInViewport({ ratio: 1 });
    expect(await control.evaluate(node => { const r = node.getBoundingClientRect(), target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return node.contains(target); })).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
