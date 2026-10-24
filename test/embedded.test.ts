import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { EmbeddedLayoutController } from '../src/client/embedded-layout.js'
import { EmbeddedViewController, embeddedChannel, embeddedEndpoint, type EmbeddedEndpoint } from '../src/client/embedded.js'
import type { WorkspaceRequest, WorkspaceViewState } from '../src/shared/workspace-protocol.js'

const channel = 'a'.repeat(43)
const intent = (revision: number, target: NonNullable<WorkspaceViewState['intent']>['target']): WorkspaceViewState => ({
  revision, reportedRevision: revision - 1, intent: { revision, requestId: `request-${revision}`, target },
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

function fixture(initial: WorkspaceViewState) {
  const selection = createSnapshotStore<{ key: string | undefined }>({ key: 'previous' })
  const layout = new EmbeddedLayoutController(() => true)
  const opened: string[] = []
  const created: string[] = []
  const blockedWorkspaces = new Map<string, Promise<void>>()
  let create = async () => ({ workspaceId: 'created' })
  const context = {
    layout,
    uiSession: { adapter: { current: selection } },
    sessions: { list: createSnapshotStore({ phase: 'ready' }) },
    workspaces: {
      list: createSnapshotStore({ phase: 'ready' }),
      create: async ({ path }: { path: string }) => { created.push(path); return create() },
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
      return { ...current, reportedRevision: request.revision, sessionId: request.sessionId, error: request.error }
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
  const controller = new EmbeddedViewController(context as unknown as Context, channel, endpoint)
  return {
    controller, context, selection, reports, opened, created, blockedWorkspaces,
    get abortedPolls() { return abortedPolls },
    setCreate(value: typeof create) { create = value },
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
    return new Response(JSON.stringify({ ok: true, value: { revision: 1, reportedRevision: 0, intent: { revision: 1, requestId: 'request-1', target: { kind: 'session', id: 'valid' } } } }))
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

test('cancelling native directory selection preserves the session and ignores late picker callbacks', async t => {
  const f = fixture(intent(1, { kind: 'pick' }))
  t.after(() => f.controller.dispose())
  f.controller.start()
  await until(() => f.controller.state.getSnapshot().picker !== undefined)
  const owner = f.controller.pickerOwner(f.controller.state.getSnapshot().picker!.generation)
  owner.onCancel()
  owner.onPicked('/late')
  owner.onError('late failure')
  await until(() => f.reports.length === 1)
  assert.equal(f.selection.getSnapshot().key, 'previous')
  assert.equal(f.reports[0].error, 'PICK_CANCELLED')
  assert.equal(f.reports[0].sessionId, 'previous')
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
  const owner = f.controller.pickerOwner(f.controller.state.getSnapshot().picker!.generation)
  owner.onPicked('/project')
  owner.onPicked('/duplicate')
  owner.onCancel()
  assert.deepEqual(f.created, ['/project'])
  f.push(intent(2, { kind: 'session', id: 'newer' }))
  await until(() => f.reports.some(report => report.revision === 2))
  creation.resolve({ workspaceId: 'stale' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.opened, ['newer'])
  assert.equal(f.selection.getSnapshot().key, 'newer')
  assert.equal(f.reports.some(report => report.revision === 1), false)
})

test('picked directories use native workspace adoption and navigation before reporting selection', async t => {
  const f = fixture(intent(1, { kind: 'pick' }))
  t.after(() => f.controller.dispose())
  f.controller.start()
  await until(() => f.controller.state.getSnapshot().picker !== undefined)
  f.controller.pickerOwner(f.controller.state.getSnapshot().picker!.generation).onPicked('/project')
  await until(() => f.reports.length === 1)
  assert.deepEqual(f.created, ['/project'])
  assert.deepEqual(f.opened, ['created-session'])
  assert.equal(f.reports[0].sessionId, 'created-session')
  assert.equal(f.reports[0].error, undefined)
  assert.equal(f.controller.state.getSnapshot().picker, undefined)
})

test('failed directory adoption preserves selection and reports only the navigation error enum', async t => {
  const f = fixture(intent(1, { kind: 'pick' }))
  t.after(() => f.controller.dispose())
  f.setCreate(async () => { throw new Error('private native diagnostic') })
  f.controller.start()
  await until(() => f.controller.state.getSnapshot().picker !== undefined)
  f.controller.pickerOwner(f.controller.state.getSnapshot().picker!.generation).onPicked('/project')
  await until(() => f.reports.length === 1)
  assert.equal(f.reports[0].error, 'NAVIGATION_FAILED')
  assert.equal(f.reports[0].sessionId, 'previous')
  assert.equal(JSON.stringify(f.reports).includes('private'), false)
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
  assert.equal(f.reports.some(report => report.revision === 1), false)
})

test('acknowledged reload restores its session without replaying a picker, then follows native selection', async t => {
  const f = fixture({ ...intent(7, { kind: 'pick' }), reportedRevision: 7, sessionId: 'restored' })
  t.after(() => f.controller.dispose())
  f.controller.start()
  await until(() => f.reports.length > 0)
  assert.deepEqual(f.opened, ['restored'])
  assert.equal(f.controller.state.getSnapshot().picker, undefined)
  f.selection.set({ key: 'native-fork' })
  await until(() => f.reports.some(report => report.sessionId === 'native-fork'))
  assert.equal(f.reports.at(-1)?.revision, 7)
  assert.equal(f.reports.at(-1)?.error, undefined)
})

test('disposal aborts polling and ignores native selection and unfinished workspace adoption', async () => {
  const f = fixture(intent(1, { kind: 'pick' }))
  const creation = deferred<{ workspaceId: string }>()
  f.setCreate(() => creation.promise)
  f.controller.start()
  await until(() => f.controller.state.getSnapshot().picker !== undefined)
  f.controller.pickerOwner(f.controller.state.getSnapshot().picker!.generation).onPicked('/project')
  f.controller.dispose()
  f.controller.dispose()
  creation.resolve({ workspaceId: 'disposed' })
  f.selection.set({ key: 'later' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.abortedPolls, 1)
  assert.deepEqual(f.opened, [])
  assert.deepEqual(f.reports, [])
})
