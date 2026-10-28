import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsHostSnapshot } from '../src/client/settings-host-bridge.js'

// Register against the real public slot ledger; native browser acceptance owns
// visual primitives, which import CSS and are not rendered by this test.
const nativeRequire = createRequire(import.meta.url)
const module = { exports: {} as typeof import('../src/client/settings-host-menu.js') }
const compiled = buildSync({ entryPoints: ['src/client/settings-host-menu.tsx'], bundle: true, packages: 'external', format: 'cjs', write: false }).outputFiles[0].text
runInNewContext(compiled, { module, exports: module.exports,
  require: (id: string) => id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : nativeRequire(id),
})
const { installSettingsHostHeader } = module.exports
const settled = () => new Promise<void>(resolve => setImmediate(resolve))

test('native Settings title delegation preserves its own locale, store and injection across replacement', async () => {
  const core = new SlotCore()
  const disposeRoot = core.register({ name: 'root', children: { 'settings.header': { kind: 'single', scope: 'root' } } }, (() => null) as never)
  const component = () => null, inject = () => ({ title: 'native injected title' })
  const store = { create: () => ({}) }
  const original = core.register({ name: 'settings.header', locale: 'settings', inject, store } as never, component)
  const cleanups: Array<() => void> = []
  const context = {
    locale: { subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }) },
    slots: { register: core.register.bind(core), entries: core.entries.bind(core), subscribe: core.subscribe.bind(core),
      inject: (_name: string, install: () => () => void) => { cleanups.push(install()) },
    },
  }
  const snapshot = createSnapshotStore<SettingsHostSnapshot>({ selectedId: 'local', choices: [{ id: 'local', name: 'This computer', phase: 'connected' }] })
  const alias = 'connections.settings.nativeHeader'
  try {
    installSettingsHostHeader(context as never, { ...snapshot, select() {} })
    const delegated = core.entries(alias)[0]
    assert.equal(delegated.component, component)
    assert.equal(delegated.locale, 'settings')
    assert.equal(delegated.inject, inject)
    assert.equal(delegated.store, store)
    assert.equal(core.declarationEpoch(alias), 1, 'only the wrapper declares its unique child slot')
    assert.equal(core.entriesOfSlot('settings.header').length, 1, 'one wrapper occupies the native title')
    original()
    await settled()
    assert.equal(core.entries(alias).length, 0)
    const replacement = () => null
    const removeReplacement = core.register({ name: 'settings.header', locale: 'settings' } as never, replacement)
    await settled()
    assert.equal(core.entries(alias)[0].component, replacement)
    for (const cleanup of cleanups.reverse()) cleanup()
    cleanups.length = 0
    assert.equal(core.entriesOfSlot('settings.header')[0].component, replacement, 'teardown restores the original native title')
    assert.equal(core.entries(alias).length, 0)
    removeReplacement()
  } finally { for (const cleanup of cleanups.reverse()) cleanup(); disposeRoot() }
})

test('a native title with its own child declarations is not copied into a conflicting alias', () => {
  const core = new SlotCore()
  const disposeRoot = core.register({ name: 'root', children: { 'settings.header': { kind: 'single', scope: 'root' } } }, (() => null) as never)
  const removeNative = core.register({ name: 'settings.header', children: { 'fixture.title.child': { kind: 'single', scope: 'root' } } } as never, (() => null) as never)
  let dispose = () => {}
  try {
    installSettingsHostHeader({ locale: {}, slots: {
      register: core.register.bind(core), entries: core.entries.bind(core), subscribe: core.subscribe.bind(core),
      inject: (_name: string, install: () => () => void) => { dispose = install() },
    } } as never, { getSnapshot: () => undefined, subscribe: () => () => {}, select() {} })
    assert.equal(core.entries('connections.settings.nativeHeader').length, 0)
    assert.equal(core.declarationEpoch('fixture.title.child'), 1)
  } finally { dispose(); removeNative(); disposeRoot() }
})
