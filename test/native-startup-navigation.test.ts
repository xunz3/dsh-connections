import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { getEventListeners } from 'node:events'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import * as Cordis from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import * as nativeStores from '@deepseek-ai/dsh-client-store'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { createSnapshotStore } from '../src/client/snapshot-store.js'
import { createNavigationTransaction, waitForNativeStartup, watchNativeNavigation } from '../src/client/native-shell-routing.js'
import { WorkspaceController } from '../src/client/workspace-controller.js'
import { CONNECTION_CONTRACTS } from '../src/shared/contracts.js'
import { WORKSPACE_PROTOCOL, type WorkspaceRequest, type WorkspaceResultMap } from '../src/shared/workspace-protocol.js'

// Execute the complete published rc.5 factory. The class is not a public export;
// this one dev-only assignment exposes it without replacing/extracting any of
// its methods. Visual components are never rendered in this service regression.
interface NativeWorkspace {
  selection: { getSnapshot(): { sessionId?: string }; set(value: { sessionId?: string }): void }
  startSession(workspaceId?: string): void
}
type NativeConstructor = new (ctx: Cordis.Context, picker: unknown, workspaces: unknown, sessions: unknown, view: unknown, notify: (value: unknown) => void) => NativeWorkspace
const require = createRequire(import.meta.url)
const nativeSource = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-workspace/client'), 'utf8')
const exportPoint = '\t\texports.apply = apply;'
assert.equal(nativeSource.split(exportPoint).length, 2, 'the dev exposure must match one published factory export boundary')
const exposed = nativeSource.replace(exportPoint, '\t\texports.qaUiWorkspaceService = UiWorkspaceService;\n' + exportPoint)
let NativeUiWorkspace!: NativeConstructor
const modules: Record<string, unknown> = {
  '@deepseek-ai/cordis': Cordis, '@deepseek-ai/dsh-client-store': nativeStores,
  '@deepseek-ai/dsh-client-ui-primitives': {}, react: React, 'react/jsx-runtime': jsx,
}
runInNewContext(exposed, {
  AbortController, AbortSignal, console,
  window: { __ModuleLoader__: { load(registration: { factory(require: (name: string) => unknown): { qaUiWorkspaceService: NativeConstructor } }) {
    NativeUiWorkspace = registration.factory(name => {
      assert.ok(name in modules, `unexpected published dependency: ${name}`)
      return modules[name]
    }).qaUiWorkspaceService
  } } },
})
assert.equal(typeof NativeUiWorkspace, 'function')

const settled = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const localBlank = 'local-blank'
const localWorkspace = 'local-project'
const remoteId = 'connection-11111111-1111-4111-a111-111111111111'
const savedKey = '@xunz/dsh-connections/selection'

function fixture(deferRemote = false) {
  const ctx = new Cordis.Context()
  const current = createSnapshotStore<{ readonly key: string | undefined }>({ key: undefined })
  const panels = createSnapshotStore<{ activePanelId: string | null }>({ activePanelId: 'connections.workspace' })
  const records: string[] = [], nativeCreates: unknown[] = [], nativeRetains: string[] = [], nativeReleases: string[] = []
  const warnings: unknown[] = []
  let navigation = new AbortController(), begins = 0, selections = 0, currentPublications = 0
  const layout = {
    panelInfo: panels,
    beginNavigation() { begins++; records.push('begin'); navigation.abort(); navigation = new AbortController(); return navigation.signal },
    selectPanel(activePanelId: string | null) {
      selections++; records.push(`panel:${activePanelId}`); navigation.abort()
      if (panels.getSnapshot().activePanelId !== activePanelId) panels.set({ activePanelId })
    },
  }
  ctx.provide('layout', layout as never)
  ctx.provide('locale', { bind: () => () => 'Native create failed' } as never)
  const workspaces = createSnapshotStore({ phase: 'loading', items: [{ workspaceId: localWorkspace, path: '/local', sessionIds: [localBlank] }], archivedSessionIds: [] as string[], pinnedSessionIds: [] as string[] })
  const sessions = createSnapshotStore({ phase: 'loading', ids: [localBlank], byId: {
    [localBlank]: { id: localBlank, blank: true, cwd: '/local', updatedAt: 1, projectionValues: {} },
  } })
  const nativeGate = deferred<void>()
  const native = new NativeUiWorkspace(ctx, {}, { list: workspaces }, {
    list: sessions,
    async refreshProjections(id: string) { records.push(`projections:${id}`); await nativeGate.promise },
    async create(request: unknown) { nativeCreates.push(structuredClone(request)); return localBlank },
    retain(id: string) {
      nativeRetains.push(id); records.push(`retain:${id}`)
      if (current.getSnapshot().key !== id) { currentPublications++; current.set({ key: id }) }
      return { sessionId: id, release() { nativeReleases.push(id) } }
    },
    subagentAddress: () => undefined,
  }, {}, value => warnings.push(value))
  native.selection.set({ sessionId: localBlank })

  const storage = new Map<string, string>([[savedKey, JSON.stringify({ sourceId: remoteId, sessionId: 'remote-chat' })]])
  const removed: string[] = []
  const remoteGate = deferred<void>()
  if (!deferRemote) remoteGate.resolve()
  const row = { id: remoteId, name: 'SSH', target: 'dev', mode: 'managed' as const, phase: 'connected' as const, localPort: 43188, transportId: crypto.randomUUID() }
  let revision = 0, opens = 0, closed = 0
  const controller = new WorkspaceController({
    async list() { return [{ ...row }] }, async connect() { return { ...row } }, async reconnect() { return { ...row } },
    async open() { opens++; return { url: 'http://127.0.0.1:43188/?token=startup-fixture-private-value' } },
    async workspace<R extends WorkspaceRequest>(_id: string, request: R): Promise<WorkspaceResultMap[R['op']]> {
      let result: unknown
      if (request.op === 'catalog') {
        await remoteGate.promise
        result = { protocol: WORKSPACE_PROTOCOL, revision: 'b'.repeat(43), workspaces: [], sessions: [], archivedSessionIds: [], pinnedSessionIds: [] }
      } else if (request.op === 'openView') result = { protocol: WORKSPACE_PROTOCOL, contracts: { ...CONNECTION_CONTRACTS }, channel: 'a'.repeat(43), revision: 0, reportedRevision: 0, presentedRevision: 0 }
      else if (request.op === 'navigate') result = { revision: ++revision, reportedRevision: revision, presentedRevision: revision }
      else if (request.op === 'viewState') result = { revision, reportedRevision: revision, presentedRevision: revision }
      else if (request.op === 'closeView') result = { closed: true }
      else throw new Error(`Unexpected fixture request ${request.op}`)
      return result as WorkspaceResultMap[R['op']]
    },
  }, { catalogs: false, storage: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) },
    removeItem(key) { removed.push(key); storage.delete(key) },
  } })
  // The production workspace face also samples passive native selection changes.
  const offCurrent = current.subscribe(() => controller.localSelection(current.getSnapshot().key))
  const transaction = createNavigationTransaction()
  const source = {
    getSnapshot: controller.hasNavigationIntent,
    subscribe: controller.subscribe,
    close() { closed++; controller.close() },
  }
  let stop: (() => void) | undefined
  return {
    native, current, panels, layout, transaction, workspaces, records, nativeCreates, nativeRetains, nativeReleases, warnings, controller, storage, removed,
    get begins() { return begins }, get selections() { return selections }, get opens() { return opens }, get closed() { return closed },
    get currentPublications() { return currentPublications },
    nativeReady() { workspaces.set({ ...workspaces.getSnapshot(), phase: 'ready' }); sessions.set({ ...sessions.getSnapshot(), phase: 'ready' }) },
    completeNative() { nativeGate.resolve() }, completeRemote() { remoteGate.resolve() },
    mount() {
      stop = watchNativeNavigation(layout, source, transaction, current)
      return () => { stop?.(); stop = undefined }
    },
    async dispose() {
      stop?.(); offCurrent(); controller.dispose(); nativeGate.resolve(); remoteGate.resolve(); await settled(); await ctx.fiber.dispose()
    },
  }
}

for (const deferRemote of [false, true]) {
  test(`public first-main readiness preserves ${deferRemote ? 'pending' : 'already-open'} remote restoration through actual native blank startup`, async t => {
    const f = fixture(deferRemote)
    t.after(() => f.dispose())
    const restoring = f.controller.restore()
    await settled()
    assert.equal(f.controller.hasNavigationIntent(), true)
    assert.equal(f.controller.getSnapshot()?.phase, deferRemote ? undefined : 'ready')
    f.mount()
    assert.equal(f.begins, 0, 'the guard must not supersede native startup before a first main binding exists')
    f.nativeReady()
    assert.equal(f.begins, 1, 'the published UiWorkspaceService starts its own navigation')
    assert.equal(f.closed, 0)
    f.completeNative(); await settled()
    assert.equal(f.current.getSnapshot().key, localBlank)
    assert.equal(f.nativeReleases.length, 0, 'inline arming during retain would abort replaceMain and release this reference')
    assert.equal(f.native.selection.getSnapshot().sessionId, localBlank)
    assert.equal(f.begins, 2, 'the guard arms at the end of the native commit, not before its signal checks')
    assert.equal(f.selections, 0, 'native automatic restoration uses preserve, never selectPanel(null)')
    assert.equal(f.panels.getSnapshot().activePanelId, 'connections.workspace')
    assert.equal(f.storage.has(savedKey), true)
    f.completeRemote(); await restoring; await settled()
    assert.equal(f.controller.getSnapshot()?.phase, 'ready')
    assert.equal(f.controller.getCatalogs().selected.sourceId, remoteId)
    assert.equal(f.closed, 0)
    assert.deepEqual(JSON.parse(f.storage.get(savedKey)!), { sourceId: remoteId, sessionId: 'remote-chat' })
    assert.deepEqual(f.nativeCreates, [{ workspaceId: localWorkspace, sessionId: localBlank }])
  })
}

test('after first-main readiness, published explicit startSession still closes remote immediately when the same blank is reused', async t => {
  const f = fixture()
  t.after(() => f.dispose())
  await f.controller.restore(); await settled()
  f.mount(); f.nativeReady(); f.completeNative(); await settled()
  assert.equal(f.closed, 0)
  const publications = f.currentPublications, selections = f.selections
  f.native.startSession(localWorkspace)
  assert.equal(f.closed, 1, 'explicit New Session closes on beginNavigation, before asynchronous blank creation or panel reveal')
  assert.equal(f.selections, selections)
  assert.equal(f.storage.has(savedKey), false)
  await settled()
  assert.equal(f.currentPublications, publications, 'blank reuse does not need another adapter.current publication')
  assert.equal(f.current.getSnapshot().key, localBlank)
  assert.equal(f.selections, selections + 1, 'the native explicit action still owns its normal reveal')
  assert.equal(f.nativeCreates.length, 2)
})

test('the readiness latch survives a later undefined frame and an already-ready source retains immediate guard behavior', async t => {
  const f = fixture()
  t.after(() => f.dispose())
  await f.controller.restore(); await settled()
  f.nativeReady(); f.completeNative(); await settled()
  const before = f.begins
  f.mount()
  assert.equal(f.begins, before + 1, 'a source with an existing key arms synchronously as before')
  f.current.set({ key: undefined })
  f.native.startSession(localWorkspace)
  assert.equal(f.closed, 1, 'a transient undefined frame cannot turn the startup gate back on')
})

for (const order of ['remote-first', 'native-first'] as const) {
  test(`lazy public startup gate serializes the automatic panel commit for ${order} without cancelling published native blank restoration`, async t => {
    const f = fixture(true), lifetime = new AbortController()
    t.after(() => { lifetime.abort(); return f.dispose() })
    let panelsCommitted = 0, commitsWithoutMain = 0
    // Model the retained shell's public panel response. The actual production
    // controller, readiness gate, guard, and native navigation class stay intact.
    const offPanel = f.controller.subscribe(() => {
      if (!f.controller.getSnapshot() || panelsCommitted !== 0) return
      panelsCommitted++
      if (f.current.getSnapshot().key === undefined) commitsWithoutMain++
      f.transaction.run(() => { f.layout.beginNavigation(); f.layout.selectPanel('connections.workspace') })
    })
    t.after(offPanel)
    const restoring = f.controller.restore(() => waitForNativeStartup(f.current, f.workspaces, lifetime.signal))
    f.mount()
    f.nativeReady()
    await settled()
    assert.equal(f.begins, 1)
    assert.equal(f.current.getSnapshot().key, undefined)
    assert.equal(f.opens, 0)
    if (order === 'remote-first') {
      f.completeRemote(); await settled()
      assert.equal(f.controller.getCatalogs().sources[1].phase, 'connected', 'the remote catalog really settled first')
      assert.equal(f.controller.getSnapshot(), undefined)
      assert.equal(f.controller.hasNavigationIntent(), true)
      assert.equal(f.opens, 0, 'a completed remote catalog must not allocate/open a view before native main commit')
      assert.equal(panelsCommitted, 0)
      assert.equal(f.begins, 1, 'the retained shell must not abort the still-pending native signal')
      f.completeNative()
    } else {
      f.completeNative(); await settled()
      assert.equal(f.current.getSnapshot().key, localBlank)
      assert.equal(f.opens, 0, 'native completion alone does not bypass the still-pending remote catalog')
      assert.equal(panelsCommitted, 0)
      f.completeRemote()
    }
    await restoring; await settled()
    assert.equal(f.current.getSnapshot().key, localBlank)
    assert.equal(f.nativeCreates.length, 1)
    assert.equal(f.nativeRetains.length, 1)
    assert.equal(f.nativeReleases.length, 0, 'the original native startup completed rather than being aborted by the panel switch')
    assert.equal(f.controller.getSnapshot()?.phase, 'ready')
    assert.equal(f.opens, 1)
    assert.equal(panelsCommitted, 1)
    assert.equal(commitsWithoutMain, 0)
    assert.equal(f.closed, 0)
    assert.equal(f.storage.has(savedKey), true)
  })
}

function tracked<T>(initial: T) {
  const store = createSnapshotStore(initial)
  let subscribers = 0
  return { ...store,
    get subscribers() { return subscribers },
    subscribe(listener: () => void) {
      subscribers++
      const off = store.subscribe(listener)
      let active = true
      return () => { if (active) { active = false; subscribers--; off() } }
    },
  }
}

test('an empty ready native baseline resolves after microtask recheck and releases all readiness ownership', async () => {
  const current = tracked<{ key: string | undefined }>({ key: undefined })
  const workspaces = tracked({ phase: 'loading', items: [] as unknown[] }), lifetime = new AbortController()
  let done = false
  const waiting = waitForNativeStartup(current, workspaces, lifetime.signal).then(() => { done = true })
  assert.equal(current.subscribers, 1); assert.equal(workspaces.subscribers, 1)
  assert.equal(getEventListeners(lifetime.signal, 'abort').length, 1)
  workspaces.set({ phase: 'ready', items: [] })
  assert.equal(done, false)
  await waiting
  assert.equal(done, true)
  assert.equal(current.subscribers, 0); assert.equal(workspaces.subscribers, 0)
  assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0)
})

test('a same-tick ready-empty sample revoked by real workspace rows cannot release the startup barrier', async () => {
  const current = tracked<{ key: string | undefined }>({ key: undefined })
  const workspaces = tracked({ phase: 'ready', items: [] as unknown[] }), lifetime = new AbortController()
  let done = false
  const waiting = waitForNativeStartup(current, workspaces, lifetime.signal).then(() => { done = true })
  workspaces.set({ phase: 'ready', items: [{ workspaceId: localWorkspace }] })
  await settled()
  assert.equal(done, false)
  assert.equal(current.subscribers, 1)
  current.set({ key: localBlank })
  await waiting
  assert.equal(current.subscribers, 0); assert.equal(workspaces.subscribers, 0)
})

test('aborting before or during a queued first-main commit rejects and clears sources, timer, and abort listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const preAborted of [false, true]) {
    const current = tracked<{ key: string | undefined }>({ key: undefined })
    const workspaces = tracked({ phase: 'ready', items: [{ workspaceId: localWorkspace }] }), lifetime = new AbortController()
    if (preAborted) lifetime.abort()
    const waiting = assert.rejects(waitForNativeStartup(current, workspaces, lifetime.signal), { name: 'AbortError' })
    if (!preAborted) { current.set({ key: localBlank }); lifetime.abort() }
    await waiting
    assert.equal(current.subscribers, 0); assert.equal(workspaces.subscribers, 0)
    assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0)
    t.mock.timers.tick(30_000)
    await settled()
  }
})

test('a stalled nonempty native startup releases the controller only at the documented 30-second fallback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(), lifetime = new AbortController()
  t.after(() => { lifetime.abort(); return f.dispose() })
  const restoring = f.controller.restore(() => waitForNativeStartup(f.current, f.workspaces, lifetime.signal))
  await settled()
  assert.equal(f.opens, 0)
  assert.equal(f.controller.getSnapshot(), undefined)
  assert.equal(f.controller.hasNavigationIntent(), true)
  t.mock.timers.tick(29_999); await settled()
  assert.equal(f.opens, 0)
  t.mock.timers.tick(1)
  await restoring; await settled()
  assert.equal(f.opens, 1)
  assert.equal(f.controller.getSnapshot()?.phase, 'ready')
  assert.equal(f.current.getSnapshot().key, undefined, 'the fallback does not claim that native startup succeeded')
  assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0)
})

test('restore never creates a startup promise for an absent or invalid saved remote preference', async t => {
  const f = fixture()
  t.after(() => f.dispose())
  for (const saved of [undefined, '{not-json', JSON.stringify({ sourceId: 'invalid' })]) {
    if (saved === undefined) f.storage.delete(savedKey)
    else f.storage.set(savedKey, saved)
    let called = 0
    await f.controller.restore(() => { called++; return new Promise<void>(() => {}) })
    assert.equal(called, 0, 'a lazy source must not create an unobserved timer or abortable promise')
  }
  assert.equal(f.opens, 0)
})

test('disposing after the first-key notification withdraws a queued arm before it can abort the native commit', async t => {
  const f = fixture()
  t.after(() => f.dispose())
  await f.controller.restore(); await settled()
  const stop = f.mount()
  const off = f.current.subscribe(() => { if (f.current.getSnapshot().key !== undefined) stop() })
  t.after(off)
  f.nativeReady(); f.completeNative(); await settled()
  assert.equal(f.begins, 1, 'only native startup began navigation; the disposed queued callback is inert')
  assert.equal(f.closed, 0)
  assert.equal(f.nativeReleases.length, 0)
  assert.equal(f.storage.has(savedKey), true)
})
