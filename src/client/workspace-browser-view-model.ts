import { deriveWorkspaceRows, pageWorkspaceRows, workspaceRowKey, type CatalogSourcePage, type WorkspaceFilter, type WorkspaceSelection, type WorkspaceSource } from './workspace-catalog.js'

export type Action = void | Promise<unknown>

/** The controller remains the owner of catalogs, navigation and native operations. */
export interface WorkspaceBrowserModel {
  /** Immutable publications: replace changed source/catalog records on refresh. */
  sources: readonly WorkspaceSource[]
  selected?: WorkspaceSelection
  onOpenSession(sourceId: string, sessionId: string): Action
  onOpenWorkspace(sourceId: string, workspaceId: string): Action
  onNewSession(sourceId: string, workspaceId: string): Action
  onAddWorkspace(): Action
  onReconnect(sourceId: string): Action
  onRenameWorkspace(sourceId: string, workspaceId: string, title: string): Action
  onForgetWorkspace(sourceId: string, workspaceId: string): Action
  onRenameSession(sourceId: string, sessionId: string, title: string): Action
  onArchiveSession(sourceId: string, sessionId: string, archived: boolean): Action
  onPinSession(sourceId: string, sessionId: string, pinned: boolean): Action
}

export interface WorkspaceBrowserSnapshot {
  readonly selected?: WorkspaceSelection
  readonly query: string
  readonly searchOpen: boolean
  readonly filter: WorkspaceFilter
  readonly collapsed: ReadonlySet<string>
  readonly editing?: string
  readonly forgetting?: string
  readonly pending: ReadonlySet<string>
  readonly error?: unknown
  readonly rows: CatalogSourcePage[]
  readonly hiddenCount: number
  readonly totalCount: number
}

export const WORKSPACE_ADD_KEY = 'add'
export const workspaceReconnectKey = (sourceId: string): string => JSON.stringify([sourceId, 'connection'])
type RowTarget = { sourceId: string; kind: 'workspace' | 'session'; id: string }
type Target = RowTarget | { sourceId: string; kind: 'connection' }
interface Operation {
  target?: Target
  lifetime: number
  sequence: number
  promise: Promise<void>
}
function rowTarget(key: string): RowTarget | undefined {
  try {
    const value: unknown = JSON.parse(key)
    if (Array.isArray(value) && value.length === 3 && typeof value[0] === 'string'
      && (value[1] === 'workspace' || value[1] === 'session') && typeof value[2] === 'string') {
      return { sourceId: value[0], kind: value[1], id: value[2] }
    }
  } catch { /* Ignore obsolete or foreign row keys. */ }
  return undefined
}

function sameSources(a: readonly WorkspaceSource[], b: readonly WorkspaceSource[]): boolean {
  return a === b || a.length === b.length && a.every((source, index) => {
    const other = b[index]
    return source.id === other.id && source.name === other.name && source.phase === other.phase
      && source.catalog === other.catalog && source.catalogError === other.catalogError
  })
}

function sameSelection(a?: WorkspaceSelection, b?: WorkspaceSelection): boolean {
  return a?.sourceId === b?.sourceId && a?.sessionId === b?.sessionId && a?.workspaceId === b?.workspaceId
}

/** Headless interaction state. No catalog copies, native IDs or transport ownership
 * are introduced here; React owns focus, open menus and unsaved text fields. */
export class WorkspaceBrowserViewModel {
  private model: WorkspaceBrowserModel
  private snapshot!: WorkspaceBrowserSnapshot
  private listeners = new Set<() => void>()
  private operations = new Map<string, Operation>()
  private disposed = false
  private lifetime = 0
  private sequence = 0
  private errorSequence = 0
  private dismissedThroughSequence = 0
  private query = ''
  private searchOpen = false
  private filter: WorkspaceFilter = 'active'
  private collapsed = new Set<string>()
  private searchCollapsed = new Set<string>()
  private editing?: string
  private forgetting?: string
  private editGeneration = 0
  private forgetGeneration = 0
  private error?: unknown
  private rowLimit = 100
  private selected?: WorkspaceSelection
  private selectedParent?: string
  private derived?: {
    sources: readonly WorkspaceSource[]
    selected?: WorkspaceSelection
    query: string
    filter: WorkspaceFilter
    rows: ReturnType<typeof deriveWorkspaceRows>
  }

  constructor(model: WorkspaceBrowserModel) {
    this.model = model
    this.reconcileSelection()
    this.publish()
  }

  getSnapshot = (): WorkspaceBrowserSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** React may replay mount effects in StrictMode. Old promises remain invalid. */
  activate(): void { this.disposed = false }
  dispose(): void {
    this.disposed = true
    this.lifetime++
    this.operations.clear()
    this.listeners.clear()
    this.publish()
  }

  update(model: WorkspaceBrowserModel): void {
    const changed = !sameSources(this.model.sources, model.sources) || !sameSelection(this.selected, model.selected)
    this.model = model
    if (!changed) return
    this.reconcileSelection()
    if (this.editing && !this.exists(rowTarget(this.editing))) { this.editing = undefined; this.editGeneration++ }
    if (this.forgetting && !this.exists(rowTarget(this.forgetting))) { this.forgetting = undefined; this.forgetGeneration++ }
    this.collapsed = new Set([...this.collapsed].filter(key => this.exists(rowTarget(key))))
    this.searchCollapsed = new Set([...this.searchCollapsed].filter(key => this.exists(rowTarget(key))))
    for (const [key, operation] of this.operations) {
      if (operation.target && !this.exists(operation.target)) this.operations.delete(key)
    }
    this.publish()
  }

  setQuery(query: string): void {
    if (this.disposed || this.query === query) return
    this.query = query
    this.searchCollapsed.clear()
    this.rowLimit = 100
    this.publish()
  }
  setSearchOpen(open: boolean): void {
    if (this.disposed || this.searchOpen === open && (open || !this.query)) return
    this.searchOpen = open
    if (!open) { this.query = ''; this.searchCollapsed.clear(); this.rowLimit = 100 }
    this.publish()
  }
  setFilter(filter: WorkspaceFilter): void {
    if (this.disposed || this.filter === filter) return
    this.filter = filter
    this.rowLimit = 100
    this.publish()
  }
  toggleWorkspace(key: string): void {
    const target = rowTarget(key)
    if (this.disposed || target?.kind !== 'workspace' || !this.exists(target)) return
    const collapsed = this.query.trim() ? this.searchCollapsed : this.collapsed
    if (collapsed.has(key)) collapsed.delete(key)
    else collapsed.add(key)
    this.publish()
  }
  showMore(): void {
    if (this.disposed || !this.snapshot.hiddenCount) return
    this.rowLimit += 100
    this.publish()
  }
  edit(key: string | undefined): void {
    if (this.disposed || key !== undefined && !this.canMutate(rowTarget(key))) return
    this.editing = key
    this.editGeneration++
    this.publish()
  }
  confirmForget(key: string | undefined): void {
    const target = key === undefined ? undefined : rowTarget(key)
    if (this.disposed || key !== undefined && (target?.kind !== 'workspace' || !this.canMutate(target))) return
    this.forgetting = key
    this.forgetGeneration++
    this.publish()
  }
  dismissError(): void {
    if (this.disposed) return
    this.dismissedThroughSequence = this.sequence
    this.error = undefined
    this.publish()
  }

  openSession(sourceId: string, id: string): Promise<void> {
    const source = this.source(sourceId)
    if (source?.catalog?.archivedSessionIds.includes(id)) return Promise.resolve()
    return this.runRow({ sourceId, kind: 'session', id }, false, () => this.model.onOpenSession(sourceId, id))
  }
  openWorkspace(sourceId: string, id: string): Promise<void> {
    return this.runRow({ sourceId, kind: 'workspace', id }, false, () => this.model.onOpenWorkspace(sourceId, id))
  }
  newSession(sourceId: string, id: string): Promise<void> {
    return this.runRow({ sourceId, kind: 'workspace', id }, true, () => this.model.onNewSession(sourceId, id))
  }
  addWorkspace(): Promise<void> { return this.run(WORKSPACE_ADD_KEY, undefined, () => this.model.onAddWorkspace()) }
  reconnect(sourceId: string): Promise<void> {
    const target: Target = { sourceId, kind: 'connection' }
    if (!this.exists(target)) return Promise.resolve()
    return this.run(workspaceReconnectKey(sourceId), target, () => this.model.onReconnect(sourceId))
  }
  renameSession(sourceId: string, id: string, title: string): Promise<void> {
    return this.rename({ sourceId, kind: 'session', id }, title, () => this.model.onRenameSession(sourceId, id, title.trim()))
  }
  renameWorkspace(sourceId: string, id: string, title: string): Promise<void> {
    return this.rename({ sourceId, kind: 'workspace', id }, title, () => this.model.onRenameWorkspace(sourceId, id, title.trim()))
  }
  forgetWorkspace(sourceId: string, id: string): Promise<void> {
    const key = workspaceRowKey(sourceId, 'workspace', id)
    const generation = this.forgetGeneration
    return this.runRow({ sourceId, kind: 'workspace', id }, true, () => this.model.onForgetWorkspace(sourceId, id), () => {
      if (this.forgetting === key && this.forgetGeneration === generation) { this.forgetting = undefined; this.forgetGeneration++ }
    })
  }
  pinSession(sourceId: string, id: string, pinned: boolean): Promise<void> {
    return this.runRow({ sourceId, kind: 'session', id }, true, () => this.model.onPinSession(sourceId, id, pinned))
  }
  archiveSession(sourceId: string, id: string, archived: boolean): Promise<void> {
    return this.runRow({ sourceId, kind: 'session', id }, true, () => this.model.onArchiveSession(sourceId, id, archived))
  }

  private source(id: string): WorkspaceSource | undefined { return this.model.sources.find(source => source.id === id) }
  private exists(target?: Target): boolean {
    if (!target) return false
    const source = this.source(target.sourceId)
    if (!source) return false
    if (target.kind === 'connection') return true
    return (target.kind === 'workspace' ? source.catalog?.workspaces : source.catalog?.sessions)?.some(row => row.id === target.id) ?? false
  }
  private canMutate(target?: RowTarget): boolean {
    return !!target && this.exists(target) && this.source(target.sourceId)?.phase === 'connected'
  }
  private rename(target: RowTarget, title: string, action: () => Action): Promise<void> {
    if (!title.trim()) return Promise.resolve()
    const key = workspaceRowKey(target.sourceId, target.kind, target.id)
    const generation = this.editGeneration
    return this.runRow(target, true, action, () => {
      if (this.editing === key && this.editGeneration === generation) { this.editing = undefined; this.editGeneration++ }
    })
  }
  private runRow(target: RowTarget, mutation: boolean, action: () => Action, done?: () => void): Promise<void> {
    if (mutation ? !this.canMutate(target) : !this.exists(target)) return Promise.resolve()
    return this.run(workspaceRowKey(target.sourceId, target.kind, target.id), target, action, done)
  }
  private run(key: string, target: Target | undefined, action: () => Action, done?: () => void): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const existing = this.operations.get(key)
    if (existing) return existing.promise
    let finish!: () => void
    const operation: Operation = { target, lifetime: this.lifetime, sequence: ++this.sequence, promise: new Promise(resolve => { finish = resolve }) }
    this.operations.set(key, operation)
    this.error = undefined
    this.publish()
    const current = () => !this.disposed && operation.lifetime === this.lifetime && this.operations.get(key) === operation
    void (async () => {
      try {
        await action()
        if (current()) done?.()
      } catch (cause) {
        // Successful navigation on another host must not hide a pending rename
        // failure. Only explicit dismissal or a newer reported failure wins.
        if (current() && operation.sequence > this.dismissedThroughSequence && operation.sequence >= this.errorSequence) {
          this.error = cause ?? null
          this.errorSequence = operation.sequence
        }
      } finally {
        if (current()) { this.operations.delete(key); this.publish() }
        finish()
      }
    })()
    return operation.promise
  }

  private reconcileSelection(): void {
    if (!sameSelection(this.selected, this.model.selected)) this.selectedParent = undefined
    this.selected = this.model.selected ? { ...this.model.selected } : undefined
    const selection = this.selected
    const workspace = selection && this.source(selection.sourceId)?.catalog?.workspaces.find(workspace =>
      selection.sessionId ? workspace.sessionIds.includes(selection.sessionId) : workspace.id === selection.workspaceId)
    const parent = workspace && selection ? workspaceRowKey(selection.sourceId, 'workspace', workspace.id) : undefined
    // A selection can arrive before its catalog; open its parent when it resolves.
    if (parent && parent !== this.selectedParent) { this.collapsed.delete(parent); this.searchCollapsed.delete(parent) }
    this.selectedParent = parent
  }
  private publish(): void {
    const previous = this.derived
    if (!previous || !sameSources(previous.sources, this.model.sources) || !sameSelection(previous.selected, this.selected)
      || previous.query !== this.query || previous.filter !== this.filter) {
      this.derived = {
        sources: this.model.sources, selected: this.selected, query: this.query, filter: this.filter,
        rows: deriveWorkspaceRows(this.model.sources, { query: this.query, filter: this.filter, selected: this.selected }),
      }
    }
    const rows = this.derived!.rows
    const collapsed = new Set(this.query.trim() ? this.searchCollapsed : this.collapsed)
    const page = pageWorkspaceRows(rows, { limit: this.rowLimit, collapsed, selected: this.selected })
    this.snapshot = {
      selected: this.selected, query: this.query, searchOpen: this.searchOpen, filter: this.filter,
      collapsed, editing: this.editing, forgetting: this.forgetting, error: this.error,
      pending: new Set(this.operations.keys()), ...page,
      totalCount: rows.reduce((count, source) => count + source.looseSessions.length + source.workspaces.reduce((count, workspace) => count + 1 + workspace.sessions.length, 0), 0),
    }
    if (!this.disposed) for (const listener of this.listeners) listener()
  }
}
