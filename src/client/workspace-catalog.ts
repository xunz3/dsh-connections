import type { WorkspaceCatalog, WorkspaceCatalogSession, WorkspaceCatalogWorkspace } from '../shared/workspace-protocol.js'

/** A connection owns its native IDs; identical IDs on two computers stay distinct. */
export interface WorkspaceSource {
  id: string
  name: string
  phase: 'connected' | 'connecting' | 'disconnected' | 'error'
  catalog?: WorkspaceCatalog
  /** Authority captured with this catalog, never the transport of a newer list. */
  info?: { transportId?: string }
  /** Catalog availability is independent of transport status. */
  catalogError?: string
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
export interface CatalogSourcePage extends Omit<CatalogSourceRows, 'workspaces'> {
  workspaces: Array<CatalogWorkspaceRow & { sessionCount: number }>
}

/** Bound mounted rows after full-catalog filtering. Selection stays reachable even
 * beyond the current page; explicitly collapsed children consume no render budget. */
export function pageWorkspaceRows(rows: readonly CatalogSourceRows[], {
  limit, collapsed, selected,
}: { limit: number; collapsed: ReadonlySet<string>; selected?: WorkspaceSelection }): { rows: CatalogSourcePage[]; hiddenCount: number } {
  let remaining = Math.max(1, Math.floor(limit))
  let hiddenCount = 0
  const result = rows.map(({ source, workspaces, looseSessions }) => {
    const selection = selected?.sourceId === source.id ? selected : undefined
    const takeSessions = (sessions: CatalogSessionRow[]) => {
      const visible = sessions.slice(0, remaining)
      remaining -= visible.length
      const selectedRow = selection?.sessionId ? sessions.find(row => row.session.id === selection.sessionId) : undefined
      if (selectedRow && !visible.includes(selectedRow)) visible.push(selectedRow)
      hiddenCount += sessions.length - visible.length
      return visible
    }
    const visibleWorkspaces: CatalogSourcePage['workspaces'] = []
    for (const row of workspaces) {
      const expanded = !collapsed.has(row.key)
      const isSelected = selection?.workspaceId === row.workspace.id
        || selection?.sessionId !== undefined && row.sessions.some(item => item.session.id === selection.sessionId)
      if (remaining > 0 || isSelected) {
        remaining = Math.max(0, remaining - 1)
        visibleWorkspaces.push({ ...row, sessionCount: row.sessions.length, sessions: expanded ? takeSessions(row.sessions) : [] })
      } else hiddenCount += 1 + (expanded ? row.sessions.length : 0)
    }
    return { source, workspaces: visibleWorkspaces, looseSessions: takeSessions(looseSessions) }
  })
  return { rows: result, hiddenCount }
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
