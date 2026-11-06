import { test, expect } from '@playwright/test';
import path from 'node:path';

test('pin placement keeps the address, exact center marker, and confirmation usable on short screens', async ({ page }) => {
  await enableService(page);
  for (const [width, height] of [[320, 568], [390, 664], [664, 390]]) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.getByRole('button', { name: 'Add a display', exact: true }).click();
    await page.locator('#submission-address').fill('123 Test Avenue, St Petersburg');
    await page.locator('#submission-location-button').click();
    await expect(page.locator('#submission-location-address')).toHaveText('123 Test Avenue, St Petersburg');
    await expect(page.locator('#submission-form-actions')).toBeHidden();
    const [map, crosshair, confirmation, scroll] = await Promise.all([
      '#submission-location-map', '.submission-map-crosshair', '#submission-location-confirm', '#submission-scroll'
    ].map(selector => page.locator(selector).boundingBox()));
    expect(Math.abs(crosshair.y + crosshair.height / 2 - map.y - map.height / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(crosshair.x + crosshair.width / 2 - map.x - map.width / 2)).toBeLessThanOrEqual(1);
    expect(confirmation.y).toBeGreaterThanOrEqual(scroll.y);
    expect(confirmation.y + confirmation.height).toBeLessThanOrEqual(scroll.y + scroll.height + 1);
    const zoomOut = await page.locator('#submission-location-map .leaflet-control-zoom-out').boundingBox();
    expect(zoomOut.y).toBeGreaterThanOrEqual(map.y);
    expect(zoomOut.y + zoomOut.height).toBeLessThanOrEqual(map.y + map.height);
    const attribution = await page.locator('#submission-location-map .leaflet-control-attribution').boundingBox();
    const overlapWidth = Math.max(0, Math.min(zoomOut.x + zoomOut.width, attribution.x + attribution.width) - Math.max(zoomOut.x, attribution.x));
    const overlapHeight = Math.max(0, Math.min(zoomOut.y + zoomOut.height, attribution.y + attribution.height) - Math.max(zoomOut.y, attribution.y));
    expect(overlapWidth * overlapHeight).toBe(0);
    await page.locator('#submission-location-confirm').click();
    await expect(page.locator('#submission-location-match')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add to map', exact: true })).toBeVisible();
  }
});

const season = {
  id: 'christmas-2026', kind: 'christmas', year: 2026, name: 'Christmas 2026',
  submissionTitle: 'Add a display', themePlaceholder: 'For example: A winter wonderland',
  tags: ['Lights', 'Music', 'Winter wonderland']
};
const listing = {
  id: 'live-1', locationId: 'location-1', seasonId: season.id,
  neighborhoodId: 'old-northeast', address: '123 Live Ave, St Petersburg',
  title: 'A winter display', description: 'Walk by after sunset.', tags: ['Lights'], customTags: [],
  latitude: 27.789, longitude: -82.63, status: 'published', version: 1, createdAt: Date.now(), photos: []
};

async function enableService(page, { listings = [], failListingFetch = false, loseFirstListingResponse = false } = {}) {
  const writes = [];
  let failedFirstPhoto = false;
  let createdListing = listing;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/config') {
      return route.fulfill({ json: { available: true, season, limits: { photos: 3, maxPhotoBytes: 2097152 } } });
    }
    if (url.pathname === '/api/listings' && request.method() === 'GET') {
      if (failListingFetch) return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Live displays could not load.' } } });
      return route.fulfill({ json: { listings } });
    }
    if (url.pathname === '/api/listings' && request.method() === 'POST') {
      const body = request.postDataJSON();
      writes.push({ kind: 'listing', body });
      if (loseFirstListingResponse && writes.filter(write => write.kind === 'listing').length === 1) return route.abort();
      if (loseFirstListingResponse) return route.fulfill({ status: 409, json: { error: { code: 'request_conflict', message: 'This submission was already saved with different details. Start a new submission.' } } });
      createdListing = { ...listing, ...body };
      return route.fulfill({ status: 201, json: { listing: createdListing, uploadToken: 'first-token' } });
    }
    if (url.pathname === '/api/listings/live-1/photo-upload-token' && request.method() === 'POST') {
      writes.push({ kind: 'token', body: request.postDataJSON() });
      return route.fulfill({ json: { uploadToken: 'retry-token' } });
    }
    if (url.pathname === '/api/listings/live-1/photos' && request.method() === 'POST') {
      const bytes = request.postDataBuffer();
      writes.push({ kind: 'photo', auth: request.headers().authorization, requestId: request.headers()['x-photo-request-id'], contentType: request.headers()['content-type'], bytes });
      if (!failedFirstPhoto) {
        failedFirstPhoto = true;
        return route.fulfill({ status: 503, json: { error: { code: 'temporary', message: 'Photo upload is temporarily unavailable.' } } });
      }
      return route.fulfill({ status: 201, json: { photo: { id: 'photo-1', status: 'pending', version: 1 } } });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'No mock route.' } } });
  });
  return writes;
}

test('community map fills the phone, keeps its controls clear, and selects displays without a directory', async ({ page }) => {
  const displays = [1,2,3].map(number => ({ ...listing, id:`fixture-${number}`, locationId:`fixture-location-${number}`,
    title:'', address:`${number} Synthetic long display address, St Petersburg` }));
  await enableService(page,{listings:displays});
  for (const [width,height] of [[320,568],[390,664],[664,390]]) {
    await page.setViewportSize({width,height});
    await page.goto('/');
    await expect(page.locator('#map')).toHaveAttribute('aria-busy','false');
    await expect(page.locator('body')).toHaveAttribute('data-experience','neighborhood');
    await expect(page.locator('.references')).toBeHidden();
    await expect(page.locator('#sample-count')).toHaveText('3 live displays');
    for (const selector of ['#add-display','#neighborhood-select','#season-select','.leaflet-control-zoom','.leaflet-control-attribution']) {
      await expect(page.locator(selector)).toBeInViewport({ratio:1});
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const canvas=await page.locator('.canvas').boundingBox();
    expect(canvas.y+canvas.height).toBeCloseTo(height,0);
    const credit = await page.locator('.leaflet-control-attribution').boundingBox();
    const zoom = await page.locator('.leaflet-control-zoom').boundingBox();
    const overlapWidth=Math.max(0,Math.min(credit.x+credit.width,zoom.x+zoom.width)-Math.max(credit.x,zoom.x));
    const overlapHeight=Math.max(0,Math.min(credit.y+credit.height,zoom.y+zoom.height)-Math.max(credit.y,zoom.y));
    expect(overlapWidth*overlapHeight).toBe(0);
    // Coincident fixtures remain individually reachable using the existing keyboard targets.
    await page.locator('[data-pin="fixture-3"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#selected-name')).toHaveText(displays[2].address);
    for (const selector of ['#add-display','#season-select','#neighborhood-select']) {
      await expect(page.locator(selector)).toBeInViewport({ratio:1});
    }
    await page.locator('#detail-close').click();
    await expect(page.locator('#selection')).toBeHidden();
    await page.locator('#neighborhood-select').click();
    await expect(page.locator('.neighborhood-count:visible')).toHaveCount(0);
    await page.locator('#neighborhood-picker-close').click();
  }
});

test('nearby real-world-scale display positions can be zoomed apart and selected without moving coordinates', async ({ page }) => {
  await page.setViewportSize({width:390,height:664});
  const neighbors=[{...listing,id:'fixture-west',address:'Synthetic west display',longitude:-82.63012,photos:[]},
    {...listing,id:'fixture-east',address:'Synthetic east display',longitude:-82.63,photos:[]}];
  await enableService(page,{listings:neighbors});
  await page.goto('/');
  await expect(page.locator('#map')).toHaveAttribute('aria-busy','false');
  const separation=async()=>{
    const [a,b]=await Promise.all(neighbors.map(row=>page.locator(`.map-pin[data-pin="${row.id}"]`).boundingBox()));
    return Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y));
  };
  expect(await separation()).toBeLessThan(48);
  for(let i=0;i<16&&await separation()<48;i++){
    const zoom=page.getByRole('button',{name:'Zoom in',exact:true});
    if(await zoom.evaluate(el=>el.classList.contains('leaflet-disabled')))break;
    await zoom.click();
  }
  expect(await separation()).toBeGreaterThanOrEqual(48);
  // Keyboard selection brings the now-separated neighbors into the camera.
  await page.locator('.map-pin').first().focus();
  await page.keyboard.press('Enter');
  await page.locator('#detail-close').click();
  for(const row of neighbors){
    await page.locator(`.map-pin[data-pin="${row.id}"]`).click();
    await expect(page.locator('#selected-name')).toHaveText(row.address);
    await page.locator('#detail-close').click();
  }
});

test('live map starts empty, publishes immediately, safely renders addresses, and retries private photo uploads', async ({ page }) => {
  const writes = await enableService(page);
  await page.goto('/');

  await expect(page.locator('#sample-count')).toHaveText('0 live displays');
  await expect(page.locator('#reference-list')).toHaveText('No live displays here yet.');
  await expect(page.locator('#reference-list')).not.toContainText('255 9th Ave NE');
  await expect(page.locator('.map-panel > .references')).toBeHidden();
  await expect(page.locator('#sample-count')).toBeVisible();

  await page.getByRole('button', { name: 'Add a display', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Add a display' });
  await page.locator('#submission-address').fill('123 <img src=x onerror=window.__xss=1> Avenue, St Petersburg');
  await page.locator('#submission-theme').fill('Winter lights');
  await page.locator('#submission-description').fill('A safe description.');
  await page.locator('#submission-location-button').click();
  await expect(page.locator('#submission-location-map')).toBeVisible();
  await page.locator('#submission-location-confirm').click();
  await page.locator('#submission-location-match').check();
  await page.locator('summary').filter({ hasText: 'Add photos' }).click();
  await page.locator('#submission-photos').setInputFiles(path.join(process.cwd(), 'public/assets/samples/illustration-haunt.webp'));
  await expect(page.locator('#submission-photo-previews img')).toHaveCount(1);

  await page.getByRole('button', { name: 'Add to map', exact: true }).click();
  await expect(page.locator('#submission-receipt')).toBeVisible();
  await expect(page.locator('#submission-receipt-title')).toHaveText('Your display is on the map');
  await expect(page.locator('#submission-photo-receipt')).toContainText('could not be uploaded and remains on this device');
  await expect(page.locator('#sample-count')).toHaveText('1 live display');
  await expect(page.locator('#references-title')).toHaveText('Live displays');
  await expect(page.locator('.canvas')).not.toHaveClass(/map-only/);
  await expect(page.locator('.canvas > .references')).toHaveCount(1);
  await expect(page.locator('footer .footer-tools a')).toHaveText('Review photos');
  await expect(page.locator('#reference-list')).toContainText('123 <img src=x onerror=window.__xss=1> Avenue, St Petersburg');
  await expect(page.locator('#reference-list img')).toHaveCount(0);
  await expect(page.locator('#map .map-pin img')).toHaveCount(0);
  await expect(page.locator('#detail-title')).toHaveText('Winter lights');
  await expect(page.locator('#selected-note')).toHaveText('A safe description.');
  await expect(page.locator('#detail-heart')).toHaveAttribute('aria-label', 'Heart this display on this device');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  expect(writes.filter(write => write.kind === 'listing')).toHaveLength(1);
  expect(writes[0].body.address).toContain('<img src=x');
  expect(writes[0].body.latitude).toEqual(expect.any(Number));
  expect(writes[0].body.longitude).toEqual(expect.any(Number));
  expect(writes[0].body.seasonId).toBe(season.id);
  const firstPhoto = writes.find(write => write.kind === 'photo');
  expect(firstPhoto.contentType).toBe('image/jpeg');
  if (firstPhoto.bytes) {
    expect(firstPhoto.bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(firstPhoto.bytes.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
  }

  await page.getByRole('button', { name: 'Retry photo uploads' }).click();
  await expect(page.locator('#submission-photo-receipt')).toHaveText('1 photo was sent privately and is waiting for owner review.');
  const tokenRequest = writes.find(write => write.kind === 'token');
  const photoRequests = writes.filter(write => write.kind === 'photo');
  expect(tokenRequest.body.clientRequestId).toEqual(expect.any(String));
  expect(photoRequests).toHaveLength(2);
  expect(photoRequests[0].requestId).toBe(photoRequests[1].requestId);
  expect(photoRequests[1].auth).toBe('Bearer retry-token');
});

test('enabled API errors remain visible and do not fall back to sample addresses', async ({ page }) => {
  await enableService(page, { failListingFetch: true });
  await page.goto('/');
  await expect(page.locator('#loading')).toContainText('Live displays could not load.');
  await expect(page.locator('#sample-count')).toHaveText('Loading displays…');
  await expect(page.locator('#reference-list')).toBeEmpty();
  await expect(page.locator('.map-pin')).toHaveCount(0);
});

test('explicit sample links stay in the preview-only demo when the API is available', async ({ page }) => {
  const writes = await enableService(page);
  await page.goto('/?sample=a');
  await expect(page.locator('#sample-count')).toHaveText('4 sample addresses');
  await expect(page.locator('#reference-list')).toContainText('255 9th Ave NE');
  await page.locator('#add-display').click();
  await expect(page.getByRole('button', { name: 'Preview display', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to map', exact: true })).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

test('a lost listing response keeps its request ID and surfaces a conflict after the text changes', async ({ page }) => {
  const writes = await enableService(page, { loseFirstListingResponse: true });
  await page.goto('/');
  await page.locator('#add-display').click();
  await page.locator('#submission-address').fill('123 Retry Ave, St Petersburg');
  await page.locator('#submission-theme').fill('Retry-safe display');
  await page.locator('#submission-location-button').click();
  await page.locator('#submission-location-confirm').click();
  await page.locator('#submission-location-match').check();
  await page.getByRole('button', { name: 'Add to map', exact: true }).click();
  await expect(page.locator('#submission-service-error')).toContainText('could not be reached');

  await page.locator('#submission-description').fill('Edited after the response was lost.');
  await page.getByRole('button', { name: 'Add to map', exact: true }).click();
  await expect(page.locator('#submission-service-error')).toContainText('already saved with different details');
  expect(writes.filter(write => write.kind === 'listing')).toHaveLength(2);
  expect(writes[0].body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(writes[1].body.clientRequestId).toBe(writes[0].body.clientRequestId);
});
