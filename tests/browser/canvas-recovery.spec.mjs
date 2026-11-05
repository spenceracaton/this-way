import { test, expect } from '@playwright/test';

const route = '/prototypes/continuous-map/index.html';

test('a successful public-feed retry refreshes an open selection with its updated record', async ({ page }) => {
  let recovered = false;
  await page.route('**/api/listings?**', async request => {
    const neighborhood = new URL(request.request().url()).searchParams.get('neighborhood');
    if (neighborhood === 'crescent-lake' && !recovered) {
      return request.fulfill({ status: 503, json: { error: { message: 'Fixture outage' } } });
    }

    const listings = neighborhood === 'old-northeast' ? [{
      id: 'same-public-record',
      address: recovered ? 'Fixture address after retry' : 'Fixture address before retry',
      latitude: recovered ? 27.798 : 27.789,
      longitude: -82.639
    }] : [];
    return request.fulfill({ json: { listings } });
  });

  await page.goto(route);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('body')).toHaveAttribute('data-feeds', 'partial');
  await expect(page.locator('.display-pin')).toHaveCount(1);
  await page.locator('.display-pin').click();
  await expect(page.locator('#pin-address')).toHaveText('Fixture address before retry');
  const cameraBeforeRetry = await page.evaluate(() => window.canvasStudy.camera());

  recovered = true;
  await page.locator('#retry-feeds').click();
  await expect(page.locator('body')).toHaveAttribute('data-feeds', 'complete');
  await expect(page.locator('#pin-address')).toHaveText('Fixture address after retry');
  await expect(page.locator('.display-pin')).toHaveAttribute('aria-pressed', 'true');

  const cameraAfterRetry = await page.evaluate(() => window.canvasStudy.camera());
  expect(cameraAfterRetry.lat).not.toBe(cameraBeforeRetry.lat);
  expect(cameraAfterRetry.lng).toBe(cameraBeforeRetry.lng);
});

test.describe('touchscreen input', () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 568 } });

  test('taps on dense visible pin centers select the record at each tapped coordinate', async ({ page }) => {
    const records = [
      { id: 'tap-a', address: 'Touch fixture A', latitude: 27.78870254, longitude: -82.6340216 },
      { id: 'tap-b', address: 'Touch fixture B', latitude: 27.78878705, longitude: -82.63538294 },
      { id: 'tap-c', address: 'Touch fixture C', latitude: 27.78922723, longitude: -82.63476693 }
    ];
    await page.route('**/api/listings?**', route => route.fulfill({
      json: { listings: new URL(route.request().url()).searchParams.get('neighborhood') === 'old-northeast' ? records : [] }
    }));
    await page.goto(route);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-feeds', 'complete');
    await page.evaluate(() => window.canvasStudy.view('crossing'));

    const mapBounds = await page.locator('#map').boundingBox();
    for (const record of records) {
      const point = await page.evaluate(([lat, lng]) => window.canvasStudy.project([lat, lng]), [record.latitude, record.longitude]);
      await page.touchscreen.tap(mapBounds.x + point.x, mapBounds.y + point.y);
      await expect(page.locator('#pin-address')).toHaveText(record.address);
      await page.locator('#close-pin').click();
    }
  });
});

test('focused pin buttons select their own records with Enter and Space', async ({ page }) => {
  const records = [
    { id: 'key-a', address: 'Keyboard fixture A', latitude: 27.789, longitude: -82.639 },
    { id: 'key-b', address: 'Keyboard fixture B', latitude: 27.790, longitude: -82.638 }
  ];
  await page.route('**/api/listings?**', route => route.fulfill({
    json: { listings: new URL(route.request().url()).searchParams.get('neighborhood') === 'old-northeast' ? records : [] }
  }));
  await page.goto(route);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('body')).toHaveAttribute('data-feeds', 'complete');

  for (const [index, key] of [[1, 'Enter'], [0, 'Space']]) {
    const pin = page.locator('.display-pin').nth(index);
    await pin.focus();
    await page.keyboard.press(key);
    await expect(page.locator('#pin-address')).toHaveText(records[index].address);
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.display-pin[aria-pressed="true"]')).toHaveCount(1);
    await page.locator('#close-pin').click();
  }
});

test('artwork can recover after an image failure without disturbing pins or camera', async ({ page }) => {
  let unavailable = true;
  await page.route('**/api/listings?**', route => route.fulfill({
    json: { listings: new URL(route.request().url()).searchParams.get('neighborhood') === 'old-northeast'
      ? [{ id: 'art-pin', address: 'Artwork fixture', latitude: 27.789, longitude: -82.639 }] : [] }
  }));
  await page.route('**/art/old-northeast-spotlight.webp', route => unavailable
    ? route.fulfill({ status: 503, body: 'Fixture artwork outage' })
    : route.continue());
  await page.goto(route);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('body')).toHaveAttribute('data-feeds', 'complete');
  await expect(page.locator('.display-pin')).toHaveCount(1);

  const camera = await page.evaluate(() => window.canvasStudy.camera());
  await page.locator('[data-art-mode="old-northeast"]').click();
  await expect(page.locator('#art-error')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-art-loaded', '0');
  await expect(page.locator('.display-pin')).toHaveCount(1);

  unavailable = false;
  await page.locator('#retry-art').click();
  await expect(page.locator('body')).toHaveAttribute('data-art-loaded', '1');
  await expect(page.locator('#art-error')).toBeHidden();
  await expect(page.locator('.display-pin')).toHaveCount(1);
  expect(await page.evaluate(() => window.canvasStudy.camera())).toEqual(camera);
});

test('rapid artwork choices settle on the last choice with the same camera and pins', async ({ page }) => {
  const records = [{ id: 'rapid-pin', address: 'Rapid fixture', latitude: 27.789, longitude: -82.639 }];
  await page.route('**/api/listings?**', route => route.fulfill({
    json: { listings: new URL(route.request().url()).searchParams.get('neighborhood') === 'old-northeast' ? records : [] }
  }));
  await page.route('**/art/old-northeast-spotlight.webp', async route => {
    await new Promise(resolve => setTimeout(resolve, 200));
    await route.continue();
  });
  await page.goto(route);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('body')).toHaveAttribute('data-feeds', 'complete');
  const camera = await page.evaluate(() => window.canvasStudy.camera());

  await page.locator('[data-art-mode="old-northeast"]').click();
  await page.locator('[data-art-mode="crescent-lake"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-art', 'crescent-lake');
  await expect(page.locator('body')).toHaveAttribute('data-art-loaded', '1');
  await expect(page.locator('[data-art-mode="crescent-lake"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.display-pin')).toHaveCount(1);
  expect(await page.evaluate(() => window.canvasStudy.camera())).toEqual(camera);
});

test('a genuine empty season feed is complete while a failed feed stays unavailable', async ({ page }) => {
  let failed = false;
  await page.route('**/api/listings?**', route => failed
    ? route.fulfill({ status: 503, json: { error: { message: 'Fixture outage' } } })
    : route.fulfill({ json: { listings: [] } }));

  await page.goto(`${route}?season=christmas-2026`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('body')).toHaveAttribute('data-feeds', 'complete');
  await expect(page.locator('body')).toHaveAttribute('data-pins', '0');
  await expect(page.locator('#feed-error')).toBeHidden();
  await expect(page.locator('#feed-status')).toContainText('0 published displays');

  failed = true;
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-feeds', 'unavailable');
  await expect(page.locator('#feed-error')).toBeVisible();
  await expect(page.locator('#feed-error-copy')).toContainText('Displays could not load');
});
