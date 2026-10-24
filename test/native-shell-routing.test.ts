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
  constructor(ctx: Context, readonly core: slots.SlotCore) { super(ctx, 'slots') }
  register(options: unknown, component: unknown) {
    return this.ctx.effect(() => this.core.register(options as never, component as never))
  }
  inject(_key: string, install: () => () => void) { return this.ctx.effect(install) }
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
  } }, (() => null) as never)
  new TestSlots(ctx, core)
  if (!tracked) ctx.provide('uiWorkspace', native as unknown as UiWorkspace)
  ctx.provide('layout', { toggleSidebar() {}, selectPanel() {} } as never)
  const dictionaries = new Set<string>()
  ctx.provide('locale', { register(name: string) { dictionaries.add(name); return () => { dictionaries.delete(name) } }, subscribe: () => () => {} } as never)
  ctx.provide('shortcuts', { catalog: stores.createSnapshotStore([]) } as never)
  return {
    ctx, core, native, dictionaries,
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
    assert.equal(Object.keys(children).length, 7)
    for (const name of Object.keys(children)) assert.equal(routed.core.declarationEpoch(name), 1)
    assert.equal(routed.dictionaries.has('sidebar'), true)
  } finally { await routed.dispose(); await baseline.dispose() }
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
    const scoped = installed.ctx.get('uiWorkspace') as unknown as TrackedNativeWorkspace
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
    const scoped = installed.ctx.get('uiWorkspace') as unknown as NativeWorkspace
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
    await installed.dispose()
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
    assert.throws(() => installNativeSidebar(f.ctx, { startSession() {} }), /separate ui-sidebar deployment/u)
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
