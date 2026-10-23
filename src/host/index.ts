import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import { ConnectionsManager } from './manager.js'
import { createStore } from './store.js'
import { mountRpc } from './rpc.js'

export const name = 'connections'
export const inject = ['credentials', 'typert']
export function apply(ctx: Context): void {
  const manager = new ConnectionsManager(createStore(ctx.credentials))
  ctx.effect(() => () => manager.dispose())
  mountRpc(ctx, manager)
}
