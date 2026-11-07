import {defineConfig, devices} from '@playwright/test';

const ci = process.env.CI === 'true' || process.env.CI === '1';

export default defineConfig({
  testDir: './apps/threadnote/test/e2e/manager',
  testMatch: '**/*.spec.ts',
  globalSetup: './apps/threadnote/test/e2e/manager/fixtures/global-setup.ts',
  fullyParallel: true,
  forbidOnly: ci,
  failOnFlakyTests: false,
  retries: ci ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  globalTimeout: 20 * 60_000,
  expect: {timeout: 10_000},
  outputDir: '.context/manager-e2e/results',
  reporter: [
    ['./apps/threadnote/test/e2e/manager/fixtures/required-cases-reporter.ts'],
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
  projects: [{name: 'chromium', use: {...devices['Desktop Chrome']}}],
});
