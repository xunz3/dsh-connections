import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { RPC_NAMESPACE, RPC_PACKAGE, rpcContribution } from '../shared/rpc.js'
import { parseId, parseOpenResult, parseSave, parseSshHosts, parseUpdate, parseView, parseViews } from '../shared/validation.js'
import type { ConnectionsApi, SaveConnection, UpdateConnection } from '../shared/types.js'
import { parseWorkspaceCall, type WorkspaceCall } from '../shared/workspace-rpc.js'
import { parseWorkspaceResponse } from '../shared/workspace-protocol.js'

export type WorkspaceHandler = (input: WorkspaceCall) => Promise<unknown>

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'connections/owner-required': Record<string, never> }
}

/** Every operation, including reads and launch URL access, requires the authenticated owner. */
export class ConnectionsRpc extends TypertRemoteService {
  constructor(ctx: Context, private readonly api: ConnectionsApi, private readonly workspaceHandler?: WorkspaceHandler) { super(ctx, RPC_NAMESPACE) }
  private owner(): void {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('connections/owner-required', 'Only the Harness owner can manage connections.', {})
    }
  }
  async list() { this.owner(); return parseViews(await this.api.list()) }
  async sshHosts() { this.owner(); return parseSshHosts(await this.api.sshHosts()) }
  async save(input: SaveConnection) { this.owner(); return parseView(await this.api.save(parseSave(input))) }
  async forget(id: string) { this.owner(); await this.api.remove(parseId(id)) }
  async connect(id: string) { this.owner(); return parseView(await this.api.connect(parseId(id))) }
  async disconnect(id: string) { this.owner(); return parseView(await this.api.disconnect(parseId(id))) }
  async update(input: UpdateConnection) { this.owner(); return parseView(await this.api.update(parseUpdate(input))) }
  async open(id: string) { this.owner(); return parseOpenResult(await this.api.open(parseId(id))) }
  async workspace(value: WorkspaceCall) {
    this.owner()
    const input = parseWorkspaceCall(value)
    if (!this.workspaceHandler) throw new Error('The workspace service is unavailable.')
    return { request: input.request, response: parseWorkspaceResponse(input.request.op, await this.workspaceHandler(input)) }
  }
}

export function mountRpc(ctx: Context, api: ConnectionsApi, workspaceHandler?: WorkspaceHandler): void {
  new ConnectionsRpc(ctx, api, workspaceHandler)
  ctx.typert.register({ package: RPC_PACKAGE, face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: rpcContribution.descriptors })
}
