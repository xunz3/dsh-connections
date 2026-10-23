/**
 * Sent over authenticated SSH, then executed by a transient systemd user unit.
 * This is a short-lived maintenance program, not another daemon or RPC server.
 * Keep it self-contained: no packages are required before native Harness installs.
 */
export const REMOTE_SERVICE_SCRIPT = String.raw`
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { request } from 'node:http';

const owner = '@xunz/dsh-connections';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function exists(path) { try { return await fs.lstat(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }
async function privatePath(path, directory = false) {
  const stat = await exists(path);
  if (!stat || stat.isSymbolicLink() || stat.uid !== process.getuid() || (directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077)) fail('ownership');
}
async function privateDir(path) {
  await fs.mkdir(path, { mode: 0o700, recursive: true });
  await privatePath(path, true);
}
async function atomic(path, value) {
  const temporary = path + '.tmp-' + process.pid;
  await fs.writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, path);
}
async function json(path) { await privatePath(path); return JSON.parse(await fs.readFile(path, 'utf8')); }
async function run(command, args, { timeout = 120000, log, allowFailure = false, env = process.env } = {}) {
  const fd = log ? await fs.open(log, 'a', 0o600) : undefined;
  let output = '';
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, { shell: false, env, stdio: ['ignore', fd ? fd.fd : 'pipe', fd ? fd.fd : 'ignore'] });
      child.stdout?.on('data', data => { output = (output + data.toString()).slice(-65536); });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); if (code === 0 || allowFailure) resolve({ code, output }); else reject(new Error('command failed')); });
    });
  } finally { await fd?.close(); }
}
async function systemctl(args, options) { return run('systemctl', ['--user', ...args], options); }
async function properties(unit) {
  const { output } = await systemctl(['show', unit, '--property=LoadState,ActiveState,SubState,MainPID,InvocationID,FragmentPath,ExecStart,DropInPaths,NeedDaemonReload']);
  return Object.fromEntries(output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
}
function quote(value) { return JSON.stringify(value.replaceAll('%', '%%')); }
function networkEnvironment() {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'npm_config_registry', 'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_noproxy', 'npm_config_cafile'];
  return keys.filter(key => process.env[key] !== undefined && !/[\x00\r\n]/.test(process.env[key])).map(key => key + '=' + JSON.stringify(process.env[key])).join('\n') + '\n';
}
function unitText(root, node) {
  return '[Unit]\nDescription=DeepSeek Harness (dsh-connections)\nStartLimitIntervalSec=60\nStartLimitBurst=3\n\n[Service]\nType=exec\nWorkingDirectory=' + join(root, 'workspace') + '\nEnvironment=' + quote('DSH_HOME=' + join(root, 'home')) + '\nEnvironment=' + quote('DSH_AGENTS_HOME=' + join(root, 'agents')) + '\nEnvironment=' + quote('PATH=' + dirname(node) + ':/usr/local/bin:/usr/bin:/bin') + '\nEnvironmentFile=' + join(root, 'environment') + '\nUMask=0077\nExecStart=' + quote(node.replaceAll('$', '$$')) + ' ' + quote(join(root, 'current/node_modules/@deepseek-ai/dsh/lib/bin.js').replaceAll('$', '$$')) + ' --profile web --host 127.0.0.1 --port 0 --no-open\nStandardOutput=truncate:' + join(root, 'service.log') + '\nStandardError=inherit\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=15\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n';
}
async function preflight() {
  if (process.platform !== 'linux') fail('unavailable');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major >= 24 || major === 22 && minor >= 19)) fail('unavailable');
  try {
    await systemctl(['show-environment']);
    for (const command of ['npm', 'flock', 'tar', 'systemd-run']) await run(command, ['--version'], { timeout: 10000 });
  } catch { fail('unavailable'); }
  try { if ((await run('loginctl', ['show-user', String(process.getuid()), '--property=Linger', '--value'])).output.trim() !== 'yes') fail('linger'); }
  catch (error) { if (error.code === 'linger') throw error; fail('linger'); }
}
async function initialize(input) {
  const root = input.root ?? join(homedir(), '.local/share/dsh-connections');
  const unit = input.unit ?? 'dsh-connections.service';
  if (resolve(root) !== root || /[%\x00-\x1f\x7f]/.test(root) || !/^dsh-connections(?:-[a-z0-9-]+)?\.service$/.test(unit)) fail('ownership');
  const unitDirectory = input.unitDirectory ?? join(homedir(), '.config/systemd/user');
  if (resolve(unitDirectory) !== unitDirectory || /[%\x00-\x1f\x7f]/.test(unitDirectory)) fail('ownership');
  const unitPath = join(unitDirectory, unit);
  await privateDir(root);
  const markerPath = join(root, 'owner.json');
  if (!await exists(markerPath)) {
    if ((await fs.readdir(root)).length || await exists(unitPath) || (await properties(unit)).LoadState !== 'not-found') fail('ownership');
    try { await fs.writeFile(markerPath, JSON.stringify({ schema: 1, owner, root, unit, unitPath, node: process.execPath }), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const marker = await json(markerPath);
  if (marker.schema !== 1 || marker.owner !== owner || marker.root !== root || marker.unit !== unit || marker.unitPath !== unitPath || typeof marker.node !== 'string' || !marker.node.startsWith('/') || /[%\x00-\x1f\x7f]/.test(marker.node)) fail('ownership');
  for (const part of ['releases', 'home', 'agents', 'workspace']) await privateDir(join(root, part));
  for (const file of ['service.log', 'install.log', 'management.lock']) {
    const path = join(root, file);
    try { await fs.writeFile(path, '', { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await privatePath(path);
  }
  return { root, unit, unitPath, marker };
}
async function verifyUnit(context) {
  const { root, unit, unitPath, marker } = context;
  const current = await properties(unit);
  if (await exists(unitPath)) {
    await privatePath(unitPath);
    if (await fs.readFile(unitPath, 'utf8') !== unitText(root, marker.node)) fail('ownership');
    if (current.LoadState !== 'not-found') {
      if (current.LoadState !== 'loaded' || current.FragmentPath !== unitPath || current.DropInPaths || current.NeedDaemonReload === 'yes') fail('ownership');
      const expected = marker.node + ' ' + join(root, 'current/node_modules/@deepseek-ai/dsh/lib/bin.js') + ' --profile web --host 127.0.0.1 --port 0 --no-open';
      if (!current.ExecStart?.includes('path=' + marker.node + ' ;') || !current.ExecStart.includes('argv[]=' + expected + ' ;')) fail('ownership');
    }
  } else if (current.LoadState !== 'not-found') fail('ownership');
}
async function currentRelease(root) {
  const path = join(root, 'current');
  const stat = await exists(path);
  if (!stat) return undefined;
  if (!stat.isSymbolicLink() || stat.uid !== process.getuid()) fail('ownership');
  const release = await fs.readlink(path);
  if (!/^releases\/0\.2\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release)) fail('ownership');
  await privatePath(join(root, release), true);
  const metadata = await json(join(root, release, 'release.json'));
  if (metadata.owner !== owner || metadata.version !== release.slice('releases/'.length)) fail('ownership');
  return metadata.version;
}
async function select(root, version) {
  const path = join(root, 'current.tmp-' + process.pid);
  await fs.symlink('releases/' + version, path);
  await fs.rename(path, join(root, 'current'));
}
async function stage(context, version) {
  const { root, marker } = context;
  const release = join(root, 'releases', version);
  if (await exists(release)) {
    await privatePath(release, true);
    const metadata = await json(join(release, 'release.json'));
    if (metadata.owner !== owner || metadata.version !== version) fail('ownership');
    return;
  }
  const staging = join(root, 'releases', '.stage-' + process.pid);
  await privateDir(staging);
  try {
    await fs.writeFile(join(root, 'install.log'), '', { mode: 0o600 });
    await run('npm', ['install', '--prefix', staging, '--save-exact', '--omit=dev', '--no-audit', '--no-fund', '--', '@deepseek-ai/dsh@' + version], { timeout: 600000, log: join(root, 'install.log') });
    const manifest = JSON.parse(await fs.readFile(join(staging, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
    if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== version) fail('install');
    const actual = await run(marker.node, [join(staging, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--version']);
    if (actual.output.trim() !== version) fail('install');
    await atomic(join(staging, 'release.json'), JSON.stringify({ owner, version }));
    await fs.rename(staging, release);
  } catch (error) { await fs.rm(staging, { recursive: true, force: true }); if (error.code === 'ownership') throw error; fail('install'); }
}
async function authenticate(port, token) {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, path: '/?token=' + encodeURIComponent(token), method: 'GET', timeout: 3000 }, response => {
      response.resume();
      const expected = 'dsh-auth-' + createHash('sha256').update('127.0.0.1:' + port).digest('base64url') + '=';
      resolve(response.statusCode === 303 && response.headers.location === './' && (response.headers['set-cookie'] ?? []).some(cookie => cookie.startsWith(expected) && /;\s*HttpOnly/i.test(cookie) && /;\s*SameSite=Strict/i.test(cookie)));
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false)); req.end();
  });
}
async function ready(context, version) {
  const { root, unit } = context;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const before = await properties(unit);
    if (before.ActiveState === 'failed') fail('startup');
    if (before.ActiveState === 'active' && Number(before.MainPID) > 0) {
      await privatePath(join(root, 'service.log'));
      const handle = await fs.open(join(root, 'service.log'), 'r');
      let text;
      try { const buffer = Buffer.alloc(262144); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); text = buffer.subarray(0, bytesRead).toString('utf8'); }
      finally { await handle.close(); }
      const match = text.match(/^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{20,512})\s*$/m);
      if (match) {
        const url = new URL(match[1]); const port = Number(url.port); const token = url.searchParams.get('token');
        if (port > 0 && port <= 65535 && await authenticate(port, token)) {
          const after = await properties(unit);
          if (after.ActiveState === 'active' && after.MainPID === before.MainPID && after.InvocationID === before.InvocationID) return { remotePort: port, token, version, service: 'systemd', pid: Number(after.MainPID) };
        }
      }
    }
    await sleep(300);
  }
  fail('startup');
}
async function start(context) {
  await systemctl(['reset-failed', context.unit], { allowFailure: true });
  await systemctl(['enable', '--now', context.unit]);
}
async function installUnit(context) {
  const { root, unitPath, marker } = context;
  await verifyUnit(context);
  if (!await exists(unitPath)) {
    await fs.mkdir(dirname(unitPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(unitPath, unitText(root, marker.node), { mode: 0o600, flag: 'wx' });
  }
  await systemctl(['daemon-reload']);
  await verifyUnit(context);
}
async function recover(context) {
  const { root, unit } = context;
  const path = join(root, 'transaction.json');
  if (!await exists(path)) return;
  const transaction = await json(path);
  if (!/^0\.2\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(transaction.previous) || !['stopping', 'snapshot', 'switched'].includes(transaction.phase)) fail('recovery');
  try {
    await systemctl(['stop', unit]);
    if (transaction.phase !== 'stopping') {
      const backup = join(root, 'rollback.tar');
      await privatePath(backup);
      // The archive was made by this installation after its sole writer stopped.
      for (const part of ['home', 'agents']) await fs.rm(join(root, part), { recursive: true, force: true });
      await run('tar', ['--extract', '--file', backup, '--directory', root, '--same-permissions'], { timeout: 600000 });
    } else await fs.rm(join(root, 'rollback.tar'), { force: true });
    await select(root, transaction.previous);
    await start(context);
    await ready(context, transaction.previous);
    await fs.rm(path);
    await fs.rm(join(root, 'rollback.tar'), { force: true }).catch(() => {});
  } catch { fail('recovery'); }
}
async function worker(input) {
  const context = await initialize(input);
  const { root, unit } = context;
  await verifyUnit(context);
  await recover(context);
  // Only the lock owner reaches here; interrupted staging directories cannot
  // belong to another live maintenance operation or the selected installation.
  for (const name of await fs.readdir(join(root, 'releases'))) {
    if (/^\.stage-\d+$/.test(name)) {
      await privatePath(join(root, 'releases', name), true);
      await fs.rm(join(root, 'releases', name), { recursive: true, force: true });
    }
  }
  const previous = await currentRelease(root);
  if (previous === undefined) {
    await stage(context, input.version);
    await select(root, input.version);
    await installUnit(context);
    await start(context);
    return ready(context, input.version);
  }
  await installUnit(context);
  if (input.action === 'prepare' || input.version === previous) { await start(context); return ready(context, previous); }
  // Installation and validation occur while the previous Harness is still serving.
  await stage(context, input.version);
  const transaction = { previous, next: input.version, phase: 'stopping' };
  const transactionPath = join(root, 'transaction.json');
  await atomic(transactionPath, JSON.stringify(transaction));
  try {
    await systemctl(['stop', unit]);
    await run('tar', ['--create', '--file', join(root, 'rollback.tar'), '--directory', root, 'home', 'agents'], { timeout: 600000 });
    await fs.chmod(join(root, 'rollback.tar'), 0o600);
    transaction.phase = 'snapshot'; await atomic(transactionPath, JSON.stringify(transaction));
    await select(root, input.version);
    transaction.phase = 'switched'; await atomic(transactionPath, JSON.stringify(transaction));
    await start(context);
    const result = await ready(context, input.version);
    await fs.rm(transactionPath);
    await fs.rm(join(root, 'rollback.tar'), { force: true }).catch(() => {});
    return result;
  } catch {
    await recover(context);
    fail('rollback');
  }
}
async function bootstrap(input, encoded) {
  await preflight();
  const context = await initialize(input);
  await verifyUnit(context);
  // Preserve the remote SSH user's network configuration without exposing proxy
  // credentials in argv, logs, or client records. API keys are never copied.
  await atomic(join(context.root, 'environment'), networkEnvironment());
  // Abandoned callers may leave private result credentials behind. Maintenance
  // can run for at most 30 minutes; only files older than a day are collected.
  for (const name of await fs.readdir(context.root)) {
    if (!/^result-[0-9a-f-]{36}\.json$/.test(name)) continue;
    const path = join(context.root, name);
    const stat = await exists(path);
    if (stat?.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && Date.now() - stat.mtimeMs > 86400000) await fs.rm(path);
  }
  // The caller sends the worker source as data; stdin is already consumed by node.
  const script = Buffer.from(input.source, 'base64').toString('utf8');
  const digest = createHash('sha256').update(script).digest('hex').slice(0, 20);
  const workerPath = join(context.root, 'manager-' + digest + '.mjs');
  try { await fs.writeFile(workerPath, script, { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await privatePath(workerPath);
  if (await fs.readFile(workerPath, 'utf8') !== script) fail('ownership');
  const resultPath = join(context.root, 'result-' + input.operation + '.json');
  const maintenance = 'dsh-connections-maintenance-' + input.operation;
  const args = ['--user', '--quiet', '--wait', '--pipe', '--collect', '--unit=' + maintenance, '--property=Type=exec', '--property=UMask=0077', '--property=EnvironmentFile=' + join(context.root, 'environment'), '--setenv=PATH=' + process.env.PATH, 'flock', '--wait', '1200', join(context.root, 'management.lock'), context.marker.node, workerPath, '--worker', encoded];
  await run('systemd-run', args, { timeout: 1800000, allowFailure: true });
  if (!await exists(resultPath)) fail('busy');
  const result = await json(resultPath);
  await fs.rm(resultPath);
  return result;
}
async function main(encoded) {
  process.umask(0o077);
  let input;
  let result;
  try {
    input = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (!['prepare', 'update'].includes(input.action) || !/^0\.2\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version) || !/^[0-9a-f-]{36}$/.test(input.operation)) fail('ownership');
    result = process.argv[2] === '--worker' ? await worker(input) : await bootstrap(input, encoded);
  } catch (error) {
    result = { error: ['unavailable', 'linger', 'ownership', 'install', 'startup', 'rollback', 'recovery', 'busy'].includes(error.code) ? error.code : 'startup' };
  }
  if (process.argv[2] === '--worker') {
    const root = input.root ?? join(homedir(), '.local/share/dsh-connections');
    await atomic(join(root, 'result-' + input.operation + '.json'), JSON.stringify(result));
  } else process.stdout.write(JSON.stringify(result));
}
if (process.argv[2] === '--worker') await main(process.argv[3]);
`
