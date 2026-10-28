import type { LocalPresentation, LoginAction, SurfaceAck, SurfaceSnapshot } from '../shared/view-surface-protocol.js'
import { parseLocalPresentation, parseLoginAction } from '../shared/view-surface-protocol.js'
import type { SettingsHostEndpoint } from './settings-host-relay.js'

function terminal(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && ['NOT_FOUND', 'CONFLICT', 'BAD_REQUEST', 'INCOMPATIBLE_PROTOCOL', 'NOT_EMBEDDED'].includes(String(error.code))
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); reject(signal.reason) }
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
export interface LocalSurface {
  getPresentation(): LocalPresentation
  perform(action: LoginAction, signal: AbortSignal): Promise<void>
}
/** One bridge per live view lease; only declared browser capabilities leave its document. */
export function bindViewSurfaceParent(options: LocalSurface & {
  channel: string; endpoint: SettingsHostEndpoint; getRevision(): number | undefined; intervalMs?: number
}): () => void {
  const lifetime = new AbortController()
  const completed = new Map<string, boolean>()
  let acknowledgements: SurfaceAck[] = []
  const run = async () => {
    while (!lifetime.signal.aborted) {
      try {
        const exchange = await options.endpoint({ op: 'syncSurface', channel: options.channel,
          presentation: parseLocalPresentation(options.getPresentation()), acknowledgements }, lifetime.signal)
        acknowledgements = []
        for (const request of exchange.requests) {
          if (lifetime.signal.aborted) return
          let ok = completed.get(request.id)
          if (ok === undefined) {
            ok = false
            // Re-read admission immediately before a side effect. A cancellation,
            // navigation or closed lease must not execute a queued login operation.
            try {
              if (request.revision === options.getRevision()) {
                const state = await options.endpoint({ op: 'requestSurface', channel: options.channel, ...request }, lifetime.signal)
                if (state.status === 'pending' && request.revision === options.getRevision()) {
                  lifetime.signal.throwIfAborted()
                  await options.perform(request.action, lifetime.signal)
                  ok = true
                }
              }
            } catch { /* Return a real failure to the native login/copy handler. */ }
            completed.set(request.id, ok)
          }
          acknowledgements.push({ id: request.id, ok })
        }
      } catch (error) { if (terminal(error)) return }
      await delay(options.intervalMs ?? 500, lifetime.signal).catch(() => {})
    }
  }
  void run()
  return () => { lifetime.abort(); completed.clear() }
}

/** Uses the existing owner-authenticated channel; never grants the child local RPC. */
export function createViewSurfaceClient(channel: string, endpoint: SettingsHostEndpoint, intervalMs = 1000) {
  const lifetime = new AbortController(), listeners = new Set<() => void>()
  let snapshot: SurfaceSnapshot | undefined
  let readyResolve!: (value: SurfaceSnapshot) => void, readyReject!: (error: unknown) => void
  const ready = new Promise<SurfaceSnapshot>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const run = async () => {
    while (!lifetime.signal.aborted) {
      try {
        const value = await endpoint({ op: 'surfaceSnapshot', channel }, lifetime.signal)
        if (lifetime.signal.aborted) return
        if (!value.presentation) throw new Error('Local presentation is unavailable')
        if (JSON.stringify(value) !== JSON.stringify(snapshot)) { snapshot = value; for (const listener of listeners) listener() }
        readyResolve(value)
      } catch (error) { if (!snapshot || terminal(error)) { readyReject(error); lifetime.abort(); return } }
      await delay(intervalMs, lifetime.signal).catch(() => {})
    }
  }
  void run()
  return {
    ready,
    getSnapshot: () => snapshot?.presentation,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async request(action: LoginAction, callerSignal: AbortSignal): Promise<void> {
      const signal = AbortSignal.any([callerSignal, lifetime.signal, AbortSignal.timeout(30_000)])
      signal.throwIfAborted()
      const id = crypto.randomUUID()
      const view = await endpoint({ op: 'viewState', channel }, signal)
      const input = { op: 'requestSurface' as const, channel, revision: view.revision, id, action: parseLoginAction(action) }
      let done = false
      const cancel = () => { void endpoint({ op: 'cancelSurface', channel, id }, AbortSignal.timeout(5000)).catch(() => {}) }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        while (true) {
          signal.throwIfAborted()
          const result = await endpoint(input, signal)
          if (result.status === 'done') { done = true; return }
          if (result.status === 'failed') throw new Error('The desktop could not complete this login action')
          await delay(250, signal)
        }
      } finally { signal.removeEventListener('abort', cancel); if (!done) cancel() }
    },
    dispose() { lifetime.abort(); readyReject(new Error('View closed')); listeners.clear() },
  }
}
