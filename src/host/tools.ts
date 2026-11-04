import type { Context } from '@deepseek-ai/cordis'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ConnectionOperationError, ConnectionsOperations } from './operations.js'
import { parseId, parseSave, parseSupportedVersion, parseTarget, parseTransportId } from '../shared/validation.js'
import { readWorkspaceCatalog, type WorkspaceApi } from '../shared/workspace-rpc.js'
import { parseWorkspaceRequest, WorkspaceProtocolError, type WorkspaceRequest } from '../shared/workspace-protocol.js'
import type { ConnectionView } from '../shared/types.js'

export const CONNECTION_TOOL_NAME = 'connections'
const mutations = ['renameWorkspace', 'forgetWorkspace', 'renameSession', 'archiveSession', 'pinSession'] as const
type Mutation = Extract<WorkspaceRequest, { op: typeof mutations[number] }>
type Input =
  | { action: 'list' | 'ssh_hosts'; offset: number; limit: number }
  | { action: 'check_ssh'; target: string }
  | { action: 'connect' | 'reconnect' | 'disconnect' | 'forget'; id: string }
  | { action: 'rename'; id: string; name: string }
  | { action: 'update'; id: string; version?: string }
  | { action: 'catalog'; id: string; kind: 'workspaces' | 'sessions'; offset: number; limit: number }
  | { action: 'mutate'; id: string; expectedTransportId: string; request: Mutation }
const readActions = new Set(['list', 'ssh_hosts', 'catalog', 'check_ssh'])
function page(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new TypeError('Invalid page.')
  return value as number
}
/** Validate per-action keys too; no generic workspace/channel or credential escape hatch. */
export function parseConnectionToolInput(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid connection action.')
  const input = value as Record<string, unknown>
  const keys = (allowed: string[]) => { if (Object.keys(input).some(key => !['action', ...allowed].includes(key))) throw new TypeError('Invalid action parameters.') }
  const pagination = () => {
    const limit = page(input.limit, 20, 50)
    if (!limit) throw new TypeError('Invalid page.')
    return { offset: page(input.offset, 0, Number.MAX_SAFE_INTEGER), limit }
  }
  switch (input.action) {
    case 'list': case 'ssh_hosts': keys(['offset', 'limit']); return { action: input.action, ...pagination() }
    case 'check_ssh': keys(['target']); return { action: input.action, target: parseTarget(input.target) }
    case 'connect': case 'reconnect': case 'disconnect': case 'forget':
      keys(['id']); return { action: input.action, id: parseId(input.id) }
    case 'rename':
      keys(['id', 'name']); return { action: input.action, id: parseId(input.id), name: parseSave({ name: input.name, target: 'validation-only' }).name }
    case 'update':
      keys(['id', 'version']); return { action: input.action, id: parseId(input.id), ...(input.version === undefined ? {} : { version: parseSupportedVersion(input.version) }) }
    case 'catalog': {
      keys(['id', 'kind', 'offset', 'limit'])
      if (input.kind !== undefined && input.kind !== 'workspaces' && input.kind !== 'sessions') throw new TypeError('Invalid catalog kind.')
      return { action: input.action, id: parseId(input.id), kind: input.kind ?? 'workspaces', ...pagination() }
    }
    case 'mutate': {
      keys(['id', 'expectedTransportId', 'request'])
      const request = parseWorkspaceRequest(input.request)
      if (!(mutations as readonly string[]).includes(request.op)) throw new TypeError('Unsupported workspace action.')
      return { action: input.action, id: parseId(input.id), expectedTransportId: parseTransportId(input.expectedTransportId), request: request as Mutation }
    }
    default: throw new TypeError('Unsupported connection action.')
  }
}
const string = { type: 'string' } as const
const requestSchema: JsonSchemaNode = { oneOf: [
  ...(['renameWorkspace', 'renameSession'] as const).map(op => ({ type: 'object' as const, properties: { op: { const: op }, id: string, title: string }, required: ['op', 'id', 'title'], additionalProperties: false })),
  { type: 'object', properties: { op: { const: 'forgetWorkspace' }, id: string }, required: ['op', 'id'], additionalProperties: false },
  { type: 'object', properties: { op: { const: 'archiveSession' }, id: string, archived: { type: 'boolean' }, stopActivity: { const: true } }, required: ['op', 'id', 'archived'], additionalProperties: false },
  { type: 'object', properties: { op: { const: 'pinSession' }, id: string, pinned: { type: 'boolean' } }, required: ['op', 'id', 'pinned'], additionalProperties: false },
] }
function slice<T>(items: T[], input: { offset: number; limit: number }) {
  const values = items.slice(input.offset, input.offset + input.limit)
  return { items: values, total: items.length, ...(input.offset + values.length < items.length ? { nextOffset: input.offset + values.length } : {}) }
}

type Approve = (input: Input, exec: ToolRunContext, signal: AbortSignal, view: ConnectionView) => Promise<boolean>
/** Narrowed public approval seam, verified against Inspect and the exact Tools contract. */
interface Approval {
  request(input: { agent: NonNullable<ToolRunContext['agent']>; toolName: string; callId: ToolRunContext['callId']; reason: string; displayReason: { en: string; zh: string }; signal: AbortSignal }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

/** No runtime SDK import: optional tools must not become a prerequisite for the UI. */
export function createConnectionTool(core: ConnectionsOperations, lifetime?: AbortSignal, approve?: Approve): ToolDefinition {
  return {
    name: CONNECTION_TOOL_NAME,
    description: 'Inspect and manage saved SSH connections and their remote workspaces. Connection changes and workspace writes require native approval. Add targets, enter launch credentials, and confirm record cleanup only in Settings → Connections. Never submit credentials here.',
    parameters: {
      type: 'object', required: ['action'], additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'ssh_hosts', 'check_ssh', 'rename', 'connect', 'reconnect', 'disconnect', 'forget', 'update', 'catalog', 'mutate'], description: 'list/ssh_hosts: paged discovery; check_ssh: SSH authentication/remote-command preflight; rename: change the saved connection name; connect/reconnect: enable saved access (managed mode may install/start its service); disconnect: disable local access without stopping remote work; forget: permanently remove the local connection and its stored credential; update: explicit managed Host maintenance with downtime; catalog: remote native identities and transportId; mutate: one workspace write, never automatically replayed.' },
        id: { type: 'string', description: 'Saved connection ID from list; required except for list, ssh_hosts and check_ssh.' },
        name: { type: 'string', description: 'Only for rename: nonempty connection name, at most 80 characters, without control characters.' },
        target: { type: 'string', description: 'Only for check_ssh: SSH alias or user@hostname; ports/options belong in SSH config.' },
        version: { type: 'string', description: 'Only for update: exact supported Harness release; omit for this build’s latest compatible release.' },
        kind: { type: 'string', enum: ['workspaces', 'sessions'], description: 'Only for catalog; defaults to workspaces. Search covers received catalog data, not server-side full text.' },
        offset: { type: 'integer', description: 'Only for list, ssh_hosts or catalog; nonnegative offset, default 0.' },
        limit: { type: 'integer', description: 'Only for list, ssh_hosts or catalog; 1–50 rows, default 20.' },
        expectedTransportId: { type: 'string', description: 'Required for mutate: transportId from the catalog that supplied these native IDs. A mismatch refuses the write; refresh and reconsider instead of replaying.' },
        request: { ...requestSchema, description: 'Only for mutate. IDs are remote native identities. forgetWorkspace removes registry membership, not project files; archiveSession with stopActivity stops active work.' },
      },
    },
    output: {
      schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, value: {}, error: { type: 'object', required: ['code', 'message'], properties: { code: string, message: string }, additionalProperties: false } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    // list() can reconcile transports and discovery can migrate credential keys;
    // do not claim these operations commute with another mutating tool.
    async execute(value, exec) {
      const signal = lifetime ? AbortSignal.any([exec.signal, lifetime]) : exec.signal
      const failure = (code: string, message: string) => ({ ok: false, error: { code, message } })
      let input: Input
      try { input = parseConnectionToolInput(value) }
      catch { return failure('INVALID_INPUT', 'Invalid Connections action or parameters. Credentials and maintenance confirmations belong in Settings.') }
      try {
        signal.throwIfAborted()
        let expectedRevision: string | undefined
        let approvedView: ConnectionView | undefined
        if (!readActions.has(input.action) && 'id' in input) {
          let view: ConnectionView
          if (input.action === 'mutate') {
            const current = (await core.list()).find(row => row.id === input.id)
            if (!current) throw new ConnectionOperationError('NOT_FOUND')
            if (current.phase !== 'connected' || current.transportId !== input.expectedTransportId) throw new ConnectionOperationError('CONFLICT')
            view = current
          } else {
            const snapshot = await core.operationSnapshot(input.id)
            view = snapshot.view
            expectedRevision = snapshot.revision
          }
          approvedView = view
          signal.throwIfAborted()
          const allowed = approve && await approve(input, exec, signal, view)
          signal.throwIfAborted()
          if (!allowed) return failure('APPROVAL_REQUIRED', 'This connection change was not approved. No operation was started.')
        }
        let result: unknown
        switch (input.action) {
          case 'list': result = slice(await core.list(), input); break
          case 'ssh_hosts': result = slice(await core.sshHosts(), input); break
          case 'check_ssh': result = await core.checkSsh(input.target); break
          case 'rename': result = await core.save({ id: input.id, name: input.name, target: approvedView!.target, ...(approvedView!.mode ? { mode: approvedView!.mode } : {}) }, expectedRevision); break
          case 'connect': case 'reconnect': case 'disconnect': result = await core[input.action](input.id, expectedRevision); break
          case 'forget': await core.remove(input.id, expectedRevision); result = { removed: true }; break
          case 'update': result = await core.update({ id: input.id, ...(input.version ? { version: input.version } : {}) }, expectedRevision); break
          case 'catalog': {
            const row = (await core.list()).find(row => row.id === input.id)
            if (!row) throw new ConnectionOperationError('NOT_FOUND')
            if (row.phase !== 'connected' || !row.transportId) throw new ConnectionOperationError('UNAVAILABLE')
            const transportId = row.transportId
            const api: WorkspaceApi = { async workspace(id, request) {
              signal.throwIfAborted()
              const result = await core.workspace({ id, request, expectedTransportId: transportId })
              signal.throwIfAborted()
              if (!result.response.ok) throw new WorkspaceProtocolError(result.response.error.code)
              return result.response.value as never
            } }
            const { catalog, revision } = await readWorkspaceCatalog(api, input.id)
            // Keep each response bounded even if a workspace owns many sessions or
            // a legal filesystem path is enormous. Session membership has its own page.
            const rows = input.kind === 'sessions'
              ? catalog.sessions.map(({ id, title, running, blank, origin, parentSessionId }) => ({ id, title, running, blank, ...(origin ? { origin } : {}), ...(parentSessionId ? { parentSessionId } : {}) }))
              : catalog.workspaces.map(({ id, title, path, sessionIds }) => ({ id, title, path: path.slice(0, 1024), pathTruncated: path.length > 1024, sessionCount: sessionIds.length }))
            result = { id: input.id, transportId, revision, kind: input.kind, ...slice<unknown>(rows, input) }
            break
          }
          case 'mutate': {
            const response = await core.workspace({ id: input.id, request: input.request, expectedTransportId: input.expectedTransportId })
            if (!response.response.ok) throw new WorkspaceProtocolError(response.response.error.code)
            result = response.response.value
          }
        }
        // Drain started shared operations before settling; cancellation does not
        // undo a committed write, disable another UI caller, or replay anything.
        signal.throwIfAborted()
        return { ok: true, value: result }
      } catch (error) {
        if (signal.aborted) return failure('CANCELLED', 'The call was cancelled. A started operation may have completed; inspect authoritative state before retrying.')
        if (error instanceof ConnectionOperationError || error instanceof WorkspaceProtocolError) return failure(error.code, error.message)
        return failure('UNAVAILABLE', 'The Connections operation is unavailable. Inspect Settings → Connections before retrying.')
      }
    },
  }
}

export function mountConnectionTools(ctx: Context, core: ConnectionsOperations): void {
  ctx.inject(['tools'], scope => {
    const lifetime = new AbortController()
    scope.effect(() => () => lifetime.abort())
    scope.tools.register(createConnectionTool(core, lifetime.signal, async (input, exec, signal, view) => {
      // Ask inside the body: a reorderable pre-execute listener cannot bypass
      // this operation-owned gate by returning allow before our listener runs.
      const approval = scope.get('approval' as never) as Approval | undefined
      if (!exec.agent || !approval) return false
      const detail = input.action === 'mutate' ? `${input.request.op}${input.request.op === 'archiveSession' && input.request.stopActivity ? ' (stop active work)' : ''}` : input.action
      const host = `${view.name} (${view.target}, ${view.mode ?? 'existing'}${view.runtime ? `, Harness ${view.runtime.version}` : ''})`
      const reason = `Connections ${detail} on ${host}, ${view.id}. Updates interrupt remote Host availability; forgetting permanently deletes the locally stored connection credential. Workspace writes affect remote authoritative data.`
      return await approval.request({ agent: exec.agent, toolName: CONNECTION_TOOL_NAME, callId: exec.callId, reason,
        displayReason: { en: reason, zh: `对已保存连接 ${host}（${view.id}）执行 ${detail}。此操作改变连接意图或远端工作区状态；更新会有停机，删除连接会永久丢弃本机保存的凭据，stop active work 会停止远端活动。` }, signal }) === 'allowed-once'
    }))
  })
}
