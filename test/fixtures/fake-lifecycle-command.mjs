#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, open, access, appendFile, stat } from 'node:fs/promises'
import { basename, join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const directory = process.env.DSH_LIFECYCLE_FIXTURE ?? dirname(dirname(process.argv[1]))
const root = join(directory, 'managed')
const command = basename(process.argv[1])
const args = process.argv.slice(2)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const exists = async path => { try { await access(path); return true } catch { return false } }
const statePath = join(directory, 'state.json')
const readState = async () => JSON.parse(await readFile(statePath, 'utf8').catch(() => '{}'))
const live = async pid => {
  if (!pid) return false
  try { process.kill(pid, 0); return !/^\d+ \(.+\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8')) } catch { return false }
}
const requestFile = command === 'systemd-run' && args.includes('--worker') ? await stat(args.at(-1)) : undefined
await appendFile(join(directory, 'commands.jsonl'), JSON.stringify({ command, action: args[0], subcommand: args[1], args,
  node: process.execPath, path: process.env.PATH,
  inheritedUnrelatedKey: process.env.UNRELATED_API_KEY !== undefined,
  ...(requestFile ? { requestFileMode: requestFile.mode & 0o777, requestBytes: requestFile.size } : {}),
}) + '\n')

if (command === 'npm' && await exists(join(directory, 'npm-unavailable'))) process.exit(1)
if (args.includes('--version')) { console.log('test command 1'); process.exit(0) }
if (command === 'loginctl') {
  if (process.env.DSH_FIXTURE_LOGINCTL_FAIL) { console.error('Private logind failure detail'); process.exit(1) }
  console.log(process.env.DSH_FIXTURE_LINGER_VALUE ?? (process.env.DSH_FIXTURE_NO_LINGER ? 'no' : 'yes'))
  process.exit(0)
}

if (command === 'npm') {
  const prefix = args[args.indexOf('--prefix') + 1]
  if (args.at(-1) === 'pnpm@11.13.1') {
    const module = join(prefix, 'node_modules/pnpm/bin')
    await mkdir(module, { recursive: true })
    await writeFile(join(module, 'pnpm.cjs'), '// Private fixture package manager\n')
    process.exit(0)
  }
  const version = args.at(-1).slice('@deepseek-ai/dsh@'.length)
  await writeFile(join(directory, 'installing'), version)
  if (version === '0.2.97') process.exit(1)
  if (version === '0.2.99') await sleep(1200)
  const module = join(prefix, 'node_modules/@deepseek-ai/dsh')
  await mkdir(join(module, 'lib'), { recursive: true })
  await writeFile(join(module, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, type: 'module' }))
  await writeFile(join(prefix, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
    'node_modules/@deepseek-ai/dsh': { version, integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64') },
  } }))
  const source = `
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { appendFile, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
const version = ${JSON.stringify(version)};
if (process.argv.includes('--version')) { console.log(version); process.exit(0); }
const fixtureDirectory = dirname(dirname(process.env.DSH_HOME));
if (process.argv[2] === 'plugin') {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[1] !== '--profile' || args[2] !== 'web' || args[3] !== 'add' || args[4] !== '--save-exact') process.exit(2);
  const digest = createHash('sha256').update(await readFile(args.at(-1))).digest('hex');
  await appendFile(fixtureDirectory + '/plugin-installs.jsonl', JSON.stringify({ args, digest, home: process.env.DSH_HOME, agents: process.env.DSH_AGENTS_HOME, path: process.env.PATH, inheritedUnrelatedKey: process.env.UNRELATED_API_KEY !== undefined }) + '\\n');
  try { await readFile(fixtureDirectory + '/plugin-fail'); process.exit(1); } catch {}
  await writeFile(process.env.DSH_HOME + '/workspace-plugin-installed', digest);
  const installed = process.env.DSH_HOME + '/profiles/web/node_modules/@xunz03/dsh-connections';
  await mkdir(installed, { recursive: true });
  execFileSync('tar', ['-xzf', args.at(-1), '--strip-components=1', '-C', installed]);
  process.exit(0);
}
if (version === '0.2.98') { await writeFile(process.env.DSH_HOME + '/state.txt', 'new incompatible state'); process.exit(1); }
if (version === '0.2.99') await new Promise(resolve => setTimeout(resolve, 1000));
const token = randomBytes(32).toString('base64url');
const installedPath = process.env.DSH_HOME + '/workspace-plugin-installed';
const runtimePath = process.env.DSH_LIFECYCLE_FIXTURE + '/plugin-runtime';
await writeFile(runtimePath, await readFile(installedPath, 'utf8').catch(() => ''));
const server = createServer(async (req, res) => {
  const authority = req.headers.host;
  const cookie = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url') + '=v1.fixture';
  if (req.url === '/?token=' + token) { res.writeHead(303, { location: './', 'set-cookie': cookie + '; HttpOnly; SameSite=Strict; Path=/' }).end(); return; }
  if (req.headers.cookie !== cookie || req.method !== 'POST') { res.writeHead(401).end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (input.type !== 'client-request' || req.url !== '/api/' + input.method) { res.writeHead(400).end(); return; }
  const respond = value => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: { ok: true, value } }));
  if (input.method === 'pluginManager/listPlugins') {
    const loaded = await readFile(runtimePath, 'utf8');
    const disabled = await readFile(process.env.DSH_LIFECYCLE_FIXTURE + '/plugin-disabled', 'utf8').then(() => true, () => false);
    const duplicate = await readFile(process.env.DSH_LIFECYCLE_FIXTURE + '/plugin-duplicate', 'utf8').then(() => true, () => false);
    const fiberPhase = await readFile(process.env.DSH_LIFECYCLE_FIXTURE + '/plugin-fiber-phase', 'utf8').catch(() => disabled ? null : 'active');
    respond([
      ...(loaded ? [{ entryId: 'web:connections', moduleName: '@xunz03/dsh-connections', patchId: 'connections', enabled: !disabled, fiberPhase }] : []),
      ...(duplicate ? [{ entryId: 'web:duplicate', moduleName: '@xunz03/dsh-connections', patchId: 'duplicate', enabled: true, fiberPhase: 'active' }] : []),
      { entryId: 'web:ui-layout', moduleName: '@deepseek/ui-layout', patchId: 'ui-layout', enabled: false, fiberPhase: null },
    ]); return;
  }
  if (input.method === 'pluginManager/setBundleEnabled') {
    const args = input.payload?.args;
    if (args?.name !== '@xunz03/dsh-connections' || args.enabled !== true || Object.keys(args).length !== 2) { res.writeHead(400).end(); return; }
    const application = await readFile(process.env.DSH_LIFECYCLE_FIXTURE + '/bundle-application', 'utf8').catch(() => 'applied');
    await appendFile(process.env.DSH_LIFECYCLE_FIXTURE + '/bundle-activations.jsonl', JSON.stringify({ args, application }) + '\\n');
    if (application === 'applied') await writeFile(runtimePath, await readFile(installedPath, 'utf8'));
    respond({ application, changed: false, warnings: [], message: 'Private native error ' + token }); return;
  }
  if (input.method === 'pluginManager/setPluginEnabled') {
    const args = input.payload?.args;
    if (args?.id !== 'web:connections' || args.enabled !== true || Object.keys(args).length !== 2) { res.writeHead(400).end(); return; }
    const application = await readFile(process.env.DSH_LIFECYCLE_FIXTURE + '/plugin-application', 'utf8').catch(() => 'applied');
    await appendFile(process.env.DSH_LIFECYCLE_FIXTURE + '/plugin-activations.jsonl', JSON.stringify({ args, application, previousDigest: await readFile(runtimePath, 'utf8') }) + '\\n');
    if (application === 'applied') {
      await writeFile(runtimePath, await readFile(installedPath, 'utf8'));
      const ignored = await readFile(fixtureDirectory + '/plugin-ignore-enable').then(() => true, () => false);
      if (!ignored) await rm(fixtureDirectory + '/plugin-disabled', { force: true });
    }
    respond({ application, changed: false, warnings: [], message: 'Private native error ' + token }); return;
  }
  res.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=' + token));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`
  await writeFile(join(module, 'lib/bin.js'), source)
  process.exit(0)
}

if (command === 'systemd-run') {
  if (process.env.DSH_FIXTURE_MAINTENANCE_FAIL) { console.error('Private maintenance failure detail'); process.exit(Number(process.env.DSH_FIXTURE_MAINTENANCE_FAIL)) }
  const at = args.indexOf('flock')
  const child = spawn('/usr/bin/flock', args.slice(at + 1), { detached: true, stdio: 'ignore', env: process.env })
  child.on('error', () => process.exit(1))
  child.on('close', code => process.exit(code ?? 1))
} else if (command === 'systemctl') {
  const action = args[1]
  if (action === 'show-environment') {
    if (process.env.DSH_FIXTURE_NO_MANAGER) process.exit(1)
    console.log('PATH=/fixture')
  } else if (action === 'show') {
    const unitPath = join(process.env.DSH_FIXTURE_UNIT_DIRECTORY ?? join(directory, 'units'), args[2])
    const loaded = await exists(unitPath)
    const content = loaded ? await readFile(unitPath, 'utf8') : ''
    const exec = content.match(/^ExecStart=("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*") (.*)$/m)
    const node = exec ? JSON.parse(exec[1]) : '/foreign'
    const entry = exec ? JSON.parse(exec[2]) : '/foreign'
    const state = await readState()
    const active = await live(state.pid)
    const fields = {
      LoadState: loaded ? 'loaded' : 'not-found', ActiveState: active ? 'active' : state.pid ? 'failed' : 'inactive',
      SubState: active ? 'running' : 'dead', MainPID: active ? state.pid : 0,
      InvocationID: state.invocation ?? '', FragmentPath: loaded ? unitPath : '',
      ExecStart: await exists(join(directory, 'wrong-exec')) ? '{ path=/foreign ; argv[]=/foreign ; }' : `{ path=${node} ; argv[]=${node} ${entry} ${exec?.[3] ?? ''} ; ignore_errors=no ; }`,
      DropInPaths: await exists(join(directory, 'drop-in')) ? '/foreign/override.conf' : '',
      NeedDaemonReload: 'no',
    }
    for (const [key, value] of Object.entries(fields)) console.log(key + '=' + value)
  } else if (action === 'enable') {
    const state = await readState()
    if (!await live(state.pid)) {
      const log = await open(join(root, 'service.log'), 'w', 0o600)
      const child = spawn(process.execPath, [join(root, 'current/node_modules/@deepseek-ai/dsh/lib/bin.js')], {
        detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, DSH_HOME: join(root, 'home') },
      })
      await writeFile(statePath, JSON.stringify({ pid: child.pid, invocation: randomUUID() }))
      child.unref()
      await log.close()
    }
  } else if (action === 'stop') {
    const state = await readState()
    if (await live(state.pid)) {
      process.kill(-state.pid, 'SIGTERM')
      for (let i = 0; i < 100 && await live(state.pid); i++) await sleep(10)
    }
    await writeFile(statePath, '{}')
  } else if (!['daemon-reload', 'reset-failed'].includes(action)) {
    throw new Error('Unexpected fixture action: ' + action)
  }
} else throw new Error('Unexpected fixture command: ' + command)
