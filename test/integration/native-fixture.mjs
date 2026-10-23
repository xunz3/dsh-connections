/** Linux-only, disposable native Harness + real OpenSSH fixture. No user config is edited. */
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, open, readFile, readlink, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const [command, input] = process.argv.slice(2)
if (process.platform !== 'linux' || !input || !['start', 'restart', 'stop'].includes(command)) {
  throw new Error('Usage on Linux: DSH_QA_CLI=/absolute/dsh/lib/bin.js node test/integration/native-fixture.mjs start|restart|stop /tmp/fixture-directory')
}
const root = resolve(input)
if (!root.startsWith(`${resolve(tmpdir())}/`)) throw new Error('Fixture must live under the operating system temporary directory.')
const metadataPath = join(root, 'processes.json')
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`

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
async function startHost(metadata) {
  await mkdir(join(root, 'agents'), { mode: 0o700, recursive: true })
  metadata.host = await startProcess(metadata.node, [metadata.cli, '--profile', 'web', '--host', '127.0.0.1', '--port', String(metadata.port), '--no-open'], {
    ...process.env, DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'), PATH: `${join(root, 'bin')}:${dirname(metadata.node)}:${process.env.PATH}`,
  }, join(root, 'host.log'))
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 })
  for (let attempt = 0; attempt < 300; attempt++) {
    const log = await readFile(join(root, 'host.log'), 'utf8')
    if (/dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(log) && await tcpOpen(metadata.port)) return
    if (await identity(metadata.host.pid) !== metadata.host.start) throw new Error('Isolated Harness failed to start. Inspect its private host.log.')
    await pause(100)
  }
  throw new Error('Isolated Harness startup timed out. Inspect its private host.log.')
}

if (command === 'start') {
  const cli = process.env.DSH_QA_CLI
  if (!cli?.startsWith('/')) throw new Error('Set DSH_QA_CLI to the installed native Harness bin.js.')
  await mkdir(root, { mode: 0o700 })
  const metadata = { node: process.execPath, cli, port: await freePort(), sshPort: await freePort(), alias: 'native-workspace-fixture' }
  try {
    await mkdir(join(root, 'bin'), { mode: 0o700 })
    await mkdir(join(root, 'home'), { mode: 0o700 })
    await mkdir(join(root, 'agents'), { mode: 0o700 })
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
    metadata.sshd = await startProcess('/usr/sbin/sshd', ['-D', '-e', '-f', join(root, 'sshd_config')], process.env, join(root, 'sshd.log'))
    for (let attempt = 0; attempt < 100 && !await tcpOpen(metadata.sshPort); attempt++) await pause(50)
    if (!await tcpOpen(metadata.sshPort)) throw new Error('Isolated sshd did not listen.')
    await startHost(metadata)
    await chmod(metadataPath, 0o600)
  } catch (error) {
    await stopProcess(metadata.host)
    await stopProcess(metadata.sshd)
    throw error
  }
  console.log(JSON.stringify({ pid: metadata.host.pid, port: metadata.port, alias: metadata.alias, log: join(root, 'host.log') }))
} else {
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  await stopProcess(metadata.host)
  if (command === 'restart') {
    await startHost(metadata)
    console.log(JSON.stringify({ pid: metadata.host.pid, port: metadata.port, log: join(root, 'host.log') }))
  } else {
    await stopProcess(metadata.sshd)
    console.log(JSON.stringify({ hostClosed: !await tcpOpen(metadata.port), sshClosed: !await tcpOpen(metadata.sshPort) }))
  }
}
