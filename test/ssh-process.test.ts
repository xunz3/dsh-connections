import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SshTunnelError } from '../src/host/ssh.js'
import { SSH_DIAGNOSTIC_MESSAGES } from '../src/host/ssh-common.js'
import { spawnSshMaster, terminateSshProcess } from '../src/host/ssh-process.js'

test('typed Host diagnostics always use fixed messages rather than an arbitrary supplied message', () => {
  for (const [code, diagnostic] of [['SSH_FORWARD', 'CONTROL_PATH'], ['SSH_FAILED', 'SUPERVISOR']] as const) {
    const error = new SshTunnelError(code, 'private-runtime-detail token=must-not-leak', diagnostic)
    assert.equal(error.code, code)
    assert.equal(error.diagnostic, diagnostic)
    assert.equal(error.message, SSH_DIAGNOSTIC_MESSAGES[diagnostic])
    assert.ok(!error.message.includes('must-not-leak'))
  }
})

test('supervisor startup rejection has a fixed SSH failure instead of leaking runtime diagnostics', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-supervisor-test-'))
  try {
    const owner = spawnSshMaster(process.execPath, ['-e', 'process.exit(0)'], directory, 10, { ...process.env, NODE_OPTIONS: '--dsh-invalid-supervisor-option-private-detail' })
    owner.child.stderr?.resume()
    const result = await owner.result
    assert.ok(result.error instanceof SshTunnelError)
    assert.equal(result.error.code, 'SSH_FAILED')
    assert.equal(result.error.diagnostic, 'SUPERVISOR')
    assert.match(result.error.message, /supervisor.*Node runtime.*Desktop installation/)
    assert.ok(!result.error.message.includes('private-detail'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('synchronous supervisor launch rejection is contained as an SSH failure', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-supervisor-test-'))
  try {
    assert.throws(() => spawnSshMaster('ssh', [], directory, 10, { ...process.env, PRIVATE_INVALID_ENV: '\0' }), error => {
      assert.ok(error instanceof SshTunnelError)
      assert.equal(error.code, 'SSH_FAILED')
      assert.equal(error.diagnostic, 'SUPERVISOR')
      assert.match(error.message, /supervisor/)
      assert.ok(!error.message.includes('PRIVATE_INVALID_ENV'))
      return true
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('supervisor preserves actual SSH spawn failures and exit statuses after startup', { skip: process.platform === 'win32' }, async () => {
  for (const missing of [true, false]) {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-supervisor-test-'))
    try {
      const owner = spawnSshMaster(missing ? '/does-not-exist/dsh-ssh' : process.execPath, missing ? [] : ['-e', 'process.exit(23)'], directory, 10, process.env)
      owner.child.stderr?.resume()
      const result = await owner.result
      if (missing) {
        assert.equal((result.error as NodeJS.ErrnoException).code, 'ENOENT')
        assert.ok(!(result.error instanceof SshTunnelError), 'missing SSH must remain distinct from a missing supervisor runtime')
      } else assert.deepEqual(result, { code: 23 })
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})

test('cleanup never signals a PID or process group after its leader has exited', async t => {
  const kill = t.mock.method(process, 'kill', () => true)
  let destroyed = 0
  const child = {
    pid: 12345, exitCode: 0, signalCode: null,
    stdin: { destroy: () => { destroyed++ } }, stdout: { destroy: () => { destroyed++ } }, stderr: { destroy: () => { destroyed++ } },
    kill: () => { assert.fail('an exited child cannot be killed') },
  } as unknown as ChildProcess
  await terminateSshProcess(child, Promise.resolve(), 1)
  assert.equal(kill.mock.callCount(), 0)
  assert.equal(destroyed, 3)
})

test('POSIX cleanup does not send a late SIGKILL after observing leader exit', { skip: process.platform === 'win32' }, async t => {
  const kill = t.mock.method(process, 'kill', () => true)
  const child = { pid: 12345, exitCode: null as number | null, signalCode: null }
  const done = Promise.resolve().then(() => { child.exitCode = 0 })
  await terminateSshProcess(child as ChildProcess, done, 1)
  assert.deepEqual(kill.mock.calls.map(call => call.arguments), [[-12345, 'SIGTERM']])
})
