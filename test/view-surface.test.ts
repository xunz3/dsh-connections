import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceEndpoint, type WorkspaceEndpointServices } from '../src/host/workspace-endpoint.js'
import { getEventListeners } from 'node:events'
import { bindViewSurfaceParent, createViewSurfaceClient, createSurfaceReadinessDeadline, SurfaceLifecycle } from '../src/client/view-surface.js'
import type { SettingsHostEndpoint } from '../src/client/settings-host-relay.js'
import { WORKSPACE_PROTOCOL, parseWorkspaceRequest, type WorkspaceRequest, type WorkspaceResultMap } from '../src/shared/workspace-protocol.js'
import { parseLocalPresentation, parseLoginAction, type LocalPresentation, type LoginAction } from '../src/shared/view-surface-protocol.js'

const unused = async () => { throw new Error('The presentation/login surface must not call native workspace services') }
const services: WorkspaceEndpointServices = {
  workspaceRegistry: { list: () => [], archivedSessionIds: [], pinnedSessionIds: [] },
  workspaceController: { rename: unused, delete: unused, archiveSession: unused, unarchiveSession: unused, pinSession: unused, unpinSession: unused },
  sessionController: { list: unused, rename: unused },
}
const presentation = (): LocalPresentation => ({ locale: 'zh', theme: {
  preference: 'dark', fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
  textFontFamily: '', codeFontFamily: '', terminalFontFamily: '',
}, tokens: { '--dsw-alias-bg-base': '#111111', '--dsw-specific-sidebar-fill': '#181818' }, general: {
  transcriptView: 'standard', collapseTiming: 'completion', performanceUsage: 'compact',
  linkOpening: 'sidebar', busyEnter: 'queue', developerTools: false,
} })
const action: LoginAction = { kind: 'openLogin', url: 'https://example.com/login?code=temporary' }
const signal = new AbortController().signal
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { resolve, promise }
}
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(predicate(), true, 'expected the view surface state to settle')
}
async function fixture() {
  const service = new WorkspaceEndpoint(services, { nativeVersion: '0.2.1-rc.3' })
  const requests: WorkspaceRequest[] = []
  const endpoint: SettingsHostEndpoint = async <R extends WorkspaceRequest>(request: R, signal: AbortSignal) => {
    requests.push(structuredClone(request))
    const result = await service.handle(request, signal)
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value as WorkspaceResultMap[R['op']]
  }
  const { channel } = await endpoint({ op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'surface', presentation: presentation() }, signal)
  const { revision } = await endpoint({ op: 'navigate', channel, requestId: 'settings', target: { kind: 'settings' } }, signal)
  return { service, endpoint, requests, channel, revision }
}
const errorCode = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code
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

test('a new view has local presentation before its child starts and updates remain lease-local', async t => {
  const f = await fixture()
  t.after(() => f.service.dispose())
  const client = createViewSurfaceClient(f.channel, f.endpoint, 2)
  t.after(() => client.dispose())
  const initial = await client.ready
  assert.equal(initial.nativeVersion, '0.2.1-rc.3')
  assert.deepEqual(client.getSnapshot(), presentation())
  const updated: LocalPresentation = { ...presentation(), locale: 'en', general: { ...presentation().general, transcriptView: 'verbose', developerTools: true } }
  const stop = bindViewSurfaceParent({ channel: f.channel, endpoint: f.endpoint, getRevision: () => f.revision,
    getPresentation: () => updated, perform: unused, intervalMs: 2 })
  t.after(stop)
  await until(() => client.getSnapshot()?.locale === 'en')
  assert.deepEqual(client.getSnapshot()?.general, updated.general)
  const other = await f.endpoint({ op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'other', presentation: presentation() }, signal)
  assert.deepEqual((await f.endpoint({ op: 'surfaceSnapshot', channel: other.channel }, signal)).presentation, presentation())
  assert.equal(f.requests.every(request => ['openView', 'navigate', 'surfaceSnapshot', 'syncSurface'].includes(request.op)), true)
})

test('login capabilities reject executable schemes and credentials, and presentation follows native font limits', () => {
  for (const url of ['https://example.com/login', 'http://127.0.0.1:3000/login']) assert.equal(parseLoginAction({ kind: 'copyLogin', url }).url, url)
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/plain,secret', 'https://user:password@example.com/', '/relative', 'https://example.com/\nsecret']) {
    assert.throws(() => parseLoginAction({ kind: 'openLogin', url }), url)
    assert.throws(() => parseWorkspaceRequest({ op: 'requestSurface', channel: 'a'.repeat(43), id: 'login', revision: 1, action: { kind: 'openLogin', url } }), url)
  }
  assert.throws(() => parseLoginAction({ kind: 'invoke', url: 'https://example.com' }))
  for (const [field, value] of [['fontSize', 23], ['codeFontSize', 17], ['terminalFontSize', 21], ['fontSize', 9], ['codeFontSize', 11.5]]) {
    assert.throws(() => parseLocalPresentation({ ...presentation(), theme: { ...presentation().theme, [field]: value } }))
  }
  for (const value of ['url(https://example.com/x)', 'red;display:none', 'var(--safe)}']) {
    assert.deepEqual(parseLocalPresentation({ ...presentation(), tokens: { '--dsw-alias-bg-base': value } }).tokens, {})
  }
  assert.throws(() => parseLocalPresentation({ ...presentation(), general: undefined }))
  for (const [field, value] of [['transcriptView', 'unknown'], ['collapseTiming', 'eager'], ['performanceUsage', 'on'], ['linkOpening', 'shell'], ['busyEnter', 'execute'], ['developerTools', 'true']]) {
    assert.throws(() => parseLocalPresentation({ ...presentation(), general: { ...presentation().general, [field]: value } }))
  }
})

test('unsupported palette tokens are omitted while native bootstrap retains the valid presentation', async t => {
  const f = await fixture()
  t.after(() => f.service.dispose())
  const tokens = { ...presentation().tokens, '--dsw-extension-invalid': 'red;display:none', '--other-plugin': '#fff', '--dsw-extension-good': '#aabbcc' }
  await f.endpoint({ op: 'syncSurface', channel: f.channel, presentation: { ...presentation(), tokens }, acknowledgements: [] }, signal)
  const client = createViewSurfaceClient(f.channel, f.endpoint, 2)
  t.after(() => client.dispose())
  await client.ready
  assert.deepEqual(client.getSnapshot()?.tokens, { ...presentation().tokens, '--dsw-extension-good': '#aabbcc' })
})

test('bootstrap retries a transient surface failure without rejecting the remote document', async t => {
  const f = await fixture()
  t.after(() => f.service.dispose())
  let failures = 0
  const endpoint: SettingsHostEndpoint = async (request, lifetime) => {
    if (request.op === 'surfaceSnapshot' && failures++ === 0) throw new Error('Temporary transport outage')
    return f.endpoint(request, lifetime)
  }
  const client = createViewSurfaceClient(f.channel, endpoint, 2)
  t.after(() => client.dispose())
  assert.equal((await client.ready).nativeVersion, '0.2.1-rc.3')
  assert.ok(failures >= 2)
})

test('cancellation before enqueue leaves a tombstone and stale revisions or closed leases cannot request login', async t => {
  const f = await fixture()
  t.after(() => f.service.dispose())
  const input = { op: 'requestSurface' as const, channel: f.channel, revision: f.revision, id: 'cancelled-first', action }
  await f.endpoint({ op: 'cancelSurface', channel: f.channel, id: input.id }, signal)
  assert.deepEqual(await f.endpoint(input, signal), { status: 'failed' })
  assert.deepEqual(await f.endpoint({ op: 'syncSurface', channel: f.channel, presentation: presentation(), acknowledgements: [] }, signal), { requests: [] })
  await f.endpoint({ op: 'requestSurface', channel: f.channel, revision: f.revision, id: 'pending', action }, signal)
  await f.endpoint({ op: 'navigate', channel: f.channel, requestId: 'newer', target: { kind: 'plugins' } }, signal)
  await assert.rejects(f.endpoint({ ...input, id: 'pending' }, signal), errorCode('CONFLICT'))
  assert.deepEqual(await f.endpoint({ op: 'syncSurface', channel: f.channel, presentation: presentation(), acknowledgements: [] }, signal), { requests: [] })
  await f.endpoint({ op: 'closeView', channel: f.channel }, signal)
  await assert.rejects(f.endpoint({ ...input, revision: f.revision + 1 }, signal), errorCode('NOT_FOUND'))
})

test('a caller cancelled while reading the view cannot enqueue a late login request', async t => {
  const f = await fixture()
  t.after(() => f.service.dispose())
  const read = deferred<WorkspaceResultMap['viewState']>()
  let reading = false
  const endpoint: SettingsHostEndpoint = <R extends WorkspaceRequest>(request: R, lifetime: AbortSignal) => {
    if (request.op !== 'viewState') return f.endpoint(request, lifetime)
    reading = true
    return read.promise as Promise<WorkspaceResultMap[R['op']]>
  }
  const client = createViewSurfaceClient(f.channel, endpoint, 2)
  t.after(() => client.dispose())
  await client.ready
  const caller = new AbortController()
  const rejected = assert.rejects(client.request(action, caller.signal))
  await until(() => reading)
  caller.abort()
  read.resolve({ revision: f.revision, reportedRevision: 0, presentedRevision: 0 })
  await rejected
  assert.equal(f.requests.some(request => request.op === 'requestSurface'), false)
})

test('re-delivered requests and acknowledgement retries never repeat the local side effect', async t => {
  const f = await fixture()
  t.after(() => f.service.dispose())
  let dropped = false, retried = false
  const endpoint: SettingsHostEndpoint = async <R extends WorkspaceRequest>(request: R, lifetime: AbortSignal) => {
    if (request.op === 'syncSurface' && request.acknowledgements.length) {
      if (!dropped) {
        dropped = true
        // Simulate a lost acknowledgement while the same request is redelivered.
        return f.endpoint({ ...request, acknowledgements: [] }, lifetime) as Promise<WorkspaceResultMap[R['op']]>
      }
      retried = true
    }
    return f.endpoint(request, lifetime)
  }
  const performed: LoginAction[] = []
  const stop = bindViewSurfaceParent({ channel: f.channel, endpoint, getRevision: () => f.revision,
    getPresentation: presentation, perform: async input => { performed.push(input) }, intervalMs: 2 })
  t.after(stop)
  const client = createViewSurfaceClient(f.channel, f.endpoint, 2)
  t.after(() => client.dispose())
  await client.ready
  await client.request(action, signal)
  assert.equal(dropped, true)
  assert.equal(retried, true)
  assert.deepEqual(performed, [action])
})

test('a refused local capability rejects its caller without leaking native errors or repeating the action', async t => {
  const f = await fixture()
  t.after(() => f.service.dispose())
  let attempts = 0
  const stop = bindViewSurfaceParent({ channel: f.channel, endpoint: f.endpoint, getRevision: () => f.revision,
    getPresentation: presentation, perform: async () => { attempts++; throw new Error('private local diagnostic') }, intervalMs: 2 })
  t.after(stop)
  const client = createViewSurfaceClient(f.channel, f.endpoint, 2)
  t.after(() => client.dispose())
  await client.ready
  await assert.rejects(client.request({ kind: 'copyLogin', url: action.url }, signal), { message: 'The desktop could not complete this login action' })
  assert.equal(attempts, 1)
  assert.equal(f.requests.some(request => request.op === 'syncSurface' && request.acknowledgements.some(ack => ack.ok === false)), true)
  assert.equal(JSON.stringify(f.requests).includes('private local diagnostic'), false)
})

test('navigation during the parent admission check revokes the pending local side effect', async t => {
  const f = await fixture()
  t.after(() => f.service.dispose())
  const admission = deferred<WorkspaceResultMap['requestSurface']>()
  let checking = false, revision = f.revision
  await f.endpoint({ op: 'requestSurface', channel: f.channel, revision, id: 'racing-login', action }, signal)
  const endpoint: SettingsHostEndpoint = <R extends WorkspaceRequest>(request: R, lifetime: AbortSignal) => {
    if (request.op !== 'requestSurface') return f.endpoint(request, lifetime)
    checking = true
    return admission.promise as Promise<WorkspaceResultMap[R['op']]>
  }
  const performed: LoginAction[] = []
  const stop = bindViewSurfaceParent({ channel: f.channel, endpoint, getRevision: () => revision,
    getPresentation: presentation, perform: async input => { performed.push(input) }, intervalMs: 2 })
  t.after(stop)
  await until(() => checking)
  revision++
  admission.resolve({ status: 'pending' })
  await until(() => f.requests.some(request => request.op === 'syncSurface' && request.acknowledgements.length > 0))
  assert.deepEqual(performed, [], 'the admission RPC must not authorize a navigation that has already been superseded')
})

test('initially hidden parent, bootstrap and queued login spend ten minutes without RPC and resume once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const f = await fixture(), document = new Visibility()
  t.after(() => f.service.dispose())
  document.set('hidden')
  f.requests.length = 0
  const performed: LoginAction[] = []
  const stop = bindViewSurfaceParent({ ...f, document, getRevision: () => f.revision, getPresentation: presentation,
    perform: async input => { performed.push(input) }, intervalMs: 10 })
  const client = createViewSurfaceClient(f.channel, f.endpoint, 10, 50, { document })
  t.after(() => { stop(); client.dispose() })
  const requested = client.request(action, signal)
  void requested.catch(() => {})
  await settled()
  t.mock.timers.tick(10 * 60_000)
  await settled()
  assert.equal(f.requests.length, 0, 'hidden bootstrap, snapshot, sync and action waiting have no periodic RPC')
  document.set('visible')
  document.set('visible')
  await client.ready
  await settled()
  t.mock.timers.tick(10)
  await settled()
  t.mock.timers.tick(10)
  await settled()
  t.mock.timers.tick(250)
  await requested
  assert.deepEqual(performed, [action])
  const enqueued = f.requests.filter(request => request.op === 'requestSurface')
  assert.equal(new Set(enqueued.map(request => request.id)).size, 1)
  stop(); client.dispose()
  assert.equal(document.listeners.size, 0)
  const count = f.requests.length
  document.set('visible')
  t.mock.timers.tick(10 * 60_000)
  await settled()
  assert.equal(f.requests.length, count, 'disposal removes visibility listeners and pending timers')
})

test('hiding during parent admission discards the old reply and re-admits the same action on resume', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(), document = new Visibility()
  t.after(() => f.service.dispose())
  await f.endpoint({ op: 'requestSurface', channel: f.channel, revision: f.revision, id: 'paused-admission', action }, signal)
  const old = deferred<WorkspaceResultMap['requestSurface']>()
  let admissions = 0
  const endpoint: SettingsHostEndpoint = (request, signal) => {
    if (request.op === 'requestSurface' && ++admissions === 1) return old.promise as never
    return f.endpoint(request, signal)
  }
  const performed: LoginAction[] = []
  const stop = bindViewSurfaceParent({ ...f, endpoint, document, getRevision: () => f.revision, getPresentation: presentation,
    perform: async input => { performed.push(input) }, intervalMs: 10 })
  t.after(stop)
  await settled()
  assert.equal(admissions, 1)
  document.set('hidden')
  old.resolve({ status: 'pending' })
  await settled()
  const count = f.requests.length
  t.mock.timers.tick(10 * 60_000)
  await settled()
  assert.equal(f.requests.length, count)
  assert.deepEqual(performed, [])
  document.set('visible')
  await settled()
  assert.equal(admissions, 2, 'a pre-hide pending reply is not an authorization after resume')
  assert.deepEqual(performed, [action])
  t.mock.timers.tick(10)
  await settled()
  assert.deepEqual((await f.endpoint({ op: 'requestSurface', channel: f.channel, revision: f.revision, id: 'paused-admission', action }, signal)), { status: 'done' })
})

test('a transient parent admission failure stays pending instead of losing or replaying the login', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture()
  t.after(() => f.service.dispose())
  await f.endpoint({ op: 'requestSurface', channel: f.channel, revision: f.revision, id: 'retry-admission', action }, signal)
  let failed = false, performed = 0
  const endpoint: SettingsHostEndpoint = (request, signal) => {
    if (request.op === 'requestSurface' && !failed) { failed = true; return Promise.reject(new Error('Temporary admission transport failure')) }
    return f.endpoint(request, signal)
  }
  const stop = bindViewSurfaceParent({ ...f, endpoint, getRevision: () => f.revision, getPresentation: presentation,
    perform: async () => { performed++ }, intervalMs: 10 })
  t.after(stop)
  await settled()
  assert.equal(performed, 0)
  t.mock.timers.tick(10)
  await settled()
  assert.equal(performed, 1)
  t.mock.timers.tick(10)
  await settled()
  assert.equal(f.requests.some(request => request.op === 'syncSurface' && request.acknowledgements.some(ack => !ack.ok)), false)
  assert.deepEqual(await f.endpoint({ op: 'requestSurface', channel: f.channel, revision: f.revision, id: 'retry-admission', action }, signal), { status: 'done' })
})

test('an acknowledgement whose response is lost retries its tombstone without repeating the side effect', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture()
  t.after(() => f.service.dispose())
  await f.endpoint({ op: 'requestSurface', channel: f.channel, revision: f.revision, id: 'ack-loss', action }, signal)
  let acknowledgements = 0, performed = 0
  const endpoint: SettingsHostEndpoint = async (request, signal) => {
    const result = await f.endpoint(request, signal)
    if (request.op === 'syncSurface' && request.acknowledgements.length && ++acknowledgements === 1) throw new Error('Lost acknowledgement response')
    return result
  }
  const stop = bindViewSurfaceParent({ ...f, endpoint, getRevision: () => f.revision, getPresentation: presentation,
    perform: async () => { performed++ }, intervalMs: 10 })
  t.after(stop)
  await settled()
  t.mock.timers.tick(10)
  await settled()
  t.mock.timers.tick(10)
  await settled()
  assert.equal(acknowledgements, 2)
  assert.equal(performed, 1)
})

test('parent and child failures use capped backoff, pause hidden, and reconcile immediately visible', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const document = new Visibility(), calls: string[] = []
  const endpoint: SettingsHostEndpoint = async request => { calls.push(request.op); throw new Error('Temporary outage') }
  const stop = bindViewSurfaceParent({ channel: 'b'.repeat(43), endpoint, document, intervalMs: 2, maxBackoffMs: 8,
    getRevision: () => 1, getPresentation: presentation, perform: unused })
  const client = createViewSurfaceClient('b'.repeat(43), endpoint, 2, 30_000, { document, maxBackoffMs: 8 })
  void client.ready.catch(() => {})
  t.after(() => { stop(); client.dispose() })
  const counts = () => [calls.filter(op => op === 'syncSurface').length, calls.filter(op => op === 'surfaceSnapshot').length]
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
  document.set('visible')
  await settled()
  assert.deepEqual(counts(), [7, 7])
})

test('a paused submitted login checks its original revision and never migrates to a newer navigation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(), document = new Visibility()
  t.after(() => f.service.dispose())
  const client = createViewSurfaceClient(f.channel, f.endpoint, 10, 30_000, { document })
  t.after(() => client.dispose())
  await client.ready
  const rejected = assert.rejects(client.request(action, signal), errorCode('CONFLICT'))
  await settled()
  const input = f.requests.find(request => request.op === 'requestSurface')!
  document.set('hidden')
  const current = await f.endpoint({ op: 'navigate', channel: f.channel, requestId: 'new-navigation', target: { kind: 'plugins' } }, signal)
  t.mock.timers.tick(10 * 60_000)
  await settled()
  const paused = f.requests.length
  document.set('visible')
  await rejected
  await settled()
  assert.equal(f.requests.filter(request => request.op === 'requestSurface').length, 1)
  assert.equal(input.op === 'requestSurface' && input.revision, f.revision)
  assert.equal(current.revision, f.revision + 1)
  assert.equal(f.requests.slice(paused).some(request => request.op === 'viewState'), true)
  assert.equal(f.requests.filter(request => request.op === 'cancelSurface').length, 1)
})

test('hidden cancellation or disposal sends at most one tombstone and cannot resurrect queued actions', async t => {
  for (const submitted of [false, true]) for (const dispose of [false, true]) await t.test(`${submitted ? 'submitted' : 'not submitted'} / ${dispose ? 'dispose' : 'caller cancel'}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = await fixture(), document = new Visibility()
    t.after(() => f.service.dispose())
    if (!submitted) document.set('hidden')
    const client = createViewSurfaceClient(f.channel, f.endpoint, 10, 30_000, { document })
    void client.ready.catch(() => {})
    t.after(() => client.dispose())
    const caller = new AbortController()
    const rejected = assert.rejects(client.request(action, caller.signal))
    await settled()
    document.set('hidden')
    if (dispose) client.dispose()
    else caller.abort()
    await rejected
    await settled()
    assert.equal(f.requests.filter(request => request.op === 'cancelSurface').length, submitted ? 1 : 0)
    const requests = f.requests.filter(request => request.op === 'requestSurface').length
    t.mock.timers.tick(10 * 60_000)
    await settled()
    document.set('visible')
    await settled()
    assert.equal(f.requests.filter(request => request.op === 'requestSurface').length, requests)
    if (submitted) assert.deepEqual(await f.endpoint({ op: 'syncSurface', channel: f.channel, presentation: presentation(), acknowledgements: [] }, signal), { requests: [] })
    client.dispose()
    assert.equal(document.listeners.size, 0)
  })
})

test('already admitted actions expire explicitly across long hiding, never under a fresh ID or revision', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const f = await fixture(), document = new Visibility()
  t.after(() => f.service.dispose())
  const client = createViewSurfaceClient(f.channel, f.endpoint, 10, 30_000, { document })
  t.after(() => client.dispose())
  await client.ready
  const rejected = assert.rejects(client.request(action, signal), { message: 'The desktop could not complete this login action' })
  await settled()
  const submitted = f.requests.filter(request => request.op === 'requestSurface')
  assert.equal(submitted.length, 1)
  document.set('hidden')
  const count = f.requests.length
  t.mock.timers.tick(10 * 60_000)
  await settled()
  assert.equal(f.requests.length, count)
  document.set('visible')
  await rejected
  assert.deepEqual(f.requests.filter(request => request.op === 'requestSurface'), [submitted[0], submitted[0]])
  assert.equal(f.requests.some(request => request.op === 'cancelSurface'), false, 'the failed status is already final')
})

test('bootstrap deadlines cancel unresponsive reads and lifecycle waits release abort listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const document = new Visibility()
  const endpoint: SettingsHostEndpoint = async () => new Promise(() => {})
  const client = createViewSurfaceClient('b'.repeat(43), endpoint, 10, 20, { document })
  t.after(() => client.dispose())
  const rejected = assert.rejects(client.ready, { name: 'TimeoutError' })
  await settled()
  t.mock.timers.tick(20)
  await rejected
  assert.equal(document.listeners.size, 0)
  const lifecycle = new SurfaceLifecycle(document), caller = new AbortController()
  document.set('hidden')
  const waiting = assert.rejects(lifecycle.wait(caller.signal))
  assert.equal(getEventListeners(caller.signal, 'abort').length, 1)
  caller.abort()
  await waiting
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
  document.set('visible')
  const active = lifecycle.activeSignal
  const sleeping = lifecycle.sleep(10)
  assert.equal(getEventListeners(active, 'abort').length, 1)
  t.mock.timers.tick(10)
  await sleeping
  assert.equal(getEventListeners(active, 'abort').length, 0)
  document.set('hidden')
  const closing = new AbortController(), closed = assert.rejects(lifecycle.wait(closing.signal))
  lifecycle.dispose()
  await closed
  assert.equal(getEventListeners(closing.signal, 'abort').length, 0, 'disposal also cleans waits owned by a separate caller signal')
  assert.equal(document.listeners.size, 0)
})

test('an effect already started before hiding completes once and only its acknowledgement resumes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(), document = new Visibility(), effect = deferred<void>()
  t.after(() => f.service.dispose())
  await f.endpoint({ op: 'requestSurface', channel: f.channel, revision: f.revision, id: 'started-effect', action }, signal)
  let performed = 0
  const stop = bindViewSurfaceParent({ ...f, document, getRevision: () => f.revision, getPresentation: presentation,
    perform: async () => { performed++; await effect.promise }, intervalMs: 10 })
  t.after(stop)
  await settled()
  assert.equal(performed, 1)
  document.set('hidden')
  effect.resolve()
  await settled()
  const count = f.requests.length
  t.mock.timers.tick(10 * 60_000)
  await settled()
  assert.equal(f.requests.length, count)
  document.set('visible')
  await settled()
  assert.equal(performed, 1)
  assert.equal(f.requests.slice(count).some(request => request.op === 'syncSurface' && request.acknowledgements.some(ack => ack.id === 'started-effect' && ack.ok)), true)
})

test('client action-status failures back off to a cap and hidden request waiting does not poll', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(), document = new Visibility()
  t.after(() => f.service.dispose())
  let attempts = 0
  const endpoint: SettingsHostEndpoint = (request, signal) => {
    if (request.op === 'requestSurface') { attempts++; return Promise.reject(new Error('Temporary action-status failure')) }
    return f.endpoint(request, signal)
  }
  const client = createViewSurfaceClient(f.channel, endpoint, 1000, 30_000, { document, maxBackoffMs: 1000 })
  t.after(() => client.dispose())
  await client.ready
  const caller = new AbortController(), rejected = assert.rejects(client.request(action, caller.signal))
  await settled()
  assert.equal(attempts, 1)
  for (const [ms, expected] of [[249, 1], [1, 2], [499, 2], [1, 3], [999, 3], [1, 4], [1000, 5]]) {
    t.mock.timers.tick(ms)
    await settled()
    assert.equal(attempts, expected)
  }
  document.set('hidden')
  const count = f.requests.length
  t.mock.timers.tick(10 * 60_000)
  await settled()
  assert.equal(attempts, 5)
  assert.equal(f.requests.length, count)
  document.set('visible')
  await settled()
  assert.equal(attempts, 6)
  caller.abort()
  await rejected
  await settled()
  assert.equal(f.requests.filter(request => request.op === 'cancelSurface').length, 1)
})

test('a hidden expired lease fails closed on resume and never automatically opens a replacement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const f = await fixture(), document = new Visibility()
  t.after(() => f.service.dispose())
  const client = createViewSurfaceClient(f.channel, f.endpoint, 10, 30_000, { document })
  t.after(() => client.dispose())
  await client.ready
  const rejected = assert.rejects(client.request(action, signal))
  await settled()
  document.set('hidden')
  const count = f.requests.length
  t.mock.timers.tick(31 * 60_000)
  await settled()
  assert.equal(f.requests.length, count)
  document.set('visible')
  await rejected
  await settled()
  await assert.rejects(f.endpoint({ op: 'viewState', channel: f.channel }, signal), errorCode('NOT_FOUND'))
  assert.equal(document.listeners.size, 0)
  assert.equal(f.requests.filter(request => request.op === 'openView').length, 1)
  assert.equal(f.requests.filter(request => request.op === 'requestSurface').length, 1)
})

test('Settings host readiness keeps its remaining visible budget across hiding and can recover after expiry', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 })
  const document = new Visibility()
  document.set('hidden')
  let expired = 0
  const deadline = createSurfaceReadinessDeadline(() => { expired++ }, 1000, { document })
  t.after(() => deadline.dispose())
  t.mock.timers.tick(10 * 60_000)
  assert.equal(expired, 0, 'a Settings host handshake mounted while hidden has not used foreground time')
  document.set('visible')
  t.mock.timers.tick(400)
  document.set('hidden')
  t.mock.timers.tick(10 * 60_000)
  assert.equal(expired, 0)
  document.set('visible')
  t.mock.timers.tick(599)
  assert.equal(expired, 0)
  t.mock.timers.tick(1)
  assert.equal(expired, 1)
  deadline.setReady(true)
  t.mock.timers.tick(10 * 60_000)
  assert.equal(expired, 1, 'an eventual host offer can recover without a lingering timeout')
  deadline.setReady(false)
  t.mock.timers.tick(999)
  assert.equal(expired, 1, 'a replacement document has its own handshake budget')
  t.mock.timers.tick(1)
  assert.equal(expired, 2)
  deadline.dispose()
  assert.equal(document.listeners.size, 0)
  deadline.setReady(false)
  document.set('hidden'); document.set('visible')
  t.mock.timers.tick(10 * 60_000)
  assert.equal(expired, 2, 'closing the Settings effect revokes the deadline permanently')
})

test('Settings host readiness cancels its pending deadline before disposal or a new handshake', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 })
  const document = new Visibility()
  let expired = 0
  const deadline = createSurfaceReadinessDeadline(() => { expired++ }, 1000, { document })
  t.after(() => deadline.dispose())
  t.mock.timers.tick(400)
  deadline.setReady(true)
  t.mock.timers.tick(10 * 60_000)
  assert.equal(expired, 0)
  deadline.setReady(false)
  t.mock.timers.tick(400)
  deadline.dispose()
  assert.equal(document.listeners.size, 0)
  t.mock.timers.tick(10 * 60_000)
  assert.equal(expired, 0, 'a retired frame cannot publish a late update-content error')
})

test('mirrored palette mode is optional for old peers, explicit for new peers, and rejects unknown modes', () => {
  assert.deepEqual(parseLocalPresentation(presentation()), presentation())
  const mirrored = { ...presentation(), theme: { ...presentation().theme, mode: 'mirrored' as const } }
  assert.deepEqual(parseLocalPresentation(mirrored), mirrored)
  assert.throws(() => parseLocalPresentation({ ...presentation(), theme: { ...presentation().theme, mode: 'independent' } }), /projection mode/)
})
