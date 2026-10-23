import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceController, workspaceUrl } from '../src/client/workspaces.js'
import type { ConnectionView } from '../src/shared/types.js'

const first = 'connection-11111111-1111-4111-a111-111111111111'
const second = 'connection-22222222-2222-4222-a222-222222222222'
const token = 'workspace-private-test-credential'
const address = (port = 43188) => `http://127.0.0.1:${port}/?token=${token}`
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  let rows: ConnectionView[] = [{ id: first, name: 'First', target: 'first', phase: 'disconnected', remotePort: 3000 }]
  let connects = 0
  let opens = 0
  const saved = new Map<string, string>()
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value) },
    removeItem: (key: string) => { saved.delete(key) },
  }
  const api = {
    async list() { return structuredClone(rows) },
    async connect(id: string) {
      connects++
      const row = rows.find(row => row.id === id)!
      row.phase = 'connected'; row.localPort = 43188
      return structuredClone(row)
    },
    async open(_id: string) { opens++; return { url: address() } },
  }
  return { api, storage, saved, get rows() { return rows }, set rows(value) { rows = value }, get connects() { return connects }, get opens() { return opens } }
}

test('workspace opens only a connected authority and persists only its connection ID', async () => {
  const f = fixture()
  const controller = new WorkspaceController(f.api, { storage: f.storage })
  await controller.open(first)
  assert.equal(controller.getSnapshot()?.phase, 'ready')
  assert.equal(f.connects, 1)
  assert.equal(f.opens, 1)
  assert.deepEqual([...f.saved.values()], [first])
  assert.ok(!JSON.stringify([...f.saved]).includes(token))
  controller.close()
  assert.equal(controller.getSnapshot(), undefined)
  assert.equal(f.saved.size, 0)
  assert.equal(f.rows[0].phase, 'connected', 'returning local must leave remote work and tunnel running')
})

test('closing while authentication is pending prevents a late remote view from opening', async () => {
  const f = fixture()
  const opening = deferred<{ url: string }>()
  f.api.open = () => opening.promise
  const controller = new WorkspaceController(f.api, { storage: f.storage })
  const pending = controller.open(first)
  await new Promise(resolve => setImmediate(resolve))
  controller.close()
  opening.resolve({ url: address() })
  await pending
  assert.equal(controller.getSnapshot(), undefined)
  assert.equal(f.saved.size, 0)
})

test('removing or disconnecting during open rejects the stale launch URL', async () => {
  for (const removed of [false, true]) {
    const f = fixture()
    const opening = deferred<{ url: string }>()
    f.api.open = () => opening.promise
    const controller = new WorkspaceController(f.api)
    const pending = controller.open(first)
    await new Promise(resolve => setImmediate(resolve))
    if (removed) f.rows = []
    else { f.rows[0].phase = 'disconnected'; delete f.rows[0].localPort }
    opening.resolve({ url: address() })
    await pending
    assert.equal(controller.getSnapshot()?.phase, 'error')
    assert.equal(controller.getSnapshot()?.url, undefined)
    assert.ok(!JSON.stringify(controller.getSnapshot()).includes(token))
  }
})

test('switching selection ignores completion from the previous connection', async () => {
  const f = fixture()
  f.rows.push({ ...f.rows[0], id: second, name: 'Second' })
  const opening = deferred<{ url: string }>()
  f.api.open = id => id === first ? opening.promise : Promise.resolve({ url: address() })
  const controller = new WorkspaceController(f.api)
  const pending = controller.open(first)
  await new Promise(resolve => setImmediate(resolve))
  await controller.open(second)
  opening.resolve({ url: address() })
  await pending
  assert.equal(controller.getSnapshot()?.id, second)
  assert.equal(controller.getSnapshot()?.phase, 'ready')
})

test('restore uses a fresh owner open and invalid stored identities are cleared', async () => {
  const f = fixture()
  const old = new WorkspaceController(f.api, { storage: f.storage })
  await old.open(first)
  old.dispose()
  const restored = new WorkspaceController(f.api, { storage: f.storage })
  await restored.restore()
  assert.equal(restored.getSnapshot()?.phase, 'ready')
  assert.equal(f.opens, 2)
  assert.equal(f.connects, 1)
  for (const key of f.saved.keys()) f.saved.set(key, address())
  const invalid = new WorkspaceController(f.api, { storage: f.storage })
  await invalid.restore()
  assert.equal(invalid.getSnapshot(), undefined)
  assert.equal(f.saved.size, 0)
})

test('restore respects disabled auto-connect without forgetting the selected connection', async () => {
  for (const phase of ['disconnected', 'connecting', 'updating', 'error'] as const) {
    const f = fixture()
    f.saved.set('@xunz/dsh-connections/selected', first)
    f.rows[0] = { ...f.rows[0], autoConnect: false, phase }
    const controller = new WorkspaceController(f.api, { storage: f.storage })
    await controller.restore()
    assert.equal(f.connects, 0, phase)
    assert.equal(f.opens, 0, phase)
    assert.equal(controller.getSnapshot(), undefined, phase)
    assert.deepEqual([...f.saved.values()], [first], phase)
    await controller.open(first)
    assert.equal(f.connects, 1, 'explicit selection still connects')
    assert.equal(f.opens, 1)
    assert.equal(controller.getSnapshot()?.phase, 'ready')
  }
})

test('restore opens an already connected host even when auto-connect is disabled', async () => {
  const f = fixture()
  f.saved.set('@xunz/dsh-connections/selected', first)
  f.rows[0] = { ...f.rows[0], autoConnect: false, phase: 'connected', localPort: 43188 }
  const controller = new WorkspaceController(f.api, { storage: f.storage })
  await controller.restore()
  assert.equal(f.connects, 0)
  assert.equal(f.opens, 1)
  assert.equal(controller.getSnapshot()?.phase, 'ready')
})

test('restore still connects enabled and legacy connections', async () => {
  for (const autoConnect of [true, undefined]) {
    const f = fixture()
    f.saved.set('@xunz/dsh-connections/selected', first)
    if (autoConnect !== undefined) f.rows[0].autoConnect = autoConnect
    const controller = new WorkspaceController(f.api, { storage: f.storage })
    await controller.restore()
    assert.equal(f.connects, 1)
    assert.equal(f.opens, 1)
    assert.equal(controller.getSnapshot()?.phase, 'ready')
  }
})

test('connection health hides a stale frame without exposing its credential', async () => {
  const f = fixture()
  const controller = new WorkspaceController(f.api)
  await controller.open(first)
  f.rows[0].phase = 'error'
  await controller.check()
  assert.equal(controller.getSnapshot()?.error, 'disconnected')
  assert.equal(controller.getSnapshot()?.url, undefined)
})

test('in-app web view preserves same-site cookies and refuses unsupported parent origins', () => {
  assert.equal(workspaceUrl(address(), { protocol: 'http:', hostname: '127.0.0.1' }, false), address())
  assert.equal(new URL(workspaceUrl(address(), { protocol: 'http:', hostname: 'localhost' }, false)).hostname, 'localhost')
  assert.equal(workspaceUrl(address(), { protocol: 'dsh-app:', hostname: 'app' }, true), address())
  for (const page of [
    { protocol: 'dsh-app:', hostname: 'app' }, { protocol: 'https:', hostname: '127.0.0.1' },
    { protocol: 'http:', hostname: 'example.test' }, { protocol: 'http:', hostname: '[::1]' },
  ]) assert.throws(() => workspaceUrl(address(), page, false), /unsupported-workspace-surface/)
  assert.throws(() => workspaceUrl('https://example.test/?token=private', { protocol: 'http:', hostname: '127.0.0.1' }, true))
})

test('native slot delegation preserves the original leaf and follows its registration lifetime', async () => {
  const { SlotCore } = await import('@deepseek-ai/dsh-client-ui-slots')
  const { installWorkspaces } = await import('../src/client/workspaces.js')
  const core = new SlotCore()
  const hero = 'conversation.hero.workspace.directoryFlow'
  const sidebar = 'sidebar.workspaces.directoryFlow'
  const original = () => null
  const inject = () => ({ pick: async () => '/native/project' })
  const removeRoot = core.register({ name: 'root', children: {
    [hero]: { kind: 'single', scope: 'root' }, [sidebar]: { kind: 'single', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
  } }, (() => null) as never)
  const removeHero = core.register({ name: hero, inject }, original)
  core.register({ name: sidebar, inject }, original)
  const effects: (() => void)[] = []
  const injections: (() => void)[] = []
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { value: { location: { protocol: 'http:', hostname: '127.0.0.1' } }, configurable: true })
  const context = {
    effect: (factory: () => (() => void)) => { effects.push(factory()) },
    locale: { register: () => () => {}, bind: () => () => '' },
    slots: {
      register: core.register.bind(core), entries: core.entries.bind(core), subscribe: core.subscribe.bind(core),
      inject: (_slot: string, install: () => () => void) => { injections.push(install()) },
    },
  }
  try {
    const f = fixture()
    installWorkspaces(context as never, f.api as never, () => '')
    const heroAlias = 'connections.local.heroDirectoryFlow'
    const delegated = core.entries(heroAlias)[0]
    assert.equal(delegated.component, original)
    assert.equal(delegated.inject, inject)
    assert.deepEqual(core.entriesOfSlot(hero)[0].children?.[heroAlias], { kind: 'single', scope: 'root' })
    assert.equal(core.entries('connections.local.sidebarDirectoryFlow')[0].component, original)
    const Picker = core.entriesOfSlot(hero)[0].component as (props: Record<string, unknown>) => {
      props: { owner: Record<string, unknown>; renderLocal(owner: Record<string, unknown>): unknown }
    }
    let forwarded: Record<string, unknown> | undefined
    const owner = { open: true, busy: false, onPicked: () => {}, onCancel: () => {}, onError: () => {} }
    const rendered = Picker({ ...owner, t: () => 'wrong namespace', useStore: () => ({}),
      renderSlot: (_key: string, props: Record<string, unknown>) => { forwarded = props; return null } })
    rendered.props.renderLocal(rendered.props.owner)
    assert.deepEqual(forwarded, owner, 'framework locale/store props must not override the native picker injected face')
    removeHero()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(core.entries(heroAlias).length, 0)
    const replacement = () => null
    core.register({ name: hero, inject }, replacement)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(core.entries(heroAlias)[0].component, replacement)
    for (const dispose of injections.reverse()) dispose()
    injections.length = 0
    assert.equal(core.specDynamic(heroAlias), undefined)
    assert.equal(core.entriesOfSlot(hero)[0].component, replacement)
  } finally {
    for (const dispose of injections.reverse()) dispose()
    for (const dispose of effects.reverse()) dispose()
    removeRoot()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
