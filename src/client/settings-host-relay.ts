import { parseSettingsHostExchange, parseSettingsHostSnapshot, type SettingsHostSnapshot } from '../shared/settings-host-protocol.js'
import { parseWorkspaceChannel, type WorkspaceRequest, type WorkspaceResultMap } from '../shared/workspace-protocol.js'
import type { SettingsHostClient } from './settings-host-bridge.js'

export type SettingsHostEndpoint = <R extends WorkspaceRequest>(request: R, signal: AbortSignal) => Promise<WorkspaceResultMap[R['op']]>
function terminal(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && ['BAD_REQUEST', 'NOT_FOUND', 'CONFLICT', 'NOT_EMBEDDED', 'INCOMPATIBLE_PROTOCOL'].includes(String(error.code))
}

/** Native webviews have no parent Window. Reuse the authenticated view lease for menu metadata only. */
export function bindSettingsHostRelay(options: {
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
  const lifetime = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let consumed = false
  const tick = async () => {
    try {
      const value = parseSettingsHostExchange(await options.endpoint({
        op: 'publishSettingsHosts', channel: options.channel, revision: options.revision,
        snapshot: parseSettingsHostSnapshot(options.getSnapshot()),
      }, lifetime.signal))
      if (lifetime.signal.aborted || value.revision !== options.revision) return
      if (value.selection !== undefined) {
        // Recheck the live source list; a removed connection cannot navigate from stale metadata.
        consumed = true
        const current = options.getSnapshot()
        if (current.choices.some(row => row.id === value.selection) && current.selectedId !== value.selection) options.onSelect(value.selection)
        else options.onError(Object.assign(new Error('The settings host selection changed'), { code: 'SETTINGS_HOST_CHANGED' }))
      } else if (value.ready) options.onReady()
    } catch (error) {
      if (!lifetime.signal.aborted) options.onError(error)
      if (terminal(error)) consumed = true
    }
    finally {
      if (!lifetime.signal.aborted && !consumed) timer = setTimeout(tick, options.intervalMs ?? 1000)
    }
  }
  void tick()
  return () => { lifetime.abort(); clearTimeout(timer) }
}

/** The child can request one displayed host ID; it never receives local RPC access. */
export function createSettingsHostRelayClient(channel: string, endpoint: SettingsHostEndpoint, intervalMs = 1000): SettingsHostClient {
  parseWorkspaceChannel(channel)
  const lifetime = new AbortController()
  const listeners = new Set<() => void>()
  let value: SettingsHostSnapshot | undefined
  let revision: number | undefined
  let selection: string | undefined
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const emit = () => { for (const listener of listeners) listener() }
  const tick = async () => {
    try {
      if (revision === undefined) {
        const view = await endpoint({ op: 'viewState', channel }, lifetime.signal)
        if (lifetime.signal.aborted) return
        if (view.intent?.target.kind !== 'settings') { finished = true; return }
        revision = view.revision
      }
      const exchange = parseSettingsHostExchange(await endpoint(selection === undefined
        ? { op: 'pollSettingsHosts', channel, revision }
        : { op: 'selectSettingsHost', channel, revision, id: selection }, lifetime.signal))
      if (lifetime.signal.aborted || exchange.revision !== revision) return
      if (exchange.snapshot) { value = exchange.snapshot; emit() }
      if (exchange.selection !== undefined) finished = true
    } catch (error) {
      // A short interruption retains the native form; a revoked operation cannot keep selecting.
      if (terminal(error)) { finished = true; value = undefined; emit() }
    } finally { if (!lifetime.signal.aborted && !finished) timer = setTimeout(tick, intervalMs) }
  }
  void tick()
  return {
    getSnapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    select(id) {
      if (!lifetime.signal.aborted && !finished && selection === undefined && value?.choices.some(row => row.id === id) && value.selectedId !== id) selection = id
    },
    dispose() {
      lifetime.abort(); clearTimeout(timer)
      value = undefined; listeners.clear()
    },
  }
}
