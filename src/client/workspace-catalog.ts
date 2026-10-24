import type { WorkspaceCatalog, WorkspaceCatalogSession, WorkspaceCatalogWorkspace } from '../shared/workspace-protocol.js'

/** A connection owns its native IDs; identical IDs on two computers stay distinct. */
export interface WorkspaceSource {
  id: string
  name: string
  phase: 'connected' | 'connecting' | 'disconnected' | 'error'
  catalog?: WorkspaceCatalog
  error?: string
}

export interface WorkspaceSelection {
  sourceId: string
  sessionId?: string
  workspaceId?: string
}

export type WorkspaceFilter = 'active' | 'pinned' | 'archived'
export interface CatalogSessionRow {
  key: string
  session: WorkspaceCatalogSession
  pinned: boolean
  archived: boolean
}
export interface CatalogWorkspaceRow {
  key: string
  workspace: WorkspaceCatalogWorkspace
  sessions: CatalogSessionRow[]
}
export interface CatalogSourceRows {
  source: WorkspaceSource
  workspaces: CatalogWorkspaceRow[]
  looseSessions: CatalogSessionRow[]
}

export function workspaceRowKey(sourceId: string, kind: 'workspace' | 'session', id: string): string {
  return JSON.stringify([sourceId, kind, id])
}

/** Derive presentation only: no local copies of remote workspace or session records. */
export function deriveWorkspaceRows(
  sources: readonly WorkspaceSource[],
  { query = '', filter = 'active', selected }: { query?: string; filter?: WorkspaceFilter; selected?: WorkspaceSelection } = {},
): CatalogSourceRows[] {
  const needle = query.trim().toLocaleLowerCase()
  const matches = (...values: (string | undefined)[]) => values.some(value => value?.toLocaleLowerCase().includes(needle))
  return sources.map(source => {
    const { catalog } = source
    if (!catalog) return { source, workspaces: [], looseSessions: [] }
    const archived = new Set(catalog.archivedSessionIds)
    const pinned = new Set(catalog.pinnedSessionIds)
    const sessions = new Map(catalog.sessions.map(session => [session.id, session]))
    const assigned = new Set(catalog.workspaces.flatMap(workspace => workspace.sessionIds))
    const sessionRows = (ids: readonly string[], parentMatches: boolean) => {
      const rows: CatalogSessionRow[] = []
      for (const id of new Set(ids)) {
        const session = sessions.get(id)
        if (!session || session.origin === 'subagent') continue
        if (session.blank && (needle !== '' || filter !== 'active' || selected?.sourceId !== source.id || selected.sessionId !== id)) continue
        const isArchived = archived.has(id)
        if (filter === 'archived' ? !isArchived : isArchived || (filter === 'pinned' && !pinned.has(id))) continue
        if (needle && !parentMatches && !matches(session.title)) continue
        rows.push({ key: workspaceRowKey(source.id, 'session', id), session, pinned: !isArchived && pinned.has(id), archived: isArchived })
      }
      // Keep native manual order inside each section, including archived rows.
      return [...rows.filter(row => row.session.blank), ...rows.filter(row => !row.session.blank && row.pinned), ...rows.filter(row => !row.session.blank && !row.pinned)]
    }
    const workspaces = catalog.workspaces.flatMap(workspace => {
      const parentMatches = matches(source.name, workspace.title, workspace.path)
      const rows = sessionRows(workspace.sessionIds, parentMatches)
      if ((filter !== 'active' && rows.length === 0) || (needle && !parentMatches && rows.length === 0)) return []
      return [{ key: workspaceRowKey(source.id, 'workspace', workspace.id), workspace, sessions: rows }]
    })
    return { source, workspaces, looseSessions: sessionRows(catalog.sessions.filter(session => !assigned.has(session.id)).map(session => session.id), matches(source.name)) }
  })
}
