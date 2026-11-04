export type ConnectionPhase = 'disconnected' | 'connecting' | 'updating' | 'connected' | 'error'
export type ConnectionMode = 'managed' | 'existing'
export type ConnectionStage = 'preparing' | 'tunnel' | 'authenticating'
export type SshFailureCode = 'SSH_UNAVAILABLE' | 'SSH_HOST_KEY' | 'SSH_AUTH' | 'SSH_TIMEOUT' | 'SSH_DNS' | 'SSH_REFUSED' | 'SSH_UNREACHABLE' | 'SSH_FORWARD' | 'SSH_CLOSED' | 'SSH_FAILED'
export type SshCheckResult = { ok: true } | { ok: false; code: SshFailureCode }

export interface ConnectionView {
  id: string
  name: string
  target: string
  remotePort?: number
  mode?: ConnectionMode
  autoConnect?: boolean
  runtime?: { version: string; service: 'systemd'; pid: number }
  phase: ConnectionPhase
  /** Actual current step; present only while connecting or updating. */
  stage?: ConnectionStage
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

/** Omit version to update to the newest remote release validated by this build. */
export interface UpdateConnection { id: string; version?: string }

export type ConnectionDiagnosticScope = 'current' | 'legacy'
export interface ConnectionDiagnosticRef {
  id: string
  scope: ConnectionDiagnosticScope
  /** Random, short-lived Host receipt; never a credential or a record digest. */
  receipt: string
}
export interface ConnectionDiagnostic extends ConnectionDiagnosticRef {
  issue: 'invalid-record'
  canDelete: boolean
}
export interface ConnectionDiagnosticList { records: ConnectionDiagnostic[]; truncated: boolean }
export interface ConnectionDiagnosticExport {
  format: 'connections-redacted-diagnostic-v1'
  redacted: true
  credentialBackup: false
  concurrency: 'same-process-provider-queue-only'
  record: Pick<ConnectionDiagnostic, 'id' | 'scope' | 'issue' | 'canDelete'>
}
export interface DeleteConnectionDiagnostic extends ConnectionDiagnosticRef {
  confirm: true
  /** Native credentials have no compare-and-delete or cross-process exclusion. */
  acknowledgeProcessLocal: true
}
export type ConnectionDiagnosticFailure = 'STALE' | 'UNAVAILABLE' | 'UNSAFE_RECORD' | 'EXPORT_REQUIRED'
export type ConnectionDiagnosticResult<T> = { ok: true; value: T } | { ok: false; code: ConnectionDiagnosticFailure }
export interface ConnectionDiagnosticsApi {
  list(): Promise<ConnectionDiagnosticList>
  export(input: ConnectionDiagnosticRef): Promise<ConnectionDiagnosticResult<ConnectionDiagnosticExport>>
  remove(input: DeleteConnectionDiagnostic): Promise<ConnectionDiagnosticResult<{ deleted: true }>>
}

export interface ConnectionOperationSnapshot { view: ConnectionView; revision: string }

export interface ConnectionsApi {
  /** Host-only approval precondition; never exposed by the Remote/UI namespace. */
  operationSnapshot?(id: string): Promise<ConnectionOperationSnapshot>
  /** Explicit owner-only recovery; optional for older integrations and test adapters. */
  diagnostics?: ConnectionDiagnosticsApi
  /** Test system SSH authentication and remote command execution without saving or installing. */
  checkSsh(target: string): Promise<SshCheckResult>
  /** Literal host aliases from the local Harness computer's SSH configuration. */
  sshHosts(): Promise<string[]>
  list(): Promise<ConnectionView[]>
  save(input: SaveConnection, expectedRevision?: string): Promise<ConnectionView>
  /** Optional revision parameters are Host-only; UI calls use their authenticated interaction. */
  remove(id: string, expectedRevision?: string): Promise<void>
  connect(id: string, expectedRevision?: string): Promise<ConnectionView>
  reconnect(id: string, expectedRevision?: string): Promise<ConnectionView>
  disconnect(id: string, expectedRevision?: string): Promise<ConnectionView>
  update(input: UpdateConnection, expectedRevision?: string): Promise<ConnectionView>
  open(id: string): Promise<{ url: string }>
}
