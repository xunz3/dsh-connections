import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.', testMatch: 'theme-acceptance.spec.ts', workers: 1,
  outputDir: '../../test-results/theme-acceptance',
  use: { baseURL: 'http://127.0.0.1:43189', headless: true },
})
