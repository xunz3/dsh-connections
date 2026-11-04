import assert from 'node:assert/strict'
import test from 'node:test'
import { createSnapshotStore } from '../src/client/snapshot-store.js'

test('owned snapshots stay referentially stable until a synchronous replacement', () => {
  const initial = { selected: 'local' }
  const store = createSnapshotStore(initial)
  const seen: string[] = []
  const off = store.subscribe(() => seen.push(store.getSnapshot().selected))
  assert.equal(store.getSnapshot(), initial)
  store.set(initial)
  assert.deepEqual(seen, [])
  const next = { selected: 'remote-a' }
  store.set(next)
  assert.equal(store.getSnapshot(), next)
  assert.deepEqual(seen, ['remote-a'])
  off(); off()
  store.set({ selected: 'local' })
  assert.deepEqual(seen, ['remote-a'])
})

test('subscription registrations have independent, idempotent cleanup', () => {
  const store = createSnapshotStore(0)
  let calls = 0
  const listener = () => { calls++ }
  const first = store.subscribe(listener)
  const second = store.subscribe(listener)
  first(); first()
  store.set(1)
  assert.equal(calls, 1)
  second()
  store.set(2)
  assert.equal(calls, 1)
})

test('notification captures additions and honors cleanup before another listener runs', () => {
  const store = createSnapshotStore(0)
  const seen: string[] = []
  let stopNext = () => {}
  let stopAdded: (() => void) | undefined
  const off = store.subscribe(() => {
    seen.push('first')
    stopNext()
    stopAdded ??= store.subscribe(() => seen.push('added'))
  })
  stopNext = store.subscribe(() => seen.push('retired'))
  store.set(1)
  assert.deepEqual(seen, ['first'])
  store.set(2)
  assert.deepEqual(seen, ['first', 'first', 'added'])
  off(); stopAdded?.()
})

test('one throwing observer cannot starve other mounted views', t => {
  const errors: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args) })
  const store = createSnapshotStore(false)
  const failure = new Error('controlled observer failure')
  const first = store.subscribe(() => { throw failure })
  let seen: boolean | undefined
  const second = store.subscribe(() => { seen = store.getSnapshot() })
  assert.doesNotThrow(() => store.set(true))
  assert.equal(seen, true)
  assert.deepEqual(errors, [['Connections snapshot observer failed', failure]])
  first(); second()
})

test('Object.is distinguishes signed zero and suppresses unchanged NaN', () => {
  const store = createSnapshotStore(0)
  let calls = 0
  const off = store.subscribe(() => { calls++ })
  store.set(-0); store.set(Number.NaN); store.set(Number.NaN)
  assert.equal(calls, 2)
  off()
})
