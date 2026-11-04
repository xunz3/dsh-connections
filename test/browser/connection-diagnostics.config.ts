import { defineConfig } from '@playwright/test'

// This task's routes are fulfilled by its exclusive spec: no shared fixture,
// fixture-server mutation, real Harness profile, or listening port is needed.
export default defineConfig({
  testDir: '.',
  testMatch: 'connection-diagnostics.spec.ts',
  fullyParallel: true,
  outputDir: '../../test-results/credential-diagnostics',
  use: { baseURL: 'http://task5-diagnostics.test', headless: true, viewport: { width: 1000, height: 760 } },
})
