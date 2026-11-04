import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { connectTunnel, SshTunnelError, type SshTunnelOptions, type Tunnel } from '../src/host/ssh.js'

interface Invocation { pid: number; args: string[] }
const pause = () => new Promise(resolve => setTimeout(resolve, 10))

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-stdio-test-'))
  const log = join(directory, 'calls.jsonl')
  const options: SshTunnelOptions = {
    transport: 'stdio', sshPath: fileURLToPath(new URL('./fixtures/fake-ssh-stdio.mjs', import.meta.url)),
    env: { ...process.env, TEST_SSH_LOG: log, ...env }, shutdownGraceMs: 100,
  }
  const calls = async (): Promise<Invocation[]> => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Invocation)
  return { options, calls, dispose: () => rm(directory, { recursive: true, force: true }) }
}

async function assertStopped(calls: Invocation[]) {
  for (const { pid } of calls) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `SSH process ${pid} must exit`)
}

test('stdio bridge owns its preferred bind, falls back atomically and forwards independent HTTP streams', async () => {
  const f = await fixture()
  const remote = createHttpServer((_, response) => { response.setHeader('Connection', 'close'); response.end('native-fixture') })
  const occupied = createServer(socket => socket.destroy())
  let tunnel: Tunnel | undefined
  try {
    const remotePort = await listen(remote)
    const previous = await listen(occupied)
    tunnel = await connectTunnel({ target: 'dev', remotePort, preferredLocalPort: previous }, f.options)
    assert.notEqual(tunnel.port, previous)
    assert.deepEqual(await f.calls(), [], 'binding alone does not claim SSH authentication')
    let closes = 0
    tunnel.onClose(() => { closes++ })
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(await (await fetch(`http://127.0.0.1:${tunnel.port}`)).text(), 'native-fixture')
    }
    assert.equal(closes, 0, 'ordinary remote EOF does not close the bridge')
    const calls = await f.calls()
    assert.equal(calls.length, 2)
    for (const { args } of calls) {
      assert.equal(args[args.indexOf('-W') + 1], `127.0.0.1:${remotePort}`)
      for (const option of ['ClearAllForwardings=yes', 'ControlMaster=no', 'ControlPath=none', 'ControlPersist=no', 'BatchMode=yes', 'StrictHostKeyChecking=yes', 'ExitOnForwardFailure=yes', 'ForwardAgent=no', 'RemoteCommand=none', 'ForkAfterAuthentication=no', 'StdinNull=no']) assert.ok(args.includes(option), option)
    }
    const reusablePort = tunnel.port
    await Promise.all([tunnel.close(), tunnel.close()])
    assert.equal(closes, 1)
    tunnel = await connectTunnel({ target: 'dev', remotePort, preferredLocalPort: reusablePort }, f.options)
    assert.equal(tunnel.port, reusablePort)
    await tunnel.close()
    await assertStopped(await f.calls())
  } finally {
    await tunnel?.close()
    remote.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => remote.close(() => resolve())), new Promise<void>(resolve => occupied.close(() => resolve()))])
    await f.dispose()
  }
})

for (const [message, code] of [
  ['Host key verification failed.', 'SSH_HOST_KEY'],
  ['Permission denied (publickey).', 'SSH_AUTH'],
  ['channel 0: open failed: administratively prohibited: open failed', 'SSH_FORWARD'],
  ['channel 0: open failed: connect failed: Permission denied\nstdio forwarding failed', 'SSH_FORWARD'],
] as const) {
  test(`stdio first-use ${code} failure closes the bridge with its SSH reason`, async () => {
    const f = await fixture({ TEST_SSH_STDIO_ERROR: message })
    const tunnel = await connectTunnel({ target: 'dev', remotePort: 3080 }, f.options)
    try {
      const failure = new Promise<Error | undefined>(resolve => tunnel.onClose(resolve))
      await assert.rejects(fetch(`http://127.0.0.1:${tunnel.port}`))
      const error = await failure
      assert.ok(error instanceof SshTunnelError)
      assert.equal(error.code, code)
      assert.equal(await new Promise<Error | undefined>(resolve => tunnel.onClose(resolve)), error)
      await tunnel.close()
      await assertStopped(await f.calls())
    } finally { await tunnel.close(); await f.dispose() }
  })
}

test('stdio missing SSH is reported by first-use failure rather than a successful connection', async () => {
  const tunnel = await connectTunnel({ target: 'dev', remotePort: 3080 }, { transport: 'stdio', sshPath: '/does-not-exist/dsh-ssh' })
  try {
    const failure = new Promise<Error | undefined>(resolve => tunnel.onClose(resolve))
    await assert.rejects(fetch(`http://127.0.0.1:${tunnel.port}`))
    assert.equal((await failure as SshTunnelError).code, 'SSH_UNAVAILABLE')
  } finally { await tunnel.close() }
})

for (const [message, code] of [
  ['Permission denied (publickey).', 'SSH_AUTH'],
  ['Host key verification failed.', 'SSH_HOST_KEY'],
] as const) test(`a later ${code} failure closes the connection and every active stream exactly once`, { timeout: 10_000 }, async () => {
  const f = await fixture()
  const remoteSockets = new Set<ReturnType<typeof createConnection>>()
  const remote = createServer(socket => {
    remoteSockets.add(socket)
    socket.once('close', () => remoteSockets.delete(socket))
    socket.write('ready')
  })
  const tunnel = await connectTunnel({ target: 'dev', remotePort: await listen(remote) }, f.options)
  const persistent = createConnection({ host: '127.0.0.1', port: tunnel.port })
  persistent.on('error', () => {})
  try {
    await new Promise<void>(resolve => persistent.once('data', () => resolve()))
    const persistentClosed = new Promise<void>(resolve => persistent.once('close', () => resolve()))
    let closes = 0
    const failure = new Promise<Error | undefined>(resolve => tunnel.onClose(error => { closes++; resolve(error) }))
    f.options.env!.TEST_SSH_STDIO_ERROR = message
    const failed = createConnection({ host: '127.0.0.1', port: tunnel.port })
    failed.on('error', () => {})
    await new Promise<void>(resolve => failed.once('close', () => resolve()))
    const error = await failure
    assert.ok(error instanceof SshTunnelError)
    assert.equal(error.code, code)
    await persistentClosed
    await Promise.all([tunnel.close(), tunnel.close()])
    assert.equal(closes, 1)
    assert.equal(await new Promise<Error | undefined>(resolve => tunnel.onClose(resolve)), error, 'late listeners retain the classified reason')
    const calls = await f.calls()
    assert.equal(calls.length, 2, 'fatal failures never retry SSH authentication automatically')
    await assertStopped(calls)
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: tunnel.port })
      socket.once('error', reject)
      socket.once('connect', () => { socket.destroy(); resolve() })
    }))
    assert.equal((await f.calls()).length, calls.length)
  } finally {
    persistent.destroy()
    await tunnel.close()
    remoteSockets.forEach(socket => socket.destroy())
    await new Promise<void>(resolve => remote.close(() => resolve()))
    await f.dispose()
  }
})

test('stdio cancellation during the initial bind cannot leave an owned listener behind', async () => {
  const reservation = createServer()
  const port = await listen(reservation)
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const controller = new AbortController()
  const pending = connectTunnel({ target: 'dev', remotePort: 3080, preferredLocalPort: port, signal: controller.signal }, { transport: 'stdio' })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  const replacement = createServer()
  try {
    await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(port, '127.0.0.1', resolve) })
  } finally { await new Promise<void>(resolve => replacement.close(() => resolve())) }
})

test('stdio cancellation disposes active forwards and bounds pending SSH processes', async () => {
  const f = await fixture({ TEST_SSH_STDIO_HANG: '1' })
  const controller = new AbortController()
  const tunnel = await connectTunnel({ target: 'dev', remotePort: 3080, signal: controller.signal }, f.options)
  const sockets: ReturnType<typeof createConnection>[] = []
  try {
    for (let i = 0; i < 32; i++) {
      const socket = createConnection({ port: tunnel.port, host: '127.0.0.1' })
      socket.on('error', () => {})
      sockets.push(socket)
    }
    for (let i = 0; i < 500 && (await f.calls()).length < 32; i++) await pause()
    assert.equal((await f.calls()).length, 32)
    const excess = createConnection({ port: tunnel.port, host: '127.0.0.1' })
    excess.on('error', () => {})
    await new Promise<void>(resolve => excess.once('close', () => resolve()))
    assert.equal((await f.calls()).length, 32, 'an extra socket cannot spawn an unbounded process')
    const closed = new Promise<Error | undefined>(resolve => tunnel.onClose(resolve))
    controller.abort()
    assert.equal((await closed)?.name, 'AbortError')
    await tunnel.close()
    await assertStopped(await f.calls())
  } finally {
    sockets.forEach(socket => socket.destroy())
    await tunnel.close()
    await f.dispose()
  }
})

test('stdio browser cancellation only disposes its stream and leaves the bridge usable', async () => {
  const f = await fixture({ TEST_SSH_STDIO_HANG: '1' })
  const tunnel = await connectTunnel({ target: 'dev', remotePort: 3080 }, f.options)
  try {
    let closed = false
    tunnel.onClose(() => { closed = true })
    const socket = createConnection({ port: tunnel.port, host: '127.0.0.1' })
    socket.on('error', () => {})
    for (let i = 0; i < 100 && !(await f.calls()).length; i++) await pause()
    socket.resetAndDestroy()
    for (let i = 0; i < 100; i++) {
      try { process.kill((await f.calls())[0]!.pid, 0) } catch { break }
      await pause()
    }
    assert.equal(closed, false)
    await assertStopped(await f.calls())
  } finally { await tunnel.close(); await f.dispose() }
})

for (const message of ['channel 0: open failed: administratively prohibited: open failed', 'channel 0: open failed: connect failed: Permission denied\nstdio forwarding failed', 'Connection refused', 'Network is unreachable']) test(`a later ${message} failure preserves other streams and allows recovery`, async () => {
  const f = await fixture()
  const remote = createServer(socket => {
    socket.write('ready')
    socket.on('data', data => socket.write(data))
  })
  const tunnel = await connectTunnel({ target: 'dev', remotePort: await listen(remote) }, f.options)
  const persistent = createConnection({ host: '127.0.0.1', port: tunnel.port })
  persistent.on('error', () => {})
  let closes = 0
  tunnel.onClose(() => { closes++ })
  const read = (socket: ReturnType<typeof createConnection>) => new Promise<string>((resolve, reject) => {
    socket.once('data', data => resolve(data.toString()))
    socket.once('error', reject)
  })
  try {
    assert.equal(await read(persistent), 'ready')
    f.options.env!.TEST_SSH_STDIO_ERROR = message
    const failed = createConnection({ host: '127.0.0.1', port: tunnel.port })
    failed.on('error', () => {})
    await new Promise<void>(resolve => failed.once('close', () => resolve()))
    assert.equal(closes, 0)
    const response = read(persistent)
    persistent.write('still connected')
    assert.equal(await response, 'still connected')
    delete f.options.env!.TEST_SSH_STDIO_ERROR
    const sshPath = f.options.sshPath
    f.options.sshPath = '\0'
    const invalidLaunch = createConnection({ host: '127.0.0.1', port: tunnel.port })
    invalidLaunch.on('error', () => {})
    await new Promise<void>(resolve => invalidLaunch.once('close', () => resolve()))
    f.options.sshPath = sshPath
    assert.equal(closes, 0, 'a synchronous launch failure only closes its own stream')
    const recovered = createConnection({ host: '127.0.0.1', port: tunnel.port })
    recovered.on('error', () => {})
    assert.equal(await read(recovered), 'ready')
    recovered.destroy()
    assert.equal(closes, 0)
  } finally {
    persistent.destroy()
    await tunnel.close()
    await new Promise<void>(resolve => remote.close(() => resolve()))
    await f.dispose()
  }
})
