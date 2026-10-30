import assert from 'node:assert/strict'
import test from 'node:test'
import { credentialKey, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { createStore } from '../src/host/store.js'

const id = 'connection-12345678-1234-1234-1234-123456789abc'
const secondId = 'connection-12345678-1234-1234-1234-123456789abd'
const legacyKey = credentialKey('connections', id)
const currentKey = credentialKey('xunz-dsh-connections', id)
const record = { kind: 'grant' as const, payload: { id, name: 'Legacy', target: 'dev', mode: 'managed', autoConnect: true, lastLocalPort: 41380 } }

function credentials() {
  const records = new Map<CredentialKey, CredentialRecord>()
  return {
    records,
    async listRecords() { return [...records].map(([key, value]) => ({ key, kind: value.kind })) },
    async readRecord(key: CredentialKey) { return records.get(key) },
    async modifyRecord(key: CredentialKey, mutate: (value: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      const value = await mutate(records.get(key))
      if (value !== undefined) records.set(key, value)
      return records.get(key)
    },
    async deleteRecord(key: CredentialKey) { records.delete(key) },
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('migration and removal share one per-id transaction across store instances', async () => {
  for (const operation of ['read', 'list'] as const) {
    const provider = credentials(), entered = deferred(), release = deferred()
    provider.records.set(legacyKey, record)
    const modify = provider.modifyRecord
    provider.modifyRecord = async (key, mutate) => {
      if (key === currentKey) { entered.resolve(); await release.promise }
      return modify(key, mutate)
    }
    const reader = createStore(provider), writer = createStore(provider)
    const migrating = operation === 'read' ? reader.read(id) : reader.list()
    await entered.promise
    let removed = false
    const removing = writer.remove(id).then(() => { removed = true })
    try {
      // A different connection remains writable while this migration waits.
      const other = await writer.save({ name: 'Independent', target: 'other', mode: 'managed' })
      assert.equal(removed, false)
      release.resolve()
      await Promise.all([migrating, removing])
      assert.equal(provider.records.has(currentKey), false)
      assert.equal(provider.records.has(legacyKey), false)
      assert.deepEqual((await reader.list()).map(item => item.id), [other.id])
    } finally { release.resolve(); await Promise.allSettled([migrating, removing]) }
  }
})

test('a read queued after removal cannot reimport a legacy snapshot', async () => {
  const provider = credentials(), entered = deferred(), release = deferred()
  provider.records.set(legacyKey, record)
  const remove = provider.deleteRecord
  provider.deleteRecord = async key => {
    if (key === legacyKey) { entered.resolve(); await release.promise }
    await remove(key)
  }
  const store = createStore(provider)
  const removing = store.remove(id)
  await entered.promise
  const reading = store.read(id)
  release.resolve()
  await removing
  assert.equal(await reading, undefined)
  assert.equal(provider.records.size, 0)
})

test('legacy credentials migrate without changing connection identity or transport preferences', async () => {
  const provider = credentials()
  provider.records.set(legacyKey, record)
  const store = createStore(provider)
  assert.deepEqual(await store.list(), [record.payload])
  assert.equal(provider.records.has(legacyKey), false)
  assert.deepEqual(provider.records.get(currentKey), record)
  assert.equal((await store.save({ id, name: 'Renamed', target: 'dev' })).lastLocalPort, 41380)
  await store.remove(id)
  assert.deepEqual(await store.list(), [])
})

test('interrupted migrations retain the old credential and a current record wins over a legacy copy', async () => {
  const provider = credentials()
  provider.records.set(legacyKey, record)
  const failing = createStore({ ...provider, async modifyRecord() { throw new Error('provider unavailable') } })
  await assert.rejects(failing.read(id), /provider unavailable/)
  assert.deepEqual(provider.records.get(legacyKey), record)
  assert.equal(provider.records.has(currentKey), false)
  const updated = { kind: 'grant' as const, payload: { ...record.payload, name: 'Current' } }
  provider.records.set(currentKey, updated)
  const store = createStore(provider)
  assert.deepEqual(await store.list(), [updated.payload])
  assert.equal(provider.records.has(legacyKey), false, 'reading the authoritative record finishes obsolete-copy cleanup')
  await store.remove(id)
  assert.equal(provider.records.has(legacyKey), false)
  assert.equal(provider.records.has(currentKey), false)
  assert.deepEqual(await store.list(), [])
})

test('a valid destination and explicit removal clean damaged obsolete credentials', async () => {
  const provider = credentials()
  provider.records.set(currentKey, record)
  provider.records.set(legacyKey, { kind: 'grant', payload: {} })
  const store = createStore(provider)
  assert.deepEqual(await store.read(id), record.payload)
  assert.equal(provider.records.has(legacyKey), false)
  provider.records.set(legacyKey, { kind: 'grant', payload: {} })
  await store.remove(id)
  assert.equal(provider.records.has(legacyKey), false)
  assert.equal(provider.records.has(currentKey), false)
})

test('malformed keys and individual corrupt credentials cannot hide valid connections', async () => {
  const provider = credentials()
  provider.records.set(currentKey, record)
  provider.records.set(credentialKey('connections', 'connection-unrelated'), { kind: 'grant', payload: {} })
  provider.records.set(credentialKey('xunz-dsh-connections', secondId), { kind: 'grant', payload: { ...record.payload, id: secondId, name: undefined } })
  provider.records.set(credentialKey('other-plugin', id), { kind: 'grant', payload: record.payload })
  const store = createStore(provider)
  assert.deepEqual(await store.list(), [record.payload])
  await assert.rejects(store.read(secondId), /invalid/)
  assert.equal(provider.records.size, 4, 'unrecognized records remain owned by their original writer')
  const unavailable = createStore({ ...provider, async readRecord() { throw new Error('provider unavailable') } })
  await assert.rejects(unavailable.list(), /provider unavailable/)
})

test('connection intent changes preserve queued metadata edits and cannot recreate removed records', async () => {
  const provider = credentials()
  provider.records.set(legacyKey, record)
  const first = createStore(provider), second = createStore(provider)
  assert.equal((await first.setAutoConnect(id, false)).autoConnect, false)
  assert.equal(provider.records.has(legacyKey), false, 'intent changes share the native migration path')
  const edited = second.save({ id, name: 'Renamed', target: 'another', mode: 'managed' })
  const enabled = first.setAutoConnect(id, true)
  assert.deepEqual(await enabled, { ...await edited, autoConnect: true })
  const removed = second.remove(id)
  const disabled = first.setAutoConnect(id, false)
  await removed
  await assert.rejects(disabled, /no longer exists/)
  assert.equal(await first.read(id), undefined)
})
