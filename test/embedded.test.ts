import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInThisContext } from 'node:vm'
import { buildSync } from 'esbuild'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { EmbeddedLayoutController } from '../src/client/embedded-layout.js'
import type { EmbeddedEndpoint } from '../src/client/embedded.js'
import type { EmbeddedSettingsAdapter } from '../src/client/embedded-settings.js'
import type { WorkspaceRequest, WorkspaceViewState } from '../src/shared/workspace-protocol.js'

// Exercise the controller without loading the native visual package's browser
// CSS. Native browser tests render the real header and menu components.
const nativeRequire = createRequire(import.meta.url)
const module = { exports: {} as typeof import('../src/client/embedded.js') }
const compiled = buildSync({ entryPoints: ['src/client/embedded.tsx'], bundle: true, packages: 'external', format: 'cjs', write: false }).outputFiles[0].text
runInThisContext(`(function(module, exports, require) { ${compiled}\n})`)(module, module.exports,
  (id: string) => id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : nativeRequire(id))
const { EmbeddedViewController, embeddedChannel, embeddedEndpoint } = module.exports

const channel = 'a'.repeat(43)
const intent = (revision: number, target: NonNullable<WorkspaceViewState['intent']>['target']): WorkspaceViewState => ({
  revision, reportedRevision: revision - 1, presentedRevision: revision - 1, intent: { revision, requestId: `request-${revision}`, target },
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 30 && !predicate(); attempt++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(predicate(), true, 'expected the asynchronous state transition to settle')
}

function fixture(initial: WorkspaceViewState, settings?: EmbeddedSettingsAdapter) {
  const selection = createSnapshotStore<{ key: string | undefined }>({ key: 'previous' })
  const layout = new EmbeddedLayoutController(() => true)
  const opened: string[] = []
  const created: string[] = []
  const started: Array<string | undefined> = []
  const blockedWorkspaces = new Map<string, Promise<void>>()
  let create = async () => ({ workspaceId: 'created' })
  let start = async (id: string | undefined) => `${id ?? 'project'}-new-session`
  const workspaceList = createSnapshotStore({ phase: 'ready', items: [{ workspaceId: 'project' }] })
  const context = {
    layout,
    uiSession: { adapter: { current: selection } },
    sessions: { list: createSnapshotStore({ phase: 'ready' }) },
    workspaces: {
      list: workspaceList,
      create: async ({ path }: { path: string }) => {
        created.push(path)
        const result = await create()
        workspaceList.update(value => { value.items.push({ workspaceId: result.workspaceId }) })
        return result
      },
    },
    uiWorkspace: {
      openSession: (id: string) => { opened.push(id); selection.set({ key: id }); layout.selectPanel(null) },
      openWorkspace: async (id: string, beforeOpen: (id: string) => void) => {
        const signal = layout.beginNavigation()
        await blockedWorkspaces.get(id)
        if (signal.aborted) return
        const session = `${id}-session`
        beforeOpen(session)
        opened.push(session)
        selection.set({ key: session })
        layout.selectPanel(null)
      },
      startSession: (id?: string) => {
        started.push(id)
        const signal = layout.beginNavigation()
        void start(id).then(session => {
          if (signal.aborted) return
          opened.push(session)
          selection.set({ key: session })
          layout.selectPanel(null)
        })
      },
    },
  }
  type Report = Extract<WorkspaceRequest, { op: 'reportView' }>
  const reports: Report[] = []
  let current = initial
  const queued = [initial]
  let deliver: ((state: WorkspaceViewState) => void) | undefined
  let abortedPolls = 0
  const endpoint: EmbeddedEndpoint = async (request, signal) => {
    if (request.op === 'reportView') {
      reports.push(request)
      current = request.presented === true ? { ...current, presentedRevision: request.revision }
        : { ...current, reportedRevision: request.revision, presentedRevision: request.revision, sessionId: request.sessionId, error: request.error }
      return current
    }
    const next = queued.shift()
    if (next) return next
    return new Promise((resolve, reject) => {
      const abort = () => { abortedPolls++; deliver = undefined; reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      deliver = value => { signal.removeEventListener('abort', abort); deliver = undefined; resolve(value) }
      if (signal.aborted) abort()
    })
  }
  const controller = new EmbeddedViewController(context as unknown as Context, channel, endpoint, undefined, settings)
  return {
    controller, context, selection, reports, opened, created, started, blockedWorkspaces,
    get finalReports() { return reports.filter(report => report.presented !== true) },
    presentPicker() { controller.pickerPresented(controller.state.getSnapshot().picker!.generation) },
    get abortedPolls() { return abortedPolls },
    setCreate(value: typeof create) { create = value },
    setStart(value: typeof start) { start = value },
    push(value: WorkspaceViewState) { current = value; if (deliver) deliver(value); else queued.push(value) },
  }
}

test('embedded channels accept only one complete view capability', () => {
  assert.equal(embeddedChannel(`#connections-view=${channel}`), channel)
  assert.equal(embeddedChannel(`#connections-view=${channel}&connections-view=${channel}`), undefined)
  assert.equal(embeddedChannel('#connections-view=short'), undefined)
  assert.equal(embeddedChannel('#connections-view=https://example.com'), undefined)
  assert.equal(embeddedChannel(''), undefined)
})

test('embedded endpoint uses same-origin owner authentication and validates the response', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const endpoint = embeddedEndpoint({ baseURI: 'http://127.0.0.1:1234/#connections-view=secret' }, async (url, init) => {
    requests.push({ url: String(url), init: init! })
    return new Response(JSON.stringify({ ok: true, value: { revision: 1, reportedRevision: 0, presentedRevision: 0, intent: { revision: 1, requestId: 'request-1', target: { kind: 'session', id: 'valid' } } } }))
  })
  const signal = new AbortController().signal
  assert.equal((await endpoint({ op: 'pollView', channel, afterRevision: 0 }, signal)).revision, 1)
  assert.equal(requests[0].url, 'http://127.0.0.1:1234/api/connections/workspaces')
  assert.equal(requests[0].init.credentials, 'same-origin')
  assert.equal(requests[0].init.redirect, 'error')
  assert.equal(requests[0].init.signal, signal)
  const invalid = embeddedEndpoint({ baseURI: 'http://localhost/' }, async () => new Response('{"ok":true,"value":{"revision":-1,"reportedRevision":0}}'))
  await assert.rejects(invalid({ op: 'pollView', channel, afterRevision: 0 }, signal))
})

test('a mounted picker reports presentation once without completing navigation or changing selection', async t => {
  const f = fixture(intent(1, { kind: 'pick' }))
  t.after(() => f.controller.dispose())
  f.controller.start()
  await until(() => f.controller.state.getSnapshot().picker !== undefined)
  assert.deepEqual(f.reports, [], 'accepting the picker intent is not evidence that it mounted')
  const generation = f.controller.state.getSnapshot().picker!.generation
  f.controller.pickerPresented(generation - 1)
  assert.deepEqual(f.reports, [], 'a stale mount must not acknowledge the current picker')
  f.presentPicker()
  f.presentPicker()
  await until(() => f.reports.length === 1)
  assert.deepEqual(f.reports[0], { op: 'reportView', channel, revision: 1, presented: true })
  f.selection.set({ key: 'native-background-selection' })
  assert.equal(f.finalReports.length, 0, 'the open picker still owns navigation')
  assert.equal(f.controller.state.getSnapshot().picker?.generation, generation)
  f.controller.pickerOwner(generation).onCancel()
  await until(() => f.finalReports.length === 1)
  f.controller.pickerPresented(generation)
  assert.equal(f.reports.length, 2, 'unmounted picker callbacks cannot replace the final result')
  assert.equal(f.finalReports[0].error, 'PICK_CANCELLED')
})

test('new-session targets use native startSession and report only after a new selection arrives', async t => {
  for (const id of ['project', undefined]) await t.test(id ?? 'native inferred workspace', async t => {
    const f = fixture(intent(1, { kind: 'newSession', ...(id === undefined ? {} : { id }) }))
    t.after(() => f.controller.dispose())
    const creation = deferred<string>()
    f.setStart(() => creation.promise)
    f.controller.start()
    await until(() => f.started.length === 1)
    assert.deepEqual(f.started, [id])
    assert.equal(f.finalReports.length, 0)
    assert.equal(f.selection.getSnapshot().key, 'previous')
    creation.resolve('fresh-native-session')
    await until(() => f.finalReports.length === 1)
    assert.equal(f.finalReports[0].sessionId, 'fresh-native-session')
    assert.equal(f.finalReports[0].error, undefined)
    assert.deepEqual(f.created, [], 'existing workspaces need no directory adoption')
  })
})

test('new session without any workspace uses the native picker then creates a fresh native session', async t => {
  const f = fixture(intent(1, { kind: 'newSession' }))
  t.after(() => f.controller.dispose())
  f.context.workspaces.list.set({ phase: 'ready', items: [] })
  f.controller.start()
  await until(() => f.controller.state.getSnapshot().picker !== undefined)
  assert.deepEqual(f.started, [])
  assert.equal(f.finalReports.length, 0)
  f.presentPicker()
  await until(() => f.reports.length === 1)
  assert.equal(f.reports[0].presented, true)
  f.controller.pickerOwner(f.controller.state.getSnapshot().picker!.generation).onPicked('/fresh-project')
  await until(() => f.finalReports.length === 1)
  assert.deepEqual(f.created, ['/fresh-project'])
  assert.deepEqual(f.started, ['created'])
  assert.deepEqual(f.opened, ['created-new-session'])
  assert.equal(f.finalReports[0].sessionId, 'created-new-session')
})

test('a superseded new-session creation cannot report or select its late result', async t => {
  const f = fixture(intent(1, { kind: 'newSession', id: 'project' }))
  t.after(() => f.controller.dispose())
  const creation = deferred<string>()
  f.setStart(() => creation.promise)
  f.controller.start()
  await until(() => f.started.length === 1)
  f.push(intent(2, { kind: 'session', id: 'newer' }))
  await until(() => f.finalReports.some(report => report.revision === 2))
  creation.resolve('obsolete')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.opened, ['newer'])
  assert.equal(f.finalReports.some(report => report.revision === 1), false)
})

test('new-session targets for a removed workspace fail before invoking native creation', async t => {
  const f = fixture(intent(1, { kind: 'newSession', id: 'missing' }))
  t.after(() => f.controller.dispose())
  f.controller.start()
  await until(() => f.finalReports.length === 1)
  assert.deepEqual(f.started, [])
  assert.equal(f.finalReports[0].error, 'NAVIGATION_FAILED')
})

test('cancelling native directory selection preserves the session and ignores late picker callbacks', async t => {
  const f = fixture(intent(1, { kind: 'pick' }))
  t.after(() => f.controller.dispose())
  f.controller.start()
  await until(() => f.controller.state.getSnapshot().picker !== undefined)
  f.presentPicker()
  const owner = f.controller.pickerOwner(f.controller.state.getSnapshot().picker!.generation)
  owner.onCancel()
  owner.onPicked('/late')
  owner.onError('late failure')
  await until(() => f.finalReports.length === 1)
  assert.equal(f.selection.getSnapshot().key, 'previous')
  assert.equal(f.finalReports[0].error, 'PICK_CANCELLED')
  assert.equal(f.finalReports[0].sessionId, 'previous')
  assert.deepEqual(f.created, [])
  assert.equal(f.controller.state.getSnapshot().picker, undefined)
  assert.equal(f.controller.state.getSnapshot().message, undefined)
})

test('a later navigation supersedes directory adoption without opening its eventual workspace', async t => {
  const f = fixture(intent(1, { kind: 'pick' }))
  t.after(() => f.controller.dispose())
  const creation = deferred<{ workspaceId: string }>()
  f.setCreate(() => creation.promise)
  f.controller.start()
  await until(() => f.controller.state.getSnapshot().picker !== undefined)
  f.presentPicker()
  const owner = f.controller.pickerOwner(f.controller.state.getSnapshot().picker!.generation)
  owner.onPicked('/project')
  owner.onPicked('/duplicate')
  owner.onCancel()
  assert.deepEqual(f.created, ['/project'])
  f.push(intent(2, { kind: 'session', id: 'newer' }))
  await until(() => f.finalReports.some(report => report.revision === 2))
  creation.resolve({ workspaceId: 'stale' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.opened, ['newer'])
  assert.equal(f.selection.getSnapshot().key, 'newer')
  assert.equal(f.finalReports.some(report => report.revision === 1), false)
})

test('picked directories use native workspace adoption and navigation before reporting selection', async t => {
  const f = fixture(intent(1, { kind: 'pick' }))
  t.after(() => f.controller.dispose())
  f.controller.start()
  await until(() => f.controller.state.getSnapshot().picker !== undefined)
  f.presentPicker()
  f.controller.pickerOwner(f.controller.state.getSnapshot().picker!.generation).onPicked('/project')
  await until(() => f.finalReports.length === 1)
  assert.deepEqual(f.created, ['/project'])
  assert.deepEqual(f.opened, ['created-session'])
  assert.equal(f.finalReports[0].sessionId, 'created-session')
  assert.equal(f.finalReports[0].error, undefined)
  assert.equal(f.controller.state.getSnapshot().picker, undefined)
})

test('failed directory adoption preserves selection and reports only the navigation error enum', async t => {
  const f = fixture(intent(1, { kind: 'pick' }))
  t.after(() => f.controller.dispose())
  f.setCreate(async () => { throw new Error('private native diagnostic') })
  f.controller.start()
  await until(() => f.controller.state.getSnapshot().picker !== undefined)
  f.presentPicker()
  f.controller.pickerOwner(f.controller.state.getSnapshot().picker!.generation).onPicked('/project')
  await until(() => f.finalReports.length === 1)
  assert.equal(f.finalReports[0].error, 'NAVIGATION_FAILED')
  assert.equal(f.finalReports[0].sessionId, 'previous')
  assert.equal(JSON.stringify(f.finalReports).includes('private'), false)
  assert.equal(f.controller.state.getSnapshot().message, 'failed')
  assert.deepEqual(f.opened, [])
})

test('new session navigation aborts native pending workspace navigation', async t => {
  const f = fixture(intent(1, { kind: 'workspace', id: 'slow' }))
  t.after(() => f.controller.dispose())
  const blocked = deferred<void>()
  f.blockedWorkspaces.set('slow', blocked.promise)
  f.controller.start()
  await until(() => f.controller.state.getSnapshot().message === undefined)
  await new Promise(resolve => setImmediate(resolve))
  f.push(intent(2, { kind: 'session', id: 'newer' }))
  await until(() => f.selection.getSnapshot().key === 'newer')
  blocked.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.opened, ['newer'])
  assert.equal(f.finalReports.some(report => report.revision === 1), false)
})

test('acknowledged reload restores its session without replaying a picker, then follows native selection', async t => {
  const f = fixture({ ...intent(7, { kind: 'pick' }), reportedRevision: 7, sessionId: 'restored' })
  t.after(() => f.controller.dispose())
  f.controller.start()
  await until(() => f.finalReports.length > 0)
  assert.deepEqual(f.opened, ['restored'])
  assert.equal(f.controller.state.getSnapshot().picker, undefined)
  f.selection.set({ key: 'native-fork' })
  await until(() => f.finalReports.some(report => report.sessionId === 'native-fork'))
  assert.equal(f.finalReports.at(-1)?.revision, 7)
  assert.equal(f.finalReports.at(-1)?.error, undefined)
})

test('disposal aborts polling and ignores native selection and unfinished workspace adoption', async () => {
  const f = fixture(intent(1, { kind: 'pick' }))
  const creation = deferred<{ workspaceId: string }>()
  f.setCreate(() => creation.promise)
  f.controller.start()
  await until(() => f.controller.state.getSnapshot().picker !== undefined)
  f.presentPicker()
  f.controller.pickerOwner(f.controller.state.getSnapshot().picker!.generation).onPicked('/project')
  f.controller.dispose()
  f.controller.dispose()
  creation.resolve({ workspaceId: 'disposed' })
  f.selection.set({ key: 'later' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.abortedPolls, 1)
  assert.deepEqual(f.opened, [])
  assert.equal(f.finalReports.length, 0)
})

test('a reused native blank session is acknowledged only after native navigation completes', async t => {
  const f = fixture(intent(1, { kind: 'newSession', id: 'project' }))
  t.after(() => f.controller.dispose())
  const creation = deferred<string>()
  f.setStart(() => creation.promise)
  f.controller.start()
  await until(() => f.started.length === 1)
  f.context.layout.measure(1200)
  f.context.layout.resize(400)
  f.context.layout.showSettings(true)
  assert.equal(f.finalReports.length, 0, 'geometry changes do not acknowledge a pending native command')
  creation.resolve('previous')
  await until(() => f.finalReports.length === 1)
  assert.equal(f.finalReports[0].sessionId, 'previous')
  assert.equal(f.finalReports[0].error, undefined)
})

test('settings report presentation without changing session and only report a native close on demand', async t => {
  const commit = deferred<void>()
  let opens = 0
  const settings: EmbeddedSettingsAdapter = { open: async () => { opens++; await commit.promise }, close() {} }
  const f = fixture(intent(1, { kind: 'settings' }), settings)
  t.after(() => f.controller.dispose())
  f.controller.start()
  await until(() => opens === 1)
  assert.equal(f.finalReports.length, 0)
  commit.resolve()
  await until(() => f.finalReports.length === 1)
  assert.deepEqual(f.finalReports[0], { op: 'reportView', channel, revision: 1 })
  f.selection.set({ key: 'native-onboarding-selection' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.finalReports.length, 1, 'settings cannot leak native onboarding selections to the parent conversation')
  f.controller.settingsClosed()
  await until(() => f.finalReports.length === 2)
  assert.equal(f.finalReports[1].error, 'SETTINGS_CLOSED')
  assert.equal(f.finalReports[1].sessionId, undefined)
})
