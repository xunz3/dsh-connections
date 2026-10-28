import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bindSettingsHostParent, createSettingsHostClient, type SettingsHostSnapshot } from '../src/client/settings-host-bridge.js'

const channel = 'a'.repeat(43)
const remote = 'connection-11111111-1111-4111-8111-111111111111'
const other = 'connection-22222222-2222-4222-8222-222222222222'
const parentOrigin = 'http://localhost:3000'
const childOrigin = 'http://localhost:4000'
const bridge = '@xunz/dsh-connections/settings-host'
const initial: SettingsHostSnapshot = {
  choices: [{ id: 'local', name: 'This computer', phase: 'connected' }, { id: remote, name: 'Server', phase: 'connected' }],
  selectedId: remote,
}

type Delivery = { data: unknown; origin: string; source: object; ports: MessagePort[]; targetOrigin?: string }
class WireEvent extends Event {
  constructor(readonly data: unknown, readonly origin: string, readonly source: object, readonly ports: MessagePort[]) { super('message') }
}
class FakeWindow extends EventTarget {
  parent: FakeWindow = this
  sender!: FakeWindow
  inbox: Delivery[] = []
  constructor(readonly origin: string) { super() }
  postMessage(data: unknown, targetOrigin: string, ports: MessagePort[] = []) {
    if (targetOrigin !== '*' && targetOrigin !== this.origin) return
    const delivery = { data: structuredClone(data), origin: this.sender.origin, source: this.sender, ports, targetOrigin }
    this.inbox.push(delivery)
    queueMicrotask(() => this.dispatchEvent(new WireEvent(delivery.data, delivery.origin, delivery.source, ports)))
  }
  deliver(data: unknown, { origin = this.sender.origin, source = this.sender, ports = [] }: Partial<Delivery> = {}) {
    this.dispatchEvent(new WireEvent(data, origin, source, ports))
  }
}
function inWindow<T>(window: FakeWindow, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window })
  try { return run() } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(predicate(), true, 'expected the asynchronous port state to settle')
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20))
function fixture(t: TestContext, bind = true) {
  const parent = new FakeWindow(parentOrigin), child = new FakeWindow(childOrigin)
  parent.sender = child; child.sender = parent; child.parent = parent
  const frame = Object.assign(new EventTarget(), { contentWindow: child })
  let value = initial
  const listeners = new Set<() => void>(), selected: string[] = [], readiness: boolean[] = []
  const cleanups: Array<() => void> = []
  const connect = () => {
    const dispose = inWindow(parent, () => bindSettingsHostParent({ frame: frame as unknown as HTMLIFrameElement, channel,
      origin: childOrigin, getSnapshot: () => value,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
      onSelect: id => { selected.push(id) }, onReady: ready => { readiness.push(ready) },
    }))
    cleanups.push(dispose)
    return dispose
  }
  const client = () => {
    const instance = inWindow(child, () => createSettingsHostClient(channel))
    cleanups.push(() => instance.dispose())
    return instance
  }
  if (bind) connect()
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup() })
  return { parent, child, frame, selected, readiness, listeners, connect, client,
    set(value_: SettingsHostSnapshot) { value = value_; for (const listener of listeners) listener() },
    hello: (nonce = 'document-1') => ({ bridge, version: 1, type: 'hello', channel, nonce }),
    offer: () => child.inbox.findLast(row => (row.data as { type?: string }).type === 'offer')!,
  }
}

test('only menu metadata crosses the bridge, and current parent choices authorize selection', async t => {
  const f = fixture(t)
  f.set({ ...initial, target: 'private-ssh-target', token: 'secret', choices: initial.choices.map(row => ({ ...row, url: 'secret-url', credential: 'secret' })) } as SettingsHostSnapshot)
  const client = f.client()
  await until(() => client.getSnapshot() !== undefined)
  assert.deepEqual(client.getSnapshot(), initial)
  assert.equal(f.readiness.at(-1), true)
  assert.deepEqual(Object.keys(f.parent.inbox[0].data as object).sort(), ['bridge', 'channel', 'nonce', 'type', 'version'])
  assert.equal(f.child.inbox[0].targetOrigin, childOrigin, 'the port is offered only to the exact configured origin')
  const updated: SettingsHostSnapshot = { selectedId: remote, choices: [...initial.choices, { id: other, name: 'Build server', phase: 'disconnected' }] }
  f.set(updated)
  await until(() => client.getSnapshot()?.choices.length === 3)
  assert.deepEqual(client.getSnapshot(), updated)
  client.select('not-allowed')
  f.offer().ports[0].postMessage({ type: 'select', id: 'not-allowed' })
  await settle()
  assert.deepEqual(f.selected, [])
  // Removal may race a menu click; the rendered snapshot is not authorization.
  f.set(initial)
  f.offer().ports[0].postMessage({ type: 'select', id: other })
  await settle()
  assert.deepEqual(f.selected, [])
  client.select('local')
  client.select('local')
  await until(() => f.selected.length === 1)
  await settle()
  assert.deepEqual(f.selected, ['local'], 'a valid switch consumes the old view capability once')
  assert.equal(f.readiness.at(-1), false)
})

test('selecting the current host leaves the established bridge usable', async t => {
  const f = fixture(t), client = f.client()
  await until(() => client.getSnapshot() !== undefined)
  client.select(remote)
  f.offer().ports[0].postMessage({ type: 'select', id: remote })
  await settle()
  assert.deepEqual(f.selected, [])
  assert.equal(f.readiness.at(-1), true)
  f.set({ ...initial, choices: initial.choices.map(row => ({ ...row, name: 'Renamed' })) })
  await until(() => client.getSnapshot()?.choices[0].name === 'Renamed')
  client.select('local')
  await until(() => f.selected.length === 1)
})

test('parent rejects wrong origin, window, channel, version and transferred hello ports', async t => {
  const f = fixture(t)
  f.parent.deliver(f.hello(), { origin: 'http://localhost:4001' })
  f.parent.deliver(f.hello(), { source: {} })
  f.parent.deliver({ ...f.hello(), channel: 'b'.repeat(43) })
  f.parent.deliver({ ...f.hello(), version: 2 })
  f.parent.deliver({ ...f.hello(), bridge: 'another-bridge' })
  f.parent.deliver({ ...f.hello(), extra: 'unexpected' })
  let closed = 0
  f.parent.deliver(f.hello(), { ports: [{ close() { closed++ } } as MessagePort] })
  await settle()
  assert.equal(closed, 1)
  assert.equal(f.child.inbox.length, 0)
  assert.deepEqual(f.readiness, [false])
  const client = f.client()
  await until(() => client.getSnapshot() !== undefined)
})

test('client pins its parent, channel and document nonce and accepts only one port', async t => {
  const f = fixture(t, false), client = f.client()
  await settle()
  const hello = f.parent.inbox[0].data as Record<string, unknown>
  let closed = 0
  const send = (data: unknown, delivery: Partial<Delivery> = {}) => f.child.deliver(data, { ports: [{ close() { closed++ } } as MessagePort], ...delivery })
  send({ ...hello, type: 'offer' }, { source: {} })
  send({ ...hello, type: 'offer', channel: 'b'.repeat(43) })
  send({ ...hello, type: 'offer', nonce: 'old-document' })
  send({ ...hello, type: 'offer' }, { origin: 'null' })
  send({ ...hello, type: 'offer' }, { origin: 'invalid-origin' })
  assert.equal(closed, 3, 'ports for another channel or client nonce are left to their own listener')
  assert.equal(client.getSnapshot(), undefined)
  f.connect()
  f.parent.deliver(hello)
  await until(() => client.getSnapshot() !== undefined)
  send({ ...hello, type: 'offer' })
  assert.equal(closed, 4, 'a second offer cannot replace an established channel')
  f.child.deliver({ ...hello, type: 'reset' }, { origin: 'http://other-parent.test' })
  assert.deepEqual(client.getSnapshot(), initial)
})

test('an initial iframe load after a completed handshake explicitly reconnects the same client', async t => {
  const f = fixture(t), client = f.client()
  await until(() => client.getSnapshot() !== undefined)
  const oldPort = f.offer().ports[0]
  f.frame.dispatchEvent(new Event('load'))
  assert.equal(f.readiness.at(-1), false)
  await until(() => f.child.inbox.filter(row => (row.data as { type?: string }).type === 'offer').length === 2 && f.readiness.at(-1) === true)
  assert.deepEqual(client.getSnapshot(), initial)
  oldPort.postMessage({ type: 'select', id: 'local' })
  await settle()
  assert.deepEqual(f.selected, [])
  client.select('local')
  await until(() => f.selected.length === 1)
})

test('iframe load between hello and acknowledgement also recovers', async t => {
  const f = fixture(t), client = f.client()
  // A hello has been queued, then load arrives while its offer is still pending.
  await Promise.resolve()
  assert.equal(f.child.inbox.length, 1)
  f.frame.dispatchEvent(new Event('load'))
  await until(() => client.getSnapshot() !== undefined && f.readiness.at(-1) === true)
  client.select('local')
  await until(() => f.selected.length === 1)
})

test('a new Settings client replaces the previous capability before iframe load or without navigation', async t => {
  const f = fixture(t), first = f.client()
  await until(() => first.getSnapshot() !== undefined)
  const oldPort = f.offer().ports[0]
  first.dispose()
  const next = f.client()
  await until(() => next.getSnapshot() !== undefined)
  oldPort.postMessage({ type: 'select', id: 'local' })
  await settle()
  assert.deepEqual(f.selected, [])
  next.select('local')
  await until(() => f.selected.length === 1)
})

test('disposing the parent revokes selection, subscription and load handlers', async t => {
  const f = fixture(t, false), dispose = f.connect(), client = f.client()
  await until(() => client.getSnapshot() !== undefined)
  dispose(); dispose()
  assert.equal(f.listeners.size, 0)
  assert.equal(f.readiness.at(-1), false)
  const messages = f.child.inbox.length
  client.select('local')
  f.parent.deliver(f.hello('replacement'))
  f.frame.dispatchEvent(new Event('load'))
  f.set({ ...initial, selectedId: 'local' })
  await settle()
  assert.deepEqual(f.selected, [])
  assert.equal(f.child.inbox.length, messages)
  assert.deepEqual(client.getSnapshot(), initial)
  client.dispose(); client.dispose()
  assert.equal(client.getSnapshot(), undefined)
})

test('invalid parent menu snapshots are not sent and cannot authorize a selection', async t => {
  const f = fixture(t), client = f.client()
  await until(() => client.getSnapshot() !== undefined)
  const invalid: SettingsHostSnapshot[] = [
    { ...initial, choices: [initial.choices[1]] },
    { ...initial, selectedId: other },
    { ...initial, choices: [...initial.choices, initial.choices[0]] },
    { ...initial, choices: initial.choices.map(row => ({ ...row, name: 'bad\nname' })) },
    { ...initial, choices: initial.choices.map(row => ({ ...row, phase: 'invented' })) } as unknown as SettingsHostSnapshot,
  ]
  for (const value of invalid) {
    f.set(value)
    f.offer().ports[0].postMessage({ type: 'select', id: 'local' })
    await settle()
    assert.deepEqual(client.getSnapshot(), initial)
    assert.deepEqual(f.selected, [])
  }
  f.set(initial)
  client.select('local')
  await until(() => f.selected.length === 1)
})

test('the client rejects malformed port data and stops notifying after disposal', async t => {
  const f = fixture(t, false), client = f.client(), pair = new MessageChannel()
  t.after(() => { pair.port1.close(); pair.port2.close() })
  let acknowledgements = 0, notifications = 0
  pair.port1.onmessage = event => { if (event.data.type === 'ready') acknowledgements++ }
  client.subscribe(() => { notifications++ })
  await settle()
  f.child.deliver({ ...f.parent.inbox[0].data as object, type: 'offer' }, { ports: [pair.port2] })
  await until(() => acknowledgements === 1)
  pair.port1.postMessage({ type: 'snapshot', value: initial })
  await until(() => notifications === 1)
  pair.port1.postMessage({ type: 'snapshot', value: { ...initial, selectedId: other } })
  pair.port1.postMessage({ type: 'snapshot', value: { ...initial, choices: [...initial.choices, initial.choices[0]] } })
  pair.port1.postMessage({ type: 'snapshot', value: initial, operation: 'unexpected' })
  pair.port1.postMessage({ type: 'execute', method: 'connect' })
  await settle()
  assert.equal(notifications, 1)
  assert.deepEqual(client.getSnapshot(), initial)
  client.dispose()
  pair.port1.postMessage({ type: 'snapshot', value: { ...initial, selectedId: 'local' } })
  await settle()
  assert.equal(notifications, 1)
  assert.equal(client.getSnapshot(), undefined)
})
