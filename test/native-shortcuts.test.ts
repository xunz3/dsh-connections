import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import * as cordis from '@deepseek-ai/cordis'
import * as stores from '@deepseek-ai/dsh-client-store'
import { ShortcutPersistence } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { DesktopShortcutInput, ShortcutConfigSnapshot } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { ShortcutCommand } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { NativeCommandResolver } from '../src/client/native-shortcuts.js'
import { workspaceCommandResolver } from '../src/client/workspace-shortcuts.js'
import { transformSync } from 'esbuild'

const require = createRequire(import.meta.url)
const source = readFileSync(require.resolve('@deepseek-ai/dsh-client-shortcuts/client'), 'utf8')
const { assertNativeShortcutRegistry } = await import(new URL('../scripts/native-shortcuts.mjs', import.meta.url).href) as {
  assertNativeShortcutRegistry(source: string): void
}
const adapterCode = transformSync(readFileSync(new URL('../src/client/native-shortcuts.ts', import.meta.url), 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'es2022',
}).code
const settled = () => new Promise<void>(resolve => setImmediate(resolve))

// Model only the native preload boundary and focus facts. The published service,
// command registry and preference coordinator execute unchanged in these tests.
class InputTarget {
  readonly listeners = new Map<string, Set<unknown>>()
  addEventListener(type: string, listener: unknown) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener); this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: unknown) { this.listeners.get(type)?.delete(listener) }
  get listenerCount() { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0) }
}

class FocusTarget {
  isConnected = true
  dataset: Record<string, string> = {}
  constructor(readonly guestName?: string) {}
  matches(selector: string) { return selector === 'webview[data-sidebar-browser-frame]' && this.guestName !== undefined }
  closest() { return null }
  getAttribute(name: string) { return name === 'name' ? this.guestName : null }
}

function command(id: string, code: string, run: () => void, modals: string[] = []): ShortcutCommand {
  return {
    id: id as ShortcutCommand['id'], label: () => id, aliases: [],
    defaults: { 'desktop:windows': { code, modifiers: ['control'] } },
    regions: ['page', 'editable'], modals,
    resolve: () => ({ status: 'handled', run }),
  }
}

async function fixture(resolve: NativeCommandResolver, before?: (ctx: cordis.Context) => void) {
  const keyboard = new Set<(input: DesktopShortcutInput) => void>()
  const preferences = new Set<(snapshot: ShortcutConfigSnapshot) => void>()
  const observers = new Set<object>()
  const document = Object.assign(new InputTarget(), {
    documentElement: { dataset: { platform: 'win32' } },
    activeElement: new FocusTarget(), modals: [] as FocusTarget[],
    querySelectorAll() { return this.modals },
  })
  let raw: string | null = null
  const persistence = new ShortcutPersistence({ read: () => raw, write: value => { raw = value } }, 'desktop', 'windows', false,
    snapshot => { for (const publish of preferences) publish(snapshot) })
  const window = Object.assign(new InputTarget(), {
    document, setTimeout, clearTimeout,
    dshDesktop: {
      keyboard: {
        subscribe(listener: (input: DesktopShortcutInput) => void) { keyboard.add(listener); return () => { keyboard.delete(listener) } },
        async closeWindow() {},
      },
      shortcuts: {
        get(definitions: Parameters<ShortcutPersistence['setDefinitions']>[0]) {
          persistence.setDefinitions(definitions); return persistence.readCurrent()
        },
        edit: persistence.edit.bind(persistence),
        subscribe(listener: (snapshot: ShortcutConfigSnapshot) => void) { preferences.add(listener); return () => { preferences.delete(listener) } },
        async recording() {},
      },
    },
  })
  const nativeModule = { exports: {} as { default: unknown } }
  runInNewContext(source, {
    document, navigator: { platform: 'Win32' }, console, crypto: webcrypto,
    Element: FocusTarget, HTMLIFrameElement: class {},
    MutationObserver: class {
      observe() { observers.add(this) }
      takeRecords() { return [] }
      disconnect() { observers.delete(this) }
    },
    __DSH_SHORTCUTS_CONFIG__: { stopSequenceMs: 750 },
    window: Object.assign(window, { __ModuleLoader__: { load(registration: { factory(require: (id: string) => unknown): unknown }) {
      nativeModule.exports = { default: registration.factory(nativeRequire) }
    } } }),
  })
  function nativeRequire(id: string) {
    if (id === '@deepseek-ai/cordis') return cordis
    if (id === '@deepseek-ai/dsh-client-store') return stores
    assert.equal(id, '@deepseek-ai/dsh-client-ui-primitives')
    return { modalSelector: '[data-shortcut-modal]', observeComposition: () => ({ guards: () => false, dispose() {} }) }
  }
  const adapter = { exports: {} as typeof import('../src/client/native-shortcuts.js') }
  runInNewContext(adapterCode, { module: adapter, exports: adapter.exports })
  const ctx = new cordis.Context()
  const locale = new Set<() => void>()
  ctx.provide('locale', { subscribe(listener: () => void) { locale.add(listener); return () => { locale.delete(listener) } } } as never)
  await ctx.plugin(nativeModule.exports.default as typeof import('@deepseek-ai/dsh-client-shortcuts/client').default)
  await settled()
  before?.(ctx)
  const readiness: boolean[] = []
  const install = () => adapter.exports.installNativeShortcuts(ctx, resolve, ready => readiness.push(ready))
  const provider = await install(); await settled()
  return {
    ctx, document, window, keyboard, preferences, locale, observers, provider, readiness, install,
    async register(value: ShortcutCommand) {
      const off = ctx.shortcuts.register(value); await settled(); return off
    },
    input(code: string, overrides: Partial<DesktopShortcutInput> = {}) {
      const input = {
        revision: ctx.shortcuts.config.getSnapshot().revision, kind: 'keyboard', frameName: '',
        code, control: true, alt: false, shift: false, meta: false, repeat: false, ...overrides,
      } as DesktopShortcutInput
      for (const listener of keyboard) listener(input)
    },
    async dispose() { await ctx.fiber.dispose(); persistence.dispose() },
  }
}

test('native command resolution keeps user bindings, repeat/stale guards, menu dispatch and local fallback', async () => {
  const actions: string[] = []
  let sourceId: string | undefined
  const f = await fixture((command, context) => sourceId === undefined ? undefined : {
    status: 'handled', run: () => { actions.push(`${sourceId}:${command.id}:${context.source ?? 'keyboard'}`) },
  })
  try {
    await f.register(command('session.new', 'KeyN', () => actions.push('local:new')))
    await f.register(command('page.close', 'KeyW', () => actions.push('local:close'), ['settings']))
    assert.equal(f.ctx.shortcuts.stopSequenceMs, 750, 'Native Host-provided timing remains effective')
    f.input('KeyN')
    sourceId = 'remote-a'
    f.input('KeyN')
    f.input('KeyN', { repeat: true })
    f.input('KeyN', { revision: 'stale' as ShortcutConfigSnapshot['revision'] })
    assert.deepEqual(actions, ['local:new', 'remote-a:session.new:keyboard'])

    const changed = await f.ctx.shortcuts.edit({ type: 'set', id: 'session.new' as ShortcutCommand['id'],
      binding: { code: 'KeyM', modifiers: ['control', 'shift'] },
    }, f.ctx.shortcuts.config.getSnapshot().revision)
    assert.equal(changed.status, 'saved')
    f.input('KeyN')
    f.input('KeyM', { shift: true })
    assert.equal(actions.at(-1), 'remote-a:session.new:keyboard')
    assert.equal(actions.length, 3, 'The former binding cannot dispatch after the native preference edit')
    f.input('', { kind: 'menu', commandId: 'page.close' as ShortcutCommand['id'] })
    assert.equal(actions.at(-1), 'remote-a:page.close:menu')
    sourceId = undefined
    f.input('KeyM', { shift: true })
    assert.equal(actions.at(-1), 'local:new', 'Returning local preserves the original command callback')
  } finally { await f.dispose() }
  assert.equal(f.keyboard.size + f.preferences.size + f.locale.size + f.observers.size, 0)
  assert.equal(f.document.listenerCount + f.window.listenerCount, 0)
})

test('native guest ownership is verified before routing and blocked remote actions never reach retained local commands', async () => {
  const seen: string[] = []
  let localCalls = 0
  const f = await fixture((command, context) => {
    seen.push(`${command.id}:${context.source ?? 'keyboard'}`)
    return { status: 'blocked', reason: 'The remote owner has no active session.' }
  })
  try {
    await f.register(command('session.archive', 'KeyA', () => { localCalls++ }))
    f.document.activeElement = new FocusTarget('guest-current')
    f.input('KeyA', { kind: 'webview', frameName: 'guest-stale' })
    assert.equal(seen.length, 0)
    f.input('KeyA', { kind: 'webview', frameName: 'guest-current' })
    assert.deepEqual(seen, ['session.archive:webview'])
    f.document.activeElement.isConnected = false
    f.input('KeyA', { kind: 'webview', frameName: 'guest-current' })
    assert.equal(seen.length, 1)
    f.document.activeElement = new FocusTarget()
    const modal = new FocusTarget(); modal.dataset.shortcutModal = 'settings'
    f.document.modals = [modal]
    f.input('KeyA')
    assert.equal(seen.length, 2, 'Windows modal-priority dispatch still resolves through the source guard')
    assert.equal(localCalls, 0)
  } finally { await f.dispose() }
})

test('Windows modal-priority bindings retain native local actions while protecting remote content', async () => {
  let source: string | undefined
  const actions: string[] = []
  const routed = () => { actions.push('routed') }
  const f = await fixture(workspaceCommandResolver({
    getRemoteSourceId: () => source, onNewSession: routed, onSearch: routed,
    onAddWorkspace: routed, onClose: routed, onBlocked: routed,
  }))
  try {
    for (const [id, code] of [['session.new', 'KeyN'], ['session.search', 'KeyK'], ['workspace.add', 'KeyO']] as const) {
      await f.register(command(id, code, () => { actions.push(id) }))
    }
    const modal = new FocusTarget(); modal.dataset.shortcutModal = 'settings'
    f.document.modals = [modal]
    for (const code of ['KeyN', 'KeyK', 'KeyO']) f.input(code)
    assert.deepEqual(actions, ['session.new', 'session.search', 'workspace.add'],
      'Local Desktop bindings keep the original native action even with a modal open')
    source = 'remote-a'
    for (const code of ['KeyN', 'KeyK', 'KeyO']) f.input(code)
    assert.equal(actions.length, 3, 'A local modal above remote content cannot navigate either background Host')
  } finally { await f.dispose() }
})

test('enabling, unloading and re-enabling routing preserves the native provider and dependent root', async () => {
  let remoteCalls = 0, localCalls = 0
  let mounts = 0, disposals = 0
  const original = command('session.new', 'KeyN', () => { localCalls++ })
  const nativeResolver = original.resolve
  const f = await fixture(() => ({ status: 'handled', run: () => { remoteCalls++ } }), ctx => {
    ctx.shortcuts.register(original)
    ctx.inject(['shortcuts'], scope => {
      mounts++
      scope.effect(() => () => { disposals++ })
    })
  })
  try {
    const nativeCatalog = f.ctx.shortcuts.catalog
    assert.equal(f.readiness.at(-1), true)
    f.input('KeyN')
    await f.provider.dispose()
    assert.equal(f.ctx.shortcuts.catalog, nativeCatalog, 'The original native service and its state survive removal')
    assert.equal(original.resolve, nativeResolver, 'Only our resolver is restored')
    assert.equal(f.keyboard.size, 1)
    assert.equal(f.ctx.shortcuts.catalog.getSnapshot().length, 1)
    assert.equal(f.readiness.at(-1), false)
    f.input('KeyN')
    assert.equal(remoteCalls, 1)
    assert.equal(localCalls, 1)
    await f.install(); await settled()
    f.input('KeyN')
    assert.equal(remoteCalls, 2)
    assert.equal(mounts, 1, 'Native layout dependencies never remount')
    assert.equal(disposals, 0, 'No root-slot gap exists during enable, disable or reload')
    assert.equal(f.keyboard.size, 1)
  } finally { await f.dispose() }
  assert.equal(disposals, 1)
})

test('catalog refresh and re-registration keep one wrapper and preserve native disposal identity', async () => {
  let resolutions = 0, localCalls = 0
  const f = await fixture(() => { resolutions++; return undefined })
  try {
    const first = command('session.new', 'KeyN', () => { localCalls++ })
    const native = first.resolve
    const off = await f.register(first)
    const wrapper = first.resolve
    for (const refresh of f.locale) { refresh(); refresh() }
    assert.equal(first.resolve, wrapper)
    f.input('KeyN')
    assert.equal(resolutions, 1)
    assert.equal(localCalls, 1)
    off(); await settled()
    assert.equal(first.resolve, native, 'Retired commands release their original resolver')
    assert.equal(f.ctx.shortcuts.catalog.getSnapshot().length, 0)
    const second = command('session.new', 'KeyN', () => { localCalls++ })
    await f.register(second)
    f.input('KeyN')
    assert.equal(resolutions, 2)
    assert.equal(localCalls, 2)
    const retiredResult = wrapper({ region: 'page', modal: null, target: null })
    if (retiredResult.status === 'handled') retiredResult.run()
    assert.equal(resolutions, 2, 'A retained old wrapper cannot reactivate after another command registers')
    assert.equal(localCalls, 3)
  } finally { await f.dispose() }
})

test('a foreign resolver replacement is retained and withdraws routing readiness', async () => {
  const f = await fixture(() => ({ status: 'blocked', reason: 'fixture' }))
  let localCalls = 0
  try {
    const first = command('session.new', 'KeyN', () => { localCalls++ })
    const second = command('page.close', 'KeyW', () => {})
    const secondNative = second.resolve
    await f.register(first); await f.register(second)
    const captured = first.resolve
    const foreign: ShortcutCommand['resolve'] = context => captured(context)
    first.resolve = foreign
    for (const refresh of f.locale) refresh()
    assert.equal(f.readiness.at(-1), false)
    assert.equal(first.resolve, foreign)
    assert.equal(second.resolve, secondNative, 'Other wrappers are restored after readiness is withdrawn')
    for (const refresh of f.locale) refresh()
    assert.equal(f.readiness.at(-1), false, 'A failed contract cannot silently rewrap a foreign resolver')
    assert.equal(first.resolve, foreign)
    f.input('KeyN')
    assert.equal(localCalls, 1, 'A foreign wrapper retaining our retired resolver delegates only to the native action')
    await f.provider.dispose()
    assert.equal(first.resolve, foreign, 'Cleanup never overwrites another owner')
  } finally { await f.dispose() }
})

test('unsupported or immutable command contracts refuse routing without replacing the native service', async () => {
  const f = await fixture(() => ({ status: 'blocked', reason: 'fixture' }), ctx => {
    ctx.shortcuts.register(Object.freeze(command('session.new', 'KeyN', () => {})))
  })
  try {
    assert.equal(f.readiness.includes(true), false)
    assert.equal(f.keyboard.size, 1)
    assert.equal(f.ctx.shortcuts.catalog.getSnapshot().length, 1)
  } finally { await f.dispose() }
})

test('a command frozen after attachment disables routing without failing native cleanup', async () => {
  const f = await fixture(() => ({ status: 'blocked', reason: 'fixture' }))
  let localCalls = 0
  try {
    const native = command('session.new', 'KeyN', () => { localCalls++ })
    await f.register(native)
    Object.freeze(native)
    for (const refresh of f.locale) refresh()
    assert.equal(f.readiness.at(-1), false)
    f.input('KeyN')
    assert.equal(localCalls, 1, 'An unremovable wrapper becomes an inert native passthrough')
    await f.provider.dispose()
    assert.equal(f.keyboard.size, 1)
  } finally { await f.dispose() }
})

test('unrelated immutable application commands stay outside the compatibility boundary', async () => {
  let routed = 0, native = 0
  const unrelated = Object.freeze(command('application.palette', 'KeyP', () => { native++ }))
  const original = unrelated.resolve
  const f = await fixture(() => { routed++; return { status: 'blocked', reason: 'fixture' } }, ctx => {
    ctx.shortcuts.register(unrelated)
  })
  try {
    assert.equal(f.readiness.at(-1), true)
    assert.equal(unrelated.resolve, original)
    f.input('KeyP')
    assert.equal(native, 1)
    assert.equal(routed, 0, 'No global or third-party resolver is inspected or wrapped')
    const routedCommand = command('session.new', 'KeyN', () => { native++ })
    await f.register(routedCommand)
    f.input('KeyN')
    assert.equal(routed, 1)
    assert.equal(unrelated.resolve, original)
    await f.provider.dispose()
    assert.equal(unrelated.resolve, original)
    f.input('KeyP')
    assert.equal(native, 2)
  } finally { await f.dispose() }
})

test('build validation rejects changes to native command identity or dispatch', () => {
  assertNativeShortcutRegistry(source)
  assert.throws(() => assertNativeShortcutRegistry(source.replace('this.commands.set(command.id, command)', 'this.commands.set(command.id, { ...command })')), /command identity contract/)
  assert.throws(() => assertNativeShortcutRegistry(source.replace('this.bindings.set(bindingKey(row.binding), command)', 'this.bindings.set(bindingKey(row.binding), { ...command })')), /command identity contract/)
  assert.throws(() => assertNativeShortcutRegistry(source.replace('command.resolve(context)', 'command.cachedResolve(context)')), /command identity contract/)
})
