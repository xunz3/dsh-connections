import type { Context } from '@deepseek-ai/cordis'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'

/** Observe the independently deployed native shell; never install or replace it. */
export function observeNativeSidebar(ctx: Context, onReady: (ready: boolean) => void): () => void {
  let ready: boolean | undefined
  const publish = (next: boolean) => {
    if (next === ready) return
    ready = next
    onReady(next)
  }
  const sync = () => {
    const entry = ctx.slots.entriesOfSlot('sidebar')[0]
    publish(entry?.locale === 'sidebar'
      && entry.children?.['sidebar.workspaces']?.kind === 'single'
      && entry.children?.['sidebar.settings']?.kind === 'single')
  }
  const unsubscribe = ctx.slots.subscribe('sidebar', sync)
  sync()
  return () => { unsubscribe(); publish(false) }
}

/** Plugin-owned synchronous panel transitions, never a replacement layout API. */
export interface NavigationTransaction {
  getSnapshot(): boolean
  subscribe(listener: () => void): () => void
  run(action: () => void): void
}

export function createNavigationTransaction(): NavigationTransaction {
  let depth = 0
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of listeners) listener() }
  return {
    getSnapshot: () => depth > 0,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    run(action) {
      const outer = depth++ === 0
      try { if (outer) emit(); action() }
      finally { depth--; if (outer) emit() }
    },
  }
}

export interface RemoteNavigationSource {
  getSnapshot(): boolean
  subscribe(listener: () => void): () => void
  close(): void
}

export interface NativeSessionSource {
  getSnapshot(): { readonly key: string | undefined }
  subscribe(listener: () => void): () => void
}

/** Wait for the native local baseline before an automatic remote panel commit.
 * An empty ready workspace list needs no local workspace restoration. A stalled
 * native startup is bounded; this does not create a Session or rewrite its facts. */
export function waitForNativeStartup(session: NativeSessionSource, workspaces: {
  getSnapshot(): { readonly phase: string; readonly items: readonly unknown[] }
  subscribe(listener: () => void): () => void
}, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  if (session.getSnapshot().key !== undefined) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let active = true, queued = false
    const subscriptions: Array<() => void> = []
    const finish = (error?: unknown) => {
      if (!active) return
      active = false
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      for (const off of subscriptions) off()
      if (error !== undefined) reject(error); else resolve()
    }
    const aborted = () => finish(signal.reason ?? new DOMException('Startup cancelled', 'AbortError'))
    const check = () => {
      if (!active || queued) return
      const snapshot = workspaces.getSnapshot()
      if (session.getSnapshot().key === undefined && (snapshot.phase !== 'ready' || snapshot.items.length !== 0)) return
      queued = true
      queueMicrotask(() => {
        queued = false
        if (!active) return
        const latest = workspaces.getSnapshot()
        if (session.getSnapshot().key !== undefined || latest.phase === 'ready' && latest.items.length === 0) finish()
      })
    }
    const timer = setTimeout(() => finish(), 30_000)
    signal.addEventListener('abort', aborted, { once: true })
    try {
      for (const source of [session, workspaces]) {
        const off = source.subscribe(check)
        if (active) subscriptions.push(off); else off()
      }
      if (signal.aborted) aborted(); else check()
    } catch (error) { finish(error) }
  })
}

/**
 * Native blank restoration also calls beginNavigation during cold startup. Do
 * not arm a cancelling navigation signal until the first native main binding
 * has committed. Afterwards latch readiness: explicit New Session may reuse
 * the same blank/key/panel and must still supersede pending remote intent.
 */
export function watchNativeNavigation(layout: Pick<ILayout, 'beginNavigation'>, source: RemoteNavigationSource, transaction: NavigationTransaction, session: NativeSessionSource): () => void {
  let active = true
  let ready = session.getSnapshot().key !== undefined
  let queued = false
  let closing = false
  let signal: AbortSignal | undefined
  const clear = () => { signal?.removeEventListener('abort', navigate); signal = undefined }
  const navigate = () => {
    clear()
    closing = true
    try { source.close() } finally { closing = false }
  }
  const sync = () => {
    if (!active || closing) return
    if (!ready || transaction.getSnapshot() || !source.getSnapshot()) { clear(); return }
    if (signal !== undefined) return
    const next = layout.beginNavigation()
    // Superseding an older native navigation may synchronously update state.
    if (!active || transaction.getSnapshot() || !source.getSnapshot()) return
    signal = next
    next.addEventListener('abort', navigate, { once: true })
    if (next.aborted) navigate()
  }
  // Withdraw the old abort listener before our own panel actions and rearm only
  // after the complete synchronous transaction (including nested actions) ends.
  const offTransaction = transaction.subscribe(sync)
  const unsubscribe = source.subscribe(sync)
  const offSession = session.subscribe(() => {
    if (ready || queued || session.getSnapshot().key === undefined) return
    queued = true
    // retain() may publish the binding before native replaceMain checks its
    // navigation signal once more. Never abort that in-progress commit inline.
    queueMicrotask(() => {
      queued = false
      if (!active || session.getSnapshot().key === undefined) return
      ready = true
      sync()
    })
  })
  sync()
  return () => { active = false; unsubscribe(); offSession(); offTransaction(); clear() }
}
