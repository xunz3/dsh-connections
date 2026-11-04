import type { LocalPresentation, LoginAction, SurfaceAck, SurfaceSnapshot } from '../shared/view-surface-protocol.js'
import { parseLocalPresentation, parseLoginAction } from '../shared/view-surface-protocol.js'
import type { SettingsHostEndpoint } from './settings-host-relay.js'

export function surfaceTerminal(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && ['NOT_FOUND', 'CONFLICT', 'BAD_REQUEST', 'INCOMPATIBLE_PROTOCOL', 'NOT_EMBEDDED'].includes(String(error.code))
}
type SurfaceDocument = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
export interface SurfacePollingOptions {
  document?: SurfaceDocument
  maxBackoffMs?: number
}
export function surfaceRetryDelay(intervalMs: number, failures: number, maximumMs = 30_000): number {
  const base = Math.max(1, Number.isFinite(intervalMs) ? intervalMs : 1000)
  const cap = Math.max(base, Number.isFinite(maximumMs) ? maximumMs : 30_000)
  return Math.min(cap, base * 2 ** Math.min(30, Math.max(0, failures - 1)))
}

/** One document listener, cancellable foreground reads, and no timers while hidden. */
export class SurfaceLifecycle {
  private readonly lifetime = new AbortController()
  private foreground = new AbortController()
  private readonly listeners = new Set<() => void>()
  private visible: boolean
  constructor(private readonly document: SurfaceDocument | undefined = globalThis.document) {
    this.visible = document?.visibilityState !== 'hidden'
    if (!this.visible) this.foreground.abort()
    document?.addEventListener('visibilitychange', this.changed)
  }
  get signal(): AbortSignal { return this.lifetime.signal }
  get activeSignal(): AbortSignal { return this.foreground.signal }
  private readonly changed = () => {
    if (this.signal.aborted) return
    const visible = this.document?.visibilityState !== 'hidden'
    if (visible === this.visible) return
    this.visible = visible
    if (visible) this.foreground = new AbortController()
    else this.foreground.abort()
    for (const listener of this.listeners) listener()
  }
  async wait(signal = this.signal): Promise<void> {
    this.signal.throwIfAborted()
    signal.throwIfAborted()
    if (this.visible) return
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.listeners.delete(check)
        signal.removeEventListener('abort', abort)
        if (signal !== this.signal) this.signal.removeEventListener('abort', abort)
      }
      const abort = () => { cleanup(); reject(signal.aborted ? signal.reason : this.signal.reason) }
      const check = () => { if (this.visible) { cleanup(); resolve() } }
      this.listeners.add(check)
      signal.addEventListener('abort', abort, { once: true })
      if (signal !== this.signal) this.signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted || this.signal.aborted) abort()
      else check()
    })
  }
  async sleep(ms: number, signal = this.activeSignal): Promise<void> {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
      const abort = () => { cleanup(); reject(signal.reason) }
      const timer = setTimeout(() => { cleanup(); resolve() }, ms)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  async read<T>(read: (signal: AbortSignal) => Promise<T>, signal = this.activeSignal): Promise<T> {
    signal.throwIfAborted()
    // Some parent RPC carriers cannot cancel transport. Stop waiting anyway and
    // consume their eventual settlement, without admitting their stale reply.
    return new Promise<T>((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve().then(() => { signal.throwIfAborted(); return read(signal) }).then(
        value => { signal.removeEventListener('abort', abort); resolve(value) },
        error => { signal.removeEventListener('abort', abort); reject(error) },
      )
      if (signal.aborted) abort()
    })
  }
  /** Client budgets pause hidden; Host action/lease TTLs still use wall-clock time. */
  budget(ms: number): { signal: AbortSignal; dispose(): void } {
    const timeout = new AbortController()
    let remaining = Math.max(0, ms), started: number | undefined, timer: ReturnType<typeof setTimeout> | undefined
    const clear = () => { clearTimeout(timer); timer = undefined }
    const update = () => {
      clear()
      if (started !== undefined) remaining = Math.max(0, remaining - (Date.now() - started))
      started = undefined
      if (!this.visible || this.signal.aborted || timeout.signal.aborted) return
      started = Date.now()
      timer = setTimeout(() => { clear(); timeout.abort(new DOMException('View surface timed out', 'TimeoutError')) }, remaining)
    }
    this.listeners.add(update)
    update()
    return { signal: timeout.signal, dispose: () => { clear(); this.listeners.delete(update) } }
  }
  dispose(): void {
    if (this.signal.aborted) return
    this.lifetime.abort()
    this.visible = false
    this.foreground.abort(this.signal.reason)
    this.document?.removeEventListener('visibilitychange', this.changed)
    for (const listener of this.listeners) listener()
    this.listeners.clear()
  }
}
/** Readiness is a foreground budget, not a wall-clock expiry of a hidden view. */
export function createSurfaceReadinessDeadline(onTimeout: () => void, timeoutMs = 30_000, options: SurfacePollingOptions = {}) {
  const lifetime = new SurfaceLifecycle(options.document)
  let stop: (() => void) | undefined
  const clear = () => { stop?.(); stop = undefined }
  const setReady = (ready: boolean) => {
    clear()
    if (ready || lifetime.signal.aborted) return
    const budget = lifetime.budget(timeoutMs)
    const expired = () => {
      clear()
      if (!lifetime.signal.aborted) onTimeout()
    }
    stop = () => { budget.signal.removeEventListener('abort', expired); budget.dispose() }
    budget.signal.addEventListener('abort', expired, { once: true })
  }
  setReady(false)
  return { setReady, dispose() { clear(); lifetime.dispose() } }
}

export interface LocalSurface {
  getPresentation(): LocalPresentation
  perform(action: LoginAction, signal: AbortSignal): Promise<void>
}
/** One bridge per live view lease; only declared browser capabilities leave its document. */
export function bindViewSurfaceParent(options: LocalSurface & SurfacePollingOptions & {
  channel: string; endpoint: SettingsHostEndpoint; getRevision(): number | undefined; intervalMs?: number
}): () => void {
  const lifetime = new SurfaceLifecycle(options.document)
  const completed = new Map<string, boolean>()
  const acknowledgements = new Map<string, boolean>()
  let failures = 0
  const run = async () => {
    while (!lifetime.signal.aborted) {
      let active: AbortSignal | undefined
      try {
        await lifetime.wait()
        active = lifetime.activeSignal
        const sent: SurfaceAck[] = [...acknowledgements].map(([id, ok]) => ({ id, ok }))
        const exchange = await lifetime.read(signal => options.endpoint({ op: 'syncSurface', channel: options.channel,
          presentation: parseLocalPresentation(options.getPresentation()), acknowledgements: sent }, signal), active)
        active.throwIfAborted()
        for (const ack of sent) acknowledgements.delete(ack.id)
        for (const request of exchange.requests) {
          active.throwIfAborted()
          let ok = completed.get(request.id)
          if (ok === undefined && completed.size >= 512) {
            // Never evict a completed side effect's tombstone to admit another ID.
            ok = false
          } else if (ok === undefined) {
            const revision = options.getRevision()
            if (revision === undefined) continue // A local navigation is still settling.
            ok = false
            if (request.revision === revision) {
              let state
              try {
                state = await lifetime.read(signal => options.endpoint({ op: 'requestSurface', channel: options.channel, ...request }, signal), active)
              } catch (error) {
                active.throwIfAborted()
                // A transport failure is not an action refusal. Keep the request
                // pending and retry admission, not the side effect, after backoff.
                if (!surfaceTerminal(error)) throw error
              }
              active.throwIfAborted()
              const current = options.getRevision()
              if (current === undefined) continue
              if (request.revision === current && state?.status === 'pending') {
                // Once an effect has been attempted, even an ambiguous failure is
                // final. Hiding only pauses transport; it must not replay effects.
                completed.set(request.id, false)
                try { await options.perform(request.action, lifetime.signal); ok = true }
                catch { /* Return a real failure to the native login/copy handler. */ }
                if (lifetime.signal.aborted) return
              } else if (state?.status === 'done') ok = true
            }
            completed.set(request.id, ok)
          }
          acknowledgements.set(request.id, ok)
        }
        failures = 0
      } catch (error) {
        if (lifetime.signal.aborted) return
        if (active?.aborted) continue
        if (surfaceTerminal(error)) { lifetime.dispose(); return }
        failures++
      }
      if (active) await lifetime.sleep(surfaceRetryDelay(options.intervalMs ?? 500, failures, options.maxBackoffMs), active).catch(() => {})
    }
  }
  void run()
  return () => { lifetime.dispose(); completed.clear(); acknowledgements.clear() }
}

/** Uses the existing owner-authenticated channel; never grants the child local RPC. */
export function createViewSurfaceClient(channel: string, endpoint: SettingsHostEndpoint, intervalMs = 1000, bootstrapTimeoutMs = 30_000, options: SurfacePollingOptions = {}) {
  const lifetime = new SurfaceLifecycle(options.document), listeners = new Set<() => void>()
  let snapshot: SurfaceSnapshot | undefined
  let readyResolve!: (value: SurfaceSnapshot) => void, readyReject!: (error: unknown) => void
  const ready = new Promise<SurfaceSnapshot>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const bootstrap = lifetime.budget(bootstrapTimeoutMs)
  const run = async () => {
    let failures = 0
    try {
      while (!lifetime.signal.aborted) {
        let active: AbortSignal | undefined
        try {
          await lifetime.wait()
          active = snapshot ? lifetime.activeSignal : AbortSignal.any([lifetime.activeSignal, bootstrap.signal])
          const value = await lifetime.read(signal => endpoint({ op: 'surfaceSnapshot', channel }, signal), active)
          active.throwIfAborted()
          if (!value.presentation) throw new Error('Local presentation is unavailable')
          if (JSON.stringify(value) !== JSON.stringify(snapshot)) { snapshot = value; for (const listener of listeners) listener() }
          bootstrap.dispose()
          readyResolve(value)
          failures = 0
        } catch (error) {
          if (lifetime.signal.aborted) return
          if (surfaceTerminal(error) || !snapshot && bootstrap.signal.aborted) { readyReject(error); lifetime.dispose(); return }
          if (active?.aborted) continue
          failures++
        }
        if (active) await lifetime.sleep(surfaceRetryDelay(intervalMs, failures, options.maxBackoffMs), active).catch(() => {})
      }
    } finally { bootstrap.dispose() }
  }
  void run()
  return {
    ready,
    getSnapshot: () => snapshot?.presentation,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async request(action: LoginAction, callerSignal: AbortSignal): Promise<void> {
      const parsed = parseLoginAction(action)
      const budget = lifetime.budget(30_000)
      const signal = AbortSignal.any([callerSignal, lifetime.signal, budget.signal])
      const id = crypto.randomUUID()
      let input: { op: 'requestSurface'; channel: string; revision: number; id: string; action: LoginAction } | undefined
      let admitted: AbortSignal | undefined, submitted = false, settled = false, cancelled = false, failures = 0
      const cancel = () => {
        if (!submitted || settled || cancelled) return
        cancelled = true
        // A single best-effort tombstone is allowed even while hidden/closing;
        // there is no background status polling or automatic resubmission.
        const cancellation = new AbortController()
        const timer = setTimeout(() => cancellation.abort(), 5000)
        void lifetime.read(signal => endpoint({ op: 'cancelSurface', channel, id }, signal), cancellation.signal)
          .catch(() => {}).finally(() => clearTimeout(timer))
      }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        while (true) {
          await lifetime.wait(signal)
          const visible = lifetime.activeSignal
          const active = AbortSignal.any([signal, visible])
          let result
          try {
            if (admitted !== visible) {
              const view = await lifetime.read(signal => endpoint({ op: 'viewState', channel }, signal), active)
              active.throwIfAborted()
              // A paused request keeps its original identity and revision. Never
              // migrate an already-admitted login to a different navigation.
              if (input && input.revision !== view.revision) throw Object.assign(new Error('The view navigation changed'), { code: 'CONFLICT' })
              input ??= { op: 'requestSurface', channel, revision: view.revision, id, action: parsed }
              admitted = visible
            }
            active.throwIfAborted()
            submitted = true
            result = await lifetime.read(signal => endpoint(input!, signal), active)
            active.throwIfAborted()
            failures = 0
          } catch (error) {
            signal.throwIfAborted()
            if (active.aborted) continue
            if (surfaceTerminal(error)) throw error
            failures++
            await lifetime.sleep(surfaceRetryDelay(250, failures, options.maxBackoffMs), active).catch(() => {})
            continue
          }
          if (result.status === 'done') { settled = true; return }
          if (result.status === 'failed') { settled = true; throw new Error('The desktop could not complete this login action') }
          await lifetime.sleep(250, active).catch(() => {})
        }
      } finally { signal.removeEventListener('abort', cancel); budget.dispose(); cancel() }
    },
    dispose() { lifetime.dispose(); readyReject(new Error('View closed')); listeners.clear() },
  }
}
