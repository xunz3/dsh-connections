import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { ConnectionsManager, probeHarness } from '../src/host/manager.js'
import { createStore } from '../src/host/store.js'
import { SshTunnelError, type Tunnel } from '../src/host/ssh.js'

const TOKEN = 'private-launch-token-never-in-status'
const launchUrl = `http://127.0.0.1:3080/?token=${TOKEN}`
function credentials() {
  const records = new Map<CredentialKey, CredentialRecord>()
  return {
    records,
    async listRecords() { return [...records].map(([key, record]) => ({ key, kind: record.kind })) },
    async readRecord(key: CredentialKey) { return records.get(key) },
    async modifyRecord(key: CredentialKey, mutate: (value: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
    async deleteRecord(key: CredentialKey) { records.delete(key) },
  }
}
function fakeTunnel(port = 41380) {
  const listeners = new Set<(error?: Error) => void>()
  let closed = false
  const tunnel: Tunnel & { closes: number; drop(): void } = {
    port, closes: 0,
    async close() {
      if (closed) return
      closed = true
      ++tunnel.closes
      for (const listener of [...listeners]) listener()
    },
    onClose(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    drop() { closed = true; for (const listener of [...listeners]) listener(new Error('transport detail')) },
  }
  return tunnel
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('native credentials store persists one complete connection and preserves an omitted token', async () => {
  const provider = credentials()
  const store = createStore(provider)
  const saved = await store.save({ name: 'Work', target: 'dev', launchUrl })
  assert.equal(provider.records.size, 1)
  assert.equal([...provider.records.keys()][0], `connections/${saved.id}`)
  assert.deepEqual(await createStore(provider).read(saved.id), saved)
  assert.equal((await store.save({ id: saved.id, name: 'Renamed', target: 'dev' })).token, TOKEN)
  await assert.rejects(store.save({ id: saved.id, name: 'Work', target: 'other' }), /fresh Harness launch URL/)
  assert.equal((await store.read(saved.id))?.target, 'dev')
  assert.equal((await store.save({ id: saved.id, name: 'Other', target: 'other', launchUrl })).target, 'other')
  await store.remove(saved.id)
  assert.deepEqual(await store.list(), [])
  await assert.rejects(store.save({ name: 'New', target: 'dev' }), /fresh Harness launch URL/)
})

test('successful connection exposes its credential only through explicit open', async () => {
  const store = createStore(credentials())
  const tunnel = fakeTunnel()
  let probes = 0
  const manager = new ConnectionsManager(store, {
    connectTunnel: async () => tunnel,
    probe: async (port, token) => { assert.equal(port, tunnel.port); assert.equal(token, TOKEN); ++probes },
  })
  const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl })
  await assert.rejects(manager.open(saved.id), /Connect before opening/)
  const connected = await manager.connect(saved.id)
  assert.equal(connected.phase, 'connected')
  assert.equal(connected.localPort, tunnel.port)
  assert.equal(JSON.stringify([saved, connected, await manager.list()]).includes(TOKEN), false)
  assert.equal((await manager.open(saved.id)).url, `http://127.0.0.1:${tunnel.port}/?token=${TOKEN}`)
  await manager.connect(saved.id)
  assert.equal(probes, 1)
  const disconnected = await manager.disconnect(saved.id)
  assert.equal(disconnected.phase, 'disconnected')
  assert.equal(disconnected.localPort, undefined)
  assert.equal(tunnel.closes, 1)
  assert.ok(await store.read(saved.id))
  await manager.dispose()
})

test('concurrent connect calls share one attempt and disconnect cancels a pending health probe', async () => {
  const store = createStore(credentials())
  const tunnel = fakeTunnel()
  const started = deferred<void>()
  let attempts = 0
  const manager = new ConnectionsManager(store, {
    connectTunnel: async () => { ++attempts; return tunnel },
    probe: async (_port, _token, signal) => {
      started.resolve()
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    },
  })
  const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl })
  const first = manager.connect(saved.id)
  const second = manager.connect(saved.id)
  const failures = Promise.all([assert.rejects(first, /cancelled/), assert.rejects(second, /cancelled/)])
  await started.promise
  assert.equal((await manager.list())[0]?.phase, 'connecting')
  assert.equal((await manager.disconnect(saved.id)).phase, 'disconnected')
  await failures
  assert.equal(attempts, 1)
  assert.equal(tunnel.closes, 1)
  assert.equal((await manager.list())[0]?.error, undefined)
  await manager.dispose()
})

test('a late tunnel result cannot restore a cancelled connection', async () => {
  const store = createStore(credentials())
  const pending = deferred<Tunnel>()
  const started = deferred<void>()
  const tunnel = fakeTunnel()
  let probes = 0
  const manager = new ConnectionsManager(store, {
    connectTunnel: async () => { started.resolve(); return pending.promise },
    probe: async () => { ++probes },
  })
  const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl })
  const connecting = manager.connect(saved.id)
  const failed = assert.rejects(connecting, /cancelled/)
  await started.promise
  const disconnected = manager.disconnect(saved.id)
  await new Promise(resolve => setImmediate(resolve))
  pending.resolve(tunnel)
  assert.equal((await disconnected).phase, 'disconnected')
  await failed
  assert.equal(tunnel.closes, 1)
  assert.equal(probes, 0)
  await manager.dispose()
})

test('failures are redacted, release the tunnel, and permit an explicit reconnect', async () => {
  const store = createStore(credentials())
  const tunnels = [fakeTunnel(), fakeTunnel(41381)]
  let attempt = 0
  const manager = new ConnectionsManager(store, {
    connectTunnel: async () => tunnels[attempt++]!,
    probe: async () => { if (attempt === 1) throw new Error(`do not disclose ${TOKEN}`) },
  })
  const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl })
  await assert.rejects(manager.connect(saved.id), error => error instanceof Error && /authentication failed/.test(error.message) && !error.message.includes(TOKEN))
  assert.equal(tunnels[0]?.closes, 1)
  assert.equal((await manager.list())[0]?.phase, 'error')
  assert.equal(JSON.stringify(await manager.list()).includes(TOKEN), false)
  assert.equal((await manager.connect(saved.id)).phase, 'connected')
  tunnels[1]!.drop()
  assert.equal((await manager.list())[0]?.phase, 'error')
  await assert.rejects(manager.open(saved.id), /Connect before opening/)
  await manager.dispose()
})

test('SSH failure codes retain useful guidance without forwarding raw process diagnostics', async () => {
  const manager = new ConnectionsManager(createStore(credentials()), {
    connectTunnel: async () => { throw new SshTunnelError('SSH_HOST_KEY', `untrusted diagnostic ${TOKEN}`) },
  })
  const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl })
  await assert.rejects(manager.connect(saved.id), error => error instanceof Error && /host identity/.test(error.message) && !error.message.includes(TOKEN))
  assert.equal(JSON.stringify(await manager.list()).includes(TOKEN), false)
  await manager.dispose()
})

test('editing, deleting and unloading stop owned tunnels without deleting remote work', async () => {
  const store = createStore(credentials())
  const tunnels = [fakeTunnel(), fakeTunnel(41381), fakeTunnel(41382)]
  let attempt = 0
  const manager = new ConnectionsManager(store, { connectTunnel: async () => tunnels[attempt++]!, probe: async () => {} })
  const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl })
  await manager.connect(saved.id)
  assert.equal((await manager.save({ id: saved.id, name: 'Renamed', target: 'dev' })).phase, 'disconnected')
  assert.equal(tunnels[0]?.closes, 1)
  await manager.connect(saved.id)
  await manager.remove(saved.id)
  assert.equal(tunnels[1]?.closes, 1)
  assert.equal(await store.read(saved.id), undefined)
  const next = await manager.save({ name: 'Next', target: 'dev', launchUrl })
  await manager.connect(next.id)
  await manager.dispose()
  assert.equal(tunnels[2]?.closes, 1)
  assert.ok(await store.read(next.id))
  await assert.rejects(manager.list(), /unloaded/)
  await manager.dispose()
})

test('a credential changed outside the manager never opens through the previous destination', async () => {
  const store = createStore(credentials())
  const tunnel = fakeTunnel()
  const manager = new ConnectionsManager(store, { connectTunnel: async () => tunnel, probe: async () => {} })
  const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl })
  await manager.connect(saved.id)
  await store.save({ id: saved.id, name: 'Work', target: 'another', launchUrl })
  await assert.rejects(manager.open(saved.id), /Connect before opening/)
  assert.equal(tunnel.closes, 1)
  await manager.dispose()
})

test('unloading cancels an in-flight SSH attempt and rejects further management', async () => {
  const store = createStore(credentials())
  const started = deferred<void>()
  let aborted = false
  const manager = new ConnectionsManager(store, {
    connectTunnel: async ({ signal }) => {
      started.resolve()
      return new Promise<Tunnel>((_resolve, reject) => signal?.addEventListener('abort', () => {
        aborted = true
        reject(new Error(`cancelled with private data ${TOKEN}`))
      }, { once: true }))
    },
    probe: async () => { assert.fail('The cancelled attempt must not reach the Host') },
  })
  const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl })
  const pending = manager.connect(saved.id)
  const failure = assert.rejects(pending, /Connection cancelled\./)
  await started.promise
  await manager.dispose()
  await failure
  assert.equal(aborted, true)
  assert.ok(await store.read(saved.id))
  await assert.rejects(manager.connect(saved.id), /unloaded/)
})

async function listening(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing test listener')
  return address.port
}
async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

test('probe accepts only the expected authority-bound Harness exchange, never follows redirects', async () => {
  let mode: 'valid' | 'unauthorized' | 'redirect' | 'cookie' = 'valid'
  const paths: string[] = []
  const server = createServer((req, res) => {
    paths.push(req.url ?? '')
    const cookieName = `dsh-auth-${createHash('sha256').update(req.headers.host!).digest('base64url')}`
    res.writeHead(mode === 'unauthorized' ? 401 : 303, {
      location: mode === 'redirect' ? 'https://example.invalid/credential-leak' : './',
      'set-cookie': `${mode === 'cookie' ? 'other-cookie' : cookieName}=v1.payload.signature; Path=/; HttpOnly; SameSite=Strict`,
    })
    res.end()
  })
  const port = await listening(server)
  try {
    await probeHarness(port, TOKEN, new AbortController().signal)
    for (const invalid of ['unauthorized', 'redirect', 'cookie'] as const) {
      mode = invalid
      await assert.rejects(probeHarness(port, TOKEN, new AbortController().signal), error => error instanceof Error && !error.message.includes(TOKEN))
    }
    assert.equal(paths.length, 4)
    assert.ok(paths.every(path => path === `/?token=${TOKEN}`))
  } finally { await close(server) }
})

test('probe cancels a stalled HTTP response without exposing the credential', async () => {
  const received = deferred<void>()
  const server = createServer(() => { received.resolve() })
  const port = await listening(server)
  const controller = new AbortController()
  try {
    const checking = probeHarness(port, TOKEN, controller.signal)
    const failed = assert.rejects(checking, error => error instanceof Error && !error.message.includes(TOKEN))
    await received.promise
    controller.abort()
    await failed
  } finally { await close(server) }
})
