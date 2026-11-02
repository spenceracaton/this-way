import { test, expect } from '@playwright/test';

// Public map marker anchors, independently recorded from the rendered Fright This Way map.
// Never derive these expectations from the projection or Leaflet under test.
const oldNortheast = {
  bounds: { left: 30, right: 835, top: 15, bottom: 1072 },
  raster: [3220, 4228],
  anchors: [
    { label: 'A', x: 372.40174, y: 816.4476 },
    { label: 'B', x: 604.46772, y: 551.869055 },
    { label: 'C', x: 359.89314, y: 426.28013 },
    { label: 'D', x: 269.92438, y: 517.501645 }
  ]
};
const crescentLake = {
  bounds: { left: 20, right: 980, top: 20, bottom: 1040 },
  raster: [3840, 4080],
  anchors: [
    { label: 'A', x: 212.664369, y: 345.589749 },
    { label: 'B', x: 477.209655, y: 295.294091 },
    { label: 'C', x: 667.069610, y: 913.782129 },
    { label: 'D', x: 331.669314, y: 737.272753 }
  ]
};
const anchors = oldNortheast.anchors;
const pin = (page, label) => page.getByRole('button', { name: new RegExp(`^Select sample ${label}:`) });

async function artworkRect(page) {
  return page.locator('#neighborhood-artwork').boundingBox();
}

async function checkAlignment(page, specification = oldNortheast) {
  await expect.poll(async () => {
    const art = await artworkRect(page);
    if (!art) return Infinity;
    const { bounds } = specification;
    const errors = await Promise.all(specification.anchors.map(async ({ label, x, y }) => {
      const marker = await pin(page, label).boundingBox();
      if (!marker) return Infinity;
      return Math.hypot(marker.x + marker.width / 2 - (art.x + (x - bounds.left) * art.width / (bounds.right - bounds.left)),
        marker.y + marker.height / 2 - (art.y + (y - bounds.top) * art.height / (bounds.bottom - bounds.top)));
    }));
    return Math.max(...errors);
  }, { message: 'all four pins align with independent artwork anchors' }).toBeLessThan(2);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.map-pin')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Reset view' })).toBeEnabled();
});

test('loads local artwork and aligns the four independent reference anchors', async ({ page }, testInfo) => {
  await expect(page.locator('#neighborhood-artwork')).toBeVisible();
  await checkAlignment(page);
  expect((await pin(page, 'C').boundingBox()).y).toBeLessThan((await pin(page, 'A').boundingBox()).y);
  await expect(page.getByText('© OpenStreetMap contributors', { exact: false })).toBeVisible();
  await testInfo.attach('initial-map', { body: await page.locator('.map-panel').screenshot(), contentType: 'image/png' });
});

test('browser rasterizes the core shoreline and nearby-area hole correctly', async ({ page }) => {
  await page.goto('/?diagnostic=1&artwork=full');
  await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#world > use[mask="url(#spotlight)"]')).toHaveCount(1);
  await expect(page.locator('#world > use[mask="url(#nearbyBlocksMask)"]')).toHaveCount(1);
  // Exercise the browser's SVG mask compositor with the actual loaded definitions.
  // Fixed sample points straddle the coast and the nearby mask's core-area hole.
  const result = await page.locator('#neighborhood-artwork').evaluate(async svg => {
    const samples = [[400, 700], [100, 700], [750, 700], [50, 30]];
    const output = {};
    for (const id of ['spotlight', 'nearbyBlocksMask']) {
      const source = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1072"><defs>${svg.querySelector('#' + id).outerHTML}</defs><rect width="1000" height="1072" fill="black"/><rect width="1000" height="1072" fill="red" mask="url(#${id})"/></svg>`;
      const image = new Image();
      const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
      try {
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 1000; canvas.height = 1072;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        output[id] = samples.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
      } finally { URL.revokeObjectURL(url); }
    }
    return output;
  });
  const red = [255, 0, 0, 255], black = [0, 0, 0, 255];
  expect(result.spotlight).toEqual([red, black, black, black]);
  expect(result.nearbyBlocksMask).toEqual([black, red, black, black]);
});

test('pointer and keyboard selection keep map, list and details synchronized', async ({ page, isMobile }) => {
  const a = pin(page, 'A'), b = pin(page, 'B'), c = pin(page, 'C');
  const listA = page.locator('#reference-list button').filter({ hasText: '255 9th Ave NE' });
  await listA.click();
  await expect(a).toHaveAttribute('aria-pressed', 'true');
  await expect(listA).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#selected-label')).toHaveText('A');
  await page.getByRole('button', { name: 'Close display details' }).click();
  if (isMobile) await b.tap(); else await b.click();
  await expect(b).toHaveAttribute('aria-pressed', 'true');
  await expect(a).toHaveAttribute('aria-pressed', 'false');
  await expect(listA).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#selected-label')).toHaveText('B');
  await expect(page.locator('#selected-name')).toHaveText('805 17th Ave NE');
  await expect(page.locator('#selected-note')).toHaveText('Sample address · not a live Christmas listing');
  await expect(page.locator('#reference-list button').filter({ hasText: '805 17th Ave NE' })).toHaveAttribute('aria-pressed', 'true');
  await c.focus();
  await page.keyboard.press('Enter');
  await expect(c).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#selected-label')).toHaveText('C');
  await a.focus();
  await page.keyboard.press('Space');
  await expect(a).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#selected-label')).toHaveText('A');
  await page.keyboard.press('Escape');
  await expect(page.locator('#selection')).toHaveAttribute('data-selected', '');
  await expect(page.locator('.map-pin[aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator('#reference-list [aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator('#selection')).toBeHidden();
  await b.click();
  const mapBox = await page.locator('#map').boundingBox();
  await page.locator('#map').click({ position: { x: mapBox.width - 70, y: mapBox.height * 0.55 } });
  await expect(page.locator('#selection')).toHaveAttribute('data-selected', '');
});

test('zoom, drag and keyboard pan preserve alignment; reset and Home restore overview', async ({ page }) => {
  const initial = await artworkRect(page);
  const camera = page.locator('#camera-status');
  const initialStatus = await camera.textContent();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(async () => (await artworkRect(page)).width).toBeGreaterThan(initial.width * 1.3);
  await expect(camera).not.toHaveText(initialStatus);
  await checkAlignment(page);
  const map = page.locator('#map');
  await map.scrollIntoViewIfNeeded();
  const box = await map.boundingBox();
  const beforeDrag = await artworkRect(page);
  const x = box.x + box.width * 0.45, y = box.y + box.height * 0.6;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 65, y + 35, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await artworkRect(page)).x - beforeDrag.x)).toBeGreaterThan(20);
  await checkAlignment(page);
  // A valid pan may move B outside the clipped map, especially on the phone.
  // The reference list is the supported way to select a location offscreen.
  await page.locator('#reference-list button').filter({ hasText: '805 17th Ave NE' }).click();
  await expect(page.locator('#selected-label')).toHaveText('B');
  await page.getByRole('button', { name: 'Reset view' }).click();
  await expect(camera).toHaveText(initialStatus);
  await expect(page.locator('#selection')).toHaveAttribute('data-selected', '');
  await expect.poll(async () => Math.abs((await artworkRect(page)).width - initial.width)).toBeLessThan(1);
  await checkAlignment(page);
  // The wide desktop overview can already show the entire padded bounds, so
  // horizontal panning there is correctly clamped. Zoom in before testing it.
  const overview = await artworkRect(page);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(camera).not.toHaveText(initialStatus);
  const beforeKey = await artworkRect(page);
  await map.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Math.abs((await artworkRect(page)).x - beforeKey.x)).toBeGreaterThan(20);
  await page.keyboard.press('Home');
  await expect(camera).toHaveText(initialStatus);
  await expect.poll(async () => Math.abs((await artworkRect(page)).x - overview.x)).toBeLessThan(1);
  await expect.poll(async () => Math.abs((await artworkRect(page)).width - overview.width)).toBeLessThan(1);
  await checkAlignment(page);
  const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
  for (let step = 0; step < 16 && await zoomIn.isEnabled(); step += 1) await zoomIn.click();
  await expect(camera).toHaveText('View 2.00');
});

test('the ordinary URL uses raster artwork without exposing diagnostic controls', async ({ page }) => {
  await expect(page.getByRole('navigation', { name: 'Artwork comparison' })).toBeHidden();
  await expect(page.locator('img#neighborhood-artwork')).toBeVisible();
  await expect(page.locator('svg#neighborhood-artwork')).toHaveCount(0);
  expect(await page.locator('img#neighborhood-artwork').evaluate(image => [image.naturalWidth, image.naturalHeight]))
    .toEqual([3220, 4228]);
  await checkAlignment(page);
});

test('Crescent Lake uses its own raster, coordinates and selectable reference points', async ({ page }, testInfo) => {
  await page.getByRole('combobox', { name: 'Explore a neighborhood' }).selectOption('crescent-lake');
  await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
  await expect(page).toHaveTitle('This Way · Crescent Lake');
  await expect(page.getByRole('heading', { name: 'Crescent Lake', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Explore a neighborhood' })).toHaveValue('crescent-lake');
  expect(await page.locator('img#neighborhood-artwork').evaluate(image => [image.naturalWidth, image.naturalHeight]))
    .toEqual(crescentLake.raster);
  await checkAlignment(page, crescentLake);
  expect((await pin(page, 'C').boundingBox()).y).toBeGreaterThan((await pin(page, 'A').boundingBox()).y);
  await page.locator('#reference-list button').filter({ hasText: '1930 Crescent Lake Dr N' }).click();
  await expect(page.locator('#selected-name')).toHaveText('1930 Crescent Lake Dr N');
  await expect(pin(page, 'B')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await checkAlignment(page, crescentLake);
  await page.getByRole('button', { name: 'Reset view' }).click();
  await expect(page.locator('#selection')).toHaveAttribute('data-selected', '');
  await testInfo.attach('crescent-lake-map', { body: await page.locator('.map-panel').screenshot(), contentType: 'image/png' });
  await page.getByRole('combobox', { name: 'Explore a neighborhood' }).selectOption('old-northeast');
  await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('heading', { name: 'Old Northeast', exact: true })).toBeVisible();
  await checkAlignment(page);
});

test('a drag can start immediately after zoom without waiting for an animation', async ({ page }) => {
  const map = page.locator('#map');
  await map.scrollIntoViewIfNeeded();
  const box = await map.boundingBox();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  // Deliberately do not wait for zoom to settle before starting the next gesture.
  // Leaflet's default zoom transition discards this pointer-down for 250 ms.
  const before = await artworkRect(page);
  const x = box.x + box.width * 0.45, y = box.y + box.height * 0.6;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 65, y + 35, { steps: 10 });
  // A continuing zoom can also move the artwork. Verify the drag itself started.
  await expect(page.locator('body')).toHaveClass(/leaflet-dragging/);
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await artworkRect(page)).x - before.x))
    .toBeGreaterThan(20);
  await checkAlignment(page);
});

test('viewport fits the page and keeps controls and sample pins usable', async ({ page, isMobile }) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const { label } of anchors) {
    const rect = await pin(page, label).boundingBox();
    expect(rect.width).toBeGreaterThanOrEqual(44);
    expect(rect.height).toBeGreaterThanOrEqual(44);
    const map = await page.locator('#map').boundingBox();
    expect(rect.x).toBeGreaterThanOrEqual(map.x);
    expect(rect.x + rect.width).toBeLessThanOrEqual(map.x + map.width);
    expect(rect.y).toBeGreaterThanOrEqual(map.y);
    expect(rect.y + rect.height).toBeLessThanOrEqual(map.y + map.height);
  }
  if (isMobile) {
    expect(page.viewportSize()).toEqual({ width: 390, height: 664 });
    const panel = await page.locator('.map-panel').boundingBox();
    const references = await page.locator('.references').boundingBox();
    expect(references.x).toBeGreaterThanOrEqual(panel.x);
    expect(references.x + references.width).toBeLessThanOrEqual(panel.x + panel.width);
    expect(references.y + references.height).toBeLessThanOrEqual(panel.y + panel.height);
  }
  await page.locator('#reference-list button').last().click();
  await expect(page.locator('#selected-label')).toHaveText('D');
  await page.getByRole('button', { name: 'Reset view' }).click();
  await expect(page.locator('#selection')).toHaveAttribute('data-selected', '');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('artwork diagnostic preserves geometry and selection across SVG, raster and rectangle modes', async ({ page }, testInfo) => {
  await expect(page.getByRole('navigation', { name: 'Artwork comparison' })).toBeHidden();
  await page.goto('/?diagnostic=1&artwork=full');
  await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
  const full = await artworkRect(page);
  await page.getByRole('link', { name: 'Rasterized artwork', exact: true }).click();
  await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
  const raster = await artworkRect(page);
  for (const key of ['x', 'y', 'width', 'height']) expect(Math.abs(full[key] - raster[key])).toBeLessThan(1);
  await expect(page.locator('img#neighborhood-artwork')).toBeVisible();
  expect(await page.locator('img#neighborhood-artwork').evaluate(image => [image.naturalWidth, image.naturalHeight]))
    .toEqual([3220, 4228]);
  await expect(page.locator('.map-pin')).toHaveCount(4);
  await checkAlignment(page);
  await pin(page, 'B').click();
  await expect(page.locator('#selected-label')).toHaveText('B');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await checkAlignment(page);
  await page.getByRole('button', { name: 'Reset view' }).click();
  await expect(page.locator('#selection')).toHaveAttribute('data-selected', '');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await testInfo.attach('raster-artwork-diagnostic', { body: await page.locator('.map-panel').screenshot(), contentType: 'image/png' });
  await page.getByRole('link', { name: 'Plain rectangle', exact: true }).click();
  await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
  const simple = await artworkRect(page);
  for (const key of ['x', 'y', 'width', 'height']) expect(Math.abs(full[key] - simple[key])).toBeLessThan(1);
  await expect(page.locator('#neighborhood-artwork rect')).toHaveCount(1);
  await expect(page.locator('#neighborhood-artwork path, #neighborhood-artwork mask, #neighborhood-artwork text')).toHaveCount(0);
  await expect(page.locator('.map-pin')).toHaveCount(4);
  await checkAlignment(page);
  await pin(page, 'B').click();
  await expect(page.locator('#selected-label')).toHaveText('B');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await checkAlignment(page);
  await page.getByRole('button', { name: 'Reset view' }).click();
  await expect(page.locator('#selection')).toHaveAttribute('data-selected', '');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await testInfo.attach('plain-artwork-diagnostic', { body: await page.locator('.map-panel').screenshot(), contentType: 'image/png' });
  await page.getByRole('link', { name: 'Full SVG', exact: true }).click();
  await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#neighborhood-artwork mask')).toHaveCount(2);
  await checkAlignment(page);
});

test('photo-first details support browsing, enlargement and address fallback', async ({ page }) => {
  const opener = page.locator('#reference-list button').first();
  await opener.click();
  const sheet = page.locator('#selection');
  const address = sheet.getByRole('link', { name: /Directions to/ });
  await expect(sheet.getByRole('heading', { name: 'Pumpkin Lantern Walk' })).toBeVisible();
  const frame = await sheet.locator('.house-body').boundingBox();
  const link = await address.boundingBox();
  expect(link.y + link.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
  await sheet.getByRole('button', { name: 'Next photo' }).click();
  await expect(sheet.getByRole('button', { name: 'Show photo 2 of 3' })).toHaveAttribute('aria-current', 'true');
  await sheet.getByRole('button', { name: /Enlarge photo/ }).click();
  const viewer = page.getByRole('dialog');
  await expect(viewer).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(viewer.getByRole('button', { name: 'Show photo 3 of 3' })).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await sheet.getByRole('button', { name: 'Close display details' }).click();
  await page.locator('#reference-list button').nth(2).click();
  await expect(sheet.getByRole('heading', { name: /Pumpkin Trail/ })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Next photo' })).toHaveCount(0);
  const longAddress = await address.boundingBox();
  expect(longAddress.height).toBeGreaterThanOrEqual(44);
  expect(longAddress.height).toBeLessThanOrEqual(48);
  const note = await sheet.locator('#selected-note').boundingBox();
  const secondaryGap = note.y - (longAddress.y + longAddress.height);
  expect(secondaryGap).toBeGreaterThanOrEqual(6);
  expect(secondaryGap).toBeLessThanOrEqual(10);
  const body = await sheet.locator('.house-body').boundingBox();
  expect(longAddress.y + longAddress.height).toBeLessThanOrEqual(body.y + body.height + 1);
  await sheet.getByRole('button', { name: 'Close display details' }).click();
  await page.locator('#reference-list button').nth(1).click();
  await expect(sheet.getByRole('heading', { name: /805 17th Ave NE/ })).toBeVisible();
  await expect(sheet.locator('#display-photos')).toBeHidden();
});

test('desktop detail pane follows the selected location and fits inside the map', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Phones use the bottom sheet.');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.locator('#reference-list button').first().click();
  const marker = pin(page, 'A');
  const sheet = page.locator('#selection');
  async function offset() {
    const m = await marker.boundingBox();
    const s = await sheet.boundingBox();
    const x = m.x + m.width / 2;
    return Math.min(Math.abs(s.x - x), Math.abs(s.x + s.width - x));
  }
  await expect.poll(offset).toBeCloseTo(28, 0);
  const before = await marker.boundingBox();
  await page.locator('#map').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Math.abs((await marker.boundingBox()).x - before.x)).toBeGreaterThan(1);
  await expect.poll(offset).toBeCloseTo(28, 0);
  const bounds = await page.locator('.canvas').boundingBox();
  const card = await sheet.boundingBox();
  expect(card.x).toBeGreaterThanOrEqual(bounds.x);
  expect(card.y + card.height).toBeLessThanOrEqual(bounds.y + bounds.height);
});


test('address-only details keep the heading clear and heart state survives reload', async ({ page }, testInfo) => {
  await page.locator('#reference-list button').last().click();
  const sheet = page.locator('#selection');
  const heading = sheet.locator('#detail-title');
  const note = sheet.locator('#selected-note');
  const titleBox = await heading.boundingBox();
  const noteBox = await note.boundingBox();
  const gap = noteBox.y - (titleBox.y + titleBox.height);
  expect(gap).toBeGreaterThanOrEqual(6);
  expect(gap).toBeLessThanOrEqual(10);
  const heart = sheet.locator('#detail-heart');
  await expect(heart.locator('svg.paper-heart')).toBeVisible();
  await expect(heart.locator('.heart-count')).toHaveText('0');
  const target = await heart.boundingBox();
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
  await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await expect(heart.locator('.heart-count')).toHaveText('1');
  await testInfo.attach('address-only-heart', { body: await sheet.screenshot(), contentType: 'image/png' });
  await page.reload();
  await page.locator('#reference-list button').last().click();
  await expect(page.locator('#detail-heart')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#detail-heart .heart-count')).toHaveText('1');
});

test('mobile detail sheets keep media, controls and attribution clear', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Phones use the bottom sheet.');
  await page.evaluate(() => document.fonts.ready);
  const sheet = page.locator('#selection');
  const attribution = page.locator('.leaflet-control-attribution');
  const zoom = page.locator('.leaflet-control-zoom');
  const clearOfSheet = async () => {
    await expect.poll(async () => {
      const card = await sheet.boundingBox();
      const credit = await attribution.boundingBox();
      return card.y - (credit.y + credit.height);
    }).toBeGreaterThanOrEqual(6);
    const card = await sheet.boundingBox();
    const zoomBox = await zoom.boundingBox();
    expect(zoomBox.y + zoomBox.height).toBeLessThanOrEqual(card.y - 4);
    const share = await sheet.locator('#detail-share').boundingBox();
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.id,
      { x: share.x + share.width / 2, y: share.y + share.height / 2 });
    expect(hit).toBe('detail-share');
  };

  await page.locator('#reference-list button').first().click();
  const frame = await sheet.locator('#display-photos .photo-frame').boundingBox();
  expect(frame.width).toBeLessThanOrEqual(300);
  expect(frame.width / frame.height).toBeGreaterThan(1.45);
  expect(frame.width / frame.height).toBeLessThan(1.55);
  await clearOfSheet();

  await sheet.getByRole('button', { name: 'Close display details' }).click();
  await page.locator('#reference-list button').nth(2).click();
  const pill = await sheet.locator('#detail-tags li').boundingBox();
  const body = await sheet.locator('.house-body').boundingBox();
  expect(pill.y + pill.height).toBeLessThanOrEqual(body.y + body.height + 1);
  await clearOfSheet();

  await sheet.getByRole('button', { name: 'Close display details' }).click();
  await page.locator('#reference-list button').last().click();
  const card = await sheet.boundingBox();
  const heading = await sheet.locator('#detail-title').boundingBox();
  const note = await sheet.locator('#selected-note').boundingBox();
  const footer = await sheet.locator('.house-actions').boundingBox();
  expect(heading.x - card.x).toBeGreaterThanOrEqual(18);
  expect(heading.y - card.y).toBeGreaterThanOrEqual(18);
  expect(footer.y - (note.y + note.height)).toBeGreaterThanOrEqual(18);
  await clearOfSheet();
});

test('mobile selection keeps its marker clear of the sheet without locking map panning', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Phones reserve map space above the bottom sheet.');
  const clearMarker = async (id) => {
    await expect.poll(async () => page.evaluate(id => {
      const marker = document.querySelector(`.map-pin[data-pin="${id}"]`);
      if (!marker) return false;
      const box = marker.getBoundingClientRect();
      const sheet = document.querySelector('#selection').getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return box.bottom <= sheet.top - 8 && hit?.closest('.map-pin') === marker;
    }, id)).toBe(true);
  };
  for (const sample of ['a', 'c', 'd']) {
    await page.goto(`/?sample=${sample}`);
    await expect(page.locator('#selection')).toHaveAttribute('data-selected', sample);
    await page.evaluate(() => document.fonts.ready);
    await clearMarker(sample);
  }
  await page.goto('/?sample=a');
  await clearMarker('a');
  await page.setViewportSize({ width: 390, height: 760 });
  await clearMarker('a');
  await page.setViewportSize({ width: 375, height: 568 });
  await clearMarker('a');
  const shortCard = await page.locator('#selection').boundingBox();
  expect(shortCard.y + shortCard.height).toBeLessThanOrEqual(568);
  await page.setViewportSize({ width: 390, height: 664 });
  await clearMarker('a');
  const before = await pin(page, 'A').boundingBox();
  await page.locator('#map').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await pin(page, 'A').boundingBox()).x).not.toBe(before.x);
  await page.waitForTimeout(300);
  const after = await pin(page, 'A').boundingBox();
  // A settled user pan must not trigger the selection-reveal behavior again.
  await page.waitForTimeout(250);
  expect(Math.abs((await pin(page, 'A').boundingBox()).x - after.x)).toBeLessThan(2);
  await page.locator('#detail-close').click();
  await expect(page.locator('#selection')).toBeHidden();
  await page.goto('/?neighborhood=crescent-lake&sample=c');
  await clearMarker('c');
  await page.getByRole('button', { name: 'Reset view' }).click();
  await expect(page.locator('#selection')).toBeHidden();
  await expect(page.locator('.map-pin.is-selected')).toHaveCount(0);
});

test('short-phone details keep actions visible and reveal all scrollable content', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Short phones constrain the bottom sheet.');
  await page.setViewportSize({ width: 375, height: 568 });
  for (const sample of ['a', 'c', 'd']) {
    await page.goto(`/?sample=${sample}`);
    const sheet = page.locator('#selection');
    await expect(sheet).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const share = await sheet.locator('#detail-share').boundingBox();
    expect(share.y + share.height).toBeLessThanOrEqual(568);
    const address = await sheet.getByRole('link', { name: /Directions to/ }).boundingBox();
    expect(address.height).toBeGreaterThanOrEqual(44);
    const body = sheet.locator('.house-body');
    const overflow = await body.evaluate(el => el.scrollHeight > el.clientHeight + 2);
    await expect(sheet).toHaveAttribute('data-more-below', String(overflow));
    // Exercise scrolling rather than relying on DOM presence below a clipped body.
    await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(sheet).toHaveAttribute('data-more-below', 'false');
    const last = await sheet.locator(sample === 'd' ? '#selected-note' : '#detail-tags').boundingBox();
    const viewport = await body.boundingBox();
    expect(last.y).toBeGreaterThanOrEqual(viewport.y);
    expect(viewport.y + viewport.height - last.y - last.height).toBeGreaterThanOrEqual(12);
  }
});


test('mobile rotation keeps photo and address details clear of map controls', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Phones use the responsive detail sheet.');
  for (const sample of ['a', 'c', 'd']) {
    await page.setViewportSize({ width: 390, height: 664 });
    await page.goto(`/?sample=${sample}`);
    await expect(page.locator('#selection')).toHaveAttribute('data-selected', sample);
    await page.setViewportSize({ width: 664, height: 390 });
    await expect.poll(async () => page.evaluate(id => {
      const marker = document.querySelector(`.map-pin[data-pin="${id}"]`);
      if (!marker) return false;
      const box = marker.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('.map-pin') === marker;
    }, sample)).toBe(true);
    const sheet = await page.locator('#selection').boundingBox();
    const zoom = await page.locator('.leaflet-control-zoom').boundingBox();
    const footer = await page.locator('.house-actions').boundingBox();
    expect(zoom.x + zoom.width).toBeLessThan(sheet.x);
    expect(footer.y + footer.height).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 390, height: 664 });
    await expect.poll(async () => page.evaluate(id => {
      const marker = document.querySelector(`.map-pin[data-pin="${id}"]`);
      const box = marker.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('.map-pin') === marker;
    }, sample)).toBe(true);
  }
});
