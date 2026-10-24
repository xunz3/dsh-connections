import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { ConnectionsManager } from '../src/host/manager.js'
import { createStore } from '../src/host/store.js'
import type { Tunnel } from '../src/host/ssh.js'
import { WORKSPACE_ENDPOINT } from '../src/shared/workspace-protocol.js'

const token = 'workspace-manager-private-launch-token'
const secret = 'remote-private-payload-not-for-public-projections'
const catalog = (title: string) => ({ ok: true, value: {
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
    async probe() {},
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
    const results = await Promise.all(Array.from({ length: 4 }, () => manager.workspace(id, { op: 'catalog' })))
    results.forEach(result => assert.deepEqual(result, catalog('Remote')))
    await manager.workspace(id, { op: 'catalog' })
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
    await manager.workspace(id, { op: 'catalog' })
    assert.equal(host.state.auth, 2)
    assert.equal(host.state.receivedCookies.at(-1), host.state.cookies[1])
  } finally { await manager.dispose(); await host.close() }
})

test('disconnect, removal, edit and unload abort in-flight workspace results', async () => {
  for (const action of ['disconnect', 'remove', 'edit', 'unload'] as const) {
    const host = await remote()
    const { manager, add, tunnels } = await setup({ dev: host.port })
    const received = deferred<ServerResponse>()
    const closed = deferred()
    host.state.onPost = (request, response) => { request.socket.once('close', () => closed.resolve()); received.resolve(response) }
    try {
      const id = await add('dev')
      const pending = manager.workspace(id, { op: 'catalog' })
      const rejected = assert.rejects(pending, safeRejection)
      const response = await received.promise
      if (action === 'disconnect') await manager.disconnect(id)
      else if (action === 'remove') await manager.remove(id)
      else if (action === 'edit') await manager.save({ id, name: 'Edited', target: 'dev' })
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

test('cancellation during the cookie exchange never sends a workspace command', async () => {
  const host = await remote()
  const { manager, add } = await setup({ dev: host.port })
  const received = deferred()
  const closed = deferred()
  host.state.onAuth = (request, _response) => { request.socket.once('close', () => closed.resolve()); received.resolve() }
  try {
    const id = await add('dev')
    const pending = manager.workspace(id, { op: 'catalog' })
    const rejected = assert.rejects(pending, safeRejection)
    await received.promise
    await manager.disconnect(id)
    await rejected
    await closed.promise
    assert.equal(host.state.posts, 0)
    host.state.onAuth = undefined
    await manager.connect(id)
    assert.deepEqual(await manager.workspace(id, { op: 'catalog' }), catalog('Remote'))
    assert.equal(host.state.auth, 2)
  } finally { await manager.dispose(); await host.close() }
})

test('connections keep independent cookies and long polls do not block list or another connection', async () => {
  const first = await remote('First')
  const second = await remote('Second')
  const { manager, add } = await setup({ first: first.port, second: second.port })
  const received = deferred()
  let count = 0
  first.state.onPost = (_request, _response) => { if (++count === 2) received.resolve() }
  try {
    const firstId = await add('first')
    const secondId = await add('second')
    const polling = [1, 2].map(() => manager.workspace(firstId, { op: 'pollView', channel: 'a'.repeat(43), afterRevision: 0 }))
    const rejected = Promise.all(polling.map(promise => assert.rejects(promise, safeRejection)))
    await received.promise
    const started = Date.now()
    assert.equal((await manager.list()).filter(row => row.phase === 'connected').length, 2)
    assert.deepEqual(await manager.workspace(secondId, { op: 'catalog' }), catalog('Second'))
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

test('a rejected cached authorization is replaced for the next workspace request', async () => {
  const host = await remote()
  const { manager, add } = await setup({ dev: host.port })
  try {
    const id = await add('dev')
    await manager.workspace(id, { op: 'catalog' })
    host.state.onPost = (_request, response) => { response.writeHead(401); response.end(secret) }
    await assert.rejects(manager.workspace(id, { op: 'catalog' }), safeRejection)
    host.state.onPost = undefined
    assert.deepEqual(await manager.workspace(id, { op: 'catalog' }), catalog('Remote'))
    assert.equal(host.state.auth, 2)
    assert.equal(host.state.receivedCookies.at(-1), host.state.cookies[1])
  } finally { await manager.dispose(); await host.close() }
})
