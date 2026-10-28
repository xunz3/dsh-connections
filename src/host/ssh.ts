import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTarget } from '../shared/validation.js'
import { SshTunnelError, sshProcessError, type ProcessResult, type SshTunnelOptions, type Tunnel, type TunnelInput } from './ssh-common.js'
import { connectStdioTunnel } from './ssh-stdio.js'
export { SshTunnelError, type SshTunnelOptions, type Tunnel } from './ssh-common.js'

interface OwnedProcess {
  child: ChildProcess
  done: Promise<ProcessResult>
  settled: boolean
  stderr: string
}

function cancelled(): Error {
  return new DOMException('SSH connection cancelled.', 'AbortError')
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : cancelled()
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortReason(signal)); return }
    const onAbort = () => { clearTimeout(timer); reject(abortReason(signal!)) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function processError(process: OwnedProcess, result: ProcessResult, fallback: 'SSH_FORWARD' | 'SSH_CLOSED' | 'SSH_FAILED'): SshTunnelError {
  return sshProcessError(process.stderr, result, fallback)
}

function signalProcess(process: OwnedProcess, signal: NodeJS.Signals, includeDescendants = false): void {
  if (!process.child.pid || (process.settled && (!includeDescendants || globalThis.process.platform === 'win32'))) return
  try {
    // ProxyJump/ProxyCommand children belong to this private process group too.
    if (globalThis.process.platform !== 'win32') globalThis.process.kill(-process.child.pid, signal)
    else process.child.kill(signal)
  } catch { /* The process can exit between the check and the signal. */ }
}

/** Reserve an OS-selected loopback port. SSH's subsequent bind is authoritative. */
async function candidatePort(signal: AbortSignal): Promise<number> {
  signal.throwIfAborted()
  const server = createServer()
  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') reject(new Error('Could not allocate a local port.'))
        else resolve(address.port)
      })
    })
    signal.throwIfAborted()
    return port
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/**
 * Own exactly one OpenSSH master and one local forward. Readiness comes from
 * the private control socket's acknowledged forward, never an arbitrary TCP
 * listener at the candidate port. The remote Harness process is not managed.
 */
export async function connectTunnel(input: TunnelInput, options: SshTunnelOptions = {}): Promise<Tunnel> {
  const target = parseTarget(input.target)
  if (!Number.isInteger(input.remotePort) || input.remotePort < 1 || input.remotePort > 65535) throw new TypeError('Invalid remote port.')
  if (input.preferredLocalPort !== undefined && (!Number.isInteger(input.preferredLocalPort) || input.preferredLocalPort < 1 || input.preferredLocalPort > 65535)) throw new TypeError('Invalid preferred local port.')
  if (input.signal?.aborted) throw cancelled()
  const startupTimeoutMs = options.startupTimeoutMs ?? 20_000
  const controlTimeoutMs = options.controlTimeoutMs ?? 3_000
  const shutdownGraceMs = options.shutdownGraceMs ?? 500
  for (const value of [startupTimeoutMs, controlTimeoutMs, shutdownGraceMs]) {
    if (!Number.isFinite(value) || value < 1) throw new TypeError('Invalid SSH timeout.')
  }
  if ((options.transport ?? (process.platform === 'win32' ? 'stdio' : 'control')) === 'stdio') return connectStdioTunnel({ ...input, target }, options)

  const controller = new AbortController()
  const children = new Set<OwnedProcess>()
  let master: OwnedProcess | undefined
  const listeners = new Set<(error?: Error) => void>()
  let directory: string | undefined
  let port = 0
  let closed = false
  let closeError: Error | undefined
  let cleanup: Promise<void> | undefined
  let notified = false
  let startupTimer: ReturnType<typeof setTimeout> | undefined

  const notify = () => {
    if (notified) return
    notified = true
    for (const listener of [...listeners]) {
      try { listener(closeError) } catch { /* A subscriber must not break disposal. */ }
    }
    listeners.clear()
  }

  const stop = (error?: Error): Promise<void> => {
    if (cleanup) return cleanup
    closed = true
    closeError = error
    clearTimeout(startupTimer)
    input.signal?.removeEventListener('abort', onAbort)
    controller.abort(error ?? cancelled())
    cleanup = (async () => {
      // A ProxyCommand descendant can outlive its master and close its stdio.
      // Keep that owned process group addressable after the leader has exited.
      const processes = [...new Set([...children, ...(master ? [master] : [])])]
      for (const child of processes) signalProcess(child, 'SIGTERM', child === master)
      const done = Promise.all(processes.map((child) => child.done))
      await Promise.race([done, delay(shutdownGraceMs)])
      for (const child of processes) signalProcess(child, 'SIGKILL', child === master)
      await Promise.race([done, delay(shutdownGraceMs)])
      if (directory) await rm(directory, { recursive: true, force: true })
    })().finally(notify)
    return cleanup
  }
  const onAbort = () => { void stop(cancelled()).catch(() => {}) }
  input.signal?.addEventListener('abort', onAbort, { once: true })
  if (input.signal?.aborted) onAbort()
  if (!closed) startupTimer = setTimeout(() => {
    void stop(new SshTunnelError('SSH_TIMEOUT', 'SSH connection timed out. Check the host, network and SSH config.')).catch(() => {})
  }, startupTimeoutMs)

  const launch = (args: string[]): OwnedProcess => {
    controller.signal.throwIfAborted()
    const child = spawn(options.sshPath ?? 'ssh', args, {
      shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32', env: options.env ?? process.env,
    })
    const owned: OwnedProcess = { child, done: Promise.resolve({ code: null }), settled: false, stderr: '' }
    let spawnError: Error | undefined
    child.stderr?.on('data', (chunk: Buffer) => { owned.stderr = (owned.stderr + chunk.toString('utf8')).slice(-8_192) })
    child.on('error', (error) => { spawnError = error })
    owned.done = new Promise((resolve) => {
      child.once('close', (code) => {
        owned.settled = true
        children.delete(owned)
        resolve({ code, ...(spawnError ? { error: spawnError } : {}) })
      })
    })
    children.add(owned)
    return owned
  }

  const runControl = async (args: string[]): Promise<{ child: OwnedProcess; result: ProcessResult }> => {
    const child = launch(args)
    let timer: ReturnType<typeof setTimeout> | undefined
    let onControlAbort: (() => void) | undefined
    try {
      const interruption = new Promise<never>((_, reject) => {
        onControlAbort = () => reject(abortReason(controller.signal))
        controller.signal.addEventListener('abort', onControlAbort, { once: true })
        timer = setTimeout(() => {
          signalProcess(child, 'SIGTERM')
          reject(new SshTunnelError('SSH_TIMEOUT', 'OpenSSH control request timed out.'))
        }, controlTimeoutMs)
      })
      return { child, result: await Promise.race([child.done, interruption]) }
    } finally {
      clearTimeout(timer)
      if (onControlAbort) controller.signal.removeEventListener('abort', onControlAbort)
    }
  }

  try {
    directory = await mkdtemp(join(tmpdir(), 'dshc-'))
    await chmod(directory, 0o700)
    // An abort during mkdtemp must still remove the newly-created directory.
    if (closed) { await rm(directory, { recursive: true, force: true }); throw abortReason(controller.signal) }
    const controlPath = join(directory, 's')
    const masterArgs = [
      ...(options.configFile ? ['-F', options.configFile] : []),
      '-M', '-N', '-T', '-S', controlPath,
      '-o', 'ControlMaster=yes', '-o', 'ControlPersist=no',
      '-o', 'ClearAllForwardings=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
      '-o', 'Tunnel=no',
      '-o', 'PermitLocalCommand=no', '-o', 'RemoteCommand=none',
      // Older OpenSSH has no ForkAfterAuthentication option. Newer versions
      // must override user config so the owned master cannot daemonize.
      '-o', 'IgnoreUnknown=ForkAfterAuthentication', '-o', 'ForkAfterAuthentication=no',
      '-o', `ConnectTimeout=${Math.max(1, Math.min(15, Math.ceil(startupTimeoutMs / 1_000)))}`,
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '--', target,
    ]
    master = launch(masterArgs)
    const ownedMaster = master
    void ownedMaster.done.then((result) => {
      if (!closed) void stop(processError(ownedMaster, result, 'SSH_CLOSED')).catch(() => {})
    })

    for (;;) {
      controller.signal.throwIfAborted()
      const exists = await stat(controlPath).then((entry) => entry.isSocket(), () => false)
      if (exists) {
        const check = await runControl(['-F', 'none', '-S', controlPath, '-O', 'check', '--', target])
        if (check.result.code === 0 && !check.result.error) break
      }
      await delay(40, controller.signal)
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      const candidate = attempt === 0 && input.preferredLocalPort !== undefined ? input.preferredLocalPort : await candidatePort(controller.signal)
      const forward = await runControl([
        '-F', 'none', '-S', controlPath, '-o', 'ExitOnForwardFailure=yes', '-O', 'forward',
        '-L', `127.0.0.1:${candidate}:127.0.0.1:${input.remotePort}`, '--', target,
      ])
      controller.signal.throwIfAborted()
      if (forward.result.code === 0 && !forward.result.error) { port = candidate; break }
      if (attempt === 3 || !/address already in use|cannot listen|cannot bind|port forwarding failed/i.test(forward.child.stderr)) {
        throw processError(forward.child, forward.result, 'SSH_FORWARD')
      }
    }
    controller.signal.throwIfAborted()
    clearTimeout(startupTimer)
    return {
      get port() { return port },
      close: () => stop(),
      onClose(listener) {
        let active = true
        if (closed) queueMicrotask(() => { if (active) { try { listener(closeError) } catch { /* Subscriber callback. */ } } })
        else listeners.add(listener)
        return () => { active = false; listeners.delete(listener) }
      },
    }
  } catch (error) {
    await stop(error instanceof Error ? error : new SshTunnelError('SSH_FAILED', 'SSH could not connect.'))
    // stop() may have completed while the asynchronous directory creation ran.
    if (directory) await rm(directory, { recursive: true, force: true })
    throw error
  }
}
