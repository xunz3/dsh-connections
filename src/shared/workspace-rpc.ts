import { parseId, parseTransportId } from './validation.js'
import { WORKSPACE_PROTOCOL, parseWorkspaceCatalogPage, parseWorkspaceRequest, parseWorkspaceResponse, WorkspaceProtocolError, type WorkspaceCatalog, type WorkspaceCatalogWorkspace, type WorkspaceRequest, type WorkspaceResponse, type WorkspaceResultMap } from './workspace-protocol.js'

export interface WorkspaceCall {
  id: string
  request: WorkspaceRequest
  /** Local-Host precondition; never forwarded to the remote content endpoint. */
  expectedTransportId?: string
}
export interface WorkspaceCallResult { request: WorkspaceRequest; response: WorkspaceResponse }
export interface WorkspaceApi {
  workspace<R extends WorkspaceRequest>(id: string, request: R, expectedTransportId?: string): Promise<WorkspaceResultMap[R['op']]>
}
export interface WorkspaceCatalogSnapshot { revision: string; catalog: WorkspaceCatalog }

/** Publish only complete snapshots; a changed catalog cannot mix pages from different revisions. */
export async function readWorkspaceCatalog(api: WorkspaceApi, id: string, previous?: WorkspaceCatalogSnapshot): Promise<WorkspaceCatalogSnapshot> {
  for (let attempt = 0; ; attempt++) {
    try {
      let page = parseWorkspaceCatalogPage(await api.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL, ...(previous ? { ifRevision: previous.revision } : {}) }))
      if (page.unchanged) {
        if (!previous || page.revision !== previous.revision) throw new TypeError('Invalid workspace catalog revision.')
        return previous
      }
      const revision = page.revision
      const catalog: WorkspaceCatalog = { workspaces: [], sessions: [], archivedSessionIds: [], pinnedSessionIds: [] }
      const workspaces = new Map<string, WorkspaceCatalogWorkspace>()
      let nextPage = 1
      while (true) {
        if (page.revision !== revision || page.unchanged) throw new TypeError('Invalid workspace catalog revision.')
        for (const row of page.workspaces) {
          const existing = workspaces.get(row.id)
          if (existing) {
            if (existing.path !== row.path || existing.title !== row.title) throw new TypeError('Invalid workspace catalog page.')
            for (const sessionId of row.sessionIds) existing.sessionIds.push(sessionId)
          } else {
            const workspace = { ...row, sessionIds: [...row.sessionIds] }
            workspaces.set(row.id, workspace)
            catalog.workspaces.push(workspace)
          }
        }
        for (const row of page.sessions) catalog.sessions.push(row)
        for (const sessionId of page.archivedSessionIds) catalog.archivedSessionIds.push(sessionId)
        for (const sessionId of page.pinnedSessionIds) catalog.pinnedSessionIds.push(sessionId)
        if (!page.nextCursor) return { revision, catalog }
        if (page.nextCursor !== `${revision}.${nextPage++}`) throw new TypeError('Invalid workspace catalog cursor.')
        page = parseWorkspaceCatalogPage(await api.workspace(id, { op: 'catalog', protocol: WORKSPACE_PROTOCOL, cursor: page.nextCursor }))
      }
    } catch (error) {
      // Snapshot eviction or expiry is safe to retry once from the beginning.
      if (attempt === 0 && error && typeof error === 'object' && 'code' in error && error.code === 'CATALOG_EXPIRED') continue
      // An older endpoint may reject the versioned request before advertising compatibility.
      if (error && typeof error === 'object' && 'code' in error && error.code === 'BAD_REQUEST') throw new WorkspaceProtocolError('INCOMPATIBLE_PROTOCOL')
      throw error
    }
  }
}
export function parseWorkspaceCall(value: unknown): WorkspaceCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid workspace request.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['id', 'request', 'expectedTransportId'].includes(key))) throw new TypeError('Invalid workspace request.')
  const id = input.id === 'local' ? 'local' : parseId(input.id)
  if (id === 'local' && input.expectedTransportId !== undefined) throw new TypeError('Invalid workspace transport precondition.')
  return { id, request: parseWorkspaceRequest(input.request),
    ...(input.expectedTransportId === undefined ? {} : { expectedTransportId: parseTransportId(input.expectedTransportId) }) }

}
export function parseWorkspaceCallResult(value: unknown): WorkspaceCallResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid workspace response.')
  const input = value as Record<string, unknown>
  const request = parseWorkspaceRequest(input.request)
  return { request, response: parseWorkspaceResponse(request.op, input.response) }
}
