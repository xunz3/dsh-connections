import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  WORKSPACE_ENDPOINT, WORKSPACE_ERRORS, WORKSPACE_REQUEST_LIMIT, WORKSPACE_RESPONSE_LIMIT,
  parseWorkspaceRequest, parseWorkspaceResponse,
} from '../shared/workspace-protocol.js'
import type {
  WorkspaceCatalogWorkspace, WorkspaceErrorCode, WorkspaceRequest, WorkspaceResponse,
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
    rename(request: { workspaceId: string; title: string }): Promise<{ workspace: NativeWorkspace }>
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
}
export interface WorkspaceEndpointHandle {
  handle(input: WorkspaceRequest, signal: AbortSignal): Promise<WorkspaceResponse>
}
interface ViewChannel {
  expires: number
  state: WorkspaceViewState
  requests: Map<string, string>
  waiters: Set<{ resolve(): void; reject(error: EndpointError): void }>
}
class EndpointError extends Error {
  constructor(readonly code: WorkspaceErrorCode) { super(WORKSPACE_ERRORS[code]) }
}
const statuses: Record<WorkspaceErrorCode, number> = {
  BAD_REQUEST: 400, TOO_LARGE: 413, NOT_FOUND: 404, CONFLICT: 409,
  SESSION_ACTIVE: 409, UNAVAILABLE: 503, CANCELLED: 499, FAILED: 502,
  NOT_EMBEDDED: 503,
}

function displayTitle(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512) : ''
}
function workspace(row: NativeWorkspace): WorkspaceCatalogWorkspace {
  return { id: row.id ?? row.workspaceId ?? '', path: row.path, title: displayTitle(row.title), sessionIds: [...row.sessionIds] }
}
function safeError(error: unknown, aborted: boolean): EndpointError {
  if (aborted) return new EndpointError('CANCELLED')
  if (error instanceof EndpointError) return error
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
  private readonly lifetime = new AbortController()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly pollMs: number
  private readonly maxChannels: number
  private readonly embedded: boolean
  private readonly sweeper: ReturnType<typeof setInterval>

  constructor(private readonly services: WorkspaceEndpointServices, options: EndpointOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = Math.max(1, Math.min(options.ttlMs ?? 30 * 60_000, 30 * 60_000))
    this.pollMs = Math.max(1, Math.min(options.pollMs ?? 20_000, 20_000))
    this.maxChannels = Math.max(1, Math.min(options.maxChannels ?? 32, 32))
    this.embedded = options.embedded ?? true
    this.sweeper = setInterval(() => this.expire(), Math.min(this.ttlMs, 60_000))
    this.sweeper.unref()
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) return
    this.lifetime.abort()
    clearInterval(this.sweeper)
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
      } catch (error) { if (error instanceof EndpointError) throw error; throw new EndpointError('BAD_REQUEST') }
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
    if (!this.embedded && ['openView', 'navigate', 'pollView', 'reportView', 'viewState', 'closeView'].includes(input.op)) throw new EndpointError('NOT_EMBEDDED')
    const { workspaceRegistry, workspaceController, sessionController } = this.services
    switch (input.op) {
      case 'catalog': {
        const { items } = await sessionController.list({}, signal)
        return {
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
      }
      case 'renameWorkspace': {
        const result = await workspaceController.rename({ workspaceId: input.id, title: input.title })
        return { workspace: workspace(result.workspace) }
      }
      case 'forgetWorkspace': await workspaceController.delete({ workspaceId: input.id }); return { done: true }
      case 'renameSession': await sessionController.rename({ sessionId: input.id, title: input.title }); return { done: true }
      case 'archiveSession':
        if (input.archived) await workspaceController.archiveSession({ sessionId: input.id })
        else await workspaceController.unarchiveSession({ sessionId: input.id })
        return { done: true }
      case 'pinSession':
        if (input.pinned) await workspaceController.pinSession({ sessionId: input.id })
        else await workspaceController.unpinSession({ sessionId: input.id })
        return { done: true }
      case 'openView': {
        this.expire()
        if (this.channels.size >= this.maxChannels) throw new EndpointError('CONFLICT')
        const channel = randomBytes(32).toString('base64url')
        const view: ViewChannel = { expires: this.now() + this.ttlMs, state: { revision: 0, reportedRevision: 0, presentedRevision: 0 }, requests: new Map(), waiters: new Set() }
        this.channels.set(channel, view)
        return { channel, ...view.state }
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
export function installWorkspaceEndpoint(ctx: Context, options: { embedded?: boolean } = {}): WorkspaceEndpointHandle {
  let active: WorkspaceEndpoint | undefined
  ctx.inject(['connection', 'workspaceRegistry', 'workspaceController', 'sessionController'], child => {
    const services = child as unknown as EndpointContext
    const endpoint = new WorkspaceEndpoint(services, { embedded: options.embedded === true })
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
