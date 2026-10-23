export type ConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ConnectionView {
  id: string
  name: string
  target: string
  remotePort: number
  phase: ConnectionPhase
  localPort?: number
  error?: string
}

export interface SaveConnection {
  id?: string
  name: string
  target: string
  /** Write-only. Omit during an edit to preserve the existing launch credential. */
  launchUrl?: string
}

export interface ConnectionRecord {
  id: string
  name: string
  target: string
  remotePort: number
  token: string
}

export interface ConnectionsApi {
  list(): Promise<ConnectionView[]>
  save(input: SaveConnection): Promise<ConnectionView>
  remove(id: string): Promise<void>
  connect(id: string): Promise<ConnectionView>
  disconnect(id: string): Promise<ConnectionView>
  open(id: string): Promise<{ url: string }>
}
