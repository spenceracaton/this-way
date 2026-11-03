import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { neighborhoods } from '../../public/neighborhoods.mjs';
import { importedNeighborhoods } from '../../public/neighborhood-catalog.mjs';

for (const [id, neighborhood] of Object.entries(neighborhoods)) {
  test(`${neighborhood.name}: its map loads with accurate sample coverage`, async ({ page }) => {
    const failures = [];
    page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
    page.on('pageerror', error => failures.push(error.message));
    page.on('requestfailed', request => failures.push(request.url()));
    page.on('response', response => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
    await page.goto(`/?neighborhood=${encodeURIComponent(id)}`);
    await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
    await expect(page).toHaveTitle(`This Way · ${neighborhood.name}`);
    await expect(page.getByRole('button', { name: 'Explore a neighborhood' })).toContainText(neighborhood.name);
    const artwork = page.locator('#neighborhood-artwork');
    await expect(artwork).toBeVisible();
    expect(await artwork.evaluate(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)).toBe(true);
    await expect(page.locator('.map-pin')).toHaveCount(neighborhood.pins.length);
    if (!neighborhood.pins.length) {
      await expect(page.locator('#reference-list')).toContainText('No sample addresses here yet.');
      await expect(page.locator('#sample-count')).toHaveText('Map only');
      if (page.viewportSize().width <= 720) {
        await expect.poll(async () => {
          const [card, credit] = await Promise.all([page.locator('.references').boundingBox(), page.locator('.leaflet-control-attribution').boundingBox()]);
          return credit.y - card.y - card.height;
        }).toBeGreaterThanOrEqual(6);
      }
    }
    expect(failures).toEqual([]);
  });
}

test('representative imported SVG diagnostics remain local and free of seasonal artwork', async ({ page }) => {
  const maps = await Promise.all(importedNeighborhoods.map(async item => {
    const config = JSON.parse(await readFile(resolve('public', item.config.replace(/^\.\//, '')), 'utf8'));
    return { ...item, config };
  }));
  const longest = [...maps].sort((a, b) => b.name.length - a.name.length)[0];
  const coastal = maps.find(item => item.id === 'gulfport');
  const largest = [...maps].sort((a, b) => {
    const area = config => (config.overviewBounds.right - config.overviewBounds.left) * (config.overviewBounds.bottom - config.overviewBounds.top);
    return area(b.config) - area(a.config);
  })[0];
  expect(coastal).toBeTruthy();
  for (const item of new Map([longest, coastal, largest].map(value => [value.id, value])).values()) {
    await page.goto(`/?neighborhood=${encodeURIComponent(item.id)}&diagnostic=1&artwork=full`);
    await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
    const svg = page.locator('svg#neighborhood-artwork');
    await expect(svg).toBeVisible();
    const diagnostic = await svg.evaluate(element => ({
      ids: [...element.querySelectorAll('[id]')].map(node => node.id),
      html: element.outerHTML
    }));
    expect(diagnostic.ids.join(' ')).not.toMatch(/seasonal|christmas|holiday|overlay/i);
    expect(diagnostic.html).not.toMatch(/seasonal|christmas|holiday/i);
  }
});

test('long County GIS credits remain visible and separate from the empty state', async ({ page }) => {
  for (const [width, height] of [[320,568],[390,664],[664,390]]) {
    await page.setViewportSize({ width, height });
    for (const id of ['childs-park', 'lake-maggiore-park', 'azalea', 'harbor-isle', 'historic-park-street', 'bartlett-park']) {
      await page.goto(`/?neighborhood=${id}`);
      await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
      const credit = page.locator('.leaflet-control-attribution');
      await expect(credit).toContainText('Pinellas County');
      await expect(credit.getByRole('link', { name: '© OpenStreetMap contributors', exact: true })).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
      const box = await credit.boundingBox();
      expect(box.y + box.height).toBeLessThanOrEqual(height - 5);
      await expect.poll(async () => {
        const card = await page.locator('.references').boundingBox();
        return (await credit.boundingBox()).y - card.y - card.height;
      }).toBeGreaterThanOrEqual(6);
    }
  }
});
