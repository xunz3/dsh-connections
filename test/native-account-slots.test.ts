import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as stores from '@deepseek-ai/dsh-client-store'
import { SlotCore, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import { installAccountLoginSlots } from '../src/client/settings-native/account-slots.js'
import { AccountLoginPresenter } from '../src/client/settings-native/account-login.js'
import { createLoginHost, type LoginAction } from '../src/client/login-host.js'
const require = createRequire(import.meta.url)
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
type Cleanup = () => void | Promise<unknown>
async function setup() {
  const core = new SlotCore(), nativeEffects: Cleanup[] = [], bridgeEffects: Cleanup[] = []
  let registrations = 0, finish!: () => void
  const ended = new Promise<void>(resolve => { finish = resolve })
  const removeRoot = core.register({ name: 'root', children: {
    'settings.launcher': { kind: 'single', scope: 'root' }, 'settings.models.sign-in': { kind: 'single', scope: 'root' },
    'settings.section': { kind: 'list', scope: 'root' },
  } } as never, (() => null) as never)
  const slots = (effects: Cleanup[]) => ({
    register(options: never, component: never) { registrations++; const off = core.register(options, component); effects.push(off); return off },
    inject(key: string, callback: () => Cleanup) {
      let live: Cleanup | undefined
      const sync = () => { if (core.specDynamic(key)) live ??= callback(); else { void live?.(); live = undefined } }
      const unsubscribe = core.subscribeDeclaration(key, sync); sync()
      const off = () => { unsubscribe(); void live?.(); live = undefined }
      effects.push(off); return off
    },
    entries: core.entries.bind(core), entriesOfSlot: core.entriesOfSlot.bind(core), subscribe: core.subscribe.bind(core),
  })
  const account = { status: 'signed-out', attempt: null, links: { usageUrl: 'https://platform.example.test/usage', topUpUrl: 'https://platform.example.test/topup' } }
  const remote = { $on: () => () => {}, $stream: () => ({ async *[Symbol.asyncIterator]() { yield { value: account, accept() {} }; await ended }, dispose: async () => finish() }),
    account: { async startSignIn() { return { ok: true, value: { ...account, attempt: { id: 'real-public-attempt', phase: 'waiting-browser', authorizeUrl: 'https://login.example.test/from-native-face' } } } },
      async cancelSignIn() { return { ok: true } } }, session: { async initializeDefaultModel() { return { ok: true } } } }
  const shared = { remote, theme: { getTheme: () => ({ active: { colorScheme: 'dark' } }), subscribe: () => () => {} },
    locale: { register: () => () => {}, bind: () => (key: string) => key, getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} }, configForms: {} }
  const nativeContext = { ...shared, slots: slots(nativeEffects), effect(callback: () => Cleanup) { const off = callback(); if (off) nativeEffects.push(off); return off } }
  const modules: Record<string, unknown> = { react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDom,
    '@deepseek-ai/dsh-client-store': stores, '@deepseek-ai/dsh-client-ui-primitives': {} }
  let native!: { apply(ctx: unknown): void }
  runInNewContext(readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-settings-account/client'), 'utf8'), {
    console, structuredClone, URL, AbortController, setTimeout, clearTimeout,
    window: { location: { origin: 'http://127.0.0.1:1' }, open() { assert.fail('native popup capability must not run through delegation') },
      __ModuleLoader__: { load(entry: { factory(require: (id: string) => unknown): typeof native }) { native = entry.factory(id => { assert.ok(id in modules, id); return modules[id] }) } } },
  })
  native.apply(nativeContext); await tick()
  const bridgeContext = { ...shared, slots: slots(bridgeEffects), inject(_names: string[], callback: (ctx: unknown) => void) { callback(this) },
    effect(callback: () => Cleanup) { const off = callback(); if (off) bridgeEffects.push(off); return off } } as unknown as Context
  const actions: LoginAction[] = [], host = createLoginHost(async action => { actions.push(action) }, assert.fail)
  return { core, host, actions, bridgeContext, get registrations() { return registrations },
    async disposeBridge() { for (const off of bridgeEffects.splice(0).reverse()) await off() },
    async dispose() { for (const off of bridgeEffects.splice(0).reverse()) await off(); for (const off of nativeEffects.splice(0).reverse()) await off(); host.dispose(); removeRoot() } }
}

test('actual published Account inject face delegates through stable SlotCore seats to the browser bridge', async () => {
  const f = await setup(), windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'http://127.0.0.1:1' } } })
  try {
    const original = f.core.entries('settings.launcher')[0]
    const operations = original.inject!() as Record<string, unknown>
    const originalModels = f.core.entries('settings.models.sign-in')[0]
    assert.ok(operations.hooks && operations.start && operations.cancel && operations.signOut)
    installAccountLoginSlots(f.bridgeContext, f.host, '0.2.1-rc.5')
    await tick(); const count = f.registrations
    for (let index = 0; index < 4; index++) await tick()
    assert.equal(f.registrations, count, 'self-shadow registration must reach idle rather than flap')
    assert.equal(f.core.entries('settings.launcher').length, 2)
    const winner = f.core.entriesOfSlot('settings.launcher')[0]
    const injected = winner.inject!() as unknown as { start(): Promise<void>; hooks: { account: unknown }; signOut: unknown; loginPresenter: AccountLoginPresenter; showLogin(visible: boolean): void }
    assert.equal(injected.hooks.account, (operations.hooks as { account: unknown }).account, 'the native account stream is not replaced')
    assert.equal(injected.signOut, operations.signOut, 'native business operations remain exact references')
    injected.showLogin(true); assert.equal(injected.loginPresenter.state.getSnapshot().open, true)
    await injected.start(); await tick()
    assert.deepEqual(f.actions, [{ kind: 'openLogin', url: 'https://login.example.test/from-native-face?theme=dark' }])
    await injected.loginPresenter.copy()
    assert.deepEqual(f.actions[1], { kind: 'copyLogin', url: 'https://login.example.test/from-native-face?theme=dark' })
    const modelFace = f.core.entriesOfSlot('settings.models.sign-in')[0].inject!() as unknown as { loginPresenter: AccountLoginPresenter; hooks: { account: unknown } }
    assert.equal(modelFace.loginPresenter, injected.loginPresenter, 'two sign-in seats share one attempt presenter')
    assert.equal(modelFace.hooks.account, injected.hooks.account)
    await f.disposeBridge()
    assert.equal(f.core.entriesOfSlot('settings.launcher')[0], original)
    assert.equal(f.core.entriesOfSlot('settings.models.sign-in')[0], originalModels)
    assert.equal(f.core.isLive(original), true)
  } finally { if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor); else Reflect.deleteProperty(globalThis, 'window'); await f.dispose() }
})

test('native Account delegation leaves an existing foreign shadow untouched', async () => {
  const f = await setup()
  const remove = f.core.register({ name: 'settings.launcher', id: 'foreign', priority: -1 } as never, (() => null) as never)
  try {
    const foreign = f.core.entriesOfSlot('settings.launcher')[0] as StoredEntry
    installAccountLoginSlots(f.bridgeContext, f.host, '0.2.1-rc.5'); await tick()
    assert.equal(f.core.entriesOfSlot('settings.launcher')[0], foreign)
    await f.disposeBridge(); assert.equal(f.core.isLive(foreign), true)
  } finally { remove(); await f.dispose() }
})
