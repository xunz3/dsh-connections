import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveWorkspaceRows, workspaceRowKey, type WorkspaceSource } from '../src/client/workspace-catalog.js'
import type { WorkspaceCatalog, WorkspaceCatalogSession } from '../src/shared/workspace-protocol.js'

const session = (id: string, extra: Partial<WorkspaceCatalogSession> = {}): WorkspaceCatalogSession => ({ id, title: id, updatedAt: 0, blank: false, running: false, ...extra })
const catalog = (extra: Partial<WorkspaceCatalog> = {}): WorkspaceCatalog => ({
  workspaces: [{ id: 'project', title: 'Example', path: '/project', sessionIds: ['first', 'second', 'third'] }],
  sessions: ['first', 'second', 'third'].map(id => session(id)),
  archivedSessionIds: [], pinnedSessionIds: [], ...extra,
})
const source = (id = 'local', extra: Partial<WorkspaceSource> = {}): WorkspaceSource => ({ id, name: id === 'local' ? 'This computer' : 'Build server', phase: 'connected', catalog: catalog(), ...extra })

test('identical native workspace and session IDs remain distinct across computers', () => {
  const result = deriveWorkspaceRows([source(), source('remote')])
  assert.equal(result.length, 2)
  assert.notEqual(result[0].workspaces[0].key, result[1].workspaces[0].key)
  assert.notEqual(result[0].workspaces[0].sessions[0].key, result[1].workspaces[0].sessions[0].key)
  assert.notEqual(workspaceRowKey('a:b', 'workspace', 'c'), workspaceRowKey('a', 'workspace', 'b:c'))
  assert.deepEqual(result.map(row => row.workspaces[0].workspace.id), ['project', 'project'])
})

test('native workspace and manual session order survive pin partitioning without mutating catalogs', () => {
  const remote = source('remote', { catalog: catalog({
    workspaces: [{ id: 'second-project', title: 'Z', path: '/z', sessionIds: [] }, { id: 'project', title: 'A', path: '/a', sessionIds: ['third', 'first', 'second'] }],
    pinnedSessionIds: ['first', 'third'],
  }) })
  const before = structuredClone(remote)
  const result = deriveWorkspaceRows([remote])[0]
  assert.deepEqual(result.workspaces.map(row => row.workspace.id), ['second-project', 'project'])
  assert.deepEqual(result.workspaces[1].sessions.map(row => row.session.id), ['third', 'first', 'second'])
  assert.deepEqual(result.workspaces[1].sessions.map(row => row.pinned), [true, true, false])
  assert.deepEqual(remote, before)
})

test('archived and pinned filters use each owning host membership', () => {
  const local = source('local', { catalog: catalog({ archivedSessionIds: ['first'], pinnedSessionIds: ['first', 'second'] }) })
  const remote = source('remote', { catalog: catalog({ archivedSessionIds: ['second'], pinnedSessionIds: ['first'] }) })
  const active = deriveWorkspaceRows([local, remote])
  assert.deepEqual(active.map(row => row.workspaces[0].sessions.map(row => row.session.id)), [['second', 'third'], ['first', 'third']])
  const pinned = deriveWorkspaceRows([local, remote], { filter: 'pinned' })
  assert.deepEqual(pinned.map(row => row.workspaces[0].sessions.map(row => row.session.id)), [['second'], ['first']])
  const archived = deriveWorkspaceRows([local, remote], { filter: 'archived' })
  assert.deepEqual(archived.map(row => row.workspaces[0].sessions.map(row => [row.session.id, row.archived, row.pinned])), [[['first', true, false]], [['second', true, false]]])
})

test('only the selected host blank session is shown, and subagents do not become ordinary chats', () => {
  const data = catalog({
    sessions: [session('first', { blank: true }), session('second', { origin: 'subagent' }), session('third', { parentSessionId: 'parent' })],
  })
  const rows = deriveWorkspaceRows([source('local', { catalog: data }), source('remote', { catalog: data })], { selected: { sourceId: 'remote', sessionId: 'first' } })
  assert.deepEqual(rows.map(row => row.workspaces[0].sessions.map(row => row.session.id)), [['third'], ['first', 'third']])
  assert.equal(deriveWorkspaceRows([source('remote', { catalog: data })], { query: 'first', selected: { sourceId: 'remote', sessionId: 'first' } })[0].workspaces.length, 0)
})

test('title search finds chat, workspace, path, or computer while preserving order', () => {
  const sources = [source(), source('remote')]
  const byChat = deriveWorkspaceRows(sources, { query: 'SECOND' })
  assert.deepEqual(byChat.map(row => row.workspaces[0].sessions.map(row => row.session.id)), [['second'], ['second']])
  assert.equal(deriveWorkspaceRows(sources, { query: 'build server' })[0].workspaces.length, 0)
  assert.equal(deriveWorkspaceRows(sources, { query: 'build server' })[1].workspaces[0].sessions.length, 3)
  assert.equal(deriveWorkspaceRows(sources, { query: '/project' })[0].workspaces[0].sessions.length, 3)
  assert.equal(deriveWorkspaceRows(sources, { query: 'Example' })[0].workspaces[0].sessions.length, 3)
  assert.equal(deriveWorkspaceRows(sources, { query: 'missing' })[0].workspaces.length, 0)
})

test('disconnected hosts retain existing rows and hosts without a catalog remain represented', () => {
  const rows = deriveWorkspaceRows([source(), source('offline', { phase: 'disconnected' }), source('loading', { phase: 'connecting', catalog: undefined })])
  assert.equal(rows[0].workspaces.length, 1)
  assert.equal(rows[1].workspaces.length, 1)
  assert.equal(rows[1].source.phase, 'disconnected')
  assert.equal(rows[2].source.phase, 'connecting')
  assert.equal(rows[2].workspaces.length, 0)
})

test('loose sessions remain native loose sessions and missing catalog entries do not create rows', () => {
  const rows = deriveWorkspaceRows([source('remote', { catalog: catalog({
    workspaces: [{ id: 'project', title: 'Project', path: '/project', sessionIds: ['missing', 'first', 'first'] }],
    sessions: [session('first'), session('loose'), session('subagent', { origin: 'subagent' })],
  }) })])[0]
  assert.deepEqual(rows.workspaces[0].sessions.map(row => row.session.id), ['first'])
  assert.deepEqual(rows.looseSessions.map(row => row.session.id), ['loose'])
  assert.equal(rows.workspaces.length, 1, 'no synthetic workspace is created from a cwd')
})

test('empty native workspaces remain visible only in the unfiltered active view', () => {
  const sources = [source('remote', { catalog: catalog({ workspaces: [{ id: 'empty', title: 'Empty', path: '/empty', sessionIds: [] }], sessions: [] }) })]
  assert.equal(deriveWorkspaceRows(sources)[0].workspaces.length, 1)
  assert.equal(deriveWorkspaceRows(sources, { filter: 'pinned' })[0].workspaces.length, 0)
  assert.equal(deriveWorkspaceRows(sources, { filter: 'archived' })[0].workspaces.length, 0)
  assert.equal(deriveWorkspaceRows(sources, { query: 'empty' })[0].workspaces.length, 1)
  assert.equal(deriveWorkspaceRows(sources, { query: 'elsewhere' })[0].workspaces.length, 0)
})
