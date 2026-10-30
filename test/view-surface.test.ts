import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceEndpoint, type WorkspaceEndpointServices } from '../src/host/workspace-endpoint.js'
import { bindViewSurfaceParent, createViewSurfaceClient } from '../src/client/view-surface.js'
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
