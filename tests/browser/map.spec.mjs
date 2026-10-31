import { test, expect } from '@playwright/test';

// Retained artwork anchors, independently recorded from the original road geometry.
// Never derive these expectations from the projection or Leaflet under test.
const oldNortheast = {
  bounds: { left: 30, right: 835, top: 15, bottom: 1072 },
  raster: [3220, 4228],
  anchors: [
    { label: 'A', x: 378.61, y: 824.39 },
    { label: 'B', x: 600.85, y: 680.32 },
    { label: 'C', x: 473.24, y: 393.42 },
    { label: 'D', x: 421.90, y: 527.82 }
  ]
};
const crescentLake = {
  bounds: { left: 20, right: 980, top: 20, bottom: 1040 },
  raster: [3840, 4080],
  anchors: [
    { label: 'A', x: 186.55, y: 201.74 },
    { label: 'B', x: 725.27, y: 451.79 },
    { label: 'C', x: 500.86, y: 892.41 },
    { label: 'D', x: 231.60, y: 667.46 }
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
  const listA = page.locator('#reference-list button').filter({ hasText: '9th Avenue' });
  await listA.click();
  await expect(a).toHaveAttribute('aria-pressed', 'true');
  await expect(listA).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#selected-label')).toHaveText('A');
  if (isMobile) await b.tap(); else await b.click();
  await expect(b).toHaveAttribute('aria-pressed', 'true');
  await expect(a).toHaveAttribute('aria-pressed', 'false');
  await expect(listA).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#selected-label')).toHaveText('B');
  await expect(page.locator('#selected-name')).toHaveText('North Shore Drive');
  await expect(page.locator('#selected-note')).toHaveText('Coastal reference · near the shoreline');
  await expect(page.locator('#reference-list button').filter({ hasText: 'North Shore Drive' })).toHaveAttribute('aria-pressed', 'true');
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
  await expect(page.locator('#selected-name')).toHaveText('Choose a sample pin');
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
  await page.locator('#reference-list button').filter({ hasText: 'North Shore Drive' }).click();
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
  await page.locator('#reference-list button').filter({ hasText: '18th Avenue & 5th Street' }).click();
  await expect(page.locator('#selected-name')).toHaveText('18th Avenue & 5th Street');
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
