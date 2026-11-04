import { parseSettingsHostExchange, parseSettingsHostSnapshot, type SettingsHostSnapshot } from '../shared/settings-host-protocol.js'
import { parseWorkspaceChannel, type WorkspaceRequest, type WorkspaceResultMap } from '../shared/workspace-protocol.js'
import type { SettingsHostClient } from './settings-host-bridge.js'
import { SurfaceLifecycle, surfaceRetryDelay, surfaceTerminal, type SurfacePollingOptions } from './view-surface.js'

export type SettingsHostEndpoint = <R extends WorkspaceRequest>(request: R, signal: AbortSignal) => Promise<WorkspaceResultMap[R['op']]>

/** Native webviews have no parent Window. Reuse the authenticated view lease for menu metadata only. */
export function bindSettingsHostRelay(options: SurfacePollingOptions & {
  channel: string
  revision: number
  endpoint: SettingsHostEndpoint
  getSnapshot(): SettingsHostSnapshot
  onSelect(id: string): void
  onReady(): void
  onError(error: unknown): void
  intervalMs?: number
}): () => void {
  parseWorkspaceChannel(options.channel)
  const lifetime = new SurfaceLifecycle(options.document)
  let consumed = false
  const run = async () => {
    let failures = 0
    while (!lifetime.signal.aborted && !consumed) {
      let active: AbortSignal | undefined
      try {
        await lifetime.wait()
        active = lifetime.activeSignal
        // publishSettingsHosts itself validates the fixed revision and Settings
        // intent. Resuming must never retarget a menu to a new navigation.
        const result = await lifetime.read(signal => options.endpoint({
          op: 'publishSettingsHosts', channel: options.channel, revision: options.revision,
          snapshot: parseSettingsHostSnapshot(options.getSnapshot()),
        }, signal), active)
        active.throwIfAborted()
        const value = parseSettingsHostExchange(result)
        if (value.revision !== options.revision) throw Object.assign(new Error('The settings operation changed'), { code: 'CONFLICT' })
        if (value.selection !== undefined) {
          // Consume before calling external code: an ambiguous navigation failure
          // may be reported, but cannot repeat that navigation on a retry.
          consumed = true
          const current = options.getSnapshot()
          if (current.choices.some(row => row.id === value.selection) && current.selectedId !== value.selection) options.onSelect(value.selection)
          else options.onError(Object.assign(new Error('The settings host selection changed'), { code: 'SETTINGS_HOST_CHANGED' }))
        } else if (value.ready) options.onReady()
        failures = 0
      } catch (error) {
        if (lifetime.signal.aborted) return
        if (active?.aborted) continue
        options.onError(error)
        if (surfaceTerminal(error)) consumed = true
        failures++
      }
      if (consumed) { lifetime.dispose(); return }
      if (active) await lifetime.sleep(surfaceRetryDelay(options.intervalMs ?? 1000, failures, options.maxBackoffMs), active).catch(() => {})
    }
  }
  void run()
  return () => { consumed = true; lifetime.dispose() }
}

/** The child can request one displayed host ID; it never receives local RPC access. */
export function createSettingsHostRelayClient(channel: string, endpoint: SettingsHostEndpoint, intervalMs = 1000, options: SurfacePollingOptions = {}): SettingsHostClient {
  parseWorkspaceChannel(channel)
  const lifetime = new SurfaceLifecycle(options.document)
  const listeners = new Set<() => void>()
  let value: SettingsHostSnapshot | undefined
  let revision: number | undefined
  let selection: string | undefined
  let admitted: AbortSignal | undefined
  let finished = false
  const emit = () => { for (const listener of listeners) listener() }
  const run = async () => {
    let failures = 0
    while (!lifetime.signal.aborted && !finished) {
      let active: AbortSignal | undefined
      try {
        await lifetime.wait()
        active = lifetime.activeSignal
        if (admitted !== active) {
          const view = await lifetime.read(signal => endpoint({ op: 'viewState', channel }, signal), active)
          active.throwIfAborted()
          if (view.intent?.target.kind !== 'settings' || view.error !== undefined || revision !== undefined && revision !== view.revision) {
            throw Object.assign(new Error('The settings operation changed'), { code: 'CONFLICT' })
          }
          revision ??= view.revision
          admitted = active
        }
        const result = await lifetime.read(signal => endpoint(selection === undefined
          ? { op: 'pollSettingsHosts', channel, revision: revision! }
          : { op: 'selectSettingsHost', channel, revision: revision!, id: selection }, signal), active)
        active.throwIfAborted()
        const exchange = parseSettingsHostExchange(result)
        if (exchange.revision !== revision) throw Object.assign(new Error('The settings operation changed'), { code: 'CONFLICT' })
        if (exchange.snapshot) { value = exchange.snapshot; emit() }
        if (exchange.selection !== undefined) finished = true
        failures = 0
      } catch (error) {
        if (lifetime.signal.aborted) return
        if (active?.aborted) continue
        // A short outage retains the native form, but a revoked revision cannot
        // keep selecting. Never carry a queued selection into a replacement view.
        if (surfaceTerminal(error)) { finished = true; value = undefined; emit() }
        failures++
      }
      if (finished) { lifetime.dispose(); return }
      if (active) await lifetime.sleep(surfaceRetryDelay(intervalMs, failures, options.maxBackoffMs), active).catch(() => {})
    }
  }
  void run()
  return {
    getSnapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    select(id) {
      if (!lifetime.signal.aborted && !finished && selection === undefined && value?.choices.some(row => row.id === id) && value.selectedId !== id) selection = id
    },
    dispose() {
      finished = true; lifetime.dispose()
      value = undefined; listeners.clear()
    },
  }
}
