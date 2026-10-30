import type { LocalPresentation, SurfaceRequest, SurfaceActionResult } from '../shared/view-surface-protocol.js'
import { createHash, randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsHostExchange } from '../shared/settings-host-protocol.js'
import {
  WORKSPACE_CATALOG_PAGE_LIMIT, WORKSPACE_ENDPOINT, WORKSPACE_ERRORS, WORKSPACE_PROTOCOL, WORKSPACE_REQUEST_LIMIT, WORKSPACE_RESPONSE_LIMIT,
  parseWorkspaceCatalogPage, parseWorkspaceRequest, parseWorkspaceResponse, WorkspaceProtocolError,
} from '../shared/workspace-protocol.js'
import type {
  WorkspaceCatalog, WorkspaceCatalogPage, WorkspaceCatalogWorkspace, WorkspaceErrorCode, WorkspaceRequest, WorkspaceResponse,
  WorkspaceResult, WorkspaceViewState,
} from '../shared/workspace-protocol.js'

/** Public native service shapes, narrowed to the operations this endpoint needs. */
interface NativeWorkspace {
  readonly id?: string
  readonly workspaceId?: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
}
interface NativeSessionSummary {
  readonly sessionId: string
  readonly cwd?: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly origin?: 'subagent'
  readonly parentSessionId?: string
  readonly projections?: { readonly values: { readonly title?: unknown } }
}
export interface WorkspaceEndpointServices {
  workspaceRegistry: {
    list(): readonly NativeWorkspace[]
    readonly archivedSessionIds: readonly string[]
    readonly pinnedSessionIds: readonly string[]
  }
  workspaceController: {
    rename(request: { workspaceId: string; title: string }): Promise<unknown>
    delete(request: { workspaceId: string }): Promise<unknown>
    archiveSession(request: { sessionId: string }): Promise<unknown>
    unarchiveSession(request: { sessionId: string }): Promise<unknown>
    pinSession(request: { sessionId: string }): Promise<unknown>
    unpinSession(request: { sessionId: string }): Promise<unknown>
  }
  sessionController: {
    list(request: Record<string, never>, signal: AbortSignal): Promise<{ items: readonly NativeSessionSummary[] }>
    rename(request: { sessionId: string; title: string }): Promise<unknown>
  }
}
interface FetchRoute {
  path: string
  methods: readonly ['POST']
  requestBody: 'buffered'
  fetch(request: Request): Promise<Response>
}
interface EndpointContext extends WorkspaceEndpointServices {
  connection: { fetch: { register(route: FetchRoute): () => Promise<void> } }
}
interface EndpointOptions {
  embedded?: boolean
  now?: () => number
  ttlMs?: number
  pollMs?: number
  maxChannels?: number
  nativeVersion?: string
}
export interface WorkspaceEndpointHandle {
  handle(input: WorkspaceRequest, signal: AbortSignal): Promise<WorkspaceResponse>
}
interface ViewChannel {
  clientId: string
  expires: number
  state: WorkspaceViewState
  requests: Map<string, string>
  waiters: Set<{ resolve(): void; reject(error: EndpointError): void }>
  settingsHosts?: SettingsHostExchange
  presentation?: LocalPresentation
  cancelledSurfaceActions: Set<string>
  surfaceActions: Map<string, { request: SurfaceRequest; status: SurfaceActionResult['status']; expires: number }>
}
interface CatalogSnapshot { expires: number; pages: WorkspaceCatalogPage[]; bytes: number }
const CATALOG_TTL_MS = 2 * 60_000
const CATALOG_CACHE_LIMIT = 64 * 1024 * 1024
class EndpointError extends Error {
  constructor(readonly code: WorkspaceErrorCode) { super(WORKSPACE_ERRORS[code]) }
}
const statuses: Record<WorkspaceErrorCode, number> = {
  BAD_REQUEST: 400, TOO_LARGE: 413, NOT_FOUND: 404, CONFLICT: 409,
  SESSION_ACTIVE: 409, UNAVAILABLE: 503, CANCELLED: 499, FAILED: 502,
  NOT_EMBEDDED: 503,
  INCOMPATIBLE_PROTOCOL: 409, CATALOG_EXPIRED: 409,
}

function displayTitle(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512) : ''
}
function workspace(row: NativeWorkspace): WorkspaceCatalogWorkspace {
  return { id: row.id ?? row.workspaceId ?? '', path: row.path, title: displayTitle(row.title), sessionIds: [...row.sessionIds] }
}
function emptyCatalog(): WorkspaceCatalog {
  return { workspaces: [], sessions: [], archivedSessionIds: [], pinnedSessionIds: [] }
}
function catalogPages(catalog: WorkspaceCatalog, revision: string): WorkspaceCatalogPage[] {
  const pages: WorkspaceCatalogPage[] = []
  let page: WorkspaceCatalogPage = { ...emptyCatalog(), protocol: WORKSPACE_PROTOCOL, revision }
  // Reserve the envelope, keys, revision and cursor; row byte counts include their commas.
  let bytes = 512
  let rows = 0
  const append = <K extends keyof WorkspaceCatalog>(key: K, row: WorkspaceCatalog[K][number]) => {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1
    if (size + 512 > WORKSPACE_CATALOG_PAGE_LIMIT) throw new EndpointError('TOO_LARGE')
    if (bytes + size > WORKSPACE_CATALOG_PAGE_LIMIT || rows >= 4096) {
      pages.push(page)
      page = { ...emptyCatalog(), protocol: WORKSPACE_PROTOCOL, revision }
      bytes = 512
      rows = 0
    }
    ;(page[key] as Array<typeof row>).push(row)
    bytes += size
    rows++
  }
  for (const row of catalog.workspaces) {
    // A workspace can itself own thousands of sessions. Split its membership too;
    // the reader merges same-revision fragments in their native order.
    if (!row.sessionIds.length) append('workspaces', row)
    for (let offset = 0; offset < row.sessionIds.length; offset += 128) append('workspaces', { ...row, sessionIds: row.sessionIds.slice(offset, offset + 128) })
  }
  for (const row of catalog.sessions) append('sessions', row)
  for (const id of catalog.archivedSessionIds) append('archivedSessionIds', id)
  for (const id of catalog.pinnedSessionIds) append('pinnedSessionIds', id)
  pages.push(page)
  return pages.map((page, index) => parseWorkspaceCatalogPage({ ...page, ...(index + 1 < pages.length ? { nextCursor: `${revision}.${index + 1}` } : {}) }))
}
function safeError(error: unknown, aborted: boolean): EndpointError {
  if (aborted) return new EndpointError('CANCELLED')
  if (error instanceof EndpointError) return error
  if (error instanceof WorkspaceProtocolError) return new EndpointError(error.code)
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  switch (code) {
    case 'workspace/session-active': return new EndpointError('SESSION_ACTIVE')
    case 'workspace/not-found': case 'session/not-found': return new EndpointError('NOT_FOUND')
    case 'workspace/name-conflict': return new EndpointError('CONFLICT')
    case 'gateway/bad-request': return new EndpointError('BAD_REQUEST')
    default: return new EndpointError('FAILED')
  }
}

/** Owner-only transport callback. Never mount this directly on an unauthenticated server. */
export class WorkspaceEndpoint {
  private readonly channels = new Map<string, ViewChannel>()
  /** Sliding-expiry LRU snapshots keep active readers ahead of idle catalog revisions.
   * Bound history by count and wire size; one current catalog may exceed the cache budget. */
  private readonly catalogs = new Map<string, CatalogSnapshot>()
  private readonly lifetime = new AbortController()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly pollMs: number
  private readonly maxChannels: number
  private readonly embedded: boolean
  private readonly nativeVersion: string
  private readonly sweeper: ReturnType<typeof setInterval>

  constructor(private readonly services: WorkspaceEndpointServices, options: EndpointOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = Math.max(1, Math.min(options.ttlMs ?? 30 * 60_000, 30 * 60_000))
    this.pollMs = Math.max(1, Math.min(options.pollMs ?? 20_000, 20_000))
    this.maxChannels = Math.max(1, Math.min(options.maxChannels ?? 32, 32))
    this.embedded = options.embedded ?? true
    this.nativeVersion = options.nativeVersion ?? 'unknown'
    this.sweeper = setInterval(() => this.expire(), Math.min(this.ttlMs, 60_000))
    this.sweeper.unref()
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) return
    this.lifetime.abort()
    clearInterval(this.sweeper)
    this.catalogs.clear()
    for (const [id, view] of this.channels) this.close(id, view, new EndpointError('UNAVAILABLE'))
  }

  readonly fetch = async (request: Request): Promise<Response> => {
    const signal = AbortSignal.any([request.signal, this.lifetime.signal])
    try {
      if (this.lifetime.signal.aborted) throw new EndpointError('UNAVAILABLE')
      signal.throwIfAborted()
      if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new EndpointError('BAD_REQUEST')
      let input: unknown
      try { input = await readBody(request, signal) }
      catch (error) { if (error instanceof EndpointError) throw error; throw new EndpointError('BAD_REQUEST') }
      const result = await this.handle(input as WorkspaceRequest, signal)
      return json(JSON.stringify(result), result.ok ? 200 : statuses[result.error.code])
    } catch (error) {
      const failure = this.lifetime.signal.aborted ? new EndpointError('UNAVAILABLE') : safeError(error, signal.aborted)
      return json(JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } }), statuses[failure.code])
    }
  }

  async handle(request: WorkspaceRequest, callerSignal: AbortSignal): Promise<WorkspaceResponse> {
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal])
    try {
      if (this.lifetime.signal.aborted) throw new EndpointError('UNAVAILABLE')
      signal.throwIfAborted()
      let input: WorkspaceRequest
      try {
        input = parseWorkspaceRequest(request)
        if (Buffer.byteLength(JSON.stringify(input)) > WORKSPACE_REQUEST_LIMIT) throw new EndpointError('TOO_LARGE')
      } catch (error) { if (error instanceof EndpointError || error instanceof WorkspaceProtocolError) throw error; throw new EndpointError('BAD_REQUEST') }
      const value = await this.execute(input, signal)
      signal.throwIfAborted()
      // Copy only declared fields, never native objects, projections, or errors.
      let output: WorkspaceResponse
      try { output = parseWorkspaceResponse(input.op, { ok: true, value }) }
      catch { throw new EndpointError('FAILED') }
      const body = JSON.stringify(output)
      if (Buffer.byteLength(body) > WORKSPACE_RESPONSE_LIMIT) throw new EndpointError('TOO_LARGE')
      return output
    } catch (error) {
      const failure = this.lifetime.signal.aborted ? new EndpointError('UNAVAILABLE') : safeError(error, signal.aborted)
      return { ok: false, error: { code: failure.code, message: failure.message } }
    }
  }

  private async execute(input: WorkspaceRequest, signal: AbortSignal): Promise<WorkspaceResult> {
    if (!this.embedded && ['openView', 'navigate', 'pollView', 'reportView', 'viewState', 'closeView', 'publishSettingsHosts', 'pollSettingsHosts', 'selectSettingsHost', 'surfaceSnapshot', 'syncSurface', 'requestSurface', 'cancelSurface'].includes(input.op)) throw new EndpointError('NOT_EMBEDDED')
    const { workspaceRegistry, workspaceController, sessionController } = this.services
    switch (input.op) {
      case 'catalog': {
        this.expire()
        if (input.cursor) {
          const [revision, offset] = input.cursor.split('.')
          const snapshot = this.catalogs.get(revision!)
          const page = snapshot?.pages[Number(offset)]
          if (!page) throw new EndpointError('CATALOG_EXPIRED')
          this.touchCatalog(revision!, snapshot!)
          return page
        }
        const { items } = await sessionController.list({}, signal)
        const catalog: WorkspaceCatalog = {
          workspaces: workspaceRegistry.list().map(workspace),
          sessions: items.map(row => ({
            id: row.sessionId, title: displayTitle(row.projections?.values.title), updatedAt: row.updatedAt,
            running: row.running, blank: row.blank,
            ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
            ...(row.origin === undefined ? {} : { origin: row.origin }),
            ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }),
          })),
          archivedSessionIds: [...workspaceRegistry.archivedSessionIds], pinnedSessionIds: [...workspaceRegistry.pinnedSessionIds],
        }
        const revision = createHash('sha256').update(JSON.stringify(catalog)).digest('base64url')
        if (input.ifRevision === revision) return { ...emptyCatalog(), protocol: WORKSPACE_PROTOCOL, revision, unchanged: true }
        let snapshot = this.catalogs.get(revision)
        if (!snapshot) {
          const pages = catalogPages(catalog, revision)
          snapshot = { expires: 0, pages, bytes: pages.reduce((total, page) => total + Buffer.byteLength(JSON.stringify(page)), 0) }
        }
        this.touchCatalog(revision, snapshot)
        return snapshot.pages[0]!
      }
      case 'renameWorkspace': {
        await workspaceController.rename({ workspaceId: input.id, title: input.title })
        return { done: true }
      }
      case 'forgetWorkspace': await workspaceController.delete({ workspaceId: input.id }); return { done: true }
      case 'renameSession': await sessionController.rename({ sessionId: input.id, title: input.title }); return { done: true }
      case 'archiveSession':
        if (input.archived) await workspaceController.archiveSession({ sessionId: input.id, ...(input.stopActivity === true ? { stopActivity: true } : {}) })
        else await workspaceController.unarchiveSession({ sessionId: input.id })
        return { done: true }
      case 'pinSession':
        if (input.pinned) await workspaceController.pinSession({ sessionId: input.id })
        else await workspaceController.unpinSession({ sessionId: input.id })
        return { done: true }
      case 'openView': {
        this.expire()
        // A stable per-tab client ID owns one lease. Rotate the channel on reload:
        // delayed cleanup or reports from the previous document cannot affect it.
        for (const [channel, view] of this.channels) {
          if (view.clientId === input.clientId) this.close(channel, view, new EndpointError('NOT_FOUND'))
        }
        if (this.channels.size >= this.maxChannels) throw new EndpointError('CONFLICT')
        const channel = randomBytes(32).toString('base64url')
        const view: ViewChannel = { clientId: input.clientId, expires: this.now() + this.ttlMs, state: { revision: 0, reportedRevision: 0, presentedRevision: 0 }, requests: new Map(), waiters: new Set(), surfaceActions: new Map(), cancelledSurfaceActions: new Set(), ...(input.presentation ? { presentation: input.presentation } : {}) }
        this.channels.set(channel, view)
        return { channel, ...view.state, protocol: WORKSPACE_PROTOCOL }
      }
      case 'closeView': {
        const view = this.channels.get(input.channel)
        if (view) this.close(input.channel, view, new EndpointError('NOT_FOUND'))
        return { closed: true }
      }
      case 'navigate': {
        const view = this.get(input.channel)
        const target = JSON.stringify(input.target)
        const previous = view.requests.get(input.requestId)
        if (previous !== undefined) {
          if (previous !== target) throw new EndpointError('CONFLICT')
          return view.state
        }
        // Preserve idempotency for the channel's whole lifetime with bounded storage.
        if (view.requests.size >= 4096) throw new EndpointError('CONFLICT')
        view.requests.set(input.requestId, target)
        const revision = view.state.revision + 1
        view.settingsHosts = undefined
        for (const action of view.surfaceActions.values()) if (action.status === 'pending') action.status = 'failed'
        view.state = {
          revision, reportedRevision: view.state.reportedRevision, presentedRevision: view.state.presentedRevision,
          intent: { revision, requestId: input.requestId, target: input.target },
          ...(view.state.sessionId === undefined ? {} : { sessionId: view.state.sessionId }),
        }
        for (const waiter of view.waiters) waiter.resolve()
        return view.state
      }
      case 'pollView': {
        const view = this.get(input.channel)
        if (input.afterRevision > view.state.revision) throw new EndpointError('BAD_REQUEST')
        if (input.afterRevision === view.state.revision) await this.wait(view, signal)
        return this.get(input.channel).state
      }
      case 'reportView': {
        const view = this.get(input.channel)
        if (input.revision > view.state.revision) throw new EndpointError('BAD_REQUEST')
        if (input.revision < view.state.revision) return view.state
        if (input.presented === true) {
          view.state = { ...view.state, presentedRevision: input.revision }
          return view.state
        }
        view.state = {
          revision: view.state.revision, reportedRevision: input.revision, presentedRevision: input.revision,
          ...(view.state.intent === undefined ? {} : { intent: view.state.intent }),
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          ...(input.error === undefined ? {} : { error: input.error }),
        }
        return view.state
      }
      case 'viewState': return this.get(input.channel).state
      case 'surfaceSnapshot': {
        const view = this.get(input.channel)
        return { nativeVersion: this.nativeVersion, ...(view.presentation ? { presentation: view.presentation } : {}) }
      }
      case 'syncSurface': {
        const view = this.get(input.channel)
        view.presentation = input.presentation
        for (const ack of input.acknowledgements) {
          const action = view.surfaceActions.get(ack.id)
          if (action?.status === 'pending') action.status = ack.ok && action.expires > this.now() ? 'done' : 'failed'
        }
        const requests: SurfaceRequest[] = []
        for (const action of view.surfaceActions.values()) {
          if (action.status !== 'pending') continue
          if (action.expires <= this.now() || action.request.revision !== view.state.revision) action.status = 'failed'
          else requests.push(action.request)
        }
        return { requests }
      }
      case 'requestSurface': {
        const view = this.get(input.channel)
        if (input.revision !== view.state.revision || !input.revision) throw new EndpointError('CONFLICT')
        if (view.cancelledSurfaceActions.has(input.id)) return { status: 'failed' }
        let action = view.surfaceActions.get(input.id)
        if (action) {
          if (JSON.stringify(action.request.action) !== JSON.stringify(input.action) || action.request.revision !== input.revision) throw new EndpointError('CONFLICT')
          if (action.expires <= this.now() && action.status === 'pending') action.status = 'failed'
        } else {
          if (view.surfaceActions.size >= 512 || [...view.surfaceActions.values()].filter(row => row.status === 'pending' && row.expires > this.now()).length >= 8) throw new EndpointError('CONFLICT')
          action = { request: { id: input.id, revision: input.revision, action: input.action }, status: 'pending', expires: this.now() + 30_000 }
          view.surfaceActions.set(input.id, action)
        }
        return { status: action.status }
      }
      case 'cancelSurface': {
        const view = this.get(input.channel)
        const action = view.surfaceActions.get(input.id)
        if (action) action.status = 'failed'
        else {
          if (view.cancelledSurfaceActions.size >= 512) throw new EndpointError('CONFLICT')
          view.cancelledSurfaceActions.add(input.id)
        }
        return { done: true }
      }
      case 'publishSettingsHosts': case 'pollSettingsHosts': case 'selectSettingsHost': {
        const view = this.get(input.channel)
        if (input.revision !== view.state.revision || view.state.intent?.target.kind !== 'settings' || view.state.error !== undefined) throw new EndpointError('CONFLICT')
        const exchange = view.settingsHosts ?? { revision: input.revision }
        if (input.op === 'publishSettingsHosts' && exchange.selection === undefined) exchange.snapshot = input.snapshot
        if (input.op === 'pollSettingsHosts' && exchange.snapshot) exchange.ready = true
        if (input.op === 'selectSettingsHost') {
          if (!exchange.ready || !exchange.snapshot?.choices.some(row => row.id === input.id) || input.id === exchange.snapshot.selectedId) throw new EndpointError('BAD_REQUEST')
          if (exchange.selection !== undefined && exchange.selection !== input.id) throw new EndpointError('CONFLICT')
          // One host switch consumes the operation. Retries return the same selection.
          exchange.selection = input.id
        }
        view.settingsHosts = exchange
        return exchange
      }
    }
  }

  private touchCatalog(revision: string, snapshot: CatalogSnapshot): void {
    snapshot.expires = this.now() + CATALOG_TTL_MS
    this.catalogs.delete(revision)
    this.catalogs.set(revision, snapshot)
    let bytes = [...this.catalogs.values()].reduce((total, entry) => total + entry.bytes, 0)
    while (this.catalogs.size > 1 && (this.catalogs.size > 8 || bytes > CATALOG_CACHE_LIMIT)) {
      const oldest = this.catalogs.keys().next().value!
      bytes -= this.catalogs.get(oldest)!.bytes
      this.catalogs.delete(oldest)
    }
  }

  private get(id: string): ViewChannel {
    this.expire()
    const view = this.channels.get(id)
    if (!view) throw new EndpointError('NOT_FOUND')
    view.expires = this.now() + this.ttlMs
    return view
  }
  private expire(): void {
    const now = this.now()
    for (const [id, view] of this.channels) if (view.expires <= now) this.close(id, view, new EndpointError('NOT_FOUND'))
    for (const [revision, snapshot] of this.catalogs) if (snapshot.expires <= now) this.catalogs.delete(revision)
  }
  private close(id: string, view: ViewChannel, error: EndpointError): void {
    this.channels.delete(id)
    for (const waiter of view.waiters) waiter.reject(error)
  }
  private async wait(view: ViewChannel, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (view.waiters.size >= 4) throw new EndpointError('CONFLICT')
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: EndpointError) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        view.waiters.delete(waiter)
        if (error) reject(error)
        else resolve()
      }
      const waiter = { resolve: () => finish(), reject: (error: EndpointError) => finish(error) }
      const abort = () => finish(new EndpointError('CANCELLED'))
      const timer = setTimeout(() => finish(), this.pollMs)
      view.waiters.add(waiter)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
}

async function readBody(request: Request, signal: AbortSignal): Promise<unknown> {
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > WORKSPACE_REQUEST_LIMIT)) throw new EndpointError('TOO_LARGE')
  if (!request.body) throw new EndpointError('BAD_REQUEST')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > WORKSPACE_REQUEST_LIMIT) { void reader.cancel().catch(() => {}); throw new EndpointError('TOO_LARGE') }
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  } finally {
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}
function json(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

/** Native exact Fetch routes admit only owner Peers, on Web and Desktop carriers. */
export function installWorkspaceEndpoint(ctx: Context, options: { embedded?: boolean; nativeVersion?: string } = {}): WorkspaceEndpointHandle {
  let active: WorkspaceEndpoint | undefined
  ctx.inject(['connection', 'workspaceRegistry', 'workspaceController', 'sessionController'], child => {
    const services = child as unknown as EndpointContext
    const endpoint = new WorkspaceEndpoint(services, { embedded: options.embedded === true, nativeVersion: options.nativeVersion })
    child.effect(() => {
      const unregister = services.connection.fetch.register({ path: WORKSPACE_ENDPOINT, methods: ['POST'], requestBody: 'buffered', fetch: endpoint.fetch })
      active = endpoint
      return async () => { if (active === endpoint) active = undefined; endpoint.dispose(); await unregister() }
    })
  })
  return {
    async handle(input, signal) {
      return active?.handle(input, signal) ?? { ok: false, error: { code: 'UNAVAILABLE', message: WORKSPACE_ERRORS.UNAVAILABLE } }
    },
  }
}
