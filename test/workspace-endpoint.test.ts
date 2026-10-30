import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { WorkspaceEndpoint, installWorkspaceEndpoint } from '../src/host/workspace-endpoint.js'
import type { WorkspaceEndpointHandle, WorkspaceEndpointServices } from '../src/host/workspace-endpoint.js'
import {
  WORKSPACE_CATALOG_PAGE_LIMIT, WORKSPACE_PROTOCOL, WORKSPACE_ENDPOINT, WORKSPACE_ERRORS, WORKSPACE_REQUEST_LIMIT, WORKSPACE_RESPONSE_LIMIT, parseWorkspaceRequest, parseWorkspaceResponse,
  parseWorkspaceViewState, WorkspaceProtocolError,
} from '../src/shared/workspace-protocol.js'
import type { WorkspaceOperation, WorkspaceRequest, WorkspaceResponse, WorkspaceResultMap } from '../src/shared/workspace-protocol.js'
import { readWorkspaceCatalog, type WorkspaceApi } from '../src/shared/workspace-rpc.js'
import type { SettingsHostSnapshot } from '../src/shared/settings-host-protocol.js'

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

test('settings host metadata stays on its settings lease and consumes one validated selection', async () => {
  const endpoint = new WorkspaceEndpoint(nativeServices().services)
  const remote = 'connection-11111111-1111-4111-8111-111111111111'
  const other = 'connection-22222222-2222-4222-8222-222222222222'
  const snapshot: SettingsHostSnapshot = { choices: [
    { id: 'local', name: 'This computer', phase: 'connected' },
    { id: remote, name: 'Remote', phase: 'connected' },
    { id: other, name: 'Other', phase: 'disconnected' },
  ], selectedId: remote }
  const signal = new AbortController().signal
  try {
    const { channel } = await call(endpoint, { op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'settings-tab' })
    failure(await endpoint.handle({ op: 'pollSettingsHosts', channel, revision: 0 }, signal), 'CONFLICT')
    const { revision } = await call(endpoint, { op: 'navigate', channel, requestId: 'settings-one', target: { kind: 'settings' } })
    assert.deepEqual(await call(endpoint, { op: 'pollSettingsHosts', channel, revision }), { revision })
    const metadata = { ...snapshot, token: secret, choices: snapshot.choices.map(row => ({ ...row, target: secret })) }
    assert.deepEqual(await call(endpoint, { op: 'publishSettingsHosts', channel, revision, snapshot: metadata }), { revision, snapshot })
    failure(await endpoint.handle({ op: 'selectSettingsHost', channel, revision, id: 'local' }, signal), 'BAD_REQUEST')
    assert.deepEqual(await call(endpoint, { op: 'pollSettingsHosts', channel, revision }), { revision, snapshot, ready: true })
    failure(await endpoint.handle({ op: 'selectSettingsHost', channel, revision, id: remote }, signal), 'BAD_REQUEST')
    const selected = { revision, snapshot, ready: true, selection: 'local' }
    assert.deepEqual(await call(endpoint, { op: 'selectSettingsHost', channel, revision, id: 'local' }), selected)
    assert.deepEqual(await call(endpoint, { op: 'selectSettingsHost', channel, revision, id: 'local' }), selected, 'retry is idempotent')
    failure(await endpoint.handle({ op: 'selectSettingsHost', channel, revision, id: other }, signal), 'CONFLICT')
    const next = await call(endpoint, { op: 'navigate', channel, requestId: 'settings-two', target: { kind: 'settings' } })
    failure(await endpoint.handle({ op: 'selectSettingsHost', channel, revision, id: 'local' }, signal), 'CONFLICT')
    assert.deepEqual(await call(endpoint, { op: 'pollSettingsHosts', channel, revision: next.revision }), { revision: next.revision }, 'navigation revokes old metadata and readiness')
    await call(endpoint, { op: 'navigate', channel, requestId: 'session', target: { kind: 'session', id: 'session-1' } })
    failure(await endpoint.handle({ op: 'publishSettingsHosts', channel, revision: next.revision + 1, snapshot }, signal), 'CONFLICT')
    await call(endpoint, { op: 'closeView', channel })
    failure(await endpoint.handle({ op: 'pollSettingsHosts', channel, revision: next.revision }, signal), 'NOT_FOUND')
  } finally { endpoint.dispose() }
})

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
    const denied = await shared.fetch(request({ op: 'catalog', protocol: WORKSPACE_PROTOCOL }), guest)
    assert.equal(denied.status, 403)
    assert.deepEqual(calls, [])
    const result = await shared.fetch(request({ op: 'catalog', protocol: WORKSPACE_PROTOCOL }), connection.browserPeer)
    assert.equal(result.status, 200)
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.equal((await result.json()).ok, true)
    assert.equal((await shared.fetch(new Request(`http://localhost${WORKSPACE_ENDPOINT}`), connection.browserPeer)).status, 404)
    assert.equal((await shared.fetch(new Request(`http://localhost${WORKSPACE_ENDPOINT}/other`, { method: 'POST' }), connection.browserPeer)).status, 404)
    const channel = (await call(endpoint, { op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'tab-1' })).channel
    const pending = endpoint.handle({ op: 'pollView', channel, afterRevision: 0 }, new AbortController().signal)
    await plugin.dispose()
    failure(await pending, 'UNAVAILABLE')
    assert.equal((await shared.fetch(request({ op: 'catalog', protocol: WORKSPACE_PROTOCOL }), connection.browserPeer)).status, 404)
    failure(await endpoint.handle({ op: 'catalog', protocol: WORKSPACE_PROTOCOL }, new AbortController().signal), 'UNAVAILABLE')
  } finally { await plugin.dispose(); await provider.dispose() }
})

test('catalog rows are projections of native ownership and expose no native payloads', async () => {
  const { services, row, calls } = nativeServices()
  const endpoint = new WorkspaceEndpoint(services)
  try {
    const { protocol, revision, ...catalog } = await call(endpoint, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
    assert.equal(protocol, WORKSPACE_PROTOCOL)
    assert.match(revision, /^[A-Za-z0-9_-]{43}$/)
    assert.deepEqual(catalog, {
      workspaces: [{ id: row.id, path: row.path, title: row.title, sessionIds: row.sessionIds }],
      sessions: [
        { id: 'session-1', title: 'Native title', cwd: row.path, updatedAt: 123, running: true, blank: false },
        { id: 'session-2', title: '', cwd: row.path, updatedAt: 1, running: false, blank: true, parentSessionId: 'session-1', origin: 'subagent' },
      ], archivedSessionIds: ['session-3'], pinnedSessionIds: ['session-1'],
    })
    assert.deepEqual(calls, [['list', {}]])
    row.title = 'Changed natively'
    row.sessionIds.reverse()
    assert.equal((await call(endpoint, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })).workspaces[0].title, 'Changed natively')
    assert.deepEqual((await call(endpoint, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })).workspaces[0].sessionIds, ['session-1', 'session-2'])
  } finally { endpoint.dispose() }
})

test('catalog paths preserve filesystem characters, empty cwd and deep paths without corrupting the snapshot', async () => {
  const { services, row } = nativeServices()
  const paths = ['/tmp/a\nb', '/tmp/x\ty', '/tmp/\x1b\x7f', `/${'directory/'.repeat(1024)}`]
  services.workspaceRegistry.list = () => paths.map((path, index) => ({ ...row, id: `workspace-${index}`, path }))
  services.sessionController.list = async () => ({ items: [...paths, ''].map((cwd, index) => ({
    sessionId: `session-${index}`, cwd, updatedAt: 1, running: false, blank: false,
  })) })
  const endpoint = new WorkspaceEndpoint(services)
  try {
    const page = await call(endpoint, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
    assert.deepEqual(page.workspaces.map(row => row.path), paths)
    assert.deepEqual(page.sessions.map(row => row.cwd), [...paths, ''])
    assert.deepEqual(parseWorkspaceResponse('catalog', JSON.parse(JSON.stringify({ ok: true, value: page }))), { ok: true, value: page })
    assert.throws(() => parseWorkspaceResponse('catalog', { ok: true, value: { ...page, workspaces: [{ ...page.workspaces[0], path: '/tmp/\0invalid' }] } }))
    services.workspaceRegistry.list = () => [{ ...row, path: `/${'x'.repeat(WORKSPACE_CATALOG_PAGE_LIMIT)}` }]
    failure(await endpoint.handle({ op: 'catalog', protocol: WORKSPACE_PROTOCOL }, new AbortController().signal), 'TOO_LARGE')
  } finally { endpoint.dispose() }
})

test('mutations delegate to native controllers without changing paths or stopping active work', async () => {
  const { services, calls } = nativeServices()
  const endpoint = new WorkspaceEndpoint(services)
  try {
    assert.deepEqual(await call(endpoint, { op: 'renameWorkspace', id: 'workspace-1', title: 'Renamed' }), { done: true })
    for (const input of [
      { op: 'forgetWorkspace', id: 'workspace-1' }, { op: 'renameSession', id: 'session-1', title: 'Session name' },
      { op: 'archiveSession', id: 'session-1', archived: true }, { op: 'archiveSession', id: 'session-1', archived: false },
      { op: 'archiveSession', id: 'session-1', archived: true, stopActivity: true },
      { op: 'pinSession', id: 'session-1', pinned: true }, { op: 'pinSession', id: 'session-1', pinned: false },
    ] satisfies WorkspaceRequest[]) assert.deepEqual(await call(endpoint, input), { done: true })
    assert.deepEqual(calls, [
      ['renameWorkspace', { workspaceId: 'workspace-1', title: 'Renamed' }], ['delete', { workspaceId: 'workspace-1' }],
      ['renameSession', { sessionId: 'session-1', title: 'Session name' }], ['archive', { sessionId: 'session-1' }],
      ['unarchive', { sessionId: 'session-1' }], ['archive', { sessionId: 'session-1', stopActivity: true }],
      ['pin', { sessionId: 'session-1' }], ['unpin', { sessionId: 'session-1' }],
    ])
    services.workspaceController.archiveSession = async () => { throw Object.assign(new Error(secret), { code: 'workspace/session-active', details: { token: secret } }) }
    failure(await endpoint.handle({ op: 'archiveSession', id: 'session-1', archived: true }, new AbortController().signal), 'SESSION_ACTIVE')
  } finally { endpoint.dispose() }
})

test('archive stops native activity only with explicit archive confirmation', () => {
  const request = { op: 'archiveSession', id: 'session-1', archived: true }
  assert.deepEqual(parseWorkspaceRequest(request), request)
  assert.deepEqual(parseWorkspaceRequest({ ...request, stopActivity: true }), { ...request, stopActivity: true })
  for (const stopActivity of [false, 'true', 1, null]) {
    assert.throws(() => parseWorkspaceRequest({ ...request, stopActivity }))
  }
  assert.throws(() => parseWorkspaceRequest({ ...request, archived: false, stopActivity: true }))
})

test('view navigation wakes long polls, deduplicates requests and ignores stale acknowledgements', async () => {
  const endpoint = new WorkspaceEndpoint(nativeServices().services, { pollMs: 30 })
  try {
    const opened = await call(endpoint, { op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'tab-1' })
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
    const { channel } = await call(endpoint, { op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'tab-1' })
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

test('presentation protocol rejects older bundles immediately and validates navigation fields', () => {
  assert.throws(() => parseWorkspaceViewState({ revision: 4, reportedRevision: 4, sessionId: 'native-session' }),
    (error: unknown) => error instanceof WorkspaceProtocolError && error.code === 'INCOMPATIBLE_PROTOCOL')
  for (const presentedRevision of [-1, 1.5, 5, '4', null]) {
    assert.throws(() => parseWorkspaceViewState({ revision: 4, reportedRevision: 4, presentedRevision }))
  }
  const channel = 'a'.repeat(43)
  assert.deepEqual(parseWorkspaceRequest({ op: 'navigate', channel, requestId: 'settings', target: { kind: 'settings' } }), {
    op: 'navigate', channel, requestId: 'settings', target: { kind: 'settings' },
  })
  assert.deepEqual(parseWorkspaceRequest({ op: 'navigate', channel, requestId: 'plugins', target: { kind: 'plugins' } }), {
    op: 'navigate', channel, requestId: 'plugins', target: { kind: 'plugins' },
  })
  for (const target of [
    { kind: 'newSession', id: '../workspace' }, { kind: 'newSession', id: '' },
    { kind: 'newSession', workspaceId: 'workspace-1' }, { kind: 'newSession', prompt: secret },
    { kind: 'settings', url: 'http://example.com' }, { kind: 'settings', id: 'plugin' },
    { kind: 'plugins', id: 'arbitrary-panel' }, { kind: 'plugins', method: 'installBundle' }, { kind: 'plugins', package: '@scope/plugin' },
  ]) assert.throws(() => parseWorkspaceRequest({ op: 'navigate', channel, requestId: 'new', target }))
  for (const extra of [
    { presented: false }, { presented: 'true' },
    { presented: true, sessionId: 'session-1' }, { presented: true, error: 'PICK_CANCELLED' },
  ]) assert.throws(() => parseWorkspaceRequest({ op: 'reportView', channel, revision: 1, ...extra }))
  assert.deepEqual(parseWorkspaceRequest({ op: 'reportView', channel, revision: 1, presented: true }), {
    op: 'reportView', channel, revision: 1, presented: true,
  })
})

test('settings navigation has a native presentation and close acknowledgement without mutating workspaces', async () => {
  const { services, calls } = nativeServices()
  const endpoint = new WorkspaceEndpoint(services)
  try {
    const { channel } = await call(endpoint, { op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'tab-settings' })
    const intent = await call(endpoint, { op: 'navigate', channel, requestId: 'settings', target: { kind: 'settings' } })
    assert.deepEqual(intent.intent?.target, { kind: 'settings' })
    const visible = await call(endpoint, { op: 'reportView', channel, revision: intent.revision, presented: true })
    assert.equal(visible.presentedRevision, intent.revision)
    assert.equal(visible.reportedRevision, 0)
    const closed = await call(endpoint, { op: 'reportView', channel, revision: intent.revision, error: 'SETTINGS_CLOSED' })
    assert.equal(closed.reportedRevision, intent.revision)
    assert.equal(closed.error, 'SETTINGS_CLOSED')
    assert.deepEqual(calls, [])
  } finally { endpoint.dispose() }
})

test('reload replaces the same tab lease while other tabs and stale cleanup stay isolated', async () => {
  const endpoint = new WorkspaceEndpoint(nativeServices().services, { maxChannels: 2 })
  try {
    const other = await call(endpoint, { op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'other-tab' })
    let active = await call(endpoint, { op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'reloaded-tab' })
    for (let reload = 0; reload < 40; reload++) {
      const previous = active
      const waiting = endpoint.handle({ op: 'pollView', channel: previous.channel, afterRevision: 0 }, new AbortController().signal)
      active = await call(endpoint, { op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'reloaded-tab' })
      assert.notEqual(active.channel, previous.channel)
      failure(await waiting, 'NOT_FOUND')
      await call(endpoint, { op: 'closeView', channel: previous.channel })
      assert.equal((await call(endpoint, { op: 'viewState', channel: active.channel })).revision, 0)
      assert.equal((await call(endpoint, { op: 'viewState', channel: other.channel })).revision, 0)
    }
    failure(await endpoint.handle({ op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'third-tab' }, new AbortController().signal), 'CONFLICT')
    await call(endpoint, { op: 'closeView', channel: active.channel })
    await call(endpoint, { op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'third-tab' })
    for (const clientId of [undefined, '', '../tab', 'tab\n', 'x'.repeat(257)]) {
      assert.throws(() => parseWorkspaceRequest({ op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId }))
    }
  } finally { endpoint.dispose() }
})

test('view channels renew on access, expire, respect capacity, and release waiters on close or cancellation', async () => {
  let now = 1000
  const endpoint = new WorkspaceEndpoint(nativeServices().services, { now: () => now, ttlMs: 200, maxChannels: 1 })
  try {
    const { channel } = await call(endpoint, { op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'tab-1' })
    failure(await endpoint.handle({ op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'tab-2' }, new AbortController().signal), 'CONFLICT')
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
    const next = await call(endpoint, { op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'tab-1' })
    assert.notEqual(next.channel, channel)
    const expiring = endpoint.handle({ op: 'pollView', channel: next.channel, afterRevision: 0 }, new AbortController().signal)
    now += 201
    failure(await endpoint.handle({ op: 'viewState', channel: next.channel }, new AbortController().signal), 'NOT_FOUND')
    failure(await expiring, 'NOT_FOUND')
    await call(endpoint, { op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'tab-1' })
  } finally { endpoint.dispose() }
})

test('invalid requests, unknown operations and native errors never reflect submitted secrets', async () => {
  const { services, calls } = nativeServices()
  const endpoint = new WorkspaceEndpoint(services)
  try {
    for (const body of [
      { op: 'prompt', prompt: secret }, { op: 'catalog', protocol: WORKSPACE_PROTOCOL, token: secret }, { op: 'renameSession', id: '../session', title: 'Title' },
      { op: 'listDirectories' }, { op: 'createDirectory', path: '/remote', name: 'new' }, { op: 'createWorkspace', path: '/remote' },
      { op: 'pinSession', id: 'session-1', pinned: 'true' }, { op: 'reportView', channel: secret, revision: -1, error: secret },
      { op: 'navigate', channel: 'a'.repeat(43), requestId: 'request-1', target: { kind: 'pick', id: 'session-1' } },
    ]) {
      const result = await endpoint.fetch(request(body))
      assert.equal(result.status, 400)
      assert.equal((await result.text()).includes(secret), false)
    }
    assert.deepEqual(calls, [])
    const large = await endpoint.fetch(request({ op: 'catalog', protocol: WORKSPACE_PROTOCOL, token: secret.repeat(WORKSPACE_REQUEST_LIMIT) }))
    assert.equal(large.status, 413)
    services.sessionController.list = async () => { throw new Error(`token=${secret}`) }
    const failed = await endpoint.fetch(request({ op: 'catalog', protocol: WORKSPACE_PROTOCOL }))
    assert.equal(failed.status, 502)
    assert.equal((await failed.text()).includes(secret), false)
    assert.throws(() => parseWorkspaceRequest({ op: 'catalog', protocol: WORKSPACE_PROTOCOL, extra: true }))
    for (const ok of [true, false]) assert.throws(() => parseWorkspaceResponse('unknown' as WorkspaceOperation, { ok, value: {}, error: { code: 'FAILED', message: secret } }))
    assert.deepEqual(parseWorkspaceResponse('catalog', { ok: false, error: { code: 'FAILED', message: secret, token: secret } }), { ok: false, error: { code: 'FAILED', message: WORKSPACE_ERRORS.FAILED } })
  } finally { endpoint.dispose() }
})

test('large catalogs are paged below the transport limit and cancellation reaches the native session service', async () => {
  const { services } = nativeServices()
  const endpoint = new WorkspaceEndpoint(services)
  try {
    services.workspaceRegistry.list = () => Array.from({ length: 1100 }, (_, index) => ({ id: `workspace-${index}`, path: `/${'p'.repeat(4000)}`, title: 'Project', sessionIds: [] }))
    const page = await call(endpoint, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
    assert.ok(page.nextCursor)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < WORKSPACE_CATALOG_PAGE_LIMIT)
    let nativeSignal: AbortSignal | undefined
    services.sessionController.list = async (_request, signal) => {
      nativeSignal = signal
      return await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error(secret)), { once: true }) })
    }
    const abort = new AbortController()
    const pending = endpoint.handle({ op: 'catalog', protocol: WORKSPACE_PROTOCOL }, abort.signal)
    assert.equal(nativeSignal?.aborted, false)
    abort.abort()
    failure(await pending, 'CANCELLED')
    assert.equal(nativeSignal?.aborted, true)
  } finally { endpoint.dispose() }
})

test('catalog synchronization preserves large workspace membership and skips unchanged payloads', async () => {
  const { services, row } = nativeServices()
  const sessionIds = Array.from({ length: 23_000 }, (_, index) => `session-${index}-${'x'.repeat(200)}`)
  const workspaceRows = [{ ...row, sessionIds }, ...Array.from({ length: 1100 }, (_, index) => ({ id: `large-${index}`, path: `/${'p'.repeat(4000)}`, title: 'Project', sessionIds: [] }))]
  services.workspaceRegistry.list = () => workspaceRows
  const endpoint = new WorkspaceEndpoint(services)
  const requests: WorkspaceRequest[] = []
  let wireBytes = 0
  const api: WorkspaceApi = {
    async workspace<R extends WorkspaceRequest>(_id: string, request: R): Promise<WorkspaceResultMap[R['op']]> {
      requests.push(request)
      const response = await endpoint.handle(request, new AbortController().signal)
      if (!response.ok) throw new WorkspaceProtocolError(response.error.code)
      const bytes = Buffer.byteLength(JSON.stringify(response))
      assert.ok(bytes < WORKSPACE_CATALOG_PAGE_LIMIT)
      wireBytes += bytes
      return response.value as WorkspaceResultMap[R['op']]
    },
  }
  try {
    const first = await readWorkspaceCatalog(api, 'local')
    assert.equal(first.catalog.workspaces.length, 1101)
    assert.deepEqual(first.catalog.workspaces[0]!.sessionIds, sessionIds)
    assert.ok(wireBytes > WORKSPACE_RESPONSE_LIMIT, 'the complete catalog exceeds the old 4 MB transport limit')
    assert.ok(requests.length > 1)
    services.workspaceController.rename = async request => ({ workspace: { ...workspaceRows[0]!, title: request.title } })
    assert.deepEqual(await call(endpoint, { op: 'renameWorkspace', id: row.id, title: 'Renamed' }), { done: true }, 'successful renames do not return the unbounded membership list')
    requests.length = 0
    wireBytes = 0
    assert.equal(await readWorkspaceCatalog(api, 'local', first), first)
    assert.deepEqual(requests, [{ op: 'catalog', protocol: WORKSPACE_PROTOCOL, ifRevision: first.revision }])
    assert.ok(wireBytes < 256, 'unchanged refreshes carry metadata only')
    workspaceRows[0]!.title = 'Changed natively'
    const changed = await readWorkspaceCatalog(api, 'local', first)
    assert.notEqual(changed.revision, first.revision)
    assert.equal(changed.catalog.workspaces[0]!.title, 'Changed natively')
    assert.equal(first.catalog.workspaces[0]!.title, row.title)
  } finally { endpoint.dispose() }
})

test('catalog readers finish immutable revisions and restart expired pagination without mixing data', async () => {
  const { services } = nativeServices()
  const rows = Array.from({ length: 100 }, (_, index) => ({ id: `workspace-${index}`, path: `/${'p'.repeat(4000)}`, title: 'Initial', sessionIds: [] }))
  services.workspaceRegistry.list = () => rows
  let now = 0
  const endpoint = new WorkspaceEndpoint(services, { now: () => now })
  const api: WorkspaceApi = {
    async workspace<R extends WorkspaceRequest>(_id: string, input: R): Promise<WorkspaceResultMap[R['op']]> {
      const response = await endpoint.handle(input, new AbortController().signal)
      if (!response.ok) throw new WorkspaceProtocolError(response.error.code)
      if (input.op === 'catalog' && !input.cursor && now === 0) {
        now = 120_001
        for (const row of rows) row.title = 'Updated'
      }
      return response.value as WorkspaceResultMap[R['op']]
    },
  }
  try {
    const firstPage = await call(endpoint, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
    assert.ok(firstPage.nextCursor)
    for (const row of rows) row.title = 'Other revision'
    await call(endpoint, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
    const previousPage = await call(endpoint, { op: 'catalog', protocol: WORKSPACE_PROTOCOL, cursor: firstPage.nextCursor })
    assert.equal(previousPage.revision, firstPage.revision)
    assert.ok(previousPage.workspaces.every(row => row.title === 'Initial'))
    const result = await readWorkspaceCatalog(api, 'local')
    assert.equal(result.catalog.workspaces.length, rows.length)
    assert.ok(result.catalog.workspaces.every(row => row.title === 'Updated'))
    failure(await endpoint.handle({ op: 'catalog', protocol: WORKSPACE_PROTOCOL, cursor: firstPage.nextCursor }, new AbortController().signal), 'CATALOG_EXPIRED')
  } finally { endpoint.dispose() }
})

test('each cursor read renews its immutable snapshot across a slow multi-page transfer', async () => {
  const { services } = nativeServices()
  const rows = Array.from({ length: 200 }, (_, index) => ({ id: `workspace-${index}`, path: `/${'p'.repeat(4000)}`, title: 'Initial', sessionIds: [] }))
  services.workspaceRegistry.list = () => rows
  let now = 0
  const endpoint = new WorkspaceEndpoint(services, { now: () => now })
  try {
    let page = await call(endpoint, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
    const revision = page.revision
    let count = page.workspaces.length
    let pages = 1
    while (page.nextCursor) {
      now += 61_000
      rows[0]!.title = `New native revision ${now}`
      await call(endpoint, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
      page = await call(endpoint, { op: 'catalog', protocol: WORKSPACE_PROTOCOL, cursor: page.nextCursor })
      assert.equal(page.revision, revision)
      assert.ok(page.workspaces.every(row => row.title === 'Initial'))
      count += page.workspaces.length
      pages++
    }
    assert.equal(count, rows.length)
    assert.ok(pages >= 4)
    assert.ok(now > 120_000)
    now += 120_001
    failure(await endpoint.handle({ op: 'catalog', protocol: WORKSPACE_PROTOCOL, cursor: `${revision}.1` }, new AbortController().signal), 'CATALOG_EXPIRED')
  } finally { endpoint.dispose() }
})

test('catalog history evicts idle revisions before a reader that keeps renewing its cursor', async () => {
  const { services } = nativeServices()
  const rows = Array.from({ length: 100 }, (_, index) => ({ id: `workspace-${index}`, path: `/${'p'.repeat(4000)}`, title: 'Initial', sessionIds: [] }))
  services.workspaceRegistry.list = () => rows
  const endpoint = new WorkspaceEndpoint(services)
  try {
    const active = await call(endpoint, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
    let idleCursor = ''
    for (let update = 1; update <= 8; update++) {
      rows[0]!.title = `Updated ${update}`
      const next = await call(endpoint, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
      if (update === 1) idleCursor = next.nextCursor!
      await call(endpoint, { op: 'catalog', protocol: WORKSPACE_PROTOCOL, cursor: active.nextCursor })
    }
    failure(await endpoint.handle({ op: 'catalog', protocol: WORKSPACE_PROTOCOL, cursor: idleCursor }, new AbortController().signal), 'CATALOG_EXPIRED')
    assert.equal((await call(endpoint, { op: 'catalog', protocol: WORKSPACE_PROTOCOL, cursor: active.nextCursor })).revision, active.revision)
  } finally { endpoint.dispose() }
})

test('protocol versions and catalog cursors fail explicitly instead of accepting incompatible results', async () => {
  const empty = { workspaces: [], sessions: [], archivedSessionIds: [], pinnedSessionIds: [] }
  const incompatible = (error: unknown) => error instanceof WorkspaceProtocolError && error.code === 'INCOMPATIBLE_PROTOCOL'
  for (const protocol of [undefined, 0, 1, WORKSPACE_PROTOCOL - 1, WORKSPACE_PROTOCOL + 1]) {
    for (const op of ['catalog', 'openView']) assert.throws(() => parseWorkspaceRequest({ op, protocol }), incompatible)
    assert.throws(() => parseWorkspaceResponse('catalog', { ok: true, value: { ...empty, protocol, revision: 'a'.repeat(43) } }), incompatible)
    assert.throws(() => parseWorkspaceResponse('openView', { ok: true, value: { protocol, channel: 'a'.repeat(43), revision: 0, reportedRevision: 0 } }), incompatible)
    assert.throws(() => parseWorkspaceResponse('openView', { ok: true, value: { protocol } }), incompatible)
  }
  for (const input of [
    { op: 'catalog', protocol: WORKSPACE_PROTOCOL, ifRevision: 'invalid' },
    { op: 'catalog', protocol: WORKSPACE_PROTOCOL, cursor: `${'a'.repeat(43)}.0` },
    { op: 'catalog', protocol: WORKSPACE_PROTOCOL, ifRevision: 'a'.repeat(43), cursor: `${'a'.repeat(43)}.1` },
  ]) assert.throws(() => parseWorkspaceRequest(input))
  assert.throws(() => parseWorkspaceResponse('catalog', { ok: true, value: { ...empty, protocol: WORKSPACE_PROTOCOL, revision: 'a'.repeat(43), nextCursor: `${'b'.repeat(43)}.1` } }))
  await assert.rejects(readWorkspaceCatalog({ async workspace() { throw new WorkspaceProtocolError('BAD_REQUEST') } }, 'local', { revision: 'a'.repeat(43), catalog: empty }), incompatible)
  const endpoint = new WorkspaceEndpoint(nativeServices().services)
  try {
    for (const op of ['catalog', 'openView']) {
      const response = await endpoint.fetch(request({ op }))
      assert.equal(response.status, 409)
      failure(await response.json(), 'INCOMPATIBLE_PROTOCOL')
    }
  } finally { endpoint.dispose() }
})

test('a normal Host serves its catalog but refuses every remote content operation', async () => {
  const endpoint = new WorkspaceEndpoint(nativeServices().services, { embedded: false })
  const channel = 'a'.repeat(43)
  try {
    assert.equal((await call(endpoint, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })).workspaces.length, 1)
    for (const input of [
      { op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'tab-1' }, { op: 'navigate', channel, requestId: 'request-1', target: { kind: 'pick' } },
      { op: 'pollView', channel, afterRevision: 0 }, { op: 'reportView', channel, revision: 0 },
      { op: 'viewState', channel }, { op: 'closeView', channel },
    ] satisfies WorkspaceRequest[]) failure(await endpoint.handle(input, new AbortController().signal), 'NOT_EMBEDDED')
  } finally { endpoint.dispose() }
})
