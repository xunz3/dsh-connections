/**
 * Sent over authenticated SSH, then executed by a transient systemd user unit.
 * This is a short-lived maintenance program, not another daemon or RPC server.
 * Keep it self-contained: no packages are required before native Harness installs.
 */
export const REMOTE_SERVICE_SCRIPT = String.raw`
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, dirname, resolve } from 'node:path';
import { request } from 'node:http';

// Installation identity predates the public npm scope; retain ownership of existing homes.
const owner = '@xunz/dsh-connections';
const packageName = '@xunz03/dsh-connections';
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
  // Every production caller owns management.lock. Distinguish this protocol
  // from older bootstraps that used lock-external .tmp-UUID writes.
  const temporary = path + '.tmp-locked-' + randomUUID();
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(value); } finally { await handle.close(); }
    await fs.rename(temporary, path);
  } finally { await fs.rm(temporary, { force: true }); }
}
async function sweepTemporary(root) {
  // Only the management.lock owner calls this. Collect the exact root names
  // in the locked namespace, plus legacy names written only by locked workers.
  // Legacy bootstrap environment/request .tmp-UUID writes were lock-external:
  // even an old mtime cannot prove that their writer will not resume a rename.
  await privatePath(root, true);
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const lockedFiles = new RegExp('^(?:environment|transaction\\.json|(?:request|result)-' + uuid + '\\.json)\\.tmp-locked-' + uuid + '$');
  const legacyFiles = new RegExp('^(?:transaction\\.json|result-' + uuid + '\\.json)\\.tmp-' + uuid + '$');
  const links = new RegExp('^current\\.tmp-(?:locked-)?' + uuid + '$');
  for (const name of await fs.readdir(root)) {
    const file = lockedFiles.test(name) || legacyFiles.test(name);
    if (!file && !links.test(name)) continue;
    const path = join(root, name);
    const stat = await exists(path);
    if (!stat) continue;
    if (stat.uid !== process.getuid()) fail('ownership');
    if (file) {
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.nlink !== 1) fail('ownership');
    } else if (!stat.isSymbolicLink() || !/^releases\/0\.2\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(await fs.readlink(path))) fail('ownership');
    // unlink cannot recurse into directories or follow a symlink's target.
    await fs.unlink(path);
  }
}
async function json(path) { await privatePath(path); return JSON.parse(await fs.readFile(path, 'utf8')); }
async function run(command, args, { timeout = 120000, log, allowFailure = false, env = process.env } = {}) {
  const fd = log ? await fs.open(log, 'a', 0o600) : undefined;
  let output = '';
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, { shell: false, env, stdio: ['ignore', fd ? fd.fd : 'pipe', fd ? fd.fd : 'ignore'] });
      child.stdout?.on('data', data => { output = (output + data.toString()).slice(-65536); });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); if (code === 0 || allowFailure) resolve({ code, output, timedOut }); else reject(new Error('command failed')); });
    });
  } finally { await fd?.close(); }
}
async function systemctl(args, options) { return run('systemctl', ['--user', ...args], options); }
async function properties(unit) {
  const { output } = await systemctl(['show', unit, '--property=LoadState,ActiveState,SubState,MainPID,InvocationID,FragmentPath,ExecStart,DropInPaths,NeedDaemonReload']);
  return Object.fromEntries(output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
}
function quote(value) { return JSON.stringify(value.replaceAll('%', '%%')); }
const networkKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'npm_config_registry', 'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_noproxy', 'npm_config_cafile'];
function environment(keys) {
  return Object.fromEntries(keys.filter(key => process.env[key] !== undefined && !/[\x00\r\n]/.test(process.env[key])).map(key => [key, process.env[key]]));
}
function runtimePath(node) {
  // Import only absolute entries from this remote SSH environment. Empty and
  // relative entries would let a workspace shadow administrative commands.
  const paths = (process.env.PATH ?? '').split(':').filter(path => path.startsWith('/') && !/[\x00-\x1f\x7f]/.test(path));
  return [...new Set([dirname(node), ...paths, '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
}
function networkEnvironment(node, root) {
  // The native PluginManager also launches pnpm after the installer exits.
  // Keep its owned package manager available without requiring a global install.
  const path = [...new Set([dirname(node), join(root, 'installer/node_modules/.bin'), ...runtimePath(node).split(':')])].join(':');
  return Object.entries({ ...environment(networkKeys), PATH: path }).map(([key, value]) => key + '=' + JSON.stringify(value)).join('\n') + '\n';
}
function installerEnvironment() {
  // Native dependency installers need PATH and the user's npm configuration,
  // but must not inherit unrelated credentials or Node injection options.
  return environment(['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', ...networkKeys]);
}
async function runtimeNode(context) {
  try {
    const result = JSON.parse((await run(context.marker.node, ['-p', 'JSON.stringify({version:process.version,modules:process.versions.modules})'], { env: installerEnvironment(), timeout: 10000 })).output);
    const [major, minor] = result.version.slice(1).split('.').map(Number);
    if (!(major >= 24 || major === 22 && minor >= 19)) fail('runtime');
    return result;
  } catch { fail('runtime'); }
}
async function npm(context, args, options = {}) {
  const env = { ...installerEnvironment(), PATH: runtimePath(context?.marker.node ?? process.execPath) };
  const node = context?.marker.node ?? process.execPath;
  // npm's shebang can otherwise select a different Node/ABI from PATH. Run its
  // JS entry with the owned runtime and use that runtime for install scripts.
  let entry;
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (!directory.startsWith('/') || /[\x00-\x1f\x7f]/.test(directory)) continue;
    const candidate = join(directory, 'npm');
    try { if ((await fs.stat(candidate)).isFile()) { entry = candidate; break; } } catch {}
  }
  if (!entry) fail('install-tools');
  try { return await run(node, [entry, ...args], { ...options, env }); }
  catch (error) { if (args.length === 1 && args[0] === '--version') fail('install-tools'); throw error; }
}
function unitText(root, node) {
  // These three path directives consume the whole value, including spaces.
  // Quoting WorkingDirectory/EnvironmentFile/StandardOutput makes quotes part
  // of the path; only Environment and ExecStart use systemd word quoting.
  return '[Unit]\nDescription=DeepSeek Harness (dsh-connections)\nStartLimitIntervalSec=60\nStartLimitBurst=3\n\n[Service]\nType=exec\nWorkingDirectory=' + join(root, 'workspace') + '\nEnvironment=' + quote('DSH_HOME=' + join(root, 'home')) + '\nEnvironment=' + quote('DSH_AGENTS_HOME=' + join(root, 'agents')) + '\nEnvironment=' + quote('PATH=' + dirname(node) + ':/usr/local/bin:/usr/bin:/bin') + '\nEnvironmentFile=' + join(root, 'environment') + '\nUMask=0077\nExecStart=' + quote(node.replaceAll('$', '$$')) + ' ' + quote(join(root, 'current/node_modules/@deepseek-ai/dsh/lib/bin.js').replaceAll('$', '$$')) + ' --profile web --host 127.0.0.1 --port 0 --no-open\nStandardOutput=truncate:' + join(root, 'service.log') + '\nStandardError=inherit\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=15\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n';
}
async function preflight() {
  if (process.platform !== 'linux') fail('unavailable');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major >= 24 || major === 22 && minor >= 19)) fail('unavailable');
  try {
    await systemctl(['show-environment']);
    for (const command of ['flock', 'systemd-run']) await run(command, ['--version'], { timeout: 10000 });
  } catch { fail('unavailable'); }
}
async function requireTools(commands) {
  try { for (const command of commands) await run(command, ['--version'], { timeout: 10000, env: installerEnvironment() }); }
  catch { fail('install-tools'); }
}
async function installPreflight(update = false, context) {
  await npm(context, ['--version'], { timeout: 10000 });
  if (update) await requireTools(['tar']);
  let linger;
  try { linger = (await run('loginctl', ['show-user', String(process.getuid()), '--property=Linger', '--value'])).output.trim(); }
  catch { fail('linger-check'); }
  if (linger === 'no') fail('linger');
  if (linger !== 'yes') fail('linger-check');
}
async function initialize(input) {
  const root = input.root ?? join(homedir(), '.local/share/dsh-connections');
  const unit = input.unit ?? 'dsh-connections.service';
  if (resolve(root) !== root || /[%\x00-\x1f\x7f]/.test(root) || !/^dsh-connections(?:-[a-z0-9-]+)?\.service$/.test(unit)) fail('ownership');
  const markerPath = join(root, 'owner.json');
  const previous = await exists(markerPath) ? await json(markerPath) : undefined;
  if (previous && (typeof previous.unitPath !== 'string' || !previous.unitPath.startsWith('/'))) fail('ownership');
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  if (!input.unitDirectory && !previous && (resolve(configHome) !== configHome || /[%\x00-\x1f\x7f]/.test(configHome))) fail('ownership');
  // Existing installations retain their recorded unit location when a later
  // SSH login has a different XDG setting. Never create a duplicate service.
  const unitDirectory = input.unitDirectory ?? (previous ? dirname(previous.unitPath) : join(configHome, 'systemd/user'));
  if (resolve(unitDirectory) !== unitDirectory || /[%\x00-\x1f\x7f]/.test(unitDirectory)) fail('ownership');
  const unitPath = join(unitDirectory, unit);
  // systemd can report not-found for a unit that has only drop-ins. Reject
  // those before claiming the home or writing a fragment that activates them.
  const current = await properties(unit);
  if (current.DropInPaths || await exists(unitPath + '.d')) fail('ownership');
  await privateDir(root);
  if (!await exists(markerPath)) {
    if ((await fs.readdir(root)).length || await exists(unitPath) || current.LoadState !== 'not-found') fail('ownership');
    try { await fs.writeFile(markerPath, JSON.stringify({ schema: 1, owner, root, unit, unitPath, node: process.execPath }), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const marker = await json(markerPath);
  if (marker.schema !== 1 || marker.owner !== owner || marker.root !== root || marker.unit !== unit || marker.unitPath !== unitPath || typeof marker.node !== 'string' || !marker.node.startsWith('/') || /[%\x00-\x1f\x7f]/.test(marker.node)) fail('ownership');
  for (const part of ['releases', 'home', 'agents', 'workspace']) await privateDir(join(root, part));
  for (const file of ['service.log', 'install.log', 'maintenance.log', 'management.lock']) {
    const path = join(root, file);
    try { await fs.writeFile(path, '', { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await privatePath(path);
  }
  return { root, unit, unitPath, marker };
}
async function verifyUnit(context) {
  const { root, unit, unitPath, marker } = context;
  const current = await properties(unit);
  if (current.DropInPaths || await exists(unitPath + '.d')) fail('ownership');
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
  const path = join(root, 'current.tmp-locked-' + randomUUID());
  await fs.symlink('releases/' + version, path);
  try { await fs.rename(path, join(root, 'current')); }
  finally { await fs.rm(path, { force: true }); }
}
async function stage(context, version) {
  const { root, marker } = context;
  const runtime = await runtimeNode(context);
  const release = join(root, 'releases', version);
  if (await exists(release)) {
    await privatePath(release, true);
    const metadata = await json(join(release, 'release.json'));
    if (metadata.owner !== owner || metadata.version !== version) fail('ownership');
    if (metadata.runtime && (metadata.runtime.node !== marker.node || metadata.runtime.modules !== runtime.modules)) fail('runtime');
    return;
  }
  const staging = join(root, 'releases', '.stage-' + process.pid);
  await privateDir(staging);
  try {
    await fs.writeFile(join(root, 'install.log'), '', { mode: 0o600 });
    // Harness depends on native packages (including node-pty/koffi) whose
    // reviewed upstream installation requires scripts. Keep their lifecycle,
    // restrict inherited environment, and retain npm's integrity-bearing lock.
    await npm(context, ['install', '--prefix', staging, '--save-exact', '--package-lock', '--omit=dev', '--no-audit', '--no-fund', '--', '@deepseek-ai/dsh@' + version], { timeout: 600000, log: join(root, 'install.log') });
    const manifest = JSON.parse(await fs.readFile(join(staging, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
    if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== version) fail('install');
    const actual = await run(marker.node, [join(staging, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--version'], { env: installerEnvironment() });
    if (actual.output.trim() !== version) fail('install');
    const lock = await fs.readFile(join(staging, 'package-lock.json'));
    const locked = JSON.parse(lock.toString('utf8')).packages?.['node_modules/@deepseek-ai/dsh'];
    if (locked?.version !== version || typeof locked.integrity !== 'string' || !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(locked.integrity)) fail('install');
    await atomic(join(staging, 'release.json'), JSON.stringify({ owner, version, runtime: { ...runtime, node: marker.node }, integrity: locked.integrity, lockDigest: createHash('sha256').update(lock).digest('hex') }));
    await fs.rename(staging, release);
  } catch (error) { await fs.rm(staging, { recursive: true, force: true }); if (error.code === 'ownership') throw error; fail('install'); }
}
async function authenticate(port, token) {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, path: '/?token=' + encodeURIComponent(token), method: 'GET', timeout: 3000 }, response => {
      response.resume();
      const expected = 'dsh-auth-' + createHash('sha256').update('127.0.0.1:' + port).digest('base64url') + '=';
      const cookie = (response.headers['set-cookie'] ?? []).find(cookie => cookie.startsWith(expected) && /;\s*HttpOnly(?:;|$)/i.test(cookie) && /;\s*SameSite=Strict(?:;|$)/i.test(cookie) && /;\s*Path=\/(?:;|$)/i.test(cookie) && !/;\s*Domain=/i.test(cookie));
      const value = cookie?.split(';')[0];
      resolve(response.statusCode === 303 && response.headers.location === './' && value && /^[\x21-\x3a\x3c-\x7e]+$/.test(value) ? value : undefined);
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(undefined)); req.end();
  });
}
async function pluginManagerRequest(port, cookie, method, args, timeout = 120000) {
  if (!['listPlugins', 'setPluginEnabled', 'setBundleEnabled'].includes(method)) fail('plugin-activation');
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ type: 'client-request', rpcId: 'connections-plugin-' + method, method: 'pluginManager/' + method, payload: { args } });
    const rejectRequest = () => reject(Object.assign(new Error('plugin-activation'), { code: 'plugin-activation' }));
    const req = request({ host: '127.0.0.1', port, path: '/api/pluginManager/' + method, method: 'POST', headers: { cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, response => {
      if (response.statusCode !== 200) { response.destroy(); rejectRequest(); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) { req.destroy(); rejectRequest(); } else chunks.push(chunk); });
      response.on('error', rejectRequest);
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (body.result?.ok !== true) { rejectRequest(); return; }
          resolve(body.result.value);
        } catch { rejectRequest(); }
      });
      response.on('close', () => { if (!response.complete) rejectRequest(); });
    });
    const timer = setTimeout(() => { req.destroy(); rejectRequest(); }, timeout);
    req.on('close', () => clearTimeout(timer));
    req.on('error', rejectRequest);
    req.end(payload);
  });
}
async function activateWorkspacePlugin(context, reconcile = false) {
  const host = await ready(context, await currentRelease(context.root));
  const cookie = await authenticate(host.remotePort, host.token);
  if (!cookie) fail('plugin-activation');
  let plugins = await pluginManagerRequest(host.remotePort, cookie, 'listPlugins', {});
  if (!Array.isArray(plugins)) fail('plugin-activation');
  if (!plugins.some(plugin => plugin?.moduleName === packageName)) {
    // A bundle added for the first time may not exist in the running Loader yet.
    // Publish only our bundle through the native lifecycle, then resolve its
    // actual entry before using the entry-level activation path below.
    const result = await pluginManagerRequest(host.remotePort, cookie, 'setBundleEnabled', { name: packageName, enabled: true });
    if (result?.application === 'restart-required') fail('plugin-restart');
    if (result?.application !== 'applied') fail('plugin-activation');
    plugins = await pluginManagerRequest(host.remotePort, cookie, 'listPlugins', {});
    if (!Array.isArray(plugins)) fail('plugin-activation');
  }
  // Select only this bundle's actual Cordis entry. Other entries, including
  // native layout entries disabled by the remote bundle, are never mutated.
  const entries = plugins.filter(plugin => plugin?.moduleName === packageName);
  if (entries.length !== 1 || entries[0].patchId !== 'connections' || typeof entries[0].entryId !== 'string' || entries[0].entryId.length === 0 || entries[0].entryId.length > 1024 || entries[0].readOnlyReason) fail('plugin-activation');
  if (entries[0].enabled === true && entries[0].fiberPhase === 'active' && !reconcile) return;
  const result = await pluginManagerRequest(host.remotePort, cookie, 'setPluginEnabled', { id: entries[0].entryId, enabled: true });
  if (result?.application === 'restart-required') fail('plugin-restart');
  if (result?.application !== 'applied') fail('plugin-activation');
  // Saved enablement is not runtime readiness: a failed/missing dependency can
  // leave an enabled row inactive. Only read polling may retry after this one
  // native mutation; do not restart the service or replay an ambiguous write.
  const deadline = Date.now() + 10000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('plugin-activation');
    const verified = await pluginManagerRequest(host.remotePort, cookie, 'listPlugins', {}, remaining);
    if (!Array.isArray(verified)) fail('plugin-activation');
    const active = verified.filter(plugin => plugin?.moduleName === packageName);
    if (active.length !== 1 || active[0].entryId !== entries[0].entryId || active[0].patchId !== 'connections' || active[0].enabled !== true || active[0].readOnlyReason) fail('plugin-activation');
    if (active[0].fiberPhase === 'active') return;
    if (!['pending', 'loading'].includes(active[0].fiberPhase) || Date.now() >= deadline) fail('plugin-activation');
    await sleep(250);
  }
}
async function installWorkspacePlugin(context, plugin) {
  try { return await installWorkspacePluginContents(context, plugin); }
  catch (error) { if (['ownership', 'install-tools', 'plugin-activation', 'plugin-restart', 'plugin-migration'].includes(error.code)) throw error; fail('install'); }
}
async function workspacePluginContents(root) {
  // A receipt proves a past reconciliation, not the continued presence of the
  // package. Verify precisely the declared runtime files before skipping CLI.
  try {
    const directory = join(root, 'home/profiles/web/node_modules', packageName);
    const manifest = JSON.parse(await fs.readFile(join(directory, 'package.json'), 'utf8'));
    if (manifest.name !== packageName) return undefined;
    const main = manifest.exports?.['.'];
    const entry = typeof main === 'string' ? main : main?.default ?? manifest.main;
    const paths = ['package.json', entry, manifest.dsh?.bundle?.patch, ...(manifest.dsh?.client ? [manifest.exports?.['./client']] : [])];
    if (paths.some(path => typeof path !== 'string' || path.startsWith('/') || path.split('/').includes('..'))) return undefined;
    const digest = createHash('sha256');
    for (const path of paths) { digest.update(path); digest.update('\0'); digest.update(await fs.readFile(join(directory, path))); }
    return digest.digest('hex');
  } catch { return undefined; }
}
async function pluginReceipt(root, digest) {
  const contents = await workspacePluginContents(root);
  if (!contents) fail('install');
  return JSON.stringify({ schema: 3, digest, contents, activation: 'applied' });
}
async function checkWorkspacePluginMigration(context, plugin) {
  // Both bundles compose the same native slots. Resolve the package rename
  // before staging an update or interrupting an otherwise healthy Host.
  if (plugin !== undefined && await exists(join(context.root, 'home/profiles/web/node_modules', owner))) fail('plugin-migration');
}
async function installWorkspacePluginContents(context, plugin) {
  if (plugin === undefined) return; // isolated lifecycle fixtures
  if (!plugin || !/^[a-f0-9]{64}$/.test(plugin.digest) || typeof plugin.data !== 'string') fail('install');
  const archive = Buffer.from(plugin.data, 'base64');
  if (archive.length > 4 * 1024 * 1024 || createHash('sha256').update(archive).digest('hex') !== plugin.digest) fail('install');
  const { root, marker } = context;
  await checkWorkspacePluginMigration(context, plugin);
  const directory = join(root, 'plugins');
  await privateDir(directory);
  const receipt = join(root, 'home/connections-workspace-plugin.json');
  const previous = await exists(receipt) ? await json(receipt) : undefined;
  const contents = await workspacePluginContents(root);
  const installed = previous?.digest === plugin.digest && contents !== undefined && previous.contents === contents;
  const confirmed = installed && previous.schema === 3 && previous.activation === 'applied';
  if (confirmed) {
    if ((await properties(context.unit)).ActiveState === 'active') { await activateWorkspacePlugin(context); return; }
    return { receipt, digest: plugin.digest };
  }
  // Native pnpm can keep a damaged hoisted package for an unchanged file: spec,
  // even with --force. A fresh immutable archive identity republishes only this
  // bundle. Retain it because the profile's saved dependency references it.
  const repair = previous?.digest === plugin.digest && !installed;
  const file = join(directory, plugin.digest + (repair ? '-repair-' + randomUUID() : '') + '.tgz');
  if (!await exists(file)) await fs.writeFile(file, archive, { flag: 'wx', mode: 0o600 });
  await privatePath(file);
  if (createHash('sha256').update(await fs.readFile(file)).digest('hex') !== plugin.digest) fail('ownership');
  if (!installed) {
    const installer = join(root, 'installer');
    await privateDir(installer);
    const pnpm = join(installer, 'node_modules/pnpm/bin/pnpm.cjs');
    if (!await exists(pnpm)) {
      await npm(context, ['--version'], { timeout: 10000 });
      await npm(context, ['install', '--prefix', installer, '--save-exact', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--', 'pnpm@11.13.1'], { timeout: 600000, log: join(root, 'install.log') });
    }
    const env = { ...installerEnvironment(), DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'), PATH: join(installer, 'node_modules/.bin') + ':' + runtimePath(marker.node) };
    await run(marker.node, [join(root, 'current/node_modules/@deepseek-ai/dsh/lib/bin.js'), 'plugin', '--profile', 'web', 'add', '--save-exact', file], { timeout: 600000, env, log: join(root, 'install.log') });
  }
  if ((await properties(context.unit)).ActiveState === 'active') {
    // CLI installation updates files but the native manifest watcher may skip a
    // same-bundle change. Setting this entry enabled reconciles it without a
    // Host restart, including migration from legacy install-only receipts.
    await activateWorkspacePlugin(context, true);
    await atomic(receipt, await pluginReceipt(root, plugin.digest));
    return;
  }
  return { receipt, digest: plugin.digest };
}
async function readyInstalled(context, version, installation) {
  const result = await ready(context, version);
  if (installation) {
    await activateWorkspacePlugin(context);
    await atomic(installation.receipt, await pluginReceipt(context.root, installation.digest));
  }
  return result;
}
async function ready(context, version) {
  const { root, unit } = context;
  const deadline = Date.now() + 120000;
  let failedSince;
  let failedInvocation;
  while (Date.now() < deadline) {
    const before = await properties(unit);
    if (before.ActiveState === 'failed') {
      if (failedInvocation !== before.InvocationID) { failedSince = undefined; failedInvocation = before.InvocationID; }
      failedSince ??= Date.now();
      // Give Restart=on-failure a chance to advance to its next invocation.
      if (Date.now() - failedSince >= 5000) fail('startup');
    } else failedSince = undefined;
    if (before.ActiveState === 'active' && Number(before.MainPID) > 0) {
      const selected = await currentRelease(root);
      if (selected !== version) fail('startup');
      const manifest = JSON.parse(await fs.readFile(join(root, 'releases', selected, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
      if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== selected) fail('startup');
      const processRoot = '/proc/' + before.MainPID;
      try {
        const args = (await fs.readFile(join(processRoot, 'cmdline'), 'utf8')).split('\0');
        if (await fs.readlink(join(processRoot, 'exe')) !== await fs.realpath(context.marker.node)
          || !args.includes(join(root, 'current/node_modules/@deepseek-ai/dsh/lib/bin.js'))) fail('startup');
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
        await sleep(300); continue; // The service may have advanced to its restart.
      }
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
          if (after.ActiveState === 'active' && after.MainPID === before.MainPID && after.InvocationID === before.InvocationID && await currentRelease(root) === selected) return { remotePort: port, token, version: selected, service: 'systemd', pid: Number(after.MainPID) };
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
  await requireTools(['tar']);
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
  await sweepTemporary(root);
  // Bootstrap conveys only the current SSH login's network allowlist in its
  // private request, not argv. Replace rather than merge an older environment
  // so unsetting a proxy/CA/registry variable also removes the persisted value.
  for (const key of networkKeys) {
    delete process.env[key];
    const value = input.network?.[key];
    if (typeof value === 'string' && !/[\x00\r\n]/.test(value)) process.env[key] = value;
  }
  await atomic(join(root, 'environment'), networkEnvironment(context.marker.node, root));
  const runtime = await runtimeNode(context);
  await recover(context);
  await checkWorkspacePluginMigration(context, input.plugin);
  // Only the lock owner reaches here; interrupted staging directories cannot
  // belong to another live maintenance operation or the selected installation.
  for (const name of await fs.readdir(join(root, 'releases'))) {
    if (/^\.stage-\d+$/.test(name)) {
      await privatePath(join(root, 'releases', name), true);
      await fs.rm(join(root, 'releases', name), { recursive: true, force: true });
    }
  }
  const previous = await currentRelease(root);
  // Default updates must not downgrade a newer Host or replace an unvalidated
  // release. Inspect the installed version under the same maintenance lock.
  if (input.latest && previous && !input.supportedVersions?.includes(previous)) fail('update-version');
  if (input.action === 'prepare' && previous && input.supportedVersions && !input.supportedVersions.includes(previous)) fail('version');
  if (previous) {
    const metadata = await json(join(root, 'releases', previous, 'release.json'));
    if (metadata.runtime && (metadata.runtime.node !== context.marker.node || metadata.runtime.modules !== runtime.modules)) fail('runtime');
  }
  if (previous === undefined) {
    await installPreflight(false, context);
    await stage(context, input.version);
    await select(root, input.version);
    const installation = await installWorkspacePlugin(context, input.plugin);
    await installUnit(context);
    await start(context);
    return readyInstalled(context, input.version, installation);
  }
  await installUnit(context);
  if (input.action === 'prepare' || input.version === previous) { const installation = await installWorkspacePlugin(context, input.plugin); await start(context); return readyInstalled(context, previous, installation); }
  // Installation and validation occur while the previous Harness is still serving.
  await installPreflight(true, context);
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
    const installation = await installWorkspacePlugin(context, input.plugin);
    await start(context);
    const result = await readyInstalled(context, input.version, installation);
    await fs.rm(transactionPath);
    await fs.rm(join(root, 'rollback.tar'), { force: true }).catch(() => {});
    return result;
  } catch {
    await recover(context);
    fail('rollback');
  }
}
async function bootstrap(input) {
  await preflight();
  // Check fresh installations before creating any owned files. The worker
  // repeats this under its lock in case a previous attempt was interrupted.
  if (!await exists(input.root ?? join(homedir(), '.local/share/dsh-connections'))) await installPreflight();
  const context = await initialize(input);
  await verifyUnit(context);
  // Abandoned callers may leave private result credentials behind. Maintenance
  // can run for at most 30 minutes; only files older than a day are collected.
  for (const name of await fs.readdir(context.root)) {
    if (!/^(?:result|request)-[0-9a-f-]{36}\.json$/.test(name)) continue;
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
  const requestPath = join(context.root, 'request-' + input.operation + '.json');
  // A unique request needs no rename: it is fully written before launching the
  // reader. Keeping bootstrap out of root-level atomic writes lets the locked
  // worker collect crash leftovers without racing another live SSH bootstrap.
  const encoded = Buffer.from(JSON.stringify({ ...input, network: environment(networkKeys) })).toString('base64');
  const request = await fs.open(requestPath, 'wx', 0o600);
  try { await request.writeFile(encoded); }
  catch (error) { await fs.rm(requestPath, { force: true }); throw error; }
  finally { await request.close(); }
  const maintenance = 'dsh-connections-maintenance-' + input.operation;
  const args = ['--user', '--quiet', '--wait', '--pipe', '--collect', '--unit=' + maintenance, '--property=Type=exec', '--property=UMask=0077', '--setenv=PATH=' + runtimePath(context.marker.node), 'flock', '--wait', '1200', '--conflict-exit-code', '75', join(context.root, 'management.lock'), process.execPath, workerPath, '--worker', requestPath];
  let execution;
  try { execution = await run('systemd-run', args, { timeout: 1800000, allowFailure: true, log: join(context.root, 'maintenance.log') }); }
  catch { await fs.rm(requestPath, { force: true }); fail('maintenance'); }
  if (!await exists(resultPath)) {
    if (!execution.timedOut) await fs.rm(requestPath, { force: true });
    fail(execution.timedOut || execution.code === 75 ? 'busy' : 'maintenance');
  }
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
    result = process.argv[2] === '--worker' ? await worker(input) : await bootstrap(input);
  } catch (error) {
    result = { error: ['unavailable', 'install-tools', 'linger', 'linger-check', 'ownership', 'install', 'runtime', 'version', 'update-version', 'plugin-activation', 'plugin-restart', 'plugin-migration', 'startup', 'rollback', 'recovery', 'busy', 'maintenance'].includes(error.code) ? error.code : 'startup' };
  }
  if (process.argv[2] === '--worker') {
    const root = input.root ?? join(homedir(), '.local/share/dsh-connections');
    await atomic(join(root, 'result-' + input.operation + '.json'), JSON.stringify(result));
  } else process.stdout.write(JSON.stringify(result));
}
if (process.argv[2] === '--worker') {
  const inputPath = process.argv[3];
  if (!/^request-[0-9a-f-]{36}\.json$/.test(basename(inputPath))) fail('ownership');
  await privatePath(inputPath);
  const encoded = await fs.readFile(inputPath, 'utf8');
  if (encoded.length > 12 * 1024 * 1024) fail('ownership');
  try { await main(encoded); } finally { await fs.rm(inputPath, { force: true }); }
}
`
