import { CONNECTION_CONTRACTS } from '../../src/shared/contracts.js'
import { WORKSPACE_PROTOCOL } from '../../src/shared/workspace-protocol.js'
import { useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { HostChooser, RemoteWorkspace, WorkspaceController, desktopBrowser, workspaceMessages, workspaceUrl } from '../../src/client/workspaces.js'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { ConnectionView } from '../../src/shared/types.js'
import type { WorkspaceCatalogPage, WorkspaceRequest, WorkspaceResult, WorkspaceResultMap, WorkspaceViewState } from '../../src/shared/workspace-protocol.js'
import { WorkspaceBrowser } from '../../src/client/WorkspaceBrowser.js'

const query = new URLSearchParams(location.search)
const id = 'connection-11111111-1111-4111-a111-111111111111'
const row: ConnectionView = { id, name: 'Development', target: 'devbox', remotePort: 3000, phase: 'disconnected' }
const calls = { opens: 0, localPicks: 0, leases: 0, releases: [] as string[], loads: 0, external: [] as string[] }
const views = new Map<string, WorkspaceViewState>()
let viewCount = 0
const catalog = (remote: boolean): WorkspaceCatalogPage => ({
  protocol: WORKSPACE_PROTOCOL, revision: 'a'.repeat(43),
  workspaces: [{ id: 'project', title: remote ? 'Remote project' : 'Local project', path: '/project', sessionIds: ['chat', 'other'] }],
  sessions: [{ id: 'chat', title: remote ? 'Remote discussion' : 'Local discussion', updatedAt: 0, running: false, blank: false }, { id: 'other', title: remote ? 'Another remote discussion' : 'Another local discussion', updatedAt: 0, running: false, blank: false }],
  archivedSessionIds: [], pinnedSessionIds: [],
})
let pendingLease: (() => void) | undefined
let popup: (() => void) | undefined
const api = {
  async reconnect() { return api.connect() },
  async list() { return [{ ...row }] },
  async connect() { row.phase = 'connected'; row.localPort = 43188; row.transportId = crypto.randomUUID(); return { ...row } },
  async open() { calls.opens++; return { url: 'http://127.0.0.1:43188/?token=fixture-workspace-private-credential' } },
  async workspace<R extends WorkspaceRequest>(sourceId: string, request: R): Promise<WorkspaceResultMap[R['op']]> {
    let result: WorkspaceResult
    switch (request.op) {
      case 'catalog': result = catalog(sourceId !== 'local'); break
      case 'openView': {
        const channel = String(++viewCount).padStart(43, 'a')
        result = { protocol: WORKSPACE_PROTOCOL, contracts: { ...CONNECTION_CONTRACTS }, channel, revision: 0, presentedRevision: 0, reportedRevision: 0 }; views.set(channel, result); break
      }
      case 'navigate': {
        const previous = views.get(request.channel)!
        result = { ...previous, revision: previous.revision + 1, presentedRevision: query.has('unpresented') ? 0 : previous.revision + 1 }; views.set(request.channel, result); break
      }
      case 'viewState': result = views.get(request.channel)!; break
      case 'closeView': views.delete(request.channel); result = { closed: true }; break
      default: result = { done: true }
    }
    return result as WorkspaceResultMap[R['op']]
  },
}
if (query.has('desktop')) {
  window.open = ((url?: string | URL) => { calls.external.push(String(url)); return null }) as typeof window.open
  const nativeCreate = document.createElement.bind(document)
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const element = nativeCreate(tag, options)
    if (tag === 'webview') {
      Object.assign(element, { loadURL: async () => {
        calls.loads++
        if (query.has('loadfail')) throw new Error('http://127.0.0.1:43188/?token=fixture-workspace-private-credential')
      } })
      queueMicrotask(() => element.dispatchEvent(new Event('dom-ready')))
    }
    return element
  }) as typeof document.createElement
  const bridge: DesktopBrowserBridge = {
    async acquire() {
      calls.leases++
      if (query.has('acquirefail')) throw new Error('Guest allocation failed')
      if (query.has('slowlease')) await new Promise<void>(resolve => { pendingLease = resolve })
      return { lease: `lease-${calls.leases}` as DesktopBrowserLeaseId, partition: 'fixture-private-partition' }
    },
    async release(lease) { calls.releases.push(lease) },
    onOpenRequested(_lease, listener) { popup = () => listener('https://example.test/'); return () => { popup = undefined } },
  }
  Object.assign(globalThis, { dshDesktop: { protocolVersion: 1, browser: bridge } })
}
const bridge = desktopBrowser()
const controller = new WorkspaceController(api, {
  storage: localStorage, prepareUrl: url => workspaceUrl(url, location, bridge !== undefined),
  presentationTimeoutMs: query.has('timeout') ? 1500 : 30_000,
  localNavigate: target => { if (target.kind === 'session') controller.localSelection(target.id) },
})
const messages = query.has('zh') ? workspaceMessages.zh : workspaceMessages.en
const t = (key: keyof typeof workspaceMessages.en) => messages[key]
function LocalPicker({ owner }: { owner: DirectoryFlowOwnerProps }) {
  return <div role="dialog" aria-label="Native local directory picker"><button onClick={() => owner.onPicked('/local/project')}>Confirm local folder</button><button onClick={owner.onCancel}>Cancel local picker</button></div>
}
function App() {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState('')
  const { sources, selected } = useSyncExternalStore(controller.subscribe, controller.getCatalogs)
  const remote = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const owner: DirectoryFlowOwnerProps = { open, busy: false, onCancel: () => setOpen(false), onError: () => {}, onPicked: path => { calls.localPicks++; setPicked(path); setOpen(false) } }
  return <><style>{`main#root{display:flex;max-width:none;margin:0;padding:0;height:100dvh}aside{width:266px;flex:none;background:#f8f9fa;padding-top:20px}.workspace-main{display:flex;min-width:0;flex:1;position:relative}.local-content{padding:36px}`}</style>
    <aside><WorkspaceBrowser sources={sources} selected={selected} onOpenSession={(id, sessionId) => controller.navigate(id, { kind: 'session', id: sessionId })} onOpenWorkspace={(id, workspaceId) => controller.navigate(id, { kind: 'workspace', id: workspaceId })}
      onNewSession={(id, workspaceId) => controller.navigate(id, { kind: 'newSession', id: workspaceId })}
      onAddWorkspace={() => setOpen(true)} onReconnect={id => controller.retry(id)}
      onRenameWorkspace={(id, workspaceId, title) => controller.mutate(id, { op: 'renameWorkspace', id: workspaceId, title }, sources.find(source => source.id === id)?.info?.transportId)}
      onForgetWorkspace={(id, workspaceId) => controller.mutate(id, { op: 'forgetWorkspace', id: workspaceId }, sources.find(source => source.id === id)?.info?.transportId)}
      onRenameSession={(id, sessionId, title) => controller.mutate(id, { op: 'renameSession', id: sessionId, title }, sources.find(source => source.id === id)?.info?.transportId)}
      onArchiveSession={(id, sessionId, archived) => controller.mutate(id, { op: 'archiveSession', id: sessionId, archived }, sources.find(source => source.id === id)?.info?.transportId)}
      onPinSession={(id, sessionId, pinned) => controller.mutate(id, { op: 'pinSession', id: sessionId, pinned }, sources.find(source => source.id === id)?.info?.transportId)} /></aside>
    <div className="workspace-main">{remote ? <RemoteWorkspace controller={controller} t={t} bridge={bridge} /> : <div className="local-content"><h1>Local native workspace</h1><output>{picked}</output></div>}</div>
    <HostChooser owner={owner} controller={controller} t={t} renderLocal={owner => <LocalPicker owner={owner} />} />
  </>
}
Object.assign(globalThis, { workspaceFixture: {
  snapshot: () => ({ ...calls, releases: [...calls.releases], phase: controller.getSnapshot()?.phase, selected: controller.getSnapshot()?.id }),
  settleLease: () => pendingLease?.(), popup: () => popup?.(),
  presented: async () => { for (const view of views.values()) view.presentedRevision = view.revision; await controller.check() },
  disconnect: async () => { row.phase = 'disconnected'; delete row.localPort; await controller.check() },
  crash: () => document.querySelector('webview')?.dispatchEvent(new Event('render-process-gone')),
} })
void controller.restore()
window.addEventListener('beforeunload', () => controller.dispose())
createRoot(document.getElementById('root')!).render(<App />)
