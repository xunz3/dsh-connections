import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceBrowserViewModel, type WorkspaceBrowserModel } from '../src/client/workspace-browser-view-model.js'
import { workspaceRowKey, type WorkspaceSource } from '../src/client/workspace-catalog.js'
import type { WorkspaceCatalog } from '../src/shared/workspace-protocol.js'

function catalog(ids = ['chat']): WorkspaceCatalog {
  return {
    workspaces: [{ id: 'project', title: 'Project', path: '/project', sessionIds: ids }],
    sessions: ids.map(id => ({ id, title: id, updatedAt: 0, running: false, blank: false })),
    pinnedSessionIds: [], archivedSessionIds: [],
  }
}
const source = (id: string, extra: Partial<WorkspaceSource> = {}): WorkspaceSource => ({ id, name: id, phase: 'connected', catalog: catalog(), ...extra })
function model(extra: Partial<WorkspaceBrowserModel> = {}): WorkspaceBrowserModel {
  return {
    sources: [source('local'), source('remote')], onOpenSession() {}, onOpenWorkspace() {},
    onNewSession() {}, onAddWorkspace() {}, onReconnect() {}, onRenameWorkspace() {},
    onForgetWorkspace() {}, onRenameSession() {}, onArchiveSession() {}, onPinSession() {}, ...extra,
  }
}
function deferred() {
  let resolve!: () => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('same native IDs remain source-qualified and each pending row deduplicates independently', async () => {
  const calls: unknown[][] = []
  const local = deferred()
  const remote = deferred()
  const vm = new WorkspaceBrowserViewModel(model({
    onRenameSession: (sourceId, id, title) => { calls.push([sourceId, id, title]); return (sourceId === 'local' ? local : remote).promise },
    onOpenWorkspace: (...args) => { calls.push(['workspace', ...args]) },
    onPinSession: (...args) => { calls.push(['pin', ...args]) },
  }))
  const first = vm.renameSession('local', 'chat', 'Local')
  const duplicate = vm.renameSession('local', 'chat', 'Duplicate')
  const other = vm.renameSession('remote', 'chat', 'Remote')
  assert.equal(first, duplicate)
  assert.deepEqual(calls, [['local', 'chat', 'Local'], ['remote', 'chat', 'Remote']])
  assert.deepEqual([...vm.getSnapshot().pending], [workspaceRowKey('local', 'session', 'chat'), workspaceRowKey('remote', 'session', 'chat')])
  local.resolve()
  await first
  assert.equal(vm.getSnapshot().pending.size, 1)
  remote.resolve()
  await other
  await vm.openWorkspace('remote', 'project')
  await vm.pinSession('local', 'chat', true)
  assert.deepEqual(calls.slice(2), [['workspace', 'remote', 'project'], ['pin', 'local', 'chat', true]])
  assert.equal(vm.getSnapshot().pending.size, 0)
})

test('native active-work archive refusal requires a separate confirmed stop operation', async () => {
  const calls: unknown[][] = []
  const vm = new WorkspaceBrowserViewModel(model({
    onArchiveSession(...args) {
      calls.push(args)
      if (!args[3]?.stopActivity) throw Object.assign(new Error('private diagnostic'), { code: 'SESSION_ACTIVE' })
    },
  }))
  const key = workspaceRowKey('remote', 'session', 'chat')
  await vm.archiveSession('remote', 'chat', true)
  assert.equal(vm.getSnapshot().archiving, key)
  assert.equal(vm.getSnapshot().error, undefined)
  assert.deepEqual(calls, [['remote', 'chat', true]], 'a refusal must never auto-replay with stopActivity')
  vm.confirmArchive(undefined)
  assert.equal(vm.getSnapshot().archiving, undefined)
  assert.equal(calls.length, 1, 'cancelling leaves the native session untouched')
  vm.confirmArchive(key)
  await vm.archiveSession('remote', 'chat', true, { stopActivity: true })
  assert.deepEqual(calls[1], ['remote', 'chat', true, { stopActivity: true }])
  assert.equal(vm.getSnapshot().archiving, undefined)
})

test('offline records can reconnect through navigation, while mutations and archived opens validate the current owner', async () => {
  const calls: unknown[][] = []
  const data = catalog(['chat', 'archived'])
  data.archivedSessionIds = ['archived']
  const vm = new WorkspaceBrowserViewModel(model({
    sources: [source('remote', { phase: 'disconnected', catalog: data })],
    onOpenSession: (...args) => { calls.push(['session', ...args]) },
    onOpenWorkspace: (...args) => { calls.push(['workspace', ...args]) },
    onNewSession: (...args) => { calls.push(['new', ...args]) },
    onRenameSession: (...args) => { calls.push(['rename', ...args]) },
    onPinSession: (...args) => { calls.push(['pin', ...args]) },
    onArchiveSession: (...args) => { calls.push(['archive', ...args]) },
    onForgetWorkspace: (...args) => { calls.push(['forget', ...args]) },
  }))
  await vm.openSession('remote', 'chat')
  await vm.openWorkspace('remote', 'project')
  await vm.openSession('remote', 'archived')
  await vm.openSession('local', 'chat')
  await vm.openWorkspace('remote', 'missing')
  await vm.newSession('remote', 'project')
  await vm.renameSession('remote', 'chat', 'Changed')
  await vm.pinSession('remote', 'chat', true)
  await vm.archiveSession('remote', 'chat', true)
  await vm.forgetWorkspace('remote', 'project')
  vm.edit(workspaceRowKey('remote', 'session', 'chat'))
  assert.equal(vm.getSnapshot().editing, undefined)
  assert.deepEqual(calls, [['session', 'remote', 'chat'], ['workspace', 'remote', 'project']])
})

test('failed rename keeps the editor available for retry and closes only after a successful save', async () => {
  const failure = new Error('Host rejected the title')
  const titles: string[] = []
  const vm = new WorkspaceBrowserViewModel(model({
    onRenameSession: (_source, _id, title) => { titles.push(title); if (titles.length === 1) throw failure },
  }))
  const key = workspaceRowKey('remote', 'session', 'chat')
  vm.edit(key)
  await vm.renameSession('remote', 'chat', '  First draft  ')
  assert.equal(vm.getSnapshot().editing, key)
  assert.equal(vm.getSnapshot().error, failure)
  assert.equal(vm.getSnapshot().pending.size, 0)
  await vm.renameSession('remote', 'chat', ' Revised draft ')
  assert.deepEqual(titles, ['First draft', 'Revised draft'])
  assert.equal(vm.getSnapshot().editing, undefined)
  assert.equal(vm.getSnapshot().error, undefined)
})

test('completion of a previous edit or removal does not close a newly opened interaction on the same row', async () => {
  const rename = deferred()
  const forget = deferred()
  const vm = new WorkspaceBrowserViewModel(model({ onRenameSession: () => rename.promise, onForgetWorkspace: () => forget.promise }))
  const chat = workspaceRowKey('remote', 'session', 'chat')
  const project = workspaceRowKey('remote', 'workspace', 'project')
  vm.edit(chat)
  const saving = vm.renameSession('remote', 'chat', 'Old draft')
  vm.edit(undefined)
  vm.edit(chat)
  vm.confirmForget(project)
  const removing = vm.forgetWorkspace('remote', 'project')
  vm.confirmForget(undefined)
  vm.confirmForget(project)
  rename.resolve()
  forget.resolve()
  await Promise.all([saving, removing])
  assert.equal(vm.getSnapshot().editing, chat)
  assert.equal(vm.getSnapshot().forgetting, project)
})

test('older failures cannot replace a newer error or restore an error after dismissal', async () => {
  const first = deferred()
  const second = deferred()
  const third = deferred()
  const fourth = deferred()
  let localCalls = 0
  const vm = new WorkspaceBrowserViewModel(model({
    onRenameSession: sourceId => sourceId === 'remote' ? second.promise : [first, third, fourth][localCalls++].promise,
  }))
  const older = vm.renameSession('local', 'chat', 'Old')
  const newer = vm.renameSession('remote', 'chat', 'New')
  const currentError = new Error('Current failure')
  second.reject(currentError)
  await newer
  first.reject(new Error('Obsolete failure'))
  await older
  assert.equal(vm.getSnapshot().error, currentError)
  const dismissed = vm.renameSession('local', 'chat', 'Again')
  vm.dismissError()
  third.reject(new Error('Dismissed failure'))
  await dismissed
  assert.equal(vm.getSnapshot().error, undefined)
  const stillRelevant = vm.renameSession('local', 'chat', 'Pending save')
  await vm.openSession('remote', 'chat')
  const saveError = new Error('Save failed after navigation')
  fourth.reject(saveError)
  await stillRelevant
  assert.equal(vm.getSnapshot().error, saveError, 'successful navigation elsewhere must not silently discard a save failure')
})

test('removing a target invalidates pending commands even when its native IDs later reappear', async () => {
  const old = deferred()
  const fresh = deferred()
  let attempts = 0
  const initial = model({ onRenameSession: () => (++attempts === 1 ? old : fresh).promise })
  const vm = new WorkspaceBrowserViewModel(initial)
  const key = workspaceRowKey('remote', 'session', 'chat')
  vm.edit(key)
  vm.confirmForget(workspaceRowKey('remote', 'workspace', 'project'))
  const stale = vm.renameSession('remote', 'chat', 'Old')
  vm.update({ ...initial, sources: [initial.sources[0]] })
  assert.equal(vm.getSnapshot().editing, undefined)
  assert.equal(vm.getSnapshot().forgetting, undefined)
  assert.equal(vm.getSnapshot().pending.size, 0)
  vm.update(initial)
  vm.edit(key)
  const current = vm.renameSession('remote', 'chat', 'New')
  old.reject(new Error('Removed source failure'))
  await stale
  assert.equal(vm.getSnapshot().error, undefined)
  assert.equal(vm.getSnapshot().editing, key)
  assert.ok(vm.getSnapshot().pending.has(key))
  fresh.resolve()
  await current
  assert.equal(vm.getSnapshot().editing, undefined)
})

test('callback-only updates keep a stable snapshot, and mount replay cannot revive disposed work', async () => {
  const stale = deferred()
  const initial = model({ onAddWorkspace: () => stale.promise })
  const vm = new WorkspaceBrowserViewModel(initial)
  const snapshot = vm.getSnapshot()
  let notifications = 0
  let currentCalls = 0
  vm.subscribe(() => { notifications++ })
  const updated = { ...initial, sources: initial.sources.map(source => ({ ...source })), selected: undefined, onReconnect: () => { currentCalls++ } }
  vm.update(updated)
  assert.equal(vm.getSnapshot(), snapshot)
  assert.equal(notifications, 0)
  await vm.reconnect('remote')
  assert.equal(currentCalls, 1)
  const old = vm.addWorkspace()
  vm.dispose()
  vm.activate()
  let mountedNotifications = 0
  vm.subscribe(() => { mountedNotifications++ })
  stale.reject(new Error('Previous mount failure'))
  await old
  assert.equal(vm.getSnapshot().error, undefined)
  assert.equal(vm.getSnapshot().pending.size, 0)
  assert.equal(mountedNotifications, 0)
  await vm.reconnect('remote')
  assert.equal(currentCalls, 2)
  assert.ok(mountedNotifications > 0)
})

test('late selection expands its parent while temporary search preserves collapse preferences and resets paging', () => {
  const ids = Array.from({ length: 150 }, (_, index) => `chat-${index}`)
  const initial = model({ sources: [source('remote', { catalog: catalog(ids) })], selected: { sourceId: 'remote', sessionId: 'later' } })
  const vm = new WorkspaceBrowserViewModel(initial)
  const project = workspaceRowKey('remote', 'workspace', 'project')
  vm.toggleWorkspace(project)
  assert.ok(vm.getSnapshot().collapsed.has(project))
  const arrived = { ...initial, sources: [source('remote', { catalog: catalog([...ids, 'later']) })] }
  vm.update(arrived)
  assert.ok(!vm.getSnapshot().collapsed.has(project))
  assert.equal(vm.getSnapshot().rows[0].workspaces[0].sessions.at(-1)?.session.id, 'later')
  vm.showMore()
  assert.equal(vm.getSnapshot().hiddenCount, 0)
  vm.toggleWorkspace(project)
  vm.update({ ...arrived, sources: arrived.sources.map(source => ({ ...source })) })
  assert.ok(vm.getSnapshot().collapsed.has(project), 'ordinary catalog refresh must not undo an explicit collapse')
  vm.setSearchOpen(true)
  vm.setQuery('chat-149')
  assert.equal(vm.getSnapshot().collapsed.size, 0)
  assert.deepEqual(vm.getSnapshot().rows[0].workspaces[0].sessions.map(row => row.session.id), ['chat-149'])
  vm.toggleWorkspace(project)
  assert.ok(vm.getSnapshot().collapsed.has(project), 'search results still support explicit collapse')
  assert.equal(vm.getSnapshot().rows[0].workspaces[0].sessions.length, 0)
  vm.toggleWorkspace(project)
  assert.ok(!vm.getSnapshot().collapsed.has(project))
  vm.setSearchOpen(false)
  assert.equal(vm.getSnapshot().query, '')
  assert.ok(vm.getSnapshot().collapsed.has(project))
  vm.toggleWorkspace(project)
  assert.ok(vm.getSnapshot().hiddenCount > 0, 'clearing a search resets the mounted-row budget')
})
