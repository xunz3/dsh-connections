import { defineConfig } from '@playwright/test'
import './test/browser/loopback-proxy.js'

export default defineConfig({
  testDir: './test/browser',
  testIgnore: [
    '**/native.spec.ts', '**/unified-native.spec.ts',
    ...(process.env.DSH_DESKTOP_CONTRACT === '1' ? [] : ['**/workspaces.desktop.spec.ts']),
  ],
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:43187', headless: true, viewport: { width: 1000, height: 760 } },
  webServer: { command: 'node test/browser/server.mjs', url: 'http://127.0.0.1:43187', reuseExistingServer: false },
})
