import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { prepareHost, updateHost, RemoteHostError, type RemoteHostOptions } from '../src/host/lifecycle.js'
import { LATEST_SUPPORTED_REMOTE_VERSION } from '../src/shared/validation.js'
import { REMOTE_SERVICE_SCRIPT } from '../src/host/remote-service.js'

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

test('default update selects the latest compatible release and refuses to downgrade an unvalidated Host', { timeout: 40_000 }, async () => {
  const f = await fixture()
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    assert.equal(first.version, '0.2.1-rc.2')
    const updated = await updateHost({ target: 'dev' }, f.options)
    assert.equal(updated.version, LATEST_SUPPORTED_REMOTE_VERSION)
    assert.notEqual(updated.pid, first.pid)
    assert.deepEqual(await updateHost({ target: 'dev' }, f.options), updated, 'an up-to-date Host is not restarted')

    // Synthetic isolated releases exercise the protection without installing a
    // new public release or mutating any user-owned remote service.
    const newer = await updateHost({ target: 'dev', version: '0.2.1-rc.4' }, f.options)
    const releases = await readdir(join(f.options.remoteRoot!, 'releases'))
    const before = (await readFile(join(f.directory, 'commands.jsonl'), 'utf8')).trim().split('\n').length
    await assert.rejects(updateHost({ target: 'dev' }, f.options), { code: 'update-version' })
    assert.equal((await f.state()).pid, newer.pid)
    assert.deepEqual(await readdir(join(f.options.remoteRoot!, 'releases')), releases)
    const commands = (await readFile(join(f.directory, 'commands.jsonl'), 'utf8')).trim().split('\n').slice(before)
      .map(line => JSON.parse(line) as { command: string; args: string[] })
    assert.ok(!commands.some(row => row.command === 'npm' && row.args.includes('install')))
    assert.ok(!commands.some(row => row.command === 'systemctl' && row.args.includes('stop')))
    assert.equal((await prepareHost({ target: 'dev' }, f.options)).version, newer.version)
  } finally { await f.dispose() }
})

async function fixture(extraEnv: NodeJS.ProcessEnv = {}, workspacePlugin?: Buffer, directoryPrefix = 'dsh-lifecycle-test-') {
  const directory = await mkdtemp(join(tmpdir(), directoryPrefix))
  const bin = join(directory, 'bin')
  await mkdir(bin)
  await mkdir(join(directory, 'units'))
  const fixtureCommand = fileURLToPath(new URL('./fixtures/fake-lifecycle-command.mjs', import.meta.url))
  const fixtureSource = await readFile(fixtureCommand)
  // Own each executable fixture too: concurrent runs must not chmod the shared
  // source or observe another test generation through a symlink.
  for (const command of ['systemctl', 'systemd-run', 'loginctl', 'npm']) await writeFile(join(bin, command), fixtureSource, { mode: 0o755 })
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

test('native workspace activation requires an active fiber, not only saved enablement', async () => {
  // Exercise only the fixed management program's activation decision. Replacing
  // its I/O functions in this private child never contacts a real Host/profile.
  const source = REMOTE_SERVICE_SCRIPT + `
    ready = async () => ({ remotePort: 1, token: 'isolated-fixture-token' });
    currentRelease = async () => '0.2.1-rc.3';
    authenticate = async () => 'isolated-fixture-cookie';
    const rows = [];
    for (const enabled of [true, false]) {
      let calls = 0;
      pluginManagerRequest = async (_port, _cookie, method) => {
        if (method === 'listPlugins') return [{ moduleName: packageName, entryId: 'web:connections', patchId: 'connections', enabled: enabled || calls > 0, fiberPhase: 'failed' }];
        if (method !== 'setPluginEnabled') throw new Error('Unexpected native mutation');
        calls++;
        return { application: 'applied' };
      };
      let outcome = 'success';
      try { await activateWorkspacePlugin({ root: '/unused-private-fixture' }); }
      catch (error) { outcome = error.code; }
      rows.push({ enabled, outcome });
    }
    process.stdout.write(JSON.stringify(rows));
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source])
  assert.deepEqual(JSON.parse(stdout), [
    { enabled: true, outcome: 'plugin-activation' },
    { enabled: false, outcome: 'plugin-activation' },
  ])
})

test('native activation polls only transient fiber phases and never repeats its enable mutation', async () => {
  const source = REMOTE_SERVICE_SCRIPT + `
    ready = async () => ({ remotePort: 1, token: 'isolated-fixture-token' });
    currentRelease = async () => '0.2.1-rc.3';
    authenticate = async () => 'isolated-fixture-cookie';
    const rows = [];
    for (const phases of [['pending', 'active'], ['loading', 'active'], ['pending', 'loading', 'active'], ['failed'], ['unloading'], [null], [undefined], ['unknown'], ['timeout']]) {
      let mutations = 0, reads = 0, tick = 0;
      const now = Date.now;
      if (phases[0] === 'timeout') Date.now = () => tick += 20000;
      pluginManagerRequest = async (_port, _cookie, method) => {
        if (method === 'listPlugins') {
          const fiberPhase = !mutations ? null : phases[0] === 'timeout' ? 'loading' : phases[Math.min(reads++, phases.length - 1)];
          return [{ moduleName: packageName, entryId: 'web:connections', patchId: 'connections', enabled: mutations > 0, fiberPhase }];
        }
        if (method !== 'setPluginEnabled' || mutations) throw new Error('Repeated or unexpected native mutation');
        mutations++;
        return { application: 'applied' };
      };
      let outcome = 'success';
      try { await activateWorkspacePlugin({ root: '/unused-private-fixture' }); }
      catch (error) { outcome = error.code; }
      finally { Date.now = now; }
      rows.push({ phase: phases[0] ?? null, outcome, mutations });
    }
    process.stdout.write(JSON.stringify(rows));
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source])
  assert.deepEqual(JSON.parse(stdout), [
    ...['pending', 'loading', 'pending'].map(phase => ({ phase, outcome: 'success', mutations: 1 })),
    ...['failed', 'unloading', null, null, 'unknown', 'timeout'].map(phase => ({ phase, outcome: 'plugin-activation', mutations: 1 })),
  ])
})

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

test('service PATH pins Node, exposes owned pnpm and excludes relative remote entries', { timeout: 30_000 }, async () => {
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
    const installerBin = join(f.options.remoteRoot!, 'installer/node_modules/.bin')
    await mkdir(installerBin, { recursive: true })
    await writeFile(join(installerBin, 'pnpm'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({ executable: process.argv[1], node: process.execPath }))\n', { mode: 0o755 })
    const child = await promisify(execFile)('pnpm', ['--version'], { env: { PATH: path } })
    assert.deepEqual(JSON.parse(child.stdout), { executable: join(installerBin, 'pnpm'), node: process.execPath }, 'native plugin subprocesses find the private package manager and its pinned Node')
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
    const releases = await readdir(join(f.options.remoteRoot!, 'releases'))
    const commandsBeforeUpdate = (await readFile(join(f.directory, 'commands.jsonl'), 'utf8')).trim().split('\n').length
    await assert.rejects(updateHost({ target: 'dev', version: '0.2.1-rc.3' }, f.options), { code: 'plugin-migration' })
    assert.equal((await f.state()).pid, first.pid, 'a package rename conflict must not restart the healthy Host')
    assert.deepEqual(await readdir(join(f.options.remoteRoot!, 'releases')), releases, 'reject before staging the requested release')
    await assert.rejects(stat(join(f.options.remoteRoot!, 'transaction.json')), { code: 'ENOENT' })
    const updateCommands = (await readFile(join(f.directory, 'commands.jsonl'), 'utf8')).trim().split('\n').slice(commandsBeforeUpdate)
      .map(line => JSON.parse(line) as { command: string; args: string[] })
    assert.ok(!updateCommands.some(row => row.command === 'npm' && row.args.includes('install')))
    assert.ok(!updateCommands.some(row => row.command === 'systemctl' && row.args.includes('stop')))
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
  for (const [environment, code] of [
    [{ DSH_FIXTURE_NO_MANAGER: '1' }, 'unavailable'], [{ DSH_FIXTURE_NO_LINGER: '1' }, 'linger'],
    [{ DSH_FIXTURE_LOGINCTL_FAIL: '1' }, 'linger-check'], [{ DSH_FIXTURE_LINGER_VALUE: 'unknown' }, 'linger-check'],
  ] as const) {
    const f = await fixture(environment)
    try {
      await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code })
      await assert.rejects(stat(f.options.remoteRoot!), { code: 'ENOENT' })
    } finally { await f.dispose() }
  }
})

test('a drop-in without a unit is rejected before claiming or installing a service', async () => {
  const f = await fixture()
  try {
    const unitPath = join(f.directory, 'units/dsh-connections-fixture.service')
    await mkdir(unitPath + '.d')
    const override = join(unitPath + '.d', 'override.conf')
    await writeFile(override, '[Service]\nExecStart=/foreign\n')
    await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code: 'ownership' })
    await assert.rejects(stat(unitPath), { code: 'ENOENT' })
    await assert.rejects(stat(join(f.options.remoteRoot!, 'owner.json')), { code: 'ENOENT' })
    assert.equal(await readFile(override, 'utf8'), '[Service]\nExecStart=/foreign\n')
    const commands = (await readFile(join(f.directory, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; args: string[] })
    assert.ok(!commands.some(row => row.command === 'systemctl' && row.args.includes('daemon-reload')))
    assert.ok(!commands.some(row => row.command === 'npm' && row.args.includes('install')))
  } finally { await f.dispose() }
})

test('atomic writes remove their private temporary file after write and rename failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-atomic-test-'))
  try {
    const destination = join(directory, 'destination')
    await mkdir(destination)
    const source = REMOTE_SERVICE_SCRIPT + `\nfor (const value of [undefined, 'content']) { try { await atomic(${JSON.stringify(destination)}, value); throw new Error('Expected failure'); } catch (error) { if (error.message === 'Expected failure') throw error; } }\n`
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source])
    assert.deepEqual(await readdir(directory), ['destination'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

for (const kind of ['environment', 'request'] as const) test(`legacy bootstrap can commit a paused ${kind} rename after a new worker sweeps`, { timeout: 30_000 }, async () => {
  const f = await fixture()
  let legacy: ReturnType<typeof spawn> | undefined
  let exited: Promise<number | null> | undefined
  let stderr = ''
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    const root = f.options.remoteRoot!
    const destination = join(root, kind === 'environment' ? 'environment' : `request-${randomUUID()}.json`)
    const value = kind === 'environment' ? 'HTTP_PROXY="http://paused-legacy-credential@proxy.invalid:1234"\n' : 'private-legacy-request'
    // This is the old bootstrap's lock-external atomic helper, with an explicit
    // barrier immediately before rename. No age/mtime heuristic proves safety.
    const source = `
      import * as fs from 'node:fs/promises';
      import { randomUUID } from 'node:crypto';
      const destination = ${JSON.stringify(destination)};
      const temporary = destination + '.tmp-' + randomUUID();
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        try { await handle.writeFile(${JSON.stringify(value)}); } finally { await handle.close(); }
        process.send({ temporary });
        await new Promise(resolve => process.once('message', resolve));
        await fs.rename(temporary, destination);
      } finally { await fs.rm(temporary, { force: true }); }
      process.disconnect();
    `
    // Transfer synthetic proxy values over stdin too, never in the helper argv.
    legacy = spawn(process.execPath, ['--input-type=module', '-'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
    legacy.stderr!.on('data', data => { stderr += data.toString() })
    exited = new Promise(resolve => legacy!.once('close', resolve))
    const paused = new Promise<string>((resolve, reject) => {
      legacy!.once('error', reject)
      legacy!.once('exit', () => reject(new Error(`Legacy bootstrap exited before its rename barrier: ${stderr}`)))
      legacy!.once('message', message => resolve((message as { temporary: string }).temporary))
    })
    legacy.stdin!.end(source)
    const temporary = await paused
    assert.equal(await readFile(temporary, 'utf8'), value)
    assert.deepEqual(await prepareHost({ target: 'dev' }, f.options), first, 'the new worker runs under the real management lock while legacy bootstrap is paused')
    assert.equal(await readFile(temporary, 'utf8'), value, 'the locked worker must preserve a legacy bootstrap temporary even if it looks abandoned')
    legacy.send({ resume: true })
    assert.equal(await exited, 0, `legacy atomic rename must remain valid: ${stderr}`)
    assert.equal(await readFile(destination, 'utf8'), value)
    await assert.rejects(lstat(temporary), { code: 'ENOENT' })
    const commands = await readFile(join(f.directory, 'commands.jsonl'), 'utf8')
    assert.ok(!commands.includes('paused-legacy-credential'))
  } finally {
    if (legacy?.connected) legacy.send({ resume: true }, () => {})
    await exited
    await f.dispose()
  }
})

test('temporary sweeping rejects unexpected types and links without following or recursively deleting them', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-sweep-test-'))
  const outside = join(directory, 'outside')
  await writeFile(outside, 'must remain untouched', { mode: 0o600 })
  try {
    for (const namespace of ['locked', 'legacy']) for (const kind of ['symlink', 'directory', 'public-file', 'hardlink', 'external-current-link']) {
      const root = join(directory, `${namespace}-${kind}`)
      await mkdir(root, { mode: 0o700 })
      const base = kind === 'external-current-link' ? 'current' : namespace === 'locked' ? 'environment' : 'transaction.json'
      const path = join(root, `${base}.tmp-${namespace === 'locked' ? 'locked-' : ''}${randomUUID()}`)
      if (kind === 'directory') {
        await mkdir(path, { mode: 0o700 })
        await writeFile(join(path, 'keep'), 'nested data')
      } else if (kind === 'public-file') {
        await writeFile(path, 'private-lookalike', { mode: 0o600 })
        await chmod(path, 0o644)
      } else if (kind === 'hardlink') await link(outside, path)
      else await symlink(outside, path)
      const source = REMOTE_SERVICE_SCRIPT + `\ntry { await sweepTemporary(${JSON.stringify(root)}); throw new Error('Expected ownership rejection'); } catch (error) { if (error.code !== 'ownership') throw error; }\n`
      await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source])
      assert.ok(await lstat(path), `${kind} must remain, rather than being followed or recursively removed`)
      assert.equal(await readFile(outside, 'utf8'), 'must remain untouched')
      if (kind === 'directory') assert.equal(await readFile(join(path, 'keep'), 'utf8'), 'nested data')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('locked workers sweep only owned exact root temporaries while concurrent bootstraps retain their requests', { timeout: 30_000 }, async () => {
  const f = await fixture({ HTTP_PROXY: 'http://private-proxy-credential@proxy.invalid:1234', UNRELATED_API_KEY: 'must-not-copy' })
  let locker: ReturnType<typeof spawn> | undefined
  let lockClosed: Promise<void> | undefined
  const pending: Promise<Awaited<ReturnType<typeof prepareHost>>>[] = []
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    const root = f.options.remoteRoot!
    const temporaryNames = [
      ...['environment', 'transaction.json', `request-${randomUUID()}.json`, `result-${randomUUID()}.json`].map(name => `${name}.tmp-locked-${randomUUID()}`),
      ...['transaction.json', `result-${randomUUID()}.json`].map(name => `${name}.tmp-${randomUUID()}`),
    ]
    for (const name of temporaryNames) await writeFile(join(root, name), 'crash leftover', { mode: 0o600 })
    for (const name of [`current.tmp-${randomUUID()}`, `current.tmp-locked-${randomUUID()}`]) {
      await symlink(`releases/${first.version}`, join(root, name))
      temporaryNames.push(name)
    }
    const unknown = [
      `notes.tmp-${randomUUID()}`, `notes.tmp-locked-${randomUUID()}`, 'transaction.json.tmp-not-a-uuid',
      'environment.tmp-locked-not-a-uuid', `environment.tmp-${randomUUID()}`, `request-${randomUUID()}.json.tmp-${randomUUID()}`,
    ]
    for (const name of unknown) await writeFile(join(root, name), 'preserve unknown files', { mode: 0o600 })
    const nested = join(root, 'home', `environment.tmp-locked-${randomUUID()}`)
    await writeFile(nested, 'preserve native home', { mode: 0o600 })
    const previousEnvironment = await readFile(join(root, 'environment'), 'utf8')
    f.setEnvironment({ HTTP_PROXY: 'http://new-private-credential@proxy.invalid:2345' })
    locker = spawn('flock', ['--exclusive', '--no-fork', join(root, 'management.lock'), process.execPath, '-e', 'process.stdout.write("locked\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'], { stdio: ['pipe', 'pipe', 'pipe'] })
    lockClosed = new Promise<void>(resolve => locker!.once('close', () => resolve()))
    await new Promise<void>((resolve, reject) => {
      locker!.once('error', reject)
      locker!.once('exit', () => reject(new Error('Fixture lock owner exited before acquisition')))
      locker!.stdout!.once('data', () => resolve())
    })
    for (let i = 0; i < 2; i++) {
      const request = prepareHost({ target: 'dev' }, f.options)
      request.catch(() => {})
      pending.push(request)
    }
    let requests: string[] = []
    for (let attempt = 0; attempt < 300; attempt++) {
      requests = (await readdir(root)).filter(name => /^request-[0-9a-f-]{36}\.json$/.test(name))
      if (requests.length === 2) break
      await sleep(10)
    }
    assert.equal(requests.length, 2, 'both bootstraps transfer distinct complete requests before waiting for management.lock')
    for (const name of requests) {
      assert.equal((await stat(join(root, name))).mode & 0o777, 0o600)
      const request = JSON.parse(Buffer.from(await readFile(join(root, name), 'utf8'), 'base64').toString('utf8'))
      assert.equal(request.network.HTTP_PROXY, 'http://new-private-credential@proxy.invalid:2345')
      assert.equal(request.network.UNRELATED_API_KEY, undefined)
    }
    for (const name of temporaryNames) assert.ok(await lstat(join(root, name)), 'bootstrap cannot sweep before acquiring the worker lock')
    assert.equal(await readFile(join(root, 'environment'), 'utf8'), previousEnvironment, 'queued bootstraps cannot change the active worker environment')
    locker.stdin!.end()
    await lockClosed
    assert.deepEqual(await Promise.all(pending), [first, first])
    for (const name of temporaryNames) await assert.rejects(lstat(join(root, name)), { code: 'ENOENT' })
    for (const name of unknown) assert.equal(await readFile(join(root, name), 'utf8'), 'preserve unknown files')
    assert.equal(await readFile(nested, 'utf8'), 'preserve native home')
    assert.equal((await readdir(root)).some(name => /^(?:request|result)-[0-9a-f-]{36}\.json$/.test(name)), false)
    const commands = await readFile(join(f.directory, 'commands.jsonl'), 'utf8')
    assert.ok(!commands.includes('private-credential'), 'proxy credentials never enter systemd-run argv')
    assert.ok(!commands.includes('--property=EnvironmentFile='), 'workers do not import a stale environment before acquiring their lock')
    const environment = await readFile(join(root, 'environment'), 'utf8')
    assert.ok(environment.includes('new-private-credential'))
    assert.ok(!environment.includes('private-proxy-credential'))
  } finally {
    locker?.stdin?.end()
    await lockClosed
    await Promise.allSettled(pending)
    await f.dispose()
  }
})

test('current network allowlist replaces legacy environment values and honors removed variables', { timeout: 30_000 }, async () => {
  const f = await fixture({ HTTP_PROXY: 'http://legacy-private-credential@proxy.invalid:1234', npm_config_registry: 'https://legacy-registry.invalid', UNRELATED_API_KEY: 'never-copy-this-key' })
  try {
    const first = await prepareHost({ target: 'dev' }, f.options)
    const path = join(f.options.remoteRoot!, 'environment')
    await writeFile(path, await readFile(path, 'utf8') + 'UNRELATED_API_KEY="legacy-secret"\n', { mode: 0o600 })
    f.setEnvironment({ HTTP_PROXY: undefined, npm_config_registry: undefined, HTTPS_PROXY: 'http://current-private-credential@proxy.invalid:2345' })
    assert.deepEqual(await prepareHost({ target: 'dev' }, f.options), first)
    const environment = await readFile(path, 'utf8')
    assert.ok(environment.includes('HTTPS_PROXY="http://current-private-credential@proxy.invalid:2345"'))
    assert.ok(!/^HTTP_PROXY=/m.test(environment))
    assert.ok(!/^npm_config_registry=/m.test(environment))
    assert.ok(!environment.includes('legacy-private-credential'))
    assert.ok(!environment.includes('legacy-secret'))
    assert.ok(!environment.includes('UNRELATED_API_KEY'))
    assert.ok(!environment.includes('never-copy-this-key'))
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    const diagnostics = await readFile(join(f.directory, 'commands.jsonl'), 'utf8') + await readFile(join(f.options.remoteRoot!, 'maintenance.log'), 'utf8')
    assert.ok(!diagnostics.includes('private-credential'))
    assert.ok(!diagnostics.includes('legacy-secret'))
  } finally { await f.dispose() }
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

test('failed native fibers cannot create or renew an activation receipt and preserve the running Host', { timeout: 30_000 }, async () => {
  const f = await fixture({}, await workspaceArchive())
  const phase = join(f.directory, 'plugin-fiber-phase')
  const receipt = join(f.options.remoteRoot!, 'home/connections-workspace-plugin.json')
  try {
    await writeFile(phase, 'failed')
    await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code: 'plugin-activation' })
    await assert.rejects(stat(receipt), { code: 'ENOENT' }, 'enabled plus an applied response does not attest to an active runtime')
    const runningPid = (await f.state()).pid
    await rm(phase)
    const repaired = await prepareHost({ target: 'dev' }, f.options)
    assert.equal(repaired.pid, runningPid)
    const confirmed = await readFile(receipt, 'utf8')
    await writeFile(phase, 'failed')
    await assert.rejects(prepareHost({ target: 'dev' }, f.options), { code: 'plugin-activation' })
    assert.equal(await readFile(receipt, 'utf8'), confirmed, 'a historical receipt cannot override an observed inactive fiber')
    assert.equal((await f.state()).pid, runningPid)
    await rm(phase)
    assert.deepEqual(await prepareHost({ target: 'dev' }, f.options), repaired)
    const commands = (await readFile(join(f.directory, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; args: string[] })
    assert.ok(!commands.some(row => row.command === 'systemctl' && row.args.includes('stop')), 'activation repair cannot restart active work')
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
    await assert.rejects(stat(join(f.options.remoteRoot!, 'transaction.json')), { code: 'ENOENT' })
    await assert.rejects(stat(join(f.options.remoteRoot!, 'rollback.tar')), { code: 'ENOENT' })
    const stagedCommands = (await readFile(join(f.directory, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; args: string[] })
    assert.ok(!stagedCommands.some(row => row.command === 'systemctl' && row.args.includes('stop')), 'failed staging must not enter rollback or stop the serving Host')
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
    // Verification creates a transient private manager socket. Never share the
    // real logged-in user's runtime directory (or another concurrent verifier).
    const runtime = join(f.directory, 'systemd-runtime')
    await mkdir(runtime, { mode: 0o700 })
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: runtime }
    delete env.DBUS_SESSION_BUS_ADDRESS
    const result = await promisify(execFile)('systemd-analyze', ['--user', '--man=no', 'verify', join(f.directory, 'units/dsh-connections-fixture.service')], { env })
    assert.equal(result.stderr.trim(), '')
  } finally { await f.dispose() }
})
