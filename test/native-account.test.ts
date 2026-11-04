import assert from 'node:assert/strict'
import test from 'node:test'
import type { AccountSnapshot } from '@deepseek-ai/dsh-client-ui-settings-account/client'
import { AccountLoginPresenter } from '../src/client/settings-native/account-login.js'
import { createSnapshotStore } from '../src/client/snapshot-store.js'
import { createLoginHost, type LoginAction } from '../src/client/login-host.js'

type View = NonNullable<AccountSnapshot['view']>
const view = (id: string, phase = 'waiting-browser', authorizeUrl?: string, status = 'signed-out') => ({ status, attempt: { id, phase, ...(authorizeUrl ? { authorizeUrl } : {}) } }) as unknown as View
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture(copy?: Promise<void>) {
  const source = createSnapshotStore<AccountSnapshot>({ view: undefined, details: undefined, avatar: undefined, failed: false })
  const actions: LoginAction[] = [], cancellations: string[] = [], requests: ReturnType<typeof deferred<View>>[] = []
  const host = createLoginHost(async action => { actions.push(action); if (action.kind === 'copyLogin') await copy }, assert.fail)
  const presenter = new AccountLoginPresenter({ account: source, host, destination: url => { const result = new URL(url); result.searchParams.set('theme', 'dark'); return result.href },
    start: () => { const request = deferred<View>(); requests.push(request); return request.promise }, cancel: async id => { cancellations.push(id) } })
  const publish = (value: View) => source.set({ ...source.getSnapshot(), view: value })
  return { source, actions, cancellations, requests, host, presenter, publish, dispose() { presenter.dispose(); host.dispose() } }
}
test('public Account stream identity owns one browser navigation and cancellation without native factory code', async () => {
  const f = fixture()
  try {
    const starting = f.presenter.start(); f.requests[0].resolve(view('one', 'initializing')); await starting
    f.publish(view('other', 'waiting-browser', 'https://login.example.test/foreign'))
    f.publish(view('one', 'waiting-browser', 'https://login.example.test/authorize'))
    f.publish(view('one', 'waiting-browser', 'https://login.example.test/authorize'))
    await tick()
    assert.deepEqual(f.actions, [{ kind: 'openLogin', url: 'https://login.example.test/authorize?theme=dark' }])
    await f.presenter.copy()
    assert.deepEqual(f.actions[1], { kind: 'copyLogin', url: 'https://login.example.test/authorize?theme=dark' })
    await f.presenter.close(); assert.deepEqual(f.cancellations, ['one'])
  } finally { f.dispose() }
})
test('closing before start settles cancels only the exact late attempt and never opens its browser', async () => {
  const f = fixture()
  try {
    const starting = f.presenter.start(); await f.presenter.close()
    f.requests[0].resolve(view('late', 'waiting-browser', 'https://login.example.test/late')); await starting; await tick()
    assert.deepEqual(f.cancellations, ['late']); assert.deepEqual(f.actions, []); assert.equal(f.presenter.state.getSnapshot().open, false)
  } finally { f.dispose() }
})
test('close and reopen defer late cleanup until the new attempt identity is known', async () => {
  const f = fixture()
  try {
    const first = f.presenter.start(); await f.presenter.close(); const second = f.presenter.start()
    f.requests[0].resolve(view('old', 'waiting-browser', 'https://login.example.test/old')); await first
    assert.deepEqual(f.cancellations, [], 'do not cancel an identity that the new start may legitimately reuse yet')
    f.requests[1].resolve(view('new', 'waiting-browser', 'https://login.example.test/new')); await second; await tick()
    assert.deepEqual(f.cancellations, ['old']); assert.equal(f.presenter.state.getSnapshot().attempt?.id, 'new')
    assert.deepEqual(f.actions, [{ kind: 'openLogin', url: 'https://login.example.test/new?theme=dark' }])
  } finally { f.dispose() }
})
test('a reused attempt returned to a reopened dialog is not cancelled as stale', async () => {
  const f = fixture()
  try {
    const first = f.presenter.start(); await f.presenter.close(); const second = f.presenter.start()
    f.requests[0].resolve(view('same', 'initializing')); await first
    f.requests[1].resolve(view('same', 'waiting-browser', 'https://login.example.test/same')); await second
    assert.deepEqual(f.cancellations, [])
  } finally { f.dispose() }
})
test('a stale copy settlement cannot mark a replacement attempt copied', async () => {
  const copy = deferred<void>(), f = fixture(copy.promise)
  try {
    const first = f.presenter.start(); f.requests[0].resolve(view('old', 'waiting-browser', 'https://login.example.test/old')); await first
    const copying = f.presenter.copy(); await tick(); await f.presenter.close()
    const second = f.presenter.start(); f.requests[1].resolve(view('new', 'waiting-browser', 'https://login.example.test/new')); await second
    copy.resolve(); await copying
    assert.equal(f.presenter.state.getSnapshot().copied, false)
    assert.equal(f.presenter.state.getSnapshot().attempt?.id, 'new')
  } finally { copy.resolve(); f.dispose() }
})
test('an old signed-in baseline or unrelated stream cannot close a new owned attempt', async () => {
  const f = fixture()
  try {
    f.publish(view('old', 'succeeded', undefined, 'credential-stored'))
    const starting = f.presenter.start(); f.requests[0].resolve(view('new', 'waiting-browser', 'https://login.example.test/new')); await starting
    assert.equal(f.presenter.state.getSnapshot().open, true)
    f.publish(view('foreign', 'succeeded', undefined, 'credential-stored'))
    assert.equal(f.presenter.state.getSnapshot().open, true)
    f.publish(view('new', 'succeeded', undefined, 'credential-stored'))
    assert.equal(f.presenter.state.getSnapshot().open, false)
  } finally { f.dispose() }
})
test('synchronous presentation failure retains a copyable attempt and does not escape the native stream', async () => {
  const f = fixture(); let copied = ''
  const presenter = new AccountLoginPresenter({ account: f.source, start: async () => view('owned', 'initializing'), cancel: async () => {}, destination: url => url,
    host: { dispose() {}, async copy(url) { copied = url }, prepare: () => ({ opener: null, closed: false, close() {}, location: { replace() { throw new Error('private browser detail') } } }) } })
  try {
    await presenter.start()
    assert.doesNotThrow(() => f.publish(view('owned', 'waiting-browser', 'https://login.example.test/copyable')))
    assert.equal(presenter.state.getSnapshot().failed, true)
    assert.equal(presenter.state.getSnapshot().attempt?.authorizeUrl, 'https://login.example.test/copyable')
    await presenter.copy(); assert.equal(copied, 'https://login.example.test/copyable')
  } finally { presenter.dispose(); f.dispose() }
})
test('copy failure is visible without carrying the native clipboard error into public state', async () => {
  const f = fixture()
  const presenter = new AccountLoginPresenter({ account: f.source, start: async () => view('owned', 'waiting-browser', 'https://login.example.test/copyable'), cancel: async () => {}, destination: url => url,
    host: { dispose() {}, async copy() { throw new Error('private clipboard credential detail') }, prepare: () => ({ opener: null, closed: false, close() {}, location: { replace() {} } }) } })
  try {
    await presenter.start(); await presenter.copy()
    assert.equal(presenter.state.getSnapshot().copyFailed, true)
    assert.equal(presenter.state.getSnapshot().failed, false, 'a clipboard failure is not an authentication failure')
    assert.ok(!JSON.stringify(presenter.state.getSnapshot()).includes('private clipboard'))
  } finally { presenter.dispose(); f.dispose() }
})
test('dispose cancels a late owned response and synchronous browser preparation is contained', async () => {
  const f = fixture()
  const starting = f.presenter.start(); f.presenter.dispose(); f.requests[0].resolve(view('late', 'waiting-browser', 'https://login.example.test/late')); await starting
  assert.deepEqual(f.actions, []); assert.deepEqual(f.cancellations, ['late']); f.host.dispose()
  const other = fixture(); other.host.dispose(); await other.presenter.start()
  assert.equal(other.presenter.state.getSnapshot().failed, true); assert.equal(other.requests.length, 0); other.dispose()
})
