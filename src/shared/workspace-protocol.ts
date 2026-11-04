import { parseConnectionContracts, type ConnectionContracts } from './contracts.js'
import { parseLocalPresentation, parseLoginAction, parseSurfaceSnapshot, parseSurfaceActionResult, type LocalPresentation, type LoginAction, type SurfaceSnapshot, type SurfaceActionResult, type SurfaceRequest, type SurfaceAck } from './view-surface-protocol.js'
import { parseSettingsHostExchange, parseSettingsHostId, parseSettingsHostSnapshot, type SettingsHostExchange, type SettingsHostSnapshot } from './settings-host-protocol.js'

/** Small owner-only catalog and navigation seam; conversation data stays in Harness. */
export const WORKSPACE_ROUTE = '/connections/workspaces'
export const WORKSPACE_ENDPOINT = `/api${WORKSPACE_ROUTE}`
/** Includes at most 101 settings menu entries; other request shapes retain their field limits. */
export const WORKSPACE_REQUEST_LIMIT = 128 * 1024
export const WORKSPACE_RESPONSE_LIMIT = 4 * 1024 * 1024
/** v3 adds parent-owned presentation and acknowledged login browser capabilities. */
export const WORKSPACE_PROTOCOL = 3
/** Pages stay well below the transport limit, including deeply populated workspaces. */
export const WORKSPACE_CATALOG_PAGE_LIMIT = 256 * 1024

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
export interface WorkspaceCatalogPage extends WorkspaceCatalog {
  protocol: typeof WORKSPACE_PROTOCOL
  revision: string
  /** An unchanged catalog has empty arrays and no continuation. */
  unchanged?: true
  nextCursor?: string
}
export type WorkspaceNavigationTarget =
  | { kind: 'session' | 'workspace'; id: string }
  | { kind: 'newSession'; id?: string }
  | { kind: 'pick' | 'settings' | 'plugins' }
export interface WorkspaceViewIntent {
  revision: number
  requestId: string
  target: WorkspaceNavigationTarget
}
export type WorkspaceNavigationError = 'NAVIGATION_FAILED' | 'PICK_CANCELLED' | 'SETTINGS_CLOSED'
export interface WorkspaceViewState {
  /** Increments only when a new navigation request is accepted. */
  revision: number
  /** Last navigation acknowledged by the native remote document. */
  reportedRevision: number
  /** Last navigation whose native content or directory picker is visible. */
  presentedRevision: number
  intent?: WorkspaceViewIntent
  sessionId?: string
  error?: WorkspaceNavigationError
}
export type WorkspaceRequest =
  | { op: 'catalog'; protocol: typeof WORKSPACE_PROTOCOL; ifRevision?: string; cursor?: string }
  | { op: 'renameWorkspace'; id: string; title: string }
  | { op: 'forgetWorkspace'; id: string }
  | { op: 'renameSession'; id: string; title: string }
  | { op: 'archiveSession'; id: string; archived: boolean; stopActivity?: true }
  | { op: 'pinSession'; id: string; pinned: boolean }
  | { op: 'openView'; protocol: typeof WORKSPACE_PROTOCOL; clientId: string; contracts?: ConnectionContracts; presentation?: LocalPresentation }
  | { op: 'navigate'; channel: string; requestId: string; target: WorkspaceNavigationTarget }
  | { op: 'pollView'; channel: string; afterRevision: number }
  | { op: 'reportView'; channel: string; revision: number; presented?: true; sessionId?: string; error?: WorkspaceNavigationError }
  | { op: 'viewState'; channel: string }
  | { op: 'publishSettingsHosts'; channel: string; revision: number; snapshot: SettingsHostSnapshot }
  | { op: 'pollSettingsHosts'; channel: string; revision: number }
  | { op: 'selectSettingsHost'; channel: string; revision: number; id: string }
  | { op: 'surfaceSnapshot'; channel: string }
  | { op: 'syncSurface'; channel: string; presentation: LocalPresentation; acknowledgements: SurfaceAck[] }
  | { op: 'requestSurface'; channel: string; revision: number; id: string; action: LoginAction }
  | { op: 'cancelSurface'; channel: string; id: string }
  | { op: 'closeView'; channel: string }

export interface WorkspaceResultMap {
  catalog: WorkspaceCatalogPage
  renameWorkspace: { done: true }
  forgetWorkspace: { done: true }
  renameSession: { done: true }
  archiveSession: { done: true }
  pinSession: { done: true }
  openView: WorkspaceViewState & { channel: string; protocol: typeof WORKSPACE_PROTOCOL; contracts?: ConnectionContracts }
  navigate: WorkspaceViewState
  pollView: WorkspaceViewState
  reportView: WorkspaceViewState
  viewState: WorkspaceViewState
  publishSettingsHosts: SettingsHostExchange
  pollSettingsHosts: SettingsHostExchange
  selectSettingsHost: SettingsHostExchange
  surfaceSnapshot: SurfaceSnapshot
  syncSurface: { requests: SurfaceRequest[] }
  requestSurface: SurfaceActionResult
  cancelSurface: { done: true }
  closeView: { closed: true }
}
export type WorkspaceOperation = WorkspaceRequest['op']
export type WorkspaceResult = WorkspaceResultMap[WorkspaceOperation]
const operations: readonly WorkspaceOperation[] = [
  'catalog', 'renameWorkspace', 'forgetWorkspace',
  'renameSession', 'archiveSession', 'pinSession', 'openView', 'navigate', 'pollView', 'reportView', 'viewState', 'closeView',
  'publishSettingsHosts', 'pollSettingsHosts', 'selectSettingsHost',
  'surfaceSnapshot', 'syncSurface', 'requestSurface', 'cancelSurface',
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
  INCOMPATIBLE_PROTOCOL: 'The Connections plugin versions are incompatible. Update Connections on both the local and remote Hosts.',
  CATALOG_EXPIRED: 'The workspace catalog changed while loading. Refresh it and try again.',
  CANCELLED: 'The workspace request was cancelled.',
  FAILED: 'The workspace operation failed.',
} as const
export type WorkspaceErrorCode = keyof typeof WORKSPACE_ERRORS
export class WorkspaceProtocolError extends Error {
  constructor(readonly code: WorkspaceErrorCode) { super(WORKSPACE_ERRORS[code]) }
}
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
/** Filesystem metadata is not a title: JSON safely preserves legal control characters.
 * Deep cwd values can exceed PATH_MAX; the containing page supplies the wire-size bound. */
function filesystemPath(value: unknown, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > WORKSPACE_CATALOG_PAGE_LIMIT || value.includes('\0')) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
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
function catalogRevision(value: unknown): string {
  const result = text(value, 43)
  if (!/^[A-Za-z0-9_-]{43}$/.test(result)) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  return result
}
function catalogCursor(value: unknown): string {
  const result = text(value, 64)
  if (!/^[A-Za-z0-9_-]{43}\.[1-9][0-9]{0,8}$/.test(result)) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  return result
}
function protocol(value: unknown): typeof WORKSPACE_PROTOCOL {
  if (value !== WORKSPACE_PROTOCOL) throw new WorkspaceProtocolError('INCOMPATIBLE_PROTOCOL')
  return WORKSPACE_PROTOCOL
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  return value
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
}
function navigationError(value: unknown): WorkspaceNavigationError {
  if (value !== 'NAVIGATION_FAILED' && value !== 'PICK_CANCELLED' && value !== 'SETTINGS_CLOSED') throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  return value
}
export function parseWorkspaceTarget(value: unknown): WorkspaceNavigationTarget {
  const target = object(value)
  if (target.kind === 'pick' || target.kind === 'settings' || target.kind === 'plugins') { keys(target, ['kind']); return { kind: target.kind } }
  if (target.kind === 'newSession') {
    keys(target, ['kind', 'id'])
    return { kind: 'newSession', ...(target.id === undefined ? {} : { id: parseWorkspaceId(target.id) }) }
  }
  if (target.kind !== 'session' && target.kind !== 'workspace') throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  keys(target, ['kind', 'id'])
  return { kind: target.kind, id: parseWorkspaceId(target.id) }
}

/** Reject unknown fields so credentials and unrelated native commands never enter this seam. */
export function parseWorkspaceRequest(value: unknown): WorkspaceRequest {
  const input = object(value)
  const op = input.op
  switch (op) {
    case 'catalog':
      keys(input, ['op', 'protocol', 'ifRevision', 'cursor'])
      if (input.ifRevision !== undefined && input.cursor !== undefined) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
      return { op, protocol: protocol(input.protocol),
        ...(input.ifRevision === undefined ? {} : { ifRevision: catalogRevision(input.ifRevision) }),
        ...(input.cursor === undefined ? {} : { cursor: catalogCursor(input.cursor) }),
      }
    case 'openView':
      keys(input, ['op', 'protocol', 'clientId', 'contracts', 'presentation'])
      return { op, protocol: protocol(input.protocol), clientId: parseWorkspaceId(input.clientId),
        ...(input.contracts === undefined ? {} : { contracts: parseConnectionContracts(input.contracts) }),
        ...(input.presentation === undefined ? {} : { presentation: parseLocalPresentation(input.presentation) }),
      }
    case 'renameWorkspace': case 'renameSession':
      keys(input, ['op', 'id', 'title'])
      return { op, id: parseWorkspaceId(input.id), title: text(input.title, 512).trim() }
    case 'forgetWorkspace': keys(input, ['op', 'id']); return { op, id: parseWorkspaceId(input.id) }
    case 'archiveSession': {
      keys(input, ['op', 'id', 'archived', 'stopActivity'])
      const archived = boolean(input.archived)
      if (input.stopActivity !== undefined && (input.stopActivity !== true || !archived)) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
      return { op, id: parseWorkspaceId(input.id), archived, ...(input.stopActivity === true ? { stopActivity: true } : {}) }
    }
    case 'pinSession':
      keys(input, ['op', 'id', 'pinned']); return { op, id: parseWorkspaceId(input.id), pinned: boolean(input.pinned) }
    case 'navigate':
      keys(input, ['op', 'channel', 'requestId', 'target'])
      return { op, channel: parseWorkspaceChannel(input.channel), requestId: parseWorkspaceId(input.requestId), target: parseWorkspaceTarget(input.target) }
    case 'pollView':
      keys(input, ['op', 'channel', 'afterRevision'])
      return { op, channel: parseWorkspaceChannel(input.channel), afterRevision: revision(input.afterRevision) }
    case 'reportView':
      keys(input, ['op', 'channel', 'revision', 'presented', 'sessionId', 'error'])
      if (input.presented !== undefined && input.presented !== true) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
      if (input.presented === true && (input.sessionId !== undefined || input.error !== undefined)) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
      return {
        op, channel: parseWorkspaceChannel(input.channel), revision: revision(input.revision),
        ...(input.presented === undefined ? {} : { presented: true }),
        ...(input.sessionId === undefined ? {} : { sessionId: parseWorkspaceId(input.sessionId) }),
        ...(input.error === undefined ? {} : { error: navigationError(input.error) }),
      }
    case 'syncSurface': {
      keys(input, ['op', 'channel', 'presentation', 'acknowledgements'])
      if (!Array.isArray(input.acknowledgements) || input.acknowledgements.length > 8) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
      return { op, channel: parseWorkspaceChannel(input.channel), presentation: parseLocalPresentation(input.presentation), acknowledgements: input.acknowledgements.map(value => { const ack = object(value); keys(ack, ['id', 'ok']); return { id: parseWorkspaceId(ack.id), ok: boolean(ack.ok) } }) }
    }
    case 'requestSurface':
      keys(input, ['op', 'channel', 'revision', 'id', 'action'])
      return { op, channel: parseWorkspaceChannel(input.channel), revision: revision(input.revision), id: parseWorkspaceId(input.id), action: parseLoginAction(input.action) }
    case 'cancelSurface':
      keys(input, ['op', 'channel', 'id']); return { op, channel: parseWorkspaceChannel(input.channel), id: parseWorkspaceId(input.id) }
    case 'surfaceSnapshot': case 'viewState': case 'closeView': keys(input, ['op', 'channel']); return { op, channel: parseWorkspaceChannel(input.channel) }
    case 'publishSettingsHosts':
      keys(input, ['op', 'channel', 'revision', 'snapshot'])
      return { op, channel: parseWorkspaceChannel(input.channel), revision: revision(input.revision), snapshot: parseSettingsHostSnapshot(input.snapshot) }
    case 'pollSettingsHosts':
      keys(input, ['op', 'channel', 'revision'])
      return { op, channel: parseWorkspaceChannel(input.channel), revision: revision(input.revision) }
    case 'selectSettingsHost':
      keys(input, ['op', 'channel', 'revision', 'id'])
      return { op, channel: parseWorkspaceChannel(input.channel), revision: revision(input.revision), id: parseSettingsHostId(input.id) }
    default: throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  }
}

function array<T>(value: unknown, parse: (value: unknown) => T, max = 20_000): T[] {
  if (!Array.isArray(value) || value.length > max) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  return value.map(parse)
}
function workspace(value: unknown): WorkspaceCatalogWorkspace {
  const row = object(value)
  return { id: parseWorkspaceId(row.id), path: filesystemPath(row.path), title: text(row.title, 512, true), sessionIds: array(row.sessionIds, parseWorkspaceId) }
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
        ...(row.cwd === undefined ? {} : { cwd: filesystemPath(row.cwd, true) }),
        ...(row.origin === undefined ? {} : { origin: 'subagent' as const }),
        ...(row.parentSessionId === undefined ? {} : { parentSessionId: parseWorkspaceId(row.parentSessionId) }),
      }
    }),
    archivedSessionIds: array(catalog.archivedSessionIds, parseWorkspaceId),
    pinnedSessionIds: array(catalog.pinnedSessionIds, parseWorkspaceId),
  }
}
export function parseWorkspaceCatalogPage(value: unknown): WorkspaceCatalogPage {
  const page = object(value)
  const version = protocol(page.protocol)
  const result: WorkspaceCatalogPage = {
    ...parseWorkspaceCatalog(page), protocol: version, revision: catalogRevision(page.revision),
    ...(page.nextCursor === undefined ? {} : { nextCursor: catalogCursor(page.nextCursor) }),
  }
  if (result.nextCursor !== undefined && !result.nextCursor.startsWith(`${result.revision}.`)) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  if (page.unchanged !== undefined) {
    if (page.unchanged !== true || result.nextCursor !== undefined || result.workspaces.length || result.sessions.length
      || result.archivedSessionIds.length || result.pinnedSessionIds.length) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
    result.unchanged = true
  }
  return result
}
export function parseWorkspaceViewState(value: unknown): WorkspaceViewState {
  const state = object(value)
  // v1 bundles could acknowledge selection without ever presenting native content.
  // Reject them immediately instead of leaving the parent waiting for a timeout.
  if (state.presentedRevision === undefined) throw new WorkspaceProtocolError('INCOMPATIBLE_PROTOCOL')
  const intent = state.intent === undefined ? undefined : object(state.intent)
  const result: WorkspaceViewState = {
    revision: revision(state.revision), reportedRevision: revision(state.reportedRevision),
    presentedRevision: revision(state.presentedRevision),
    ...(intent === undefined ? {} : { intent: { revision: revision(intent.revision), requestId: parseWorkspaceId(intent.requestId), target: parseWorkspaceTarget(intent.target) } }),
    ...(state.sessionId === undefined ? {} : { sessionId: parseWorkspaceId(state.sessionId) }),
    ...(state.error === undefined ? {} : { error: navigationError(state.error) }),
  }
  if (result.reportedRevision > result.revision || result.presentedRevision > result.revision
    || (result.intent !== undefined && result.intent.revision !== result.revision)) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
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
    case 'catalog': parsed = parseWorkspaceCatalogPage(result); break
    case 'cancelSurface': case 'renameWorkspace': case 'forgetWorkspace': case 'renameSession': case 'archiveSession': case 'pinSession':
      if (result.done !== true) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
      parsed = { done: true }; break
    case 'openView': {
      const version = protocol(result.protocol)
      parsed = { ...parseWorkspaceViewState(result), channel: parseWorkspaceChannel(result.channel), protocol: version,
        ...(result.contracts === undefined ? {} : { contracts: parseConnectionContracts(result.contracts) }),
      }; break
    }
    case 'navigate': case 'pollView': case 'reportView': case 'viewState': parsed = parseWorkspaceViewState(result); break
    case 'publishSettingsHosts': case 'pollSettingsHosts': case 'selectSettingsHost': parsed = parseSettingsHostExchange(result); break
    case 'surfaceSnapshot': parsed = parseSurfaceSnapshot(result); break
    case 'requestSurface': parsed = parseSurfaceActionResult(result); break
    case 'syncSurface':
      if (!Array.isArray(result.requests) || result.requests.length > 8) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
      parsed = { requests: result.requests.map(value => { const request = object(value); return { id: parseWorkspaceId(request.id), revision: revision(request.revision), action: parseLoginAction(request.action) } }) }; break
    case 'closeView':
      if (result.closed !== true) throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
      parsed = { closed: true }; break
    default: throw new TypeError(WORKSPACE_ERRORS.BAD_REQUEST)
  }
  return { ok: true, value: parsed as WorkspaceResultMap[Op] }
}
