import assert from 'node:assert/strict'
import test from 'node:test'
import { createApi } from '../src/client/rpc.js'
import type { ConnectionView } from '../src/shared/types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { resolve, promise }
}

test('concurrent shell list samples share a read but mutations invalidate earlier samples', async () => {
  const reads: ReturnType<typeof deferred<{ ok: true; value: ConnectionView[] }>>[] = []
  const change = deferred<{ ok: true; value: ConnectionView }>()
  const row: ConnectionView = { id: 'connection-11111111-1111-4111-a111-111111111111', name: 'Development', target: 'devbox', phase: 'disconnected', mode: 'managed' }
  const api = createApi({ remote: { connections: {
    list() { const read = deferred<{ ok: true; value: ConnectionView[] }>(); reads.push(read); return read.promise },
    connect: () => change.promise,
  } } } as never)
  const old = api.list()
  assert.equal(api.list(), old)
  const connecting = api.connect(row.id)
  const duringChange = api.list()
  assert.notEqual(duringChange, old)
  assert.equal(reads.length, 2)
  reads[0].resolve({ ok: true, value: [row] })
  await old
  assert.equal(api.list(), duringChange, 'settling an invalidated old read cannot clear the newer pending sample')
  change.resolve({ ok: true, value: row })
  await connecting
  const latest = api.list()
  assert.notEqual(latest, duringChange)
  assert.equal(reads.length, 3, 'navigation after a mutation gets a fresh authority sample')
  reads[1].resolve({ ok: true, value: [row] })
  reads[2].resolve({ ok: true, value: [row] })
  await Promise.all([duringChange, latest])
})
