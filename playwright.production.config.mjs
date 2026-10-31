import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/production',
  outputDir: 'test-results-production',
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-production-report', open: 'never' }]],
  use: {
    baseURL: process.env.PRODUCTION_URL,
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});
