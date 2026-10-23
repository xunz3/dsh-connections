import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionsApi, ConnectionView, SaveConnection, UpdateConnection } from '../shared/types.js'
import { rpcContribution } from '../shared/rpc.js'
import { parseOpenResult, parseView, parseViews } from '../shared/validation.js'

interface RemoteApi {
  list(): Promise<RemoteResult<ConnectionView[]>>
  save(input: SaveConnection): Promise<RemoteResult<ConnectionView>>
  forget(id: string): Promise<RemoteResult<void>>
  connect(id: string): Promise<RemoteResult<ConnectionView>>
  disconnect(id: string): Promise<RemoteResult<ConnectionView>>
  update(input: UpdateConnection): Promise<RemoteResult<ConnectionView>>
  open(id: string): Promise<RemoteResult<{ url: string }>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap { connections: RemoteApi }
}

async function unwrap<T>(pending: Promise<RemoteResult<T>>, parse: (value: unknown) => T): Promise<T> {
  const result = await pending
  if (!result.ok) throw result.error
  return parse(result.value)
}

export async function mountRpc(ctx: Context): Promise<void> { await ctx.remote.$mount(rpcContribution) }
export function createApi(ctx: Context): ConnectionsApi {
  const api = ctx.remote.connections
  return {
    list: () => unwrap(api.list(), parseViews),
    save: input => unwrap(api.save(input), parseView),
    remove: id => unwrap(api.forget(id), () => undefined),
    connect: id => unwrap(api.connect(id), parseView),
    disconnect: id => unwrap(api.disconnect(id), parseView),
    update: input => unwrap(api.update(input), parseView),
    open: id => unwrap(api.open(id), parseOpenResult),
  }
}
