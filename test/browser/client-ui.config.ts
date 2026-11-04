import { defineConfig } from '@playwright/test'

// Fulfilled routes only: no listening server, profile, build artifact, or shared
// fixture port. Native primitives are bundled only in this dev comparison.
export default defineConfig({
  testDir: '.', testMatch: 'client-ui.spec.ts', fullyParallel: false, workers: 1,
  outputDir: '../../test-results/client-ui-owned',
  use: { baseURL: 'http://connections-client-ui.test', headless: true, viewport: { width: 1000, height: 760 } },
})
