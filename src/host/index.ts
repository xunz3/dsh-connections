import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-credentials'
import { ConnectionsManager } from './manager.js'
import { createStore } from './store.js'
import { mountRpc } from './rpc.js'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installWorkspaceEndpoint } from './workspace-endpoint.js'

export const name = 'connections'
export const inject = ['credentials', 'typert']
// Embedded profiles use the separate remote artifact. A local configuration
// must never silently turn off its connection manager or replace its layout.
export interface Config { embedded?: false }
export const Config: Schema<Config> = Schema.object({ embedded: Schema.const(false).default(false).hidden() })
export function apply(ctx: Context): void {
  const workspaces = installWorkspaceEndpoint(ctx, { embedded: false })
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
