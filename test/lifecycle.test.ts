import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
  const options: RemoteHostOptions = { workspacePlugin: false, executor: async () => { called = true; return JSON.stringify({ error: 'install' }) } }
  for (const target of ['-Fother', 'host; command', 'user@host\n']) await assert.rejects(prepareHost({ target }, options), TypeError)
  for (const version of ['latest', '^0.2.1', '0.3.0', '0.2.1; command']) await assert.rejects(updateHost({ target: 'dev', version }, options), TypeError)
  assert.equal(called, false)
  await assert.rejects(prepareHost({ target: 'dev' }, options), { code: 'install' })
  await assert.rejects(prepareHost({ target: 'dev' }, { workspacePlugin: false, executor: async () => JSON.stringify({ error: token }) }), error => {
    assert.ok(error instanceof RemoteHostError)
    assert.equal(error.code, 'protocol')
    assert.ok(!error.message.includes(token))
    return true
  })
})

test('accepts a validated native result without persisting its credential', async () => {
  const result = { remotePort: 3080, token, version: '0.2.1-rc.2', service: 'systemd', pid: 123 }
  assert.deepEqual(await prepareHost({ target: 'dev' }, { workspacePlugin: false, executor: async () => JSON.stringify(result) }), result)
  await assert.rejects(prepareHost({ target: 'dev' }, { workspacePlugin: false, executor: async () => JSON.stringify({ ...result, pid: 0 }) }), { code: 'protocol' })
  await assert.rejects(prepareHost({ target: 'dev', signal: AbortSignal.abort() }, { workspacePlugin: false, executor: async () => { throw new Error('must not execute') } }), { name: 'AbortError' })
})

async function fixture(extraEnv: NodeJS.ProcessEnv = {}, workspacePlugin?: Buffer, directoryPrefix = 'dsh-lifecycle-test-') {
  const directory = await mkdtemp(join(tmpdir(), directoryPrefix))
  const bin = join(directory, 'bin')
  await mkdir(bin)
  await mkdir(join(directory, 'units'))
  const fixtureCommand = fileURLToPath(new URL('./fixtures/fake-lifecycle-command.mjs', import.meta.url))
  await chmod(fixtureCommand, 0o755)
  for (const command of ['systemctl', 'systemd-run', 'loginctl', 'npm']) await symlink(fixtureCommand, join(bin, command))
  const env = { ...process.env, ...extraEnv, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, DSH_LIFECYCLE_FIXTURE: directory }
  const options: RemoteHostOptions = {
    workspacePlugin: false,
    remoteRoot: join(directory, 'managed'), unit: 'dsh-connections-fixture.service', unitDirectory: join(directory, 'units'),
    executor: async ({ script, signal }) => new Promise((resolve, reject) => {
      // Exercise the real worker transfer/install path without making the source
      // lifecycle module depend on build output at its import-relative location.
      if (workspacePlugin !== undefined) {
        const match = script.match(/\nawait main\(("[^\n]+")\);\n$/)
        if (!match || match.index === undefined) { reject(new Error('Missing fixture management payload')); return }
        const payload = JSON.parse(Buffer.from(JSON.parse(match[1]!) as string, 'base64').toString('utf8')) as Record<string, unknown>
        payload.plugin = { data: workspacePlugin.toString('base64'), digest: createHash('sha256').update(workspacePlugin).digest('hex') }
        script = script.slice(0, match.index) + `\nawait main(${JSON.stringify(Buffer.from(JSON.stringify(payload)).toString('base64'))});\n`
      }
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
    setEnvironment(value: NodeJS.ProcessEnv) { Object.assign(env, value) },
    setWorkspacePlugin(value: Buffer) { workspacePlugin = value },
    state: async () => JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as { pid: number },
    dispose: async () => {
      const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8').catch(() => '{}')) as { pid?: number }
      if (state.pid) { try { process.kill(-state.pid, 'SIGTERM') } catch { /* already stopped */ } }
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function workspaceArchive(): Promise<Buffer> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-workspace-bundle-fixture-'))
  try {
    const packageDir = join(temporary, 'package')
    await mkdir(packageDir)
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@xunz03/dsh-connections', version: '0.1.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(packageDir, 'index.js'), 'export function apply() {}\n')
    await writeFile(join(packageDir, 'cordis.patch.yml'), '- insert:\n    - id: connections\n      name: \'@xunz03/dsh-connections\'\n      config:\n        embedded: true\n')
    // Incompressible data makes the encoded transfer exceed common per-argument
    // OS limits, catching regressions that put the archive back into argv.
    await writeFile(join(packageDir, 'fixture-data'), randomBytes(192 * 1024))
    const path = join(temporary, 'workspace.tgz')
    await promisify(execFile)('tar', ['-czf', path, '-C', temporary, 'package'])
    return await readFile(path)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

test('transfers the private workspace bundle through a request file and installs with the native CLI', { timeout: 40_000 }, async () => {
  const archive = await workspaceArchive()
  const f = await fixture({ UNRELATED_API_KEY: 'must-not-copy' }, archive)
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    const root = f.options.remoteRoot!
    const digest = createHash('sha256').update(archive).digest('hex')
    const receipt = JSON.parse(await readFile(join(root, 'home/connections-workspace-plugin.json'), 'utf8'))
    assert.deepEqual({ ...receipt, contents: undefined }, { schema: 3, digest, activation: 'applied', contents: undefined })
    assert.match(receipt.contents, /^[a-f0-9]{64}$/)
    assert.equal(await readFile(join(f.directory, 'plugin-runtime'), 'utf8'), digest)
    assert.deepEqual(await readFile(join(root, 'plugins', `${digest}.tgz`)), archive)
    assert.equal((await stat(join(root, 'plugins', `${digest}.tgz`))).mode & 0o777, 0o600)
    const installs = (await readFile(join(f.directory, 'plugin-installs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[]; digest: string; home: string; agents: string; path: string; inheritedUnrelatedKey: boolean })
    assert.equal(installs.length, 1)
    assert.deepEqual(installs[0]!.args, ['plugin', '--profile', 'web', 'add', '--save-exact', join(root, 'plugins', `${digest}.tgz`)])
    assert.equal(installs[0]!.digest, digest)
    assert.equal(installs[0]!.home, join(root, 'home'))
    assert.equal(installs[0]!.agents, join(root, 'agents'))
    assert.ok(installs[0]!.path.startsWith(`${join(root, 'installer/node_modules/.bin')}:`))
    assert.equal(installs[0]!.inheritedUnrelatedKey, false)
    const commands = (await readFile(join(f.directory, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; args: string[]; requestFileMode?: number; requestBytes?: number })
    const worker = commands.find(row => row.command === 'systemd-run' && row.args.includes('--worker'))!
    assert.equal(worker.requestFileMode, 0o600)
    assert.ok(worker.requestBytes! > 128 * 1024)
    assert.ok(worker.args.every(arg => arg.length < 4096))
    assert.match(worker.args.at(-1)!, /\/request-[0-9a-f-]{36}\.json$/)
    const installer = commands.find(row => row.command === 'npm' && row.args.at(-1) === 'pnpm@11.13.1')!
    assert.ok(installer.args.includes('--ignore-scripts'))
    assert.ok(installer.args.includes('--save-exact'))
    assert.equal((await readdir(root)).some(name => /^(request|result)-/.test(name)), false)
    assert.deepEqual(await prepareHost({ target: 'dev' }, f.options), first)
    assert.equal((await readFile(join(f.directory, 'plugin-installs.jsonl'), 'utf8')).trim().split('\n').length, 1)
  } finally { await f.dispose() }
})

test('adding and refreshing remote workspace support preserves the existing Host and its state', { timeout: 40_000 }, async () => {
  const f = await fixture()
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    const root = f.options.remoteRoot!
    const state = join(root, 'home/active-task-state')
    await writeFile(state, 'Existing native state must survive', { mode: 0o600 })
    const archive = await workspaceArchive()
    f.setWorkspacePlugin(archive)
    await writeFile(join(f.directory, 'bundle-application'), 'restart-required')
    await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code: 'plugin-restart' })
    await assert.rejects(stat(join(root, 'home/connections-workspace-plugin.json')), { code: 'ENOENT' })
    assert.equal((await f.state()).pid, first.pid)
    assert.equal(await readFile(join(f.directory, 'plugin-runtime'), 'utf8'), '')
    await rm(join(f.directory, 'bundle-application'))
    const attached = await prepareHost({ target: 'dev' }, f.options)
    assert.deepEqual(attached, first)
    const previousReceipt = await readFile(join(root, 'home/connections-workspace-plugin.json'), 'utf8')
    assert.equal(JSON.parse(previousReceipt).activation, 'applied')
    assert.equal(await readFile(join(f.directory, 'plugin-runtime'), 'utf8'), createHash('sha256').update(archive).digest('hex'))
    // Changing the gzip timestamp preserves its contents and changes the digest.
    archive[4] = archive[4]! ^ 1
    await writeFile(join(f.directory, 'plugin-fail'), '')
    await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code: 'install' })
    assert.equal((await f.state()).pid, first.pid)
    assert.equal(await readFile(join(root, 'home/connections-workspace-plugin.json'), 'utf8'), previousReceipt)
    await rm(join(f.directory, 'plugin-fail'))
    assert.deepEqual(await prepareHost({ target: 'dev' }, f.options), first)
    assert.notEqual(await readFile(join(root, 'home/connections-workspace-plugin.json'), 'utf8'), previousReceipt)
    assert.equal(await readFile(join(f.directory, 'plugin-runtime'), 'utf8'), createHash('sha256').update(archive).digest('hex'))
    const activations = (await readFile(join(f.directory, 'plugin-activations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: unknown; application: string; previousDigest: string })
    assert.equal(activations.length, 2)
    assert.ok(activations.every(row => row.application === 'applied'))
    assert.deepEqual(activations.map(row => row.args), [{ id: 'web:connections', enabled: true }, { id: 'web:connections', enabled: true }])
    assert.deepEqual(activations.map(row => row.previousDigest), [JSON.parse(previousReceipt).digest, JSON.parse(previousReceipt).digest])
    const bundles = (await readFile(join(f.directory, 'bundle-activations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: unknown; application: string })
    assert.deepEqual(bundles, [
      { args: { name: '@xunz03/dsh-connections', enabled: true }, application: 'restart-required' },
      { args: { name: '@xunz03/dsh-connections', enabled: true }, application: 'applied' },
    ])
    assert.equal(await readFile(state, 'utf8'), 'Existing native state must survive')
    const commands = (await readFile(join(f.directory, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; args: string[] })
    assert.equal(commands.filter(row => row.command === 'systemctl' && row.args.includes('stop')).length, 0)
    assert.equal(commands.filter(row => row.command === 'npm' && row.args.at(-1) === 'pnpm@11.13.1').length, 1)
  } finally { await f.dispose() }
})

test('migrates install-only receipts and retries failed native activation without restarting the Host', { timeout: 40_000 }, async () => {
  const archive = await workspaceArchive()
  const f = await fixture({}, archive)
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    const digest = createHash('sha256').update(archive).digest('hex')
    const receipt = join(f.options.remoteRoot!, 'home/connections-workspace-plugin.json')
    const legacy = JSON.stringify({ digest })
    await writeFile(receipt, legacy)
    // Model the real failure: CLI files/receipt are new, but the same running
    // native bundle has not been reconciled and is still serving old code.
    await writeFile(join(f.directory, 'plugin-runtime'), 'old-runtime')
    await writeFile(join(f.directory, 'plugin-duplicate'), '')
    await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code: 'plugin-activation' })
    assert.equal(await readFile(receipt, 'utf8'), legacy)
    await assert.rejects(stat(join(f.directory, 'plugin-activations.jsonl')), { code: 'ENOENT' })
    await rm(join(f.directory, 'plugin-duplicate'))
    for (const [application, code] of [['failed', 'plugin-activation'], ['restart-required', 'plugin-restart']] as const) {
      await writeFile(join(f.directory, 'plugin-application'), application)
      await assert.rejects(prepareHost({ target: 'dev' }, f.options), error => {
        assert.ok(error instanceof RemoteHostError)
        assert.equal(error.code, code)
        assert.ok(!error.message.includes(first.token))
        return true
      })
      assert.equal(await readFile(receipt, 'utf8'), legacy)
      assert.equal(await readFile(join(f.directory, 'plugin-runtime'), 'utf8'), 'old-runtime')
      assert.equal((await f.state()).pid, first.pid)
    }
    await rm(join(f.directory, 'plugin-application'))
    assert.deepEqual(await prepareHost({ target: 'dev' }, f.options), first)
    const repaired = JSON.parse(await readFile(receipt, 'utf8'))
    assert.deepEqual({ ...repaired, contents: undefined }, { schema: 3, digest, activation: 'applied', contents: undefined })
    assert.match(repaired.contents, /^[a-f0-9]{64}$/)
    assert.equal(await readFile(join(f.directory, 'plugin-runtime'), 'utf8'), digest)
    assert.deepEqual(await prepareHost({ target: 'dev' }, f.options), first)
    // An old receipt cannot attest to the package's bytes. Failed attempts
    // leave that receipt unchanged, so each retry must verify a fresh install.
    assert.equal((await readFile(join(f.directory, 'plugin-installs.jsonl'), 'utf8')).trim().split('\n').length, 5)
    assert.equal((await readFile(join(f.directory, 'plugin-activations.jsonl'), 'utf8')).trim().split('\n').length, 3)
    const commands = (await readFile(join(f.directory, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; args: string[] })
    assert.equal(commands.filter(row => row.command === 'systemctl' && row.args.includes('stop')).length, 0)
  } finally { await f.dispose() }
})

test('new installations honor XDG_CONFIG_HOME and existing owners retain their recorded unit', { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    const config = join(f.directory, 'custom config')
    const units = join(config, 'systemd/user')
    delete f.options.unitDirectory
    f.setEnvironment({ XDG_CONFIG_HOME: config, DSH_FIXTURE_UNIT_DIRECTORY: units })
    const first = await prepareHost({ target: 'dev' }, f.options)
    assert.equal(JSON.parse(await readFile(join(f.options.remoteRoot!, 'owner.json'), 'utf8')).unitPath, join(units, f.options.unit!))
    f.setEnvironment({ XDG_CONFIG_HOME: join(f.directory, 'changed') })
    assert.deepEqual(await prepareHost({ target: 'dev' }, f.options), first)
    await assert.rejects(stat(join(f.directory, 'changed/systemd/user', f.options.unit!)), { code: 'ENOENT' })
  } finally { await f.dispose() }
})

test('npm runs with the owned Node and only absolute remote PATH entries reach the service', { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    f.setEnvironment({ PATH: `${join(f.directory, 'bin')}:.:relative::${dirname(process.execPath)}:/custom/toolchain/bin:/usr/bin:/bin` })
    await prepareHost({ target: 'dev' }, f.options)
    const lines = (await readFile(join(f.directory, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; node: string; path: string })
    for (const command of lines.filter(row => row.command === 'npm')) {
      assert.equal(command.node, process.execPath)
      assert.ok(command.path.startsWith(dirname(process.execPath) + ':'))
      assert.ok(command.path.split(':').every(path => path.startsWith('/')))
    }
    const environment = await readFile(join(f.options.remoteRoot!, 'environment'), 'utf8')
    const path = JSON.parse(environment.match(/^PATH=(.*)$/m)![1]!) as string
    assert.ok(path.includes('/custom/toolchain/bin'))
    assert.ok(path.split(':').every(part => part.startsWith('/')))
  } finally { await f.dispose() }
})

test('runtime path and ABI drift produce actionable diagnostics without stopping the Host', { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    const release = join(f.options.remoteRoot!, 'releases', first.version, 'release.json')
    const metadata = JSON.parse(await readFile(release, 'utf8'))
    metadata.runtime.modules = 'different-abi'
    await writeFile(release, JSON.stringify(metadata))
    await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code: 'runtime' })
    assert.equal((await f.state()).pid, first.pid)
    metadata.runtime.modules = process.versions.modules
    await writeFile(release, JSON.stringify(metadata))
    const markerPath = join(f.options.remoteRoot!, 'owner.json')
    const marker = JSON.parse(await readFile(markerPath, 'utf8'))
    const unitPath = marker.unitPath as string
    const unit = await readFile(unitPath, 'utf8')
    marker.node = join(f.directory, 'removed-node/bin/node')
    await writeFile(markerPath, JSON.stringify(marker))
    await writeFile(unitPath, unit.replaceAll(process.execPath, marker.node).replaceAll(dirname(process.execPath), dirname(marker.node)))
    await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code: 'runtime' })
    assert.equal((await f.state()).pid, first.pid)
  } finally { await f.dispose() }
})

test('matching receipts repair removed or changed installed package bytes without restarting', { timeout: 30_000 }, async () => {
  const f = await fixture({}, await workspaceArchive())
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    const entry = join(f.options.remoteRoot!, 'home/profiles/web/node_modules/@xunz03/dsh-connections/index.js')
    const original = await readFile(entry, 'utf8')
    await rm(entry)
    assert.deepEqual(await prepareHost({ target: 'dev' }, f.options), first)
    assert.equal(await readFile(entry, 'utf8'), original)
    await writeFile(entry, '// corrupted package')
    assert.deepEqual(await prepareHost({ target: 'dev' }, f.options), first)
    assert.equal(await readFile(entry, 'utf8'), original)
    const installs = (await readFile(join(f.directory, 'plugin-installs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[] })
    assert.equal(installs.length, 3)
    assert.equal(new Set(installs.map(row => row.args.at(-1))).size, 3)
    for (const install of installs.slice(1)) {
      assert.match(install.args.at(-1)!, /-repair-[a-f0-9-]{36}\.tgz$/)
      assert.deepEqual(await readFile(install.args.at(-1)!), await readFile(installs[0]!.args.at(-1)!))
    }
  } finally { await f.dispose() }
})

test('public package rename retains service ownership and refuses duplicate legacy bundles', { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    const legacy = join(f.options.remoteRoot!, 'home/profiles/web/node_modules/@xunz/dsh-connections')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'package.json'), JSON.stringify({ name: '@xunz/dsh-connections' }))
    f.setWorkspacePlugin(await workspaceArchive())
    await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code: 'plugin-migration' })
    assert.equal((await f.state()).pid, first.pid)
    assert.equal(JSON.parse(await readFile(join(legacy, 'package.json'), 'utf8')).name, '@xunz/dsh-connections')
    await assert.rejects(stat(join(f.options.remoteRoot!, 'home/profiles/web/node_modules/@xunz03/dsh-connections')), { code: 'ENOENT' })
    // Simulate the documented native CLI removal, without changing the service homes.
    await rm(legacy, { recursive: true })
    assert.deepEqual(await prepareHost({ target: 'dev' }, f.options), first)
  } finally { await f.dispose() }
})

test('readiness refuses release metadata that disagrees with the installed native manifest', { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    const manifest = join(f.options.remoteRoot!, 'releases', first.version, 'node_modules/@deepseek-ai/dsh/package.json')
    await writeFile(manifest, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.3', type: 'module' }))
    await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code: 'startup' })
    assert.equal((await f.state()).pid, first.pid)
  } finally { await f.dispose() }
})

test('missing native service prerequisites leave no installation behind', async () => {
  for (const [environment, code] of [[{ DSH_FIXTURE_NO_MANAGER: '1' }, 'unavailable'], [{ DSH_FIXTURE_NO_LINGER: '1' }, 'linger']] as const) {
    const f = await fixture(environment)
    try {
      await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code })
      await assert.rejects(stat(f.options.remoteRoot!), { code: 'ENOENT' })
    } finally { await f.dispose() }
  }
})

test('startup activation is verified and reconnect repairs disabled and missing entries', { timeout: 40_000 }, async () => {
  const archive = await workspaceArchive()
  const f = await fixture({}, archive)
  try {
    const root = f.options.remoteRoot!
    const receipt = join(root, 'home/connections-workspace-plugin.json')
    await writeFile(join(f.directory, 'plugin-disabled'), '')
    await writeFile(join(f.directory, 'plugin-ignore-enable'), '')
    await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code: 'plugin-activation' })
    await assert.rejects(stat(receipt), { code: 'ENOENT' }, 'an applied result is insufficient while the entry remains disabled')
    const pid = (await f.state()).pid
    await rm(join(f.directory, 'plugin-ignore-enable'))
    const repaired = await prepareHost({ target: 'dev' }, f.options)
    assert.equal(repaired.pid, pid)
    assert.equal(JSON.parse(await readFile(receipt, 'utf8')).activation, 'applied')
    await writeFile(join(f.directory, 'plugin-disabled'), '')
    assert.deepEqual(await prepareHost({ target: 'dev' }, f.options), repaired)
    await assert.rejects(stat(join(f.directory, 'plugin-disabled')), { code: 'ENOENT' })
    await writeFile(join(f.directory, 'plugin-runtime'), '')
    assert.deepEqual(await prepareHost({ target: 'dev' }, f.options), repaired)
    assert.equal(await readFile(join(f.directory, 'plugin-runtime'), 'utf8'), createHash('sha256').update(archive).digest('hex'))
    const currentReceipt = JSON.parse(await readFile(receipt, 'utf8'))
    await writeFile(receipt, JSON.stringify({ ...currentReceipt, activation: 'startup' }))
    await writeFile(join(f.directory, 'plugin-runtime'), 'legacy-unverified-content')
    assert.deepEqual(await prepareHost({ target: 'dev' }, f.options), repaired)
    assert.equal(await readFile(join(f.directory, 'plugin-runtime'), 'utf8'), currentReceipt.digest)
    assert.equal(JSON.parse(await readFile(receipt, 'utf8')).activation, 'applied')
  } finally { await f.dispose() }
})

test('reconnect needs no npm or linger while explicit installation retains prerequisites', { timeout: 30_000 }, async () => {
  const f = await fixture({}, await workspaceArchive())
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    await writeFile(join(f.directory, 'npm-unavailable'), '')
    f.setEnvironment({ DSH_FIXTURE_NO_LINGER: '1' })
    assert.deepEqual(await prepareHost({ target: 'dev' }, f.options), first)
    await assert.rejects(updateHost({ target: 'dev', version: '0.2.99' }, f.options), { code: 'install-tools' })
    assert.equal((await f.state()).pid, first.pid)
    await rm(join(f.directory, 'npm-unavailable'))
    await assert.rejects(updateHost({ target: 'dev', version: '0.2.99' }, f.options), { code: 'linger' })
    assert.equal((await f.state()).pid, first.pid)
  } finally { await f.dispose() }
})

test('maintenance launcher failures are distinct from lock contention and retain private diagnostics', { timeout: 20_000 }, async () => {
  for (const [exit, code] of [['1', 'maintenance'], ['75', 'busy']] as const) {
    const f = await fixture({ DSH_FIXTURE_MAINTENANCE_FAIL: exit })
    try {
      await assert.rejects(prepareHost({ target: 'dev' }, f.options), (error: unknown) => {
        assert.ok(error instanceof RemoteHostError)
        assert.equal(error.code, code)
        assert.ok(!error.message.includes('Private maintenance failure detail'))
        return true
      })
      const log = join(f.options.remoteRoot!, 'maintenance.log')
      assert.match(await readFile(log, 'utf8'), /Private maintenance failure detail/)
      assert.equal((await stat(log)).mode & 0o777, 0o600)
      assert.equal((await readdir(f.options.remoteRoot!)).some(name => /^(request|result)-/.test(name)), false)
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
    const release = join(f.options.remoteRoot!, 'releases', first.version)
    const receipt = JSON.parse(await readFile(join(release, 'release.json'), 'utf8'))
    assert.match(receipt.integrity, /^sha512-/)
    assert.equal(receipt.lockDigest, createHash('sha256').update(await readFile(join(release, 'package-lock.json'))).digest('hex'))
    const commands = (await readFile(join(f.directory, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; inheritedUnrelatedKey: boolean })
    assert.ok(commands.filter(row => row.command === 'npm').every(row => !row.inheritedUnrelatedKey))
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

test('managed paths containing spaces survive install and reconnect', { timeout: 30_000 }, async () => {
  const f = await fixture({}, undefined, 'dsh lifecycle spaces ')
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    assert.deepEqual(await prepareHost({ target: 'dev' }, f.options), first)
  } finally { await f.dispose() }
})

test('native systemd accepts paths with spaces without ignored directives', { skip: process.env.DSH_CONNECTIONS_TEST_SYSTEMD !== '1', timeout: 30_000 }, async () => {
  const f = await fixture({}, undefined, 'dsh systemd spaces ')
  try {
    await prepareHost({ target: 'dev' }, f.options)
    const result = await promisify(execFile)('systemd-analyze', ['--user', '--man=no', 'verify', join(f.directory, 'units/dsh-connections-fixture.service')])
    assert.equal(result.stderr.trim(), '')
  } finally { await f.dispose() }
})
