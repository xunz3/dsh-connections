import { WORKSPACE_PROTOCOL } from '../../src/shared/workspace-protocol.ts'
/** Same-version CLI bundle updates reconcile through native PluginManager, without restarting the owned Host. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const directory = resolve(process.argv[2] ?? '')
if (!directory.startsWith(`${resolve(tmpdir())}/`)) throw new Error('Use an owned native fixture under the temporary directory.')
const metadata = JSON.parse(await readFile(join(directory, 'processes.json'), 'utf8'))
if (!metadata.remote?.pid || !metadata.remotePort) throw new Error('The fixture must own a remote Harness Host.')
const identity = async () => (await readFile(`/proc/${metadata.remote.pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19]
assert.equal(await identity(), metadata.remote.start, 'The fixture remote process identity must still match.')
const launch = (await readFile(join(directory, 'remote.log'), 'utf8')).match(/dsh web: (http[^\s]+)/)?.[1]
if (!launch) throw new Error('The fixture has no private remote launch address.')
const origin = new URL(launch).origin
assert.equal(origin, `http://127.0.0.1:${metadata.remotePort}`)
const response = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
assert.equal(response.status, 303, 'Native owner authentication must succeed.')
const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
assert.ok(cookie)
const packageName = '@xunz03/dsh-connections-native-reload-probe'
const routePath = '/api/connections/native-reload-probe'
const work = join(directory, 'native-reload-probe')
await mkdir(work, { recursive: true, mode: 0o700 })

async function post(path, body) {
  const result = await fetch(new URL(path, origin), {
    method: 'POST', redirect: 'error', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  })
  assert.equal(result.status, 200, `Native endpoint ${path} must respond successfully.`)
  return result.json()
}
async function rpc(method, args) {
  const result = await post(`/api/pluginManager/${method}`, {
    type: 'client-request', rpcId: crypto.randomUUID(), method: `pluginManager/${method}`, payload: { args },
  })
  assert.equal(result.result?.ok, true, `Native PluginManager ${method} must succeed.`)
  return result.result.value
}
async function cli(args, logName) {
  const env = {
    ...process.env, DSH_HOME: join(directory, 'remote-home'), DSH_AGENTS_HOME: join(directory, 'remote-agents'),
    PATH: `${join(directory, 'bin')}:${dirname(metadata.node)}:${process.env.PATH}`,
  }
  try {
    const result = await execute(metadata.node, [metadata.cli, 'plugin', '--profile', 'web', ...args], { cwd: directory, env, timeout: 120000 })
    await writeFile(join(work, logName), result.stdout + result.stderr, { mode: 0o600 })
  } catch (error) {
    await writeFile(join(work, logName), String(error.stdout ?? '') + String(error.stderr ?? ''), { mode: 0o600 })
    throw new Error(`The isolated CLI operation failed; inspect ${logName} privately.`)
  }
}
async function archive(marker) {
  const folder = join(work, marker, 'package')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  await writeFile(join(folder, 'package.json'), JSON.stringify({
    name: packageName, version: '0.0.1', type: 'module', exports: './index.mjs',
    engines: { dsh: '>=0.2.1-rc.2 <0.3.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(folder, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'connections-native-reload-probe', name: packageName }] }]))
  await writeFile(join(folder, 'index.mjs'), `export const inject = ['connection'];
export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({ path: ${JSON.stringify(routePath)}, methods: ['POST'], requestBody: 'buffered',
    fetch: async () => Response.json({ marker: ${JSON.stringify(marker)}, pid: process.pid }) }));
}
`)
  const file = join(work, `${marker}.tgz`)
  await execute('tar', ['-czf', file, '-C', dirname(folder), 'package'])
  return file
}
async function entry() {
  const rows = await rpc('listPlugins', {})
  const row = rows.find(row => row.moduleName === packageName)
  assert.ok(row, 'The test bundle must appear in the native plugin catalog.')
  return row.entryId
}
async function reconcile(id, enabled = true) {
  const result = await rpc('setPluginEnabled', { id, enabled })
  assert.equal(result.application, 'applied', 'Native profile reconciliation must apply without a restart.')
  return result
}
let installed = false
try {
  const baseline = await post('/api/connections/workspaces', { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
  assert.equal(baseline.ok, true, 'The existing Connections bundle must be running.')
  await cli(['add', '--save-exact', await archive('first')], 'install-first.log')
  installed = true
  // A brand-new bundle is not necessarily visible in the live loader yet.
  // Establish its baseline through the public bundle lifecycle first.
  assert.equal((await rpc('setBundleEnabled', { name: packageName, enabled: true })).application, 'applied')
  const id = await entry()
  await reconcile(id)
  assert.deepEqual(await post(routePath, {}), { marker: 'first', pid: metadata.remote.pid })
  await cli(['add', '--save-exact', await archive('second')], 'install-second.log')
  assert.deepEqual(await post(routePath, {}), { marker: 'first', pid: metadata.remote.pid }, 'CLI package replacement alone must reproduce the stale active runtime.')
  const applied = await reconcile(await entry())
  assert.deepEqual(await post(routePath, {}), { marker: 'second', pid: metadata.remote.pid })
  assert.equal(await identity(), metadata.remote.start, 'The native Host must not restart during reconciliation.')
  assert.equal((await post('/api/connections/workspaces', { op: 'catalog', protocol: WORKSPACE_PROTOCOL })).ok, true, 'The existing Connections bundle must remain available.')
  console.log(JSON.stringify({ cliLeftOldRuntime: true, nativeReconcileApplied: true, sameVersion: '0.0.1', hostPidUnchanged: true, application: applied.application }))
} finally {
  if (installed) {
    await rpc('setBundleEnabled', { name: packageName, enabled: false })
    await cli(['remove', packageName], 'remove.log')
  }
}
