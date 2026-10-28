import { WORKSPACE_PROTOCOL } from '../src/shared/workspace-protocol.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { buildSync } from 'esbuild'
import { WorkspaceController, viewClientId } from '../src/client/workspace-controller.js'
import { workspaceUrl } from '../src/client/workspace-surface.js'
import type { ConnectionView } from '../src/shared/types.js'
import type { WorkspaceCatalogPage, WorkspaceRequest, WorkspaceResult, WorkspaceResultMap, WorkspaceViewState } from '../src/shared/workspace-protocol.js'

const first = 'connection-11111111-1111-4111-a111-111111111111'
const second = 'connection-22222222-2222-4222-a222-222222222222'
const token = 'workspace-private-test-credential'
const address = (port = 43188) => `http://127.0.0.1:${port}/?token=${token}`
const savedKey = '@xunz/dsh-connections/selection'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const nextTick = () => new Promise<void>(resolve => setImmediate(resolve))
const catalog = (): WorkspaceCatalogPage => ({
  protocol: WORKSPACE_PROTOCOL, revision: 'a'.repeat(43),
  workspaces: [{ id: 'project', path: '/project', title: 'Project', sessionIds: ['chat'] }],
  sessions: [{ id: 'chat', title: 'Chat', blank: false, running: false, updatedAt: 0 }], archivedSessionIds: [], pinnedSessionIds: [],
})
function fixture() {
  let rows: ConnectionView[] = [{ id: first, name: 'First', target: 'first', phase: 'disconnected', remotePort: 3000 }]
  let connects = 0, reconnects = 0, opens = 0, channels = 0
  const calls: { id: string; request: WorkspaceRequest }[] = []
  const views = new Map<string, WorkspaceViewState>()
  const saved = new Map<string, string>()
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value) }, removeItem: (key: string) => { saved.delete(key) } }
  const f = {
    async respond(_id: string, request: WorkspaceRequest): Promise<WorkspaceResult> {
      switch (request.op) {
        case 'catalog': return catalog()
        case 'openView': {
          const channel = String(++channels).padStart(43, 'a')
          const view = { protocol: WORKSPACE_PROTOCOL, channel, revision: 0, presentedRevision: 0, reportedRevision: 0 }; views.set(channel, view); return view
        }
        case 'navigate': {
          const current = views.get(request.channel)!
          const view = { ...current, revision: current.revision + 1, intent: { revision: current.revision + 1, requestId: request.requestId, target: request.target } }
          views.set(request.channel, view); return view
        }
        case 'viewState': return { ...views.get(request.channel)! }
        case 'closeView': views.delete(request.channel); return { closed: true }
        default: return { done: true }
      }
    },
    api: {
      async reconnect(id: string) { reconnects++; return f.api.connect(id) },
      async list() { return structuredClone(rows) },
      async connect(id: string) { connects++; const row = rows.find(row => row.id === id)!; row.phase = 'connected'; row.localPort = id === first ? 43188 : 43189; return structuredClone(row) },
      async open(id: string) { opens++; return { url: address(rows.find(row => row.id === id)?.localPort) } },
      async workspace<R extends WorkspaceRequest>(id: string, request: R): Promise<WorkspaceResultMap[R['op']]> {
        calls.push({ id, request: structuredClone(request) }); return await f.respond(id, request) as WorkspaceResultMap[R['op']]
      },
    },
    storage, saved, calls, views,
    get rows() { return rows }, set rows(value) { rows = value },
    get connects() { return connects }, get reconnects() { return reconnects }, get opens() { return opens }, get channels() { return channels },
  }
  return f
}

test('native navigation is scoped by connection and persists only IDs, never view credentials', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api, { storage: f.storage })
  await controller.open(first, { kind: 'session', id: 'chat' }); await controller.refresh()
  assert.equal(controller.getSnapshot()?.phase, 'ready')
  assert.equal(f.connects, 1); assert.equal(f.opens, 1)
  assert.ok(controller.getSnapshot()?.url?.includes('#connections-view='))
  assert.deepEqual(JSON.parse(f.saved.get(savedKey)!), { sourceId: first, sessionId: 'chat' })
  assert.ok(!JSON.stringify([...f.saved]).includes(token))
  assert.ok(!JSON.stringify([...f.saved]).includes(controller.getSnapshot()!.channel!))
  controller.close()
  assert.equal(controller.getSnapshot(), undefined); assert.equal(f.saved.size, 0); assert.equal(f.views.size, 0)
  assert.equal(f.rows[0].phase, 'connected', 'returning local leaves remote work alive')
  controller.dispose()
})

test('closing a view aborts its local surface even when remote lease cleanup fails', async t => {
  const f = fixture(), respond = f.respond, entered = deferred<void>(), completing = deferred<void>()
  let operationSignal: AbortSignal | undefined
  f.respond = async (id, request) => {
    if (request.op === 'syncSurface') return { requests: [{ id: 'login-request', revision: 1, action: { kind: 'copyLogin', url: 'https://example.com/login' } }] }
    if (request.op === 'requestSurface') return { status: 'pending' }
    if (request.op === 'closeView') throw new Error('Transport temporarily unavailable')
    return respond(id, request)
  }
  const controller = new WorkspaceController(f.api, { catalogs: false, surface: {
    getPresentation: () => ({ locale: 'en', tokens: {}, theme: {
      preference: 'light', fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
      textFontFamily: '', codeFontFamily: '', terminalFontFamily: '',
    }, general: { transcriptView: 'standard', collapseTiming: 'completion', performanceUsage: 'detailed', linkOpening: 'sidebar', busyEnter: 'queue', developerTools: false } }),
    async perform(_action, signal) { operationSignal = signal; entered.resolve(); await completing.promise },
  } })
  t.after(() => { completing.resolve(); controller.dispose() })
  await controller.open(first, { kind: 'settings' })
  await entered.promise
  assert.equal(operationSignal?.aborted, false)
  controller.close()
  assert.equal(operationSignal?.aborted, true, 'local capabilities are revoked synchronously without waiting for remote cleanup')
  completing.resolve()
  await nextTick()
  assert.equal(f.calls.filter(call => call.request.op === 'syncSurface').length, 1, 'the closed lease is not kept alive by presentation polling')
})

test('same-host navigation reuses the content document while equal IDs on another host use a new view', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api)
  f.rows.push({ ...f.rows[0], id: second, target: 'second' })
  await controller.open(first, { kind: 'session', id: 'chat' }); const url = controller.getSnapshot()!.url
  await controller.open(first, { kind: 'session', id: 'another' })
  assert.equal(controller.getSnapshot()!.url, url); assert.equal(f.channels, 1); assert.equal(f.opens, 1)
  await controller.open(second, { kind: 'session', id: 'chat' })
  assert.equal(controller.getCatalogs().selected.sourceId, second); assert.equal(f.channels, 2); assert.equal(f.views.size, 1)
  assert.deepEqual(f.calls.filter(call => call.request.op === 'navigate').map(call => call.id), [first, first, second])
  controller.dispose()
})

test('native plugin management reuses its host document and preserves the selected conversation', async t => {
  const f = fixture(), controller = new WorkspaceController(f.api, { catalogs: false })
  t.after(() => controller.dispose())
  await controller.open(first, { kind: 'session', id: 'chat' })
  const { channel, url } = controller.getSnapshot()!
  const selection = controller.getCatalogs().selected
  await controller.open(first, { kind: 'plugins' })
  assert.equal(controller.getSnapshot()!.channel, channel)
  assert.equal(controller.getSnapshot()!.url, url)
  assert.equal(controller.getCatalogs().selected, selection)
  assert.equal(f.channels, 1)
  assert.equal(f.opens, 1)
  const pending = f.views.get(channel!)!
  f.views.set(channel!, { ...pending, reportedRevision: pending.revision, presentedRevision: pending.revision })
  await controller.check()
  assert.equal(controller.getSnapshot()?.presented, true)
  assert.equal(controller.getCatalogs().selected, selection)
  await controller.reconnect(first)
  const navigation = f.calls.filter(call => call.request.op === 'navigate').at(-1)?.request
  assert.equal(navigation?.op, 'navigate')
  assert.deepEqual(navigation?.target, { kind: 'plugins' })
})

test('missing native plugin management retains the guest and allows same-document recovery', async t => {
  const f = fixture(), controller = new WorkspaceController(f.api, { catalogs: false })
  t.after(() => controller.dispose())
  await controller.open(first, { kind: 'session', id: 'chat' })
  const { channel, url } = controller.getSnapshot()!
  await controller.open(first, { kind: 'plugins' })
  const pending = f.views.get(channel!)!
  f.views.set(channel!, { ...pending, reportedRevision: pending.revision, presentedRevision: pending.revision, error: 'NAVIGATION_FAILED' })
  await controller.check()
  assert.equal(controller.getSnapshot()?.phase, 'ready', 'the remote notice must not destroy an unsent native draft')
  assert.equal(controller.getSnapshot()?.presented, true)
  assert.equal(controller.getSnapshot()?.url, url)
  assert.equal(f.calls.some(call => call.request.op === 'closeView'), false)
  await controller.open(first, { kind: 'session', id: 'chat' })
  assert.equal(controller.getSnapshot()?.channel, channel)
  assert.equal(f.channels, 1)
})

test('a late allocated view is released after returning local or switching computers', async () => {
  for (const switchComputer of [false, true]) {
    const f = fixture(), controller = new WorkspaceController(f.api), waiting = deferred<WorkspaceResult>(), respond = f.respond
    f.rows.push({ ...f.rows[0], id: second, target: 'second' })
    let late: WorkspaceResult | undefined
    f.respond = async (id, request) => { if (id === first && request.op === 'openView') { late = await respond(id, request); return waiting.promise } return respond(id, request) }
    const opening = controller.open(first, { kind: 'session', id: 'chat' }); await nextTick()
    if (switchComputer) await controller.open(second, { kind: 'session', id: 'chat' }); else controller.close()
    waiting.resolve(late!); await opening
    assert.equal(controller.getSnapshot()?.id, switchComputer ? second : undefined); assert.equal(f.views.size, switchComputer ? 1 : 0)
    controller.dispose()
  }
})

test('a newly allocated replacement tunnel view is released when navigation becomes stale', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api)
  await controller.open(first, { kind: 'session', id: 'chat' }); await controller.refresh()
  f.rows[0].localPort = 43200
  const waiting = deferred<WorkspaceResult>(), respond = f.respond
  f.respond = async (id, request) => request.op === 'navigate' ? waiting.promise : respond(id, request)
  const opening = controller.open(first, { kind: 'session', id: 'next' }); await nextTick()
  assert.equal(f.channels, 2)
  controller.close(); waiting.resolve({ revision: 1, presentedRevision: 0, reportedRevision: 0 }); await opening
  assert.equal(f.views.size, 0); controller.dispose()
})

test('destination edits, removal and disconnect during authentication reject stale authority', async () => {
  for (const change of ['remove', 'disconnect', 'port', 'destination'] as const) {
    const f = fixture(), controller = new WorkspaceController(f.api), waiting = deferred<{ url: string }>()
    f.api.open = () => waiting.promise
    const opening = controller.open(first, { kind: 'session', id: 'chat' }); await nextTick()
    if (change === 'remove') f.rows = []
    else if (change === 'disconnect') f.rows[0].phase = 'disconnected'
    else if (change === 'port') f.rows[0].localPort = 43200
    else f.rows[0].target = 'different-computer'
    waiting.resolve({ url: address() }); await opening
    assert.equal(controller.getSnapshot()?.phase, 'error', change); assert.equal(controller.getSnapshot()?.url, undefined, change); assert.equal(f.views.size, 0, change)
    controller.dispose()
  }
})

test('restoration validates IDs, migrates legacy selection and respects automatic connection preferences', async () => {
  for (const phase of ['disconnected', 'connecting', 'updating', 'error'] as const) {
    const f = fixture(), controller = new WorkspaceController(f.api, { storage: f.storage })
    f.saved.set(savedKey, JSON.stringify({ sourceId: first, sessionId: 'chat' })); f.rows[0] = { ...f.rows[0], autoConnect: false, phase }
    await controller.restore(); assert.equal(f.connects, 0, phase); assert.equal(f.opens, 0, phase); assert.ok(f.saved.has(savedKey))
    await controller.open(first, { kind: 'session', id: 'chat' }); assert.equal(f.connects, 1); controller.dispose()
  }
  for (const selected of [{ sourceId: first, sessionId: 'chat' }, { sourceId: first, workspaceId: 'project' }]) {
    const f = fixture(), controller = new WorkspaceController(f.api, { storage: f.storage })
    f.rows[0] = { ...f.rows[0], phase: 'connected', localPort: 43188, autoConnect: false }; f.saved.set(savedKey, JSON.stringify(selected))
    await controller.restore(); assert.equal(f.connects, 0); assert.equal(f.opens, 1); assert.deepEqual(controller.getCatalogs().selected, selected); controller.dispose()
  }
  const f = fixture(), controller = new WorkspaceController(f.api, { storage: f.storage })
  f.saved.set('@xunz/dsh-connections/selected', first); await controller.restore()
  assert.equal(f.saved.has('@xunz/dsh-connections/selected'), false); assert.ok(f.saved.has(savedKey)); controller.dispose()
  for (const invalid of [{ sourceId: address() }, { sourceId: first, sessionId: '../escape' }, { sourceId: first, workspaceId: {} }]) {
    f.saved.set(savedKey, JSON.stringify(invalid)); const invalidController = new WorkspaceController(f.api, { storage: f.storage })
    await invalidController.restore(); assert.equal(invalidController.getSnapshot(), undefined); assert.equal(f.saved.size, 0); invalidController.dispose()
  }
})

test('an in-flight restore cannot reopen a remote after explicit local navigation', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api, { storage: f.storage }), waiting = deferred<WorkspaceResult>(), respond = f.respond
  f.saved.set(savedKey, JSON.stringify({ sourceId: first, sessionId: 'chat' }))
  f.respond = async (id, request) => id === 'local' && request.op === 'catalog' ? waiting.promise : respond(id, request)
  const restoring = controller.restore(); await nextTick(); controller.close(); waiting.resolve(catalog()); await restoring
  assert.equal(f.connects, 0); assert.equal(f.opens, 0); assert.equal(controller.getSnapshot(), undefined); controller.dispose()
})

test('native local-session restoration cannot erase the saved remote choice while catalogs load', async () => {
  for (const autoConnect of [true, false]) {
    const f = fixture(), controller = new WorkspaceController(f.api, { storage: f.storage }), waiting = deferred<WorkspaceResult>(), respond = f.respond
    const selected = { sourceId: first, sessionId: 'chat' }
    f.rows[0].autoConnect = autoConnect
    f.saved.set(savedKey, JSON.stringify(selected))
    f.respond = async (id, request) => id === 'local' && request.op === 'catalog' ? waiting.promise : respond(id, request)
    const restoring = controller.restore(); await nextTick()
    controller.localSelection('previous-local-chat')
    assert.deepEqual(JSON.parse(f.saved.get(savedKey)!), selected)
    waiting.resolve(catalog()); await restoring
    assert.equal(f.opens, autoConnect ? 1 : 0)
    assert.deepEqual(JSON.parse(f.saved.get(savedKey)!), selected)
    if (autoConnect) assert.deepEqual(controller.getCatalogs().selected, selected)
    controller.dispose()
  }
})

test('catalogs publish independently, retain offline rows and discard an edited destination catalog', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api), waiting = deferred<WorkspaceResult>(), respond = f.respond
  f.rows[0] = { ...f.rows[0], phase: 'connected', localPort: 43188 }
  f.respond = async (id, request) => id === first && request.op === 'catalog' ? waiting.promise : respond(id, request)
  const refreshing = controller.refresh(); await nextTick()
  assert.ok(controller.getCatalogs().sources[0].catalog, 'local data must appear while a remote is slow')
  waiting.resolve(catalog()); await refreshing; f.rows[0].phase = 'disconnected'; await controller.refresh()
  assert.ok(controller.getCatalogs().sources[1].catalog); assert.equal(controller.getCatalogs().sources[1].phase, 'disconnected')
  f.rows[0].target = 'replacement'; await controller.refresh(); assert.equal(controller.getCatalogs().sources[1].catalog, undefined); controller.dispose()
})

test('catalog refresh publishes immutable source snapshots through partial results, failure and recovery', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api), respond = f.respond
  const local = deferred<WorkspaceResult>(), remote = deferred<WorkspaceResult>()
  f.rows[0] = { ...f.rows[0], phase: 'connected', localPort: 43188 }
  f.respond = async (id, request) => request.op === 'catalog' ? (id === 'local' ? local : remote).promise : respond(id, request)
  const history: { snapshot: ReturnType<WorkspaceController['getCatalogs']>; expected: ReturnType<WorkspaceController['getCatalogs']> }[] = []
  controller.subscribe(() => {
    const snapshot = controller.getCatalogs()
    history.push({ snapshot, expected: structuredClone(snapshot) })
  })
  const refreshing = controller.refresh()
  try {
    await nextTick()
    const loading = controller.getCatalogs()
    local.resolve(catalog())
    await nextTick()
    const partial = controller.getCatalogs()
    assert.ok(partial.sources[0].catalog)
    assert.equal(partial.sources[1].catalog, undefined)
    assert.equal(loading.sources[0].catalog, undefined, 'a completed request must not mutate the published loading snapshot')
    remote.resolve(catalog())
    await refreshing
    const completed = controller.getCatalogs()
    assert.ok(completed.sources[1].catalog)
    assert.equal(partial.sources[1].catalog, undefined, 'the next host completion must leave the partial snapshot unchanged')
    f.respond = async (id, request) => {
      if (id === first && request.op === 'catalog') throw new Error('Temporary catalog failure')
      return respond(id, request)
    }
    await controller.refresh()
    const failed = controller.getCatalogs()
    assert.ok(failed.sources[1].catalogError)
    assert.equal(completed.sources[1].catalogError, undefined)
    f.respond = async (id, request) => request.op === 'catalog'
      ? { ...catalog(), workspaces: [], sessions: [], unchanged: true }
      : respond(id, request)
    await controller.refresh()
    const recovered = controller.getCatalogs()
    assert.equal(recovered.sources[1].catalogError, undefined)
    assert.ok(failed.sources[1].catalogError, 'clearing the current error must not rewrite the failure snapshot')
    assert.equal(recovered.sources[1].catalog, failed.sources[1].catalog, 'unchanged native catalogs retain their cached identity')
    for (const { snapshot, expected } of history) assert.deepEqual(snapshot, expected)
  } finally {
    local.resolve(catalog()); remote.resolve(catalog())
    await refreshing
    controller.dispose()
  }
})

test('mutation failures surface and successful writes refresh the native catalog', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api), respond = f.respond
  let archived = false
  f.respond = async (id, request) => {
    if (request.op === 'renameSession') throw new Error('Rename failed')
    if (request.op === 'archiveSession') { archived = true; return { done: true } }
    if (request.op === 'catalog') return { ...catalog(), archivedSessionIds: archived ? ['chat'] : [] }
    return respond(id, request)
  }
  f.rows[0] = { ...f.rows[0], phase: 'connected', localPort: 43188 }
  await assert.rejects(controller.mutate(first, { op: 'renameSession', id: 'chat', title: 'New' }), /Rename failed/)
  await controller.mutate(first, { op: 'archiveSession', id: 'chat', archived: true })
  assert.deepEqual(controller.getCatalogs().sources[1].catalog?.archivedSessionIds, ['chat']); controller.dispose()
})

test('a row from an old destination cannot navigate an equal native ID on a replacement host', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api)
  f.rows[0] = { ...f.rows[0], phase: 'connected', localPort: 43188 }; await controller.refresh()
  f.rows[0].target = 'replacement'
  await controller.navigate(first, { kind: 'session', id: 'chat' })
  await assert.rejects(controller.mutate(first, { op: 'renameSession', id: 'chat', title: 'Wrong computer' }), /connection changed/)
  assert.equal(controller.getSnapshot()?.phase, 'error')
  assert.equal(f.calls.filter(call => call.request.op === 'navigate').length, 0)
  assert.equal(f.calls.filter(call => call.request.op === 'renameSession').length, 0)
  controller.dispose()
})

test('reconnect replaces either a disconnected or connected view while preserving the chosen chat', async () => {
  for (const phase of ['disconnected', 'connected'] as const) {
    const f = fixture(), controller = new WorkspaceController(f.api)
    try {
      await controller.open(first, { kind: 'session', id: 'chosen-chat' }); await controller.refresh()
      const previous = controller.getSnapshot()!
      f.views.set(previous.channel!, { revision: previous.revision!, presentedRevision: 0, reportedRevision: 0, sessionId: 'older-chat' })
      await controller.check()
      assert.equal(controller.getCatalogs().selected.sessionId, 'chosen-chat', 'unacknowledged selection is ignored')
      f.rows[0].phase = phase
      await controller.check()
      assert.equal(controller.getSnapshot()?.phase, phase === 'disconnected' ? 'error' : 'ready', phase)
      if (phase === 'disconnected') assert.equal(controller.getSnapshot()?.url, undefined)
      await controller.reconnect(first)
      assert.equal(f.reconnects, 1, phase)
      assert.equal(f.channels, 2, phase)
      assert.notEqual(controller.getSnapshot()?.channel, previous.channel, phase)
      assert.equal(f.views.has(previous.channel!), false, phase)
      assert.deepEqual(controller.getCatalogs().selected, { sourceId: first, sessionId: 'chosen-chat' }, phase)
      const last = f.calls.filter(call => call.request.op === 'navigate').at(-1)!
      assert.deepEqual(last.request.op === 'navigate' && last.request.target, { kind: 'session', id: 'chosen-chat' }, phase)
    } finally { controller.dispose() }
  }
})

test('metadata edits preserve the content channel and conditional catalog cache', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api)
  try {
    await controller.open(first, { kind: 'session', id: 'chat' })
    await controller.refresh()
    const previous = controller.getSnapshot()!
    f.rows[0].name = 'Renamed'
    f.rows[0].autoConnect = false
    await controller.refresh()
    assert.equal(controller.getSnapshot()?.channel, previous.channel)
    assert.equal(f.channels, 1)
    assert.equal(f.reconnects, 0)
    assert.equal(controller.getCatalogs().sources.find(source => source.id === first)?.name, 'Renamed')
    const request = f.calls.filter(call => call.id === first && call.request.op === 'catalog').at(-1)!.request
    assert.equal(request.op === 'catalog' && request.ifRevision, catalog().revision)
  } finally { controller.dispose() }
})

test('a destination edited while disconnected cannot reuse the old catalog revision after connecting', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api)
  try {
    await f.api.connect(first)
    await controller.refresh(false)
    f.rows[0].phase = 'disconnected'
    f.rows[0].target = 'replacement'
    await controller.refresh(false)
    assert.equal(controller.getCatalogs().sources.find(source => source.id === first)?.catalog, undefined)
    await f.api.connect(first)
    await controller.refresh(false)
    const request = f.calls.filter(call => call.id === first && call.request.op === 'catalog').at(-1)!.request
    assert.equal(request.op === 'catalog' && request.ifRevision, undefined)
  } finally { controller.dispose() }
})

test('a late catalog result cannot overwrite a reconnect and a forced refresh is not lost', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api), waiting = deferred<WorkspaceResult>(), respond = f.respond
  const seen: string[] = []
  let requests = 0
  f.rows[0] = { ...f.rows[0], phase: 'connected', localPort: 43188 }
  f.respond = async (id, request) => {
    if (id !== first || request.op !== 'catalog') return respond(id, request)
    if (++requests === 1) return waiting.promise
    return { ...catalog(), workspaces: [{ ...catalog().workspaces[0], title: 'Fresh Host' }] }
  }
  controller.subscribe(() => {
    const title = controller.getCatalogs().sources.find(source => source.id === first)?.catalog?.workspaces[0]?.title
    if (title) seen.push(title)
  })
  try {
    const refreshing = controller.refresh(false)
    await nextTick()
    const reconnecting = controller.reconnect(first)
    await nextTick()
    waiting.resolve({ ...catalog(), workspaces: [{ ...catalog().workspaces[0], title: 'Stale Host' }] })
    await Promise.all([refreshing, reconnecting])
    assert.equal(requests, 2)
    assert.equal(seen.includes('Stale Host'), false)
    assert.equal(seen.at(-1), 'Fresh Host')
    const request = f.calls.filter(call => call.id === first && call.request.op === 'catalog').at(-1)!.request
    assert.equal(request.op === 'catalog' && request.ifRevision, undefined)
  } finally { waiting.resolve(catalog()); controller.dispose() }
})

test('background catalogs use selected and idle intervals with bounded retry backoff', async t => {
  let now = 0
  t.mock.method(Date, 'now', () => now)
  t.mock.method(Math, 'random', () => 0.5)
  const f = fixture(), controller = new WorkspaceController(f.api), respond = f.respond
  let fail = false
  f.rows[0] = { ...f.rows[0], phase: 'connected', localPort: 43188 }
  f.respond = async (id, request) => { if (fail && id === first && request.op === 'catalog') throw new Error('temporarily unavailable'); return respond(id, request) }
  const count = (id: string) => f.calls.filter(call => call.id === id && call.request.op === 'catalog').length
  try {
    await controller.refresh(false)
    await controller.refresh(false)
    assert.equal(count('local'), 1); assert.equal(count(first), 1)
    now = 5001
    await controller.refresh(false)
    assert.equal(count('local'), 2); assert.equal(count(first), 1)
    now = 30001; fail = true
    await controller.refresh(false)
    assert.equal(count(first), 2)
    assert.equal(controller.getCatalogs().sources[1].phase, 'connected')
    assert.ok(controller.getCatalogs().sources[1].catalogError)
    now += 9999
    await controller.refresh(false)
    assert.equal(count(first), 2)
    assert.equal(controller.getCatalogs().sources[1].phase, 'connected', 'catalog backoff does not change transport phase')
    now += 2
    await controller.refresh(false)
    assert.equal(count(first), 3)
    now += 19999
    await controller.refresh(false)
    assert.equal(count(first), 3)
    now += 2; fail = false
    await controller.refresh(false)
    assert.equal(count(first), 4)
    assert.equal(controller.getCatalogs().sources[1].phase, 'connected')
  } finally { controller.dispose() }
})

test('hidden pages pause automatic catalog work and resume with a fresh snapshot', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api)
  try {
    controller.setVisible(false)
    controller.start()
    await nextTick()
    assert.equal(f.calls.length, 0)
    controller.setVisible(true)
    await nextTick()
    assert.equal(f.calls.filter(call => call.request.op === 'catalog').length, 1)
  } finally { controller.dispose() }
})

test('catalog reads keep at most three source requests in flight', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api)
  f.rows = Array.from({ length: 5 }, (_, index) => ({ ...f.rows[0], id: `connection-${index.toString().padStart(8, '0')}-1111-4111-a111-111111111111`, phase: 'connected', localPort: 43188 + index }))
  const pending: ReturnType<typeof deferred<WorkspaceResult>>[] = []
  let active = 0, maximum = 0
  f.respond = async () => {
    active++; maximum = Math.max(maximum, active)
    const result = deferred<WorkspaceResult>(); pending.push(result)
    try { return await result.promise } finally { active-- }
  }
  const refreshing = controller.refresh(false)
  try {
    await nextTick()
    assert.equal(active, 3)
    for (let index = 0; index < 6; index++) { pending.shift()!.resolve(catalog()); await nextTick() }
    await refreshing
    assert.equal(maximum, 3)
    assert.equal(f.calls.length, 6)
  } finally { controller.dispose(); for (const result of pending) result.resolve(catalog()); await refreshing }
})

test('pending replacement navigation cannot be invalidated by an older view error', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api)
  await controller.open(first, { kind: 'session', id: 'first-chat' }); await controller.refresh()
  const old = controller.getSnapshot()!, waiting = deferred<WorkspaceResult>(), respond = f.respond
  f.views.set(old.channel!, { revision: old.revision!, presentedRevision: 0, reportedRevision: old.revision!, error: 'NAVIGATION_FAILED' })
  f.respond = async (id, request) => request.op === 'navigate' ? waiting.promise : respond(id, request)
  const opening = controller.open(first, { kind: 'session', id: 'next-chat' }); await nextTick(); await controller.check()
  assert.equal(controller.getSnapshot()?.phase, 'ready')
  f.views.set(old.channel!, { revision: 2, presentedRevision: 0, reportedRevision: 0 }); waiting.resolve({ revision: 2, presentedRevision: 0, reportedRevision: 0 }); await opening
  assert.equal(controller.getCatalogs().selected.sessionId, 'next-chat'); assert.equal(f.channels, 1); controller.dispose()
})

test('cancelled remote picking retains the previous chat or returns local when none was open', async () => {
  for (const hasPrevious of [false, true]) {
    const f = fixture(), controller = new WorkspaceController(f.api)
    if (hasPrevious) await controller.open(first, { kind: 'session', id: 'original' })
    await controller.pick(first); await controller.refresh()
    const state = controller.getSnapshot()!
    f.views.set(state.channel!, { revision: state.revision!, presentedRevision: 0, reportedRevision: state.revision!, error: 'PICK_CANCELLED' }); await controller.check(); await controller.check()
    assert.equal(controller.getCatalogs().selected.sourceId, hasPrevious ? first : 'local'); assert.equal(controller.getCatalogs().selected.sessionId, hasPrevious ? 'original' : undefined)
    assert.equal(controller.getSnapshot()?.phase, hasPrevious ? 'ready' : undefined); controller.dispose()
  }
})

test('local navigation delegates native IDs without creating remote placeholders', async () => {
  const f = fixture(), targets: unknown[] = [], controller = new WorkspaceController(f.api, { localNavigate: target => { targets.push(target) } })
  await controller.open(first, { kind: 'session', id: 'chat' }); await controller.navigate('local', { kind: 'workspace', id: 'project' })
  assert.deepEqual(targets, [{ kind: 'workspace', id: 'project' }]); assert.equal(controller.getSnapshot(), undefined)
  assert.equal(f.calls.some(call => call.id === 'local' && call.request.op !== 'catalog'), false); controller.dispose()
})

test('New Session retains selection while native blank reuse or creation is pending', async () => {
  for (const resolvedSession of ['chat', 'new-chat']) {
    const f = fixture(), controller = new WorkspaceController(f.api, { storage: f.storage })
    try {
      await controller.open(first, { kind: 'session', id: 'chat' })
      const url = controller.getSnapshot()!.url
      const pending = deferred<WorkspaceResult>(), respond = f.respond
      f.respond = async (id, request) => {
        if (request.op === 'navigate' && request.target.kind === 'newSession') await pending.promise
        return respond(id, request)
      }
      const navigation = controller.newSession()
      await nextTick()
      assert.deepEqual(controller.getCatalogs().selected, { sourceId: first, sessionId: 'chat' })
      assert.deepEqual(JSON.parse(f.saved.get(savedKey)!), { sourceId: first, sessionId: 'chat' })
      pending.resolve({ done: true }); await navigation
      const state = controller.getSnapshot()!
      assert.equal(state.url, url)
      assert.equal(f.channels, 1, 'keep the native document and its draft resident')
      f.views.set(state.channel!, { revision: state.revision!, presentedRevision: state.revision!, reportedRevision: state.revision!, sessionId: resolvedSession })
      await controller.check()
      assert.deepEqual(controller.getCatalogs().selected, { sourceId: first, sessionId: resolvedSession })
    } finally { controller.dispose() }
  }
})

test('New Session follows the selected source and explicit local creation supersedes restoration', async () => {
  const f = fixture(), local: unknown[] = [], controller = new WorkspaceController(f.api, { storage: f.storage, localNavigate: target => { local.push(target) } })
  await controller.newSession()
  assert.deepEqual(local, [{ kind: 'newSession' }])
  await controller.open(first, { kind: 'session', id: 'chat' })
  await controller.newSession()
  const last = f.calls.filter(call => call.request.op === 'navigate').at(-1)!
  assert.equal(last.id, first)
  assert.deepEqual(last.request.op === 'navigate' && last.request.target, { kind: 'newSession' })
  assert.equal(local.length, 1)
  controller.dispose()

  const restoringFixture = fixture(), waiting = deferred<WorkspaceResult>(), respond = restoringFixture.respond
  restoringFixture.saved.set(savedKey, JSON.stringify({ sourceId: first, sessionId: 'chat' }))
  restoringFixture.respond = async (id, request) => id === 'local' && request.op === 'catalog' ? waiting.promise : respond(id, request)
  const restored = new WorkspaceController(restoringFixture.api, { storage: restoringFixture.storage, localNavigate: target => { local.push(target) } })
  const restoration = restored.restore(); await nextTick()
  const creation = restored.newSession()
  waiting.resolve(catalog()); await Promise.all([restoration, creation])
  assert.equal(restoringFixture.opens, 0); assert.equal(restored.getCatalogs().selected.sourceId, 'local')
  restored.dispose()
})

test('a view remains pending until native presentation and picker presentation does not complete navigation', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api)
  await controller.pick(first)
  await controller.check()
  assert.equal(controller.getSnapshot()?.presented, false)
  const state = controller.getSnapshot()!
  f.views.set(state.channel!, { revision: state.revision!, presentedRevision: state.revision!, reportedRevision: 0 })
  await controller.check()
  assert.equal(controller.getSnapshot()?.presented, true)
  assert.deepEqual(controller.getCatalogs().selected, { sourceId: first })
  controller.dispose()
})

test('a stalled presentation times out independently of pending Host requests and ignores their late reply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(), controller = new WorkspaceController(f.api, { presentationTimeoutMs: 20 }), waiting = deferred<WorkspaceResult>(), respond = f.respond
  f.respond = async (id, request) => request.op === 'viewState' ? waiting.promise : respond(id, request)
  await controller.pick(first)
  const checking = controller.check()
  t.mock.timers.tick(20)
  assert.equal(controller.getSnapshot()?.error, 'timeout')
  assert.equal(controller.getSnapshot()?.url, undefined)
  waiting.resolve({ revision: 1, presentedRevision: 1, reportedRevision: 1, sessionId: 'late' }); await checking
  assert.equal(controller.getSnapshot()?.error, 'timeout')
  assert.equal(f.rows[0].phase, 'connected', 'presentation failure must not terminate remote work')
  controller.dispose()
})

test('synchronous navigation observer errors reach the error surface rather than escaping the click', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api)
  controller.subscribe(() => { if (controller.getSnapshot()?.phase === 'connecting') throw new Error('unavailable panel') })
  await controller.open(first)
  assert.equal(controller.getSnapshot()?.phase, 'error')
  controller.dispose()
})

test('a native acknowledgement cannot revive a remote closed by a selection observer', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api)
  await controller.pick(first)
  const state = controller.getSnapshot()!
  controller.subscribe(() => { if (controller.getCatalogs().selected.sessionId === 'chosen') controller.close() })
  f.views.set(state.channel!, { revision: state.revision!, presentedRevision: state.revision!, reportedRevision: state.revision!, sessionId: 'chosen' })
  await controller.check()
  assert.equal(controller.getSnapshot(), undefined)
  assert.equal(controller.getCatalogs().selected.sourceId, 'local')
  assert.equal(f.views.size, 0)
  controller.dispose()
})

test('a remote host without the content bundle reports a setup requirement without opening its full app', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api), respond = f.respond
  f.respond = async (id, request) => {
    if (request.op === 'openView') throw Object.assign(new Error('Remote content bundle required.'), { code: 'NOT_EMBEDDED' })
    return respond(id, request)
  }
  await controller.open(first, { kind: 'session', id: 'chat' })
  assert.equal(controller.getSnapshot()?.error, 'pluginRequired'); assert.equal(controller.getSnapshot()?.url, undefined); assert.equal(f.opens, 0)
  controller.dispose()
})

test('dispose invalidates pending work and repeated start creates only one polling loop', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api), waiting = deferred<WorkspaceResult>(), respond = f.respond
  f.respond = async (id, request) => id === 'local' && request.op === 'catalog' ? waiting.promise : respond(id, request)
  controller.start(); controller.start(); await nextTick()
  assert.equal(f.calls.filter(call => call.id === 'local' && call.request.op === 'catalog').length, 1)
  controller.dispose(); waiting.resolve(catalog()); await nextTick(); controller.start()
  assert.equal(controller.getSnapshot(), undefined); assert.equal(f.calls.filter(call => call.id === 'local' && call.request.op === 'catalog').length, 1)
})

test('in-app web view preserves same-site cookies and refuses unsupported parent origins', () => {
  assert.equal(workspaceUrl(address(), { protocol: 'http:', hostname: '127.0.0.1' }, false), address())
  assert.equal(new URL(workspaceUrl(address(), { protocol: 'http:', hostname: 'localhost' }, false)).hostname, 'localhost')
  assert.equal(workspaceUrl(address(), { protocol: 'dsh-app:', hostname: 'app' }, true), address())
  for (const page of [
    { protocol: 'dsh-app:', hostname: 'app' }, { protocol: 'https:', hostname: '127.0.0.1' },
    { protocol: 'http:', hostname: 'example.test' }, { protocol: 'http:', hostname: '[::1]' },
  ]) assert.throws(() => workspaceUrl(address(), page, false), /unsupported-workspace-surface/)
  assert.throws(() => workspaceUrl('https://example.test/?token=private', { protocol: 'http:', hostname: '127.0.0.1' }, true))
})


function loadWorkspaces(globals: Record<string, unknown> = {}) {
  const built = buildSync({ entryPoints: ['src/client/workspaces.tsx'], bundle: true, packages: 'external', format: 'cjs', platform: 'node', write: false })
  const require = createRequire(import.meta.url)
  const exports = { exports: {} as typeof import('../src/client/workspaces.js') }
  vm.runInNewContext(built.outputFiles[0].text, {
    module: exports, exports: exports.exports,
    require: (name: string) => name === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(name),
    console, URL, URLSearchParams, crypto, setTimeout, clearTimeout, AbortController, AbortSignal,
    get window() { return globalThis.window },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    ...globals,
  })
  return exports.exports
}

function localPresentationServices() {
  return {
    locale: { register: () => () => {}, bind: () => () => '', getSnapshot: () => ({ active: 'en' }) },
    theme: { getTheme: () => ({ active: { colorScheme: 'light', tokens: {} },
      fontSizes: { text: 14, code: 11, terminal: 13 }, fontFamilies: { text: '', code: '', terminal: '' },
    }) },
    configForms: { get: () => ({ getSnapshot: () => ({ value: undefined }) }), developerTools: { enabled: { getSnapshot: () => false } } },
  }
}

test('production workspace installation opens native desktop views through the validated loopback URL', async () => {
  const { installWorkspaces } = loadWorkspaces({
    dshDesktop: { protocolVersion: 1, browser: {} },
    window: { location: { protocol: 'dsh-app:', hostname: 'app' } },
  })
  const effects: (() => void)[] = []
  const context = {
    inject() {},
    effect: (factory: () => (() => void)) => { effects.push(factory()) },
    ...localPresentationServices(),
  }
  let resolveCommand: import('../src/client/native-shortcuts.js').NativeCommandResolver | undefined
  const f = fixture(), controller = installWorkspaces(context as never, f.api as never, () => '', () => true, resolve => {
    resolveCommand = resolve; return () => { resolveCommand = undefined }
  })
  try {
    await controller.open(first, { kind: 'session', id: 'chat' })
    assert.equal(controller.getSnapshot()?.phase, 'ready')
    assert.equal(new URL(controller.getSnapshot()!.url!).hostname, '127.0.0.1')
    assert.equal(f.calls.some(call => call.request.op === 'navigate'), true)
    const allocation = f.calls.find(call => call.request.op === 'openView')?.request
    assert.equal(allocation?.op, 'openView')
    assert.equal(allocation.presentation?.locale, 'en', 'native presentation is available to the guest at allocation')
    assert.equal(allocation.presentation?.general.busyEnter, 'queue')
    assert.equal(f.views.size, 1)
    assert.ok(resolveCommand, 'source routing must be installed without mounting a React sidebar')
    const resolution = resolveCommand({ id: 'session.archive' } as never, { region: 'page', modal: null, target: null })
    assert.equal(resolution?.status, 'handled', 'retained local action must not receive this command')
  } finally { for (const dispose of effects.reverse()) dispose() }
})

test('native slot delegation preserves the original leaf and follows its registration lifetime', async () => {
  const { SlotCore } = await import('@deepseek-ai/dsh-client-ui-slots')
  const { createSnapshotStore } = await import('@deepseek-ai/dsh-client-store')
  const { installWorkspaces } = loadWorkspaces()
  const core = new SlotCore()
  const hero = 'conversation.hero.workspace.directoryFlow'
  const sidebar = 'sidebar.workspaces.directoryFlow'
  const original = () => null
  const inject = () => ({ pick: async () => '/native/project' })
  const removeRoot = core.register({ name: 'root', children: {
    [hero]: { kind: 'single', scope: 'root' }, [sidebar]: { kind: 'single', scope: 'root' },
    'main': { kind: 'keyed', scope: 'root' }, 'sidebar.workspaces': { kind: 'single', scope: 'root' },
  } }, (() => null) as never)
  const removeHero = core.register({ name: hero, inject }, original)
  core.register({ name: sidebar, inject }, original)
  const effects: (() => void)[] = []
  const injections: (() => void)[] = []
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { value: { location: { protocol: 'http:', hostname: '127.0.0.1' } }, configurable: true })
  const observable = <T,>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} })
  const localCalls: unknown[][] = []
  const panels = createSnapshotStore<{ activePanelId: string | null; wide: boolean }>({ activePanelId: null, wide: false })
  const context = {
    inject: (_keys: string[], apply: (ctx: unknown) => void) => {
      const child = Object.create(context)
      Object.defineProperty(child, 'uiWorkspace', { value: {
        openSession(id: string) { localCalls.push(['session', id]) },
        async openWorkspace(id: string) { localCalls.push(['workspace', id]) },
        startSession(id?: string) { localCalls.push(['newSession', id]) },
      } })
      apply(child)
    },
    layout: {
      // A previous navigation's cancellation can synchronously update geometry.
      beginNavigation() { panels.set({ ...panels.getSnapshot(), wide: !panels.getSnapshot().wide }) },
      selectPanel(id: string | null) { panels.set({ ...panels.getSnapshot(), activePanelId: id }) }, panelInfo: panels,
    },
    uiSession: { adapter: { current: observable({ key: 'reused-local-draft' }) } },
    get uiWorkspace(): never { throw new Error('uiWorkspace is not available outside its injection scope') },
    workspaces: {},
    effect: (factory: () => (() => void)) => { effects.push(factory()) },
    ...localPresentationServices(),
    slots: {
      register: core.register.bind(core), entries: core.entries.bind(core), subscribe: core.subscribe.bind(core),
      inject: (_slot: string, install: () => () => void) => { injections.push(install()) },
    },
  }
  try {
    const f = fixture()
    const controller = installWorkspaces(context as never, f.api as never, () => '')
    assert.equal(controller.getCatalogs().selected.sessionId, 'reused-local-draft', 'already restored native sessions are sampled without a change event')
    await controller.navigate('local', { kind: 'session', id: 'chat' })
    await controller.navigate('local', { kind: 'workspace', id: 'project' })
    assert.equal(controller.getCatalogs().selected.sessionId, 'reused-local-draft', 'reusing a native blank session keeps its sidebar selection')
    assert.deepEqual(localCalls, [['session', 'chat'], ['workspace', 'project']])
    assert.equal(core.entries('main').length, 1, 'remote content uses the native main panel')
    assert.equal(core.entries('sidebar.workspaces').length, 1, 'one combined browser occupies the sidebar')
    const heroAlias = 'connections.local.heroDirectoryFlow'
    const delegated = core.entries(heroAlias)[0]
    assert.equal(delegated.component, original)
    assert.equal(delegated.inject, inject)
    assert.deepEqual({ ...core.entriesOfSlot(hero)[0].children?.[heroAlias] }, { kind: 'single', scope: 'root' })
    assert.equal(core.entries('connections.local.sidebarDirectoryFlow')[0].component, original)
    const Picker = core.entriesOfSlot(hero)[0].component as (props: Record<string, unknown>) => {
      props: { owner: Record<string, unknown>; renderLocal(owner: Record<string, unknown>): unknown }
    }
    let forwarded: Record<string, unknown> | undefined
    const owner = { open: true, busy: false, onPicked: () => {}, onCancel: () => {}, onError: () => {} }
    const rendered = Picker({ ...owner, t: () => 'wrong namespace', useStore: () => ({}),
      renderSlot: (_key: string, props: Record<string, unknown>) => { forwarded = props; return null } })
    rendered.props.renderLocal(rendered.props.owner)
    assert.deepEqual({ ...forwarded }, owner, 'framework locale/store props must not override the native picker injected face')
    removeHero()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(core.entries(heroAlias).length, 0)
    const replacement = () => null
    core.register({ name: hero, inject }, replacement)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(core.entries(heroAlias)[0].component, replacement)
    await controller.open(first, { kind: 'session', id: 'chat' })
    assert.equal(controller.getSnapshot()?.phase, 'ready', 'geometry notifications must not cancel entering the remote panel')
    assert.equal(panels.getSnapshot().activePanelId, 'connections.workspace')
    await controller.navigate('local', { kind: 'newSession' })
    assert.deepEqual(localCalls.at(-1), ['newSession', undefined])
    assert.equal(controller.getSnapshot(), undefined)
    for (const dispose of injections.reverse()) dispose()
    injections.length = 0
    assert.equal(core.specDynamic(heroAlias), undefined)
    assert.equal(core.entriesOfSlot(hero)[0].component, replacement)
  } finally {
    for (const dispose of injections.reverse()) dispose()
    for (const dispose of effects.reverse()) dispose()
    removeRoot()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})


test('a catalog error keeps the connected phase and retry refreshes without rebuilding transport', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api)
  await f.api.connect(first)
  const respond = f.respond
  let fail = true
  f.respond = async (id, request) => {
    if (id === first && request.op === 'catalog' && fail) throw new Error('busy')
    return respond(id, request)
  }
  try {
    await controller.refresh(false)
    assert.equal(controller.getCatalogs().sources[1].phase, 'connected')
    assert.ok(controller.getCatalogs().sources[1].catalogError)
    fail = false
    await controller.retry(first)
    assert.equal(f.reconnects, 0)
    assert.equal(controller.getCatalogs().sources[1].catalogError, undefined)
    fail = true; await controller.refresh()
    f.rows[0].phase = 'disconnected'; await controller.refresh(false)
    f.rows[0].phase = 'connected'; fail = false; await controller.refresh(false)
    assert.equal(controller.getCatalogs().sources[1].catalogError, undefined, 'external reconnect bypasses stale catalog backoff')
  } finally { controller.dispose() }
})

test('a transient view RPC failure retains its iframe and a successful check resets the retry budget', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api)
  await controller.open(first, { kind: 'session', id: 'chat' })
  await controller.refresh()
  const state = controller.getSnapshot()!, respond = f.respond
  let fail = true
  f.respond = async (id, request) => {
    if (request.op === 'viewState' && fail) throw new Error('temporarily unavailable')
    return respond(id, request)
  }
  try {
    await controller.check(); await controller.check()
    assert.equal(controller.getSnapshot()?.url, state.url)
    fail = false; await controller.check()
    fail = true; await controller.check(); await controller.check()
    assert.equal(controller.getSnapshot()?.phase, 'ready')
    await controller.check()
    assert.equal(controller.getSnapshot()?.error, 'disconnected')
    assert.equal(f.reconnects, 0)
  } finally { controller.dispose() }
})

test('a transport identity change invalidates iframe reuse even when its local port is unchanged', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api)
  f.rows[0].transportId = crypto.randomUUID()
  try {
    await controller.open(first, { kind: 'session', id: 'chat' }); await controller.refresh()
    const previous = controller.getSnapshot()!.channel
    f.rows[0].transportId = crypto.randomUUID()
    await controller.open(first, { kind: 'session', id: 'chat' })
    assert.notEqual(controller.getSnapshot()!.channel, previous)
    assert.equal(f.opens, 2)
  } finally { controller.dispose() }
})

test('settings navigation uses its own view lease and never changes a workspace selection or reads catalogs', async () => {
  const f = fixture(), workspace = new WorkspaceController(f.api), settings = new WorkspaceController(f.api, { catalogs: false })
  try {
    await workspace.open(first, { kind: 'session', id: 'chat' }); await workspace.refresh()
    const selection = workspace.getCatalogs().selected
    f.calls.length = 0
    await settings.open(first, { kind: 'settings' })
    assert.deepEqual(workspace.getCatalogs().selected, selection)
    assert.equal(f.calls.some(call => call.request.op === 'catalog'), false)
    assert.equal(f.views.size, 2)
    const state = settings.getSnapshot()!
    f.views.set(state.channel!, { revision: state.revision!, reportedRevision: state.revision!, presentedRevision: state.revision!, error: 'SETTINGS_CLOSED' })
    await settings.check()
    assert.equal(settings.getSnapshot(), undefined)
    assert.equal(workspace.getSnapshot()?.phase, 'ready')
  } finally { workspace.dispose(); settings.dispose() }
})

test('view owners survive reload, fork copied tab storage, and separate settings from workspaces', () => {
  const f = fixture()
  const handlers = new Map<string, () => void>()
  const events = { addEventListener: (event: string, callback: () => void) => handlers.set(event, callback) } as unknown as Pick<Window, 'addEventListener'>
  const first = viewClientId(f.storage, 'workspace', events)
  const duplicateStorage = new Map(f.saved)
  const duplicate = viewClientId({ getItem: key => duplicateStorage.get(key) ?? null, setItem: (key, value) => { duplicateStorage.set(key, value) } }, 'workspace', events)
  assert.notEqual(first, duplicate)
  const reloadEvents = new Map<string, () => void>()
  // Recreate the original callbacks after the independent duplicate fixture.
  const id = viewClientId(f.storage, 'workspace', { addEventListener: (event: string, callback: () => void) => reloadEvents.set(event, callback) } as unknown as Pick<Window, 'addEventListener'>)
  reloadEvents.get('pagehide')!()
  assert.equal(viewClientId(f.storage, 'workspace', events), id)
  assert.notEqual(viewClientId(f.storage, 'settings', events), id)
  assert.ok(!JSON.stringify([...f.saved]).includes(token))
})

test('overlapping navigation serializes lease allocation so an old request cannot replace a newer view', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api), waiting = deferred<void>(), entered = deferred<void>()
  const respond = f.respond
  let allocations = 0
  f.respond = async (id, request) => {
    if (request.op === 'openView') {
      if (++allocations === 1) { entered.resolve(); await waiting.promise }
      // Model endpoint replacement of the same per-tab lease owner.
      f.views.clear()
    }
    return respond(id, request)
  }
  try {
    const older = controller.open(first, { kind: 'session', id: 'old' })
    await entered.promise
    const newer = controller.open(first, { kind: 'session', id: 'new' })
    await nextTick()
    assert.equal(allocations, 1, 'the newer allocation waits for the old one to finish')
    waiting.resolve(); await Promise.all([older, newer])
    assert.equal(allocations, 2)
    assert.equal(controller.getSnapshot()?.phase, 'ready')
    assert.ok(f.views.has(controller.getSnapshot()!.channel!))
    assert.deepEqual(f.views.get(controller.getSnapshot()!.channel!)?.intent?.target, { kind: 'session', id: 'new' })
  } finally { controller.dispose() }
})
