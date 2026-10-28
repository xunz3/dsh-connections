/** Linux-only, disposable native Harness + real OpenSSH fixture. No user config is edited. */
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, open, readFile, readlink, realpath, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const [command, input] = process.argv.slice(2)
if (process.platform !== 'linux' || !input || !['start', 'restart', 'restart-remote', 'stop'].includes(command)) {
  throw new Error('Usage on Linux: DSH_QA_CLI=/absolute/dsh/lib/bin.js node test/integration/native-fixture.mjs start|restart|restart-remote|stop /tmp/fixture-directory')
}
const root = resolve(input)
if (!root.startsWith(`${resolve(tmpdir())}/`)) throw new Error('Fixture must live under the operating system temporary directory.')
const metadataPath = join(root, 'processes.json')
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
const digest = value => createHash('sha256').update(value).digest('hex')
const buildFiles = ['dist/host/index.js', 'dist/client.js']

async function verifyInstalled(metadata, remote = false) {
  const installed = join(root, remote ? 'remote-home' : 'home', 'profiles/web/node_modules/@xunz03/dsh-connections')
  const files = {}
  for (const file of buildFiles) {
    const [expected, actual] = await Promise.all([
      remote ? execute('tar', ['-xOzf', join(repository, 'dist/remote-plugin.tgz'), `package/${file}`], { encoding: 'buffer' }).then(result => result.stdout) : readFile(join(repository, file)),
      readFile(join(installed, file)),
    ])
    const sha256 = digest(expected)
    if (digest(actual) !== sha256) throw new Error(`The ${remote ? 'remote' : 'local'} fixture contains a stale ${file}. Rebuild and reinstall its Connections bundle before starting Harness.`)
    files[file] = sha256
  }
  metadata.builds ??= {}
  const side = remote ? 'remote' : 'local'
  metadata.builds[side] = { ...metadata.builds[side], packageRoot: await realpath(installed), files }
}

async function identity(pid) {
  try {
    const fields = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')
    return fields[0] === 'Z' ? undefined : fields[19]
  }
  catch { return undefined }
}
async function startProcess(executable, args, env, log) {
  const output = await open(log, 'w', 0o600)
  try {
    const child = spawn(executable, args, { cwd: root, env, detached: true, stdio: ['ignore', output.fd, output.fd] })
    await once(child, 'spawn')
    child.unref()
    return { pid: child.pid, start: await identity(child.pid), executable, args }
  } finally { await output.close() }
}
async function stopProcess(record) {
  if (!record?.start || await identity(record.pid) !== record.start) return
  const args = (await readFile(`/proc/${record.pid}/cmdline`, 'utf8')).split('\0')
  const commandMatches = args.includes(record.executable) && record.args.every(value => args.includes(value))
  // OpenSSH replaces its argv with a listener title after binding. The kernel
  // executable, recorded start time and exact config path still identify it.
  const sshdTitleMatches = record.executable === '/usr/sbin/sshd'
    && args[0].startsWith(`sshd: ${[record.executable, ...record.args].join(' ')} [listener]`)
  if (await readlink(`/proc/${record.pid}/exe`) !== record.executable || !commandMatches && !sshdTitleMatches) {
    throw new Error('Refusing to stop a process whose command identity changed.')
  }
  process.kill(record.pid, 'SIGTERM')
  for (let attempt = 0; attempt < 100 && await identity(record.pid) === record.start; attempt++) await pause(100)
  if (await identity(record.pid) === record.start) process.kill(record.pid, 'SIGKILL')
}
async function tcpOpen(port) {
  return await new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = value => { socket.destroy(); resolve(value) }
    socket.once('error', () => finish(false))
    socket.once('connect', () => finish(true))
    socket.setTimeout(500, () => finish(false))
  })
}
async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
function hostEnvironment(metadata, remote = false) {
  return {
    ...process.env, DSH_HOME: join(root, remote ? 'remote-home' : 'home'),
    DSH_AGENTS_HOME: join(root, remote ? 'remote-agents' : 'agents'),
    PATH: `${join(root, 'bin')}:${dirname(metadata.node)}:${process.env.PATH}`,
  }
}
async function installRemote(metadata) {
  // A fixed file: URL can resolve to an old same-version package in pnpm's
  // store. Keep each exact archive as immutable fixture evidence and give the
  // package manager a new identity whenever its contents change.
  const archive = await readFile(join(repository, 'dist/remote-plugin.tgz'))
  const sha256 = digest(archive)
  const artifacts = join(root, 'artifacts')
  await mkdir(artifacts, { recursive: true, mode: 0o700 })
  const archivePath = join(artifacts, `connections-${sha256}.tgz`)
  try { await writeFile(archivePath, archive, { mode: 0o600, flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (digest(await readFile(archivePath)) !== sha256) throw new Error('The fixture archive does not match its content hash.')
  }
  const install = await execute(metadata.node, [metadata.cli, 'plugin', '--profile', 'web', 'add', '--save-exact', archivePath], {
    cwd: root, env: hostEnvironment(metadata, true),
  })
  await writeFile(join(root, 'remote-install.log'), install.stdout + install.stderr, { mode: 0o600 })
  await verifyInstalled(metadata, true)
  metadata.builds.remote = { ...metadata.builds.remote, archive: archivePath, archiveSha256: sha256 }
}
async function prepareMedia(metadata) {
  for (const [side, project] of Object.entries(metadata.projects ?? {})) {
    await writeFile(join(project, 'media.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#6788aa"/></svg>\n')
    await writeFile(join(project, 'media.md'), `# ${side} media\n\n![Native ${side} preview](media.svg)\n`)
  }
}
async function startHost(metadata, remote = false) {
  await verifyInstalled(metadata, remote)
  const port = remote ? metadata.remotePort : metadata.port
  const key = remote ? 'remote' : 'host'
  const logPath = join(root, remote ? 'remote.log' : 'host.log')
  await mkdir(join(root, remote ? 'remote-agents' : 'agents'), { mode: 0o700, recursive: true })
  metadata[key] = await startProcess(metadata.node, [metadata.cli, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], hostEnvironment(metadata, remote), logPath)
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 })
  // The first dedicated profile may prepare native packages before logging its URL.
  for (let attempt = 0; attempt < (metadata.remotePort ? 1200 : 300); attempt++) {
    const log = await readFile(logPath, 'utf8')
    if (/dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(log) && await tcpOpen(port)) return
    if (await identity(metadata[key].pid) !== metadata[key].start) throw new Error('Isolated Harness failed to start. Inspect its private startup log.')
    await pause(100)
  }
  throw new Error('Isolated Harness startup timed out. Inspect its private host.log.')
}

if (command === 'start') {
  const cli = process.env.DSH_QA_CLI
  if (!cli?.startsWith('/')) throw new Error('Set DSH_QA_CLI to the installed native Harness bin.js.')
  await mkdir(root, { mode: 0o700 })
  const metadata = { node: process.execPath, cli, port: await freePort(), sshPort: await freePort(), alias: 'native-workspace-fixture' }
  if (process.env.DSH_QA_UNIFIED === '1') {
    metadata.remotePort = await freePort()
    metadata.projects = { local: join(root, 'local-project'), remote: join(root, 'remote-project') }
  }
  try {
    await mkdir(join(root, 'bin'), { mode: 0o700 })
    await mkdir(join(root, 'home'), { mode: 0o700 })
    await mkdir(join(root, 'agents'), { mode: 0o700 })
    if (metadata.remotePort) {
      await mkdir(join(root, 'remote-home'), { mode: 0o700 })
      await mkdir(join(root, 'remote-agents'), { mode: 0o700 })
      for (const [side, project] of Object.entries(metadata.projects)) {
        await mkdir(join(project, 'nested'), { mode: 0o700, recursive: true })
        await writeFile(join(project, 'README.md'), `# ${side} project\n\nNative ${side} workspace fixture.\n`)
        await writeFile(join(project, 'nested/source.txt'), `native ${side} sidebar nested file\n`)
      }
      await prepareMedia(metadata)
    }
    await execute('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'host-key')])
    await execute('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'client-key')])
    const publicKey = (await readFile(join(root, 'host-key.pub'), 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ')
    await writeFile(join(root, 'known_hosts'), `[127.0.0.1]:${metadata.sshPort} ${publicKey}\n`, { mode: 0o600 })
    await writeFile(join(root, 'sshd_config'), [
      `Port ${metadata.sshPort}`, 'ListenAddress 127.0.0.1', `HostKey ${join(root, 'host-key')}`,
      `PidFile ${join(root, 'sshd.pid')}`, `AuthorizedKeysFile ${join(root, 'client-key.pub')}`,
      'StrictModes no', 'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
      'AuthenticationMethods publickey', 'AllowTcpForwarding local', 'PermitOpen 127.0.0.1:*',
      'GatewayPorts no', 'LogLevel ERROR', 'ForceCommand /bin/false',
    ].join('\n') + '\n', { mode: 0o600 })
    await writeFile(join(root, 'ssh_config'), [
      `Host ${metadata.alias}`, ' HostName 127.0.0.1', ` Port ${metadata.sshPort}`, ` User ${userInfo().username}`,
      ` IdentityFile ${join(root, 'client-key')}`, ' IdentitiesOnly yes',
      ` UserKnownHostsFile ${join(root, 'known_hosts')}`, ' GlobalKnownHostsFile /dev/null',
    ].join('\n') + '\n', { mode: 0o600 })
    // The plugin still executes real OpenSSH. Only this process's PATH supplies
    // an isolated config file instead of reading or modifying ~/.ssh/config.
    await writeFile(join(root, 'bin/ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F ${shellQuote(join(root, 'ssh_config'))} "$@"\n`, { mode: 0o700 })
    const install = await execute(metadata.node, [cli, 'plugin', '--profile', 'web', 'add', repository], {
      cwd: root, env: { ...process.env, DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'), PATH: `${dirname(metadata.node)}:${process.env.PATH}` },
    })
    await writeFile(join(root, 'install.log'), install.stdout + install.stderr, { mode: 0o600 })
    if (metadata.remotePort) await installRemote(metadata)
    metadata.sshd = await startProcess('/usr/sbin/sshd', ['-D', '-e', '-f', join(root, 'sshd_config')], process.env, join(root, 'sshd.log'))
    for (let attempt = 0; attempt < 100 && !await tcpOpen(metadata.sshPort); attempt++) await pause(50)
    if (!await tcpOpen(metadata.sshPort)) throw new Error('Isolated sshd did not listen.')
    if (metadata.remotePort) await startHost(metadata, true)
    await startHost(metadata)
    await chmod(metadataPath, 0o600)
  } catch (error) {
    await stopProcess(metadata.host)
    await stopProcess(metadata.remote)
    await stopProcess(metadata.sshd)
    throw error
  }
  console.log(JSON.stringify({ pid: metadata.host.pid, port: metadata.port, alias: metadata.alias, log: join(root, 'host.log'),
    ...(metadata.remotePort ? { remotePid: metadata.remote.pid, remotePort: metadata.remotePort, remoteLog: join(root, 'remote.log'), projects: metadata.projects } : {}),
  }))
} else {
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  if (command === 'restart-remote') {
    if (!metadata.remotePort) throw new Error('This fixture has no owned remote Host.')
    await stopProcess(metadata.remote)
    await installRemote(metadata)
    await prepareMedia(metadata)
    await startHost(metadata, true)
    console.log(JSON.stringify({ pid: metadata.remote.pid, port: metadata.remotePort, log: join(root, 'remote.log') }))
    process.exit(0)
  }
  await stopProcess(metadata.host)
  if (command === 'restart') {
    if (!await tcpOpen(metadata.sshPort)) {
      metadata.sshd = await startProcess('/usr/sbin/sshd', ['-D', '-e', '-f', join(root, 'sshd_config')], process.env, join(root, 'sshd.log'))
      for (let attempt = 0; attempt < 100 && !await tcpOpen(metadata.sshPort); attempt++) await pause(50)
      if (!await tcpOpen(metadata.sshPort)) throw new Error('Isolated sshd did not listen.')
    }
    await startHost(metadata)
    console.log(JSON.stringify({ pid: metadata.host.pid, port: metadata.port, log: join(root, 'host.log') }))
  } else {
    await stopProcess(metadata.remote)
    await stopProcess(metadata.sshd)
    console.log(JSON.stringify({ hostClosed: !await tcpOpen(metadata.port), sshClosed: !await tcpOpen(metadata.sshPort),
      ...(metadata.remotePort ? { remoteClosed: !await tcpOpen(metadata.remotePort) } : {}),
    }))
  }
}
