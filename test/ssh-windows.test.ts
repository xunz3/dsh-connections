import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkSshTarget } from '../src/host/ssh-check.js'
import { connectTunnel, SshTunnelError } from '../src/host/ssh.js'

test('synchronous Windows spawn UNKNOWN is contained inside the connection callback', async t => {
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw Object.assign(new Error('spawn UNKNOWN'), { errno: -4094, code: 'UNKNOWN', syscall: 'spawn' }) })
  syncBuiltinESMExports()
  const tunnel = await connectTunnel({ target: 'dev', remotePort: 3080 }, { transport: 'stdio' })
  try {
    const failure = new Promise<Error | undefined>(resolve => tunnel.onClose(resolve))
    await assert.rejects(fetch(`http://127.0.0.1:${tunnel.port}`))
    const error = await failure
    assert.ok(error instanceof SshTunnelError)
    assert.equal(error.code, 'SSH_FORWARD')
    assert.equal(spawn.mock.callCount(), 1)
    await assert.rejects(checkSshTarget({ target: 'dev' }), { code: 'SSH_FAILED' })
  } finally {
    await tunnel.close()
    spawn.mock.restore()
    syncBuiltinESMExports()
  }
})

test('Windows system OpenSSH checks and stdio forwarding fail without terminating the Host', { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-windows-ssh-'))
  const configFile = join(directory, 'ssh_config')
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const address = reservation.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const sshPath = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
  await writeFile(configFile, `Host unreachable-fixture\n HostName 127.0.0.1\n Port ${address.port}\n`)
  const options = { sshPath, configFile, startupTimeoutMs: 5_000, shutdownGraceMs: 100 }
  const tunnel = await connectTunnel({ target: 'unreachable-fixture', remotePort: 3080 }, options)
  try {
    await assert.rejects(checkSshTarget({ target: 'unreachable-fixture' }, options), { code: 'SSH_REFUSED' })
    const failure = new Promise<Error | undefined>(resolve => tunnel.onClose(resolve))
    await assert.rejects(fetch(`http://127.0.0.1:${tunnel.port}`))
    assert.equal((await failure as SshTunnelError).code, 'SSH_REFUSED')
    // Native Windows also reports a missing executable asynchronously.
    const missing = await connectTunnel({ target: 'dev', remotePort: 3080 }, { sshPath: join(directory, 'missing.exe') })
    try {
      const unavailable = new Promise<Error | undefined>(resolve => missing.onClose(resolve))
      await assert.rejects(fetch(`http://127.0.0.1:${missing.port}`))
      assert.equal((await unavailable as SshTunnelError).code, 'SSH_UNAVAILABLE')
    } finally { await missing.close() }
  } finally { await tunnel.close(); await rm(directory, { recursive: true, force: true }) }
})
