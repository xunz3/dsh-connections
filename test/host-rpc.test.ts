import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { ConnectionsRpc, mountRpc } from '../src/host/rpc.js'
import * as hostPlugin from '../src/host/index.js'
import { rpcContribution } from '../src/shared/rpc.js'
import type { ConnectionsApi, ConnectionView } from '../src/shared/types.js'
import type { WorkspaceCall } from '../src/shared/workspace-rpc.js'
import { WorkspaceProtocolError, WORKSPACE_ERRORS, WORKSPACE_PROTOCOL } from '../src/shared/workspace-protocol.js'

const id = 'connection-12345678-1234-1234-1234-123456789abc'
const view: ConnectionView = { id, name: 'Work', target: 'dev', remotePort: 3080, phase: 'disconnected' }
const token = 'private-launch-token-never-in-status'

test('real Typert registration binds owner-only RPC and strips extra fields from status', async () => {
  const ctx = new Context()
  const registry = ctx.plugin(TypertRegistry)
  await registry
  let calls = 0
  const workspaceCalls: WorkspaceCall[] = []
  const catalog = { protocol: WORKSPACE_PROTOCOL, revision: 'a'.repeat(43), workspaces: [], sessions: [], archivedSessionIds: [], pinnedSessionIds: [] }
  const privateView = { ...view, token }
  const api: ConnectionsApi = {
    async sshHosts() { ++calls; return ['dev', 'build'] },
    async list() { ++calls; return [privateView] },
    async save() { ++calls; return privateView },
    async remove() { ++calls },
    async connect() { ++calls; return privateView },
    async reconnect() { ++calls; return privateView },
    async disconnect() { ++calls; return privateView },
    async update() { ++calls; return privateView },
    async open() { ++calls; return { url: `http://127.0.0.1:41380/?token=${token}` } },
  }
  const plugin = ctx.plugin({ name: 'connections-rpc-test', inject: ['typert'], apply(child: Context) {
    mountRpc(child, api, async input => {
      workspaceCalls.push(input)
      return { ok: true, value: { ...catalog, token }, token }
    })
  } })
  await plugin
  try {
    for (const descriptor of rpcContribution.descriptors) {
      assert.equal(ctx.typert.local.get(`${descriptor.namespace}/${descriptor.method}`)?.id, descriptor.id)
      const service = ctx.get(descriptor.service as never) as unknown as Record<string, unknown>
      assert.equal(typeof service[descriptor.implementation ?? descriptor.method], 'function', `Missing service method for ${descriptor.namespace}/${descriptor.method}`)
    }
    for (const principal of [undefined, { kind: 'other' }]) {
      const scoped = principal === undefined ? ctx : ctx.extend({ invocation: { peer: { principal } } })
      const receiver = scoped.get('connections' as never) as unknown as ConnectionsRpc
      await assert.rejects(receiver.list(), /Only the Harness owner/)
      await assert.rejects(receiver.sshHosts(), /Only the Harness owner/)
      await assert.rejects(receiver.save({ name: 'Work', target: 'dev' }), /Only the Harness owner/)
      await assert.rejects(receiver.update({ id, version: '0.2.1-rc.3' }), /Only the Harness owner/)
      await assert.rejects(receiver.workspace({ id: 'local', request: { op: 'catalog', protocol: WORKSPACE_PROTOCOL } }), /Only the Harness owner/)
      await assert.rejects(receiver.workspace({ id, request: { op: 'unknown' } } as unknown as WorkspaceCall), /Only the Harness owner/)
      for (const method of ['forget', 'connect', 'reconnect', 'disconnect', 'open'] as const) await assert.rejects(receiver[method](id), /Only the Harness owner/)
    }
    assert.equal(calls, 0)
    assert.deepEqual(workspaceCalls, [])
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } } } })
    const receiver = owner.get('connections' as never) as unknown as ConnectionsRpc
    assert.deepEqual(await receiver.list(), [view])
    assert.deepEqual(await receiver.sshHosts(), ['dev', 'build'])
    assert.deepEqual(await receiver.save({ name: 'Work', target: 'dev' }), view)
    assert.deepEqual(await receiver.connect(id), view)
    assert.deepEqual(await receiver.reconnect(id), view)
    assert.deepEqual(await receiver.disconnect(id), view)
    assert.deepEqual(await receiver.update({ id, version: '0.2.1-rc.3' }), view)
    assert.equal((await receiver.open(id)).url.includes(token), true)
    await receiver.forget(id)
    await assert.rejects(receiver.connect('invalid'), /Invalid connection identifier/)
    const workspaceCall = { id: 'local', request: { op: 'catalog', protocol: WORKSPACE_PROTOCOL } as const }
    assert.deepEqual(await receiver.workspace(workspaceCall), { request: workspaceCall.request, response: { ok: true, value: catalog } })
    assert.deepEqual(workspaceCalls, [workspaceCall])
    await assert.rejects(receiver.workspace({ id, request: { op: 'prompt', token } } as unknown as WorkspaceCall), /invalid/i)
    await assert.rejects(receiver.workspace({ id: 'other-host', request: { op: 'catalog', protocol: WORKSPACE_PROTOCOL } }), /Invalid connection identifier/)
    assert.equal(workspaceCalls.length, 1)
    const descriptor = rpcContribution.descriptors.find(item => item.method === 'workspace')!
    const parameterCodec = descriptor.parameters[0]!.codec!
    const resultCodec = descriptor.result!
    assert.equal(parameterCodec.mode, 'strict')
    assert.equal(resultCodec.mode, 'strict')
    if (parameterCodec.mode !== 'strict' || resultCodec.mode !== 'strict') throw new Error('Workspace codecs must be strict')
    const parameter = parameterCodec.create().parse
    const result = resultCodec.create().parse
    assert.deepEqual(parameter(workspaceCall), workspaceCall)
    assert.throws(() => parameter({ id, request: { op: 'prompt', token } }), /invalid/i)
    assert.throws(() => parameter({ ...workspaceCall, token }), /invalid/i)
    assert.deepEqual(result({ request: workspaceCall.request, response: { ok: true, value: { ...catalog, token }, token } }), { request: workspaceCall.request, response: { ok: true, value: catalog } })
    assert.throws(() => result({ request: { op: 'unknown' }, response: { ok: false, error: { code: 'FAILED' } } }), /invalid/i)
  } finally { await plugin.dispose() }
  assert.equal(ctx.get('connections' as never), undefined)
  assert.equal(ctx.typert.local.get('connections/list'), undefined)
  await registry.dispose()
})

test('workspace protocol incompatibility retains its public code through the RPC result envelope', async () => {
  const ctx = new Context()
  const registry = ctx.plugin(TypertRegistry)
  await registry
  const plugin = ctx.plugin({ name: 'connections-protocol-rpc-test', inject: ['typert'], apply(child: Context) {
    mountRpc(child, {} as ConnectionsApi, async () => { throw new WorkspaceProtocolError('INCOMPATIBLE_PROTOCOL') })
  } })
  await plugin
  try {
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } } } })
    const receiver = owner.get('connections' as never) as unknown as ConnectionsRpc
    const request = { op: 'catalog', protocol: WORKSPACE_PROTOCOL } as const
    assert.deepEqual(await receiver.workspace({ id, request }), {
      request, response: { ok: false, error: { code: 'INCOMPATIBLE_PROTOCOL', message: WORKSPACE_ERRORS.INCOMPATIBLE_PROTOCOL } },
    })
  } finally { await plugin.dispose(); await registry.dispose() }
})

test('host plugin reuses native credentials and unloads without dropping saved records', async () => {
  class MemoryCredentials extends Service {
    records = new Map<CredentialKey, CredentialRecord>()
    constructor(ctx: Context) { super(ctx, 'credentials') }
    async listRecords() { return [...this.records].map(([key, record]) => ({ key, kind: record.kind })) }
    async readRecord(key: CredentialKey) { return this.records.get(key) }
    async modifyRecord(key: CredentialKey, mutate: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      const next = await mutate(this.records.get(key))
      if (next !== undefined) this.records.set(key, next)
      return this.records.get(key)
    }
    async deleteRecord(key: CredentialKey) { this.records.delete(key) }
  }
  const ctx = new Context()
  const registry = ctx.plugin(TypertRegistry)
  const credentials = ctx.plugin(MemoryCredentials)
  await Promise.all([registry, credentials])
  const plugin = ctx.plugin(hostPlugin)
  await plugin
  try {
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } } } })
    const receiver = owner.get('connections' as never) as unknown as ConnectionsRpc
    const saved = await receiver.save({ name: 'Work', target: 'dev', launchUrl: `http://127.0.0.1:3080/?token=${token}` })
    assert.equal(JSON.stringify(saved).includes(token), false)
    assert.equal((await receiver.list()).length, 1)
    await receiver.forget(saved.id)
    assert.deepEqual(await receiver.list(), [])
    await receiver.save({ name: 'Preserved on unload', target: 'dev', launchUrl: `http://127.0.0.1:3080/?token=${token}` })
    await plugin.dispose()
    assert.equal((await ctx.credentials.listRecords()).length, 1)
    assert.equal(ctx.get('connections' as never), undefined)
  } finally {
    await plugin.dispose()
    await Promise.all([credentials.dispose(), registry.dispose()])
  }
})
