import assert from 'node:assert/strict'
import test from 'node:test'
import { CONNECTION_CONTRACTS, matchingConnectionContracts, parseConnectionContracts } from '../src/shared/contracts.js'
import { WORKSPACE_PROTOCOL, parseWorkspaceRequest, parseWorkspaceResponse } from '../src/shared/workspace-protocol.js'
import { WorkspaceEndpoint, type WorkspaceEndpointServices } from '../src/host/workspace-endpoint.js'
import { WorkspaceController } from '../src/client/workspace-controller.js'
import type { WorkspaceRequest, WorkspaceResultMap } from '../src/shared/workspace-protocol.js'

function nativeServices(): WorkspaceEndpointServices {
  return {
    workspaceRegistry: { list: () => [], archivedSessionIds: [], pinnedSessionIds: [] },
    workspaceController: { async rename() {}, async delete() {}, async archiveSession() {}, async unarchiveSession() {}, async pinSession() {}, async unpinSession() {} },
    sessionController: { async list() { return { items: [] } }, async rename() {} },
  }
}
const signal = () => new AbortController().signal

test('contract inventory declares absent integrations and stays separate from runtime admission', () => {
  assert.equal(CONNECTION_CONTRACTS.workspaceProtocol, WORKSPACE_PROTOCOL)
  assert.equal(CONNECTION_CONTRACTS.sidebarAdapter, 0, 'no copied native sidebar factory')
  assert.equal(CONNECTION_CONTRACTS.remoteEventProtocol, 0, 'no event/control plane is advertised')
  assert.equal(CONNECTION_CONTRACTS.settingsFactory, 2, 'the remaining Settings bootstrap takes an owned snapshot-store dependency')
  assert.equal(CONNECTION_CONTRACTS.accountFactory, 2, 'slot delegation replaces whole Account factory derivation')
  assert.equal(matchingConnectionContracts(CONNECTION_CONTRACTS), true)
  assert.equal(matchingConnectionContracts(undefined), false)
  for (const key of ['schema', 'settingsFactory', 'accountFactory', 'workspaceProtocol', 'viewSurfaceProtocol'] as const) {
    const changed = { ...CONNECTION_CONTRACTS, [key]: 1 + CONNECTION_CONTRACTS[key as keyof typeof CONNECTION_CONTRACTS] }
    assert.equal(matchingConnectionContracts(changed), false)
  }
  assert.equal(matchingConnectionContracts({ ...CONNECTION_CONTRACTS, sidebarAdapter: 9, shortcutRegistry: 9, remoteEventProtocol: 9 }), true, 'unconsumed local/optional seams do not gate remote content')
  for (const value of [{ ...CONNECTION_CONTRACTS, token: 'private' }, { ...CONNECTION_CONTRACTS, schema: '1' }, { ...CONNECTION_CONTRACTS, schema: -1 }, { ...CONNECTION_CONTRACTS, schema: Number.MAX_SAFE_INTEGER }, []]) {
    assert.throws(() => parseConnectionContracts(value), /Invalid Connections contracts/)
  }
})

test('a mismatched content contract cannot rotate a healthy lease or disable catalogs', async t => {
  const endpoint = new WorkspaceEndpoint(nativeServices(), { maxChannels: 1 })
  t.after(() => endpoint.dispose())
  const request = { op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'tab', contracts: { ...CONNECTION_CONTRACTS } } as const
  const opened = await endpoint.handle(request, signal())
  assert.equal(opened.ok, true)
  if (!opened.ok) throw new Error('fixture lease missing')
  const response = parseWorkspaceResponse('openView', opened)
  if (!response.ok) throw new Error('fixture lease missing')
  assert.deepEqual(response.value.contracts, CONNECTION_CONTRACTS)
  const { channel } = response.value
  const mismatch = await endpoint.handle({ ...request, contracts: { ...CONNECTION_CONTRACTS, settingsFactory: 99 } }, signal())
  assert.equal(mismatch.ok, false)
  if (!mismatch.ok) assert.equal(mismatch.error.code, 'INCOMPATIBLE_PROTOCOL')
  assert.equal((await endpoint.handle({ op: 'viewState', channel }, signal())).ok, true)
  assert.equal((await endpoint.handle({ op: 'catalog', protocol: WORKSPACE_PROTOCOL }, signal())).ok, true)
  assert.throws(() => parseWorkspaceRequest({ ...request, contracts: { ...CONNECTION_CONTRACTS, token: 'private' } }))
})

test('an unreviewed native runtime cannot be admitted by identical plugin-owned contracts', async t => {
  const endpoint = new WorkspaceEndpoint(nativeServices(), { nativeVersion: '0.2.1-rc.6' })
  t.after(() => endpoint.dispose())
  const result = await endpoint.handle({ op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: 'future-tab', contracts: { ...CONNECTION_CONTRACTS } }, signal())
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'INCOMPATIBLE_PROTOCOL')
  assert.equal((await endpoint.handle({ op: 'catalog', protocol: WORKSPACE_PROTOCOL }, signal())).ok, true)
})

test('missing or incompatible advertisements stop remote content before opening its credential URL', async t => {
  for (const advertisement of [undefined, { ...CONNECTION_CONTRACTS, accountFactory: 42 }]) {
    const endpoint = new WorkspaceEndpoint(nativeServices())
    let opens = 0, navigations = 0, closes = 0
    const row = { id: 'connection-11111111-1111-4111-a111-111111111111', name: 'Remote', target: 'dev', phase: 'connected' as const, localPort: 43188 }
    const controller = new WorkspaceController({
      async list() { return [row] }, async connect() { return row }, async reconnect() { return row },
      async open() { opens++; return { url: 'http://127.0.0.1:43188/?token=private-test-credential' } },
      async workspace<R extends WorkspaceRequest>(_id: string, request: R): Promise<WorkspaceResultMap[R['op']]> {
        if (request.op === 'navigate') navigations++
        if (request.op === 'closeView') closes++
        const result = await endpoint.handle(request, signal())
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
        const value = request.op === 'openView' ? { ...result.value, contracts: advertisement } : result.value
        return value as WorkspaceResultMap[R['op']]
      },
    }, { catalogs: false })
    t.after(() => { controller.dispose(); endpoint.dispose() })
    await controller.open(row.id, { kind: 'pick' })
    assert.equal(controller.getSnapshot()?.error, 'protocolMismatch')
    assert.equal(opens, 0)
    assert.equal(navigations, 0)
    assert.equal(closes, 1, 'an allocated but rejected lease is released')
    assert.equal((await endpoint.handle({ op: 'catalog', protocol: WORKSPACE_PROTOCOL }, signal())).ok, true)
    controller.close()
    assert.equal(controller.getCatalogs().selected.sourceId, 'local')
  }
})
