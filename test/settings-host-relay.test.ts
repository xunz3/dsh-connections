import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceEndpoint, type WorkspaceEndpointServices } from '../src/host/workspace-endpoint.js'
import { bindSettingsHostRelay, createSettingsHostRelayClient, type SettingsHostEndpoint } from '../src/client/settings-host-relay.js'
import { WORKSPACE_PROTOCOL, type WorkspaceRequest, type WorkspaceResultMap } from '../src/shared/workspace-protocol.js'
import type { SettingsHostSnapshot } from '../src/shared/settings-host-protocol.js'

const remote = 'connection-11111111-1111-4111-8111-111111111111'
const snapshot: SettingsHostSnapshot = { choices: [
  { id: 'local', name: 'This computer', phase: 'connected' },
  { id: remote, name: 'Remote', phase: 'connected' },
], selectedId: remote }
const unused = async () => { throw new Error('The settings host relay must not call native session services') }
const services: WorkspaceEndpointServices = {
  workspaceRegistry: { list: () => [], archivedSessionIds: [], pinnedSessionIds: [] },
  workspaceController: { rename: unused, delete: unused, archiveSession: unused, unarchiveSession: unused, pinSession: unused, unpinSession: unused },
  sessionController: { list: unused, rename: unused },
}
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(predicate(), true, 'expected the settings relay state to settle')
}

test('native webview settings waits for its menu consumer and switches hosts once through the existing lease', async t => {
  const service = new WorkspaceEndpoint(services)
  t.after(() => service.dispose())
  const requests: WorkspaceRequest[] = []
  const endpoint: SettingsHostEndpoint = async <R extends WorkspaceRequest>(request: R, signal: AbortSignal) => {
    requests.push(request)
    const result = await service.handle(request, signal)
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value as WorkspaceResultMap[R['op']]
  }
  const signal = new AbortController().signal
  const { channel } = await endpoint({ op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'desktop-settings' }, signal)
  const { revision } = await endpoint({ op: 'navigate', channel, requestId: 'settings', target: { kind: 'settings' } }, signal)
  const selected: string[] = [], errors: unknown[] = []
  let ready = false
  const stop = bindSettingsHostRelay({ channel, revision, endpoint, getSnapshot: () => ({ ...snapshot, token: 'secret' }),
    onSelect: id => { selected.push(id) }, onReady: () => { ready = true }, onError: error => { errors.push(error) }, intervalMs: 2 })
  t.after(stop)
  await until(() => requests.filter(row => row.op === 'publishSettingsHosts').length >= 2)
  assert.equal(ready, false, 'publishing is not evidence that the embedded settings document consumed the menu')
  const client = createSettingsHostRelayClient(channel, endpoint, 2)
  t.after(() => client.dispose())
  await until(() => ready && client.getSnapshot() !== undefined)
  assert.deepEqual(client.getSnapshot(), snapshot)
  assert.equal(JSON.stringify(requests).includes('secret'), false)
  client.select(remote)
  client.select('not-in-menu')
  assert.deepEqual(selected, [])
  client.select('local'); client.select('local')
  await until(() => selected.length === 1)
  assert.deepEqual(selected, ['local'])
  assert.deepEqual(errors, [])
  const completed = requests.length
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(requests.length, completed, 'consumed host selection stops both relay loops')
})

test('disposed settings operations ignore late replies and abort their request signal', async () => {
  const channel = 'a'.repeat(43)
  let finish!: (value: unknown) => void
  let signal!: AbortSignal
  const endpoint: SettingsHostEndpoint = <R extends WorkspaceRequest>(_request: R, lifetime: AbortSignal) => {
    signal = lifetime
    return new Promise(resolve => { finish = value => resolve(value as WorkspaceResultMap[R['op']]) })
  }
  const selected: string[] = []
  let ready = false
  const stop = bindSettingsHostRelay({ channel, revision: 1, endpoint, getSnapshot: () => snapshot,
    onSelect: id => { selected.push(id) }, onReady: () => { ready = true }, onError: assert.fail })
  await new Promise<void>(resolve => setImmediate(resolve))
  stop()
  assert.equal(signal.aborted, true)
  finish({ revision: 1, snapshot, ready: true, selection: 'local' })
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(selected, [])
  assert.equal(ready, false)
  const client = createSettingsHostRelayClient(channel, endpoint)
  await new Promise<void>(resolve => setImmediate(resolve))
  client.dispose()
  assert.equal(signal.aborted, true)
  finish({ revision: 1, reportedRevision: 1, presentedRevision: 1, intent: { revision: 1, requestId: 'one', target: { kind: 'settings' } } })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(client.getSnapshot(), undefined)
})

const settled = () => new Promise<void>(resolve => setImmediate(resolve))
class Visibility extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible'
  readonly listeners = new Set<EventListenerOrEventListenerObject | null>()
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (type === 'visibilitychange') this.listeners.add(listener)
    super.addEventListener(type, listener, options)
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (type === 'visibilitychange') this.listeners.delete(listener)
    super.removeEventListener(type, listener, options)
  }
  set(value: DocumentVisibilityState) { this.visibilityState = value; this.dispatchEvent(new Event('visibilitychange')) }
}
async function fixture() {
  const service = new WorkspaceEndpoint(services), requests: WorkspaceRequest[] = []
  const signal = new AbortController().signal
  const endpoint: SettingsHostEndpoint = async <R extends WorkspaceRequest>(request: R, signal: AbortSignal) => {
    requests.push(structuredClone(request))
    const result = await service.handle(request, signal)
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value as WorkspaceResultMap[R['op']]
  }
  const { channel } = await endpoint({ op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'relay-lifecycle' }, signal)
  const { revision } = await endpoint({ op: 'navigate', channel, requestId: 'settings', target: { kind: 'settings' } }, signal)
  return { service, requests, endpoint, channel, revision, signal }
}

test('Desktop Settings publish, poll and queued selection pause hidden for ten minutes and consume once visible', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(), document = new Visibility(), selected: string[] = [], errors: unknown[] = []
  t.after(() => f.service.dispose())
  document.set('hidden')
  f.requests.length = 0
  let ready = false
  const stop = bindSettingsHostRelay({ ...f, document, getSnapshot: () => snapshot, onSelect: id => selected.push(id),
    onReady: () => { ready = true }, onError: error => errors.push(error), intervalMs: 2 })
  const client = createSettingsHostRelayClient(f.channel, f.endpoint, 2, { document })
  t.after(() => { stop(); client.dispose() })
  await settled()
  t.mock.timers.tick(10 * 60_000)
  await settled()
  assert.equal(f.requests.length, 0)
  document.set('visible')
  await settled()
  assert.deepEqual(client.getSnapshot(), snapshot)
  t.mock.timers.tick(2)
  await settled()
  assert.equal(ready, true)
  document.set('hidden')
  client.select('local'); client.select('local')
  const before = f.requests.length
  t.mock.timers.tick(10 * 60_000)
  await settled()
  assert.equal(f.requests.length, before)
  document.set('visible')
  document.set('visible')
  await settled()
  t.mock.timers.tick(2)
  await settled()
  assert.deepEqual(selected, ['local'])
  assert.equal(f.requests.slice(before).some(request => request.op === 'viewState'), true)
  assert.equal(f.requests.filter(request => request.op === 'selectSettingsHost').length, 1)
  assert.deepEqual(errors, [])
  assert.equal(document.listeners.size, 0, 'both one-consumer loops remove their visibility listener on consumption')
  const count = f.requests.length
  t.mock.timers.tick(10 * 60_000)
  await settled()
  assert.equal(f.requests.length, count)
})

test('a queued Settings selection is not migrated into a newer Settings revision after hiding', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(), document = new Visibility(), selected: string[] = [], errors: unknown[] = []
  t.after(() => f.service.dispose())
  const stop = bindSettingsHostRelay({ ...f, document, getSnapshot: () => snapshot, onSelect: id => selected.push(id),
    onReady() {}, onError: error => errors.push(error), intervalMs: 2 })
  const client = createSettingsHostRelayClient(f.channel, f.endpoint, 2, { document })
  t.after(() => { stop(); client.dispose() })
  await settled()
  assert.deepEqual(client.getSnapshot(), snapshot)
  document.set('hidden')
  client.select('local')
  await f.endpoint({ op: 'navigate', channel: f.channel, requestId: 'new-settings', target: { kind: 'settings' } }, f.signal)
  const count = f.requests.length
  t.mock.timers.tick(10 * 60_000)
  await settled()
  assert.equal(f.requests.length, count)
  document.set('visible')
  await settled()
  assert.deepEqual(selected, [])
  assert.equal(client.getSnapshot(), undefined)
  assert.equal(f.requests.some(request => request.op === 'selectSettingsHost'), false)
  assert.equal(errors.length, 1)
  assert.equal((errors[0] as { code: string }).code, 'CONFLICT')
  assert.equal(document.listeners.size, 0)
})

test('lost selection and publish replies retry only the same operation and never repeat host navigation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(), selected: string[] = []
  t.after(() => f.service.dispose())
  let selectionLost = false, publishLost = false
  const endpoint: SettingsHostEndpoint = async (request, signal) => {
    const result = await f.endpoint(request, signal)
    if (request.op === 'selectSettingsHost' && !selectionLost) { selectionLost = true; throw new Error('Lost selection reply') }
    if (request.op === 'publishSettingsHosts' && 'selection' in result && result.selection !== undefined && !publishLost) {
      publishLost = true
      throw new Error('Lost publish reply')
    }
    return result
  }
  const stop = bindSettingsHostRelay({ ...f, endpoint, getSnapshot: () => snapshot, onSelect: id => selected.push(id), onReady() {}, onError() {}, intervalMs: 2 })
  const client = createSettingsHostRelayClient(f.channel, endpoint, 2)
  t.after(() => { stop(); client.dispose() })
  await settled()
  client.select('local')
  for (let attempt = 0; attempt < 5; attempt++) { t.mock.timers.tick(2); await settled() }
  assert.equal(selectionLost, true)
  assert.equal(publishLost, true)
  assert.deepEqual(selected, ['local'])
  const selections = f.requests.filter(request => request.op === 'selectSettingsHost')
  assert.equal(selections.length, 2)
  assert.deepEqual(selections[0], selections[1])
  const count = f.requests.length
  t.mock.timers.tick(10_000)
  await settled()
  assert.equal(f.requests.length, count)
})

test('Settings parent and child use capped backoff, suppress hidden errors and clear waits on dispose', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const document = new Visibility(), calls: string[] = [], errors: unknown[] = []
  const endpoint: SettingsHostEndpoint = async request => { calls.push(request.op); throw new Error('Temporary relay outage') }
  const stop = bindSettingsHostRelay({ channel: 'b'.repeat(43), revision: 1, endpoint, document, intervalMs: 2, maxBackoffMs: 8,
    getSnapshot: () => snapshot, onSelect: assert.fail, onReady: assert.fail, onError: error => errors.push(error) })
  const client = createSettingsHostRelayClient('b'.repeat(43), endpoint, 2, { document, maxBackoffMs: 8 })
  t.after(() => { stop(); client.dispose() })
  const counts = () => [calls.filter(op => op === 'publishSettingsHosts').length, calls.filter(op => op === 'viewState').length]
  await settled()
  assert.deepEqual(counts(), [1, 1])
  for (const [ms, expected] of [[1, 1], [1, 2], [3, 2], [1, 3], [7, 3], [1, 4], [8, 5], [8, 6]]) {
    t.mock.timers.tick(ms)
    await settled()
    assert.deepEqual(counts(), [expected, expected])
  }
  document.set('hidden')
  t.mock.timers.tick(10 * 60_000)
  await settled()
  assert.deepEqual(counts(), [6, 6])
  assert.equal(errors.length, 6)
  document.set('visible')
  await settled()
  assert.deepEqual(counts(), [7, 7])
  document.set('hidden')
  stop(); client.dispose()
  assert.equal(document.listeners.size, 0)
  document.set('visible')
  t.mock.timers.tick(10 * 60_000)
  await settled()
  assert.deepEqual(counts(), [7, 7])
})

test('disposing a hidden queued selection cannot send it or navigate after visibility returns', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(), document = new Visibility(), selected: string[] = []
  t.after(() => f.service.dispose())
  const stop = bindSettingsHostRelay({ ...f, document, getSnapshot: () => snapshot, onSelect: id => selected.push(id), onReady() {}, onError: assert.fail, intervalMs: 2 })
  const client = createSettingsHostRelayClient(f.channel, f.endpoint, 2, { document })
  t.after(() => { stop(); client.dispose() })
  await settled()
  document.set('hidden')
  client.select('local')
  client.dispose()
  document.set('visible')
  await settled()
  assert.equal(f.requests.some(request => request.op === 'selectSettingsHost'), false)
  assert.deepEqual(selected, [])
  stop()
  assert.equal(document.listeners.size, 0)
})
