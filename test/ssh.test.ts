import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fsPromises, { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { createConnection, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { connectTunnel, SshTunnelError, type SshTunnelOptions } from '../src/host/ssh.js'
import { checkSshTarget } from '../src/host/ssh-check.js'

interface Invocation { pid: number; args: string[]; event: string }

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-test-'))
  const log = join(directory, 'calls.jsonl')
  const options: SshTunnelOptions = {
    sshPath: fileURLToPath(new URL('./fixtures/fake-ssh.mjs', import.meta.url)),
    configFile: join(directory, 'ssh-config'),
    env: { ...process.env, TEST_SSH_LOG: log, ...env },
    startupTimeoutMs: 3_000, controlTimeoutMs: 1_000, shutdownGraceMs: 100,
  }
  const calls = async (): Promise<Invocation[]> => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Invocation)
  return { options, calls, dispose: () => rm(directory, { recursive: true, force: true }) }
}

async function assertDisposed(calls: Invocation[]): Promise<void> {
  const master = calls.find((call) => call.args.includes('-M'))
  if (master) {
    const controlPath = master.args[master.args.indexOf('-S') + 1]!
    await assert.rejects(stat(dirname(controlPath)), { code: 'ENOENT' })
  }
  for (const pid of new Set(calls.map((call) => call.pid))) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `SSH process ${pid} should have exited`)
  }
}

test('rejects command-like targets and invalid ports before starting SSH', async () => {
  const f = await fixture()
  try {
    for (const target of ['-Fconfig', 'host name', 'host;echo', '$(command)', 'user@host\n', 'ssh://host', 'host:2222']) {
      await assert.rejects(connectTunnel({ target, remotePort: 3080 }, f.options), TypeError)
    }
    for (const remotePort of [0, 65536, 1.5, NaN]) await assert.rejects(connectTunnel({ target: 'dev', remotePort }, f.options), TypeError)
    assert.deepEqual(await f.calls(), [])
  } finally { await f.dispose() }
})

test('owns a private master, clears configured forwards and acknowledges one loopback forward', async () => {
  const f = await fixture()
  const tunnel = await connectTunnel({ target: 'user@dev', remotePort: 3080 }, f.options)
  try {
    const calls = await f.calls()
    const master = calls.find((call) => call.args.includes('-M'))!
    const controlPath = master.args[master.args.indexOf('-S') + 1]!
    assert.equal((await stat(dirname(controlPath))).mode & 0o777, 0o700)
    for (const option of ['ClearAllForwardings=yes', 'BatchMode=yes', 'StrictHostKeyChecking=yes', 'ControlPersist=no', 'ForwardAgent=no', 'ForwardX11=no', 'PermitLocalCommand=no', 'RemoteCommand=none', 'Tunnel=no', 'ForkAfterAuthentication=no']) assert.ok(master.args.includes(option), option)
    assert.deepEqual(master.args.slice(-2), ['--', 'user@dev'])
    const controls = calls.filter((call) => call.args.includes('-O'))
    assert.equal(controls.length, 2)
    for (const call of controls) assert.deepEqual(call.args.slice(0, 2), ['-F', 'none'])
    const forward = controls.find((call) => call.args.includes('forward'))!
    assert.equal(forward.args[forward.args.indexOf('-L') + 1], `127.0.0.1:${tunnel.port}:127.0.0.1:3080`)
    let closed = 0
    tunnel.onClose((error) => { assert.equal(error, undefined); closed++ })
    await Promise.all([tunnel.close(), tunnel.close()])
    assert.equal(closed, 1)
    await assertDisposed(await f.calls())
  } finally { await tunnel.close(); await f.dispose() }
})

for (const segment of ['a'.repeat(90), '临'.repeat(30)]) test(`oversized ${segment.startsWith('a') ? 'ASCII' : 'UTF-8'} ControlPaths fall back to a private /tmp directory`, { skip: process.platform === 'win32' }, async () => {
  const f = await fixture()
  const previousTmpdir = process.env.TMPDIR
  const longRoot = join(dirname(f.options.configFile!), segment)
  await mkdir(longRoot, { recursive: true })
  let tunnel: Awaited<ReturnType<typeof connectTunnel>> | undefined
  try {
    process.env.TMPDIR = longRoot
    tunnel = await connectTunnel({ target: 'dev', remotePort: 3080 }, f.options)
    const master = (await f.calls()).find(call => call.args.includes('-M'))!
    const controlPath = master.args[master.args.indexOf('-S') + 1]!
    assert.match(controlPath, /^\/tmp\/dshc-[^/]+\/s$/)
    assert.ok(Buffer.byteLength(controlPath) + 17 < 104, 'reserve OpenSSH temporary suffix and NUL in the portable socket bound')
    assert.equal((await stat(dirname(controlPath))).mode & 0o777, 0o700)
    assert.deepEqual(await readdir(longRoot), [], 'do not allocate an unusable private directory in the long TMPDIR')
    await tunnel.close()
    await assertDisposed(await f.calls())
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
    await tunnel?.close()
    await f.dispose()
  }
})

test('ControlPath byte budget includes the temporary OpenSSH suffix and terminating NUL', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture()
  const base = await mkdtemp('/tmp/dsh-socket-budget-')
  const previousTmpdir = process.env.TMPDIR
  let tunnel: Awaited<ReturnType<typeof connectTunnel>> | undefined
  try {
    for (const excess of [0, 1]) {
      // Root + /dshc-XXXXXX/s is 86 bytes at the safe boundary; OpenSSH's
      // 17-byte temporary suffix leaves one byte for NUL in sun_path[104].
      const root = join(base, 'a'.repeat(72 - Buffer.byteLength(base) - 1 + excess))
      await mkdir(root, { mode: 0o700 })
      process.env.TMPDIR = root
      tunnel = await connectTunnel({ target: 'dev', remotePort: 3080 }, f.options)
      const master = (await f.calls()).filter(call => call.args.includes('-M')).at(-1)!
      const controlPath = master.args[master.args.indexOf('-S') + 1]!
      assert.equal(controlPath.startsWith(root + '/'), excess === 0)
      assert.ok(Buffer.byteLength(controlPath) + 17 < 104)
      await tunnel.close()
    }
    await assertDisposed(await f.calls())
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
    await tunnel?.close()
    await rm(base, { recursive: true, force: true })
    await f.dispose()
  }
})

test('an unavailable short ControlPath fallback reports a fixed actionable SSH diagnostic', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture()
  const previousTmpdir = process.env.TMPDIR
  try {
    process.env.TMPDIR = '/private/' + 'secret-credential'.repeat(20)
    const create = t.mock.method(fsPromises, 'mkdtemp', async (prefix: string) => {
      assert.equal(prefix, '/tmp/dshc-')
      throw Object.assign(new Error('Private filesystem detail and secret-credential'), { code: 'EACCES' })
    })
    syncBuiltinESMExports()
    await assert.rejects(connectTunnel({ target: 'dev', remotePort: 3080 }, f.options), error => {
      assert.ok(error instanceof SshTunnelError)
      assert.equal(error.code, 'SSH_FORWARD')
      assert.equal(error.diagnostic, 'CONTROL_PATH')
      assert.match(error.message, /ControlPath.*\/tmp fallback.*TMPDIR.*permissions/)
      assert.ok(!error.message.includes('secret-credential'))
      assert.ok(!error.message.includes('Private filesystem'))
      return true
    })
    assert.equal(create.mock.callCount(), 1)
    assert.equal(create.mock.calls[0]!.arguments[0], '/tmp/dshc-')
    assert.deepEqual(await f.calls(), [], 'a failed private socket allocation never starts SSH')
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
    await f.dispose()
  }
})

test('a lost port reservation is retried only after SSH rejects its bind', async () => {
  const f = await fixture({ TEST_SSH_FORWARD_RACES: '1' })
  try {
    const tunnel = await connectTunnel({ target: 'dev', remotePort: 3080 }, f.options)
    assert.ok(tunnel.port > 0)
    assert.equal((await f.calls()).filter((call) => call.args.includes('forward')).length, 2)
    await tunnel.close()
    await assertDisposed(await f.calls())
  } finally { await f.dispose() }
})

test('legacy OpenSSH ignores the new foreground option while current clients keep the override', async () => {
  const f = await fixture({ TEST_SSH_LEGACY_OPTIONS: '1' })
  try {
    const tunnel = await connectTunnel({ target: 'dev', remotePort: 3080 }, f.options)
    const args = (await f.calls()).find(call => call.args.includes('-M'))!.args
    assert.ok(args.includes('ForkAfterAuthentication=no'))
    assert.ok(args.indexOf('IgnoreUnknown=ForkAfterAuthentication') < args.indexOf('ForkAfterAuthentication=no'))
    await tunnel.close()
    await assertDisposed(await f.calls())
  } finally { await f.dispose() }
})

test('reuses the previous origin only after owning its bind and falls back when occupied', async () => {
  const f = await fixture()
  let tunnel = await connectTunnel({ target: 'dev', remotePort: 3080 }, f.options)
  const previous = tunnel.port
  await tunnel.close()
  const occupied = createServer(socket => socket.destroy())
  try {
    tunnel = await connectTunnel({ target: 'dev', remotePort: 3080, preferredLocalPort: previous }, f.options)
    assert.equal(tunnel.port, previous)
    await tunnel.close()
    await new Promise<void>(resolve => occupied.listen(previous, '127.0.0.1', resolve))
    tunnel = await connectTunnel({ target: 'dev', remotePort: 3080, preferredLocalPort: previous }, f.options)
    assert.notEqual(tunnel.port, previous)
  } finally {
    await tunnel.close()
    if (occupied.listening) await new Promise<void>(resolve => occupied.close(() => resolve()))
    await f.dispose()
  }
})

test('disposal terminates proxy descendants even after the master exits', async () => {
  const f = await fixture({ TEST_SSH_DESCENDANT: '1' })
  try {
    const tunnel = await connectTunnel({ target: 'dev', remotePort: 3080 }, f.options)
    await tunnel.close()
    const calls = await f.calls()
    const descendant = calls.find((call) => call.event === 'descendant')!
    assert.ok(descendant.pid)
    // A killed orphan may briefly be a zombie until the system reaps it.
    let stopped = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(descendant.pid, 0)
        if (process.platform === 'linux' && /^\d+ \(.+\) Z /.test(await readFile(`/proc/${descendant.pid}/stat`, 'utf8'))) { stopped = true; break }
      } catch { stopped = true; break }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(stopped, 'proxy descendant must not remain running')
    await assertDisposed(calls.filter((call) => call.event !== 'descendant'))
  } finally { await f.dispose() }
})

test('Host SIGKILL releases its master, proxy descendants, forward and control directory', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const f = await fixture({ TEST_SSH_DESCENDANT: '1' })
  const owner = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/tunnel-owner.mjs', import.meta.url))], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...f.options.env, NODE_TEST_CONTEXT: undefined, TEST_SSH_PATH: f.options.sshPath },
  })
  let stderr = ''
  owner.stderr?.on('data', data => { stderr += data.toString() })
  const exited = new Promise<void>(resolve => owner.once('close', () => resolve()))
  try {
    const port = await new Promise<number>((resolve, reject) => {
      owner.once('message', message => resolve((message as { port: number }).port))
      owner.once('exit', () => reject(new Error(`Isolated Host exited before connecting: ${stderr}`)))
    })
    const calls = await f.calls()
    const master = calls.find(call => call.args.includes('-M'))!
    const directory = dirname(master.args[master.args.indexOf('-S') + 1]!)
    assert.ok((await stat(directory)).isDirectory())
    owner.kill('SIGKILL')
    await exited
    for (let attempt = 0; attempt < 300; attempt++) {
      if (!await stat(directory).then(() => true, () => false)) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await assert.rejects(stat(directory), { code: 'ENOENT' })
    for (const { pid } of calls) {
      let stopped = false
      for (let attempt = 0; attempt < 300; attempt++) {
        try {
          process.kill(pid, 0)
          if (process.platform === 'linux' && /^\d+ \(.+\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'))) { stopped = true; break }
        } catch { stopped = true; break }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.ok(stopped, `Owned SSH process ${pid} must stop after its Host dies`)
    }
    const replacement = createServer()
    try {
      await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(port, '127.0.0.1', resolve) })
    } finally { await new Promise<void>(resolve => replacement.close(() => resolve())) }
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL')
    await exited
    await f.dispose()
  }
})

test('failed forwards never become connected and retries are bounded', async () => {
  const f = await fixture({ TEST_SSH_FORWARD_FAIL: '1' })
  try {
    await assert.rejects(connectTunnel({ target: 'dev', remotePort: 3080 }, f.options), { code: 'SSH_FORWARD' })
    assert.equal((await f.calls()).filter((call) => call.args.includes('forward')).length, 4)
    await assertDisposed(await f.calls())
  } finally { await f.dispose() }
})

for (const [message, code] of [
  ['Host key verification failed.', 'SSH_HOST_KEY'],
  ['Permission denied (publickey).', 'SSH_AUTH'],
] as const) {
  test(`reports ${code} and cleans failed masters`, async () => {
    const f = await fixture({ TEST_SSH_MASTER_ERROR: message })
    try {
      await assert.rejects(connectTunnel({ target: 'dev', remotePort: 3080 }, f.options), { code })
      await assertDisposed(await f.calls())
    } finally { await f.dispose() }
  })
}

test('missing OpenSSH is actionable', async () => {
  await assert.rejects(connectTunnel({ target: 'dev', remotePort: 3080 }, { sshPath: '/does-not-exist/dsh-ssh' }), { code: 'SSH_UNAVAILABLE' })
})

test('a supervisor that cannot start is classified separately from SSH authentication and missing OpenSSH', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture({ NODE_OPTIONS: '--dsh-invalid-supervisor-option-private-detail' })
  try {
    await assert.rejects(connectTunnel({ target: 'dev', remotePort: 3080 }, f.options), error => {
      assert.ok(error instanceof SshTunnelError)
      assert.equal(error.code, 'SSH_FAILED')
      assert.equal(error.diagnostic, 'SUPERVISOR')
      assert.match(error.message, /supervisor.*Node runtime.*Desktop installation/)
      assert.ok(!error.message.includes('private-detail'))
      return true
    })
    assert.deepEqual(await f.calls(), [], 'runtime startup failed before OpenSSH was launched')
  } finally { await f.dispose() }
})

test('bounds diagnostic output and redacts launch credentials', async () => {
  const f = await fixture({ TEST_SSH_MASTER_ERROR: `${'x'.repeat(10_000)}\u001b[31m http://localhost/?token=secret-credential` })
  try {
    await assert.rejects(connectTunnel({ target: 'dev', remotePort: 3080 }, f.options), (error: unknown) => {
      assert.ok(error instanceof SshTunnelError)
      assert.ok(error.message.length < 700)
      assert.ok(!error.message.includes('secret-credential'))
      assert.ok(!error.message.includes('\u001b'))
      return true
    })
    await assertDisposed(await f.calls())
  } finally { await f.dispose() }
})

test('startup timeout terminates a master that never creates its socket', async () => {
  const f = await fixture({ TEST_SSH_HANG: 'master' })
  try {
    await assert.rejects(connectTunnel({ target: 'dev', remotePort: 3080 }, { ...f.options, startupTimeoutMs: 150 }), { code: 'SSH_TIMEOUT' })
    await assertDisposed(await f.calls())
  } finally { await f.dispose() }
})

test('a hanging control request is bounded and disposed with its master', async () => {
  const f = await fixture({ TEST_SSH_HANG: 'forward' })
  try {
    await assert.rejects(connectTunnel({ target: 'dev', remotePort: 3080 }, { ...f.options, controlTimeoutMs: 150 }), { code: 'SSH_TIMEOUT' })
    await assertDisposed(await f.calls())
  } finally { await f.dispose() }
})

test('cancellation before startup does not launch SSH', async () => {
  const f = await fixture()
  try {
    await assert.rejects(connectTunnel({ target: 'dev', remotePort: 3080, signal: AbortSignal.abort() }, f.options), { name: 'AbortError' })
    assert.deepEqual(await f.calls(), [])
  } finally { await f.dispose() }
})

test('cancellation during connect kills every owned child', async () => {
  const f = await fixture({ TEST_SSH_HANG: 'forward' })
  const controller = new AbortController()
  try {
    const pending = connectTunnel({ target: 'dev', remotePort: 3080, signal: controller.signal }, f.options)
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    for (let i = 0; i < 100; i++) {
      if ((await f.calls()).some((call) => call.args.includes('forward'))) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    controller.abort()
    await rejected
    await assertDisposed(await f.calls())
  } finally { controller.abort(); await f.dispose() }
})

test('cancellation after connect closes the tunnel; late listeners also observe closure', async () => {
  const f = await fixture()
  const controller = new AbortController()
  try {
    const tunnel = await connectTunnel({ target: 'dev', remotePort: 3080, signal: controller.signal }, f.options)
    const closed = new Promise<Error | undefined>((resolve) => tunnel.onClose(resolve))
    controller.abort()
    assert.equal((await closed)?.name, 'AbortError')
    assert.equal((await new Promise<Error | undefined>((resolve) => tunnel.onClose(resolve)))?.name, 'AbortError')
    await assertDisposed(await f.calls())
  } finally { controller.abort(); await f.dispose() }
})

test('an unexpected master exit notifies once and does not silently reconnect', async () => {
  const f = await fixture({ TEST_SSH_EXIT_AFTER_FORWARD: '100' })
  try {
    const tunnel = await connectTunnel({ target: 'dev', remotePort: 3080 }, f.options)
    const error = await new Promise<Error | undefined>((resolve) => tunnel.onClose(resolve))
    assert.ok(error instanceof SshTunnelError)
    assert.equal(error.code, 'SSH_CLOSED')
    await tunnel.close()
    assert.equal((await f.calls()).filter((call) => call.args.includes('-M')).length, 1)
    await assertDisposed(await f.calls())
  } finally { await f.dispose() }
})

for (const transport of ['control', 'stdio'] as const) test(`real OpenSSH ${transport} preserves remote HTTP and clears configured forwards`, { skip: process.env.DSH_CONNECTIONS_TEST_SSHD !== '1', timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-sshd-test-'))
  const server = createHttpServer((_, response) => response.end('native-harness-fixture'))
  const occupied = createServer((socket) => socket.end('must remain owned by this test'))
  let daemon: ChildProcess | undefined
  let tunnel: Awaited<ReturnType<typeof connectTunnel>> | undefined
  const portOf = (listening: ReturnType<typeof createServer> | ReturnType<typeof createHttpServer>): number => {
    const address = listening.address()
    assert.ok(address && typeof address !== 'string')
    return address.port
  }
  const listen = (listening: ReturnType<typeof createServer> | ReturnType<typeof createHttpServer>): Promise<void> => new Promise((resolve, reject) => {
    listening.once('error', reject)
    listening.listen(0, '127.0.0.1', resolve)
  })
  try {
    await listen(server)
    await listen(occupied)
    const reservation = createServer()
    await listen(reservation)
    const sshPort = portOf(reservation)
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const execute = promisify(execFile)
    const hostKey = join(directory, 'host')
    const clientKey = join(directory, 'client')
    await execute('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey])
    await execute('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey])
    const daemonConfig = join(directory, 'sshd_config')
    const clientConfig = join(directory, 'ssh_config')
    const knownHosts = join(directory, 'known_hosts')
    await writeFile(daemonConfig, [
      `Port ${sshPort}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey}`,
      `PidFile ${join(directory, 'sshd.pid')}`, `AuthorizedKeysFile ${clientKey}.pub`,
      'StrictModes no', 'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
      'AuthenticationMethods publickey', 'AllowTcpForwarding local', 'PermitOpen 127.0.0.1:*', 'GatewayPorts no', 'LogLevel ERROR',
    ].join('\n') + '\n', { mode: 0o600 })
    await writeFile(clientConfig, [
      'Host fixture', ' HostName 127.0.0.1', ` Port ${sshPort}`, ` User ${userInfo().username}`,
      ` IdentityFile ${clientKey}`, ' IdentitiesOnly yes', ` UserKnownHostsFile ${knownHosts}`,
      ' GlobalKnownHostsFile /dev/null',
      // Request-bearing stdio forwards must override this user preference.
      ' StdinNull yes',
      // This bind would fail and abort the master if ClearAllForwardings did not work.
      ` LocalForward 127.0.0.1:${portOf(occupied)} 127.0.0.1:${portOf(server)}`,
    ].join('\n') + '\n', { mode: 0o600 })
    daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', daemonConfig], { stdio: ['ignore', 'ignore', 'pipe'] })
    let daemonError = ''
    daemon.stderr?.on('data', (chunk: Buffer) => { daemonError = (daemonError + chunk.toString()).slice(-2_000) })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (daemon.exitCode !== null) assert.fail(`Temporary sshd exited: ${daemonError}`)
      const ready = await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: '127.0.0.1', port: sshPort })
        socket.once('error', () => resolve(false))
        socket.once('connect', () => { socket.destroy(); resolve(true) })
      })
      if (ready) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const options = { configFile: clientConfig, startupTimeoutMs: 3_000, transport }
    await assert.rejects(checkSshTarget({ target: 'fixture' }, options), { code: 'SSH_HOST_KEY' })
    await assert.rejects(stat(knownHosts), { code: 'ENOENT' }, 'A check cannot trust an unknown host automatically.')
    if (transport === 'control') {
      await assert.rejects(connectTunnel({ target: 'fixture', remotePort: portOf(server) }, options), { code: 'SSH_HOST_KEY' })
    } else {
      const untrusted = await connectTunnel({ target: 'fixture', remotePort: portOf(server) }, options)
      const failure = new Promise<Error | undefined>(resolve => untrusted.onClose(resolve))
      await assert.rejects(fetch(`http://127.0.0.1:${untrusted.port}`))
      assert.equal((await failure as SshTunnelError).code, 'SSH_HOST_KEY')
      await untrusted.close()
    }
    const publicKey = (await readFile(`${hostKey}.pub`, 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ')
    await writeFile(knownHosts, `[127.0.0.1]:${sshPort} ${publicKey}\n`, { mode: 0o600 })
    const trustedKeys = await readFile(knownHosts, 'utf8')
    await checkSshTarget({ target: 'fixture' }, options)
    assert.equal(await readFile(knownHosts, 'utf8'), trustedKeys, 'A check must preserve existing host trust.')
    tunnel = await connectTunnel({ target: 'fixture', remotePort: portOf(server) }, options)
    assert.equal(await (await fetch(`http://127.0.0.1:${tunnel.port}`)).text(), 'native-harness-fixture')
    await tunnel.close()
    assert.equal(await (await fetch(`http://127.0.0.1:${portOf(server)}`)).text(), 'native-harness-fixture', 'disconnect does not stop the remote service')
    assert.equal(daemon.exitCode, null)
  } finally {
    await tunnel?.close()
    if (daemon && daemon.exitCode === null) {
      daemon.kill('SIGTERM')
      await new Promise<void>((resolve) => daemon!.once('close', () => resolve()))
    }
    server.closeAllConnections()
    await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => occupied.close(() => resolve()))])
    await rm(directory, { recursive: true, force: true })
  }
})
