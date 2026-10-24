import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceController } from '../src/client/workspace-controller.js'
import { workspaceUrl } from '../src/client/workspaces.js'
import type { ConnectionView } from '../src/shared/types.js'
import type { WorkspaceCatalog, WorkspaceRequest, WorkspaceResult, WorkspaceResultMap, WorkspaceViewState } from '../src/shared/workspace-protocol.js'

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
const catalog = (): WorkspaceCatalog => ({
  workspaces: [{ id: 'project', path: '/project', title: 'Project', sessionIds: ['chat'] }],
  sessions: [{ id: 'chat', title: 'Chat', blank: false, running: false, updatedAt: 0 }], archivedSessionIds: [], pinnedSessionIds: [],
})
function fixture() {
  let rows: ConnectionView[] = [{ id: first, name: 'First', target: 'first', phase: 'disconnected', remotePort: 3000 }]
  let connects = 0, opens = 0, channels = 0
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
          const view = { channel, revision: 0, reportedRevision: 0 }; views.set(channel, view); return view
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
      async list() { return structuredClone(rows) },
      async connect(id: string) { connects++; const row = rows.find(row => row.id === id)!; row.phase = 'connected'; row.localPort = id === first ? 43188 : 43189; return structuredClone(row) },
      async open(id: string) { opens++; return { url: address(rows.find(row => row.id === id)?.localPort) } },
      async workspace<R extends WorkspaceRequest>(id: string, request: R): Promise<WorkspaceResultMap[R['op']]> {
        calls.push({ id, request: structuredClone(request) }); return await f.respond(id, request) as WorkspaceResultMap[R['op']]
      },
    },
    storage, saved, calls, views,
    get rows() { return rows }, set rows(value) { rows = value },
    get connects() { return connects }, get opens() { return opens }, get channels() { return channels },
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
  controller.close(); waiting.resolve({ revision: 1, reportedRevision: 0 }); await opening
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

test('health checks accept acknowledged selection and reconnect restores the chosen chat', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api)
  await controller.open(first, { kind: 'session', id: 'chosen-chat' }); await controller.refresh()
  const state = controller.getSnapshot()!
  f.views.set(state.channel!, { revision: state.revision!, reportedRevision: 0, sessionId: 'older-chat' }); await controller.check()
  assert.equal(controller.getCatalogs().selected.sessionId, 'chosen-chat')
  f.rows[0].phase = 'disconnected'; await controller.check(); assert.equal(controller.getSnapshot()?.phase, 'error'); assert.equal(controller.getSnapshot()?.url, undefined)
  await controller.reconnect(first)
  const last = f.calls.filter(call => call.request.op === 'navigate').at(-1)!
  assert.deepEqual(last.request.op === 'navigate' && last.request.target, { kind: 'session', id: 'chosen-chat' }); controller.dispose()
})

test('pending replacement navigation cannot be invalidated by an older view error', async () => {
  const f = fixture(), controller = new WorkspaceController(f.api)
  await controller.open(first, { kind: 'session', id: 'first-chat' }); await controller.refresh()
  const old = controller.getSnapshot()!, waiting = deferred<WorkspaceResult>(), respond = f.respond
  f.views.set(old.channel!, { revision: old.revision!, reportedRevision: old.revision!, error: 'NAVIGATION_FAILED' })
  f.respond = async (id, request) => request.op === 'navigate' ? waiting.promise : respond(id, request)
  const opening = controller.open(first, { kind: 'session', id: 'next-chat' }); await nextTick(); await controller.check()
  assert.equal(controller.getSnapshot()?.phase, 'ready')
  f.views.set(old.channel!, { revision: 2, reportedRevision: 0 }); waiting.resolve({ revision: 2, reportedRevision: 0 }); await opening
  assert.equal(controller.getCatalogs().selected.sessionId, 'next-chat'); assert.equal(f.channels, 1); controller.dispose()
})

test('cancelled remote picking retains the previous chat or returns local when none was open', async () => {
  for (const hasPrevious of [false, true]) {
    const f = fixture(), controller = new WorkspaceController(f.api)
    if (hasPrevious) await controller.open(first, { kind: 'session', id: 'original' })
    await controller.pick(first); await controller.refresh()
    const state = controller.getSnapshot()!
    f.views.set(state.channel!, { revision: state.revision!, reportedRevision: state.revision!, error: 'PICK_CANCELLED' }); await controller.check(); await controller.check()
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


test('native slot delegation preserves the original leaf and follows its registration lifetime', async () => {
  const { SlotCore } = await import('@deepseek-ai/dsh-client-ui-slots')
  const { installWorkspaces } = await import('../src/client/workspaces.js')
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
  const context = {
    inject: (_keys: string[], apply: (ctx: unknown) => void) => {
      const child = Object.create(context)
      Object.defineProperty(child, 'uiWorkspace', { value: {
        openSession(id: string) { localCalls.push(['session', id]) },
        async openWorkspace(id: string) { localCalls.push(['workspace', id]) },
      } })
      apply(child)
    },
    layout: { beginNavigation() {}, selectPanel() {}, panelInfo: observable({ activePanelId: null }) },
    uiSession: { adapter: { current: observable({ key: undefined }) } },
    get uiWorkspace(): never { throw new Error('uiWorkspace is not available outside its injection scope') },
    workspaces: {},
    effect: (factory: () => (() => void)) => { effects.push(factory()) },
    locale: { register: () => () => {}, bind: () => () => '' },
    slots: {
      register: core.register.bind(core), entries: core.entries.bind(core), subscribe: core.subscribe.bind(core),
      inject: (_slot: string, install: () => () => void) => { injections.push(install()) },
    },
  }
  try {
    const f = fixture()
    const controller = installWorkspaces(context as never, f.api as never, () => '')
    await controller.navigate('local', { kind: 'session', id: 'chat' })
    await controller.navigate('local', { kind: 'workspace', id: 'project' })
    assert.deepEqual(localCalls, [['session', 'chat'], ['workspace', 'project']])
    assert.equal(core.entries('main').length, 1, 'remote content uses the native main panel')
    assert.equal(core.entries('sidebar.workspaces').length, 1, 'one combined browser occupies the sidebar')
    const heroAlias = 'connections.local.heroDirectoryFlow'
    const delegated = core.entries(heroAlias)[0]
    assert.equal(delegated.component, original)
    assert.equal(delegated.inject, inject)
    assert.deepEqual(core.entriesOfSlot(hero)[0].children?.[heroAlias], { kind: 'single', scope: 'root' })
    assert.equal(core.entries('connections.local.sidebarDirectoryFlow')[0].component, original)
    const Picker = core.entriesOfSlot(hero)[0].component as (props: Record<string, unknown>) => {
      props: { owner: Record<string, unknown>; renderLocal(owner: Record<string, unknown>): unknown }
    }
    let forwarded: Record<string, unknown> | undefined
    const owner = { open: true, busy: false, onPicked: () => {}, onCancel: () => {}, onError: () => {} }
    const rendered = Picker({ ...owner, t: () => 'wrong namespace', useStore: () => ({}),
      renderSlot: (_key: string, props: Record<string, unknown>) => { forwarded = props; return null } })
    rendered.props.renderLocal(rendered.props.owner)
    assert.deepEqual(forwarded, owner, 'framework locale/store props must not override the native picker injected face')
    removeHero()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(core.entries(heroAlias).length, 0)
    const replacement = () => null
    core.register({ name: hero, inject }, replacement)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(core.entries(heroAlias)[0].component, replacement)
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
