import { spawn } from 'node:child_process'
import { parseTarget } from '../shared/validation.js'
import { sshProcessError, SshTunnelError, type SshTunnelOptions } from './ssh-common.js'
import { terminateSshProcess } from './ssh-process.js'

const marker = 'DSH_CONNECTIONS_SSH_CHECK_OK'
const command = `printf '%s\\n' '${marker}'`
const outputLimit = 16_384
const aborted = () => new DOMException('SSH check cancelled.', 'AbortError')

/** Check noninteractive SSH access without saving a connection or managing a Host. */
export async function checkSshTarget(input: { target: string; signal?: AbortSignal }, options: SshTunnelOptions = {}): Promise<void> {
  const target = parseTarget(input.target)
  const timeoutMs = options.startupTimeoutMs ?? 15_000
  const graceMs = options.shutdownGraceMs ?? 500
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isFinite(graceMs) || graceMs < 0) throw new TypeError('Invalid SSH check timeout.')
  if (input.signal?.aborted) throw aborted()
  const args = [
    ...(options.configFile === undefined ? [] : ['-F', options.configFile]),
    '-T', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
    '-o', 'ClearAllForwardings=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'Tunnel=no',
    '-o', 'PermitLocalCommand=no', '-o', 'RemoteCommand=none',
    '-o', 'IgnoreUnknown=ForkAfterAuthentication,StdinNull', '-o', 'ForkAfterAuthentication=no', '-o', 'StdinNull=no',
    '-o', `ConnectTimeout=${Math.max(1, Math.min(15, Math.ceil(timeoutMs / 1_000)))}`,
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
    '--', target, command,
  ]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.sshPath ?? 'ssh', args, {
      shell: false, detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], env: options.env ?? process.env,
    })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let failure: Error | undefined
    let settled = false
    let disposal: Promise<void> | undefined
    let markClosed!: () => void
    const done = new Promise<void>(resolve => { markClosed = resolve })
    const dispose = () => disposal ??= terminateSshProcess(child, done, graceMs)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const stop = (error: Error) => {
      failure ??= error
      // ProxyCommand descendants can keep pipes open after the SSH leader exits.
      // Always settle after bounded cleanup, independently of the close event.
      void dispose().then(() => finish(failure))
    }
    const onAbort = () => stop(aborted())
    const timer = setTimeout(() => stop(new SshTunnelError('SSH_TIMEOUT')), timeoutMs)
    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
    const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (failure || settled) return
      outputBytes += chunk.byteLength
      if (outputBytes > outputLimit) {
        stop(new SshTunnelError('SSH_FAILED', 'SSH check returned too much output. Check the remote shell startup configuration in your terminal.'))
        return
      }
      if (stream === 'stdout') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
    }
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk))
    child.stdin.on('error', () => { /* SSH exit determines the result. */ })
    child.on('error', error => stop(sshProcessError(stderr, { code: null, error }, 'SSH_FAILED')))
    child.once('close', code => {
      markClosed()
      void dispose().then(() => {
        if (failure) finish(failure)
        else if (code !== 0) finish(sshProcessError(stderr, { code }, 'SSH_FAILED'))
        else if (!stdout.split(/\r?\n/).includes(marker)) finish(new SshTunnelError('SSH_FAILED', 'SSH connected but could not verify remote command execution. Check the remote shell or forced command configuration in your terminal.'))
        else finish()
      })
    })
    child.stdin.end()
  })
}
