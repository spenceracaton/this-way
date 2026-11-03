import { test, expect } from '@playwright/test';

const trigger = page => page.getByRole('button', { name: 'Explore a neighborhood' });
const dialog = page => page.getByRole('dialog', { name: 'Neighborhoods' });
const search = page => dialog(page).getByRole('searchbox');

test('picker search, current selection and dismissal preserve map context', async ({ page }) => {
  await page.goto('/?sample=a&diagnostic=1&artwork=raster');
  await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
  const camera = await page.locator('.leaflet-map-pane').getAttribute('style');
  await trigger(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('heading', { name: 'Neighborhoods' })).toBeFocused();
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog(page).getByRole('option', { selected: true })).toContainText('Old Northeast');
  await expect(dialog(page).getByRole('option')).toHaveCount(87);
  await search(page).fill('CrEsCeNt-Lake');
  await expect(dialog(page).getByRole('option')).toHaveCount(1);
  await expect(dialog(page).getByRole('option')).toContainText('Crescent Lake');
  await search(page).fill('not a neighborhood');
  await expect(dialog(page).getByRole('option')).toHaveCount(0);
  await expect(dialog(page).getByText('No matching neighborhoods.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
  await trigger(page).click();
  await expect(search(page)).toHaveValue('');
  await dialog(page).getByRole('option', { name: /Old Northeast/ }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(page).toHaveURL(/sample=a/);
  await expect(page.locator('#selection')).toHaveAttribute('data-selected', 'a');
  expect(await page.locator('.leaflet-map-pane').getAttribute('style')).toBe(camera);
});

test('picker keyboard selection preserves diagnostics and clears the previous sample', async ({ page }) => {
  await page.goto('/?sample=c&diagnostic=1&artwork=raster');
  await trigger(page).click();
  await page.keyboard.press('ArrowDown');
  await expect(dialog(page).getByRole('option').first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(dialog(page).getByRole('option').last()).toBeFocused();
  await search(page).fill('Crescent Lake');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveTitle('This Way · Crescent Lake');
  const params = new URL(page.url()).searchParams;
  expect(params.get('neighborhood')).toBe('crescent-lake');
  expect(params.get('diagnostic')).toBe('1');
  expect(params.get('artwork')).toBe('raster');
  expect(params.has('sample')).toBe(false);
  await expect(page.locator('#selection')).toBeHidden();
});

test('picker opens a recovered map-only neighborhood and clears the sample card', async ({ page }) => {
  await page.goto('/?sample=c');
  await expect(page.locator('#selection')).toHaveAttribute('data-selected', 'c');
  await trigger(page).click();
  await search(page).fill('Harbor Isle');
  await expect(dialog(page).getByRole('option')).toHaveCount(1);
  await dialog(page).getByRole('option', { name: /Harbor Isle/ }).click();
  await expect(page).toHaveTitle('This Way · Harbor Isle');
  await expect(page.locator('#map')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#selection')).toBeHidden();
  await expect(page.locator('.map-pin')).toHaveCount(0);
  await expect(page.locator('#reference-list')).toContainText('No sample addresses here yet.');
  expect(new URL(page.url()).searchParams.has('sample')).toBe(false);
});

test('wrapped neighborhood titles keep both icons aligned with the first line', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  for (const id of ['historic-park-street', 'lake-maggiore-shores', 'northeast-terraces']) {
    await page.goto(`/?neighborhood=${id}`);
    const name = await page.locator('#neighborhood-name').boundingBox();
    for (const icon of ['.neighborhood-pin', '.neighborhood-chevron']) {
      const box = await page.locator(`#neighborhood-select ${icon}`).boundingBox();
      expect(Math.abs(box.y + box.height / 2 - name.y - 14.4)).toBeLessThanOrEqual(1);
    }
    await trigger(page).click();
    await expect(dialog(page)).toBeVisible();
  }
});

test('picker fits narrow, short and desktop viewports without moving on search', async ({ page }) => {
  for (const [width, height] of [[320,568],[664,390],[721,568],[1280,900]]) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await trigger(page).click();
    const before = await dialog(page).boundingBox();
    expect(before.x).toBeGreaterThanOrEqual(0);
    expect(before.y).toBeGreaterThanOrEqual(0);
    expect(before.x + before.width).toBeLessThanOrEqual(width + 1);
    expect(before.y + before.height).toBeLessThanOrEqual(height + 1);
    if (width <= 720) expect(before.y + before.height).toBeCloseTo(height, 0);
    else {
      const opener = await trigger(page).boundingBox();
      expect(Math.abs(before.y - opener.y - opener.height - 2)).toBeLessThanOrEqual(1);
    }
    await search(page).fill('no match');
    const filtered = await dialog(page).boundingBox();
    if (width <= 720) expect(filtered.height).toBe(before.height);
    await dialog(page).getByRole('button', { name: 'Close neighborhood picker' }).click();
    await expect(trigger(page)).toBeFocused();
  }
});
