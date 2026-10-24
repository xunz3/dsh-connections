import type { ConnectionsApi, ConnectionView } from '../shared/types.js'
import type { WorkspaceApi } from '../shared/workspace-rpc.js'
import { parseWorkspaceId, type WorkspaceNavigationTarget, type WorkspaceRequest } from '../shared/workspace-protocol.js'
import type { WorkspaceSelection, WorkspaceSource } from './workspace-catalog.js'
import { parseId, parseOpenResult } from '../shared/validation.js'

export interface WorkspaceState {
  id: string
  name: string
  phase: 'connecting' | 'ready' | 'error'
  url?: string
  channel?: string
  revision?: number
  presented?: boolean
  error?: 'failed' | 'unavailable' | 'disconnected' | 'pluginRequired' | 'timeout'
}
export interface WorkspaceOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  prepareUrl?: (url: string) => string
  localNavigate?: (target: WorkspaceNavigationTarget) => void | Promise<void>
  presentationTimeoutMs?: number
}
const STORAGE_KEY = '@xunz/dsh-connections/selection'
const LEGACY_KEY = '@xunz/dsh-connections/selected'
type Api = Pick<ConnectionsApi, 'list' | 'connect' | 'open'> & WorkspaceApi
interface CatalogState { sources: WorkspaceSource[]; selected: WorkspaceSelection }
const sameDestination = (left: ConnectionView | undefined, right: ConnectionView) => left?.id === right.id
  && left.target === right.target && left.mode === right.mode && left.remotePort === right.remotePort
const sameAuthority = (left: ConnectionView | undefined, right: ConnectionView) => sameDestination(left, right)
  && left?.localPort === right.localPort && right.phase === 'connected'
const selectionTarget = (selected: WorkspaceSelection): WorkspaceNavigationTarget | undefined => selected.sessionId
  ? { kind: 'session', id: selected.sessionId } : selected.workspaceId ? { kind: 'workspace', id: selected.workspaceId } : undefined

/** Remote identities stay on their native host. Only catalogs and current selection are held here. */
export class WorkspaceController {
  private state: WorkspaceState | undefined
  private catalogs: CatalogState = { sources: [{ id: 'local', name: '', phase: 'connected' }], selected: { sourceId: 'local' } }
  private rows: ConnectionView[] = []
  private version = 0
  private disposed = false
  private started = false
  private navigating?: number
  private restoring?: number
  private destination?: ConnectionView
  private pickFallback?: WorkspaceSelection
  private refreshing?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private presentationTimer?: ReturnType<typeof setTimeout>
  private presentationDeadline?: ReturnType<typeof setTimeout>
  private target?: WorkspaceNavigationTarget
  private readonly listeners = new Set<() => void>()
  readonly getSnapshot = () => this.state
  readonly getCatalogs = () => this.catalogs
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  constructor(readonly api: Api, private readonly options: WorkspaceOptions = {}) {}
  private emit() { if (!this.disposed) for (const listener of this.listeners) listener() }
  private publish(state: WorkspaceState | undefined) { this.state = state; this.emit() }
  private select(selected: WorkspaceSelection, persist = true) {
    const current = this.catalogs.selected
    if (current.sourceId === selected.sourceId && current.sessionId === selected.sessionId && current.workspaceId === selected.workspaceId) return
    this.catalogs = { ...this.catalogs, selected }; if (persist) this.remember(selected); this.emit()
  }
  private remember(selected: WorkspaceSelection) {
    try {
      this.options.storage?.removeItem(LEGACY_KEY)
      if (selected.sourceId === 'local') this.options.storage?.removeItem(STORAGE_KEY)
      else this.options.storage?.setItem(STORAGE_KEY, JSON.stringify(selected))
    } catch { /* Optional preference, never a credential or mirrored session. */ }
  }
  async restore(): Promise<void> {
    const version = this.version
    this.restoring = version
    try {
      // Native local-session restoration can arrive while catalog requests are pending.
      // Capture the preference first; only explicit navigation may supersede it.
      const saved = this.options.storage?.getItem(STORAGE_KEY)
      const legacy = this.options.storage?.getItem(LEGACY_KEY)
      const selected: WorkspaceSelection | undefined = saved ? JSON.parse(saved) : legacy ? { sourceId: legacy } : undefined
      if (!selected) { if (saved || legacy) this.remember({ sourceId: 'local' }); return }
      parseId(selected.sourceId)
      if (selected.sessionId !== undefined) parseWorkspaceId(selected.sessionId)
      if (selected.workspaceId !== undefined) parseWorkspaceId(selected.workspaceId)
      if (selected.sessionId !== undefined && selected.workspaceId !== undefined) throw new Error('invalid-selection')
      await this.refresh()
      if (this.disposed || version !== this.version) return
      const row = this.rows.find(row => row.id === selected.sourceId)
      if (!row) { this.remember({ sourceId: 'local' }); return }
      if (row.autoConnect === false && row.phase !== 'connected') return
      await this.open(selected.sourceId, selectionTarget(selected))
    } catch { if (!this.disposed && version === this.version) this.remember({ sourceId: 'local' }) }
    finally { if (this.restoring === version) this.restoring = undefined }
  }
  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    const tick = async () => { await this.refresh(); if (!this.disposed) this.timer = setTimeout(tick, 2500) }
    void tick()
  }
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return this.refreshing ??= this.readCatalogs().finally(() => { this.refreshing = undefined })
  }
  private async readCatalogs(): Promise<void> {
    try {
      const rows = await this.api.list()
      if (this.disposed) return
      const old = new Map(this.catalogs.sources.map(source => [source.id, source]))
      const previous = new Map(this.rows.map(row => [row.id, row]))
      this.rows = rows
      const sources: WorkspaceSource[] = [{ ...old.get('local'), id: 'local', name: '', phase: 'connected' }, ...rows.map(row => ({
        ...(sameDestination(previous.get(row.id), row) ? old.get(row.id) : {}),
        id: row.id, name: row.name, phase: row.phase === 'updating' ? 'connecting' as const : row.phase,
      }))]
      this.catalogs = { ...this.catalogs, sources }
      this.emit()
      await Promise.all(sources.map(async source => {
        if (source.phase !== 'connected') return
        try { source.catalog = await this.api.workspace(source.id, { op: 'catalog' }); delete source.error }
        catch { source.error = 'Workspaces unavailable'; source.phase = 'error' }
        if (!this.disposed) { this.catalogs = { ...this.catalogs, sources: [...sources] }; this.emit() }
      }))
      if (this.disposed) return
      this.catalogs = { ...this.catalogs, sources }
      this.emit()
      await this.check()
    } catch { /* Retain the previous catalog while the local transport recovers. */ }
  }
  async mutate(id: string, request: WorkspaceRequest): Promise<void> {
    if (this.disposed) return
    if (id !== 'local') {
      const known = this.rows.find(row => row.id === id)
      const current = (await this.api.list()).find(row => row.id === id)
      if (!current || current.phase !== 'connected' || (known && !sameDestination(known, current))) throw new Error('This connection changed. Select the workspace again.')
    }
    await this.api.workspace(id, request)
    // An earlier catalog request may have read before this mutation committed.
    if (this.refreshing) await this.refreshing
    await this.refresh()
  }
  async reconnect(id: string): Promise<void> {
    if (this.state?.id === id) await this.open(id, this.target ?? selectionTarget(this.catalogs.selected))
    else { await this.api.connect(id); await this.refresh() }
  }
  pick(id: string): Promise<void> { return this.navigate(id, { kind: 'pick' }) }
  newSession(workspaceId?: string): Promise<void> {
    return this.navigate(this.catalogs.selected.sourceId, { kind: 'newSession', ...(workspaceId === undefined ? {} : { id: workspaceId }) })
  }
  async navigate(id: string, target: WorkspaceNavigationTarget): Promise<void> {
    if (id === 'local') { this.close(); await this.options.localNavigate?.(target); await this.refresh(); return }
    await this.open(id, target)
  }
  localSelection(sessionId?: string): void {
    if (this.state) return
    this.select({ sourceId: 'local', ...(sessionId === undefined ? {} : { sessionId }) }, this.restoring !== this.version)
  }
  async open(id: string, target?: WorkspaceNavigationTarget): Promise<void> {
    if (this.disposed) return
    parseId(id)
    const previous = this.state
    const previousDestination = this.destination
    const previousSelection = this.catalogs.selected
    const version = ++this.version
    this.stopPresentationWatch()
    this.target = target
    this.navigating = version
    const current = () => !this.disposed && version === this.version
    const reuse = previous?.id === id && previous.phase === 'ready' && previous.channel !== undefined
    let channel: string | undefined
    let acquired = false
    try {
      if (!reuse) { this.release(previous); this.destination = undefined; this.publish({ id, name: this.rows.find(row => row.id === id)?.name ?? '', phase: 'connecting' }) }
      this.select({ sourceId: id, ...(target?.kind === 'session' ? { sessionId: target.id } : target?.kind === 'workspace' || target?.kind === 'newSession' && target.id !== undefined ? { workspaceId: target.id } : {}) })
      const row = (await this.api.list()).find(row => row.id === id)
      if (!current()) return
      if (!row) throw new Error('missing-connection')
      const catalogDestination = this.rows.find(row => row.id === id)
      if (target && target.kind !== 'pick' && catalogDestination && !sameDestination(catalogDestination, row)) throw new Error('changed-connection')
      const connected = row.phase === 'connected' ? row : await this.api.connect(id)
      if (!current()) return
      if (target === undefined) {
        const catalog = await this.api.workspace(id, { op: 'catalog' })
        const workspace = catalog.workspaces[0]
        target = workspace ? { kind: 'workspace', id: workspace.id } : { kind: 'pick' }
      }
      if (!current()) return
      this.target = target
      let url: string
      if (reuse && sameAuthority(previousDestination, connected)) {
        channel = previous.channel!; url = previous.url!
      } else {
        if (reuse) { this.release(previous); this.destination = undefined; this.publish({ id, name: row.name, phase: 'connecting' }) }
        const opened = await this.api.workspace(id, { op: 'openView' })
        channel = opened.channel
        acquired = true
        if (!current()) { this.release({ id, name: '', phase: 'ready', channel }); return }
        const result = parseOpenResult(await this.api.open(id))
        const latest = (await this.api.list()).find(row => row.id === id)
        if (!current()) { this.release({ id, name: '', phase: 'ready', channel }); return }
        if (!latest || !sameAuthority(connected, latest) || Number(new URL(result.url).port) !== latest.localPort) throw new Error('changed-connection')
        const address = new URL(this.options.prepareUrl?.(result.url) ?? result.url)
        address.hash = new URLSearchParams({ 'connections-view': channel }).toString()
        url = address.href
      }
      const view = await this.api.workspace(id, { op: 'navigate', channel, requestId: crypto.randomUUID(), target })
      if (!current()) { if (acquired) this.release({ id, name: '', phase: 'ready', channel }); return }
      this.destination = connected
      this.pickFallback = target.kind === 'pick' && previousSelection.sourceId === id && previous?.phase === 'ready' ? previousSelection : undefined
      this.publish({ id, name: row.name, phase: 'ready', url, channel, revision: view.revision, presented: false })
      this.watchPresentation(version)
      void this.refresh()
    } catch (error) {
      if (!current()) { if (channel && acquired) this.release({ id, name: '', phase: 'ready', channel }); return }
      this.release(channel ? { id, name: '', phase: 'ready', channel } : previous)
      this.destination = undefined
      const reason = error instanceof Error && 'code' in error && error.code === 'NOT_EMBEDDED' ? 'pluginRequired'
        : error instanceof Error && error.message === 'unsupported-workspace-surface' ? 'unavailable' : 'failed'
      this.publish({ id, name: this.state?.name ?? '', phase: 'error', error: reason })
    } finally { if (this.navigating === version) this.navigating = undefined }
  }
  private release(state?: WorkspaceState): void {
    if (state?.channel) void this.api.workspace(state.id, { op: 'closeView', channel: state.channel }).catch(() => {})
  }
  private stopPresentationWatch(): void {
    clearTimeout(this.presentationTimer); clearTimeout(this.presentationDeadline)
  }
  private watchPresentation(version: number): void {
    const pending = () => !this.disposed && version === this.version && this.state?.phase === 'ready' && this.state.presented !== true
    if (!pending()) return
    // A navigable HTTP address is not proof that the native document loaded.
    // Keep this deadline independent of slow catalog or HTTP health requests.
    this.presentationDeadline = setTimeout(() => {
      if (!pending()) return
      const state = this.state!
      this.stopPresentationWatch(); this.release(state); this.destination = undefined
      this.publish({ id: state.id, name: state.name, phase: 'error', error: 'timeout' })
    }, this.options.presentationTimeoutMs ?? 30_000)
    const poll = async () => {
      if (!pending()) return
      await this.check()
      if (pending()) this.presentationTimer = setTimeout(poll, 1000)
    }
    void poll()
  }
  /** Closing the view never stops a connection, native session or running task. */
  close(): void { this.version++; this.stopPresentationWatch(); this.release(this.state); this.state = undefined; this.destination = undefined; this.target = undefined; this.pickFallback = undefined; this.select({ sourceId: 'local' }); this.remember({ sourceId: 'local' }); this.emit() }
  async check(): Promise<void> {
    const state = this.state
    if (!state || state.phase !== 'ready' || this.navigating === this.version) return
    const version = this.version
    const current = () => !this.disposed && version === this.version && this.state === state
    try {
      const row = (await this.api.list()).find(row => row.id === state.id)
      if (!current()) return
      if (!row || !sameAuthority(this.destination, row)) throw new Error('disconnected')
      const view = await this.api.workspace(state.id, { op: 'viewState', channel: state.channel! })
      if (!current()) return
      if (view.reportedRevision >= (state.revision ?? 0)) {
        if (view.error === 'NAVIGATION_FAILED') throw new Error('navigation-failed')
        if (view.error === 'PICK_CANCELLED') {
          if (this.pickFallback && selectionTarget(this.pickFallback)) {
            this.target = selectionTarget(this.pickFallback); this.select(this.pickFallback)
            if (!current()) return
            this.stopPresentationWatch(); this.publish({ ...state, presented: true })
          }
          else this.close()
          return
        }
        if (view.sessionId !== undefined) { this.target = { kind: 'session', id: view.sessionId }; this.select({ sourceId: state.id, sessionId: view.sessionId }) }
      }
      if (!current()) return
      if (view.presentedRevision >= (state.revision ?? 0) && state.presented !== true) {
        this.stopPresentationWatch()
        this.publish({ ...state, presented: true })
      }
    } catch (error) {
      if (!current()) return
      this.stopPresentationWatch()
      this.release(state)
      this.destination = undefined
      this.publish({ id: state.id, name: state.name, phase: 'error', error: error instanceof Error && error.message === 'navigation-failed' ? 'failed' : 'disconnected' })
    }
  }
  dispose(): void { this.stopPresentationWatch(); this.release(this.state); this.disposed = true; this.version++; clearTimeout(this.timer); this.state = undefined; this.listeners.clear() }
}
