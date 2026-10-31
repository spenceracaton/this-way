import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test('the expected release serves both neighborhood maps', async ({ page, request }) => {
  const receipt = JSON.parse(await readFile('release-results/receipt.json', 'utf8'));
  const metadata = await request.get(`/release.json?smoke=${Date.now()}`, {
    headers: { 'cache-control': 'no-cache' }
  });
  expect(metadata.ok()).toBe(true);
  expect(await metadata.json()).toMatchObject({
    commit: receipt.commit,
    release_id: receipt.release_id
  });

  const response = await page.goto(`/?smoke=${Date.now()}`);
  expect(response.ok()).toBe(true);
  await expect(page.getByRole('navigation', { name: 'Artwork comparison' })).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Explore a neighborhood' })).toHaveValue('old-northeast');
  await expect(page.locator('.map-pin')).toHaveCount(4);
  expect(await page.locator('img#neighborhood-artwork').evaluate(image => [image.naturalWidth, image.naturalHeight]))
    .toEqual([3220, 4228]);

  await page.getByRole('combobox', { name: 'Explore a neighborhood' }).selectOption('crescent-lake');
  await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('heading', { name: 'Crescent Lake', exact: true })).toBeVisible();
  await expect(page.locator('.map-pin')).toHaveCount(4);
  expect(await page.locator('img#neighborhood-artwork').evaluate(image => [image.naturalWidth, image.naturalHeight]))
    .toEqual([3840, 4080]);
  await page.locator('#reference-list button').filter({ hasText: '18th Avenue & 5th Street' }).click();
  await expect(page.locator('#selected-name')).toHaveText('18th Avenue & 5th Street');
});
