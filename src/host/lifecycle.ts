import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { LATEST_SUPPORTED_REMOTE_VERSION, parseLaunchUrl, parseSupportedVersion, parseTarget, parseVersion, SUPPORTED_REMOTE_VERSIONS } from '../shared/validation.js'
import { REMOTE_BOOTSTRAP_COMMAND } from './remote-bootstrap.js'
import { REMOTE_SERVICE_SCRIPT } from './remote-service.js'
import { terminateSshProcess } from './ssh-process.js'
import { SSH_ERROR_MESSAGES, sshProcessError, type ProcessResult } from './ssh-common.js'

export const DEFAULT_HARNESS_VERSION = SUPPORTED_REMOTE_VERSIONS[0]!

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
  'plugin-migration': 'This Host still has the unpublished @xunz/dsh-connections bundle. Remove it from this service profile with the native CLI before installing @xunz03/dsh-connections; retain the service homes and credentials. See the release guide.',
  unavailable: 'The remote host needs Linux, Node 22.19+ or 24+, flock, systemd-run, and a running systemd user manager.',
  node: 'Could not find a supported remote Node runtime. Ensure Node 22.19+ or 24+ is on PATH for noninteractive SSH, for example by checking ssh HOST node --version. Existing managed runtimes are not changed automatically.',
  'install-tools': 'Remote installation needs npm; Harness updates and recovery also need tar. Restore the required tools, then retry.',
  runtime: 'The managed Node runtime is missing, unsupported, or has a different native ABI. Restore the Node installation recorded in owner.json/release.json before reconnecting; do not change the owned service or reuse native dependencies with another Node ABI.',
  version: `The existing remote Harness version is not supported by this Connections build. Explicitly update to one of: ${SUPPORTED_REMOTE_VERSIONS.join(', ')}.`,
  'update-version': 'The installed remote Harness version has not been validated by this Connections build. Update Connections before updating this Host; its current version was preserved.',
  linger: 'Enable persistent user services on the remote host: loginctl enable-linger "$USER". Then reconnect.',
  ownership: 'The remote Connections directory or service belongs to another installation. Resolve that conflict before connecting.',
  install: 'The remote Harness installation failed. Check the remote npm registry, disk space, and private install.log, then reconnect.',
  'plugin-activation': 'The remote Connections update could not be activated. Check the remote plugin status and private service.log, then reconnect. The Harness service was not restarted.',
  'plugin-restart': 'The remote Connections update requires a Harness restart. Finish active work, restart the managed service, then reconnect. No restart was performed automatically.',
  startup: 'The remote Harness service did not become ready. Check its private service.log and systemctl --user status dsh-connections.service.',
  rollback: 'The update failed; the previous Harness version and state were restored.',
  recovery: 'The update could not be rolled back automatically. The private recovery snapshot was preserved; inspect the remote installation before retrying.',
  busy: 'Remote Harness maintenance is still running. Reconnect to wait for its result.',
  maintenance: 'Remote Harness maintenance did not complete. Check the private maintenance.log and the systemd user manager, then reconnect.',
  'ssh-unavailable': SSH_ERROR_MESSAGES.SSH_UNAVAILABLE,
  'ssh-auth': SSH_ERROR_MESSAGES.SSH_AUTH,
  'ssh-host-key': SSH_ERROR_MESSAGES.SSH_HOST_KEY,
  'ssh-timeout': SSH_ERROR_MESSAGES.SSH_TIMEOUT,
  'ssh-dns': SSH_ERROR_MESSAGES.SSH_DNS,
  'ssh-refused': SSH_ERROR_MESSAGES.SSH_REFUSED,
  'ssh-unreachable': SSH_ERROR_MESSAGES.SSH_UNREACHABLE,
  'ssh-forward': SSH_ERROR_MESSAGES.SSH_FORWARD,
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

function sshFailure(stderr: string, result: ProcessResult): RemoteHostError {
  const failure = sshProcessError(stderr, result, 'SSH_FAILED')
  const codes = {
    SSH_UNAVAILABLE: 'ssh-unavailable', SSH_HOST_KEY: 'ssh-host-key', SSH_AUTH: 'ssh-auth', SSH_TIMEOUT: 'ssh-timeout',
    SSH_DNS: 'ssh-dns', SSH_REFUSED: 'ssh-refused', SSH_UNREACHABLE: 'ssh-unreachable', SSH_FORWARD: 'ssh-forward',
    SSH_CLOSED: 'ssh', SSH_FAILED: 'ssh',
  } as const
  return new RemoteHostError(codes[failure.code])
}

async function execute(request: { target: string; script: string; signal?: AbortSignal; timeoutMs: number }, options: RemoteHostOptions): Promise<string> {
  if (request.signal?.aborted) throw aborted()
  const args = [
    ...(options.configFile === undefined ? [] : ['-F', options.configFile]),
    '-T', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
    '-o', 'ClearAllForwardings=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'Tunnel=no',
    '-o', 'PermitLocalCommand=no', '-o', 'RemoteCommand=none',
    '-o', 'IgnoreUnknown=ForkAfterAuthentication,StdinNull', '-o', 'ForkAfterAuthentication=no', '-o', 'StdinNull=no',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '--', request.target,
    // Only a fixed command crosses the remote shell. All configuration travels on stdin.
    REMOTE_BOOTSTRAP_COMMAND,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(options.sshPath ?? 'ssh', args, {
      shell: false, detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], env: options.env ?? process.env,
    })
    let stdout = ''
    let stderr = ''
    let failure: Error | undefined
    let settled = false
    let disposal: Promise<void> | undefined
    let markClosed!: () => void
    const done = new Promise<void>(resolve => { markClosed = resolve })
    const dispose = () => disposal ??= terminateSshProcess(child, done)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(stdout)
    }
    const stop = (error: Error) => {
      failure ??= error
      // Cancellation must settle even if a ProxyCommand descendant keeps a
      // pipe open after the SSH leader exits (especially on native Windows).
      void dispose().then(() => finish(failure))
    }
    const onAbort = () => stop(aborted())
    const timer = setTimeout(() => stop(new RemoteHostError('busy')), request.timeoutMs)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    if (request.signal?.aborted) onAbort()
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > 16_384) stop(new RemoteHostError('protocol'))
    })
    // Retain a bounded tail only to classify SSH failures into fixed messages.
    // Diagnostics can contain native startup URLs and must never be exposed.
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-8_192) })
    child.stdin.on('error', () => { /* close/error below determines the result */ })
    child.on('error', error => { failure ??= sshFailure(stderr, { code: null, error }) })
    child.on('close', (code) => {
      markClosed()
      void dispose().then(() => {
        if (failure) finish(failure)
        else if (code === 127) finish(new RemoteHostError('unavailable'))
        else if (code !== 0) finish(sshFailure(stderr, { code }))
        else finish()
      })
    })
    child.stdin.end(request.script)
  })
}

async function manage(action: 'prepare' | 'update', input: { target: string; version?: string; signal?: AbortSignal }, options: RemoteHostOptions): Promise<ManagedHost> {
  const target = parseTarget(input.target)
  // Isolated lifecycle fixtures deliberately exercise broken synthetic releases.
  const latest = action === 'update' && input.version === undefined
  const version = (options.workspacePlugin === false ? parseVersion : parseSupportedVersion)(input.version ?? (latest ? LATEST_SUPPORTED_REMOTE_VERSION : DEFAULT_HARNESS_VERSION))
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
  const payload = Buffer.from(JSON.stringify({ action, version, latest, plugin, supportedVersions: options.workspacePlugin === false && !latest ? undefined : SUPPORTED_REMOTE_VERSIONS, root: options.remoteRoot, unit: options.unit, unitDirectory: options.unitDirectory, operation: randomUUID(), source: Buffer.from(REMOTE_SERVICE_SCRIPT).toString('base64') })).toString('base64')
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

/** Defaults to the newest tested release; the remote system manager owns the transaction. */
export function updateHost(input: { target: string; version?: string; signal?: AbortSignal }, options: RemoteHostOptions = {}): Promise<ManagedHost> {
  return manage('update', input, options)
}
