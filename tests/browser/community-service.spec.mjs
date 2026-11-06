import { test, expect } from '@playwright/test';

test('live feedback retains failed drafts and retry identity and blocks dismissal while sending', async ({ page }) => {
  const bodies = [];
  let pending;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/config') return route.fulfill({ json: { available: true, season: { id: 'christmas-2026', name: 'Christmas 2026' } } });
    if (path === '/api/listings') return route.fulfill({ json: { listings: [] } });
    if (path === '/api/feedback') {
      bodies.push(route.request().postDataJSON());
      if (bodies.length === 1) { pending = route; return; }
      return route.fulfill({ status: 200, json: { recorded: true, id: 'feedback-confirmed' } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/');
  await page.locator('[data-open-feedback]').click();
  const dialog = page.getByRole('dialog', { name: 'Ideas or feedback?', exact: true });
  await dialog.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(page.locator('#community-message-error')).toHaveText('Enter a message to send.');
  await page.locator('#community-message').fill('Please add another neighborhood.');
  await page.locator('#community-email').fill('neighbor@example.test');
  await dialog.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Send feedback', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  // Send a complete pointer gesture on the native backdrop.
  await page.mouse.click(2, 2);
  await expect(dialog).toBeVisible();
  expect(bodies).toHaveLength(1);
  await pending.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Please try again.' } } });
  await expect(dialog.locator('.community-form-notice')).toHaveText('Please try again.');
  await expect(page.locator('#community-message')).toHaveValue('Please add another neighborhood.');
  await expect(page.locator('#community-email')).toHaveValue('neighbor@example.test');
  await dialog.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Feedback sent', exact: true })).toBeVisible();
  expect(bodies).toHaveLength(2); expect(bodies[0]).toEqual(bodies[1]);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('[data-open-feedback]')).toBeFocused();
  await page.locator('[data-open-feedback]').click();
  await expect(page.locator('#community-message')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
