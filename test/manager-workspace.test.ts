import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import test from 'node:test'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { ConnectionsManager } from '../src/host/manager.js'
import { createStore } from '../src/host/store.js'
import type { Tunnel } from '../src/host/ssh.js'
import { WORKSPACE_ENDPOINT, WORKSPACE_PROTOCOL, WorkspaceProtocolError, type WorkspaceRequest } from '../src/shared/workspace-protocol.js'

const token = 'workspace-manager-private-launch-token'
const secret = 'remote-private-payload-not-for-public-projections'
const catalog = (title: string) => ({ ok: true, value: {
  protocol: WORKSPACE_PROTOCOL, revision: 'a'.repeat(43),
  workspaces: [{ id: 'workspace-1', path: '/remote/project', title, sessionIds: [] }],
  sessions: [], archivedSessionIds: [], pinnedSessionIds: [],
} })
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function credentials() {
  const records = new Map<CredentialKey, CredentialRecord>()
  return {
    records,
    async listRecords() { return [...records].map(([key, record]) => ({ key, kind: record.kind })) },
    async readRecord(key: CredentialKey) { return records.get(key) },
    async modifyRecord(key: CredentialKey, mutate: (value: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      const value = await mutate(records.get(key))
      if (value) records.set(key, value)
      return records.get(key)
    },
    async deleteRecord(key: CredentialKey) { records.delete(key) },
  }
}
function tunnel(port: number): Tunnel & { closes: number } {
  const listeners = new Set<(error?: Error) => void>()
  let closed = false
  return {
    port, closes: 0,
    async close() { if (!closed) { closed = true; this.closes++; for (const listener of [...listeners]) listener() } },
    onClose(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
function cookie(authority: string, counter: number): string {
  const name = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
  const payload = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, counter })).toString('base64url')
  return `${name}=v1.${payload}.${Buffer.alloc(32, 6).toString('base64url')}`
}
async function remote(title = 'Remote') {
  const state = {
    auth: 0, posts: 0, cookies: [] as string[], receivedCookies: [] as string[],
    workspaceSockets: [] as Socket[],
    onAuth: undefined as ((request: IncomingMessage, response: ServerResponse, reply: () => void) => void) | undefined,
    onPost: undefined as ((request: IncomingMessage, response: ServerResponse, input: { op: string }) => void) | undefined,
  }
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === `/?token=${token}`) {
      state.auth++
      const pair = cookie(request.headers.host!, state.auth)
      state.cookies.push(pair)
      const reply = () => { response.writeHead(303, { location: './', 'set-cookie': `${pair}; Path=/; HttpOnly; SameSite=Strict` }); response.end() }
      if (state.onAuth) state.onAuth(request, response, reply)
      else reply()
      return
    }
    if (request.method !== 'POST' || request.url !== WORKSPACE_ENDPOINT) { response.writeHead(404); response.end(); return }
    state.posts++
    state.workspaceSockets.push(request.socket)
    state.receivedCookies.push(request.headers.cookie ?? '')
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString()) as { op: string }
      if (state.onPost) state.onPost(request, response, input)
      else {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ...catalog(title), secret, value: { ...catalog(title).value, cookie: state.cookies.at(-1), secret } }))
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    ...state,
    state,
    port: address.port,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  }
}
async function setup(ports: Record<string, number>) {
  const provider = credentials()
  const store = createStore(provider)
  const tunnels: Array<Tunnel & { closes: number }> = []
  const manager = new ConnectionsManager(store, {
    async connectTunnel({ target }) {
      const created = tunnel(ports[target]!)
      tunnels.push(created)
      return created
    },
  })
  const add = async (target: string) => {
    const saved = await manager.save({ name: target, target, launchUrl: `http://127.0.0.1:3080/?token=${token}` })
    await manager.connect(saved.id)
    return saved.id
  }
  return { manager, add, provider, store, tunnels }
}
function safeRejection(error: unknown): boolean {
  assert.ok(error instanceof Error)
  assert.equal(error.message.includes(token), false)
  assert.equal(error.message.includes(secret), false)
  assert.equal(error.message.includes('dsh-auth-'), false)
  return true
}

test('workspace calls share a Host-only cookie without exposing or persisting it', async () => {
  const host = await remote()
  const { manager, add, provider } = await setup({ dev: host.port })
  try {
    const id = await add('dev')
    const results = await Promise.all(Array.from({ length: 4 }, () => manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })))
    results.forEach(result => assert.deepEqual(result, catalog('Remote')))
    await manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
    assert.equal(host.state.auth, 1)
    assert.equal(host.state.posts, 5)
    assert.ok(host.state.receivedCookies.every(value => value === host.state.cookies[0]))
    for (const publicValue of [results, await manager.list(), await manager.connect(id)]) {
      const serialized = JSON.stringify(publicValue)
      assert.equal(serialized.includes(token), false)
      assert.equal(serialized.includes(secret), false)
      assert.equal(serialized.includes('dsh-auth-'), false)
    }
    assert.equal(JSON.stringify([...provider.records.values()]).includes('dsh-auth-'), false)
    await manager.disconnect(id)
    await manager.connect(id)
    await manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
    assert.equal(host.state.auth, 2)
    assert.equal(host.state.receivedCookies.at(-1), host.state.cookies[1])
  } finally { await manager.dispose(); await host.close() }
})

const mutations: WorkspaceRequest[] = [
  { op: 'renameWorkspace', id: 'workspace-1', title: 'Renamed' },
  { op: 'forgetWorkspace', id: 'workspace-1' },
  { op: 'renameSession', id: 'session-1', title: 'Renamed' },
  { op: 'archiveSession', id: 'session-1', archived: true },
  { op: 'pinSession', id: 'session-1', pinned: true },
]
const conflict = (error: unknown) => error instanceof WorkspaceProtocolError && error.code === 'CONFLICT'

test('workspace writes require an observed transport while unguarded reads remain compatible', async () => {
  const host = await remote()
  const { manager, add } = await setup({ dev: host.port })
  try {
    const id = await add('dev')
    const transportId = (await manager.list())[0]!.transportId!
    assert.ok(transportId)
    for (const request of mutations) {
      await assert.rejects(manager.workspace(id, request), conflict)
      await assert.rejects(manager.workspace(id, request, 'stale-transport'), conflict)
    }
    await assert.rejects(manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL }, 'stale-transport'), conflict)
    assert.equal(host.state.posts, 0, 'rejected authorities cannot reach any remote workspace operation')
    assert.equal(host.state.auth, 1, 'rejected authorities cannot start another authentication exchange')
    assert.deepEqual(await manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL }), catalog('Remote'))
    host.state.onPost = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, value: { done: true } }))
    }
    for (const request of mutations) assert.deepEqual(await manager.workspace(id, request, transportId), { ok: true, value: { done: true } })
    assert.equal(host.state.posts, 6)
  } finally { await manager.dispose(); await host.close() }
})

for (const change of ['destination', 'same-origin-reconnect'] as const) test(`a delayed workspace mutation cannot cross a ${change} authority replacement`, async () => {
  const first = await remote('First'), second = await remote('Second')
  const { manager, add } = await setup({ dev: first.port, other: second.port })
  const entered = deferred(), release = deferred()
  let writes: Promise<void> | undefined
  try {
    const id = await add('dev')
    const observed = (await manager.list())[0]!
    // Model another browser retaining a catalog/list sample while this browser
    // changes that same saved connection id before the delayed RPC is admitted.
    writes = (async () => {
      entered.resolve()
      await release.promise
      await Promise.all(mutations.map(request => assert.rejects(manager.workspace(id, request, observed.transportId), conflict)))
      await assert.rejects(manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL }, observed.transportId), conflict)
    })()
    void writes.catch(() => {})
    await entered.promise
    if (change === 'destination') {
      await manager.save({ id, name: 'Changed', target: 'other', launchUrl: `http://127.0.0.1:3080/?token=${token}` })
      await manager.connect(id)
    } else await manager.reconnect(id)
    const current = (await manager.list())[0]!
    assert.equal(current.phase, 'connected')
    assert.notEqual(current.transportId, observed.transportId)
    if (change === 'same-origin-reconnect') assert.equal(current.localPort, observed.localPort, 'a port alone is not an authority identity')
    release.resolve()
    await writes
    assert.equal(first.state.posts, 0)
    assert.equal(second.state.posts, 0, 'the replacement Host must receive zero business writes from the stale caller')
    assert.deepEqual((await manager.list())[0], current)
  } finally {
    release.resolve()
    await Promise.allSettled([writes])
    await manager.dispose()
    await first.close()
    await second.close()
  }
})

test('workspace pools end with their transport and a replacement on the same port gets a fresh socket', async () => {
  for (const action of ['disconnect', 'remove', 'edit', 'unload', 'drop', 'reconnect'] as const) {
    const host = await remote()
    const { manager, add, tunnels } = await setup({ dev: host.port })
    try {
      const id = await add('dev')
      await manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
      await manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
      const first = host.state.workspaceSockets[0]!
      assert.equal(first, host.state.workspaceSockets[1])
      const closed = once(first, 'close', { signal: AbortSignal.timeout(2000) })
      if (action === 'disconnect') await manager.disconnect(id)
      else if (action === 'remove') await manager.remove(id)
      else if (action === 'edit') await manager.save({ id, name: 'Other', target: 'other', launchUrl: `http://127.0.0.1:3080/?token=${token}` })
      else if (action === 'unload') await manager.dispose()
      else if (action === 'drop') await tunnels[0]!.close()
      else await manager.reconnect(id)
      await closed
      if (action === 'disconnect' || action === 'drop' || action === 'reconnect') {
        await manager.connect(id)
        await manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
        assert.notEqual(host.state.workspaceSockets[2], first, action)
        assert.equal(host.state.auth, 2)
      }
    } finally { await manager.dispose(); await host.close() }
  }
})

test('disconnect, removal, destination edit and unload abort in-flight workspace results', async () => {
  for (const action of ['disconnect', 'remove', 'edit', 'unload'] as const) {
    const host = await remote()
    const { manager, add, tunnels } = await setup({ dev: host.port })
    const received = deferred<ServerResponse>()
    const closed = deferred()
    host.state.onPost = (request, response) => { request.socket.once('close', () => closed.resolve()); received.resolve(response) }
    try {
      const id = await add('dev')
      const pending = manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
      const rejected = assert.rejects(pending, safeRejection)
      const response = await received.promise
      if (action === 'disconnect') await manager.disconnect(id)
      else if (action === 'remove') await manager.remove(id)
      else if (action === 'edit') await manager.save({ id, name: 'Edited', target: 'other', launchUrl: `http://127.0.0.1:3080/?token=${token}` })
      else await manager.dispose()
      await rejected
      await closed.promise
      // A response from the former destination cannot revive the request or its generation.
      response.end(JSON.stringify(catalog('Old destination')))
      assert.equal(tunnels[0]?.closes, 1)
      if (action !== 'unload') {
        const rows = await manager.list()
        assert.equal(rows.length, action === 'remove' ? 0 : 1)
        if (rows[0]) assert.equal(rows[0].phase, 'disconnected')
      }
    } finally { await manager.dispose(); await host.close() }
  }
})

test('cancellation during cookie refresh never replays the rejected workspace command', async () => {
  const host = await remote()
  const { manager, add } = await setup({ dev: host.port })
  const received = deferred()
  const closed = deferred()
  try {
    const id = await add('dev')
    host.state.onAuth = (request, _response) => { request.socket.once('close', () => closed.resolve()); received.resolve() }
    host.state.onPost = (_request, response) => { response.writeHead(401); response.end() }
    const pending = manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
    const rejected = assert.rejects(pending, safeRejection)
    await received.promise
    await manager.disconnect(id)
    await rejected
    await closed.promise
    assert.equal(host.state.posts, 1)
    host.state.onAuth = undefined
    host.state.onPost = undefined
    await manager.connect(id)
    assert.deepEqual(await manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL }), catalog('Remote'))
    assert.equal(host.state.auth, 3)
  } finally { await manager.dispose(); await host.close() }
})

test('connections keep independent cookies and long polls do not block list or another connection', async () => {
  const first = await remote('First')
  const second = await remote('Second')
  const { manager, add } = await setup({ first: first.port, second: second.port })
  const received = deferred()
  let count = 0
  first.state.onPost = (_request, response, input) => {
    if (input.op === 'catalog') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(catalog('First')))
    } else if (++count === 2) received.resolve()
  }
  try {
    const firstId = await add('first')
    const secondId = await add('second')
    const polling = [1, 2].map(() => manager.workspace(firstId, { op: 'pollView', channel: 'a'.repeat(43), afterRevision: 0 }))
    const rejected = Promise.all(polling.map(promise => assert.rejects(promise, safeRejection)))
    await received.promise
    const started = Date.now()
    assert.equal((await manager.list()).filter(row => row.phase === 'connected').length, 2)
    assert.deepEqual(await manager.workspace(firstId, { op: 'catalog', protocol: WORKSPACE_PROTOCOL }), catalog('First'))
    assert.deepEqual(await manager.workspace(secondId, { op: 'catalog', protocol: WORKSPACE_PROTOCOL }), catalog('Second'))
    await manager.disconnect(firstId)
    assert.ok(Date.now() - started < 3000, 'management must not await a long poll')
    await rejected
    assert.equal(first.state.auth, 1)
    assert.equal(second.state.auth, 1)
    assert.notEqual(first.state.cookies[0], second.state.cookies[0])
    assert.ok(first.state.receivedCookies.every(value => value === first.state.cookies[0]))
    assert.ok(second.state.receivedCookies.every(value => value === second.state.cookies[0]))
    assert.equal((await manager.list()).find(row => row.id === secondId)?.phase, 'connected')
  } finally { await manager.dispose(); await first.close(); await second.close() }
})

test('an expired cached cookie refreshes once without discarding a live tunnel', async () => {
  const host = await remote()
  const { manager, add, tunnels } = await setup({ dev: host.port })
  try {
    const id = await add('dev')
    await manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
    host.state.onPost = (request, response) => {
      if (request.headers.cookie === host.state.cookies[0]) { response.writeHead(401); response.end(secret); return }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(catalog('Remote')))
    }
    assert.deepEqual(await manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL }), catalog('Remote'))
    assert.equal((await manager.list())[0]?.phase, 'connected')
    assert.equal(tunnels[0]?.closes, 0)
    assert.equal(host.state.auth, 2)
    assert.equal(host.state.receivedCookies.at(-1), host.state.cookies[1])
  } finally { await manager.dispose(); await host.close() }
})

test('a temporary background HTTP failure preserves the SSH master and its cookie', async () => {
  const host = await remote()
  const { manager, add, tunnels } = await setup({ dev: host.port })
  try {
    const id = await add('dev')
    await manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
    host.state.onPost = (request, _response) => { request.socket.destroy() }
    await assert.rejects(manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL }), safeRejection)
    const status = (await manager.list())[0]
    assert.equal(status?.phase, 'connected')
    assert.equal(status?.localPort, host.port)
    assert.equal(tunnels[0]?.closes, 0)
    host.state.onPost = undefined
    assert.deepEqual(await manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL }), catalog('Remote'))
    assert.equal(host.state.auth, 1, 'network failure does not revoke a verified cookie')
  } finally { await manager.dispose(); await host.close() }
})

test('plugin and protocol failures do not discard a healthy SSH connection', async () => {
  const host = await remote()
  const { manager, add, tunnels } = await setup({ dev: host.port })
  try {
    const id = await add('dev')
    for (const status of [404, 500]) {
      host.state.onPost = (_request, response) => { response.writeHead(status); response.end('not a workspace response') }
      await assert.rejects(manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL }), safeRejection)
      assert.equal((await manager.list())[0]?.phase, 'connected')
      assert.equal(tunnels[0]?.closes, 0)
    }
  } finally { await manager.dispose(); await host.close() }
})

test('openView authenticates before allocation and open refreshes the cookie used by later calls', async () => {
  const host = await remote()
  const { manager, add, tunnels } = await setup({ dev: host.port })
  try {
    const id = await add('dev')
    const old = host.state.cookies[0]
    host.state.onPost = (request, response, input) => {
      if (request.headers.cookie === old) { response.writeHead(401); response.end(); return }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(input.op === 'openView'
        ? { ok: true, value: { protocol: WORKSPACE_PROTOCOL, channel: 'a'.repeat(43), revision: 0, presentedRevision: 0, reportedRevision: 0 } }
        : catalog('Remote')))
    }
    await manager.workspace(id, { op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'test-browser' })
    assert.equal(host.state.auth, 2)
    assert.equal(host.state.posts, 1, 'the stale cached cookie never reaches view allocation')
    assert.equal(host.state.receivedCookies[0], host.state.cookies[1])
    await manager.open(id)
    await manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
    assert.equal(host.state.auth, 3)
    assert.equal(host.state.receivedCookies.at(-1), host.state.cookies[2])
    assert.equal(tunnels[0]?.closes, 0)
  } finally { await manager.dispose(); await host.close() }
})

test('concurrent rejected cookies share one bounded authentication refresh', async () => {
  const host = await remote()
  const { manager, add, tunnels } = await setup({ dev: host.port })
  const entered = deferred(), release = deferred()
  try {
    const id = await add('dev')
    host.state.onAuth = (_request, _response, reply) => { entered.resolve(); void release.promise.then(reply) }
    host.state.onPost = (request, response) => {
      if (request.headers.cookie === host.state.cookies[0]) { response.writeHead(401); response.end(); return }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(catalog('Remote')))
    }
    const results = Promise.all([1, 2, 3].map(() => manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL })))
    await entered.promise
    release.resolve()
    assert.deepEqual(await results, [catalog('Remote'), catalog('Remote'), catalog('Remote')])
    assert.equal(host.state.auth, 2)
    assert.equal(tunnels[0]?.closes, 0)
  } finally { release.resolve(); await manager.dispose(); await host.close() }
})

test('persistent authorization rejection retries only once and leaves SSH ownership intact', async () => {
  const host = await remote()
  const { manager, add, tunnels } = await setup({ dev: host.port })
  try {
    const id = await add('dev')
    host.state.onPost = (_request, response) => { response.writeHead(403); response.end(secret) }
    await assert.rejects(manager.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL }), safeRejection)
    assert.equal(host.state.posts, 2)
    assert.equal(host.state.auth, 2)
    assert.equal((await manager.list())[0]?.phase, 'connected')
    assert.equal(tunnels[0]?.closes, 0)
  } finally { await manager.dispose(); await host.close() }
})

test('a workspace timeout does not close the shared tunnel or replay an ambiguous mutation', async t => {
  const timeout = AbortSignal.timeout
  let timeouts = 0
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    if (milliseconds === 30_000) { timeouts++; return timeout(20) }
    return timeout(milliseconds)
  })
  const host = await remote()
  const { manager, add, tunnels } = await setup({ dev: host.port })
  try {
    const id = await add('dev')
    const transportId = (await manager.list())[0]!.transportId!
    host.state.onPost = () => {}
    for (const request of [
      { op: 'catalog', protocol: WORKSPACE_PROTOCOL },
      { op: 'viewState', channel: 'a'.repeat(43) },
      { op: 'renameSession', id: 'session-1', title: 'Updated' },
    ]) await assert.rejects(manager.workspace(id, request, transportId), safeRejection)
    assert.equal(timeouts, 3)
    assert.equal(host.state.posts, 3, 'transport failures must not replay an operation')
    assert.equal(host.state.auth, 1)
    assert.equal((await manager.list())[0]?.phase, 'connected')
    assert.equal(tunnels[0]?.closes, 0)
  } finally { await manager.dispose(); await host.close() }
})
