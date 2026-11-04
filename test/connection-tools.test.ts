import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { ConnectionsOperations, CONNECTION_OPERATION_ERRORS } from '../src/host/operations.js'
import { ConnectionsRpc, mountRpc } from '../src/host/rpc.js'
import { CONNECTION_TOOL_NAME, createConnectionTool, mountConnectionTools, parseConnectionToolInput } from '../src/host/tools.js'
import type { ConnectionView, ConnectionsApi } from '../src/shared/types.js'
import { ConnectionsManager } from '../src/host/manager.js'
import { createStore } from '../src/host/store.js'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { parseWorkspaceCall } from '../src/shared/workspace-rpc.js'
import { WORKSPACE_PROTOCOL, WorkspaceProtocolError } from '../src/shared/workspace-protocol.js'

const id = 'connection-11111111-1111-4111-8111-111111111111'
const transportId = '11111111-1111-4111-8111-111111111111'
const secret = 'never-output-launch-credential-private'
const view: ConnectionView = { id, name: 'Remote', target: 'dev', phase: 'connected', mode: 'managed', transportId }
function apiFixture() {
  const calls: string[] = []
  const row = { ...view }
  const api: ConnectionsApi = {
    async operationSnapshot() { return { view: { ...row }, revision: 'f'.repeat(64) } },
    async list() { calls.push('list'); return [{ ...row, token: secret }] },
    async sshHosts() { calls.push('sshHosts'); return ['dev', 'build'] },
    async checkSsh() { calls.push('checkSsh'); return { ok: false, code: 'SSH_HOST_KEY', stderr: secret } as const },
    async save() { calls.push('save'); return row },
    async connect() { calls.push('connect'); row.autoConnect = true; return row },
    async reconnect() { calls.push('reconnect'); return row },
    async disconnect() { calls.push('disconnect'); row.autoConnect = false; row.phase = 'disconnected'; return row },
    async remove() { calls.push('remove') },
    async update() { calls.push('update'); return row },
    async open() { calls.push('open'); return { url: `http://127.0.0.1:3080/?token=${secret}` } },
    diagnostics: { async list() { throw new Error(secret) }, async export() { throw new Error(secret) }, async remove() { calls.push('diagnostic-delete'); throw new Error(secret) } },
  }
  return { api, calls, row }
}
const execution = (signal = new AbortController().signal) => ({ signal, callId: 'call-1', name: CONNECTION_TOOL_NAME } as ToolRunContext)

test('per-action input rejects credentials, confirmations and arbitrary workspace/channel operations', () => {
  for (const value of [
    { action: 'open', id }, { action: 'save', target: 'dev', launchUrl: secret },
    { action: 'deleteDiagnostic', id, confirm: true, acknowledgeProcessLocal: true },
    { action: 'list', launchUrl: secret }, { action: 'check_ssh', target: '-oProxyCommand=id' },
    { action: 'mutate', id, expectedTransportId: transportId, request: { op: 'closeView', channel: 'a'.repeat(43) } },
    { action: 'mutate', id, request: { op: 'renameSession', id: 'chat-1', title: 'New title' } },
    { action: 'connect', id, confirm: true }, { action: 'update', id, version: 'latest' },
    { action: 'rename', id, name: 'Rename', target: 'unapproved-target' }, { action: 'rename', id, name: '   ' },
    { action: 'list', limit: 0 }, { action: 'ssh_hosts', limit: 51 }, { action: 'catalog', id, offset: -1 },
  ]) assert.throws(() => parseConnectionToolInput(value))
  assert.deepEqual(parseConnectionToolInput({ action: 'list' }), { action: 'list', offset: 0, limit: 20 })
  assert.deepEqual(parseWorkspaceCall({ id, request: { op: 'pinSession', id: 'chat-1', pinned: true }, expectedTransportId: transportId }), { id, request: { op: 'pinSession', id: 'chat-1', pinned: true }, expectedTransportId: transportId })
  for (const value of ['', secret, null]) assert.throws(() => parseWorkspaceCall({ id, request: { op: 'catalog', protocol: WORKSPACE_PROTOCOL }, expectedTransportId: value }))
  assert.throws(() => parseWorkspaceCall({ id: 'local', request: { op: 'catalog', protocol: WORKSPACE_PROTOCOL }, expectedTransportId: transportId }))
})

test('RPC and real Tools registry share one business core, native approval and owned teardown', async () => {
  const ctx = new Context()
  const { api, calls, row } = apiFixture()
  api.save = async (input, expectedRevision) => {
    assert.deepEqual(input, { id, name: 'Renamed', target: 'dev', mode: 'managed' })
    assert.equal(expectedRevision, 'f'.repeat(64))
    calls.push('save'); row.name = input.name; return row
  }
  let approved = false
  const asks: Array<{ signal: AbortSignal; callId: string; toolName: string }> = []
  const registry = ctx.plugin(TypertRegistry)
  const providers = ctx.plugin(child => {
    child.provide('systemPrompt', { tools: () => () => {} } as never)
    child.provide('approval' as never, { async request(input: { signal: AbortSignal; callId: string; toolName: string }) { asks.push(input); return approved ? 'allowed-once' : 'rejected' } } as never)
    new ToolRuntime(child)
    child.on('tools/pre-execute', async () => ({ kind: 'allow' }))
  })
  await Promise.all([registry, providers])
  let core!: ConnectionsOperations
  const plugin = ctx.plugin({ inject: ['typert'], apply(child: Context) {
    core = new ConnectionsOperations(child, api)
    mountRpc(child, core)
    mountConnectionTools(child, core)
  } })
  await plugin; await nextTurn()
  const invoke = (arguments_: unknown, withAgent = true) => ctx.tools.execute({ name: CONNECTION_TOOL_NAME, arguments: arguments_, callId: 'tool-call' as never,
    signal: new AbortController().signal, ...(withAgent ? { agent: { id: 'session-tool' } as never } : {}) })
  try {
    assert.equal(ctx.tools.schemas().filter(tool => tool.name === CONNECTION_TOOL_NAME).length, 1)
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } } } })
    const rpc = owner.get('connections' as never) as unknown as ConnectionsRpc
    const rpcRows = await rpc.list()
    const listed = await invoke({ action: 'list', limit: 1 })
    assert.equal(listed.isError, false)
    if (listed.isError) throw new Error('tool unexpectedly failed')
    assert.deepEqual(listed.value, { ok: true, value: { items: rpcRows, total: 1 } })
    assert.equal(JSON.stringify(listed).includes(secret), false)
    const checked = await invoke({ action: 'check_ssh', target: 'dev' })
    assert.equal(checked.isError, false)
    if (checked.isError) throw new Error('tool unexpectedly failed')
    assert.deepEqual(checked.value, { ok: true, value: await rpc.checkSsh('dev') })
    const before = calls.length
    const refused = await invoke({ action: 'disconnect', id })
    assert.equal(refused.isError, false)
    if (refused.isError) throw new Error('tool unexpectedly failed')
    assert.deepEqual(refused.value, { ok: false, error: { code: 'APPROVAL_REQUIRED', message: 'This connection change was not approved. No operation was started.' } })
    assert.equal(calls.length, before)
    assert.equal(asks.length, 1)
    assert.equal(asks[0].callId, 'tool-call')
    assert.equal(asks[0].toolName, CONNECTION_TOOL_NAME)
    assert.equal(asks[0].signal.aborted, false)
    approved = true
    const changed = await invoke({ action: 'disconnect', id })
    assert.equal(changed.isError, false)
    if (changed.isError) throw new Error('tool unexpectedly failed')
    assert.deepEqual(changed.value, { ok: true, value: (await rpc.list())[0] })
    assert.equal(calls.filter(call => call === 'disconnect').length, 1)
    const renamed = await invoke({ action: 'rename', id, name: 'Renamed' })
    assert.equal(renamed.isError, false)
    assert.equal(row.name, 'Renamed')
    assert.equal(calls.filter(call => call === 'save').length, 1)
    assert.equal(JSON.stringify(renamed).includes('f'.repeat(64)), false)
    const asksBefore = asks.length
    await invoke({ action: 'reconnect', id }, false)
    assert.equal(asks.length, asksBefore, 'an agentless call cannot route or mint a grant')
    assert.equal(calls.includes('reconnect'), false)
    const unowned = ctx.get('connections' as never) as unknown as ConnectionsRpc
    await assert.rejects(unowned.list(), /Only the Harness owner/)
    await plugin.dispose()
    assert.equal(ctx.tools.get(CONNECTION_TOOL_NAME), undefined)
    assert.equal(ctx.get('connectionOperations'), undefined)
    await assert.rejects(core.list(), /unavailable/)
  } finally { await plugin.dispose(); await registry.dispose(); await providers.dispose() }
})

test('ordinary provider failures are safely projected for RPC and tool results, never delegated to Gateway redaction', async () => {
  const ctx = new Context(), registry = ctx.plugin(TypertRegistry)
  await registry
  const { api } = apiFixture()
  for (const method of ['list', 'save', 'remove', 'connect', 'reconnect', 'disconnect', 'update', 'open', 'sshHosts', 'checkSsh'] as const) {
    Object.assign(api, { [method]: async () => { throw new Error(`http://127.0.0.1:3080/?token=${secret}`) } })
  }
  const plugin = ctx.plugin({ inject: ['typert'], apply(child: Context) { mountRpc(child, api, async () => { throw new Error(secret) }) } })
  await plugin
  try {
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } } } })
    const rpc = owner.get('connections' as never) as unknown as ConnectionsRpc
    for (const operation of [() => rpc.list(), () => rpc.save({ id, name: 'Edit', target: 'dev' }), () => rpc.forget(id), () => rpc.connect(id), () => rpc.open(id)]) {
      await assert.rejects(operation(), error => error instanceof Error && error.message === CONNECTION_OPERATION_ERRORS.UNAVAILABLE && !JSON.stringify(error).includes(secret))
    }
    const core = ctx.connectionOperations
    const result = await createConnectionTool(core).execute({ action: 'list' }, execution())
    assert.deepEqual(result, { ok: false, error: { code: 'UNAVAILABLE', message: CONNECTION_OPERATION_ERRORS.UNAVAILABLE } })
    assert.equal(JSON.stringify(result).includes(secret), false)
    const response = await rpc.workspace({ id, request: { op: 'catalog', protocol: WORKSPACE_PROTOCOL } })
    assert.deepEqual(response.response, { ok: false, error: { code: 'UNAVAILABLE', message: 'The workspace service is unavailable.' } })
  } finally { await plugin.dispose(); await registry.dispose() }
})

test('catalog supplies bounded native IDs with a transport guard; writes preserve it and never replay', async () => {
  const ctx = new Context(), { api, calls } = apiFixture()
  const requests: unknown[] = []
  let failMutation = false
  const plugin = ctx.plugin(child => {
    new ConnectionsOperations(child, api, async input => {
      requests.push(input)
      assert.equal(input.expectedTransportId, transportId)
      if (input.request.op !== 'catalog') { if (failMutation) throw new WorkspaceProtocolError('CONFLICT'); return { ok: true, value: { done: true } } }
      return { ok: true, value: { protocol: WORKSPACE_PROTOCOL, revision: 'a'.repeat(43),
        workspaces: [{ id: 'project-1', title: 'Native', path: '/' + 'p'.repeat(3000), sessionIds: Array.from({ length: 100 }, (_, i) => `chat-${i}`) }],
        sessions: [{ id: 'chat-1', title: 'Native session', updatedAt: 1, running: false, blank: false }], archivedSessionIds: [], pinnedSessionIds: [],
      } }
    })
  })
  await plugin
  try {
    const tool = createConnectionTool(ctx.connectionOperations, undefined, async () => true)
    const result = await tool.execute({ action: 'catalog', id, limit: 1 }, execution()) as { value: { transportId: string; items: Array<{ path: string; sessionIds?: string[]; pathTruncated: boolean; sessionCount: number }> } }
    assert.equal(result.value.transportId, transportId)
    assert.equal(result.value.items[0].path.length, 1024)
    assert.equal(result.value.items[0].pathTruncated, true)
    assert.equal(result.value.items[0].sessionCount, 100)
    assert.equal(result.value.items[0].sessionIds, undefined)
    failMutation = true
    const action = { action: 'mutate', id, expectedTransportId: transportId, request: { op: 'renameSession', id: 'chat-1', title: 'New name' } }
    const changed = await tool.execute(action, execution())
    assert.deepEqual(changed, { ok: false, error: { code: 'CONFLICT', message: 'This request conflicts with the current workspace state.' } })
    assert.equal(requests.length, 2, 'one catalog and one failed write; no replay or hidden reauthentication')
    assert.deepEqual(calls, ['list', 'list'], 'catalog and approval display each sample once; neither replays a write')
  } finally { await plugin.dispose() }
})

test('production manager snapshots pass the shared core and approved metadata tool without exposing credentials', async () => {
  const records = new Map<CredentialKey, CredentialRecord>()
  const store = createStore({
    async listRecords() { return [...records].map(([key, record]) => ({ key, kind: record.kind })) },
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, update) { const next = await update(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key) },
    async deleteRecord(key) { records.delete(key) },
  })
  const manager = new ConnectionsManager(store)
  const saved = await manager.save({ name: 'Original', target: 'dev', mode: 'existing', autoConnect: false, launchUrl: `http://127.0.0.1:3080/?token=${secret}` })
  const ctx = new Context()
  const plugin = ctx.plugin(child => { new ConnectionsOperations(child, manager) })
  await plugin
  try {
    const snapshot = await ctx.connectionOperations.operationSnapshot(saved.id)
    assert.match(snapshot.revision, /^[0-9a-f]{64}$/)
    const tool = createConnectionTool(ctx.connectionOperations, undefined, async (_input, _exec, _signal, observed) => {
      assert.equal(observed.target, 'dev')
      assert.equal(JSON.stringify(observed).includes(secret), false)
      return true
    })
    const result = await tool.execute({ action: 'rename', id: saved.id, name: 'Renamed safely' }, execution()) as { ok: boolean; value: ConnectionView }
    assert.equal(result.ok, true)
    assert.equal(result.value.name, 'Renamed safely')
    assert.equal(result.value.phase, 'disconnected')
    const record = await store.read(saved.id)
    assert.equal(record?.token, secret, 'metadata edits preserve the write-only credential')
    assert.equal(record?.autoConnect, false, 'rename does not silently start or enable a remote service')
    assert.equal(JSON.stringify(result).includes(secret), false)
    assert.equal(JSON.stringify(result).includes(snapshot.revision), false)
    assert.equal((await ctx.connectionOperations.operationSnapshot(saved.id)).revision, snapshot.revision)
  } finally { await plugin.dispose(); await manager.dispose() }
})

test('approval binds the captured record revision and refuses a replaced target without exposing that revision', async () => {
  const ctx = new Context(), { api, row } = apiFixture()
  let revision = 'a'.repeat(64), applied = 0
  api.operationSnapshot = async () => ({ view: { ...row }, revision })
  api.update = async (_input, expected) => {
    if (expected !== revision) throw new Error('This connection has changed.')
    applied++; return row
  }
  const plugin = ctx.plugin(child => { new ConnectionsOperations(child, api) })
  await plugin
  try {
    const tool = createConnectionTool(ctx.connectionOperations, undefined, async (_input, _exec, _signal, observed) => {
      assert.equal(observed.target, 'dev')
      assert.equal('revision' in observed, false)
      assert.equal('token' in observed, false)
      row.target = 'replacement'
      revision = 'b'.repeat(64)
      return true
    })
    const result = await tool.execute({ action: 'update', id }, execution())
    assert.deepEqual(result, { ok: false, error: { code: 'CONFLICT', message: CONNECTION_OPERATION_ERRORS.CONFLICT } })
    assert.equal(applied, 0)
    assert.equal(JSON.stringify(result).includes(revision), false)
  } finally { await plugin.dispose() }
})

test('cancellation while native approval declines is CANCELLED, not a missing approval grant', async () => {
  const ctx = new Context(), { api, calls } = apiFixture()
  const lifetime = new AbortController()
  let decline!: () => void
  const plugin = ctx.plugin(child => { new ConnectionsOperations(child, api) })
  await plugin
  try {
    const tool = createConnectionTool(ctx.connectionOperations, lifetime.signal, async (_input, _exec, signal) => {
      await new Promise<void>(resolve => { decline = resolve })
      assert.equal(signal.aborted, true)
      return false
    })
    const pending = tool.execute({ action: 'disconnect', id }, execution())
    await nextTurn()
    lifetime.abort(); decline()
    const result = await pending
    assert.equal((result as { error: { code: string } }).error.code, 'CANCELLED')
    assert.deepEqual(calls, [])
  } finally { await plugin.dispose() }
})

test('cancelled or disposed calls cannot start work; started shared operations are drained without replay', async () => {
  const ctx = new Context(), { api, calls } = apiFixture()
  let release!: () => void
  let finished = false
  api.reconnect = async () => { calls.push('reconnect'); await new Promise<void>(resolve => { release = resolve }); finished = true; return view }
  const plugin = ctx.plugin(child => { new ConnectionsOperations(child, api) })
  await plugin
  try {
    const lifetime = new AbortController()
    const tool = createConnectionTool(ctx.connectionOperations, lifetime.signal, async () => true)
    const aborted = new AbortController(); aborted.abort()
    const cancelled = await tool.execute({ action: 'reconnect', id }, execution(aborted.signal))
    assert.equal((cancelled as { error: { code: string } }).error.code, 'CANCELLED')
    assert.deepEqual(calls, [])
    const controller = new AbortController()
    const pending = tool.execute({ action: 'reconnect', id }, execution(controller.signal))
    await nextTurn()
    assert.deepEqual(calls, ['reconnect'])
    controller.abort()
    assert.equal(finished, false)
    release()
    const result = await pending
    assert.equal(finished, true)
    assert.equal((result as { error: { code: string } }).error.code, 'CANCELLED')
    lifetime.abort()
    await tool.execute({ action: 'connect', id }, execution())
    assert.deepEqual(calls, ['reconnect'])
  } finally { await plugin.dispose() }
})
