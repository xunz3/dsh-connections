import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionsApi, ConnectionView, SaveConnection, SshCheckResult, UpdateConnection } from '../shared/types.js'
import { rpcContribution } from '../shared/rpc.js'
import { parseOpenResult, parseSshCheck, parseSshHosts, parseView, parseViews } from '../shared/validation.js'
import { parseWorkspaceCallResult, type WorkspaceApi, type WorkspaceCall, type WorkspaceCallResult } from '../shared/workspace-rpc.js'
import type { WorkspaceRequest, WorkspaceResultMap } from '../shared/workspace-protocol.js'

interface RemoteApi {
  checkSsh(target: string): Promise<RemoteResult<SshCheckResult>>
  sshHosts(): Promise<RemoteResult<string[]>>
  list(): Promise<RemoteResult<ConnectionView[]>>
  save(input: SaveConnection): Promise<RemoteResult<ConnectionView>>
  forget(id: string): Promise<RemoteResult<void>>
  connect(id: string): Promise<RemoteResult<ConnectionView>>
  reconnect(id: string): Promise<RemoteResult<ConnectionView>>
  disconnect(id: string): Promise<RemoteResult<ConnectionView>>
  update(input: UpdateConnection): Promise<RemoteResult<ConnectionView>>
  open(id: string): Promise<RemoteResult<{ url: string }>>
  workspace(input: WorkspaceCall): Promise<RemoteResult<WorkspaceCallResult>>
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
export function createApi(ctx: Context): ConnectionsApi & WorkspaceApi {
  const api = ctx.remote.connections
  return {
    checkSsh: target => unwrap(api.checkSsh(target), parseSshCheck),
    sshHosts: () => unwrap(api.sshHosts(), parseSshHosts),
    list: () => unwrap(api.list(), parseViews),
    save: input => unwrap(api.save(input), parseView),
    remove: id => unwrap(api.forget(id), () => undefined),
    connect: id => unwrap(api.connect(id), parseView),
    reconnect: id => unwrap(api.reconnect(id), parseView),
    disconnect: id => unwrap(api.disconnect(id), parseView),
    update: input => unwrap(api.update(input), parseView),
    open: id => unwrap(api.open(id), parseOpenResult),
    async workspace<R extends WorkspaceRequest>(id: string, request: R): Promise<WorkspaceResultMap[R['op']]> {
      const result = await unwrap(api.workspace({ id, request }), parseWorkspaceCallResult)
      if (result.request.op !== request.op) throw new Error('The workspace response did not match the request.')
      if (!result.response.ok) throw Object.assign(new Error(result.response.error.message), { code: result.response.error.code })
      return result.response.value as WorkspaceResultMap[R['op']]
    },
  }
}
