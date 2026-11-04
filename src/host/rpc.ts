import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { RPC_NAMESPACE, RPC_PACKAGE, rpcContribution } from '../shared/rpc.js'
import { parseDeleteDiagnostic, parseDiagnosticDeleteResult, parseDiagnosticExportResult, parseDiagnosticList, parseDiagnosticRef } from '../shared/validation.js'
import type { ConnectionDiagnosticRef, ConnectionsApi, DeleteConnectionDiagnostic, SaveConnection, UpdateConnection } from '../shared/types.js'
import type { WorkspaceCall } from '../shared/workspace-rpc.js'
import { ConnectionOperationError, ConnectionsOperations, type CONNECTION_OPERATION_ERRORS, type WorkspaceHandler } from './operations.js'
export type { WorkspaceHandler } from './operations.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'connections/owner-required': Record<string, never>
    'connections/operation-failed': { code: keyof typeof CONNECTION_OPERATION_ERRORS }
  }
}

/** Remote authentication is independent from the shared, same-process business core. */
export class ConnectionsRpc extends TypertRemoteService {
  private readonly api: ConnectionsOperations
  constructor(ctx: Context, api: ConnectionsApi, workspaceHandler?: WorkspaceHandler) {
    super(ctx, RPC_NAMESPACE)
    this.api = api instanceof ConnectionsOperations ? api : new ConnectionsOperations(ctx, api, workspaceHandler)
  }
  private owner(): void {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('connections/owner-required', 'Only the Harness owner can manage connections.', {})
    }
  }
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    this.owner()
    try { return await operation() }
    catch (error) {
      if (error instanceof ConnectionOperationError) throw new RemoteError('connections/operation-failed', error.message, { code: error.code })
      throw error
    }
  }
  list() { return this.call(() => this.api.list()) }
  async diagnosticRecords() {
    this.owner()
    try {
      if (!this.api.diagnostics) throw new Error()
      return parseDiagnosticList(await this.api.diagnostics.list())
    } catch { throw new Error('Connection record diagnostics are unavailable.') }
  }
  async exportDiagnostic(value: ConnectionDiagnosticRef) {
    this.owner()
    const input = parseDiagnosticRef(value)
    try {
      if (!this.api.diagnostics) throw new Error()
      return parseDiagnosticExportResult(await this.api.diagnostics.export(input))
    } catch { return parseDiagnosticExportResult({ ok: false, code: 'UNAVAILABLE' }) }
  }
  async deleteDiagnostic(value: DeleteConnectionDiagnostic) {
    this.owner()
    const input = parseDeleteDiagnostic(value)
    try {
      if (!this.api.diagnostics) throw new Error()
      return parseDiagnosticDeleteResult(await this.api.diagnostics.remove(input))
    } catch { return parseDiagnosticDeleteResult({ ok: false, code: 'UNAVAILABLE' }) }
  }
  sshHosts() { return this.call(() => this.api.sshHosts()) }
  checkSsh(target: string) { return this.call(() => this.api.checkSsh(target)) }
  save(input: SaveConnection) { return this.call(() => this.api.save(input)) }
  forget(id: string) { return this.call(() => this.api.remove(id)) }
  connect(id: string) { return this.call(() => this.api.connect(id)) }
  reconnect(id: string) { return this.call(() => this.api.reconnect(id)) }
  disconnect(id: string) { return this.call(() => this.api.disconnect(id)) }
  update(input: UpdateConnection) { return this.call(() => this.api.update(input)) }
  open(id: string) { return this.call(() => this.api.open(id)) }
  workspace(value: WorkspaceCall) { return this.call(() => this.api.workspace(value)) }
}

export function mountRpc(ctx: Context, api: ConnectionsApi, workspaceHandler?: WorkspaceHandler): void {
  new ConnectionsRpc(ctx, api, workspaceHandler)
  ctx.typert.register({ package: RPC_PACKAGE, face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: rpcContribution.descriptors })
}
