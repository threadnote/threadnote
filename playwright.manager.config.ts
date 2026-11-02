import {defineConfig, devices} from '@playwright/test';

const ci = process.env.CI === 'true' || process.env.CI === '1';
const compatibility = process.env.THREADNOTE_MANAGER_E2E_FULL_BROWSERS === '1' ? undefined : /@compat/u;

export default defineConfig({
  testDir: './apps/threadnote/test/e2e/manager',
  testMatch: '**/*.spec.ts',
  globalSetup: './apps/threadnote/test/e2e/manager/fixtures/global-setup.ts',
  fullyParallel: true,
  forbidOnly: ci,
  failOnFlakyTests: ci,
  retries: ci ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  globalTimeout: 20 * 60_000,
  expect: {timeout: 10_000},
  outputDir: '.context/manager-e2e/results',
  reporter: [
    ['list'],
    ['html', {outputFolder: '.context/manager-e2e/report', open: 'never'}],
    ['junit', {outputFile: '.context/manager-e2e/junit.xml'}],
  ],
  use: {
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    {name: 'chromium', use: {...devices['Desktop Chrome']}},
    {name: 'firefox', grep: compatibility, use: {...devices['Desktop Firefox']}},
    {name: 'webkit', grep: compatibility, use: {...devices['Desktop Safari']}},
  ],
});
