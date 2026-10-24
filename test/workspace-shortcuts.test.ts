import assert from 'node:assert/strict'
import test from 'node:test'
import type { ShortcutCatalogEntry, ShortcutContext, ShortcutFixedInput, ShortcutGesture, Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { ShortcutConfigSnapshot } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { installWorkspaceShortcuts, supportsWorkspaceShortcutRouting, type WorkspaceShortcutCallbacks } from '../src/client/workspace-shortcuts.js'

const entry = (id: string, code: string, extra: Partial<ShortcutCatalogEntry> = {}): ShortcutCatalogEntry => ({
  id: id as ShortcutCatalogEntry['id'], label: id, aliases: [], keys: [], aria: undefined,
  binding: { code, modifiers: ['control', 'alt'] }, modified: false, conflicts: [], issue: null, ...extra,
})
const snapshot = (): ShortcutConfigSnapshot => ({
  revision: 'test' as ShortcutConfigSnapshot['revision'], sequence: 1, document: { schemaVersion: 1, profiles: {} },
  status: 'ready', error: null, usingDefaults: true,
})

function harness(environment: Pick<Shortcuts, 'runtime' | 'platform'> = { runtime: 'web', platform: 'windows' }) {
  let rows = [entry('session.new', 'KeyN'), entry('session.search', 'KeyK'), entry('workspace.add', 'KeyO'),
    entry('session.archive', 'KeyA'), entry('session.fork', 'KeyF'), entry('session.rename', 'KeyR')]
  let config = snapshot()
  let remote: string | undefined = 'server-a'
  const listeners = new Set<(input: ShortcutFixedInput) => void>()
  const calls: string[][] = []
  const shortcuts = {
    ...environment,
    catalog: { getSnapshot: () => rows, subscribe: () => () => {} },
    config: { getSnapshot: () => config, subscribe: () => () => {} },
    observeFixedInput(listener: (input: ShortcutFixedInput) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const callbacks: WorkspaceShortcutCallbacks = {
    getRemoteSourceId: () => remote,
    onNewSession: id => { calls.push(['new', id]) }, onSearch: () => { calls.push(['search']) },
    onAddWorkspace: () => { calls.push(['add']) }, onBlocked: (command, id) => { calls.push(['blocked', command, id]) },
  }
  const off = installWorkspaceShortcuts(shortcuts, callbacks)
  return {
    callbacks, calls, listeners, off,
    setRows(value: ShortcutCatalogEntry[]) { rows = value },
    setConfig(value: Partial<ShortcutConfigSnapshot>) { config = { ...config, ...value } },
    select(id: string | undefined) { remote = id },
    key(code: string, gesture: Partial<ShortcutGesture> = {}, context: Partial<ShortcutContext> = {}) {
      let consumed = 0
      const input: ShortcutFixedInput = { type: 'keydown',
        gesture: { code, control: true, alt: true, shift: false, meta: false, repeat: false,
          composing: false, defaultPrevented: false, ...gesture },
        context: { region: 'page', modal: null, target: null, ...context }, consume: () => { consumed++ },
      }
      for (const listener of listeners) listener(input)
      return consumed
    },
  }
}

test('remote commands capture the selected computer and block local archive/fork', () => {
  const h = harness()
  assert.equal(h.key('KeyN'), 1)
  h.select('server-b')
  assert.equal(h.key('KeyA'), 1)
  assert.equal(h.key('KeyF'), 1)
  assert.deepEqual(h.calls, [['new', 'server-a'], ['blocked', 'session.archive', 'server-b'], ['blocked', 'session.fork', 'server-b']])
  h.select(undefined)
  assert.equal(h.key('KeyN'), 0)
  assert.equal(h.key('KeyA'), 0)
  assert.equal(h.key('KeyF'), 0)
  assert.equal(h.calls.length, 3)
})

test('the unified search and add controls route for both local and remote selection', () => {
  const h = harness()
  for (const owner of [undefined, 'server-a']) {
    h.select(owner)
    assert.equal(h.key('KeyK'), 1)
    assert.equal(h.key('KeyO'), 1)
  }
  assert.deepEqual(h.calls, [['search'], ['add'], ['search'], ['add']])
})

test('accepted custom bindings update immediately and require exact physical keys and modifiers', () => {
  const h = harness({ runtime: 'web', platform: 'macos' })
  h.setRows([entry('session.new', 'KeyP', { modified: true, binding: { code: 'KeyP', modifiers: ['alt', 'meta'] } })])
  assert.equal(h.key('KeyN'), 0, 'the old default no longer applies')
  assert.equal(h.key('KeyP'), 0, 'Control must not alias Meta')
  assert.equal(h.key('KeyP', { control: false, meta: true, shift: true }), 0, 'additional modifiers do not match')
  assert.equal(h.key('KeyP', { control: false, meta: true, alt: false }), 0, 'missing modifiers do not match')
  assert.equal(h.key('KeyP', { control: false, meta: true }), 1)
  assert.deepEqual(h.calls, [['new', 'server-a']])
})

test('disabled, unbound, conflicting, and loading commands stay with native dispatch', () => {
  const h = harness()
  for (const extra of [
    { binding: null }, { issue: 'reserved' as const },
    { conflicts: ['another.command' as ShortcutCatalogEntry['id']] },
  ]) {
    h.setRows([entry('session.new', 'KeyN', extra)])
    assert.equal(h.key('KeyN'), 0)
  }
  h.setRows([entry('session.new', 'KeyN')])
  h.setConfig({ status: 'loading' })
  assert.equal(h.key('KeyN'), 0)
  h.setConfig({ status: 'unreadable', error: 'read' })
  assert.equal(h.key('KeyN'), 1, 'read errors retain the accepted binding, as native dispatch does')
  assert.deepEqual(h.calls, [['new', 'server-a']])
})

test('local controls, IME, modal dialogs, terminal input, and embedded input retain ownership', () => {
  const h = harness()
  for (const code of ['KeyN', 'KeyK', 'KeyO', 'KeyA', 'KeyF']) {
    assert.equal(h.key(code, { defaultPrevented: true }), 0)
    assert.equal(h.key(code, { composing: true }), 0)
    assert.equal(h.key(code, {}, { modal: 'directory-picker' }), 0)
    assert.equal(h.key(code, {}, { region: 'terminal' }), 0)
    assert.equal(h.key(code, {}, { source: 'iframe' }), 0)
    assert.equal(h.key(code, {}, { source: 'webview' }), 0)
    assert.equal(h.key(code, {}, { source: 'menu' }), 0)
  }
  assert.deepEqual(h.calls, [])
  assert.equal(h.key('KeyN', {}, { region: 'editable', source: 'keyboard' }), 1)
})

test('repeat events remain consumed without running actions again or falling onto local sessions', () => {
  const h = harness()
  for (const code of ['KeyN', 'KeyK', 'KeyO', 'KeyA', 'KeyF']) assert.equal(h.key(code, { repeat: true }), 1)
  assert.deepEqual(h.calls, [])
  h.select(undefined)
  assert.equal(h.key('KeyA', { repeat: true }), 0)
})

test('unrelated native commands and reset events are untouched', () => {
  const h = harness()
  assert.equal(h.key('KeyR'), 0)
  assert.equal(h.key('KeyQ'), 0)
  for (const listener of h.listeners) listener({ type: 'reset' })
  assert.deepEqual(h.calls, [])
})

test('native pair precedence does not let a single-key command steal another binding', () => {
  const h = harness({ runtime: 'desktop', platform: 'linux' })
  const single = entry('session.new', 'KeyN')
  const pair = entry('another.command', 'KeyJ', { binding: { code: 'KeyJ', secondCode: 'KeyN', modifiers: ['control', 'alt'] } })
  h.setRows([single, pair])
  assert.equal(h.key('KeyN', { secondCode: 'KeyJ' }), 0)
  h.setRows([single, { ...pair, conflicts: [single.id] }])
  assert.equal(h.key('KeyN', { secondCode: 'KeyJ' }), 0, 'a conflicting pair is blocked by native dispatch')
  h.setRows([single])
  assert.equal(h.key('KeyN', { secondCode: 'KeyJ' }), 1, 'native single-key fallback still applies if no pair is registered')
  h.setRows([entry('session.new', 'KeyJ', { binding: pair.binding })])
  assert.equal(h.key('KeyN', { secondCode: 'KeyJ' }), 1)
  assert.equal(h.key('KeyJ', { secondCode: 'KeyN' }), 1, 'pair order is immaterial')
})

test('consumption precedes business actions even when the owner callback fails', () => {
  const h = harness()
  let consumed = false
  h.callbacks.onNewSession = () => { assert.equal(consumed, true); throw new Error('operation-failed') }
  const listener = [...h.listeners][0]
  assert.throws(() => listener({ type: 'keydown',
    gesture: { code: 'KeyN', control: true, alt: true, shift: false, meta: false, repeat: false, composing: false, defaultPrevented: false },
    context: { region: 'page', modal: null, target: null }, consume: () => { consumed = true },
  }), /operation-failed/u)
  assert.equal(consumed, true)
})

test('unsupported native accelerator paths are not claimed and the observer is disposable', () => {
  for (const platform of ['windows', 'macos'] as const) {
    assert.equal(supportsWorkspaceShortcutRouting({ runtime: 'web', platform }), true)
    assert.equal(supportsWorkspaceShortcutRouting({ runtime: 'desktop', platform }), false)
    const h = harness({ runtime: 'desktop', platform })
    assert.equal(h.listeners.size, 0)
    assert.equal(h.key('KeyN'), 0)
    h.off()
  }
  const h = harness({ runtime: 'desktop', platform: 'linux' })
  assert.equal(h.listeners.size, 1)
  assert.equal(h.key('KeyN'), 1)
  h.off(); h.off()
  assert.equal(h.listeners.size, 0)
  assert.equal(h.key('KeyN'), 0)
})
