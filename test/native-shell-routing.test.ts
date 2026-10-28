import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { Context, Service } from '@deepseek-ai/cordis'
import * as stores from '@deepseek-ai/dsh-client-store'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import * as connectionMessages from '../src/client/messages.js'
import { transformSync } from 'esbuild'
import type { SidebarRootInjected } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'

// The installed native client is a ModuleLoader factory, not a Node ESM module.
// Run its actual apply/registration code; only unrendered visual primitives are stubbed.
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
const compiled = transformSync(readFileSync(new URL('../src/client/native-shell-routing.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
const module = { exports: {} as typeof import('../src/client/native-shell-routing.js') }
runInNewContext(compiled, { module, exports: module.exports, require(id: string) {
  assert.equal(id, '@deepseek-ai/dsh-client-ui-sidebar/client')
  return nativeSidebar
} })
const { installNativeSidebar } = module.exports

class NativeWorkspace {
  #value = 'native-receiver'
  calls: unknown[][] = []
  startSession(...args: unknown[]) { this.calls.push(['start', ...args]) }
  openSession(...args: unknown[]) { this.calls.push(['open', this.#value, ...args]) }
  get marker() { return this.#value }
  futureMethod() { return this.#value }
}

/** Native UiWorkspaceService is a Cordis Service, whose tracker changes ctx.get wrapping. */
class TrackedNativeWorkspace extends Service {
  private value = 'native-receiver'
  calls: unknown[][] = []
  constructor(ctx: Context) { super(ctx, 'uiWorkspace') }
  startSession(...args: unknown[]) { this.calls.push(['start', ...args]) }
  openSession(...args: unknown[]) { this.calls.push(['open', this.value, ...args]) }
  get marker() { return this.value }
  futureMethod() { return this.value }
}

class TestSlots extends Service {
  failSidebar = false
  deferSidebar = false
  private readonly pendingSidebar = new Set<() => void>()
  constructor(ctx: Context, readonly core: slots.SlotCore) { super(ctx, 'slots') }
  register(options: unknown, component: unknown) {
    if (this.failSidebar && (options as { name?: string }).name === 'sidebar') throw new Error('Fixture native sidebar installation failed')
    return this.ctx.effect(() => this.core.register(options as never, component as never))
  }
  inject(key: string, install: () => () => void) {
    if (key !== 'sidebar' || !this.deferSidebar) return this.ctx.effect(install)
    return this.ctx.effect(() => {
      let dispose: (() => void) | undefined
      const register = () => { this.pendingSidebar.delete(register); dispose = install() }
      this.pendingSidebar.add(register)
      return () => { this.pendingSidebar.delete(register); dispose?.() }
    })
  }
  registerPendingSidebar() { for (const register of this.pendingSidebar) register() }
  subscribe(key: string, listener: () => void) { return this.core.subscribe(key, listener) }
  entries(key: string) { return this.core.entries(key) }
  entriesOfSlot(key: string) { return this.core.entriesOfSlot(key) }
}

function fixture(tracked = false) {
  const ctx = new Context()
  const core = new slots.SlotCore()
  const native = tracked ? new TrackedNativeWorkspace(ctx) : new NativeWorkspace()
  const removeRoot = core.register({ name: 'root', children: {
    sidebar: { kind: 'single', scope: 'root' }, 'shell.leading': { kind: 'single', scope: 'root' },
    'settings.section': { kind: 'list', scope: 'root' },
  } }, (() => null) as never)
  const slotService = new TestSlots(ctx, core)
  if (!tracked) ctx.provide('uiWorkspace', native as unknown as UiWorkspace)
  ctx.provide('layout', { toggleSidebar() {}, selectPanel() {} } as never)
  const dictionaries = new Map<string, { en: Record<string, string> }>()
  ctx.provide('locale', {
    register(name: string, messages: { en: Record<string, string> }) { dictionaries.set(name, messages); return () => { dictionaries.delete(name) } },
    bind(name: string) { return (key: string) => dictionaries.get(name)!.en[key]! },
    subscribe: () => () => {},
  } as never)
  ctx.provide('shortcuts', { catalog: stores.createSnapshotStore([]) } as never)
  return {
    ctx, core, native, dictionaries, slotService,
    async dispose() { await ctx.fiber.dispose(); removeRoot() },
    face(key: 'sidebar' | 'shell.leading') { return core.entries(key)[0].inject!() as SidebarRootInjected },
  }
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve))

test('native sidebar and leading controls are reused with their original child registrations', async () => {
  const baseline = fixture(), routed = fixture()
  try {
    await baseline.ctx.plugin(nativeSidebar)
    const installed = installNativeSidebar(routed.ctx, { startSession() {} })
    await installed; await settled()
    for (const key of ['sidebar', 'shell.leading']) {
      assert.equal(routed.core.entries(key).length, 1)
      const actual = routed.core.entries(key)[0], original = baseline.core.entries(key)[0]
      assert.equal(actual.component, original.component)
      assert.equal(actual.locale, original.locale)
      assert.deepEqual(actual.children, original.children)
    }
    const children = routed.core.entries('sidebar')[0].children!
    assert.ok(children['sidebar.panellist.actions'], 'rc.3 native panel menu must remain available')
    for (const name of Object.keys(children)) assert.equal(routed.core.declarationEpoch(name), 1)
    assert.equal(routed.dictionaries.has('sidebar'), true)
  } finally { await routed.dispose(); await baseline.dispose() }
})

test('rc.3 panel menu contributions and pin state remain owned by the native sidebar', async () => {
  const f = fixture()
  try {
    await installNativeSidebar(f.ctx, { startSession() {} }); await settled()
    const face = f.face('sidebar')
    assert.equal(face.hooks.entryActions.getSnapshot(), false)
    const menu = () => null
    const remove = f.core.register({ name: 'sidebar.panellist.actions', id: 'third-party' }, menu)
    assert.equal(face.hooks.entryActions.getSnapshot(), true)
    assert.equal(f.core.entries('sidebar.panellist.actions')[0].component, menu)
    face.setPinned('custom-panel', false)
    assert.deepEqual([...face.hooks.entryPins.getSnapshot()], ['custom-panel'])
    face.setPinned('plugins', false)
    assert.deepEqual([...face.hooks.entryPins.getSnapshot()], ['custom-panel'], 'native plugin-manager entry stays pinned')
    face.setPinned('custom-panel', true)
    assert.equal(face.hooks.entryPins.getSnapshot().length, 0)
    remove()
    assert.equal(face.hooks.entryActions.getSnapshot(), false)
  } finally { await f.dispose() }
})

test('all native New Session controls route explicitly while other scopes stay native', async () => {
  const f = fixture()
  const calls: unknown[][] = []
  let source = 'remote-a'
  try {
    const installed = installNativeSidebar(f.ctx, { startSession: (...args) => { calls.push([source, ...args]) } })
    await installed; await settled()
    const workspaceId = 'native-project' as Parameters<UiWorkspace['startSession']>[0]
    f.face('sidebar').startSession(workspaceId)
    source = 'local'
    f.face('shell.leading').startSession()
    source = 'remote-b'
    f.face('sidebar').startSession()
    assert.deepEqual(calls, [['remote-a', 'native-project'], ['local', undefined], ['remote-b', undefined]])
    assert.deepEqual(f.native.calls, [])
    await f.ctx.inject(['uiWorkspace'], ctx => { ctx.uiWorkspace.startSession(workspaceId) })
    assert.deepEqual(f.native.calls, [['start', 'native-project']], 'parent-scope consumers retain native startSession')
  } finally { await f.dispose() }
})

test('native factory callbacks route a Cordis Service without losing the facade to tracing', async () => {
  const f = fixture(true)
  const routed: unknown[][] = []
  try {
    const installed = installNativeSidebar(f.ctx, { startSession: (...args) => { routed.push(args) } })
    await installed; await settled()
    f.face('sidebar').startSession('remote-project' as Parameters<UiWorkspace['startSession']>[0])
    f.face('shell.leading').startSession()
    assert.deepEqual(routed, [['remote-project'], [undefined]])
    assert.deepEqual(f.native.calls, [], 'neither native button may silently invoke local session creation')
    const scoped = installed!.ctx.get('uiWorkspace') as unknown as TrackedNativeWorkspace
    scoped.openSession('local-chat')
    assert.equal(scoped.marker, 'native-receiver')
    assert.equal(scoped.futureMethod(), 'native-receiver')
    await f.ctx.inject(['uiWorkspace'], ctx => { ctx.uiWorkspace.startSession() })
    assert.deepEqual(f.native.calls, [['open', 'native-receiver', 'local-chat'], ['start']], 'the parent native service remains unchanged')
  } finally { await f.dispose() }
})

test('the complete isolated facade binds native methods and accessors to their original receiver', async () => {
  const f = fixture()
  try {
    const installed = installNativeSidebar(f.ctx, { startSession() {} })
    await installed; await settled()
    const scoped = installed!.ctx.get('uiWorkspace') as unknown as NativeWorkspace
    scoped.openSession('chat')
    assert.equal(scoped.marker, 'native-receiver')
    assert.equal(scoped.futureMethod(), 'native-receiver', 'unknown future methods are forwarded without interface copies')
    const detached = scoped.futureMethod
    assert.equal(detached(), 'native-receiver')
    assert.deepEqual(f.native.calls, [['open', 'native-receiver', 'chat']])
    assert.equal(f.ctx.get('uiWorkspace')?.startSession, f.native.startSession)
  } finally { await f.dispose() }
})

test('disposal removes only the isolated provider and native shell tree, then permits reinstall', async () => {
  const f = fixture()
  try {
    const installed = installNativeSidebar(f.ctx, { startSession() {} })
    await installed; await settled()
    const child = () => null
    f.core.register({ name: 'sidebar.workspaces' }, child)
    await installed!.dispose()
    assert.equal(f.core.entries('sidebar').length, 0)
    assert.equal(f.core.entries('shell.leading').length, 0)
    assert.equal(f.core.entries('sidebar.workspaces').length, 0)
    assert.equal(f.core.specDynamic('sidebar.workspaces'), undefined)
    assert.equal(f.core.specDynamic('sidebar')?.kind, 'single', 'the original layout still owns the parent declaration')
    assert.equal(f.ctx.get('uiWorkspace'), f.native)
    f.ctx.get('uiWorkspace')!.startSession()
    assert.deepEqual(f.native.calls, [['start']])
    assert.equal(f.dictionaries.size, 0)
    const next = installNativeSidebar(f.ctx, { startSession() {} })
    await next; await settled()
    assert.equal(f.core.entries('sidebar').length, 1)
  } finally { await f.dispose() }
})

test('an active independent native sidebar fails clearly before registering another tree', async () => {
  const f = fixture()
  try {
    await f.ctx.plugin(nativeSidebar)
    const original = f.core.entries('sidebar')[0]
    assert.equal(installNativeSidebar(f.ctx, { startSession() {} }), undefined)
    assert.equal(f.core.entries('sidebar')[0], original)
    assert.equal(f.core.entries('sidebar').length, 1)
    f.face('sidebar').startSession()
    assert.deepEqual(f.native.calls, [['start', undefined]])
  } finally { await f.dispose() }
})

test('unloading the consuming plugin disposes its child shell without affecting native navigation', async () => {
  const f = fixture()
  try {
    const owner = f.ctx.inject(['slots', 'uiWorkspace'], ctx => {
      installNativeSidebar(ctx, { startSession() {} })
    })
    await owner; await settled()
    assert.equal(f.core.entries('sidebar').length, 1)
    await owner.dispose()
    assert.equal(f.core.entries('sidebar').length, 0)
    assert.equal(f.core.entries('shell.leading').length, 0)
    assert.equal(f.ctx.get('uiWorkspace'), f.native)
    f.ctx.get('uiWorkspace')!.startSession()
    assert.deepEqual(f.native.calls, [['start']])
  } finally { await f.dispose() }
})

test('routing readiness follows successful native registration, ownership and disposal', async () => {
  const f = fixture()
  const readiness: boolean[] = []
  try {
    const installed = installNativeSidebar(f.ctx, { startSession() {}, onReady: ready => readiness.push(ready) })
    assert.deepEqual(readiness, [false], 'creating a Fiber is not readiness')
    await installed; await settled()
    assert.equal(readiness.at(-1), true)
    const removeConflict = f.core.register({ name: 'sidebar', priority: -1 }, (() => null) as never)
    await settled()
    assert.equal(readiness.at(-1), false)
    removeConflict()
    await settled()
    assert.equal(readiness.at(-1), true)
    await installed!.dispose()
    assert.equal(readiness.at(-1), false)
  } finally { await f.dispose() }
})

test('native apply failures never advertise routed navigation', async () => {
  const f = fixture()
  const readiness: boolean[] = []
  f.slotService.failSidebar = true
  try {
    const installed = installNativeSidebar(f.ctx, { startSession() {}, onReady: ready => readiness.push(ready) })
    await installed; await settled(); await settled()
    assert.deepEqual(readiness, [false])
    assert.equal(f.core.entries('sidebar').length, 0)
  } finally { await f.dispose() }
})

test('routing becomes ready when native sidebar slot registration is deferred', async () => {
  const f = fixture()
  const readiness: boolean[] = []
  f.slotService.deferSidebar = true
  try {
    const installed = installNativeSidebar(f.ctx, { startSession() {}, onReady: ready => readiness.push(ready) })
    await installed; await settled()
    assert.equal(f.core.entries('sidebar').length, 0)
    assert.equal(readiness.at(-1), false)
    f.slotService.registerPendingSidebar()
    await settled()
    assert.equal(f.core.entries('sidebar').length, 1)
    assert.equal(readiness.at(-1), true)
    const removeConflict = f.core.register({ name: 'sidebar', priority: -1 }, (() => null) as never)
    await settled()
    assert.equal(readiness.at(-1), false)
    removeConflict(); await settled()
    assert.equal(readiness.at(-1), true)
    await installed!.dispose()
    assert.equal(readiness.at(-1), false)
    assert.equal(f.core.entries('sidebar').length, 0)
  } finally { await f.dispose() }
})

test('root RPC setup failure preserves native navigation and a visible settings error', async () => {
  const f = fixture()
  let workspaceInstalled = false
  const compiled = transformSync(readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8'), {
    loader: 'tsx', jsx: 'automatic', format: 'cjs', target: 'es2022',
  }).code
  const root = { exports: {} as typeof import('../src/client/index.js') }
  const imports: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, '@deepseek-ai/dsh-client-store': stores,
    './rpc.js': { mountRpc: async () => { throw new Error('Fixture unavailable RPC') }, createApi: () => ({}) },
    './Panel.js': { Panel: () => null }, './messages.js': connectionMessages,
    './workspaces.js': { installWorkspaces() { workspaceInstalled = true; throw new Error('must not install after RPC failure') } },
    './embedded.js': { applyEmbedded() {} }, './native-shell-routing.js': module.exports, './host-settings.js': { installHostSettings() {} },
  }
  runInNewContext(compiled, { module: root, exports: root.exports, setTimeout, clearTimeout, require(id: string) {
    assert.ok(id in imports, `unexpected root dependency ${id}`)
    return imports[id]
  } })
  f.ctx.provide('remote', {} as never)
  f.ctx.provide('theme', {} as never)
  try {
    const owner = f.ctx.plugin(root.exports)
    await owner; await settled(); await settled(); await settled()
    assert.equal(workspaceInstalled, false)
    assert.equal(f.core.entries('sidebar').length, 1)
    assert.equal(f.core.entries('shell.leading').length, 1)
    f.face('sidebar').startSession()
    assert.deepEqual(f.native.calls, [['start', undefined]])
    const section = f.core.entries('settings.section').find(entry => entry.options.id === 'connections')
    assert.ok(section, 'the failure must remain reachable in native Settings')
    const html = renderToStaticMarkup(React.createElement(section.component as React.ComponentType))
    assert.match(html, /role="alert"/)
    assert.ok(html.includes(connectionMessages.en.serviceUnavailable))
    assert.ok(!html.includes('Fixture unavailable RPC'), 'raw transport details stay out of the UI')
    await owner.dispose()
    assert.equal(f.core.entries('sidebar').length, 0)
    assert.equal(f.core.entries('settings.section').length, 0)
  } finally { await f.dispose() }
})

test('missing remote service leaves Settings loading only until the deadline and recovers when it arrives', async () => {
  const f = fixture()
  let now = 0, timerId = 0
  const timers = new Map<number, { at: number; callback(): void }>()
  const advance = (ms: number) => {
    now += ms
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback() }
  }
  const compiled = transformSync(readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8'), {
    loader: 'tsx', jsx: 'automatic', format: 'cjs', target: 'es2022',
  }).code
  const root = { exports: {} as typeof import('../src/client/index.js') }
  const imports: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, '@deepseek-ai/dsh-client-store': stores,
    './rpc.js': { mountRpc: async () => {}, createApi: () => ({}) },
    './Panel.js': { Panel: () => React.createElement('p', null, 'Ready connections') }, './messages.js': connectionMessages,
    './workspaces.js': { installWorkspaces: () => ({ newSession() {}, open() {} }) },
    './embedded.js': { applyEmbedded() {} }, './native-shell-routing.js': module.exports, './host-settings.js': { installHostSettings() {} },
  }
  runInNewContext(compiled, {
    module: root, exports: root.exports,
    setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id },
    clearTimeout(id: number) { timers.delete(id) },
    require(id: string) { assert.ok(id in imports, `unexpected root dependency ${id}`); return imports[id] },
  })
  f.ctx.provide('theme', {} as never)
  try {
    const owner = f.ctx.plugin(root.exports)
    await owner; await settled()
    const section = f.core.entries('settings.section').find(entry => entry.options.id === 'connections')!
    const html = () => renderToStaticMarkup(React.createElement(section.component as React.ComponentType))
    assert.match(html(), /role="status"/)
    advance(9_999)
    assert.match(html(), /role="status"/)
    advance(1)
    assert.match(html(), /role="alert"/)
    assert.ok(html().includes(connectionMessages.en.serviceUnavailable))
    f.ctx.provide('remote', {} as never)
    await settled(); await settled()
    assert.match(html(), /role="alert"/, 'a late remote namespace must not reset an expired deadline while remote.connections is still missing')
    f.ctx.provide('remote.connections' as never, {} as never)
    await settled(); await settled()
    assert.ok(html().includes('Ready connections'))
    assert.equal(timers.size, 0)
    await owner.dispose()
    assert.equal(f.core.entries('settings.section').length, 0)
  } finally { await f.dispose() }
})
