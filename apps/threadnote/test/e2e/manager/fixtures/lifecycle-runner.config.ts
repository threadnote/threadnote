import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: 'lifecycle-child.ts',
  workers: 1,
  retries: process.env.MANAGER_E2E_LIFECYCLE_MODE === 'retry' ? 1 : 0,
  timeout: 20_000,
  reporter: [['line']],
  outputDir: process.env.MANAGER_E2E_LIFECYCLE_OUTPUT,
});
