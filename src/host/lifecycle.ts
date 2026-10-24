import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseLaunchUrl, parseTarget, parseVersion } from '../shared/validation.js'
import { REMOTE_SERVICE_SCRIPT } from './remote-service.js'

export const DEFAULT_HARNESS_VERSION = '0.2.1-rc.2'

export interface ManagedHost {
  remotePort: number
  token: string
  version: string
  service: 'systemd'
  pid: number
}

/** Host-only test/configuration hooks; never accepted by the client RPC. */
export interface RemoteHostOptions {
  /** Test-only: omit the bundled remote view during isolated service lifecycle tests. */
  workspacePlugin?: false
  sshPath?: string
  configFile?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  remoteRoot?: string
  unit?: string
  /** Isolated test installations only; defaults to the user's systemd unit directory. */
  unitDirectory?: string
  executor?: (request: { target: string; script: string; signal?: AbortSignal; timeoutMs: number }) => Promise<string>
}

const messages = {
  unavailable: 'The remote host needs Linux, Node 22.19+ or 24+, npm, and a running systemd user manager.',
  linger: 'Enable persistent user services on the remote host: loginctl enable-linger "$USER". Then reconnect.',
  ownership: 'The remote Connections directory or service belongs to another installation. Resolve that conflict before connecting.',
  install: 'The remote Harness installation failed. Check the remote npm registry, disk space, and private install.log, then reconnect.',
  'plugin-activation': 'The remote Connections update could not be activated. Check the remote plugin status and private service.log, then reconnect. The Harness service was not restarted.',
  'plugin-restart': 'The remote Connections update requires a Harness restart. Finish active work, restart the managed service, then reconnect. No restart was performed automatically.',
  startup: 'The remote Harness service did not become ready. Check its private service.log and systemctl --user status dsh-connections.service.',
  rollback: 'The update failed; the previous Harness version and state were restored.',
  recovery: 'The update could not be rolled back automatically. The private recovery snapshot was preserved; inspect the remote installation before retrying.',
  busy: 'Remote Harness maintenance is still running. Reconnect to wait for its result.',
  ssh: 'Could not manage the remote Harness over SSH. Check the host, SSH key, and known_hosts in your terminal.',
  protocol: 'The remote Harness returned an invalid management response.',
} as const

export class RemoteHostError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code])
    this.name = 'RemoteHostError'
  }
}

function aborted(): Error { return new DOMException('Remote connection cancelled.', 'AbortError') }

async function execute(request: { target: string; script: string; signal?: AbortSignal; timeoutMs: number }, options: RemoteHostOptions): Promise<string> {
  if (request.signal?.aborted) throw aborted()
  const args = [
    ...(options.configFile === undefined ? [] : ['-F', options.configFile]),
    '-T', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
    '-o', 'ClearAllForwardings=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'Tunnel=no',
    '-o', 'PermitLocalCommand=no', '-o', 'RemoteCommand=none', '-o', 'ForkAfterAuthentication=no',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '--', request.target,
    // Only a fixed command crosses the remote shell. All configuration travels on stdin.
    'node --input-type=module -',
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(options.sshPath ?? 'ssh', args, {
      shell: false, detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], env: options.env ?? process.env,
    })
    let stdout = ''
    let failure: Error | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal) } catch { /* already exited */ }
    }
    const stop = (error: Error) => {
      failure ??= error
      kill('SIGTERM')
      killTimer ??= setTimeout(() => kill('SIGKILL'), 300)
    }
    const onAbort = () => stop(aborted())
    const timer = setTimeout(() => stop(new RemoteHostError('busy')), request.timeoutMs)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    if (request.signal?.aborted) onAbort()
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > 16_384) stop(new RemoteHostError('protocol'))
    })
    // Management diagnostics can contain native startup URLs. Never expose them.
    child.stderr.resume()
    child.stdin.on('error', () => { /* close/error below determines the result */ })
    child.on('error', () => { failure ??= new RemoteHostError('ssh') })
    child.on('close', (code) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      request.signal?.removeEventListener('abort', onAbort)
      kill('SIGKILL') // also reap any ProxyCommand descendants
      if (failure) reject(failure)
      else if (code === 127) reject(new RemoteHostError('unavailable'))
      else if (code !== 0) reject(new RemoteHostError('ssh'))
      else resolve(stdout)
    })
    child.stdin.end(request.script)
  })
}

async function manage(action: 'prepare' | 'update', input: { target: string; version?: string; signal?: AbortSignal }, options: RemoteHostOptions): Promise<ManagedHost> {
  const target = parseTarget(input.target)
  const version = parseVersion(input.version ?? DEFAULT_HARNESS_VERSION)
  if (input.signal?.aborted) throw aborted()
  const timeoutMs = options.timeoutMs ?? 15 * 60_000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid remote management timeout.')
  for (const path of [options.remoteRoot, options.unitDirectory]) {
    if (path !== undefined && (!path.startsWith('/') || /[%\x00-\x1f\x7f]/.test(path))) throw new TypeError('Invalid managed directory.')
  }
  if (options.unit !== undefined && !/^dsh-connections(?:-[a-z0-9-]+)?\.service$/.test(options.unit)) throw new TypeError('Invalid managed service name.')
  const archive = options.workspacePlugin === false ? undefined : await readFile(new URL('../remote-plugin.tgz', import.meta.url))
  if (archive && archive.byteLength > 4 * 1024 * 1024) throw new RemoteHostError('install')
  const plugin = archive === undefined ? undefined : { data: archive.toString('base64'), digest: createHash('sha256').update(archive).digest('hex') }
  const payload = Buffer.from(JSON.stringify({ action, version, plugin, root: options.remoteRoot, unit: options.unit, unitDirectory: options.unitDirectory, operation: randomUUID(), source: Buffer.from(REMOTE_SERVICE_SCRIPT).toString('base64') })).toString('base64')
  const script = `${REMOTE_SERVICE_SCRIPT}\nawait main(${JSON.stringify(payload)});\n`
  const stdout = await (options.executor ?? (request => execute(request, options)))({ target, script, signal: input.signal, timeoutMs })
  if (input.signal?.aborted) throw aborted()
  try {
    const result = JSON.parse(stdout) as Record<string, unknown>
    if (result.error !== undefined) {
      if (typeof result.error === 'string' && Object.hasOwn(messages, result.error)) throw new RemoteHostError(result.error as keyof typeof messages)
      throw new RemoteHostError('protocol')
    }
    const launch = parseLaunchUrl(`http://127.0.0.1:${String(result.remotePort)}/?token=${String(result.token)}`)
    if (result.service !== 'systemd' || !Number.isSafeInteger(result.pid) || (result.pid as number) < 1) throw new Error()
    return { ...launch, version: parseVersion(result.version), service: 'systemd', pid: result.pid as number }
  } catch (error) {
    if (error instanceof RemoteHostError) throw error
    throw new RemoteHostError('protocol')
  }
}

/** Install only when absent; an existing managed host is never implicitly upgraded. */
export function prepareHost(input: { target: string; version?: string; signal?: AbortSignal }, options: RemoteHostOptions = {}): Promise<ManagedHost> {
  return manage('prepare', input, options)
}

/** Explicit exact-version update; the remote system manager owns the transaction. */
export function updateHost(input: { target: string; version: string; signal?: AbortSignal }, options: RemoteHostOptions = {}): Promise<ManagedHost> {
  return manage('update', input, options)
}
