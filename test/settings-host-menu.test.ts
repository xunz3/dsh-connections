import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { getEventListeners } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { buildSync, transformSync } from 'esbuild'
import { createSnapshotStore } from '../src/client/snapshot-store.js'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { WorkspaceController, viewClientId } from '../src/client/workspace-controller.js'
import { CONNECTION_CONTRACTS } from '../src/shared/contracts.js'
import { WORKSPACE_PROTOCOL } from '../src/shared/workspace-protocol.js'
import { settingsShell } from '../src/client/native-settings.js'
import { workspaceUrl } from '../src/client/workspace-surface.js'
import { createSurfaceReadinessDeadline } from '../src/client/view-surface.js'
import type { WorkspaceRequest } from '../src/shared/workspace-protocol.js'
import type { SettingsHostSnapshot } from '../src/client/settings-host-bridge.js'

// Use the real public slot ledger. Browser acceptance owns the visual primitives.
const nativeRequire = createRequire(import.meta.url)
const module = { exports: {} as typeof import('../src/client/settings-host-menu.js') }
const compiled = buildSync({ entryPoints: ['src/client/settings-host-menu.tsx'], bundle: true, packages: 'external', format: 'cjs', write: false }).outputFiles[0].text
runInNewContext(compiled, { module, exports: module.exports,
  require: (id: string) => id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : nativeRequire(id),
})
const { installSettingsHostHeader } = module.exports
const settled = () => new Promise<void>(resolve => setImmediate(resolve))
const snapshot = () => createSnapshotStore<SettingsHostSnapshot>({ selectedId: 'local', choices: [{ id: 'local', name: 'This computer', phase: 'connected' }] })

function fixture() {
  const core = new SlotCore(), cleanups: Array<() => void> = [], warnings: string[] = []
  const disposeRoot = core.register({ name: 'root', children: {
    'settings.header': { kind: 'single', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
    'sidebar.settings': { kind: 'single', scope: 'root' },
  } }, (() => null) as never)
  let failAlias = false
  let registrations = 0
  const context = {
    locale: { subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }) },
    logger: { warn(message: string) { warnings.push(message) } },
    effect(factory: () => () => void) { cleanups.push(factory()) },
    slots: {
      register(options: { name: string }, component: unknown) {
        registrations++
        if (failAlias && options.name === 'connections.settings.nativeHeader') throw new Error('Fixture alias failure')
        return core.register(options as never, component as never)
      },
      entries: core.entries.bind(core), entriesOfSlot: core.entriesOfSlot.bind(core), subscribe: core.subscribe.bind(core),
      inject: (_name: string, install: () => () => void) => { cleanups.push(install()) },
    },
  }
  return {
    core, context, warnings, cleanups,
    get registrations() { return registrations },
    set failAlias(value: boolean) { failAlias = value },
    dispose() { for (const cleanup of cleanups.reverse()) cleanup(); cleanups.length = 0; disposeRoot() },
  }
}

test('native Settings title delegation preserves locale, store and injection across replacement', async () => {
  const f = fixture(), component = () => null, inject = () => ({ title: 'native injected title' })
  const store = { create: () => ({}) }
  const original = f.core.register({ name: 'settings.header', locale: 'settings', inject, store } as never, component)
  const alias = 'connections.settings.nativeHeader'
  try {
    const header = installSettingsHostHeader(f.context as never, { ...snapshot(), select() {} })
    assert.equal(header.isReady(), true)
    assert.equal(f.core.entriesOfSlot('settings.header')[0].options.priority, -1)
    const delegated = f.core.entries(alias)[0]
    assert.equal(delegated.component, component)
    assert.equal(delegated.locale, 'settings')
    assert.equal(delegated.inject, inject)
    assert.equal(delegated.store, store)
    assert.equal(f.core.declarationEpoch(alias), 1)
    original()
    assert.equal(header.isReady(), false, 'readiness must reflect the live ledger before batched subscribers run')
    await settled()
    assert.equal(f.core.entries(alias).length, 0)
    const replacement = () => null
    f.core.register({ name: 'settings.header', locale: 'settings' } as never, replacement)
    await settled()
    assert.equal(header.isReady(), true)
    assert.equal(f.core.entries(alias)[0].component, replacement)
    for (const cleanup of f.cleanups.reverse()) cleanup()
    f.cleanups.length = 0
    assert.equal(header.isReady(), false)
    assert.equal(f.core.entriesOfSlot('settings.header')[0].component, replacement)
    assert.equal(f.core.entries(alias).length, 0)
  } finally { f.dispose() }
})

test('a native title with its own children is left rendered, rather than copied into a blank alias', () => {
  const f = fixture(), native = () => null
  f.core.register({ name: 'settings.header', locale: 'settings', children: { 'fixture.title.child': { kind: 'single', scope: 'root' } } } as never, native)
  try {
    const header = installSettingsHostHeader(f.context as never, { ...snapshot(), select() {} })
    assert.equal(header.isReady(), false)
    assert.equal(f.core.entriesOfSlot('settings.header')[0].component, native)
    assert.equal(f.core.entries('connections.settings.nativeHeader').length, 0)
    assert.equal(f.core.declarationEpoch('fixture.title.child'), 1)
  } finally { f.dispose() }
})

test('preexisting and later priority providers retain their Settings header and readiness recovers after they leave', async () => {
  for (const preexisting of [false, true]) {
    const f = fixture(), native = () => null, foreign = () => null, readiness: boolean[] = []
    f.core.register({ name: 'settings.header', locale: 'settings' } as never, native)
    let removeForeign: (() => void) | undefined
    if (preexisting) removeForeign = f.core.register({ name: 'settings.header', priority: -1 }, foreign)
    try {
      const header = installSettingsHostHeader(f.context as never, { ...snapshot(), select() {} }, ready => readiness.push(ready))
      if (!preexisting) {
        assert.equal(header.isReady(), true)
        removeForeign = f.core.register({ name: 'settings.header', priority: -2 }, foreign)
        assert.equal(header.isReady(), false, 'a retained menu cannot route during the batched conflict-notification window')
      }
      await settled()
      assert.equal(header.isReady(), false)
      assert.equal(f.core.entriesOfSlot('settings.header')[0].component, foreign)
      assert.equal(f.core.entries('settings.header').length, 2, 'only native and third-party providers remain')
      assert.equal(f.core.entries('connections.settings.nativeHeader').length, 0)
      const count = readiness.length
      await settled()
      assert.equal(readiness.length, count, 'unchanged conflicts do not repeatedly close dependent views')
      removeForeign!(); await settled()
      assert.equal(header.isReady(), true)
      assert.equal(f.core.entries('connections.settings.nativeHeader')[0].component, native)
      assert.equal(f.warnings.length, 1)
      assert.deepEqual(readiness, preexisting ? [false, true] : [false, true, false, true])
    } finally { f.dispose() }
  }
})

test('missing or foreign native leaf never grants readiness; alias failure leaves native Settings and does not retry-spin', async () => {
  const f = fixture(), readiness: boolean[] = [], native = () => null
  try {
    const header = installSettingsHostHeader(f.context as never, { ...snapshot(), select() {} }, ready => readiness.push(ready))
    assert.equal(header.isReady(), false)
    const removeUnknown = f.core.register({ name: 'settings.header', locale: 'third-party' } as never, (() => null) as never)
    await settled()
    assert.equal(header.isReady(), false)
    removeUnknown()
    f.failAlias = true
    f.core.register({ name: 'settings.header', locale: 'settings' } as never, native)
    await settled(); await settled()
    const count = f.registrations
    assert.equal(header.isReady(), false)
    assert.deepEqual(readiness, [false])
    assert.equal(f.core.entriesOfSlot('settings.header')[0].component, native)
    assert.equal(f.core.specDynamic('connections.settings.nativeHeader'), undefined)
    await settled()
    assert.equal(f.registrations, count, 'registration failure is latched for this declaration lifetime')
  } finally { f.dispose() }
})

function loadHostSettings(capture: (source: import('../src/client/settings-host-menu.js').SettingsHostSource) => void, globals: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  const compiled = transformSync(readFileSync(new URL('../src/client/host-settings.tsx', import.meta.url), 'utf8'), {
    loader: 'tsx', jsx: 'automatic', format: 'cjs', target: 'es2022',
  }).code
  const host = { exports: {} as typeof import('../src/client/host-settings.js') }
  const imports: Record<string, unknown> = {
    react: nativeRequire('react'), 'react/jsx-runtime': nativeRequire('react/jsx-runtime'), 'react-dom': nativeRequire('react-dom'),
    './snapshot-store.js': { createSnapshotStore }, './ui/index.js': {},
    './workspace-controller.js': { WorkspaceController, viewClientId },
    './workspaces.js': { workspaceMessages: { en: {}, zh: {} } }, './workspace-surface.js': { workspaceUrl },
    './native-settings.js': { settingsShell }, './settings-host-bridge.js': {},
    './settings-host-menu.js': { ...module.exports, installSettingsHostHeader(ctx: unknown, source: import('../src/client/settings-host-menu.js').SettingsHostSource, ready: (ready: boolean) => void) {
      capture(source); return installSettingsHostHeader(ctx as never, source, ready)
    } },
    './desktop-guest.js': { desktopBrowser: () => undefined }, './settings-host-relay.js': {},
    './local-surface.js': { localSurface: () => undefined }, './connection-polling.js': { scheduleVisiblePoll: () => () => {} },
    './view-surface.js': { createSurfaceReadinessDeadline },
  }
  Object.assign(imports, overrides)
  runInNewContext(compiled, { module: host, exports: host.exports, URL, AbortController, setTimeout, clearTimeout,
    window: { location: { protocol: 'http:', hostname: '127.0.0.1' } },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }, ...globals,
    require(id: string) { assert.ok(id in imports, `unexpected host settings import ${id}`); return imports[id] },
  })
  return host.exports.installHostSettings
}

test('header conflict closes and revokes only the dependent remote Settings view; stale source actions cannot reopen it', async () => {
  const f = fixture(), nativeTitle = () => null, foreign = () => null
  const remote = 'connection-11111111-1111-4111-a111-111111111111'
  let source!: import('../src/client/settings-host-menu.js').SettingsHostSource
  const installHostSettings = loadHostSettings(value => { source = value })
  let nativeClosed = 0, localOpened = 0, channelId = 0
  const nativeSettings = {
    getSnapshot: () => ({ open: true }), subscribe: () => () => {},
    actions: { open() {}, close() { nativeClosed++ }, openSection() { localOpened++ } },
  }
  f.core.register({ name: 'settings.header', locale: 'settings' } as never, nativeTitle)
  f.core.register({ name: 'sidebar.settings', locale: 'settings', store: { create: () => nativeSettings } } as never, (() => null) as never)
  const channels = new Set<string>()
  const api = {
    async list() { return [{ id: remote, name: 'Remote', target: 'remote', phase: 'connected', remotePort: 3000, localPort: 43188 }] },
    async open() { return { url: 'http://127.0.0.1:43188/?token=settings-private-test-credential' } },
    async workspace(_id: string, request: WorkspaceRequest) {
      if (request.op === 'openView') {
        const channel = String(++channelId).padStart(43, 'a'); channels.add(channel)
        return { protocol: WORKSPACE_PROTOCOL, contracts: { ...CONNECTION_CONTRACTS }, channel, revision: 0, presentedRevision: 0, reportedRevision: 0 }
      }
      if (request.op === 'closeView') { channels.delete(request.channel); return { closed: true } }
      return { revision: 1, presentedRevision: 0, reportedRevision: 0 }
    },
  }
  try {
    const handle = installHostSettings(f.context as never, api as never)
    await settled()
    const changes: unknown[] = []
    const off = handle.subscribe(() => changes.push(handle.getSnapshot()))
    await source.select(remote)
    assert.equal(handle.getSnapshot()?.phase, 'ready')
    assert.equal(channels.size, 1)
    assert.equal(nativeClosed, 1)
    const removeForeign = f.core.register({ name: 'settings.header', priority: -2 }, foreign)
    await settled()
    assert.equal(handle.getSnapshot(), undefined)
    assert.equal(channels.size, 0, 'losing the only host-navigation entry releases the remote view lease')
    assert.equal(f.core.entriesOfSlot('settings.header')[0].component, foreign)
    assert.equal(localOpened, 0, 'conflict withdrawal is not an implicit user navigation to local General')
    await assert.rejects(Promise.resolve().then(() => source.select(remote)), /unavailable/)
    assert.equal(nativeClosed, 1, 'a stale remote selector cannot even close the native Settings dialog')
    removeForeign(); await settled()
    await source.select(remote)
    assert.equal(handle.getSnapshot()?.phase, 'ready')
    assert.equal(channels.size, 1)
    assert.ok(changes.length > 0, 'the shared native-navigation guard can observe Settings ownership')
    off()
  } finally { f.dispose() }
  assert.equal(channels.size, 0)
})

test('the Remote Settings Retry button refreshes a restarted managed Host even while SSH is connected', async t => {
  const f = fixture()
  t.after(() => f.dispose())
  let source!: import('../src/client/settings-host-menu.js').SettingsHostSource
  const react = nativeRequire('react')
  const installHostSettings = loadHostSettings(value => { source = value }, {}, {
    react: { ...react, useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
      useRef: (current: unknown) => ({ current }), useState: (initial: unknown) => [initial, () => {}], useEffect() {} },
    'react-dom': { createPortal: (element: unknown) => element },
    './ui/index.js': { Modal: () => null, useModalLayer() {} },
    './workspaces.js': { workspaceMessages: { en: { failed: 'Failed' }, zh: { failed: '失败' } } },
  })
  f.core.register({ name: 'settings.header', locale: 'settings' } as never, (() => null) as never)
  const native = { getSnapshot: () => ({ open: true }), subscribe: () => () => {}, actions: { open() {}, close() {}, openSection() {} } }
  f.core.register({ name: 'sidebar.settings', locale: 'settings', store: { create: () => native } } as never, (() => null) as never)
  const id = 'connection-11111111-1111-4111-a111-111111111111'
  const row = { id, name: 'Remote', target: 'remote', phase: 'connected', remotePort: 3000, localPort: 43188, transportId: crypto.randomUUID() }
  let reconnects = 0, failedOpen = true, channel = 0
  const targets: unknown[] = []
  const api = {
    async list() { return [{ ...row }] },
    async reconnect() { reconnects++; failedOpen = false; row.localPort = 43200; row.transportId = crypto.randomUUID(); return { ...row } },
    async open() { if (failedOpen) throw new Error('The managed Harness restarted'); return { url: `http://127.0.0.1:${row.localPort}/?token=settings-private-test-credential` } },
    async workspace(_id: string, request: WorkspaceRequest) {
      if (request.op === 'openView') return { protocol: WORKSPACE_PROTOCOL, contracts: { ...CONNECTION_CONTRACTS }, channel: String(++channel).padStart(43, 'a'), revision: 0, presentedRevision: 0, reportedRevision: 0 }
      if (request.op === 'closeView') return { closed: true }
      if (request.op === 'navigate') targets.push(structuredClone(request.target))
      return { revision: 1, presentedRevision: 1, reportedRevision: 1 }
    },
  }
  const handle = installHostSettings(f.context as never, api as never)
  await settled(); await source.select(id); await settled()
  assert.equal(handle.getSnapshot()?.phase, 'error')
  const Overlay = f.core.entries('shell.overlay').find(entry => entry.options.id === 'connections.settings')!.component as () => unknown
  const nodes = (node: unknown): Array<{ type: unknown; props: Record<string, unknown> }> => {
    if (Array.isArray(node)) return node.flatMap(nodes)
    if (!node || typeof node !== 'object' || !('props' in node)) return []
    const element = node as { type: unknown; props: Record<string, unknown> }
    return [element, ...nodes(element.props.children)]
  }
  const button = nodes(Overlay()).find(node => node.type === 'button' && node.props.children === 'Retry')
  assert.ok(button, 'verify the actual rendered Settings error button wiring')
  const reconnect = button.props.onClick as () => void
  reconnect()
  await settled()
  assert.equal(reconnects, 1)
  assert.equal(handle.getSnapshot()?.phase, 'ready')
  assert.equal(new URL(handle.getSnapshot()!.url!).port, '43200')
  assert.deepEqual(targets, [{ kind: 'settings' }])
})

class Visibility extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible'
  set(value: DocumentVisibilityState) { this.visibilityState = value; this.dispatchEvent(new Event('visibilitychange')) }
}

for (const initial of ['visible', 'hidden'] as const) {
  test(`remote Settings started ${initial} pauses its production presentation watchdog and reconciles on resume`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 })
    const f = fixture(), document = new Visibility()
    const window = Object.assign(new EventTarget(), { location: { protocol: 'http:', hostname: '127.0.0.1' } })
    document.set(initial)
    let source!: import('../src/client/settings-host-menu.js').SettingsHostSource
    const installHostSettings = loadHostSettings(value => { source = value }, { document, window })
    f.core.register({ name: 'settings.header', locale: 'settings' } as never, (() => null) as never)
    const nativeSettings = {
      getSnapshot: () => ({ open: true }), subscribe: () => () => {}, actions: { open() {}, close() {}, openSection() {} },
    }
    f.core.register({ name: 'sidebar.settings', locale: 'settings', store: { create: () => nativeSettings } } as never, (() => null) as never)
    const remote = 'connection-11111111-1111-4111-a111-111111111111'
    let lists = 0, checks = 0, closes = 0, presented = false
    const api = {
      async list() { lists++; return [{ id: remote, name: 'Remote', target: 'remote', phase: 'connected', remotePort: 3000, localPort: 43188 }] },
      async open() { return { url: 'http://127.0.0.1:43188/?token=settings-private-test-credential' } },
      async workspace(_id: string, request: WorkspaceRequest) {
        if (request.op === 'openView') return { protocol: WORKSPACE_PROTOCOL, contracts: { ...CONNECTION_CONTRACTS }, channel: 'a'.repeat(43), revision: 0, presentedRevision: 0, reportedRevision: 0 }
        if (request.op === 'viewState') checks++
        if (request.op === 'closeView') { closes++; return { closed: true } }
        return { revision: 1, presentedRevision: presented ? 1 : 0, reportedRevision: presented ? 1 : 0 }
      },
    }
    t.after(() => f.dispose())
    const handle = installHostSettings(f.context as never, api as never)
    assert.equal(getEventListeners(window, 'pagehide').length, 1)
    assert.equal(getEventListeners(window, 'pageshow').length, 1)
    assert.equal(getEventListeners(document, 'visibilitychange').length, 1)
    await settled()
    await source.select(remote)
    await settled()
    assert.equal(handle.getSnapshot()?.phase, 'ready')
    assert.equal(handle.getSnapshot()?.presented, false)
    if (initial === 'visible') { t.mock.timers.tick(4000); await settled(); document.set('hidden') }
    const before = { lists, checks, closes }
    t.mock.timers.tick(10 * 60_000)
    await settled()
    assert.deepEqual({ lists, checks, closes }, before, 'hidden Settings must not poll or lose its lease to a local timer')
    assert.equal(handle.getSnapshot()?.phase, 'ready')
    presented = true
    document.set('visible')
    await settled()
    assert.equal(handle.getSnapshot()?.presented, true)
    assert.equal(checks - before.checks, 1, 'resume checks the current authenticated view')
    t.mock.timers.tick(60_000)
    await settled()
    assert.equal(handle.getSnapshot()?.phase, 'ready')
    f.dispose()
    assert.equal(getEventListeners(document, 'visibilitychange').length, 0)
    assert.equal(getEventListeners(window, 'pagehide').length, 0)
    assert.equal(getEventListeners(window, 'pageshow').length, 0)
    assert.equal(closes, 1, 'disposing the owner still releases the remote Settings lease')
    const disposed = { lists, checks, closes }
    document.set('hidden'); document.set('visible')
    t.mock.timers.tick(60_000)
    await settled()
    assert.deepEqual({ lists, checks, closes }, disposed, 'an unloaded entry cannot restart presentation work')
  })
}
