import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { Context, Service } from '@deepseek-ai/cordis'
import * as stores from '@deepseek-ai/dsh-client-store'
import * as ownedStores from '../src/client/snapshot-store.js'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import * as connectionMessages from '../src/client/messages.js'
import { settingsShell } from '../src/client/native-settings.js'
import * as routing from '../src/client/native-shell-routing.js'
import { transformSync } from 'esbuild'
import type { SidebarRootInjected } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'

// The native deployment is deliberately independent of Connections. Exercise its
// real ModuleLoader factory; only unrendered visual primitives are stubbed.
const require = createRequire(import.meta.url)
let nativeSidebar!: typeof import('@deepseek-ai/dsh-client-ui-sidebar/client')
const modules: Record<string, unknown> = {
  '@deepseek-ai/dsh-client-store': stores, '@deepseek-ai/dsh-client-ui-slots': slots,
  react: React, 'react/jsx-runtime': jsx, '@deepseek-ai/dsh-client-ui-primitives': {},
}
runInNewContext(readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-sidebar/client'), 'utf8'), {
  window: { __ModuleLoader__: { load(registration: { factory(require: (id: string) => unknown): typeof nativeSidebar }) {
    nativeSidebar = registration.factory(id => {
      assert.ok(id in modules, `unexpected native dependency ${id}`)
      return modules[id]
    })
  } } },
})

class NativeWorkspace {
  #value = 'native-receiver'
  calls: unknown[][] = []
  constructor(private readonly navigate: () => void) {}
  startSession(...args: unknown[]) { this.calls.push(['start', ...args]); this.navigate() }
  openSession(...args: unknown[]) { this.calls.push(['open', this.#value, ...args]); this.navigate() }
  get marker() { return this.#value }
  futureMethod() { return this.#value }
}

/** Native UiWorkspaceService is a Cordis Service, not a plain navigation bag. */
class TrackedNativeWorkspace extends Service {
  private value = 'native-receiver'
  calls: unknown[][] = []
  constructor(ctx: Context, private readonly navigate: () => void) { super(ctx, 'uiWorkspace') }
  startSession(...args: unknown[]) { this.calls.push(['start', ...args]); this.navigate() }
  openSession(...args: unknown[]) { this.calls.push(['open', this.value, ...args]); this.navigate() }
  get marker() { return this.value }
  futureMethod() { return this.value }
}

class TestSlots extends Service {
  constructor(ctx: Context, readonly core: slots.SlotCore) { super(ctx, 'slots') }
  register(options: unknown, component: unknown) { return this.ctx.effect(() => this.core.register(options as never, component as never)) }
  inject(_key: string, install: () => () => void) { return this.ctx.effect(install) }
  subscribe(key: string, listener: () => void) { return this.core.subscribe(key, listener) }
  entries(key: string) { return this.core.entries(key) }
  entriesOfSlot(key: string) { return this.core.entriesOfSlot(key) }
}

function fixture(tracked = false, workspace = true) {
  const ctx = new Context()
  const core = new slots.SlotCore()
  let navigation = new AbortController(), navigations = 0
  const panelInfo = stores.createSnapshotStore({ activePanelId: null as string | null })
  const layout = {
    toggleSidebar() {}, panelInfo,
    selectPanel(id: string | null) { navigation.abort(); if (panelInfo.getSnapshot().activePanelId !== id) panelInfo.set({ activePanelId: id }) },
    beginNavigation() { navigations++; navigation.abort(); navigation = new AbortController(); return navigation.signal },
  }
  const navigate = () => { layout.beginNavigation(); layout.selectPanel(null) }
  const native = tracked ? new TrackedNativeWorkspace(ctx, navigate) : new NativeWorkspace(navigate)
  const removeRoot = core.register({ name: 'root', children: {
    sidebar: { kind: 'single', scope: 'root' }, 'shell.leading': { kind: 'single', scope: 'root' },
    'settings.section': { kind: 'list', scope: 'root' },
  } }, (() => null) as never)
  new TestSlots(ctx, core)
  if (!tracked && workspace) ctx.provide('uiWorkspace', native as unknown as UiWorkspace)
  ctx.provide('layout', layout as never)
  ctx.provide('uiSession', { adapter: { current: ownedStores.createSnapshotStore<{ key: string | undefined }>({ key: 'native-blank' }) } } as never)
  const dictionaries = new Map<string, { en: Record<string, string> }>()
  ctx.provide('locale', {
    register(name: string, messages: { en: Record<string, string> }) { dictionaries.set(name, messages); return () => { dictionaries.delete(name) } },
    bind(name: string) { return (key: string) => dictionaries.get(name)!.en[key]! },
    subscribe: () => () => {},
  } as never)
  ctx.provide('shortcuts', { catalog: stores.createSnapshotStore([]) } as never)
  ctx.provide('configForms', {
    get: () => stores.createSnapshotStore({ value: undefined }),
    developerTools: { enabled: stores.createSnapshotStore(false) },
  } as never)
  return {
    ctx, core, native, layout, dictionaries,
    get navigations() { return navigations },
    async dispose() { await ctx.fiber.dispose(); removeRoot() },
    face(key: 'sidebar' | 'shell.leading') { return core.entries(key)[0].inject!() as SidebarRootInjected },
  }
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve))

function remoteHandle() {
  const state = stores.createSnapshotStore<{ id: string } | undefined>(undefined)
  let closed = 0
  return {
    ...state,
    hasNavigationIntent: () => state.getSnapshot() !== undefined,
    get closed() { return closed },
    close() { closed++; state.set(undefined) },
    newSession() {}, open() {}, pick() {},
  }
}

function loadRoot(overrides: Record<string, unknown> = {}, globals: Record<string, unknown> = {}) {
  const compiled = transformSync(readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8'), {
    loader: 'tsx', jsx: 'automatic', format: 'cjs', target: 'es2022',
  }).code
  const root = { exports: {} as typeof import('../src/client/index.js') }
  const imports: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, './snapshot-store.js': ownedStores,
    './ui/index.js': { ownedModalClose() {} },
    './rpc.js': { mountRpc: async () => {}, createApi: () => ({}) },
    './Panel.js': { Panel: () => React.createElement('p', null, 'Ready connections') }, './messages.js': connectionMessages,
    './workspaces.js': { installWorkspaces: () => remoteHandle() },
    './embedded.js': { applyEmbedded() {} }, './native-shell-routing.js': routing,
    './host-settings.js': { installHostSettings: () => remoteHandle() },
    './native-shortcuts.js': { installNativeShortcuts(_ctx: unknown, _resolve: unknown, onReady: (ready: boolean) => void) { onReady(true) } },
    './workspace-shortcuts.js': { remoteSettingsCommand() {} },
    './native-settings.js': { settingsShell },
    ...overrides,
  }
  runInNewContext(compiled, { module: root, exports: root.exports, setTimeout, clearTimeout, ...globals, require(id: string) {
    assert.ok(id in imports, `unexpected root dependency ${id}: native sidebar factories must never be imported`)
    return imports[id]
  } })
  return root.exports
}

function provideData(f: ReturnType<typeof fixture>) {
  f.ctx.provide('theme', {} as never)
  f.ctx.provide('remote', {} as never)
  f.ctx.provide('remote.connections' as never, {} as never)
}

function settingsMarkup(f: ReturnType<typeof fixture>) {
  const section = f.core.entries('settings.section').find(entry => entry.options.id === 'connections')!
  assert.ok(section, 'Connections diagnostics remain reachable from native Settings')
  return renderToStaticMarkup(React.createElement(section.component as React.ComponentType))
}

test('the bundle patch neither disables nor redeploys the native sidebar', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(patch, /ui-sidebar|disabled:/)
  assert.match(patch, /id: connections/)
  assert.doesNotMatch(readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8'), /installNativeSidebar|mountSettingsIcon/)
})

test('an independently deployed native shell survives entry and whole-bundle disable', async () => {
  const f = fixture()
  try {
    await f.ctx.plugin(nativeSidebar)
    const sidebar = f.core.entries('sidebar')[0], leading = f.core.entries('shell.leading')[0]
    const owner = f.ctx.plugin(loadRoot())
    f.ctx.provide('theme', {} as never)
    await owner; await settled()
    assert.equal(f.core.entries('sidebar')[0], sidebar)
    assert.equal(f.core.entries('shell.leading')[0], leading)
    assert.ok(sidebar.children!['sidebar.panellist.actions'])
    for (const name of Object.keys(sidebar.children!)) assert.equal(f.core.declarationEpoch(name), 1)
    f.face('sidebar').startSession()
    await owner.dispose()
    assert.equal(f.core.entries('sidebar')[0], sidebar, 'entry disable must not tear down native navigation')
    assert.equal(f.core.entries('shell.leading')[0], leading)
    f.face('shell.leading').startSession()
    assert.deepEqual(f.native.calls, [['start', undefined], ['start', undefined]])
    assert.equal(f.core.entries('settings.section').length, 0)
    assert.equal(f.dictionaries.has('sidebar'), true, 'native shell resources belong to its independent deployment')
  } finally { await f.dispose() }
})

test('native panel menu contributions and pin state stay owned by the independent sidebar', async () => {
  const f = fixture()
  try {
    await f.ctx.plugin(nativeSidebar)
    const owner = f.ctx.plugin(loadRoot())
    f.ctx.provide('theme', {} as never)
    await owner; await settled()
    const face = f.face('sidebar'), menu = () => null
    const remove = f.core.register({ name: 'sidebar.panellist.actions', id: 'third-party' }, menu)
    assert.equal(face.hooks.entryActions.getSnapshot(), true)
    assert.equal(f.core.entries('sidebar.panellist.actions')[0].component, menu)
    face.setPinned('custom-panel', false)
    assert.deepEqual([...face.hooks.entryPins.getSnapshot()], ['custom-panel'])
    face.setPinned('plugins', false)
    assert.deepEqual([...face.hooks.entryPins.getSnapshot()], ['custom-panel'])
    await owner.dispose()
    assert.equal(face.hooks.entryActions.getSnapshot(), true)
    remove()
    assert.equal(face.hooks.entryActions.getSnapshot(), false)
  } finally { await f.dispose() }
})

test('Connections preserves native private receivers, symbols, writes and Cordis tracker rather than installing a facade', async () => {
  for (const tracked of [false, true]) {
    const f = fixture(tracked), symbol = Symbol('extension-state')
    const prototype = tracked ? TrackedNativeWorkspace.prototype : NativeWorkspace.prototype
    const start = Object.getOwnPropertyDescriptor(prototype, 'startSession')!
    try {
      Reflect.set(f.native, symbol, 'initial')
      await f.ctx.plugin(nativeSidebar)
      provideData(f)
      const owner = f.ctx.plugin(loadRoot())
      await owner; await settled(); await settled()
      await f.ctx.inject(['uiWorkspace'], ctx => {
        const scoped = ctx.uiWorkspace as unknown as TrackedNativeWorkspace
        scoped.openSession('chat')
        assert.equal(scoped.marker, 'native-receiver')
        assert.equal(scoped.futureMethod(), 'native-receiver')
        assert.equal(Reflect.get(scoped, symbol), 'initial')
        assert.equal(Reflect.set(scoped, symbol, 'updated'), true)
        assert.equal(Reflect.set(scoped, 'extensionState', 42), true)
        assert.ok(symbol in scoped)
        assert.ok(Reflect.ownKeys(scoped).includes(symbol))
        assert.equal(Reflect.get(scoped, Symbol.for('cordis.tracker')) !== undefined, tracked, 'the original tracker contract is unchanged')
      })
      assert.equal(Reflect.get(f.native, symbol), 'updated')
      assert.equal(Reflect.get(f.native, 'extensionState'), 42)
      assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'startSession'), start)
      assert.equal(Object.hasOwn(f.native, 'startSession'), false)
      f.face('sidebar').startSession('native-project' as Parameters<UiWorkspace['startSession']>[0])
      assert.deepEqual(f.native.calls, [['open', 'native-receiver', 'chat'], ['start', 'native-project']])
    } finally { await f.dispose() }
  }
})

test('native shell discovery and shadowing change readiness without owning any shell entry', async () => {
  const f = fixture(), readiness: boolean[] = []
  const stop = routing.observeNativeSidebar(f.ctx, ready => readiness.push(ready))
  try {
    assert.deepEqual(readiness, [false])
    const native = f.ctx.plugin(nativeSidebar)
    await native; await settled()
    const sidebar = f.core.entries('sidebar')[0]
    assert.deepEqual(readiness, [false, true])
    const remove = f.core.register({ name: 'sidebar', priority: -1 }, (() => null) as never)
    await settled()
    assert.equal(readiness.at(-1), false)
    assert.ok(f.core.entries('sidebar').includes(sidebar), 'shadowing does not remove the native deployment')
    remove(); await settled()
    assert.equal(readiness.at(-1), true)
    await native.dispose(); await settled()
    assert.equal(readiness.at(-1), false)
    stop()
    assert.deepEqual(readiness, [false, true, false, true, false])
  } finally { stop(); await f.dispose() }
})

test('RPC and client-factory failures preserve native navigation plus reachable Settings diagnostics', async () => {
  for (const factoryFailure of [false, true]) {
    const f = fixture()
    let installed = false
    try {
      await f.ctx.plugin(nativeSidebar)
      const sidebar = f.core.entries('sidebar')[0]
      provideData(f)
      const owner = f.ctx.plugin(loadRoot({
        './rpc.js': { mountRpc: async () => { if (!factoryFailure) throw new Error('Fixture unavailable RPC') }, createApi: () => ({}) },
        './workspaces.js': { installWorkspaces() { installed = true; throw new Error('Fixture failed client factory') } },
      }))
      await owner; await settled(); await settled(); await settled()
      assert.equal(installed, factoryFailure)
      assert.equal(f.core.entries('sidebar')[0], sidebar)
      f.face('sidebar').startSession()
      assert.deepEqual(f.native.calls, [['start', undefined]])
      assert.match(settingsMarkup(f), /role="alert"/)
      assert.ok(settingsMarkup(f).includes(connectionMessages.en.serviceUnavailable))
      assert.doesNotMatch(settingsMarkup(f), /Fixture/)
      await owner.dispose()
      assert.equal(f.core.entries('sidebar')[0], sidebar)
    } finally { await f.dispose() }
  }
})

test('missing remote service reaches its deadline and recovers without redeploying native navigation', async () => {
  const f = fixture()
  let now = 0, timerId = 0
  const timers = new Map<number, { at: number; callback(): void }>()
  const advance = (ms: number) => {
    now += ms
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback() }
  }
  try {
    await f.ctx.plugin(nativeSidebar)
    f.ctx.provide('theme', {} as never)
    const root = loadRoot({}, {
      setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id },
      clearTimeout(id: number) { timers.delete(id) },
    })
    const owner = f.ctx.plugin(root)
    await owner; await settled()
    assert.match(settingsMarkup(f), /role="status"/)
    advance(9_999)
    assert.match(settingsMarkup(f), /role="status"/)
    advance(1)
    assert.match(settingsMarkup(f), /role="alert"/)
    f.ctx.provide('remote', {} as never)
    await settled(); await settled()
    assert.match(settingsMarkup(f), /role="alert"/, 'a late namespace cannot reset the expired deadline')
    f.ctx.provide('remote.connections' as never, {} as never)
    await settled(); await settled()
    assert.ok(settingsMarkup(f).includes('Ready connections'))
    await owner.dispose()
    assert.equal(timers.size, 0)
    assert.equal(f.core.entries('sidebar').length, 1)
  } finally { await f.dispose() }
})

test('canRoute requires native discovery and shortcut readiness, and only readiness loss closes views', async () => {
  const f = fixture(false, false), workspace = remoteHandle(), settings = remoteHandle()
  let ready!: (ready: boolean) => void
  let workspaceAllowed!: () => boolean, settingsAllowed!: () => boolean
  provideData(f)
  const owner = f.ctx.plugin(loadRoot({
    './workspaces.js': { installWorkspaces(_ctx: unknown, _api: unknown, _t: unknown, canRoute: () => boolean) { workspaceAllowed = canRoute; return workspace } },
    './host-settings.js': { installHostSettings(_ctx: unknown, _api: unknown, canRoute: () => boolean) { settingsAllowed = canRoute; return settings } },
    './native-shortcuts.js': { installNativeShortcuts(_ctx: unknown, _resolve: unknown, onReady: typeof ready) { ready = onReady; ready(false) } },
  }))
  try {
    await owner; await settled(); await settled()
    assert.equal(f.core.entries('sidebar').length, 0, 'Connections must not install a native sidebar to satisfy its gate')
    assert.equal(workspaceAllowed(), false)
    assert.equal(settingsAllowed(), false)
    ready(false)
    ready(true)
    assert.equal(workspaceAllowed(), false)
    assert.equal(workspace.closed, 0, 'initial dependency discovery is not explicit local navigation')
    f.ctx.provide('uiWorkspace', f.native as unknown as UiWorkspace)
    const native = f.ctx.plugin(nativeSidebar)
    await native; await settled(); await settled()
    const sidebar = f.core.entries('sidebar')[0]
    assert.equal(workspaceAllowed(), true)
    assert.equal(settingsAllowed(), true)
    assert.equal(workspace.closed, 0)
    ready(false)
    assert.equal(workspace.closed, 1)
    assert.equal(settings.closed, 1)
    assert.equal(workspaceAllowed(), false)
    assert.equal(f.core.entries('sidebar')[0], sidebar)
    ready(false)
    assert.equal(workspace.closed, 1)
    ready(true)
    assert.equal(workspaceAllowed(), true)
    await owner.dispose()
    const closed = [workspace.closed, settings.closed]
    ready(false)
    assert.deepEqual([workspace.closed, settings.closed], closed)
    assert.equal(f.core.entries('sidebar')[0], sidebar)
  } finally { await f.dispose() }
})

test('native brand and leading New Session stay local and synchronously close both remote views even for blank reuse', async () => {
  const f = fixture(), workspace = remoteHandle(), settings = remoteHandle()
  try {
    await f.ctx.plugin(nativeSidebar)
    provideData(f)
    const owner = f.ctx.plugin(loadRoot({
      './workspaces.js': { installWorkspaces: () => workspace },
      './host-settings.js': { installHostSettings: () => settings },
    }))
    await owner; await settled(); await settled()
    for (const key of ['sidebar', 'shell.leading'] as const) {
      workspace.set({ id: 'remote-workspace' })
      const guardNavigations = f.navigations
      settings.set({ id: 'remote-settings' })
      assert.equal(f.navigations, guardNavigations, 'opening Settings must not invalidate the independent workspace view')
      assert.ok(workspace.getSnapshot())
      settings.set(undefined)
      assert.ok(workspace.getSnapshot(), 'closing Settings alone leaves the workspace intact')
      settings.set({ id: 'remote-settings' })
      f.face(key).startSession()
      assert.equal(workspace.getSnapshot(), undefined)
      assert.equal(settings.getSnapshot(), undefined)
      assert.deepEqual(f.native.calls.at(-1), ['start', undefined], 'native creation is not rerouted to the selected remote host')
    }
    settings.set({ id: 'remote-settings-only' })
    const unchangedPanel = f.layout.panelInfo.getSnapshot()
    f.layout.selectPanel(null)
    assert.equal(f.layout.panelInfo.getSnapshot(), unchangedPanel, 'native openSession may commit without publishing a new panel snapshot')
    assert.equal(settings.getSnapshot(), undefined, 'committing local navigation also closes an independent Settings-only view')
    workspace.set({ id: 'remote-workspace' })
    await owner.dispose()
    const closed = workspace.closed
    f.native.startSession()
    assert.equal(workspace.closed, closed, 'disposing Connections also removes its navigation listener')
    assert.equal(f.core.entries('sidebar').length, 1)
  } finally { await f.dispose() }
})

test('the native close command honors a foreground owned layer before remote Settings routing', async () => {
  const f = fixture(), settings = remoteHandle()
  let resolve!: import('../src/client/native-shortcuts.js').NativeCommandResolver
  let foreground = true, ownCloses = 0, settingsResolutions = 0
  try {
    await f.ctx.plugin(nativeSidebar)
    provideData(f)
    const owner = f.ctx.plugin(loadRoot({
      './host-settings.js': { installHostSettings: () => settings },
      './ui/index.js': { ownedModalClose: () => foreground ? () => { if (foreground) { foreground = false; ownCloses++ } } : undefined },
      './native-shortcuts.js': { installNativeShortcuts(_ctx: unknown, callback: typeof resolve, ready: (value: boolean) => void) { resolve = callback; ready(true) } },
      './workspace-shortcuts.js': { remoteSettingsCommand(_command: unknown, _context: unknown, close: () => void) {
        settingsResolutions++; return { status: 'handled', run: close }
      } },
    }, { document: {} }))
    await owner; await settled(); await settled()
    settings.set({ id: 'remote-settings' })
    const command = { id: 'page.close' } as import('@deepseek-ai/dsh-client-shortcuts/client').ShortcutCommand
    const context = { region: 'page', modal: 'settings', target: null } as const
    const first = resolve(command, context)
    assert.equal(first?.status, 'handled')
    assert.equal(settingsResolutions, 0)
    if (first?.status === 'handled') first.run()
    assert.equal(ownCloses, 1)
    assert.ok(settings.getSnapshot(), 'closing the owned layer cannot dismiss its background Settings view')
    const next = resolve(command, context)
    assert.equal(next?.status, 'handled')
    if (next?.status === 'handled') next.run()
    assert.equal(settings.getSnapshot(), undefined)
    if (first?.status === 'handled') first.run()
    assert.equal(ownCloses, 1, 'a captured close action is a checked capability, not a global close-latest command')
  } finally { await f.dispose() }
})

test('navigation transactions nest and rearm the native guard even after a synchronous panel failure', async () => {
  const f = fixture(), remote = remoteHandle(), transaction = routing.createNavigationTransaction()
  const stop = routing.watchNativeNavigation(f.layout, {
    getSnapshot: remote.hasNavigationIntent, subscribe: remote.subscribe, close: remote.close,
  }, transaction)
  try {
    assert.equal(f.navigations, 0)
    remote.set({ id: 'remote' })
    const before = f.navigations
    assert.throws(() => transaction.run(() => {
      f.layout.beginNavigation()
      transaction.run(() => f.layout.selectPanel('connections.workspace'))
      remote.set({ id: 'same-remote' })
      assert.equal(f.navigations, before + 1, 'nested transactions and source notifications do not prematurely rearm')
      assert.equal(remote.closed, 0)
      throw new Error('Fixture failed internal panel transition')
    }), /Fixture failed/)
    assert.equal(transaction.getSnapshot(), false)
    assert.equal(f.navigations, before + 2, 'the outer finally rearms once without waiting for another source notification')
    f.layout.selectPanel(null)
    assert.equal(remote.getSnapshot(), undefined)
    assert.equal(remote.closed, 1)
  } finally { stop(); await f.dispose() }
})

test('the root passes one internal panel transaction to its workspace installer and native guard', async () => {
  const f = fixture(), workspace = remoteHandle(), settings = remoteHandle()
  let navigatePanel!: (action: () => void) => void
  try {
    await f.ctx.plugin(nativeSidebar)
    provideData(f)
    const owner = f.ctx.plugin(loadRoot({
      './workspaces.js': { installWorkspaces(_ctx: unknown, _api: unknown, _t: unknown, _canRoute: unknown, _commands: unknown, internal: typeof navigatePanel) {
        navigatePanel = internal; return workspace
      } },
      './host-settings.js': { installHostSettings: () => settings },
    }))
    await owner; await settled(); await settled()
    assert.equal(typeof navigatePanel, 'function')
    settings.set({ id: 'remote-settings' })
    workspace.set({ id: 'remote-workspace' })
    navigatePanel(() => { f.layout.beginNavigation(); f.layout.selectPanel('connections.workspace') })
    assert.ok(workspace.getSnapshot())
    assert.ok(settings.getSnapshot())
    f.face('sidebar').startSession()
    assert.equal(workspace.getSnapshot(), undefined)
    assert.equal(settings.getSnapshot(), undefined)
    assert.deepEqual(f.native.calls, [['start', undefined]])
  } finally { await f.dispose() }
})

test('the root guards pending workspace intent even when its view snapshot is still absent', async () => {
  const f = fixture(), workspace = remoteHandle(), settings = remoteHandle()
  try {
    await f.ctx.plugin(nativeSidebar)
    provideData(f)
    const owner = f.ctx.plugin(loadRoot({
      './workspaces.js': { installWorkspaces: () => ({ ...workspace, getSnapshot: () => undefined }) },
      './host-settings.js': { installHostSettings: () => settings },
    }))
    await owner; await settled(); await settled()
    workspace.set({ id: 'pending-restore-only' })
    f.face('shell.leading').startSession()
    assert.equal(workspace.hasNavigationIntent(), false)
    assert.equal(workspace.closed, 1)
    assert.deepEqual(f.native.calls, [['start', undefined]])
  } finally { await f.dispose() }
})
