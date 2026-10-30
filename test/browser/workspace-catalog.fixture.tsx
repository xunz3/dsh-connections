import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkspaceBrowser, type WorkspaceSelection, type WorkspaceSource } from '../../src/client/WorkspaceBrowser.js'
import type { WorkspaceCatalog } from '../../src/shared/workspace-protocol.js'

const query = new URLSearchParams(location.search)
const calls: unknown[][] = []
let disconnect: () => void
let resolveReconnect: (() => void) | undefined
function catalog(remote: boolean): WorkspaceCatalog {
  if (query.has('large') && remote) {
    const sessions = Array.from({ length: 20_000 }, (_, index) => ({ id: `large-${index}`, title: `Large discussion ${index}`, updatedAt: 0, blank: false, running: false }))
    return { workspaces: [{ id: 'project', title: 'Remote project', path: '/project', sessionIds: sessions.map(row => row.id) }], sessions, pinnedSessionIds: [], archivedSessionIds: [] }
  }
  const workspaceTitle = query.has('long') ? '长期维护的跨主机工作区与连接管理项目' : remote ? 'Remote project' : 'Local project'
  const sessionTitle = query.has('long') ? '讨论远程工作区的模型配置、插件归属和侧栏设计' : remote ? 'Remote discussion' : 'Local discussion'
  return {
    workspaces: [{ id: 'project', title: workspaceTitle, path: '/project', sessionIds: ['same', 'pinned', 'archived'] }],
    sessions: [
      { id: 'same', title: sessionTitle, updatedAt: Date.now() - 120_000, blank: false, running: remote && !query.has('archiveRace') },
      { id: 'pinned', title: 'Plan release', updatedAt: 0, blank: false, running: false },
      { id: 'archived', title: 'Archived discussion', updatedAt: 0, blank: false, running: false },
    ],
    pinnedSessionIds: ['pinned'], archivedSessionIds: ['archived'],
  }
}
function App() {
  const [selected, setSelected] = useState<WorkspaceSelection | undefined>(query.has('selected') ? { sourceId: 'remote', sessionId: 'large-19999' } : undefined)
  const [wide, setWide] = useState(!query.has('rail'))
  const [sources, setSources] = useState<WorkspaceSource[]>([
    { id: 'local', name: 'This computer', phase: 'connected', catalog: catalog(false) },
    { id: 'remote', name: query.has('long') ? 'Development server with a long name' : 'devbox', phase: query.has('offline') ? 'disconnected' : 'connected', catalog: catalog(true) },
  ])
  disconnect = () => setSources(current => current.map(source => source.id === 'remote' ? { ...source, phase: 'disconnected' } : source))
  const record = (name: string, ...args: unknown[]) => { calls.push([name, ...args]) }
  return <>
    <style>{`main#root{display:flex;margin:0;padding:0;max-width:none;height:100dvh}aside{width:266px;flex:none;padding-top:20px;background:#f8f9fa}.fixture-content{padding:40px;min-width:0;flex:1}.fixture-content h1{font-size:20px;font-weight:500}.fixture-content p{color:#777d87}@media(prefers-color-scheme:dark){aside{background:#25262a}:root{--dsw-alias-interactive-bg-hover:#30343a;--dsw-alias-label-tertiary:#848a93}.fixture-content{color:#eceef1}}`}</style>
    <aside style={{ width: wide ? 266 : 56 }}><WorkspaceBrowser sources={sources} selected={selected} wide={wide} expandSidebar={() => { record('expandSidebar'); setWide(true) }} locale={query.has('zh') ? 'zh-CN' : 'en'}
      onOpenSession={(sourceId, sessionId) => { record('openSession', sourceId, sessionId); setSelected({ sourceId, sessionId }) }}
      onOpenWorkspace={(sourceId, workspaceId) => { record('openWorkspace', sourceId, workspaceId); setSelected({ sourceId, workspaceId }) }}
      onNewSession={(sourceId, workspaceId) => record('newSession', sourceId, workspaceId)}
      onAddWorkspace={() => record('add')}
      onReconnect={async id => { record('reconnect', id); await new Promise<void>(resolve => { resolveReconnect = resolve }); setSources(current => current.map(source => source.id === id ? { ...source, phase: 'connected' } : source)) }}
      onRenameWorkspace={(...args) => record('renameWorkspace', ...args)}
      onForgetWorkspace={(...args) => record('forgetWorkspace', ...args)}
      onRenameSession={(...args) => { record('renameSession', ...args); if (query.has('failRename')) throw new Error('The session is no longer available.') }}
      onArchiveSession={(sourceId, sessionId, archived, options) => {
        record('archiveSession', sourceId, sessionId, archived, ...(options ? [options] : []))
        if (query.has('archiveRace') && archived && !options?.stopActivity) throw Object.assign(new Error('private active-work diagnostic'), { code: 'SESSION_ACTIVE' })
      }}
      onPinSession={(...args) => record('pinSession', ...args)}
    /></aside>
    <div className="fixture-content"><h1>Workspace browser fixture</h1><p>{selected ? `${selected.sourceId}: ${selected.sessionId ?? selected.workspaceId}` : 'Choose a chat from either computer.'}</p></div>
  </>
}
Object.assign(globalThis, { workspaceCatalogFixture: { calls, disconnect: () => disconnect(), resolveReconnect: () => resolveReconnect?.() } })
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
