import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { credentialKey, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { createStore } from '../src/host/store.js'
import { ConnectionsManager } from '../src/host/manager.js'
import { ConnectionsRpc, mountRpc } from '../src/host/rpc.js'
import { createApi } from '../src/client/rpc.js'
import { rpcContribution } from '../src/shared/rpc.js'
import { parseDeleteDiagnostic, parseDiagnosticDeleteResult, parseDiagnosticExportResult, parseDiagnosticList, parseDiagnosticRef } from '../src/shared/validation.js'
import type { ConnectionDiagnostic, ConnectionDiagnosticRef, ConnectionDiagnosticsApi, ConnectionsApi } from '../src/shared/types.js'

const id = 'connection-12345678-1234-4234-9234-123456789abc'
const otherId = 'connection-12345678-1234-4234-9234-123456789abd'
const thirdId = 'connection-12345678-1234-4234-9234-123456789abe'
const current = (value = id) => credentialKey('xunz-dsh-connections', value)
const legacy = (value = id) => credentialKey('connections', value)
const secret = 'diagnostic-private-token-must-never-leave-the-host'
const launchUrl = `http://127.0.0.1:3080/?token=${secret}`
const damaged: CredentialRecord = { kind: 'grant', payload: { token: secret, launchUrl, privateProviderField: secret } }
const valid: CredentialRecord = { kind: 'grant', payload: { id, name: 'Valid connection', target: 'dev', mode: 'managed' } }
const ref = ({ id, scope, receipt }: ConnectionDiagnosticRef): ConnectionDiagnosticRef => ({ id, scope, receipt })
const deletion = (value: ConnectionDiagnosticRef) => ({ ...ref(value), confirm: true as const, acknowledgeProcessLocal: true as const })

function memoryCredentials() {
  const records = new Map<CredentialKey, CredentialRecord>()
  const reads: CredentialKey[] = [], deletes: CredentialKey[] = [], modifies: CredentialKey[] = []
  return {
    records, reads, deletes, modifies,
    async listRecords() { return [...records].map(([key, value]) => ({ key, kind: value.kind })) },
    async readRecord(key: CredentialKey) { reads.push(key); return records.get(key) },
    async modifyRecord(key: CredentialKey, mutate: (value: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      modifies.push(key)
      const result = await mutate(records.get(key))
      if (result !== undefined) records.set(key, result)
      return records.get(key)
    },
    async deleteRecord(key: CredentialKey) { deletes.push(key); records.delete(key) },
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function prepared(api: ConnectionDiagnosticsApi): Promise<ConnectionDiagnostic> {
  const item = (await api.list()).records[0]!
  assert.ok(item)
  assert.equal((await api.export(ref(item))).ok, true)
  return item
}
function noSecret(value: unknown) {
  const serialized = JSON.stringify(value)
  for (const forbidden of [secret, launchUrl, 'privateProviderField', 'payload', 'digest']) assert.equal(serialized.includes(forbidden), false, forbidden)
}

test('diagnostics read only exact Connections keys and never migrate or expose native record data', async () => {
  const provider = memoryCredentials()
  provider.records.set(current(), valid)
  provider.records.set(legacy(), damaged)
  provider.records.set(legacy(otherId), damaged)
  provider.records.set(current(thirdId), { kind: 'grant', payload: { ...valid.payload as object, id: otherId } })
  const ignored = [
    credentialKey('other-plugin', id),
    credentialKey('connections', 'connection-unrelated'),
    `xunz-dsh-connections/${id}/extra` as CredentialKey,
    `connections-extra/${id}` as CredentialKey,
  ]
  for (const key of ignored) provider.records.set(key, damaged)
  const api = createStore(provider).diagnostics!
  const result = await api.list()
  assert.deepEqual(result.records.map(({ id, scope, issue, canDelete }) => ({ id, scope, issue, canDelete })), [
    { id, scope: 'legacy', issue: 'invalid-record', canDelete: true },
    { id: otherId, scope: 'legacy', issue: 'invalid-record', canDelete: true },
    { id: thirdId, scope: 'current', issue: 'invalid-record', canDelete: true },
  ])
  assert.equal(result.truncated, false)
  assert.deepEqual(provider.reads, [current(), legacy(), legacy(otherId), current(thirdId)])
  assert.deepEqual(provider.deletes, [])
  assert.deepEqual(provider.modifies, [])
  assert.equal(provider.records.size, 8)
  noSecret(result)
  const report = await api.export(ref(result.records[0]!))
  assert.equal(report.ok, true)
  if (!report.ok) throw new Error()
  assert.deepEqual(report.value, {
    format: 'connections-redacted-diagnostic-v1', redacted: true, credentialBackup: false,
    concurrency: 'same-process-provider-queue-only', record: { id, scope: 'legacy', issue: 'invalid-record', canDelete: true },
  })
  assert.equal(JSON.stringify(report).includes(result.records[0]!.receipt), false)
  noSecret(report)
})

test('cleanup requires export and both confirmations, then deletes only the exact invalid legacy key', async () => {
  const provider = memoryCredentials()
  provider.records.set(current(), valid)
  provider.records.set(legacy(), damaged)
  provider.records.set(credentialKey('other-plugin', id), damaged)
  const api = createStore(provider).diagnostics!
  const item = (await api.list()).records[0]!
  await assert.rejects(api.remove(ref(item) as never), /confirmation/)
  await assert.rejects(api.remove({ ...ref(item), confirm: true } as never), /confirmation/)
  assert.deepEqual(await api.remove(deletion(item)), { ok: false, code: 'EXPORT_REQUIRED' })
  assert.equal((await api.export(ref(item))).ok, true)
  assert.deepEqual(await api.remove(deletion(item)), { ok: true, value: { deleted: true } })
  assert.deepEqual(provider.deletes, [legacy()])
  assert.equal(provider.records.get(current()), valid, 'the valid current credential must never be deleted')
  assert.equal(provider.records.has(credentialKey('other-plugin', id)), true)
  assert.deepEqual(await api.remove(deletion(item)), { ok: false, code: 'STALE' })
})

test('cleanup of a damaged current record preserves a valid legacy record without migrating it', async () => {
  const provider = memoryCredentials()
  provider.records.set(current(), damaged)
  provider.records.set(legacy(), valid)
  const api = createStore(provider).diagnostics!
  const item = await prepared(api)
  assert.equal(item.scope, 'current')
  assert.deepEqual(await api.remove(deletion(item)), { ok: true, value: { deleted: true } })
  assert.deepEqual(provider.deletes, [current()])
  assert.equal(provider.records.get(legacy()), valid)
  assert.deepEqual(provider.modifies, [])
})

test('a valid repair before export or deletion is refused, and changed invalid payloads invalidate the receipt', async () => {
  for (const stage of ['before-export', 'before-delete', 'changed-invalid', 'removed'] as const) {
    const provider = memoryCredentials()
    provider.records.set(current(), damaged)
    const api = createStore(provider).diagnostics!
    const item = (await api.list()).records[0]!
    if (stage !== 'before-export') assert.equal((await api.export(ref(item))).ok, true)
    if (stage === 'removed') provider.records.delete(current())
    else provider.records.set(current(), stage === 'changed-invalid' ? { ...damaged, payload: { ...damaged.payload as object, ignoredByDecoder: 'changed' } } : valid)
    const result = stage === 'before-export' ? await api.export(ref(item)) : await api.remove(deletion(item))
    assert.deepEqual(result, { ok: false, code: 'STALE' }, stage)
    assert.deepEqual(provider.deletes, [], stage)
    if (stage !== 'removed') assert.equal(provider.records.has(current()), true)
  }
})

test('receipts are bound to exact ids and scopes and expired receipts do not read or delete records', async t => {
  const provider = memoryCredentials()
  provider.records.set(current(), damaged)
  provider.records.set(legacy(), damaged)
  provider.records.set(current(otherId), damaged)
  const api = createStore(provider).diagnostics!
  const item = await prepared(api)
  for (const forged of [{ ...ref(item), id: otherId }, { ...ref(item), scope: 'legacy' as const }, { ...ref(item), receipt: '00000000-0000-4000-8000-000000000000' }]) {
    assert.deepEqual(await api.remove(deletion(forged)), { ok: false, code: 'STALE' })
  }
  const before = provider.reads.length, now = Date.now()
  t.mock.method(Date, 'now', () => now + 11 * 60_000)
  assert.deepEqual(await api.export(ref(item)), { ok: false, code: 'STALE' })
  assert.deepEqual(await api.remove(deletion(item)), { ok: false, code: 'STALE' })
  assert.equal(provider.reads.length, before)
  assert.deepEqual(provider.deletes, [])
})

test('diagnostic cleanup and migration use one per-id queue across stores of the same provider', async () => {
  const provider = memoryCredentials(), entered = deferred(), release = deferred()
  provider.records.set(current(), damaged)
  provider.records.set(legacy(), valid)
  const first = createStore(provider), second = createStore(provider)
  const item = await prepared(first.diagnostics!)
  const remove = provider.deleteRecord
  provider.deleteRecord = async key => {
    if (key === current()) { entered.resolve(); await release.promise }
    await remove(key)
  }
  const removing = second.diagnostics!.remove(deletion(item))
  await entered.promise
  let readFinished = false
  const migrating = first.read(id).then(value => { readFinished = true; return value })
  try {
    const independent = await second.save({ name: 'Independent', target: 'other', mode: 'managed' })
    assert.equal(readFinished, false)
    release.resolve()
    assert.deepEqual(await removing, { ok: true, value: { deleted: true } })
    assert.deepEqual(await migrating, valid.payload)
    assert.deepEqual(provider.records.get(current()), valid, 'the later migration must survive cleanup')
    assert.equal(provider.records.has(current(independent.id)), true)
  } finally { release.resolve(); await Promise.allSettled([removing, migrating]) }
})

test('nonserializable and oversized invalid records can be reported but never deleted', async () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  const exotic = new Error(secret); Object.assign(exotic, { privateField: secret })
  const accessor = Object.defineProperty({}, 'privateField', { enumerable: true, get() { throw new Error('Digest must not invoke accessors') } })
  for (const payload of [{ token: secret, unsupported() {} }, { token: secret, oversized: 'x'.repeat(1024 * 1024) }, cyclic, exotic, accessor, { [Symbol('hidden')]: secret }]) {
    const provider = memoryCredentials()
    provider.records.set(current(), { kind: 'grant', payload })
    const api = createStore(provider).diagnostics!
    const item = (await api.list()).records[0]!
    assert.equal(item.canDelete, false)
    const report = await api.export(ref(item))
    assert.equal(report.ok, true)
    if (!report.ok) throw new Error()
    assert.equal(report.value.record.canDelete, false)
    noSecret(report)
    assert.deepEqual(await api.remove(deletion(item)), { ok: false, code: 'UNSAFE_RECORD' })
    assert.deepEqual(provider.deletes, [])
  }
})

test('digest failure on a cleanup reread fails closed', async () => {
  const provider = memoryCredentials()
  provider.records.set(current(), damaged)
  const api = createStore(provider).diagnostics!, item = await prepared(api)
  provider.records.set(current(), { kind: 'grant', payload: { unsupported() {} } })
  assert.deepEqual(await api.remove(deletion(item)), { ok: false, code: 'UNSAFE_RECORD' })
  assert.deepEqual(provider.deletes, [])
})

test('provider errors are redacted and an uncertain delete consumes the receipt', async () => {
  const provider = memoryCredentials()
  provider.records.set(current(), damaged)
  const api = createStore(provider).diagnostics!
  const read = provider.readRecord, list = provider.listRecords
  provider.listRecords = async () => { throw new Error(launchUrl) }
  await assert.rejects(api.list(), error => error instanceof Error && error.message === 'Connection record diagnostics are unavailable.')
  provider.listRecords = list
  const item = await prepared(api)
  provider.readRecord = async () => { throw new Error(secret) }
  await assert.rejects(api.list(), error => error instanceof Error && !error.message.includes(secret))
  assert.deepEqual(await api.export(ref(item)), { ok: false, code: 'UNAVAILABLE' })
  provider.readRecord = read
  provider.deleteRecord = async () => { throw new Error(secret) }
  assert.deepEqual(await api.remove(deletion(item)), { ok: false, code: 'UNAVAILABLE' })
  assert.deepEqual(await api.remove(deletion(item)), { ok: false, code: 'STALE' })
  assert.equal(provider.records.has(current()), true)
})

test('diagnostics bound their output and declare truncation', async () => {
  const provider = memoryCredentials()
  for (let i = 0; i < 201; ++i) provider.records.set(current(`connection-00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`), damaged)
  const result = await createStore(provider).diagnostics!.list()
  assert.equal(result.records.length, 200)
  assert.equal(result.truncated, true)
  assert.deepEqual(parseDiagnosticList(result), result)
})

test('diagnostic codecs reject unknown data, forged scopes, missing confirmations, and arbitrary failure text', () => {
  const input = { id, scope: 'current', receipt: '12345678-1234-4234-9234-123456789abc' }
  assert.deepEqual(parseDiagnosticRef(input), input)
  for (const bad of [{ ...input, scope: 'other-plugin' }, { ...input, id: 'invalid' }, { ...input, receipt: secret }, { ...input, payload: secret }]) {
    assert.throws(() => parseDiagnosticRef(bad), error => error instanceof Error && !error.message.includes(secret))
  }
  assert.throws(() => parseDeleteDiagnostic({ ...input, confirm: true }), /confirmation/)
  assert.throws(() => parseDeleteDiagnostic({ ...input, confirm: true, acknowledgeProcessLocal: true, launchUrl }), /diagnostic/)
  const record = { ...input, issue: 'invalid-record', canDelete: true }
  assert.throws(() => parseDiagnosticList({ records: [{ ...record, token: secret }], truncated: false }), /diagnostic/)
  assert.throws(() => parseDiagnosticList({ records: [record, record], truncated: false }), /diagnostic/)
  assert.throws(() => parseDiagnosticExportResult({ ok: false, code: secret }), /diagnostic/)
  assert.throws(() => parseDiagnosticDeleteResult({ ok: true, value: { deleted: true, payload: secret } }), /diagnostic/)
  for (const method of ['diagnosticRecords', 'exportDiagnostic', 'deleteDiagnostic']) {
    const descriptor = rpcContribution.descriptors.find(item => item.method === method)!
    assert.equal(descriptor.result?.mode, 'strict')
    if (descriptor.parameters.length) assert.equal(descriptor.parameters[0]!.codec?.mode, 'strict')
  }
})

test('production manager exposes optional diagnostics without altering old store adapters', async () => {
  const provider = memoryCredentials()
  provider.records.set(current(), damaged)
  const manager = new ConnectionsManager(createStore(provider))
  assert.ok(manager.diagnostics)
  assert.equal((await manager.diagnostics.list()).records.length, 1)
  await manager.dispose()
  await assert.rejects(manager.diagnostics.list(), /unloaded/)
  const store = createStore(provider)
  delete store.diagnostics
  const older = new ConnectionsManager(store)
  assert.equal(older.diagnostics, undefined)
  await older.dispose()
})

test('real RPC registration protects every diagnostic operation with owner auth and redacts provider failures', async () => {
  const provider = memoryCredentials()
  provider.records.set(current(), valid)
  provider.records.set(legacy(), damaged)
  const manager = new ConnectionsManager(createStore(provider))
  const ctx = new Context(), registry = ctx.plugin(TypertRegistry)
  await registry
  const plugin = ctx.plugin({ name: 'connection-diagnostics-test', inject: ['typert'], apply(child: Context) { mountRpc(child, manager) } })
  await plugin
  try {
    const fake = { id, scope: 'legacy' as const, receipt: '12345678-1234-4234-9234-123456789abc' }
    for (const principal of [undefined, { kind: 'other' }]) {
      const scoped = principal ? ctx.extend({ invocation: { peer: { principal } } }) : ctx
      const receiver = scoped.get('connections' as never) as unknown as ConnectionsRpc
      await assert.rejects(receiver.diagnosticRecords(), /Only the Harness owner/)
      await assert.rejects(receiver.exportDiagnostic(fake), /Only the Harness owner/)
      await assert.rejects(receiver.deleteDiagnostic(deletion(fake)), /Only the Harness owner/)
    }
    assert.deepEqual(provider.reads, [])
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } } } })
    const receiver = owner.get('connections' as never) as unknown as ConnectionsRpc
    const list = await receiver.diagnosticRecords(), item = list.records[0]!
    noSecret(list)
    noSecret(await receiver.exportDiagnostic(ref(item)))
    assert.deepEqual(await receiver.deleteDiagnostic(deletion(item)), { ok: true, value: { deleted: true } })
    assert.equal(provider.records.get(current()), valid)
    provider.readRecord = async () => { throw new Error(launchUrl) }
    await assert.rejects(receiver.diagnosticRecords(), error => error instanceof Error && !error.message.includes(secret))
  } finally { await plugin.dispose(); await registry.dispose(); await manager.dispose() }
})

test('RPC diagnostics unavailable or returning unknown provider fields fail closed without leaking them', async () => {
  const ctx = new Context(), registry = ctx.plugin(TypertRegistry)
  await registry
  const api = {} as ConnectionsApi
  const plugin = ctx.plugin({ name: 'connection-diagnostics-unavailable-test', inject: ['typert'], apply(child: Context) { mountRpc(child, api) } })
  await plugin
  try {
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } } } })
    const receiver = owner.get('connections' as never) as unknown as ConnectionsRpc
    const input = { id, scope: 'current' as const, receipt: '12345678-1234-4234-9234-123456789abc' }
    await assert.rejects(receiver.diagnosticRecords(), /diagnostics are unavailable/)
    assert.deepEqual(await receiver.exportDiagnostic(input), { ok: false, code: 'UNAVAILABLE' })
    assert.deepEqual(await receiver.deleteDiagnostic(deletion(input)), { ok: false, code: 'UNAVAILABLE' })
    api.diagnostics = {
      async list() { return { records: [], truncated: false, token: secret } },
      async export() { throw new Error(secret) },
      async remove() { return { ok: true, value: { deleted: true, token: secret } } },
    }
    await assert.rejects(receiver.diagnosticRecords(), error => error instanceof Error && !error.message.includes(secret))
    assert.deepEqual(await receiver.exportDiagnostic(input), { ok: false, code: 'UNAVAILABLE' })
    assert.deepEqual(await receiver.deleteDiagnostic(deletion(input)), { ok: false, code: 'UNAVAILABLE' })
  } finally { await plugin.dispose(); await registry.dispose() }
})

test('client API offers diagnostics on demand and validates inputs and every response', async () => {
  const provider = memoryCredentials()
  provider.records.set(current(), damaged)
  const diagnostics = createStore(provider).diagnostics!
  let reads = 0, exports = 0, deletes = 0
  const remote = {
    async diagnosticRecords() { ++reads; return { ok: true, value: await diagnostics.list() } },
    async exportDiagnostic(input: ConnectionDiagnosticRef) { ++exports; return { ok: true, value: await diagnostics.export(input) } },
    async deleteDiagnostic(input: Parameters<ConnectionDiagnosticsApi['remove']>[0]) { ++deletes; return { ok: true, value: await diagnostics.remove(input) } },
  }
  const api = createApi({ remote: { connections: remote } } as unknown as Context)
  assert.deepEqual([reads, exports, deletes], [0, 0, 0])
  const item = (await api.diagnostics!.list()).records[0]!
  assert.equal(reads, 1)
  assert.throws(() => api.diagnostics!.export({ ...ref(item), payload: secret } as never), /diagnostic/)
  assert.equal(exports, 0)
  noSecret(await api.diagnostics!.export(ref(item)))
  assert.deepEqual(await api.diagnostics!.remove(deletion(item)), { ok: true, value: { deleted: true } })
  assert.deepEqual([reads, exports, deletes], [1, 1, 1])
  remote.diagnosticRecords = async () => ({ ok: true, value: { records: [], truncated: false, token: secret } })
  await assert.rejects(api.diagnostics!.list(), /diagnostic/)
})
