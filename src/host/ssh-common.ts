export interface Tunnel {
  readonly port: number
  close(): Promise<void>
  onClose(listener: (error?: Error) => void): () => void
}

/** Host-side injection points, never accepted from a connection's RPC input. */
export interface SshTunnelOptions {
  sshPath?: string
  configFile?: string
  env?: NodeJS.ProcessEnv
  startupTimeoutMs?: number
  controlTimeoutMs?: number
  shutdownGraceMs?: number
  /** Windows uses stdio forwarding; explicit selection supports real SSH tests. */
  transport?: 'control' | 'stdio'
}

export interface TunnelInput {
  target: string
  remotePort: number
  preferredLocalPort?: number
  signal?: AbortSignal
}

export class SshTunnelError extends Error {
  constructor(readonly code: 'SSH_UNAVAILABLE' | 'SSH_HOST_KEY' | 'SSH_AUTH' | 'SSH_TIMEOUT' | 'SSH_FORWARD' | 'SSH_CLOSED' | 'SSH_FAILED', message: string) {
    super(message)
    this.name = 'SshTunnelError'
  }
}

export interface ProcessResult {
  code: number | null
  error?: Error
}

export function sshProcessError(stderr: string, result: ProcessResult, fallback: 'SSH_FORWARD' | 'SSH_CLOSED' | 'SSH_FAILED'): SshTunnelError {
  const message = stderr.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/([?&]token=)[^&\s]+/gi, '$1[redacted]')
    .trim().slice(-600)
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return new SshTunnelError('SSH_UNAVAILABLE', 'OpenSSH is unavailable. Install the system SSH client and ensure ssh is on PATH.')
  if (/host key verification failed|remote host identification has changed|no .* host key is known|host key .*mismatch/i.test(message)) return new SshTunnelError('SSH_HOST_KEY', 'SSH host identity is not trusted or has changed. Verify the host in your terminal before connecting.')
  if (/permission denied|authentication failed|no supported authentication/i.test(message)) return new SshTunnelError('SSH_AUTH', 'SSH authentication failed. Check your SSH key or agent in a terminal; Connections uses noninteractive authentication.')
  const label = fallback === 'SSH_FORWARD' ? 'SSH could not create the local tunnel.' : fallback === 'SSH_CLOSED' ? 'The SSH connection closed.' : 'SSH could not connect.'
  return new SshTunnelError(fallback, `${label}${message ? ` ${message}` : ''}`)
}
