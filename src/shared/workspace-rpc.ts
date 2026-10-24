import { parseId } from './validation.js'
import { parseWorkspaceRequest, parseWorkspaceResponse, type WorkspaceRequest, type WorkspaceResponse, type WorkspaceResultMap } from './workspace-protocol.js'

export interface WorkspaceCall { id: string; request: WorkspaceRequest }
export interface WorkspaceCallResult { request: WorkspaceRequest; response: WorkspaceResponse }
export interface WorkspaceApi {
  workspace<R extends WorkspaceRequest>(id: string, request: R): Promise<WorkspaceResultMap[R['op']]>
}
export function parseWorkspaceCall(value: unknown): WorkspaceCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid workspace request.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => key !== 'id' && key !== 'request')) throw new TypeError('Invalid workspace request.')
  return { id: input.id === 'local' ? 'local' : parseId(input.id), request: parseWorkspaceRequest(input.request) }
}
export function parseWorkspaceCallResult(value: unknown): WorkspaceCallResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid workspace response.')
  const input = value as Record<string, unknown>
  const request = parseWorkspaceRequest(input.request)
  return { request, response: parseWorkspaceResponse(request.op, input.response) }
}
