import { test, expect } from '@playwright/test';
const writes = new WeakMap();
test.beforeEach(async ({ page }) => {
  writes.set(page, []);
  await page.route('**/*', route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      writes.get(page).push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
});
test.afterEach(async ({ page }) => expect(writes.get(page)).toEqual([]));
const image = 'public/assets/samples/illustration-haunt.webp';

test('Add a display validates, previews safe text and photos, and preserves edits', async ({ page }) => {
  await page.goto('/?sample=a');
  await page.getByRole('button', { name: 'Add a display', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Add a display', exact: true });
  await expect(modal.getByRole('heading')).toBeFocused();
  await page.getByRole('button', { name: 'Preview display', exact: true }).click();
  await expect(page.locator('#submission-address')).toBeFocused();
  await expect(page.locator('#submission-address')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#submission-address').fill('123 Example Avenue, St Petersburg');
  await page.locator('#submission-theme').fill('<img src=x onerror=alert(1)>');
  await page.locator('#submission-description').fill('A friendly winter display.');
  await page.getByText('Add photos', { exact: false }).filter({ has: page.locator('small') }).last().click();
  await page.locator('#submission-photos').setInputFiles(image);
  await expect(page.locator('#submission-photo-previews img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Preview display', exact: true }).click();
  await expect(page.locator('#submission-preview-card')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#submission-preview-card img')).toHaveCount(1);
  await expect(page.locator('#submission-preview')).toContainText(/not submitted|Nothing.*submitted|Not submitted/i);
  await page.getByRole('button', { name: /Back to editing|Edit/ }).click();
  await expect(page.locator('#submission-description')).toHaveValue('A friendly winter display.');
  await page.keyboard.press('Escape');
  await expect(page.locator('#add-display')).toBeFocused();
  await expect(page.locator('#selection')).toHaveAttribute('data-selected', 'a');
});

test('reports retain context, reset for a new display, and feedback validates email', async ({ page }) => {
  await page.goto('/?sample=a');
  await page.locator('#detail-report').click();
  const report = page.getByRole('dialog', { name: 'Report this display' });
  await expect(report).toContainText('255 9th Ave NE');
  await report.getByRole('button', { name: 'Preview report' }).click();
  await expect(page.locator('#community-reason')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#community-reason').selectOption('incorrect-address');
  await page.locator('#community-details').fill('The display is across the road.');
  await report.getByRole('button', { name: 'Preview report' }).click();
  await expect(report).toContainText('Preview only. Not sent.');
  await expect(report).toContainText('The display is across the road.');
  await report.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('#detail-report')).toBeFocused();
  await page.locator('#detail-close').click();
  await page.locator('#reference-list button').nth(2).click();
  await page.locator('#detail-report').click();
  await expect(page.locator('#community-reason')).toHaveValue('');
  await expect(page.locator('#community-details')).toHaveValue('');
  await page.keyboard.press('Escape');
  await page.locator('[data-open-feedback]').click();
  const feedback = page.getByRole('dialog', { name: 'Ideas or feedback?' });
  await page.locator('#community-message').fill('Please add another neighborhood.');
  await page.locator('#community-email').fill('not-an-email');
  await feedback.getByRole('button', { name: 'Preview feedback' }).click();
  await expect(page.locator('#community-email')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#community-email').fill('neighbor@example.test');
  await feedback.getByRole('button', { name: 'Preview feedback' }).click();
  await expect(feedback).toContainText('Please add another neighborhood.');
  await expect(feedback).toContainText('Preview only. Not sent.');
});

test('photo contributions reject broken images and preview valid photos without uploading', async ({ page }) => {
  await page.goto('/?sample=d');
  await page.locator('#detail-add-photos').click();
  const modal = page.getByRole('dialog', { name: 'Add photos', exact: true });
  const input = modal.locator('input[type=file]');
  await input.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await expect(modal.locator('.photo-contribution-error')).not.toBeEmpty();
  await expect(modal.locator('.photo-contribution-previews img')).toHaveCount(0);
  await input.setInputFiles(image);
  await expect(modal.locator('.photo-contribution-previews img')).toHaveCount(1);
  await modal.getByRole('checkbox').check();
  await modal.getByRole('button', { name: 'Preview photos', exact: true }).click();
  await expect(modal).toContainText('Preview only. Not uploaded.');
  await expect(modal.locator('.photo-contribution-preview-images img')).toHaveCount(1);
  await modal.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('#detail-add-photos')).toBeFocused();
});

test('review demo supports filtered decisions and undo without publishing', async ({ page }) => {
  await page.goto('/review.html');
  await expect(page.locator('.demo-banner')).toContainText('Demo');
  await expect(page.locator('#pending-count')).toHaveText('4');
  await page.locator('[data-record]').first().click();
  await page.getByRole('button', { name: /Approve in demo/ }).click();
  await expect(page.locator('#approved-count')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Undo decision' })).toBeFocused();
  await page.getByRole('button', { name: 'Undo decision' }).click();
  await expect(page.locator('#pending-count')).toHaveText('4');
  await page.getByRole('button', { name: 'Reject…' }).click();
  await page.locator('#reject-reason').selectOption({ label: 'Address needs clarification' });
  await page.locator('#reject-note').fill('Please include a city.');
  await page.getByRole('button', { name: 'Reject in demo', exact: true }).click();
  await expect(page.locator('#rejected-count')).toHaveText('1');
  await expect(page.locator('#detail-content')).toContainText('Please include a city.');
  await page.reload();
  await expect(page.locator('#pending-count')).toHaveText('4');
});

test('all form dialogs fit short screens and preserve dismissal focus', async ({ page }) => {
  for (const [width, height] of [[320,568],[390,664],[664,390]]) {
    await page.setViewportSize({ width, height });
    for (const [trigger, name] of [['#add-display','Add a display'],['#detail-report','Report this display'],['#detail-add-photos','Add photos'],['[data-open-feedback]','Ideas or feedback?']]) {
      await page.goto('/?sample=a');
      await page.locator(trigger).click();
      const modal = page.getByRole('dialog', { name, exact: true });
      const box = await modal.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const ids = await page.locator('[id]').evaluateAll(els => els.map(el => el.id));
      expect(new Set(ids).size).toBe(ids.length);
      await page.keyboard.press('Escape');
      await expect(modal).toBeHidden();
      await expect(page.locator(trigger)).toBeFocused();
    }
  }
});

test('short-phone form bodies scroll to optional fields without hiding actions', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await page.locator('#add-display').click();
  const body = page.locator('#submission-scroll');
  await expect(body).toHaveAttribute('data-more-below', 'true');
  await page.locator('summary').filter({ hasText: 'Seasonal tags' }).click();
  await page.getByRole('checkbox', { name: 'Santa', exact: true }).check();
  await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(body).toHaveAttribute('data-more-below', 'false');
  const action = page.locator('#submission-preview-button');
  const box = await action.boundingBox();
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.id,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 })).toBe('submission-preview-button');
});
