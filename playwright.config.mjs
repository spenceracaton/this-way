import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    { name: 'phone-webkit', use: { ...devices['iPhone 13'], defaultBrowserType: 'webkit' } }
  ],
  webServer: {
    command: 'node scripts/serve.mjs --port 5173',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false
  }
});
