import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopBrowser } from '../src/client/desktop-guest.js'
import { isWorkspaceSurface, workspaceUrl } from '../src/client/workspace-surface.js'

test('settings and content accept the native desktop capability without broadening browser origins', () => {
  const key = 'dshDesktop'
  const previous = Object.getOwnPropertyDescriptor(globalThis, key)
  const bridge = { acquire() {}, release() {}, onOpenRequested() {} }
  const url = 'http://127.0.0.1:43188/?token=surface-test-private-credential'
  const browserOnlyPages = [
    { protocol: 'dsh-app:', hostname: 'app' },
    { protocol: 'file:', hostname: '' },
    { protocol: 'https:', hostname: 'localhost' },
    { protocol: 'http:', hostname: 'remote.example' },
    { protocol: 'http:', hostname: '[::1]' },
  ]
  try {
    for (const carrier of [undefined, { protocolVersion: 2, browser: bridge }, { protocolVersion: 1 },
      { protocolVersion: 1, browser: {} }, { protocolVersion: 1, browser: { ...bridge, release: null } },
    ]) {
      Object.defineProperty(globalThis, key, { value: carrier, configurable: true })
      assert.equal(desktopBrowser(), undefined)
      for (const page of browserOnlyPages) {
        const desktop = desktopBrowser() !== undefined
        assert.equal(isWorkspaceSurface(page, desktop), false)
        assert.throws(() => workspaceUrl(url, page, desktop), /unsupported-workspace-surface/)
      }
      for (const hostname of ['127.0.0.1', 'localhost']) {
        const page = { protocol: 'http:', hostname }
        assert.equal(isWorkspaceSurface(page, desktopBrowser() !== undefined), true)
        assert.equal(new URL(workspaceUrl(url, page, false)).hostname, hostname)
      }
    }
    Object.defineProperty(globalThis, key, { value: { protocolVersion: 1, browser: bridge }, configurable: true })
    assert.equal(desktopBrowser(), bridge)
    for (const page of browserOnlyPages) {
      const desktop = desktopBrowser() !== undefined
      assert.equal(isWorkspaceSurface(page, desktop), true)
      assert.equal(workspaceUrl(url, page, desktop), url, 'desktop guests retain their validated loopback origin')
    }
    assert.throws(() => workspaceUrl('https://remote.example/?token=surface-test-private-credential', browserOnlyPages[0]!, true))
  } finally {
    if (previous) Object.defineProperty(globalThis, key, previous)
    else Reflect.deleteProperty(globalThis, key)
  }
})
