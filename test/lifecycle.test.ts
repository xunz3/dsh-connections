import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { prepareHost, updateHost, RemoteHostError, type RemoteHostOptions } from '../src/host/lifecycle.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const token = 'private-launch-credential-1234567890'

test('validates management input before SSH and sanitizes remote failures', async () => {
  let called = false
  const options: RemoteHostOptions = { executor: async () => { called = true; return JSON.stringify({ error: 'install' }) } }
  for (const target of ['-Fother', 'host; command', 'user@host\n']) await assert.rejects(prepareHost({ target }, options), TypeError)
  for (const version of ['latest', '^0.2.1', '0.3.0', '0.2.1; command']) await assert.rejects(updateHost({ target: 'dev', version }, options), TypeError)
  assert.equal(called, false)
  await assert.rejects(prepareHost({ target: 'dev' }, options), { code: 'install' })
  await assert.rejects(prepareHost({ target: 'dev' }, { executor: async () => JSON.stringify({ error: token }) }), error => {
    assert.ok(error instanceof RemoteHostError)
    assert.equal(error.code, 'protocol')
    assert.ok(!error.message.includes(token))
    return true
  })
})

test('accepts a validated native result without persisting its credential', async () => {
  const result = { remotePort: 3080, token, version: '0.2.1-rc.2', service: 'systemd', pid: 123 }
  assert.deepEqual(await prepareHost({ target: 'dev' }, { executor: async () => JSON.stringify(result) }), result)
  await assert.rejects(prepareHost({ target: 'dev' }, { executor: async () => JSON.stringify({ ...result, pid: 0 }) }), { code: 'protocol' })
  await assert.rejects(prepareHost({ target: 'dev', signal: AbortSignal.abort() }, { executor: async () => { throw new Error('must not execute') } }), { name: 'AbortError' })
})

async function fixture(extraEnv: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-lifecycle-test-'))
  const bin = join(directory, 'bin')
  await mkdir(bin)
  await mkdir(join(directory, 'units'))
  const fixtureCommand = fileURLToPath(new URL('./fixtures/fake-lifecycle-command.mjs', import.meta.url))
  await chmod(fixtureCommand, 0o755)
  for (const command of ['systemctl', 'systemd-run', 'loginctl', 'npm']) await symlink(fixtureCommand, join(bin, command))
  const env = { ...process.env, ...extraEnv, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, DSH_LIFECYCLE_FIXTURE: directory }
  const options: RemoteHostOptions = {
    remoteRoot: join(directory, 'managed'), unit: 'dsh-connections-fixture.service', unitDirectory: join(directory, 'units'),
    executor: async ({ script, signal }) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
      let output = ''; let stderr = ''
      const abort = () => child.kill('SIGTERM')
      signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', data => { output += data })
      child.stderr.on('data', data => { stderr += data })
      child.on('error', reject)
      child.on('close', code => {
        signal?.removeEventListener('abort', abort)
        if (signal?.aborted) reject(new DOMException('Cancelled', 'AbortError'))
        else if (code !== 0) reject(new Error(`Fixture management failed: ${stderr}`))
        else resolve(output)
      })
      child.stdin.end(script)
    }),
  }
  return {
    directory, options,
    state: async () => JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as { pid: number },
    dispose: async () => {
      const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8').catch(() => '{}')) as { pid?: number }
      if (state.pid) { try { process.kill(-state.pid, 'SIGTERM') } catch { /* already stopped */ } }
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('missing native service prerequisites leave no installation behind', async () => {
  for (const [environment, code] of [[{ DSH_FIXTURE_NO_MANAGER: '1' }, 'unavailable'], [{ DSH_FIXTURE_NO_LINGER: '1' }, 'linger']] as const) {
    const f = await fixture(environment)
    try {
      await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code })
      await assert.rejects(stat(f.options.remoteRoot!), { code: 'ENOENT' })
    } finally { await f.dispose() }
  }
})

test('installs one owned service and reconnects without restarting or implicitly upgrading', { timeout: 30_000 }, async () => {
  const f = await fixture({ HTTP_PROXY: 'http://test-user:test-password@proxy.invalid:1234', UNRELATED_API_KEY: 'must-not-copy' })
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    const second = await prepareHost({ target: 'dev', version: '0.2.99' }, f.options)
    assert.deepEqual(second, first)
    assert.equal((await stat(f.options.remoteRoot!)).mode & 0o777, 0o700)
    assert.equal((await stat(join(f.options.remoteRoot!, 'service.log'))).mode & 0o777, 0o600)
    assert.equal((await stat(join(f.options.remoteRoot!, 'environment'))).mode & 0o777, 0o600)
    const environment = await readFile(join(f.options.remoteRoot!, 'environment'), 'utf8')
    assert.ok(environment.includes('HTTP_PROXY="http://test-user:test-password@proxy.invalid:1234"'))
    assert.ok(!environment.includes('UNRELATED_API_KEY'))
    assert.equal(await readFile(join(f.directory, 'installing'), 'utf8'), '0.2.1-rc.2')
    const unit = await readFile(join(f.directory, 'units/dsh-connections-fixture.service'), 'utf8')
    assert.match(unit, /KillMode=control-group/)
    assert.match(unit, /Restart=on-failure/)
    assert.match(unit, /--host 127.0.0.1 --port 0 --no-open/)
  } finally { await f.dispose() }
})

test('rejects foreign directories, units and loaded drop-ins', { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    await mkdir(f.options.remoteRoot!, { mode: 0o700 })
    await writeFile(join(f.options.remoteRoot!, 'foreign'), 'preserve')
    await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code: 'ownership' })
    await rm(f.options.remoteRoot!, { recursive: true })
    const unitPath = join(f.directory, 'units/dsh-connections-fixture.service')
    await writeFile(unitPath, 'foreign service')
    await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code: 'ownership' })
    assert.equal(await readFile(unitPath, 'utf8'), 'foreign service')
    await rm(unitPath)
    await prepareHost({ target: 'dev' }, f.options)
    await writeFile(join(f.directory, 'drop-in'), '')
    await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code: 'ownership' })
    await rm(join(f.directory, 'drop-in'))
    await writeFile(join(f.directory, 'wrong-exec'), '')
    await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code: 'ownership' })
  } finally { await f.dispose() }
})

test('failed staging preserves the running process and failed startup restores version and state', { timeout: 40_000 }, async () => {
  const f = await fixture()
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    const statePath = join(f.options.remoteRoot!, 'home/state.txt')
    await writeFile(statePath, 'previous compatible state', { mode: 0o600 })
    await assert.rejects(updateHost({ target: 'dev', version: '0.2.97' }, f.options), { code: 'install' })
    assert.equal((await f.state()).pid, first.pid)
    await assert.rejects(updateHost({ target: 'dev', version: '0.2.98' }, f.options), { code: 'rollback' })
    const restored = await prepareHost({ target: 'dev' }, f.options)
    assert.equal(restored.version, first.version)
    assert.notEqual(restored.pid, first.pid)
    assert.notEqual(restored.token, first.token)
    assert.equal(await readFile(statePath, 'utf8'), 'previous compatible state')
    await assert.rejects(stat(join(f.options.remoteRoot!, 'transaction.json')), { code: 'ENOENT' })
  } finally { await f.dispose() }
})

test('remote maintenance survives its controlling process and reconnect waits behind its lock', { timeout: 40_000 }, async () => {
  const f = await fixture()
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    const controller = new AbortController()
    const pending = updateHost({ target: 'dev', version: '0.2.99', signal: controller.signal }, f.options)
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    let committing = false
    for (let attempt = 0; attempt < 200; attempt++) {
      const transaction = JSON.parse(await readFile(join(f.options.remoteRoot!, 'transaction.json'), 'utf8').catch(() => '{}')) as { phase?: string }
      if (transaction.phase === 'switched') { committing = true; break }
      await sleep(30)
    }
    assert.ok(committing, 'abort while the replacement is starting, after the previous host stopped')
    controller.abort()
    await rejected
    const reconnected = await prepareHost({ target: 'dev' }, f.options)
    assert.equal(reconnected.version, '0.2.99')
    assert.notEqual(reconnected.pid, first.pid)
    assert.notEqual(reconnected.token, first.token)
  } finally { await f.dispose() }
})

test('a reconnect recovers an interrupted snapshot and removes its partial archive', { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    const root = f.options.remoteRoot!
    await writeFile(join(root, 'home/state.txt'), 'preserved state', { mode: 0o600 })
    await writeFile(join(root, 'transaction.json'), JSON.stringify({ previous: first.version, next: '0.2.99', phase: 'stopping' }), { mode: 0o600 })
    await writeFile(join(root, 'rollback.tar'), 'incomplete snapshot', { mode: 0o600 })
    const recovered = await prepareHost({ target: 'dev' }, f.options)
    assert.equal(recovered.version, first.version)
    assert.notEqual(recovered.pid, first.pid)
    assert.equal(await readFile(join(root, 'home/state.txt'), 'utf8'), 'preserved state')
    await assert.rejects(stat(join(root, 'rollback.tar')), { code: 'ENOENT' })
    await assert.rejects(stat(join(root, 'transaction.json')), { code: 'ENOENT' })
  } finally { await f.dispose() }
})

test('native systemd accepts the generated user unit without ignored directives', { skip: process.env.DSH_CONNECTIONS_TEST_SYSTEMD !== '1', timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    await prepareHost({ target: 'dev' }, f.options)
    const result = await promisify(execFile)('systemd-analyze', ['--user', '--man=no', 'verify', join(f.directory, 'units/dsh-connections-fixture.service')])
    assert.equal(result.stderr.trim(), '')
  } finally { await f.dispose() }
})
