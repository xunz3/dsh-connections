export type ConnectionPhase = 'disconnected' | 'connecting' | 'updating' | 'connected' | 'error'
export type ConnectionMode = 'managed' | 'existing'

export interface ConnectionView {
  id: string
  name: string
  target: string
  remotePort?: number
  mode?: ConnectionMode
  autoConnect?: boolean
  runtime?: { version: string; service: 'systemd'; pid: number }
  phase: ConnectionPhase
  localPort?: number
  /** Public, opaque identity of this authenticated SSH transport; contains no credential. */
  transportId?: string
  error?: string
}

export interface SaveConnection {
  id?: string
  name: string
  target: string
  mode?: ConnectionMode
  autoConnect?: boolean
  /** Write-only. Omit during an edit to preserve the existing launch credential. */
  launchUrl?: string
}

export interface ConnectionRecord {
  id: string
  name: string
  target: string
  mode?: ConnectionMode
  autoConnect?: boolean
  remotePort?: number
  token?: string
  /** Private transport preference; only the acknowledged SSH listener is trusted. */
  lastLocalPort?: number
}

export interface UpdateConnection { id: string; version: string }

export interface ConnectionsApi {
  /** Literal host aliases from the local Harness computer's SSH configuration. */
  sshHosts(): Promise<string[]>
  list(): Promise<ConnectionView[]>
  save(input: SaveConnection): Promise<ConnectionView>
  remove(id: string): Promise<void>
  connect(id: string): Promise<ConnectionView>
  reconnect(id: string): Promise<ConnectionView>
  disconnect(id: string): Promise<ConnectionView>
  update(input: UpdateConnection): Promise<ConnectionView>
  open(id: string): Promise<{ url: string }>
}
