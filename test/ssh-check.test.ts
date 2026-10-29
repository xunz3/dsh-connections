import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkSshTarget } from '../src/host/ssh-check.js'
import { SSH_ERROR_MESSAGES, sshProcessError, SshTunnelError, type SshErrorCode, type SshTunnelOptions } from '../src/host/ssh-common.js'
import { prepareHost, RemoteHostError } from '../src/host/lifecycle.js'

interface Invocation { pid: number; args: string[] }

async function fixture(environment: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-check-'))
  const ssh = join(directory, 'ssh')
  const log = join(directory, 'call.json')
  await writeFile(ssh, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.TEST_SSH_LOG, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));
process.stdin.resume();
if (process.env.TEST_SSH_HANG) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(process.env.TEST_SSH_OUTPUT ?? 'DSH_CONNECTIONS_SSH_CHECK_OK\\n');
  process.stderr.write(process.env.TEST_SSH_ERROR ?? '');
  process.exitCode = Number(process.env.TEST_SSH_EXIT ?? 0);
}
`, { mode: 0o755 })
  const options: SshTunnelOptions = { sshPath: ssh, shutdownGraceMs: 20, env: { ...process.env, NODE_TEST_CONTEXT: undefined, TEST_SSH_LOG: log, ...environment } }
  const call = async (): Promise<Invocation | undefined> => {
    const value = await readFile(log, 'utf8').catch(() => '')
    return value ? JSON.parse(value) as Invocation : undefined
  }
  const started = async (): Promise<Invocation> => {
    for (let i = 0; i < 200; i++) {
      const value = await call()
      if (value) return value
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('SSH fixture did not start.')
  }
  return { options, call, started, dispose: () => rm(directory, { recursive: true, force: true }) }
}

function stopped(call: Invocation) {
  assert.throws(() => process.kill(call.pid, 0), { code: 'ESRCH' }, 'The SSH check process must exit before settling.')
}

test('SSH check delegates aliases to system SSH and only executes its fixed read-only command', async () => {
  const f = await fixture({ TEST_SSH_OUTPUT: 'Remote shell banner\nDSH_CONNECTIONS_SSH_CHECK_OK\r\n' })
  try {
    await checkSshTarget({ target: ' user@devbox ' }, { ...f.options, configFile: '/fixture/ssh-config' })
    const call = await f.started()
    assert.deepEqual(call.args.slice(0, 2), ['-F', '/fixture/ssh-config'])
    assert.deepEqual(call.args.slice(-3), ['--', 'user@devbox', "printf '%s\\n' 'DSH_CONNECTIONS_SSH_CHECK_OK'"])
    for (const option of ['ControlMaster=no', 'ControlPath=none', 'ControlPersist=no', 'ClearAllForwardings=yes', 'BatchMode=yes', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no', 'ForwardAgent=no', 'ForwardX11=no', 'Tunnel=no', 'PermitLocalCommand=no', 'RemoteCommand=none', 'ForkAfterAuthentication=no', 'StdinNull=no']) assert.ok(call.args.includes(option), option)
    assert.ok(!call.args.includes('-L') && !call.args.includes('-W'))
    stopped(call)
  } finally { await f.dispose() }
})

test('SSH check rejects invalid targets, invalid deadlines and cancelled requests before spawning', async () => {
  const f = await fixture()
  try {
    await assert.rejects(checkSshTarget({ target: '-oProxyCommand=anything' }, f.options), TypeError)
    await assert.rejects(checkSshTarget({ target: 'devbox' }, { ...f.options, startupTimeoutMs: Infinity }), TypeError)
    await assert.rejects(checkSshTarget({ target: 'devbox', signal: AbortSignal.abort() }, f.options), { name: 'AbortError' })
    assert.equal(await f.call(), undefined)
  } finally { await f.dispose() }
})

test('SSH check requires both successful exit and the complete command marker', async () => {
  for (const environment of [
    { TEST_SSH_OUTPUT: 'Connected\n' },
    { TEST_SSH_OUTPUT: 'prefix-DSH_CONNECTIONS_SSH_CHECK_OK\n' },
    { TEST_SSH_OUTPUT: 'DSH_CONNECTIONS_SSH_CHECK_OK\n', TEST_SSH_EXIT: '1' },
  ]) {
    const f = await fixture(environment)
    try {
      await assert.rejects(checkSshTarget({ target: 'devbox' }, f.options), { code: 'SSH_FAILED' })
      stopped(await f.started())
    } finally { await f.dispose() }
  }
})

test('SSH check bounds output and never returns remote startup output', async () => {
  for (const stream of ['TEST_SSH_OUTPUT', 'TEST_SSH_ERROR']) {
    const f = await fixture({ [stream]: 'private-token-'.repeat(2_000) })
    try {
      await assert.rejects(checkSshTarget({ target: 'devbox' }, f.options), error => {
        assert.ok(error instanceof SshTunnelError)
        assert.equal(error.code, 'SSH_FAILED')
        assert.match(error.message, /too much output/)
        assert.doesNotMatch(error.message, /private-token/)
        return true
      })
      stopped(await f.started())
    } finally { await f.dispose() }
  }
})

test('SSH check cancellation and timeout clean up unresponsive owned processes', { timeout: 6_000 }, async () => {
  for (const cancel of [true, false]) {
    const f = await fixture({ TEST_SSH_HANG: '1' })
    const controller = new AbortController()
    try {
      const pending = checkSshTarget({ target: 'devbox', signal: controller.signal }, { ...f.options, startupTimeoutMs: 500 })
      const rejected = assert.rejects(pending, cancel ? { name: 'AbortError' } : { code: 'SSH_TIMEOUT' })
      const call = await f.started()
      if (cancel) controller.abort()
      await rejected
      stopped(call)
    } finally { controller.abort(); await f.dispose() }
  }
})

const failures: Array<[string, SshErrorCode, string]> = [
  ['Host key verification failed.', 'SSH_HOST_KEY', 'ssh-host-key'],
  ['Permission denied (publickey).', 'SSH_AUTH', 'ssh-auth'],
  ['Too many authentication failures', 'SSH_AUTH', 'ssh-auth'],
  ['Could not resolve hostname private.example: Name or service not known', 'SSH_DNS', 'ssh-dns'],
  ['ssh: connect to host private.example port 22: Connection timed out', 'SSH_TIMEOUT', 'ssh-timeout'],
  ['ssh: connect to host private.example port 22: Connection refused', 'SSH_REFUSED', 'ssh-refused'],
  ['ssh: connect to host private.example port 22: No route to host', 'SSH_UNREACHABLE', 'ssh-unreachable'],
  ['ssh: connect to host private.example port 22: Network is unreachable', 'SSH_UNREACHABLE', 'ssh-unreachable'],
  ['channel 0: open failed: administratively prohibited: open failed', 'SSH_FORWARD', 'ssh-forward'],
  ['channel 0: open failed: connect failed: Connection refused', 'SSH_FORWARD', 'ssh-forward'],
  ['unrecognized private diagnostic', 'SSH_FAILED', 'ssh'],
]

for (const [diagnostic, code, managedCode] of failures) {
  test(`SSH check and managed lifecycle classify ${code} without exposing native diagnostics`, async () => {
    const stderr = `\u001b[31m${diagnostic}\u001b[0m\nhttp://127.0.0.1:3080/?token=private-secret-value`
    assert.equal(sshProcessError(stderr, { code: 255 }, 'SSH_FAILED').message, SSH_ERROR_MESSAGES[code])
    const f = await fixture({ TEST_SSH_ERROR: stderr, TEST_SSH_EXIT: '255' })
    try {
      await assert.rejects(checkSshTarget({ target: 'devbox' }, f.options), { code, message: SSH_ERROR_MESSAGES[code] })
      await assert.rejects(prepareHost({ target: 'devbox' }, { workspacePlugin: false, ...f.options }), error => {
        assert.ok(error instanceof RemoteHostError)
        assert.equal(error.code, managedCode)
        assert.doesNotMatch(error.message, /private|token=|\u001b/)
        return true
      })
    } finally { await f.dispose() }
  })
}

test('SSH check and managed lifecycle report a missing system SSH client', async () => {
  const sshPath = '/does-not-exist/dsh-ssh-check'
  await assert.rejects(checkSshTarget({ target: 'devbox' }, { sshPath, shutdownGraceMs: 5 }), { code: 'SSH_UNAVAILABLE' })
  await assert.rejects(prepareHost({ target: 'devbox' }, { workspacePlugin: false, sshPath }), { code: 'ssh-unavailable' })
})
