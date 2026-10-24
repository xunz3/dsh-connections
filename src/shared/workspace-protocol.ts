/** Small owner-only catalog and navigation seam; conversation data stays in Harness. */
export const WORKSPACE_ROUTE = '/connections/workspaces'
export const WORKSPACE_ENDPOINT = `/api${WORKSPACE_ROUTE}`
export const WORKSPACE_REQUEST_LIMIT = 16 * 1024
export const WORKSPACE_RESPONSE_LIMIT = 4 * 1024 * 1024

export interface WorkspaceCatalogWorkspace {
  id: string
  path: string
  title: string
  sessionIds: string[]
}
export interface WorkspaceCatalogSession {
  id: string
  title: string
  cwd?: string
  updatedAt: number
  running: boolean
  blank: boolean
  origin?: 'subagent'
  parentSessionId?: string
}
export interface WorkspaceCatalog {
  workspaces: WorkspaceCatalogWorkspace[]
  sessions: WorkspaceCatalogSession[]
  archivedSessionIds: string[]
  pinnedSessionIds: string[]
}
export type WorkspaceNavigationTarget =
  | { kind: 'session' | 'workspace'; id: string }
  | { kind: 'pick' }
export interface WorkspaceViewIntent {
  revision: number
  requestId: string
  target: WorkspaceNavigationTarget
}
export type WorkspaceNavigationError = 'NAVIGATION_FAILED' | 'PICK_CANCELLED'
export interface WorkspaceViewState {
  /** Increments only when a new navigation request is accepted. */
  revision: number
  /** Last navigation acknowledged by the native remote document. */
  reportedRevision: number
  intent?: WorkspaceViewIntent
  sessionId?: string
  error?: WorkspaceNavigationError
}
export type WorkspaceRequest =
  | { op: 'catalog' }
  | { op: 'renameWorkspace'; id: string; title: string }
  | { op: 'forgetWorkspace'; id: string }
  | { op: 'renameSession'; id: string; title: string }
  | { op: 'archiveSession'; id: string; archived: boolean }
  | { op: 'pinSession'; id: string; pinned: boolean }
  | { op: 'openView' }
  | { op: 'navigate'; channel: string; requestId: string; target: WorkspaceNavigationTarget }
  | { op: 'pollView'; channel: string; afterRevision: number }
  | { op: 'reportView'; channel: string; revision: number; sessionId?: string; error?: WorkspaceNavigationError }
  | { op: 'viewState'; channel: string }
  | { op: 'closeView'; channel: string }

export interface WorkspaceResultMap {
  catalog: WorkspaceCatalog
  renameWorkspace: { workspace: WorkspaceCatalogWorkspace }
  forgetWorkspace: { done: true }
  renameSession: { done: true }
  archiveSession: { done: true }
  pinSession: { done: true }
  openView: WorkspaceViewState & { channel: string }
  navigate: WorkspaceViewState
  pollView: WorkspaceViewState
  reportView: WorkspaceViewState
  viewState: WorkspaceViewState
  closeView: { closed: true }
}
export type WorkspaceOperation = WorkspaceRequest['op']
export type WorkspaceResult = WorkspaceResultMap[WorkspaceOperation]
const operations: readonly WorkspaceOperation[] = [
  'catalog', 'renameWorkspace', 'forgetWorkspace',
  'renameSession', 'archiveSession', 'pinSession', 'openView', 'navigate', 'pollView', 'reportView', 'viewState', 'closeView',
]
export function parseWorkspaceOperation(value: unknown): WorkspaceOperation {
  if (typeof value !== 'string' || !operations.includes(value as WorkspaceOperation)) throw new TypeError('The workspace request is invalid.')
  return value as WorkspaceOperation
}
export const WORKSPACE_ERRORS = {
  BAD_REQUEST: 'The workspace request is invalid.',
  TOO_LARGE: 'The workspace request or result is too large.',
  NOT_FOUND: 'The workspace, session, or view is no longer available.',
  CONFLICT: 'This request conflicts with the current workspace state.',
  SESSION_ACTIVE: 'This session still has active work. Stop it before archiving.',
  UNAVAILABLE: 'The workspace service is unavailable.',
  NOT_EMBEDDED: 'This Host needs the Connections remote content bundle. Install it in the remote profile.',
  CANCELLED: 'The workspace request was cancelled.',
  FAILED: 'The workspace operation failed.',
} as const
export type WorkspaceErrorCode = keyof typeof WORKSPACE_ERRORS
export type WorkspaceResponse<Op extends WorkspaceOperation = WorkspaceOperation> =
  | { ok: true; value: WorkspaceResultMap[Op] }
  | { ok: false; error: { code: WorkspaceErrorCode; message: string } }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  return value as Record<string, unknown>
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  return value
}
export function parseWorkspaceId(value: unknown): string {
  const id = text(value, 256)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id)) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  return id
}
export function parseWorkspaceChannel(value: unknown): string {
  const channel = text(value, 43)
  if (!/^[A-Za-z0-9_-]{43}$/.test(channel)) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  return channel
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  return value
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
}
function navigationError(value: unknown): WorkspaceNavigationError {
  if (value !== 'NAVIGATION_FAILED' && value !== 'PICK_CANCELLED') throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  return value
}
export function parseWorkspaceTarget(value: unknown): WorkspaceNavigationTarget {
  const target = object(value)
  if (target.kind === 'pick') { keys(target, ['kind']); return { kind: 'pick' } }
  if (target.kind !== 'session' && target.kind !== 'workspace') throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  keys(target, ['kind', 'id'])
  return { kind: target.kind, id: parseWorkspaceId(target.id) }
}

/** Reject unknown fields so credentials and unrelated native commands never enter this seam. */
export function parseWorkspaceRequest(value: unknown): WorkspaceRequest {
  const input = object(value)
  const op = input.op
  switch (op) {
    case 'catalog': case 'openView': keys(input, ['op']); return { op }
    case 'renameWorkspace': case 'renameSession':
      keys(input, ['op', 'id', 'title'])
      return { op, id: parseWorkspaceId(input.id), title: text(input.title, 512).trim() }
    case 'forgetWorkspace': keys(input, ['op', 'id']); return { op, id: parseWorkspaceId(input.id) }
    case 'archiveSession':
      keys(input, ['op', 'id', 'archived']); return { op, id: parseWorkspaceId(input.id), archived: boolean(input.archived) }
    case 'pinSession':
      keys(input, ['op', 'id', 'pinned']); return { op, id: parseWorkspaceId(input.id), pinned: boolean(input.pinned) }
    case 'navigate':
      keys(input, ['op', 'channel', 'requestId', 'target'])
      return { op, channel: parseWorkspaceChannel(input.channel), requestId: parseWorkspaceId(input.requestId), target: parseWorkspaceTarget(input.target) }
    case 'pollView':
      keys(input, ['op', 'channel', 'afterRevision'])
      return { op, channel: parseWorkspaceChannel(input.channel), afterRevision: revision(input.afterRevision) }
    case 'reportView':
      keys(input, ['op', 'channel', 'revision', 'sessionId', 'error'])
      return {
        op, channel: parseWorkspaceChannel(input.channel), revision: revision(input.revision),
        ...(input.sessionId === undefined ? {} : { sessionId: parseWorkspaceId(input.sessionId) }),
        ...(input.error === undefined ? {} : { error: navigationError(input.error) }),
      }
    case 'viewState': case 'closeView': keys(input, ['op', 'channel']); return { op, channel: parseWorkspaceChannel(input.channel) }
    default: throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  }
}

function array<T>(value: unknown, parse: (value: unknown) => T, max = 20_000): T[] {
  if (!Array.isArray(value) || value.length > max) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  return value.map(parse)
}
function workspace(value: unknown): WorkspaceCatalogWorkspace {
  const row = object(value)
  return { id: parseWorkspaceId(row.id), path: text(row.path, 4096), title: text(row.title, 512, true), sessionIds: array(row.sessionIds, parseWorkspaceId) }
}
export function parseWorkspaceCatalog(value: unknown): WorkspaceCatalog {
  const catalog = object(value)
  return {
    workspaces: array(catalog.workspaces, workspace),
    sessions: array(catalog.sessions, (value) => {
      const row = object(value)
      if (row.origin !== undefined && row.origin !== 'subagent') throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
      return {
        id: parseWorkspaceId(row.id), title: text(row.title, 512, true), updatedAt: revision(row.updatedAt),
        running: boolean(row.running), blank: boolean(row.blank),
        ...(row.cwd === undefined ? {} : { cwd: text(row.cwd, 4096) }),
        ...(row.origin === undefined ? {} : { origin: 'subagent' as const }),
        ...(row.parentSessionId === undefined ? {} : { parentSessionId: parseWorkspaceId(row.parentSessionId) }),
      }
    }),
    archivedSessionIds: array(catalog.archivedSessionIds, parseWorkspaceId),
    pinnedSessionIds: array(catalog.pinnedSessionIds, parseWorkspaceId),
  }
}
export function parseWorkspaceViewState(value: unknown): WorkspaceViewState {
  const state = object(value)
  const intent = state.intent === undefined ? undefined : object(state.intent)
  const result: WorkspaceViewState = {
    revision: revision(state.revision), reportedRevision: revision(state.reportedRevision),
    ...(intent === undefined ? {} : { intent: { revision: revision(intent.revision), requestId: parseWorkspaceId(intent.requestId), target: parseWorkspaceTarget(intent.target) } }),
    ...(state.sessionId === undefined ? {} : { sessionId: parseWorkspaceId(state.sessionId) }),
    ...(state.error === undefined ? {} : { error: navigationError(state.error) }),
  }
  if (result.reportedRevision > result.revision || (result.intent !== undefined && result.intent.revision !== result.revision)) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  return result
}
/** Project trusted shapes at both sides of the local Host's HTTP relay. */
export function parseWorkspaceResponse<Op extends WorkspaceOperation>(op: Op, value: unknown): WorkspaceResponse<Op> {
  parseWorkspaceOperation(op)
  const envelope = object(value)
  if (envelope.ok === false) {
    const error = object(envelope.error)
    if (typeof error.code !== 'string' || !Object.hasOwn(WORKSPACE_ERRORS, error.code)) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
    const code = error.code as WorkspaceErrorCode
    return { ok: false, error: { code, message: WORKSPACE_ERRORS[code] } }
  }
  if (envelope.ok !== true) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  const result = object(envelope.value)
  let parsed: WorkspaceResult
  switch (op) {
    case 'catalog': parsed = parseWorkspaceCatalog(result); break
    case 'renameWorkspace': parsed = { workspace: workspace(result.workspace) }; break
    case 'forgetWorkspace': case 'renameSession': case 'archiveSession': case 'pinSession':
      if (result.done !== true) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
      parsed = { done: true }; break
    case 'openView': parsed = { ...parseWorkspaceViewState(result), channel: parseWorkspaceChannel(result.channel) }; break
    case 'navigate': case 'pollView': case 'reportView': case 'viewState': parsed = parseWorkspaceViewState(result); break
    case 'closeView':
      if (result.closed !== true) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
      parsed = { closed: true }; break
    default: throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  }
  return { ok: true, value: parsed as WorkspaceResultMap[Op] }
}
