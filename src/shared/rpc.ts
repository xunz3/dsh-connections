import type { InvocationDescriptor, TypertCodec, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { parseDeleteDiagnostic, parseDiagnosticDeleteResult, parseDiagnosticExportResult, parseDiagnosticList, parseDiagnosticRef, parseId, parseOpenResult, parseSave, parseSshCheck, parseSshHosts, parseTarget, parseUpdate, parseView, parseViews } from './validation.js'
import { parseWorkspaceCall, parseWorkspaceCallResult } from './workspace-rpc.js'

export const RPC_NAMESPACE = 'connections'
export const RPC_PACKAGE = '@xunz03/dsh-connections'

function codec<T>(name: string, parse: (value: unknown) => T): TypertCodec<T> {
  return { mode: 'strict', typeSymbol: `${RPC_PACKAGE}#${name}`, create: () => ({ parse }) }
}
const id = codec('ConnectionId', parseId)
const view = codec('ConnectionView', parseView)
const nothing = codec('Void', value => {
  if (value !== undefined && value !== null) throw new TypeError('Expected an empty result.')
})

export const rpcContribution: TypertRemoteContribution = {
  package: RPC_PACKAGE,
  // `remove` is reserved by Harness's client namespace service.
  descriptors: [...(['sshHosts', 'list', 'save', 'forget', 'connect', 'reconnect', 'disconnect', 'open', 'update'] as const).map((method): InvocationDescriptor => ({
    id: `${RPC_PACKAGE}#${RPC_NAMESPACE}/${method}`,
    service: RPC_NAMESPACE,
    namespace: RPC_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: method === 'list' || method === 'sshHosts' ? [] : [{ name: method === 'save' || method === 'update' ? 'input' : 'id', wire: method === 'save' || method === 'update' ? 'input' : 'id', source: 'json', codec: method === 'save' ? codec('SaveConnection', parseSave) : method === 'update' ? codec('UpdateConnection', parseUpdate) : id }],
    result: method === 'sshHosts' ? codec('SshHosts', parseSshHosts) : method === 'list' ? codec('ConnectionViews', parseViews) : method === 'open' ? codec('OpenConnection', parseOpenResult) : method === 'forget' ? nothing : view,
  })), {
    id: `${RPC_PACKAGE}#${RPC_NAMESPACE}/diagnosticRecords`, service: RPC_NAMESPACE, namespace: RPC_NAMESPACE, method: 'diagnosticRecords',
    invocation: { kind: 'direct' }, parameters: [], result: codec('ConnectionDiagnosticList', parseDiagnosticList),
  }, {
    id: `${RPC_PACKAGE}#${RPC_NAMESPACE}/exportDiagnostic`, service: RPC_NAMESPACE, namespace: RPC_NAMESPACE, method: 'exportDiagnostic',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'input', wire: 'input', source: 'json', codec: codec('ConnectionDiagnosticRef', parseDiagnosticRef) }],
    result: codec('ConnectionDiagnosticExportResult', parseDiagnosticExportResult),
  }, {
    id: `${RPC_PACKAGE}#${RPC_NAMESPACE}/deleteDiagnostic`, service: RPC_NAMESPACE, namespace: RPC_NAMESPACE, method: 'deleteDiagnostic',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'input', wire: 'input', source: 'json', codec: codec('DeleteConnectionDiagnostic', parseDeleteDiagnostic) }],
    result: codec('ConnectionDiagnosticDeleteResult', parseDiagnosticDeleteResult),
  }, {
    id: `${RPC_PACKAGE}#${RPC_NAMESPACE}/workspace`, service: RPC_NAMESPACE, namespace: RPC_NAMESPACE, method: 'workspace',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'input', wire: 'input', source: 'json', codec: codec('WorkspaceCall', parseWorkspaceCall) }],
    result: codec('WorkspaceCallResult', parseWorkspaceCallResult),
  }, {
    id: `${RPC_PACKAGE}#${RPC_NAMESPACE}/checkSsh`, service: RPC_NAMESPACE, namespace: RPC_NAMESPACE, method: 'checkSsh',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'target', wire: 'target', source: 'json', codec: codec('SshTarget', parseTarget) }],
    result: codec('SshCheckResult', parseSshCheck),
  }],
}
