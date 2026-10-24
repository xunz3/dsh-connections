import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { WorkspaceEndpoint, installWorkspaceEndpoint } from '../src/host/workspace-endpoint.js'
import type { WorkspaceEndpointHandle, WorkspaceEndpointServices } from '../src/host/workspace-endpoint.js'
import {
  WORKSPACE_ENDPOINT, WORKSPACE_ERRORS, WORKSPACE_REQUEST_LIMIT, parseWorkspaceRequest, parseWorkspaceResponse,
  parseWorkspaceViewState,
} from '../src/shared/workspace-protocol.js'
import type { WorkspaceOperation, WorkspaceRequest, WorkspaceResponse, WorkspaceResultMap } from '../src/shared/workspace-protocol.js'

const secret = 'private-auth-token-must-not-escape'
function nativeServices() {
  const calls: Array<[string, unknown]> = []
  const row = { id: 'workspace-1', path: '/remote/project', title: 'Remote project', sessionIds: ['session-2', 'session-1'], privateToken: secret }
  const services: WorkspaceEndpointServices = {
    workspaceRegistry: { list: () => [row], archivedSessionIds: ['session-3'], pinnedSessionIds: ['session-1'] },
    workspaceController: {
      async rename(request) { calls.push(['renameWorkspace', request]); return { workspace: { ...row, title: request.title } } },
      async delete(request) { calls.push(['delete', request]); return { deleted: true, token: secret } },
      async archiveSession(request) { calls.push(['archive', request]) },
      async unarchiveSession(request) { calls.push(['unarchive', request]) },
      async pinSession(request) { calls.push(['pin', request]) },
      async unpinSession(request) { calls.push(['unpin', request]) },
    },
    sessionController: {
      async list(request, signal) {
        calls.push(['list', request]); signal.throwIfAborted()
        return { items: [
          { sessionId: 'session-1', cwd: row.path, updatedAt: 123, running: true, blank: false, projections: { values: { title: 'Native title', privateToken: secret } }, privateToken: secret },
          { sessionId: 'session-2', cwd: row.path, updatedAt: 1, running: false, blank: true, parentSessionId: 'session-1', origin: 'subagent' as const },
        ] }
      },
      async rename(request) { calls.push(['renameSession', request]); return { token: secret } },
    },
  }
  return { services, calls, row }
}
function request(body: unknown, signal?: AbortSignal): Request {
  return new Request(`http://127.0.0.1:3080${WORKSPACE_ENDPOINT}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
}
async function call<Op extends WorkspaceOperation>(endpoint: WorkspaceEndpointHandle, input: Extract<WorkspaceRequest, { op: Op }>, signal = new AbortController().signal): Promise<WorkspaceResultMap[Op]> {
  const response = await endpoint.handle(input, signal)
  assert.equal(response.ok, true, JSON.stringify(response))
  return (response as Extract<WorkspaceResponse<Op>, { ok: true }>).value
}
function failure(response: WorkspaceResponse, code: keyof typeof WORKSPACE_ERRORS): void {
  assert.deepEqual(response, { ok: false, error: { code, message: WORKSPACE_ERRORS[code] } })
}

test('registration uses native exact-route owner authorization and withdraws on unload', async () => {
  const ctx = new Context()
  const { services, calls } = nativeServices()
  const provider = ctx.plugin(child => {
    new HostConnectionService(child, [], {} as never)
    for (const [name, service] of Object.entries(services)) child.provide(name as never, service as never)
  })
  await provider
  let endpoint!: WorkspaceEndpointHandle
  const plugin = ctx.plugin(child => { endpoint = installWorkspaceEndpoint(child, { embedded: true }) })
  await plugin
  await nextTurn()
  const connection = ctx.get('connection') as HostConnectionService
  const shared = connection.createSharedFetchHandler('/api')
  const guest = connection.createPeer({ principal: { kind: 'workspace-test-guest' } as never })
  try {
    assert.equal(shared.requestBodyMode({ method: 'POST', url: new URL(`http://localhost${WORKSPACE_ENDPOINT}`) }), 'buffered')
    const denied = await shared.fetch(request({ op: 'catalog' }), guest)
    assert.equal(denied.status, 403)
    assert.deepEqual(calls, [])
    const result = await shared.fetch(request({ op: 'catalog' }), connection.browserPeer)
    assert.equal(result.status, 200)
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.equal((await result.json()).ok, true)
    assert.equal((await shared.fetch(new Request(`http://localhost${WORKSPACE_ENDPOINT}`), connection.browserPeer)).status, 404)
    assert.equal((await shared.fetch(new Request(`http://localhost${WORKSPACE_ENDPOINT}/other`, { method: 'POST' }), connection.browserPeer)).status, 404)
    const channel = (await call(endpoint, { op: 'openView' })).channel
    const pending = endpoint.handle({ op: 'pollView', channel, afterRevision: 0 }, new AbortController().signal)
    await plugin.dispose()
    failure(await pending, 'UNAVAILABLE')
    assert.equal((await shared.fetch(request({ op: 'catalog' }), connection.browserPeer)).status, 404)
    failure(await endpoint.handle({ op: 'catalog' }, new AbortController().signal), 'UNAVAILABLE')
  } finally { await plugin.dispose(); await provider.dispose() }
})

test('catalog rows are projections of native ownership and expose no native payloads', async () => {
  const { services, row, calls } = nativeServices()
  const endpoint = new WorkspaceEndpoint(services)
  try {
    assert.deepEqual(await call(endpoint, { op: 'catalog' }), {
      workspaces: [{ id: row.id, path: row.path, title: row.title, sessionIds: row.sessionIds }],
      sessions: [
        { id: 'session-1', title: 'Native title', cwd: row.path, updatedAt: 123, running: true, blank: false },
        { id: 'session-2', title: '', cwd: row.path, updatedAt: 1, running: false, blank: true, parentSessionId: 'session-1', origin: 'subagent' },
      ], archivedSessionIds: ['session-3'], pinnedSessionIds: ['session-1'],
    })
    assert.deepEqual(calls, [['list', {}]])
    row.title = 'Changed natively'
    row.sessionIds.reverse()
    assert.equal((await call(endpoint, { op: 'catalog' })).workspaces[0].title, 'Changed natively')
    assert.deepEqual((await call(endpoint, { op: 'catalog' })).workspaces[0].sessionIds, ['session-1', 'session-2'])
  } finally { endpoint.dispose() }
})

test('mutations delegate to native controllers without changing paths or stopping active work', async () => {
  const { services, calls } = nativeServices()
  const endpoint = new WorkspaceEndpoint(services)
  try {
    assert.equal((await call(endpoint, { op: 'renameWorkspace', id: 'workspace-1', title: 'Renamed' })).workspace.title, 'Renamed')
    for (const input of [
      { op: 'forgetWorkspace', id: 'workspace-1' }, { op: 'renameSession', id: 'session-1', title: 'Session name' },
      { op: 'archiveSession', id: 'session-1', archived: true }, { op: 'archiveSession', id: 'session-1', archived: false },
      { op: 'pinSession', id: 'session-1', pinned: true }, { op: 'pinSession', id: 'session-1', pinned: false },
    ] satisfies WorkspaceRequest[]) assert.deepEqual(await call(endpoint, input), { done: true })
    assert.deepEqual(calls, [
      ['renameWorkspace', { workspaceId: 'workspace-1', title: 'Renamed' }], ['delete', { workspaceId: 'workspace-1' }],
      ['renameSession', { sessionId: 'session-1', title: 'Session name' }], ['archive', { sessionId: 'session-1' }],
      ['unarchive', { sessionId: 'session-1' }], ['pin', { sessionId: 'session-1' }], ['unpin', { sessionId: 'session-1' }],
    ])
    services.workspaceController.archiveSession = async () => { throw Object.assign(new Error(secret), { code: 'workspace/session-active', details: { token: secret } }) }
    failure(await endpoint.handle({ op: 'archiveSession', id: 'session-1', archived: true }, new AbortController().signal), 'SESSION_ACTIVE')
  } finally { endpoint.dispose() }
})

test('view navigation wakes long polls, deduplicates requests and ignores stale acknowledgements', async () => {
  const endpoint = new WorkspaceEndpoint(nativeServices().services, { pollMs: 30 })
  try {
    const opened = await call(endpoint, { op: 'openView' })
    assert.match(opened.channel, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(opened.presentedRevision, 0)
    const channel = opened.channel
    const pending = call(endpoint, { op: 'pollView', channel, afterRevision: 0 })
    const first = await call(endpoint, { op: 'navigate', channel, requestId: 'request-1', target: { kind: 'workspace', id: 'workspace-1' } })
    assert.equal(first.revision, 1)
    assert.equal(first.presentedRevision, 0, 'accepting navigation does not mean the document has rendered')
    assert.deepEqual(await pending, first)
    assert.deepEqual(await call(endpoint, { op: 'navigate', channel, requestId: 'request-1', target: { kind: 'workspace', id: 'workspace-1' } }), first)
    await call(endpoint, { op: 'reportView', channel, revision: 1, sessionId: 'session-1' })
    const second = await call(endpoint, { op: 'navigate', channel, requestId: 'request-2', target: { kind: 'pick' } })
    assert.equal(second.revision, 2)
    assert.equal(second.reportedRevision, 1)
    assert.deepEqual(await call(endpoint, { op: 'navigate', channel, requestId: 'request-1', target: { kind: 'workspace', id: 'workspace-1' } }), second)
    failure(await endpoint.handle({ op: 'navigate', channel, requestId: 'request-1', target: { kind: 'session', id: 'session-1' } }, new AbortController().signal), 'CONFLICT')
    assert.deepEqual(await call(endpoint, { op: 'reportView', channel, revision: 1, sessionId: 'stale-session', error: 'NAVIGATION_FAILED' }), second)
    const acknowledged = await call(endpoint, { op: 'reportView', channel, revision: 2, sessionId: 'session-1', error: 'PICK_CANCELLED' })
    assert.equal(acknowledged.reportedRevision, 2)
    assert.equal(acknowledged.presentedRevision, 2, 'a final native report also acknowledges presentation')
    assert.equal(acknowledged.error, 'PICK_CANCELLED')
    assert.deepEqual(await call(endpoint, { op: 'reportView', channel, revision: 2, sessionId: 'session-1', error: 'PICK_CANCELLED' }), acknowledged)
    assert.deepEqual(await call(endpoint, { op: 'pollView', channel, afterRevision: 2 }), acknowledged)
    failure(await endpoint.handle({ op: 'pollView', channel, afterRevision: 3 }, new AbortController().signal), 'BAD_REQUEST')
  } finally { endpoint.dispose() }
})

test('presentation acknowledges visible native content without completing an open picker', async () => {
  const { services, calls } = nativeServices()
  const endpoint = new WorkspaceEndpoint(services)
  try {
    const { channel } = await call(endpoint, { op: 'openView' })
    await call(endpoint, { op: 'navigate', channel, requestId: 'first', target: { kind: 'session', id: 'session-1' } })
    const completed = await call(endpoint, { op: 'reportView', channel, revision: 1, sessionId: 'session-1' })
    assert.equal(completed.presentedRevision, 1)
    const pending = await call(endpoint, { op: 'navigate', channel, requestId: 'picker', target: { kind: 'pick' } })
    assert.equal(pending.revision, 2)
    assert.equal(pending.reportedRevision, 1)
    assert.equal(pending.presentedRevision, 1)
    const presented = await call(endpoint, { op: 'reportView', channel, revision: 2, presented: true })
    assert.deepEqual(presented, { ...pending, presentedRevision: 2 })
    assert.equal(presented.sessionId, 'session-1', 'presenting a picker does not clear the existing selection')
    assert.deepEqual(await call(endpoint, { op: 'reportView', channel, revision: 2, presented: true }), presented)
    failure(await endpoint.handle({ op: 'reportView', channel, revision: 3, presented: true }, new AbortController().signal), 'BAD_REQUEST')

    const next = await call(endpoint, { op: 'navigate', channel, requestId: 'new', target: { kind: 'newSession', id: 'workspace-1' } })
    assert.deepEqual(next.intent?.target, { kind: 'newSession', id: 'workspace-1' })
    assert.equal(next.presentedRevision, 2)
    assert.deepEqual(await call(endpoint, { op: 'reportView', channel, revision: 2, presented: true }), next, 'a superseded picker cannot acknowledge newer content')
    const final = await call(endpoint, { op: 'reportView', channel, revision: 3, sessionId: 'session-2' })
    assert.equal(final.reportedRevision, 3)
    assert.equal(final.presentedRevision, 3)
    assert.deepEqual(await call(endpoint, { op: 'reportView', channel, revision: 3, presented: true }), final, 'a retried presentation report preserves final state')
    const unscoped = await call(endpoint, { op: 'navigate', channel, requestId: 'unscoped', target: { kind: 'newSession' } })
    assert.deepEqual(unscoped.intent?.target, { kind: 'newSession' })
    assert.deepEqual(calls, [], 'new-session targets are delivered to native navigation, never executed by this endpoint')
  } finally { endpoint.dispose() }
})

test('presentation protocol treats older bundles as unpresented and validates new navigation fields', () => {
  assert.deepEqual(parseWorkspaceViewState({ revision: 4, reportedRevision: 4, sessionId: 'native-session' }), {
    revision: 4, reportedRevision: 4, presentedRevision: 0, sessionId: 'native-session',
  })
  for (const presentedRevision of [-1, 1.5, 5, '4', null]) {
    assert.throws(() => parseWorkspaceViewState({ revision: 4, reportedRevision: 4, presentedRevision }))
  }
  const channel = 'a'.repeat(43)
  for (const target of [
    { kind: 'newSession', id: '../workspace' }, { kind: 'newSession', id: '' },
    { kind: 'newSession', workspaceId: 'workspace-1' }, { kind: 'newSession', prompt: secret },
  ]) assert.throws(() => parseWorkspaceRequest({ op: 'navigate', channel, requestId: 'new', target }))
  for (const extra of [
    { presented: false }, { presented: 'true' },
    { presented: true, sessionId: 'session-1' }, { presented: true, error: 'PICK_CANCELLED' },
  ]) assert.throws(() => parseWorkspaceRequest({ op: 'reportView', channel, revision: 1, ...extra }))
  assert.deepEqual(parseWorkspaceRequest({ op: 'reportView', channel, revision: 1, presented: true }), {
    op: 'reportView', channel, revision: 1, presented: true,
  })
})

test('view channels renew on access, expire, respect capacity, and release waiters on close or cancellation', async () => {
  let now = 1000
  const endpoint = new WorkspaceEndpoint(nativeServices().services, { now: () => now, ttlMs: 200, maxChannels: 1 })
  try {
    const { channel } = await call(endpoint, { op: 'openView' })
    failure(await endpoint.handle({ op: 'openView' }, new AbortController().signal), 'CONFLICT')
    now += 199
    assert.equal((await call(endpoint, { op: 'viewState', channel })).revision, 0)
    now += 199
    const abort = new AbortController()
    const pending = endpoint.handle({ op: 'pollView', channel, afterRevision: 0 }, abort.signal)
    abort.abort()
    failure(await pending, 'CANCELLED')
    const closing = endpoint.handle({ op: 'pollView', channel, afterRevision: 0 }, new AbortController().signal)
    await call(endpoint, { op: 'closeView', channel })
    failure(await closing, 'NOT_FOUND')
    await call(endpoint, { op: 'closeView', channel })
    const next = await call(endpoint, { op: 'openView' })
    assert.notEqual(next.channel, channel)
    const expiring = endpoint.handle({ op: 'pollView', channel: next.channel, afterRevision: 0 }, new AbortController().signal)
    now += 201
    failure(await endpoint.handle({ op: 'viewState', channel: next.channel }, new AbortController().signal), 'NOT_FOUND')
    failure(await expiring, 'NOT_FOUND')
    await call(endpoint, { op: 'openView' })
  } finally { endpoint.dispose() }
})

test('invalid requests, unknown operations and native errors never reflect submitted secrets', async () => {
  const { services, calls } = nativeServices()
  const endpoint = new WorkspaceEndpoint(services)
  try {
    for (const body of [
      { op: 'prompt', prompt: secret }, { op: 'catalog', token: secret }, { op: 'renameSession', id: '../session', title: 'Title' },
      { op: 'listDirectories' }, { op: 'createDirectory', path: '/remote', name: 'new' }, { op: 'createWorkspace', path: '/remote' },
      { op: 'pinSession', id: 'session-1', pinned: 'true' }, { op: 'reportView', channel: secret, revision: -1, error: secret },
      { op: 'navigate', channel: 'a'.repeat(43), requestId: 'request-1', target: { kind: 'pick', id: 'session-1' } },
    ]) {
      const result = await endpoint.fetch(request(body))
      assert.equal(result.status, 400)
      assert.equal((await result.text()).includes(secret), false)
    }
    assert.deepEqual(calls, [])
    const large = await endpoint.fetch(request({ op: 'catalog', token: secret.repeat(WORKSPACE_REQUEST_LIMIT) }))
    assert.equal(large.status, 413)
    services.sessionController.list = async () => { throw new Error(`token=${secret}`) }
    const failed = await endpoint.fetch(request({ op: 'catalog' }))
    assert.equal(failed.status, 502)
    assert.equal((await failed.text()).includes(secret), false)
    assert.throws(() => parseWorkspaceRequest({ op: 'catalog', extra: true }))
    for (const ok of [true, false]) assert.throws(() => parseWorkspaceResponse('unknown' as WorkspaceOperation, { ok, value: {}, error: { code: 'FAILED', message: secret } }))
    assert.deepEqual(parseWorkspaceResponse('catalog', { ok: false, error: { code: 'FAILED', message: secret, token: secret } }), { ok: false, error: { code: 'FAILED', message: WORKSPACE_ERRORS.FAILED } })
  } finally { endpoint.dispose() }
})

test('catalog responses are bounded and cancellation reaches the native session service', async () => {
  const { services } = nativeServices()
  const endpoint = new WorkspaceEndpoint(services)
  try {
    services.workspaceRegistry.list = () => Array.from({ length: 1100 }, (_, index) => ({ id: `workspace-${index}`, path: `/${'p'.repeat(4000)}`, title: 'Project', sessionIds: [] }))
    failure(await endpoint.handle({ op: 'catalog' }, new AbortController().signal), 'TOO_LARGE')
    let nativeSignal: AbortSignal | undefined
    services.sessionController.list = async (_request, signal) => {
      nativeSignal = signal
      return await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error(secret)), { once: true }) })
    }
    const abort = new AbortController()
    const pending = endpoint.handle({ op: 'catalog' }, abort.signal)
    assert.equal(nativeSignal?.aborted, false)
    abort.abort()
    failure(await pending, 'CANCELLED')
    assert.equal(nativeSignal?.aborted, true)
  } finally { endpoint.dispose() }
})

test('a normal Host serves its catalog but refuses every remote content operation', async () => {
  const endpoint = new WorkspaceEndpoint(nativeServices().services, { embedded: false })
  const channel = 'a'.repeat(43)
  try {
    assert.equal((await call(endpoint, { op: 'catalog' })).workspaces.length, 1)
    for (const input of [
      { op: 'openView' }, { op: 'navigate', channel, requestId: 'request-1', target: { kind: 'pick' } },
      { op: 'pollView', channel, afterRevision: 0 }, { op: 'reportView', channel, revision: 0 },
      { op: 'viewState', channel }, { op: 'closeView', channel },
    ] satisfies WorkspaceRequest[]) failure(await endpoint.handle(input, new AbortController().signal), 'NOT_EMBEDDED')
  } finally { endpoint.dispose() }
})
