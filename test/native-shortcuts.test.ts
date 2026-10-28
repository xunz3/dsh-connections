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
const { composeNativeShortcuts } = await import(new URL('../scripts/native-shortcuts.mjs', import.meta.url).href) as {
  composeNativeShortcuts(source: string): string
}
const serviceCode = transformSync(composeNativeShortcuts(source), { loader: 'js', format: 'cjs', target: 'es2022' }).code
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

async function fixture(resolve: NativeCommandResolver) {
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
  runInNewContext(serviceCode, {
    window, document, navigator: { platform: 'Win32' }, console, crypto: webcrypto,
    Element: FocusTarget, HTMLIFrameElement: class {},
    MutationObserver: class {
      observe() { observers.add(this) }
      takeRecords() { return [] }
      disconnect() { observers.delete(this) }
    },
    __DSH_SHORTCUTS_CONFIG__: { stopSequenceMs: 750 },
    module: nativeModule, exports: nativeModule.exports,
    require(id: string) {
      if (id === '@deepseek-ai/cordis') return cordis
      if (id === '@deepseek-ai/dsh-client-store') return stores
      assert.equal(id, '@deepseek-ai/dsh-client-ui-primitives')
      return { modalSelector: '[data-shortcut-modal]', observeComposition: () => ({ guards: () => false, dispose() {} }) }
    },
  })
  const adapter = { exports: {} as typeof import('../src/client/native-shortcuts.js') }
  runInNewContext(adapterCode, { module: adapter, exports: adapter.exports, require(id: string) {
    assert.equal(id, '@deepseek-ai/dsh-client-shortcuts/client'); return nativeModule.exports
  } })
  const ctx = new cordis.Context()
  const locale = new Set<() => void>()
  ctx.provide('locale', { subscribe(listener: () => void) { locale.add(listener); return () => { locale.delete(listener) } } } as never)
  const install = () => adapter.exports.installNativeShortcuts(ctx, resolve)
  const provider = await install(); await settled()
  return {
    ctx, document, window, keyboard, preferences, locale, observers, provider,
    async restoreNative() {
      await ctx.plugin(nativeModule.exports.default as typeof import('@deepseek-ai/dsh-client-shortcuts/client').default)
      await settled()
    },
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

test('retiring the composed provider permits native restoration without duplicate commands or input listeners', async () => {
  let remoteCalls = 0, localCalls = 0
  const f = await fixture(() => ({ status: 'handled', run: () => { remoteCalls++ } }))
  try {
    await f.register(command('session.new', 'KeyN', () => { localCalls++ }))
    f.input('KeyN')
    await f.provider.dispose()
    assert.equal(f.ctx.get('shortcuts', false), undefined)
    assert.equal(f.keyboard.size + f.preferences.size + f.locale.size + f.observers.size, 0)
    assert.equal(f.document.listenerCount + f.window.listenerCount, 0)
    await f.restoreNative()
    await f.register(command('session.new', 'KeyN', () => { localCalls++ }))
    assert.equal(f.keyboard.size, 1)
    assert.equal(f.ctx.shortcuts.catalog.getSnapshot().length, 1)
    f.input('KeyN')
    assert.equal(remoteCalls, 1)
    assert.equal(localCalls, 1)
  } finally { await f.dispose() }
})
