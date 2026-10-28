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
  stop()
  assert.equal(signal.aborted, true)
  finish({ revision: 1, snapshot, ready: true, selection: 'local' })
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(selected, [])
  assert.equal(ready, false)
  const client = createSettingsHostRelayClient(channel, endpoint)
  client.dispose()
  assert.equal(signal.aborted, true)
  finish({ revision: 1, reportedRevision: 1, presentedRevision: 1, intent: { revision: 1, requestId: 'one', target: { kind: 'settings' } } })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(client.getSnapshot(), undefined)
})
