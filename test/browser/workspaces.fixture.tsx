import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HostChooser, RemoteWorkspace, WorkspaceController, desktopBrowser, workspaceMessages, workspaceUrl } from '../../src/client/workspaces.js'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { ConnectionView } from '../../src/shared/types.js'

const query = new URLSearchParams(location.search)
const id = 'connection-11111111-1111-4111-a111-111111111111'
const row: ConnectionView = { id, name: 'Development', target: 'devbox', remotePort: 3000, phase: 'disconnected' }
const calls = { connects: 0, opens: 0, localPicks: 0, leases: 0, releases: [] as string[], loads: 0, popups: 0, external: [] as string[] }
let pendingLease: (() => void) | undefined
let popup: (() => void) | undefined
const api = {
  async list() { return [{ ...row }] },
  async connect() { calls.connects++; row.phase = 'connected'; row.localPort = 43188; return { ...row } },
  async open() { calls.opens++; return { url: 'http://127.0.0.1:43188/?token=fixture-workspace-private-credential' } },
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
    onOpenRequested(_lease, listener) { popup = () => { calls.popups++; listener('https://example.test/') }; return () => { popup = undefined } },
  }
  Object.assign(globalThis, { dshDesktop: { protocolVersion: 1, browser: bridge } })
}
const bridge = desktopBrowser()
const controller = new WorkspaceController(api, { storage: localStorage, prepareUrl: url => workspaceUrl(url, location, bridge !== undefined) })
const messages = query.has('zh') ? workspaceMessages.zh : workspaceMessages.en
const t = (key: keyof typeof workspaceMessages.en) => messages[key]
function LocalPicker({ owner }: { owner: DirectoryFlowOwnerProps }) {
  return <div role="dialog" aria-label="Native local directory picker"><button onClick={() => owner.onPicked('/local/project')}>Confirm local folder</button><button onClick={owner.onCancel}>Cancel local picker</button></div>
}
function App() {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState('')
  const owner: DirectoryFlowOwnerProps = { open, busy: false, onCancel: () => setOpen(false), onError: () => {}, onPicked: path => { calls.localPicks++; setPicked(path); setOpen(false) } }
  return <><button onClick={() => setOpen(true)}>Open project</button><output>{picked}</output>
    <HostChooser owner={owner} controller={controller} t={t} renderLocal={owner => <LocalPicker owner={owner} />} />
    <RemoteWorkspace controller={controller} t={t} bridge={bridge} />
  </>
}
Object.assign(globalThis, { workspaceFixture: {
  snapshot: () => ({ ...calls, releases: [...calls.releases], phase: controller.getSnapshot()?.phase, selected: controller.getSnapshot()?.id }),
  settleLease: () => pendingLease?.(), popup: () => popup?.(),
  disconnect: async () => { row.phase = 'disconnected'; delete row.localPort; await controller.check() },
  crash: () => document.querySelector('webview')?.dispatchEvent(new Event('render-process-gone')),
} })
void controller.restore()
createRoot(document.getElementById('root')!).render(<App />)
