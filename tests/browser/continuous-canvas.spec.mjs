import { test, expect } from '@playwright/test';

const route = '/prototypes/continuous-map/index.html';
const records = {
  'old-northeast': [{ id: 'fixture-a', address: 'Fixture display A', latitude: 27.789, longitude: -82.639 }],
  'crescent-lake': [{ id: 'fixture-b', address: 'Fixture display B', latitude: 27.7891, longitude: -82.642 }]
};
async function feeds(page, handler) {
  await page.route('**/api/listings?**', async request => {
    const id = new URL(request.request().url()).searchParams.get('neighborhood');
    if (handler) return handler(request, id);
    return request.fulfill({ json: { listings: records[id] || [] } });
  });
}
async function open(page) {
  await page.goto(route);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('body')).toHaveAttribute('data-art-loaded', '2');
}
async function options(page) { await page.locator('#open-options').click(); await expect(page.locator('#study-options')).toBeVisible(); }

test('one geographic camera keeps record pins stable when artwork is changed or hidden', async ({page}) => {
  await feeds(page); await open(page);
  await expect(page.locator('body')).toHaveAttribute('data-feeds', 'complete');
  expect(await page.evaluate(() => Number(getComputedStyle(document.querySelector('.study-artwork').parentElement).zIndex)
    > Number(getComputedStyle(document.querySelector('.leaflet-overlay-pane')).zIndex))).toBe(true);
  const camera = await page.evaluate(() => window.canvasStudy.camera());
  const original = await page.evaluate(() => window.canvasStudy.project([27.789, -82.639]));
  await options(page);
  await page.locator('#art-mode').selectOption('base');
  await expect(page.locator('body')).toHaveAttribute('data-art-loaded', '0');
  await page.locator('#close-options').click();
  expect(await page.evaluate(() => window.canvasStudy.camera())).toEqual(camera);
  expect(await page.evaluate(() => window.canvasStudy.project([27.789, -82.639]))).toEqual(original);
  await expect(page.locator('.display-pin')).toHaveCount(2);
  await options(page);
  await page.locator('#art-mode').selectOption('crescent-lake');
  await expect(page.locator('body')).toHaveAttribute('data-art-loaded', '1');
  await page.locator('#close-options').click();
  expect(await page.evaluate(() => window.canvasStudy.camera())).toEqual(camera);
  expect(await page.evaluate(() => window.canvasStudy.diagnostics().peakEstimatedRGBABytes)).toBeLessThan(32 * 1048576);
});

test('one failed public feed stays incomplete and retry never substitutes sample pins', async ({page}) => {
  let unavailable = true;
  await feeds(page, (request, id) => id === 'crescent-lake' && unavailable
    ? request.fulfill({ status: 503, json: {error:{message:'Fixture outage'}} })
    : request.fulfill({json:{listings:records[id]}}));
  await open(page);
  await expect(page.locator('body')).toHaveAttribute('data-feeds', 'partial');
  await expect(page.locator('#feed-error')).toContainText('Counts are incomplete');
  await expect(page.locator('.display-pin')).toHaveCount(1);
  unavailable = false; await page.locator('#retry-feeds').click();
  await expect(page.locator('body')).toHaveAttribute('data-feeds', 'complete');
  await expect(page.locator('#feed-error')).toBeHidden();
  await expect(page.locator('.display-pin')).toHaveCount(2);
});

test('artwork failure preserves usable base context and independent published pins', async ({page}) => {
  await feeds(page);
  await page.route('**/art/*-spotlight.webp', request => request.fulfill({status:503,body:'Fixture outage'}));
  await page.goto(route);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('body')).toHaveAttribute('data-feeds', 'complete');
  await expect(page.locator('#art-error')).toBeVisible();
  await expect(page.locator('.display-pin')).toHaveCount(2);
  await page.locator('#open-options').click();
  await page.locator('[data-view=gap]').click();
  // On a wide desktop, finite maxBounds legitimately constrain the center.
  // The destination still has to be visible within the geographic canvas.
  const target = await page.evaluate(() => window.canvasStudy.project([27.7996, -82.6488]));
  const bounds = await page.locator('#map').boundingBox();
  expect(target.x).toBeGreaterThan(0); expect(target.x).toBeLessThan(bounds.width);
  expect(target.y).toBeGreaterThan(0); expect(target.y).toBeLessThan(bounds.height);
});

test('accessible coordinate choices expose a minimal identifier and closing keeps camera', async ({page}) => {
  await feeds(page); await open(page);
  await options(page);
  await page.locator('#display-list summary').click();
  await page.locator('#coordinate-list button').first().click();
  await expect(page.locator('#pin-card')).toBeVisible();
  await expect(page.locator('#pin-address')).toHaveText('Fixture display A');
  const camera = await page.evaluate(() => window.canvasStudy.camera());
  await page.locator('#close-pin').click();
  await expect(page.locator('#pin-card')).toBeHidden();
  expect(await page.evaluate(() => window.canvasStudy.camera())).toEqual(camera);
});

test('overlapping transparent touch targets select the actual visible coordinate nearest the tap', async ({page}) => {
  const dense = [
    {id:'near-a',address:'Fixture near A',latitude:27.78870254,longitude:-82.6340216},
    {id:'near-b',address:'Fixture near B',latitude:27.78878705,longitude:-82.63538294},
    {id:'near-c',address:'Fixture near C',latitude:27.78922723,longitude:-82.63476693}
  ];
  await page.setViewportSize({width:320,height:568});
  await feeds(page,(request,id) => request.fulfill({json:{listings:id==='old-northeast'?dense:[]}}));
  await open(page); await expect(page.locator('body')).toHaveAttribute('data-feeds','complete');
  for (const record of dense) {
    await page.evaluate(() => window.canvasStudy.view('crossing'));
    const point = await page.evaluate(point => window.canvasStudy.project(point), [record.latitude,record.longitude]);
    const bounds = await page.locator('#map').boundingBox();
    await page.mouse.click(bounds.x+point.x,bounds.y+point.y);
    await expect(page.locator('#pin-address')).toHaveText(record.address);
    await page.locator('#close-pin').click();
  }
});

test('short landscape options scroll as one bounded surface and overview points expand without moving identity', async ({page}) => {
  await page.setViewportSize({width:667,height:375}); await feeds(page); await open(page);
  await options(page);
  const dialog = await page.locator('#study-options').boundingBox();
  expect(dialog.y).toBeGreaterThanOrEqual(0); expect(dialog.y + dialog.height).toBeLessThanOrEqual(375);
  await page.locator('.existing-map-link').scrollIntoViewIfNeeded();
  await expect(page.locator('.existing-map-link')).toBeInViewport({ratio:1});
  await page.locator('#close-options').scrollIntoViewIfNeeded(); await page.locator('#close-options').click();
  await page.setViewportSize({width:320,height:568});
  await page.evaluate(() => window.canvasStudy.view('crossing'));
  await expect(page.locator('body')).toHaveAttribute('data-pin-style','points');
  const ids = await page.locator('.display-pin').evaluateAll(nodes => nodes.map(node => node.dataset.id).sort());
  await page.locator('.leaflet-control-zoom-in').click(); await page.locator('.leaflet-control-zoom-in').click();
  await expect(page.locator('body')).toHaveAttribute('data-pin-style','numbered');
  expect(await page.locator('.display-pin').evaluateAll(nodes => nodes.map(node => node.dataset.id).sort())).toEqual(ids);
});

for (const viewport of [{width:320,height:568},{width:390,height:650},{width:667,height:375}]) {
  test(`canvas controls remain on the first screen at ${viewport.width}x${viewport.height}`, async ({page}) => {
    await page.setViewportSize(viewport); await feeds(page); await open(page);
    for (const control of ['#open-options','.leaflet-control-zoom-in','.leaflet-control-zoom-out']) {
      await expect(page.locator(control)).toBeInViewport({ratio:1});
      const box = await page.locator(control).boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    const point = await page.evaluate(() => window.canvasStudy.project([27.789, -82.639]));
    const initialZoom = (await page.evaluate(() => window.canvasStudy.camera())).zoom;
    await page.locator('#map').focus(); await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await page.evaluate(() => window.canvasStudy.project([27.789, -82.639]))).x).not.toBe(point.x);
    await page.locator('.leaflet-control-zoom-in').click();
    await expect.poll(async () => Number(await page.locator('body').getAttribute('data-zoom'))).toBeGreaterThan(initialZoom);
  });
}
