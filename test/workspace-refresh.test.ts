import { CONNECTION_CONTRACTS } from '../src/shared/contracts.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceController } from '../src/client/workspace-controller.js'
import type { ConnectionView } from '../src/shared/types.js'
import { WORKSPACE_PROTOCOL, type WorkspaceRequest, type WorkspaceResultMap, type WorkspaceViewState } from '../src/shared/workspace-protocol.js'

const id = 'connection-11111111-1111-4111-a111-111111111111'
const nextTick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  let lists = 0, checks = 0, channels = 0, closes = 0, presented = true
  let row: ConnectionView = { id, name: 'Remote', target: 'dev', phase: 'connected', localPort: 43188, transportId: crypto.randomUUID() }
  const views = new Map<string, WorkspaceViewState>()
  const f = {
    get lists() { return lists }, get checks() { return checks }, get closes() { return closes },
    get presented() { return presented }, set presented(value: boolean) { presented = value },
    get row() { return row }, set row(value: ConnectionView) { row = value },
    async catalog() { return { protocol: WORKSPACE_PROTOCOL, revision: 'a'.repeat(43), workspaces: [], sessions: [], archivedSessionIds: [], pinnedSessionIds: [] } },
    api: {
      async list() { lists++; return [structuredClone(row)] },
      async connect() { return structuredClone(row) },
      async reconnect() { return structuredClone(row) },
      async open() { return { url: 'http://127.0.0.1:43188/?token=test-private-credential' } },
      async workspace<R extends WorkspaceRequest>(_id: string, request: R): Promise<WorkspaceResultMap[R['op']]> {
        let result: unknown
        switch (request.op) {
          case 'catalog': result = await f.catalog(); break
          case 'openView': {
            const channel = String(++channels).padStart(43, 'a')
            const view = { revision: 0, reportedRevision: 0, presentedRevision: 0 }
            views.set(channel, view); result = { ...view, channel, protocol: WORKSPACE_PROTOCOL, contracts: { ...CONNECTION_CONTRACTS } }; break
          }
          case 'navigate': {
            const revision = views.get(request.channel)!.revision + 1
            const view = { revision, reportedRevision: revision, presentedRevision: presented ? revision : 0 }
            views.set(request.channel, view); result = view; break
          }
          case 'viewState': {
            checks++
            const view = views.get(request.channel)!
            result = { ...view, presentedRevision: presented ? view.revision : 0 }; break
          }
          case 'closeView': closes++; views.delete(request.channel); result = { closed: true }; break
          default: throw new Error(`Unexpected operation ${request.op}`)
        }
        return result as WorkspaceResultMap[R['op']]
      },
    },
  }
  return f
}

test('a steady-state catalog refresh reuses its one list for view health', async t => {
  const f = fixture(), controller = new WorkspaceController(f.api, { catalogs: false })
  t.after(() => controller.dispose())
  await controller.open(id, { kind: 'session', id: 'chat' })
  await nextTick(); await controller.check()
  assert.equal(controller.getSnapshot()?.presented, true)
  const before = { lists: f.lists, checks: f.checks }
  await controller.refresh(false)
  assert.equal(f.lists - before.lists, 1, 'refresh must not sequentially fetch list twice')
  assert.equal(f.checks - before.checks, 1)
  const explicitLists = f.lists
  await controller.check()
  assert.equal(f.lists - explicitLists, 1, 'standalone health checks still sample current authority')
})

test('a slow catalog cannot apply its old transport sample to a newly opened view', async t => {
  const f = fixture(), controller = new WorkspaceController(f.api, { catalogs: false })
  t.after(() => controller.dispose())
  await controller.open(id, { kind: 'session', id: 'first-chat' })
  await nextTick(); await controller.check()
  const entered = deferred<void>(), release = deferred<void>(), catalog = f.catalog
  f.catalog = async () => { entered.resolve(); await release.promise; return catalog() }
  t.after(() => release.resolve())
  const refresh = controller.refresh()
  await entered.promise
  f.row = { ...f.row, transportId: crypto.randomUUID() }
  await controller.open(id, { kind: 'session', id: 'second-chat' })
  await nextTick(); await controller.check()
  const checks = f.checks, lists = f.lists
  release.resolve(); await refresh
  assert.equal(controller.getSnapshot()?.phase, 'ready')
  assert.equal(f.checks, checks, 'stale catalog check is skipped instead of reading the replacement lease')
  assert.equal(f.lists, lists, 'stale catalog check does not add another list either')
})

test('an unpresented view has no hidden watchdog RPC or hidden-time timeout and reconciles on resume', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 })
  const f = fixture(), controller = new WorkspaceController(f.api, { catalogs: false, presentationTimeoutMs: 30_000 })
  f.presented = false
  t.after(() => controller.dispose())
  await controller.open(id, { kind: 'pick' })
  await nextTick()
  assert.equal(controller.getSnapshot()?.presented, false)
  controller.setVisible(false)
  const before = { lists: f.lists, checks: f.checks, closes: f.closes }
  t.mock.timers.tick(10 * 60_000)
  await nextTick()
  assert.deepEqual({ lists: f.lists, checks: f.checks, closes: f.closes }, before)
  assert.equal(controller.getSnapshot()?.phase, 'ready')
  f.presented = true
  controller.setVisible(true)
  await nextTick()
  assert.equal(controller.getSnapshot()?.presented, true)
  assert.equal(f.checks - before.checks, 1)
  t.mock.timers.tick(60_000)
  await nextTick()
  assert.equal(controller.getSnapshot()?.phase, 'ready')
})

test('a check started before hiding cannot issue its second RPC or block the resumed visibility epoch', async t => {
  const f = fixture(), controller = new WorkspaceController(f.api, { catalogs: false })
  const waiting = deferred<ConnectionView[]>()
  t.after(() => { waiting.resolve([]); controller.dispose() })
  await controller.open(id, { kind: 'session', id: 'chat' })
  await nextTick()
  const list = f.api.list
  let held = false
  f.api.list = () => { if (!held) { held = true; return waiting.promise }; return list() }
  const old = controller.check()
  controller.setVisible(false)
  const checks = f.checks
  await controller.check()
  assert.equal(f.checks, checks)
  controller.setVisible(true)
  await controller.check()
  assert.equal(f.checks, checks + 1, 'an unresponsive previous foreground check cannot coalesce away the resumed read')
  waiting.resolve([])
  await old
  assert.equal(f.checks, checks + 1, 'the pre-hide list reply cannot continue with a viewState RPC')
  assert.equal(controller.getSnapshot()?.phase, 'ready', 'an obsolete missing-row response cannot close the resumed view')
})

test('a late viewState from a hidden visibility epoch cannot publish its navigation failure after resume', async t => {
  const f = fixture(), controller = new WorkspaceController(f.api, { catalogs: false })
  const waiting = deferred<WorkspaceViewState>(), entered = deferred<void>()
  t.after(() => { waiting.resolve({ revision: 1, reportedRevision: 1, presentedRevision: 1 }); controller.dispose() })
  await controller.open(id, { kind: 'session', id: 'chat' })
  await nextTick()
  const workspace = f.api.workspace
  let held = false
  f.api.workspace = (source, request) => {
    if (request.op === 'viewState' && !held) { held = true; entered.resolve(); return waiting.promise as never }
    return workspace(source, request)
  }
  const old = controller.check()
  await entered.promise
  controller.setVisible(false)
  controller.setVisible(true)
  await controller.check()
  waiting.resolve({ revision: 1, reportedRevision: 1, presentedRevision: 1, error: 'NAVIGATION_FAILED' })
  await old
  assert.equal(controller.getSnapshot()?.phase, 'ready')
  assert.equal(f.closes, 0, 'a hidden generation never revokes the currently reconciled lease')
})

test('presentation timeout retains its remaining visible budget instead of resetting on every hide', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 })
  const f = fixture(), controller = new WorkspaceController(f.api, { catalogs: false, presentationTimeoutMs: 1000 })
  f.presented = false
  t.after(() => controller.dispose())
  await controller.open(id, { kind: 'pick' })
  await nextTick()
  t.mock.timers.tick(400)
  controller.setVisible(false)
  t.mock.timers.tick(10 * 60_000)
  await nextTick()
  controller.setVisible(true)
  await nextTick()
  t.mock.timers.tick(599)
  assert.equal(controller.getSnapshot()?.phase, 'ready')
  t.mock.timers.tick(1)
  assert.equal(controller.getSnapshot()?.error, 'timeout')
  assert.equal(f.closes, 1)
})
