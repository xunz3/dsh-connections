import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './test/browser',
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:43187', headless: true, viewport: { width: 1000, height: 760 } },
  webServer: { command: 'node test/browser/server.mjs', url: 'http://127.0.0.1:43187', reuseExistingServer: false },
})
