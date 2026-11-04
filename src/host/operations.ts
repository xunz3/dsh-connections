import { Service, type Context } from '@deepseek-ai/cordis'
import type { ConnectionDiagnosticsApi, ConnectionOperationSnapshot, ConnectionsApi, SaveConnection, UpdateConnection } from '../shared/types.js'
import { parseDeleteDiagnostic, parseDiagnosticDeleteResult, parseDiagnosticExportResult, parseDiagnosticList, parseDiagnosticRef, parseId, parseOpenResult, parseSave, parseSshCheck, parseSshHosts, parseTarget, parseUpdate, parseView, parseViews } from '../shared/validation.js'
import { parseWorkspaceCall, type WorkspaceCall, type WorkspaceCallResult } from '../shared/workspace-rpc.js'
import { parseWorkspaceResponse, WorkspaceProtocolError, WORKSPACE_ERRORS } from '../shared/workspace-protocol.js'

export type WorkspaceHandler = (input: WorkspaceCall) => Promise<unknown>
export const CONNECTION_OPERATION_ERRORS = {
  UNAVAILABLE: 'The Connections service is unavailable. Check Settings → Connections, then retry.',
  NOT_FOUND: 'This connection no longer exists.',
  BUSY: 'A connection operation is already in progress. Wait for it to finish, then retry.',
  INVALID_INPUT: 'The connection request is invalid. Check Settings → Connections.',
  CONFLICT: 'This connection changed. Refresh its state before trying again.',
} as const
export class ConnectionOperationError extends Error {
  constructor(readonly code: keyof typeof CONNECTION_OPERATION_ERRORS) { super(CONNECTION_OPERATION_ERRORS[code]); this.name = 'ConnectionOperationError' }
}

/** Both adapters use this Host-owned core; Remote identity and tool approval stay at their boundaries. */
export class ConnectionsOperations extends Service implements ConnectionsApi {
  readonly diagnostics?: ConnectionDiagnosticsApi
  private disposed = false
  constructor(ctx: Context, private readonly api: ConnectionsApi, private readonly workspaceHandler?: WorkspaceHandler) {
    super(ctx, 'connectionOperations')
    ctx.effect(() => () => { this.disposed = true })
    const diagnostics = api.diagnostics
    if (diagnostics) this.diagnostics = {
      list: () => this.invoke(async () => parseDiagnosticList(await diagnostics.list())),
      export: input => this.invoke(async () => parseDiagnosticExportResult(await diagnostics.export(parseDiagnosticRef(input)))),
      remove: input => this.invoke(async () => parseDiagnosticDeleteResult(await diagnostics.remove(parseDeleteDiagnostic(input)))),
    }
  }
  private async invoke<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new ConnectionOperationError('UNAVAILABLE')
    try {
      const result = await operation()
      if (this.disposed) throw new ConnectionOperationError('UNAVAILABLE')
      return result
    } catch (error) {
      if (error instanceof ConnectionOperationError) throw error
      // The Gateway preserves ordinary Error.message. Never forward arbitrary
      // provider, child-process or I/O text across either caller boundary.
      const message = error instanceof Error ? error.message : ''
      if (message === 'This connection no longer exists.') throw new ConnectionOperationError('NOT_FOUND')
      if (message === 'This connection has changed.' || message === 'Connection changed. Select the workspace again.' || message === 'Connection changed. Open the Host again.') throw new ConnectionOperationError('CONFLICT')
      if (message === 'A remote update is already in progress.' || message === 'Too many SSH checks are waiting. Wait for a check to finish, then retry.') throw new ConnectionOperationError('BUSY')
      throw new ConnectionOperationError('UNAVAILABLE')
    }
  }
  operationSnapshot(value: string): Promise<ConnectionOperationSnapshot> {
    const id = parseId(value)
    return this.invoke(async () => {
      if (!this.api.operationSnapshot) throw new ConnectionOperationError('UNAVAILABLE')
      const snapshot = await this.api.operationSnapshot(id)
      if (typeof snapshot.revision !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot.revision)) throw new ConnectionOperationError('UNAVAILABLE')
      const view = parseView(snapshot.view)
      if (view.id !== id) throw new ConnectionOperationError('CONFLICT')
      return { view, revision: snapshot.revision }
    })
  }
  list() { return this.invoke(async () => parseViews(await this.api.list())) }
  sshHosts() { return this.invoke(async () => parseSshHosts(await this.api.sshHosts())) }
  checkSsh(target: string) { const input = parseTarget(target); return this.invoke(async () => parseSshCheck(await this.api.checkSsh(input))) }
  save(value: SaveConnection, expectedRevision?: string) { const input = parseSave(value); return this.invoke(async () => parseView(await this.api.save(input, expectedRevision))) }
  remove(value: string, expectedRevision?: string) { const id = parseId(value); return this.invoke(() => this.api.remove(id, expectedRevision)) }
  connect(value: string, expectedRevision?: string) { const id = parseId(value); return this.invoke(async () => parseView(await this.api.connect(id, expectedRevision))) }
  reconnect(value: string, expectedRevision?: string) { const id = parseId(value); return this.invoke(async () => parseView(await this.api.reconnect(id, expectedRevision))) }
  disconnect(value: string, expectedRevision?: string) { const id = parseId(value); return this.invoke(async () => parseView(await this.api.disconnect(id, expectedRevision))) }
  update(value: UpdateConnection, expectedRevision?: string) { const input = parseUpdate(value); return this.invoke(async () => parseView(await this.api.update(input, expectedRevision))) }
  open(value: string) { const id = parseId(value); return this.invoke(async () => parseOpenResult(await this.api.open(id))) }
  async workspace(value: WorkspaceCall): Promise<WorkspaceCallResult> {
    const input = parseWorkspaceCall(value)
    return this.invoke(async () => {
      try {
        if (!this.workspaceHandler) throw new WorkspaceProtocolError('UNAVAILABLE')
        return { request: input.request, response: parseWorkspaceResponse(input.request.op, await this.workspaceHandler(input)) }
      } catch (error) {
        // Preserve only the declared workspace domain code, never remote text.
        const code = error instanceof WorkspaceProtocolError ? error.code : 'UNAVAILABLE'
        return { request: input.request, response: parseWorkspaceResponse(input.request.op, {
          ok: false, error: { code, message: WORKSPACE_ERRORS[code] },
        }) }
      }
    })
  }
}

declare module '@deepseek-ai/cordis' { interface Context { connectionOperations: ConnectionsOperations } }
