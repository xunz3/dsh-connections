import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { ConnectionsManager, probeHarness } from '../src/host/manager.js'
import { createStore } from '../src/host/store.js'
import { SshTunnelError, type Tunnel } from '../src/host/ssh.js'
import { LATEST_SUPPORTED_REMOTE_VERSION } from '../src/shared/validation.js'
import { HarnessAuthorizationError, HarnessConnectionError, HarnessProtocolError } from '../src/host/harness-http.js'

const PROBE_COOKIE = 'private-test-owner-cookie'
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
  const tunnel: Tunnel & { closes: number; drop(error?: Error): void } = {
    port, closes: 0,
    async close() {
      if (closed) return
      closed = true
      ++tunnel.closes
      for (const listener of [...listeners]) listener()
    },
    onClose(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    drop(error = new Error('transport detail')) { closed = true; for (const listener of [...listeners]) listener(error) },
  }
  return tunnel
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('managed hosts retrieve fresh credentials, restore access after unload, and update only explicitly', async () => {
  const provider = credentials()
  const store = createStore(provider)
  let prepares = 0
  const updates: (string | undefined)[] = []
  let version = '0.2.1-rc.2'
  const host = () => ({ remotePort: 3080, token: TOKEN, version, pid: 512, service: 'systemd' as const })
  const options = {
    prepareHost: async () => { ++prepares; return host() },
    updateHost: async (input: { version?: string }) => { updates.push(input.version); version = input.version ?? LATEST_SUPPORTED_REMOTE_VERSION; return host() },
    connectTunnel: async (input: { preferredLocalPort?: number }) => { if (prepares >= 2) assert.equal(input.preferredLocalPort, 41380); return fakeTunnel() }, probe: async () => PROBE_COOKIE,
  }
  const manager = new ConnectionsManager(store, options)
  const saved = await manager.save({ name: 'Managed', target: 'dev', mode: 'managed' })
  assert.equal(saved.autoConnect, true)
  assert.equal(saved.remotePort, undefined)
  const connected = await manager.connect(saved.id)
  assert.equal(connected.runtime?.pid, 512)
  assert.equal(connected.runtime?.version, version)
  assert.ok((await manager.open(saved.id)).url.includes(TOKEN))
  assert.equal(JSON.stringify([...provider.records.values()]).includes(TOKEN), false)
  await manager.dispose()
  const reopened = new ConnectionsManager(createStore(provider), options)
  await reopened.restore()
  assert.equal(prepares, 2)
  assert.equal((await reopened.list())[0]?.phase, 'connected')
  assert.deepEqual(updates, [])
  const updated = await reopened.update({ id: saved.id })
  assert.equal(updated.runtime?.version, LATEST_SUPPORTED_REMOTE_VERSION)
  assert.deepEqual(updates, [undefined], 'default update must reach the updater, not ordinary prepare')
  await reopened.update({ id: saved.id, version: '0.2.1-rc.3' })
  assert.deepEqual(updates, [undefined, '0.2.1-rc.3'])
  await assert.rejects(reopened.update({ id: saved.id, version: 'latest' }), /exact Harness version/)
  await reopened.dispose()
})

test('cancelling local preparation never revives its tunnel after remote maintenance finishes', async () => {
  const prepared = deferred<{ remotePort: number; token: string; version: string; service: 'systemd'; pid: number }>()
  const entered = deferred<void>()
  let tunnels = 0
  const manager = new ConnectionsManager(createStore(credentials()), {
    prepareHost: async () => { entered.resolve(); return prepared.promise },
    connectTunnel: async () => { ++tunnels; return fakeTunnel() }, probe: async () => PROBE_COOKIE,
  })
  const saved = await manager.save({ name: 'Managed', target: 'dev', mode: 'managed' })
  const connecting = manager.connect(saved.id)
  const rejected = assert.rejects(connecting, /cancelled/)
  await entered.promise
  assert.equal((await manager.list())[0]?.stage, 'preparing')
  const disconnecting = manager.disconnect(saved.id)
  await new Promise(resolve => setTimeout(resolve, 0))
  prepared.resolve({ remotePort: 3080, token: TOKEN, version: '0.2.1-rc.2', service: 'systemd', pid: 513 })
  await rejected
  const disconnected = await disconnecting
  assert.equal(disconnected.phase, 'disconnected')
  assert.equal(disconnected.stage, undefined)
  assert.equal(tunnels, 0)
  await manager.dispose()
})

test('reconnect resolves a restarted managed Host even when its SSH master still reports connected', async () => {
  let remotePort = 3080
  let prepares = 0
  const tunnels: ReturnType<typeof fakeTunnel>[] = []
  const destinations: number[] = []
  const manager = new ConnectionsManager(createStore(credentials()), {
    prepareHost: async () => {
      prepares++
      return { remotePort, token: `${TOKEN}-${remotePort}`, version: '0.2.1-rc.2', pid: remotePort, service: 'systemd' }
    },
    connectTunnel: async input => {
      destinations.push(input.remotePort)
      const created = fakeTunnel(input.preferredLocalPort ?? 41380)
      tunnels.push(created)
      return created
    },
    probe: async (_port, token) => { if (token !== `${TOKEN}-${remotePort}`) throw new Error('expired private credential'); return PROBE_COOKIE },
  })
  try {
    const saved = await manager.save({ name: 'Managed', target: 'dev', mode: 'managed' })
    await manager.connect(saved.id)
    remotePort = 3081
    assert.equal((await manager.list())[0]?.phase, 'connected')
    const [first, second] = await Promise.all([manager.reconnect(saved.id), manager.reconnect(saved.id)])
    assert.equal(first.phase, 'connected')
    assert.equal(second.runtime?.pid, remotePort)
    assert.equal(prepares, 2)
    assert.deepEqual(destinations, [3080, 3081])
    assert.equal(tunnels[0]?.closes, 1)
    assert.match((await manager.open(saved.id)).url, /-3081$/)
    remotePort = 3082
    await assert.rejects(manager.open(saved.id), /Reconnect/)
    assert.equal((await manager.list())[0]?.phase, 'error')
    assert.equal(tunnels[1]?.closes, 1)
    assert.equal((await manager.reconnect(saved.id)).runtime?.pid, 3082)
  } finally { await manager.dispose() }
})

test('an open health probe can be cancelled without blocking connection management', async () => {
  const entered = deferred<void>()
  let probes = 0
  const manager = new ConnectionsManager(createStore(credentials()), {
    connectTunnel: async () => fakeTunnel(),
    probe: async (_port, _token, signal) => {
      if (++probes === 1) return PROBE_COOKIE
      entered.resolve()
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
      return PROBE_COOKIE
    },
  })
  try {
    const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl })
    await manager.connect(saved.id)
    const opening = assert.rejects(manager.open(saved.id), /Connection changed/)
    await entered.promise
    assert.equal((await manager.disconnect(saved.id)).phase, 'disconnected')
    await opening
    assert.equal((await manager.list())[0]?.phase, 'disconnected')
  } finally { await manager.dispose() }
})

test('an open protocol failure preserves its healthy transport and a later probe can succeed', async () => {
  const tunnel = fakeTunnel()
  let probes = 0
  const manager = new ConnectionsManager(createStore(credentials()), {
    connectTunnel: async () => tunnel,
    probe: async () => { if (++probes === 2) throw new HarnessProtocolError('The remote Host returned an incompatible authentication response.'); return PROBE_COOKIE },
  })
  try {
    const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl })
    const connected = await manager.connect(saved.id)
    await assert.rejects(manager.open(saved.id), HarnessProtocolError)
    assert.deepEqual((await manager.list())[0], connected)
    assert.equal(tunnel.closes, 0)
    assert.equal((await manager.open(saved.id)).url, `http://127.0.0.1:${tunnel.port}/?token=${TOKEN}`)
  } finally { await manager.dispose() }
})

test('an old open completion cannot invalidate a replacement connection', async () => {
  const entered = deferred<void>(), release = deferred<void>()
  let probes = 0
  const tunnels = [fakeTunnel(), fakeTunnel(41381)]
  let attempts = 0
  const manager = new ConnectionsManager(createStore(credentials()), {
    connectTunnel: async () => tunnels[attempts++]!,
    probe: async () => {
      if (++probes === 2) { entered.resolve(); await release.promise; throw new HarnessConnectionError('Old probe failed.') }
      return PROBE_COOKIE
    },
  })
  try {
    const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl })
    await manager.connect(saved.id)
    const opening = assert.rejects(manager.open(saved.id), /Connection changed/)
    await entered.promise
    const connected = await manager.reconnect(saved.id)
    release.resolve()
    await opening
    assert.deepEqual((await manager.list())[0], connected)
    assert.equal(tunnels[1]!.closes, 0)
  } finally { release.resolve(); await manager.dispose() }
})

test('an open transport or authorization failure invalidates only its current lease', async () => {
  for (const failure of [new HarnessAuthorizationError('Private authorization detail'), new HarnessConnectionError('Private network detail')]) {
    const tunnel = fakeTunnel()
    let probes = 0
    const manager = new ConnectionsManager(createStore(credentials()), {
      connectTunnel: async () => tunnel,
      probe: async () => { if (++probes === 2) throw failure; return PROBE_COOKIE },
    })
    try {
      const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl })
      await manager.connect(saved.id)
      await assert.rejects(manager.open(saved.id), error => error instanceof Error && /Reconnect/.test(error.message) && !error.message.includes('Private'))
      assert.equal((await manager.list())[0]?.phase, 'error')
      assert.equal(tunnel.closes, 1)
    } finally { await manager.dispose() }
  }
})

test('metadata edits preserve an in-flight preparation and its latest public name', async () => {
  const prepared = deferred<void>()
  const entered = deferred<void>()
  const manager = new ConnectionsManager(createStore(credentials()), {
    prepareHost: async () => {
      entered.resolve()
      await prepared.promise
      return { remotePort: 3080, token: TOKEN, version: '0.2.1-rc.2', pid: 1, service: 'systemd' }
    },
    connectTunnel: async () => fakeTunnel(), probe: async () => PROBE_COOKIE,
  })
  try {
    const saved = await manager.save({ name: 'Work', target: 'dev', mode: 'managed' })
    const connecting = manager.connect(saved.id)
    await entered.promise
    const edited = await manager.save({ id: saved.id, name: 'Renamed', target: 'dev', autoConnect: false })
    assert.equal(edited.phase, 'connecting')
    prepared.resolve()
    const connected = await connecting
    assert.equal(connected.name, 'Renamed')
    assert.equal(connected.autoConnect, false)
    assert.equal(connected.phase, 'connected')
  } finally { prepared.resolve(); await manager.dispose() }
})

test('native credentials store persists one complete connection and preserves an omitted token', async () => {
  const provider = credentials()
  const store = createStore(provider)
  const saved = await store.save({ name: 'Work', target: 'dev', launchUrl })
  assert.equal(provider.records.size, 1)
  assert.equal([...provider.records.keys()][0], `xunz-dsh-connections/${saved.id}`)
  assert.deepEqual(await createStore(provider).read(saved.id), saved)
  assert.equal((await store.save({ id: saved.id, name: 'Renamed', target: 'dev' })).token, TOKEN)
  await store.rememberPort(saved.id, 'dev', 41380)
  assert.equal((await store.save({ id: saved.id, name: 'Renamed', target: 'dev', mode: 'existing' })).lastLocalPort, 41380)
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
    probe: async (port, token) => { assert.equal(port, tunnel.port); assert.equal(token, TOKEN); ++probes; return PROBE_COOKIE },
  })
  const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl })
  await assert.rejects(manager.open(saved.id), /Connect before opening/)
  const connected = await manager.connect(saved.id)
  assert.equal(connected.phase, 'connected')
  assert.equal(connected.localPort, tunnel.port)
  assert.equal(JSON.stringify([saved, connected, await manager.list()]).includes(TOKEN), false)
  assert.equal((await manager.open(saved.id)).url, `http://127.0.0.1:${tunnel.port}/?token=${TOKEN}`)
  await manager.connect(saved.id)
  assert.equal(probes, 2)
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
      return PROBE_COOKIE
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
    probe: async () => { ++probes; return PROBE_COOKIE },
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
    probe: async () => { if (attempt === 1) throw new Error(`do not disclose ${TOKEN}`); return PROBE_COOKIE },
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

test('SSH authentication failure during the first HTTP request remains actionable', async () => {
  const tunnel = fakeTunnel()
  const manager = new ConnectionsManager(createStore(credentials()), {
    connectTunnel: async () => tunnel,
    probe: async () => {
      tunnel.drop(new SshTunnelError('SSH_AUTH', `private SSH diagnostic ${TOKEN}`))
      throw new Error('HTTP stream closed')
    },
  })
  try {
    const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl })
    await assert.rejects(manager.connect(saved.id), /SSH authentication failed/)
    const [row] = await manager.list()
    assert.equal(row?.phase, 'error')
    assert.match(row?.error ?? '', /SSH authentication failed/)
    assert.equal(JSON.stringify(row).includes(TOKEN), false)
  } finally { await manager.dispose() }
})

test('metadata edits preserve access while destination changes, deleting and unloading stop owned tunnels', async () => {
  const store = createStore(credentials())
  const tunnels = [fakeTunnel(), fakeTunnel(41381), fakeTunnel(41382)]
  let attempt = 0
  const manager = new ConnectionsManager(store, { connectTunnel: async () => tunnels[attempt++]!, probe: async () => PROBE_COOKIE })
  const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl })
  await manager.connect(saved.id)
  assert.equal((await manager.save({ id: saved.id, name: 'Renamed', target: 'dev', autoConnect: false })).phase, 'connected')
  assert.equal(tunnels[0]?.closes, 0)
  await assert.rejects(manager.save({ id: saved.id, name: 'Other', target: 'other' }), /fresh Harness launch URL/)
  assert.equal((await manager.list())[0]?.phase, 'connected')
  assert.equal(tunnels[0]?.closes, 0)
  assert.equal((await manager.save({ id: saved.id, name: 'Other', target: 'other', launchUrl })).phase, 'disconnected')
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
  const manager = new ConnectionsManager(store, { connectTunnel: async () => tunnel, probe: async () => PROBE_COOKIE })
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
    const cookiePayload = Buffer.from(JSON.stringify({ version: 1, authority: req.headers.host, issuedAt: Date.now(), expiresAt: Date.now() + 60_000 })).toString('base64url')
    res.writeHead(mode === 'unauthorized' ? 401 : 303, {
      location: mode === 'redirect' ? 'https://example.invalid/credential-leak' : './',
      'set-cookie': `${mode === 'cookie' ? 'other-cookie' : cookieName}=v1.${cookiePayload}.${Buffer.alloc(32, 1).toString('base64url')}; Path=/; HttpOnly; SameSite=Strict`,
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

test('later restore workers preserve explicit disconnects and current auto-connect settings', async () => {
  for (const action of ['disconnect', 'disable', 'external-disable', 'manual-connect'] as const) {
    const store = createStore(credentials())
    const saved = []
    for (let index = 1; index <= 5; index++) {
      saved.push(await store.save({ name: `Host ${index}`, target: `dev${index}`, mode: 'managed', autoConnect: true }))
    }
    const entered = deferred<void>()
    const release = deferred<void>()
    const prepared: string[] = []
    const manager = new ConnectionsManager(store, {
      prepareHost: async ({ target }) => {
        prepared.push(target)
        if (target !== 'dev5') {
          if (prepared.filter(target => target !== 'dev5').length === 4) entered.resolve()
          await release.promise
        }
        return { remotePort: 3080, token: TOKEN, version: '0.2.1-rc.2', service: 'systemd', pid: 513 }
      },
      connectTunnel: async () => fakeTunnel(), probe: async () => PROBE_COOKIE,
    })
    const restoring = manager.restore()
    try {
      await entered.promise
      assert.deepEqual(prepared, ['dev1', 'dev2', 'dev3', 'dev4'])
      const joined = manager.connect(saved[0]!.id)
      const fifth = saved[4]!
      if (action === 'disconnect') await manager.disconnect(fifth.id)
      else if (action === 'manual-connect') await manager.connect(fifth.id)
      else {
        const save = action === 'external-disable' ? store.save.bind(store) : manager.save.bind(manager)
        await save({ id: fifth.id, name: fifth.name, target: fifth.target, mode: 'managed', autoConnect: false })
      }
      // The startup snapshot must not grow to include a newly added connection.
      await manager.save({ name: 'Host 6', target: 'dev6', mode: 'managed', autoConnect: true })
      release.resolve()
      await restoring
      assert.equal((await joined).phase, 'connected')
      assert.equal(prepared.filter(target => target === 'dev1').length, 1, 'manual connect joins an automatic attempt')
      assert.equal(prepared.filter(target => target === 'dev5').length, action === 'manual-connect' ? 1 : 0, action)
      assert.equal(prepared.includes('dev6'), false)
      const fifthView = (await manager.list()).find(row => row.id === fifth.id)!
      assert.equal(fifthView.phase, action === 'manual-connect' ? 'connected' : 'disconnected', action)
    } finally {
      release.resolve()
      await restoring
      await manager.dispose()
    }
  }
})

test('restore replaces each finished worker without waiting for the slowest Host', async () => {
  const store = createStore(credentials())
  for (let index = 1; index <= 6; index++) {
    await store.save({ name: `Host ${index}`, target: `dev${index}`, mode: 'managed', autoConnect: true })
  }
  const gates = Array.from({ length: 4 }, () => deferred<void>())
  const full = deferred<void>(), fifth = deferred<void>(), sixth = deferred<void>()
  const prepared: string[] = []
  let active = 0, maximum = 0
  const manager = new ConnectionsManager(store, {
    prepareHost: async ({ target }) => {
      prepared.push(target)
      active++; maximum = Math.max(maximum, active)
      try {
        if (prepared.length === 4) full.resolve()
        const index = Number(target.slice(3)) - 1
        if (index < 4) await gates[index]!.promise
        if (target === 'dev5') { fifth.resolve(); throw new Error('unavailable') }
        if (target === 'dev6') sixth.resolve()
        return { remotePort: 3080, token: TOKEN, version: '0.2.1-rc.3', service: 'systemd', pid: 513 }
      } finally { active-- }
    },
    connectTunnel: async () => fakeTunnel(), probe: async () => PROBE_COOKIE,
  })
  const restoring = manager.restore()
  try {
    await full.promise
    gates[1]!.resolve()
    await fifth.promise
    await sixth.promise
    assert.deepEqual(prepared, ['dev1', 'dev2', 'dev3', 'dev4', 'dev5', 'dev6'])
    assert.equal(maximum, 4)
    assert.equal((await manager.list()).find(row => row.target === 'dev1')?.stage, 'preparing')
    gates.forEach(gate => gate.resolve())
    await restoring
    assert.equal((await manager.list()).find(row => row.target === 'dev5')?.phase, 'error')
  } finally { gates.forEach(gate => gate.resolve()); await restoring; await manager.dispose() }
})

test('connect and update expose only their current preparation, tunnel and authentication stages', async () => {
  for (const operation of ['connect', 'update'] as const) {
    const entered = Array.from({ length: 3 }, () => deferred<void>())
    const release = Array.from({ length: 3 }, () => deferred<void>())
    let blocking = false
    const pause = async (index: number) => {
      if (!blocking) return
      entered[index]!.resolve()
      await release[index]!.promise
    }
    const host = async () => { await pause(0); return { remotePort: 3080, token: TOKEN, version: '0.2.1-rc.3', service: 'systemd' as const, pid: 513 } }
    const manager = new ConnectionsManager(createStore(credentials()), {
      prepareHost: host, updateHost: host,
      connectTunnel: async () => { await pause(1); return fakeTunnel() },
      probe: async () => { await pause(2); return PROBE_COOKIE },
    })
    let pending: Promise<unknown> | undefined
    try {
      const saved = await manager.save({ name: 'Managed', target: 'dev', mode: 'managed' })
      if (operation === 'update') await manager.connect(saved.id)
      blocking = true
      pending = operation === 'connect' ? manager.connect(saved.id) : manager.update({ id: saved.id, version: '0.2.1-rc.3' })
      for (const [index, stage] of ['preparing', 'tunnel', 'authenticating'].entries()) {
        await entered[index]!.promise
        const status = (await manager.list())[0]!
        assert.equal(status.phase, operation === 'connect' ? 'connecting' : 'updating')
        assert.equal(status.stage, stage)
        assert.equal(JSON.stringify(status).includes(TOKEN), false)
        release[index]!.resolve()
      }
      await pending
      assert.equal((await manager.list())[0]?.stage, undefined)
      assert.equal((await manager.disconnect(saved.id)).stage, undefined)
    } finally { release.forEach(gate => gate.resolve()); await pending; await manager.dispose() }
  }
})

test('SSH preflight coalesces a target without saving it or touching a connected Host', async () => {
  const provider = credentials()
  const ready = deferred<void>(), entered = deferred<void>()
  const activeTunnel = fakeTunnel()
  let checks = 0
  const manager = new ConnectionsManager(createStore(provider), {
    connectTunnel: async () => activeTunnel, probe: async () => PROBE_COOKIE,
    checkSshTarget: async ({ target }) => { checks++; assert.equal(target, 'dev'); entered.resolve(); await ready.promise },
  })
  try {
    const saved = await manager.save({ name: 'Managed', target: 'dev', launchUrl })
    const before = await manager.connect(saved.id)
    const records = JSON.stringify([...provider.records])
    const first = manager.checkSsh('dev'), second = manager.checkSsh('dev')
    assert.equal(first, second)
    await entered.promise
    assert.equal(checks, 1)
    assert.deepEqual((await manager.list())[0], before)
    ready.resolve()
    assert.deepEqual(await first, { ok: true })
    assert.equal(activeTunnel.closes, 0)
    assert.equal(JSON.stringify([...provider.records]), records)
    assert.throws(() => manager.checkSsh('-unsafe'), /SSH alias/)
  } finally { ready.resolve(); await manager.dispose() }
})

test('SSH preflight bounds active checks, sanitizes errors and cancels them on unload', async () => {
  const provider = credentials()
  const started = deferred<void>()
  let active = 0, cancelled = 0
  const manager = new ConnectionsManager(createStore(provider), {
    checkSshTarget: async ({ target, signal }) => {
      if (target === 'denied') throw new SshTunnelError('SSH_AUTH', `private stderr ${TOKEN}`)
      if (target === 'failed') throw new Error(`private stderr ${TOKEN}`)
      active++
      if (active === 4) started.resolve()
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => { cancelled++; reject(new Error(TOKEN)) }, { once: true }))
    },
  })
  try {
    assert.deepEqual(await manager.checkSsh('denied'), { ok: false, code: 'SSH_AUTH' })
    assert.deepEqual(await manager.checkSsh('failed'), { ok: false, code: 'SSH_FAILED' })
    const checks = [1, 2, 3, 4].map(index => manager.checkSsh(`dev${index}`))
    await started.promise
    checks.push(manager.checkSsh('dev5'))
    assert.equal(active, 4)
    for (let index = 6; index <= 32; index++) checks.push(manager.checkSsh(`dev${index}`))
    assert.throws(() => manager.checkSsh('dev33'), /Too many SSH checks are waiting/)
    await manager.dispose()
    assert.equal(cancelled, 4)
    assert.deepEqual(await Promise.all(checks), Array.from({ length: 32 }, () => ({ ok: false, code: 'SSH_FAILED' })))
    assert.equal(provider.records.size, 0)
    assert.throws(() => manager.checkSsh('dev1'), /unloaded/)
  } finally { await manager.dispose() }
})

test('a fifth SSH preflight waits for a slot and reports its real result', async () => {
  const gates = Array.from({ length: 5 }, () => deferred<void>())
  const started: string[] = []
  const manager = new ConnectionsManager(createStore(credentials()), {
    checkSshTarget: async ({ target }) => { started.push(target); await gates[Number(target.slice(3)) - 1]!.promise },
  })
  const checks = [1, 2, 3, 4, 5].map(index => manager.checkSsh(`dev${index}`))
  try {
    assert.deepEqual(started, ['dev1', 'dev2', 'dev3', 'dev4'])
    gates[1]!.resolve()
    await checks[1]
    assert.deepEqual(started, ['dev1', 'dev2', 'dev3', 'dev4', 'dev5'])
    gates.forEach(gate => gate.resolve())
    assert.deepEqual(await Promise.all(checks), Array.from({ length: 5 }, () => ({ ok: true })))
  } finally { gates.forEach(gate => gate.resolve()); await manager.dispose() }
})

test('explicit connection intent survives failure, disconnect and Host reload', async () => {
  const provider = credentials()
  const store = createStore(provider)
  let attempts = 0, fail = true
  const options = {
    connectTunnel: async () => {
      attempts++
      if (fail) throw new SshTunnelError('SSH_REFUSED', 'unavailable')
      return fakeTunnel()
    },
    probe: async () => PROBE_COOKIE,
  }
  let manager = new ConnectionsManager(store, options)
  try {
    const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl, autoConnect: false })
    await assert.rejects(manager.connect(saved.id), /refused/)
    assert.equal((await manager.list())[0]?.autoConnect, true, 'a failed attempt remains enabled')
    assert.equal((await store.read(saved.id))?.autoConnect, true)
    const disconnected = await manager.disconnect(saved.id)
    assert.equal(disconnected.autoConnect, false)
    assert.equal(disconnected.phase, 'disconnected')
    await manager.dispose()
    manager = new ConnectionsManager(createStore(provider), options)
    await manager.restore()
    assert.equal(attempts, 1, 'disabled connections stay off after Host reload')
    fail = false
    const connected = await manager.reconnect(saved.id)
    assert.equal(connected.autoConnect, true, 'retry and other workspace entry points enable restoration')
    await manager.dispose()
    manager = new ConnectionsManager(createStore(provider), options)
    await manager.restore()
    assert.equal(attempts, 3, 'unloading an enabled connection retains its restoration preference')
    assert.equal((await manager.list())[0]?.phase, 'connected')
  } finally { await manager.dispose() }
})

test('turning off a pending connection persists before cancellation and a late result cannot revive it', async () => {
  const store = createStore(credentials()), entered = deferred<void>(), release = deferred<Tunnel>()
  const tunnel = fakeTunnel()
  const manager = new ConnectionsManager(store, {
    connectTunnel: async () => { entered.resolve(); return release.promise },
    probe: async () => { assert.fail('a cancelled transport must not authenticate') },
  })
  try {
    const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl, autoConnect: false })
    const pending = assert.rejects(manager.connect(saved.id), /cancelled/)
    await entered.promise
    assert.equal((await store.read(saved.id))?.autoConnect, true)
    const disconnected = manager.disconnect(saved.id)
    // Wait for the persistent transaction without waiting for an SSH child that
    // ignores abort and has not yet returned its transport.
    for (let attempt = 0; (await store.read(saved.id))?.autoConnect && attempt < 10; attempt++) {
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal((await store.read(saved.id))?.autoConnect, false)
    release.resolve(tunnel)
    assert.equal((await disconnected).phase, 'disconnected')
    await pending
    assert.equal(tunnel.closes, 1)
    const view = (await manager.list())[0]!
    assert.equal(view.autoConnect, false)
    assert.equal(view.error, undefined)
  } finally { release.resolve(tunnel); await manager.dispose() }
})

test('preference storage failures leave the current connection intent and transport unchanged', async () => {
  const provider = credentials(), modify = provider.modifyRecord
  let fail = false, attempts = 0
  const tunnel = fakeTunnel()
  provider.modifyRecord = async (key, mutate) => {
    if (fail) throw new Error('credential storage unavailable')
    return modify(key, mutate)
  }
  const store = createStore(provider)
  const manager = new ConnectionsManager(store, {
    connectTunnel: async () => { attempts++; return tunnel }, probe: async () => PROBE_COOKIE,
  })
  try {
    const saved = await manager.save({ name: 'Work', target: 'dev', launchUrl, autoConnect: false })
    fail = true
    await assert.rejects(manager.connect(saved.id), /credential storage unavailable/)
    assert.equal(attempts, 0)
    assert.equal((await store.read(saved.id))?.autoConnect, false)
    fail = false
    await manager.connect(saved.id)
    fail = true
    await assert.rejects(manager.disconnect(saved.id), /credential storage unavailable/)
    assert.equal(tunnel.closes, 0)
    assert.equal((await manager.list())[0]?.phase, 'connected')
    assert.equal((await store.read(saved.id))?.autoConnect, true)
  } finally { fail = false; await manager.dispose() }
})

test('remote updates and destination edits preserve the saved restoration preference', async () => {
  const store = createStore(credentials())
  const host = async () => ({ remotePort: 3080, token: TOKEN, version: '0.2.1-rc.3', pid: 512, service: 'systemd' as const })
  const manager = new ConnectionsManager(store, {
    prepareHost: host, updateHost: host, connectTunnel: async () => fakeTunnel(), probe: async () => PROBE_COOKIE,
  })
  try {
    const saved = await manager.save({ name: 'Managed', target: 'dev', mode: 'managed', autoConnect: false })
    assert.equal((await manager.update({ id: saved.id })).autoConnect, false)
    assert.equal((await store.read(saved.id))?.autoConnect, false)
    await manager.connect(saved.id)
    const edited = await manager.save({ id: saved.id, name: 'Renamed', target: 'another', mode: 'managed' })
    assert.equal(edited.phase, 'disconnected')
    assert.equal(edited.autoConnect, true, 'internal transport cleanup does not disable the connection')
    await manager.update({ id: saved.id })
    assert.equal((await store.read(saved.id))?.autoConnect, true)
  } finally { await manager.dispose() }
})
