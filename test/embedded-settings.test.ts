import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { SlotCore, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { EmbeddedSettingsController, createEmbeddedSettingsHosts, installEmbeddedPermissionSettings } from '../src/client/embedded-settings.js'
import type { SettingsHostSnapshot } from '../src/client/settings-host-bridge.js'

function fixture(available = true) {
  const native = () => {
    const store = createSnapshotStore<{ open: boolean; activeId?: string }>({ open: false })
    let opens = 0
    const shell = { ...store, actions: {
      open() { opens++; store.set({ open: true, activeId: undefined }) },
      openSection(id: string) { opens++; store.set({ open: true, activeId: id }) },
      close() { store.set({ open: false, activeId: undefined }) },
    } }
    const entry = { locale: 'settings', store: { create: () => shell } } as unknown as StoredEntry
    return { shell, entry, get opens() { return opens } }
  }
  const initial = native()
  let current = initial, closed = 0, localGeneral = 0
  let sections = ['general', 'models']
  const listeners = new Set<() => void>()
  const context = { slots: {
    entries: (slot: string) => slot === 'settings.section' ? sections.map(id => ({ options: { id, order: id === 'general' ? 10 : 0 } })) : available ? [current.entry] : [],
    subscribe: (_slot: string, listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  } } as unknown as Context
  const layout = { shown: false, showSettings(value: boolean) { this.shown = value } }
  const controller = new EmbeddedSettingsController(context, layout, () => { closed++ }, () => { localGeneral++ })
  return { controller, shell: initial.shell, layout, get closed() { return closed }, get opens() { return initial.opens }, get localGeneral() { return localGeneral },
    get listeners() { return listeners.size },
    publish(value = true) { available = value; for (const listener of listeners) listener() },
    sections(ids: string[]) { sections = ids; for (const listener of listeners) listener() },
    replace() { current = native(); available = true; for (const listener of listeners) listener(); return current },
  }
}

test('settings presentation waits for the original sidebar commit and its native root store', async () => {
  const f = fixture(false), lifetime = new AbortController()
  let presented = false
  const opening = f.controller.open(lifetime.signal).then(() => { presented = true })
  try {
    f.controller.mounted()
    await Promise.resolve()
    assert.equal(presented, false)
    assert.equal(f.layout.shown, true)
    f.publish()
    await opening
    assert.equal(f.opens, 1)
    assert.equal(f.shell.getSnapshot().open, true)
    assert.equal(f.shell.getSnapshot().activeId, 'models', 'remote settings starts in its native Models section')
  } finally { f.controller.close() }
  assert.equal(f.layout.shown, false)
  assert.equal(f.listeners, 0)
})

test('remote General hands off to local settings without reporting a closed remote view', async () => {
  const f = fixture()
  try {
    const opening = f.controller.open(new AbortController().signal)
    f.controller.mounted()
    await opening
    f.controller.dialogCommitted()
    await Promise.resolve()
    f.shell.actions.openSection('general')
    assert.equal(f.shell.getSnapshot().open, false, 'remote General closes before the store update returns')
    assert.equal(f.controller.state.getSnapshot().returningLocal, true)
    assert.equal(f.localGeneral, 1)
    assert.equal(f.closed, 0, 'handoff retains the live channel for selecting the local host')
    f.controller.reopen()
    f.shell.actions.open()
    assert.equal(f.shell.getSnapshot().open, false, 'native reopen cannot override an in-flight handoff')
    assert.equal(f.localGeneral, 1)
    assert.equal(f.closed, 0)
  } finally { f.controller.close() }
})

test('initial settings waits for native Models instead of falling back to local General during plugin arrival', async () => {
  const f = fixture()
  f.sections(['general'])
  try {
    let presented = false
    const opening = f.controller.open(new AbortController().signal).then(() => { presented = true })
    f.controller.mounted()
    await Promise.resolve()
    assert.equal(presented, false)
    assert.equal(f.opens, 0)
    assert.equal(f.localGeneral, 0)
    f.sections(['general', 'models'])
    await opening
    assert.equal(f.shell.getSnapshot().activeId, 'models')
    assert.equal(f.localGeneral, 0)
  } finally { f.controller.close() }
})

test('withdrawing the selected native section cannot fall back to remote General', async () => {
  const f = fixture()
  try {
    const opening = f.controller.open(new AbortController().signal)
    f.controller.mounted()
    await opening
    f.controller.dialogCommitted()
    await Promise.resolve()
    f.sections(['general', 'account'])
    assert.equal(f.shell.getSnapshot().open, true, 'native fallback follows section order, not registration order')
    assert.equal(f.localGeneral, 0)
    f.sections(['general'])
    assert.equal(f.shell.getSnapshot().open, false)
    assert.equal(f.localGeneral, 1)
    assert.equal(f.closed, 0)
  } finally { f.controller.close() }
})

test('startup onboarding can close the dialog before confirmation and leaves a native reopen action', async () => {
  const f = fixture()
  try {
    const opening = f.controller.open(new AbortController().signal)
    f.controller.mounted()
    await opening
    f.controller.dialogCommitted()
    f.shell.actions.close()
    await Promise.resolve()
    assert.equal(f.closed, 0, 'initial native onboarding is not a user dismissal')
    assert.equal(f.controller.state.getSnapshot().active, true)
    assert.equal(f.controller.state.getSnapshot().open, false)
    f.controller.reopen()
    f.controller.dialogCommitted()
    await Promise.resolve()
    f.shell.actions.close()
    assert.equal(f.closed, 1, 'a rendered native dialog owns its later close gesture')
    f.shell.actions.close()
    assert.equal(f.closed, 1, 'a single dismissal is reported once')
  } finally { f.controller.close() }
})

test('settings abort and replacement cannot report stale native dialog closures', async () => {
  const f = fixture(), first = new AbortController(), next = new AbortController()
  const opening = f.controller.open(first.signal)
  f.controller.mounted()
  await opening
  f.controller.dialogCommitted()
  const firstGeneration = f.controller.state.getSnapshot().generation
  const replacing = f.controller.open(next.signal)
  assert.notEqual(f.controller.state.getSnapshot().generation, firstGeneration, 'React must confirm replacements even when active remains true after batching')
  f.controller.mounted()
  await replacing
  await Promise.resolve()
  f.shell.actions.close()
  assert.equal(f.closed, 0, 'a previous document commit does not confirm its replacement')
  f.controller.reopen()
  f.controller.dialogCommitted()
  await Promise.resolve()
  next.abort()
  assert.equal(f.closed, 0)
  assert.equal(f.listeners, 0)
  assert.equal(f.layout.shown, false)
})

test('an aborted or unavailable settings mount releases its registration subscription', async () => {
  const f = fixture(false), lifetime = new AbortController()
  const opening = f.controller.open(lifetime.signal)
  lifetime.abort()
  await assert.rejects(opening, /unavailable or navigation cancelled/)
  f.controller.mounted()
  f.publish()
  assert.equal(f.opens, 0)
  assert.equal(f.listeners, 0)
  assert.deepEqual(f.controller.state.getSnapshot(), { active: false, open: false, available: false })
})

test('withdrawn native Settings exposes its unavailable state and resumes when the slot returns', async () => {
  const f = fixture()
  try {
    let presentations = 0
    const opening = f.controller.open(new AbortController().signal).then(() => { presentations++ })
    f.controller.mounted()
    await opening
    f.controller.dialogCommitted()
    await Promise.resolve()
    f.publish(false)
    assert.equal(f.controller.state.getSnapshot().open, false)
    assert.equal(f.controller.state.getSnapshot().available, false)
    assert.equal(f.controller.state.getSnapshot().active, true)
    assert.equal(f.closed, 0, 'slot withdrawal is not a user close gesture')
    f.publish()
    assert.equal(f.controller.state.getSnapshot().available, true)
    assert.equal(f.controller.state.getSnapshot().open, true)
    assert.equal(f.opens, 2)
    assert.equal(presentations, 1)
  } finally { f.controller.close() }
  assert.equal(f.listeners, 0)
})

test('a replacement native root opens once and stale confirmations cannot close the replacement', async () => {
  const f = fixture()
  try {
    const opening = f.controller.open(new AbortController().signal)
    f.controller.mounted()
    await opening
    f.controller.dialogCommitted()
    const next = f.replace()
    assert.equal(next.opens, 1)
    assert.equal(next.shell.getSnapshot().open, true)
    assert.equal(f.shell.getSnapshot().open, false)
    await Promise.resolve()
    f.shell.actions.close()
    next.shell.actions.close()
    assert.equal(f.closed, 0, 'the queued old-root confirmation is discarded')
    f.publish()
    assert.equal(next.opens, 1, 'unrelated slot updates do not override native onboarding or user closure')
    f.controller.reopen()
    f.controller.dialogCommitted()
    await Promise.resolve()
    next.shell.actions.close()
    assert.equal(f.closed, 1)
  } finally { f.controller.close() }
  assert.equal(f.listeners, 0)
})

test('the host chooser lease follows settings operations and ignores replaced message sources', () => {
  const state = createSnapshotStore<{ active: boolean; generation?: number }>({ active: false })
  const clients: Array<{ disposed: boolean; selected: string[]; publish(snapshot: SettingsHostSnapshot): void }> = []
  const hosts = createEmbeddedSettingsHosts(state, 'view-channel', channel => {
    assert.equal(channel, 'view-channel')
    const store = createSnapshotStore<SettingsHostSnapshot | undefined>(undefined)
    const client = { disposed: false, selected: [] as string[], publish: store.set }
    clients.push(client)
    return { getSnapshot: store.getSnapshot, subscribe: store.subscribe,
      select: id => { client.selected.push(id) }, dispose: () => { client.disposed = true },
    }
  })
  const first: SettingsHostSnapshot = { selectedId: 'one', choices: [{ id: 'one', name: 'Host one', phase: 'connected' }] }
  assert.equal(clients.length, 0)
  state.set({ active: true, generation: 1 })
  clients[0].publish(first)
  assert.equal(hosts.getSnapshot(), first)
  hosts.select('local')
  assert.deepEqual(clients[0].selected, ['local'])
  state.set({ active: true, generation: 1 })
  assert.equal(clients.length, 1, 'native dialog/onboarding rerenders do not replace the active bridge')
  state.set({ active: true, generation: 2 })
  assert.equal(clients[0].disposed, true)
  assert.equal(clients.length, 2)
  assert.equal(hosts.getSnapshot(), undefined)
  clients[0].publish(first)
  assert.equal(hosts.getSnapshot(), undefined)
  state.set({ active: false })
  assert.equal(clients[1].disposed, true)
  hosts.select('one')
  assert.deepEqual(clients[1].selected, [])
  hosts.dispose()
  state.set({ active: true, generation: 3 })
  assert.equal(clients.length, 2)
})

test('General handoff waits for host metadata once and is revoked with its settings generation', () => {
  const state = createSnapshotStore<{ active: boolean; generation?: number }>({ active: true, generation: 1 })
  const clients: Array<{ selected: string[]; publish(snapshot: SettingsHostSnapshot): void }> = []
  const hosts = createEmbeddedSettingsHosts(state, 'view-channel', () => {
    const store = createSnapshotStore<SettingsHostSnapshot | undefined>(undefined)
    const client = { selected: [] as string[], publish: store.set }
    clients.push(client)
    return { getSnapshot: store.getSnapshot, subscribe: store.subscribe,
      select: id => { client.selected.push(id) }, dispose() {},
    }
  })
  const snapshot: SettingsHostSnapshot = { selectedId: 'one', choices: [
    { id: 'local', name: 'This computer', phase: 'connected' },
    { id: 'one', name: 'Host one', phase: 'connected' },
  ] }
  try {
    hosts.select('local')
    assert.deepEqual(clients[0].selected, [])
    clients[0].publish(snapshot)
    clients[0].publish({ ...snapshot })
    assert.deepEqual(clients[0].selected, ['local'])
    state.set({ active: true, generation: 2 })
    hosts.select('local')
    state.set({ active: true, generation: 3 })
    clients[1].publish(snapshot)
    clients[2].publish(snapshot)
    assert.deepEqual(clients[1].selected, [])
    assert.deepEqual(clients[2].selected, [], 'a replaced settings operation cannot inherit a pending handoff')
  } finally { hosts.dispose() }
})

test('remote Permissions and privacy delegates native rows and follows replacement and withdrawal', async () => {
  const core = new SlotCore()
  const removeRoot = core.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' },
    'settings.general.item': { kind: 'list', scope: 'root' },
  } } as never, (() => null) as never)
  const component = () => null, inject = () => ({ remoteExecution: true }), store = { create: () => ({}) }
  const removeOriginal = core.register({ name: 'settings.general.item', id: 'permission', locale: 'settings.permission', inject, store } as never, component)
  const uploadComponent = () => null, uploadInject = () => ({ remoteUpload: true })
  const removeUpload = core.register({ name: 'settings.general.item', id: 'session-log-deepseek', locale: 'settings.sessionLog', inject: uploadInject } as never, uploadComponent)
  const cleanups: Array<() => void> = []
  const context = { locale: { getSnapshot: () => ({ active: 'en' }) }, slots: {
    register: core.register.bind(core), entriesOfSlot: core.entriesOfSlot.bind(core), subscribe: core.subscribe.bind(core),
    inject: (_name: string, install: () => () => void) => { cleanups.push(install()) },
  } } as unknown as Context
  const alias = 'connections.settings.permission'
  const settled = () => new Promise<void>(resolve => setImmediate(resolve))
  try {
    installEmbeddedPermissionSettings(context)
    const delegated = core.entries(alias)[0]
    assert.equal(delegated.component, component)
    assert.equal(delegated.inject, inject)
    assert.equal(delegated.store, store)
    assert.equal(delegated.locale, 'settings.permission')
    assert.equal(core.entries('connections.settings.sessionLog')[0].component, uploadComponent)
    assert.equal(core.entries('connections.settings.sessionLog')[0].inject, uploadInject)
    assert.deepEqual(core.entries('settings.section').map(row => row.options.id), ['connections-permissions'])
    assert.equal(core.entries('settings.general.item').length, 2, 'native General registry remains untouched')
    removeOriginal()
    await settled()
    assert.equal(core.entries(alias).length, 0)
    assert.equal(core.entries('settings.section').length, 1, 'upload consent stays accessible if permission controls are withdrawn')
    removeUpload()
    await settled()
    assert.equal(core.entries('connections.settings.sessionLog').length, 0)
    assert.equal(core.entries('settings.section').length, 0)
    const replacement = () => null
    const removeReplacement = core.register({ name: 'settings.general.item', id: 'permission', locale: 'settings.permission' } as never, replacement)
    await settled()
    assert.equal(core.entries(alias)[0].component, replacement)
    assert.equal(core.entries('settings.section').length, 1)
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    assert.equal(core.entries(alias).length, 0)
    assert.equal(core.entries('settings.section').length, 0)
    assert.equal(core.entries('settings.general.item')[0].component, replacement)
    removeReplacement()
  } finally { for (const cleanup of cleanups.reverse()) cleanup(); removeRoot() }
})
