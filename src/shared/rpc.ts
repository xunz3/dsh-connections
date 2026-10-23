import type { InvocationDescriptor, TypertCodec, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { parseId, parseOpenResult, parseSave, parseUpdate, parseView, parseViews } from './validation.js'

export const RPC_NAMESPACE = 'connections'
export const RPC_PACKAGE = '@xunz/dsh-connections'

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
  descriptors: (['list', 'save', 'forget', 'connect', 'disconnect', 'open', 'update'] as const).map((method): InvocationDescriptor => ({
    id: `${RPC_PACKAGE}#${RPC_NAMESPACE}/${method}`,
    service: RPC_NAMESPACE,
    namespace: RPC_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: method === 'list' ? [] : [{ name: method === 'save' || method === 'update' ? 'input' : 'id', wire: method === 'save' || method === 'update' ? 'input' : 'id', source: 'json', codec: method === 'save' ? codec('SaveConnection', parseSave) : method === 'update' ? codec('UpdateConnection', parseUpdate) : id }],
    result: method === 'list' ? codec('ConnectionViews', parseViews) : method === 'open' ? codec('OpenConnection', parseOpenResult) : method === 'forget' ? nothing : view,
  })),
}
