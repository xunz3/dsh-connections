import type { Context } from '@deepseek-ai/cordis'
import { Config as NativeShortcutsConfig, apply as applyNativeShortcuts } from '@deepseek-ai/dsh-client-shortcuts'
import type {} from '@deepseek-ai/dsh-credentials'
import { ConnectionsManager } from './manager.js'
import { createStore } from './store.js'
import { mountRpc } from './rpc.js'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installWorkspaceEndpoint } from './workspace-endpoint.js'

export const name = 'connections'
export const inject = ['credentials', 'typert']
export interface Config { embedded?: boolean; shortcuts?: { stopSequenceMs?: number } }
export function apply(ctx: Context, config: Config = {}): void {
  const workspaces = installWorkspaceEndpoint(ctx, { embedded: config.embedded === true })
  if (config.embedded === true) {
    ctx.on('webserver/index-inject', table => {
      table.push({ kind: 'script', placement: 'head', text: 'window.__DSH_CONNECTIONS_EMBEDDED__=true;' })
    })
    return
  }
  // The composed client retains the native Host schema and timing injection too.
  applyNativeShortcuts(ctx, NativeShortcutsConfig(config.shortcuts ?? {}))
  const manager = new ConnectionsManager(createStore(ctx.credentials))
  const lifetime = new AbortController()
  ctx.effect(() => {
    void manager.restore().catch(() => {})
    return () => { lifetime.abort(); return manager.dispose() }
  })
  mountRpc(ctx, manager, input => input.id === 'local'
    ? workspaces.handle(input.request, lifetime.signal)
    : manager.workspace(input.id, input.request))
}
