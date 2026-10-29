import type { SshFailureCode } from '../shared/types.js'

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

export const SSH_ERROR_MESSAGES = {
  SSH_UNAVAILABLE: 'OpenSSH is unavailable. Install the system SSH client and ensure ssh is on PATH.',
  SSH_HOST_KEY: 'SSH host identity is not trusted or has changed. Verify the host in your terminal before connecting.',
  SSH_AUTH: 'SSH authentication failed. Check your SSH key or agent in a terminal; Connections uses noninteractive authentication.',
  SSH_TIMEOUT: 'SSH connection timed out. Check the host, network, and SSH config.',
  SSH_DNS: 'SSH could not resolve the hostname. Check the SSH alias, HostName, and DNS configuration.',
  SSH_REFUSED: 'The SSH server refused the connection. Check the host, SSH port, and whether sshd is running.',
  SSH_UNREACHABLE: 'The SSH host is unreachable. Check the network, VPN, and jump host configuration.',
  SSH_FORWARD: 'SSH could not create the tunnel. Check the server forwarding permissions and local port availability.',
  SSH_CLOSED: 'The SSH connection closed. Connect again to resume access.',
  SSH_FAILED: 'SSH could not connect. Check the target, key or agent, known_hosts, and SSH configuration in your terminal.',
} as const satisfies Record<SshFailureCode, string>

export type SshErrorCode = keyof typeof SSH_ERROR_MESSAGES

export class SshTunnelError extends Error {
  constructor(readonly code: SshErrorCode, message: string = SSH_ERROR_MESSAGES[code]) {
    super(message)
    this.name = 'SshTunnelError'
  }
}

export interface ProcessResult {
  code: number | null
  error?: Error
}

export function sshProcessError(stderr: string, result: ProcessResult, fallback: 'SSH_FORWARD' | 'SSH_CLOSED' | 'SSH_FAILED'): SshTunnelError {
  // Native SSH diagnostics may include paths, proxy output or launch credentials.
  // Inspect a bounded tail for classification; only fixed messages leave the Host.
  const message = stderr.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trim().slice(-8_192)
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return new SshTunnelError('SSH_UNAVAILABLE')
  if (/host key verification failed|remote host identification has changed|no .* host key is known|host key .*mismatch/i.test(message)) return new SshTunnelError('SSH_HOST_KEY')
  if (/permission denied|authentication failed|no supported authentication|too many authentication failures/i.test(message)) return new SshTunnelError('SSH_AUTH')
  if (/channel \d+: open failed: (?:administratively prohibited|connect failed)|stdio forwarding failed/i.test(message)) return new SshTunnelError('SSH_FORWARD')
  if (/could not resolve hostname|name or service not known|temporary failure in name resolution|nodename nor servname provided|no such host is known|getaddrinfo.*(?:failed|not known)/i.test(message)) return new SshTunnelError('SSH_DNS')
  if (/connection timed out|operation timed out|connection timeout|connect.*etimedout/i.test(message)) return new SshTunnelError('SSH_TIMEOUT')
  if (/connection refused|connect.*econnrefused/i.test(message)) return new SshTunnelError('SSH_REFUSED')
  if (/no route to host|network is unreachable|host is unreachable|network unreachable|connect.*e(?:host|net)unreach/i.test(message)) return new SshTunnelError('SSH_UNREACHABLE')
  if (/administratively prohibited|forwarding (?:request )?failed|port forwarding failed|cannot listen to port|address already in use/i.test(message)) return new SshTunnelError('SSH_FORWARD')
  return new SshTunnelError(fallback)
}
