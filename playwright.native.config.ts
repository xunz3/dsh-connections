import { defineConfig } from '@playwright/test'

/** Native tests use explicitly supplied, isolated Harness processes. */
export default defineConfig({
  testDir: './test/browser',
  testMatch: ['native.spec.ts', 'unified-native.spec.ts'],
  workers: 1,
  use: { headless: true, viewport: { width: 1360, height: 940 } },
})
