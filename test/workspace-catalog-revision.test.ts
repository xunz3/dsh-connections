import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { workspaceCatalogRevision } from '../src/host/workspace-catalog-revision.js'
import type { WorkspaceCatalog } from '../src/shared/workspace-protocol.js'

const originalRevision = (catalog: WorkspaceCatalog) => createHash('sha256').update(JSON.stringify(catalog)).digest('base64url')
function fixture(): WorkspaceCatalog {
  return {
    workspaces: [{ id: 'project', path: '/project/\n\t😀', title: '项目 "quoted" \\ \ud800', sessionIds: ['first', 'second'] }],
    sessions: [
      { id: 'first', title: 'First', updatedAt: 1, running: false, blank: false, cwd: '' },
      { id: 'second', title: 'Second', updatedAt: 2, running: true, blank: true, cwd: '/tmp/\n😀', origin: 'subagent', parentSessionId: 'first' },
    ],
    archivedSessionIds: ['archived-a', 'archived-b'], pinnedSessionIds: ['first', 'second'],
  }
}

test('streaming catalog revisions preserve exact projected JSON bytes', () => {
  const populated = fixture()
  const large: WorkspaceCatalog = { ...fixture(), sessions: Array.from({ length: 20_000 }, (_, index) => ({ id: `session-${index}`, title: `会话😀${index}`, updatedAt: index, running: index % 2 === 0, blank: false })) }
  large.workspaces[0]!.sessionIds = Array.from({ length: 23_000 }, (_, index) => `session-${index}`)
  for (const catalog of [{ workspaces: [], sessions: [], archivedSessionIds: [], pinnedSessionIds: [] }, populated, large]) {
    assert.equal(workspaceCatalogRevision(catalog), originalRevision(catalog))
  }
})

test('every projected field and native ordering still invalidates the catalog revision', () => {
  const initial = fixture(), revision = workspaceCatalogRevision(initial)
  const changes: Array<(catalog: WorkspaceCatalog) => void> = [
    c => { c.workspaces[0]!.id = 'other' }, c => { c.workspaces[0]!.path += '/changed' },
    c => { c.workspaces[0]!.title += '!' }, c => { c.workspaces[0]!.sessionIds.reverse() },
    c => { c.workspaces.push({ ...c.workspaces[0]!, id: 'second-project' }) },
    c => { c.sessions[0]!.id = 'other' }, c => { c.sessions[0]!.title += '!' },
    c => { c.sessions[0]!.updatedAt++ }, c => { c.sessions[0]!.running = true },
    c => { c.sessions[0]!.blank = true }, c => { c.sessions[0]!.cwd = '/changed' },
    c => { delete c.sessions[0]!.cwd }, c => { delete c.sessions[1]!.origin },
    c => { c.sessions[1]!.parentSessionId = 'other' }, c => { c.sessions.reverse() },
    c => { c.archivedSessionIds.reverse() }, c => { c.pinnedSessionIds.reverse() },
  ]
  for (const change of changes) {
    const catalog = structuredClone(initial)
    change(catalog)
    assert.notEqual(workspaceCatalogRevision(catalog), revision)
    assert.equal(workspaceCatalogRevision(catalog), originalRevision(catalog))
  }
})

test('unchanged hashing never serializes the complete catalog or a complete session array', () => {
  const catalog = fixture(), stringify = JSON.stringify
  const serialized: unknown[] = []
  JSON.stringify = ((value: unknown, ...args: unknown[]) => {
    serialized.push(value)
    return Reflect.apply(stringify, JSON, [value, ...args])
  }) as typeof JSON.stringify
  try { workspaceCatalogRevision(catalog) }
  finally { JSON.stringify = stringify }
  assert.equal(serialized.includes(catalog), false)
  assert.equal(serialized.includes(catalog.sessions), false)
  assert.equal(serialized.includes(catalog.workspaces), false)
})
