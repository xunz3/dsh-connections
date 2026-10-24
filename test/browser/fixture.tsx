import { createRoot } from 'react-dom/client'
import { Panel } from '../../src/client/Panel.js'
import { en, zh } from '../../src/client/messages.js'
import type { ConnectionView, ConnectionsApi } from '../../src/shared/types.js'
import { parseLaunchUrl } from '../../src/shared/validation.js'

const query = new URLSearchParams(location.search)
let rows: ConnectionView[] = query.has('populated') ? [
  { id: 'connection-11111111-1111-4111-a111-111111111111', name: 'Development', target: 'Dev', remotePort: 3000, phase: 'connected', localPort: 43188 },
  { id: 'connection-22222222-2222-4222-a222-222222222222', name: 'Research workstation', target: 'ICT_IGL16', remotePort: 3000, phase: 'disconnected' },
] : []
const id = 'connection-33333333-3333-4333-a333-333333333333'
let sshHostRequests = 0
const api: ConnectionsApi = {
  async sshHosts() {
    const request = ++sshHostRequests
    const scenario = query.get('sshHosts')
    if (scenario === 'slow' || (scenario === 'refresherror' && request === 3)) await new Promise(resolve => setTimeout(resolve, 800))
    document.documentElement.dataset.sshHostsSettled = String(request)
    if (scenario === 'error' && request === 1) throw new Error('Unable to read SSH configuration.')
    if (scenario === 'refresherror' && request === 2) throw new Error('Unable to read SSH configuration.')
    if (scenario === 'empty') return []
    if (scenario === 'changing' && request > 1) return ['WSL_Ubuntu_R']
    return ['Dev', 'DH_H800', 'WSL_Ubuntu_R']
  },
  async list() { return structuredClone(rows) },
  async save(input) {
    const old = rows.find(row => row.id === input.id)
    const row: ConnectionView = { id: input.id ?? id, name: input.name, target: input.target, mode: input.mode, autoConnect: input.autoConnect, remotePort: input.launchUrl ? parseLaunchUrl(input.launchUrl).remotePort : old?.remotePort, phase: 'disconnected' }
    rows = [...rows.filter(item => item.id !== row.id), row]
    return row
  },
  async remove(id) { rows = rows.filter(row => row.id !== id) },
  async connect(id) {
    const row = rows.find(row => row.id === id)!
    row.phase = 'connecting'
    await new Promise(resolve => setTimeout(resolve, query.has('slow') ? 3000 : 100))
    if (row.phase !== 'connecting') throw new Error('Connection cancelled.')
    row.phase = 'connected'; row.localPort = 43188
    return { ...row }
  },
  async disconnect(id) { const row = rows.find(row => row.id === id)!; row.phase = 'disconnected'; delete row.localPort; return { ...row } },
  async update(input) {
    const row = rows.find(row => row.id === input.id)!
    row.phase = 'updating'
    await new Promise(resolve => setTimeout(resolve, 100))
    row.runtime = { version: input.version, pid: 123, service: 'systemd' }
    row.phase = 'connected'; row.localPort = 43188
    return { ...row }
  },
  async open() {
    if (query.has('slowopen')) await new Promise(resolve => setTimeout(resolve, 700))
    return { url: 'http://127.0.0.1:43188/?token=browser-test-token-not-a-real-credential' }
  },
}
const messages = query.has('zh') ? zh : en
createRoot(document.getElementById('root')!).render(<Panel onOpen={async id => { document.body.dataset.workspaceOpened = id }} api={api} t={key => messages[key]} local={!query.has('remote')} />)
