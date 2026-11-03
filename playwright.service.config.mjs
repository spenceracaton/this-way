import { defineConfig, devices } from '@playwright/test';

const chromium = {
  name: 'desktop-chromium',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 900 },
    ...(process.env.CHROMIUM_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } }
      : {})
  }
};

export default defineConfig({
  testDir: './tests/service-browser',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: './test-results/service-browser',
  use: {
    baseURL: process.env.SERVICE_BROWSER_BASE_URL || 'http://127.0.0.1:8787',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    chromium,
    { name: 'phone-webkit', use: { ...devices['iPhone 13'], defaultBrowserType: 'webkit' } }
  ]
});
