import assert from 'node:assert/strict'
import test from 'node:test'
import { pollConnections } from '../src/client/connection-polling.js'

class Visibility extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible'
  set(value: DocumentVisibilityState) {
    this.visibilityState = value
    this.dispatchEvent(new Event('visibilitychange'))
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settled = async () => { await Promise.resolve(); await Promise.resolve() }

test('hidden pages pause and resume immediately with one read, including an unfinished old request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const document = new Visibility()
  const reads = [deferred<number>(), deferred<number>(), deferred<number>()]
  const values: number[] = []
  let calls = 0
  const polling = pollConnections({ document, read: () => reads[calls++].promise, onValue: value => values.push(value), onError: () => assert.fail('Unexpected failure') })
  t.after(() => polling.dispose())
  assert.equal(calls, 1)
  document.set('hidden')
  t.mock.timers.tick(10_000)
  assert.equal(calls, 1)
  document.set('visible')
  document.set('visible')
  polling.refresh()
  assert.equal(calls, 1, 'the old request still owns the only read slot')
  reads[0].resolve(0)
  await settled()
  assert.deepEqual(values, [], 'an answer from before hiding is stale')
  assert.equal(calls, 2)
  reads[1].resolve(1)
  await settled()
  assert.deepEqual(values, [1])
  document.set('hidden')
  t.mock.timers.tick(10_000)
  assert.equal(calls, 2)
  document.set('visible')
  assert.equal(calls, 3)
})

test('mutation invalidation drops old snapshots and coalesces requested refreshes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const document = new Visibility()
  const reads = [deferred<number>(), deferred<number>()]
  const values: number[] = []
  let calls = 0
  const polling = pollConnections({ document, read: () => reads[calls++].promise, onValue: value => values.push(value), onError: () => assert.fail('Unexpected failure') })
  t.after(() => polling.dispose())
  polling.invalidate()
  polling.refresh()
  polling.invalidate()
  polling.refresh()
  assert.equal(calls, 1)
  reads[0].resolve(0)
  await settled()
  assert.deepEqual(values, [])
  assert.equal(calls, 2)
  reads[1].resolve(1)
  await settled()
  assert.deepEqual(values, [1])
})

test('failed refresh preserves the last value and subsequent polling recovers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const document = new Visibility()
  const reads = [deferred<number>(), deferred<number>(), deferred<number>()]
  const values: number[] = []
  let calls = 0
  let failures = 0
  const polling = pollConnections({ document, read: () => reads[calls++].promise, onValue: value => values.push(value), onError: () => failures++ })
  t.after(() => polling.dispose())
  reads[0].resolve(1)
  await settled()
  t.mock.timers.tick(2500)
  reads[1].reject(new Error('Host temporarily unavailable'))
  await settled()
  assert.deepEqual(values, [1])
  assert.equal(failures, 1)
  t.mock.timers.tick(2500)
  reads[2].resolve(2)
  await settled()
  assert.deepEqual(values, [1, 2])
})

test('disposal silences pending success and failure and removes visibility subscriptions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const fails of [false, true]) {
    const document = new Visibility()
    const pending = deferred<number>()
    let calls = 0
    const polling = pollConnections({ document, read: () => { calls++; return pending.promise }, onValue: () => assert.fail('Late value'), onError: () => assert.fail('Late error') })
    polling.dispose()
    if (fails) pending.reject(new Error('Cancelled'))
    else pending.resolve(1)
    await settled()
    document.set('hidden')
    document.set('visible')
    polling.refresh()
    t.mock.timers.tick(10_000)
    assert.equal(calls, 1)
  }
})
