import { createRoot } from 'react-dom/client'
import { useRef, type ReactNode } from 'react'
import { useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import { Panel } from '../../src/client/Panel.js'
import { en, zh } from '../../src/client/messages.js'
import type { ConnectionView, ConnectionsApi } from '../../src/shared/types.js'
import { LATEST_SUPPORTED_REMOTE_VERSION, parseLaunchUrl } from '../../src/shared/validation.js'

const query = new URLSearchParams(location.search)
let rows: ConnectionView[] = query.has('populated') ? [
  { id: 'connection-11111111-1111-4111-a111-111111111111', name: 'Development', target: 'Dev', mode: 'existing', autoConnect: true, remotePort: 3000, phase: 'connected', localPort: 43188 },
  { id: 'connection-22222222-2222-4222-a222-222222222222', name: 'Research workstation', target: 'ICT_IGL16', mode: 'managed', autoConnect: false, remotePort: 3000, phase: 'disconnected' },
] : []
let created = 0, sshHostRequests = 0, sshChecks = 0, listRequests = 0, activeLists = 0
const saves: Record<string, number> = Object.create(null), connects: Record<string, number> = Object.create(null)
const generations = new Map<string, number>()
const publish = () => { document.documentElement.dataset.records = JSON.stringify(rows); document.documentElement.dataset.saves = JSON.stringify(saves); document.documentElement.dataset.connects = JSON.stringify(connects) }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const api: ConnectionsApi = {
  async checkSsh(target) {
    document.documentElement.dataset.sshChecks = String(++sshChecks)
    if (query.get('check') === 'slow') await delay(800)
    document.documentElement.dataset.sshCheckSettled = target
    return query.get('check') === 'error' ? { ok: false, code: 'SSH_DNS' } : { ok: true }
  },
  async sshHosts() {
    const request = ++sshHostRequests, scenario = query.get('sshHosts')
    if (scenario === 'slow' || (scenario === 'refresherror' && request === 3)) await delay(800)
    document.documentElement.dataset.sshHostsSettled = String(request)
    if (scenario === 'error' && request === 1 || scenario === 'refresherror' && request === 2) throw new Error('Unable to read SSH configuration.')
    if (scenario === 'empty') return []
    if (scenario === 'prototype') return ['__proto__', 'constructor']
    if (scenario === 'changing' && request > 1) return ['WSL_Ubuntu_R']
    if (scenario === 'shrinking' && request > 1) return ['WSL_Ubuntu_R']
    if (scenario === 'many' || scenario === 'shrinking') return ['Dev', 'DH_H800', 'WSL_Ubuntu_R', 'Build', 'Research', 'GPU', 'Staging', 'Notebook']
    return ['Dev', 'DH_H800', 'WSL_Ubuntu_R']
  },
  async reconnect(id) { return api.connect(id) },
  async list() {
    const request = ++listRequests, snapshot = structuredClone(rows)
    document.documentElement.dataset.listRequests = String(request)
    document.documentElement.dataset.activeLists = String(++activeLists)
    try {
      if (query.get('poll') === 'slow' && request > 1) await delay(800)
      if (query.get('poll') === 'error' && request === 2) throw new Error('Refresh failed')
      return snapshot
    } finally {
      document.documentElement.dataset.activeLists = String(--activeLists)
      document.documentElement.dataset.listSettled = String(request)
    }
  },
  async save(input) {
    saves[input.target] = (saves[input.target] ?? 0) + 1; publish()
    if (query.get('save') === 'slow') await delay(1000)
    if (query.get('save') === 'partial' && input.target === 'DH_H800' && saves[input.target] === 1) throw new Error('Unable to save DH_H800. Try again.')
    if (query.get('save') === 'prototype' && input.target === '__proto__' && saves[input.target] === 1) throw new Error('Unable to save __proto__. Try again.')
    const old = rows.find(row => row.id === input.id)
    const destinationChanged = old && (old.target !== input.target || (old.mode ?? 'existing') !== (input.mode ?? old.mode ?? 'existing'))
    const row: ConnectionView = old ?? { id: 'connection-33333333-3333-4333-a333-' + String(++created).padStart(12, '0'), name: input.name, target: input.target, phase: 'disconnected' }
    if (destinationChanged) { generations.set(row.id, (generations.get(row.id) ?? 0) + 1); row.phase = 'disconnected'; delete row.localPort }
    Object.assign(row, { name: input.name, target: input.target, mode: input.mode ?? old?.mode, autoConnect: input.autoConnect ?? old?.autoConnect ?? true, remotePort: input.launchUrl ? parseLaunchUrl(input.launchUrl).remotePort : old?.remotePort })
    rows = [...rows.filter(item => item.id !== row.id), row]; publish()
    return { ...row }
  },
  async remove(id) { generations.set(id, (generations.get(id) ?? 0) + 1); rows = rows.filter(row => row.id !== id); publish() },
  async connect(id) {
    const row = rows.find(row => row.id === id)!
    const version = (generations.get(id) ?? 0) + 1; generations.set(id, version)
    connects[row.target] = (connects[row.target] ?? 0) + 1
    row.autoConnect = true; row.phase = 'connecting'; delete row.error
    if (query.has('stages')) row.stage = 'preparing'
    publish()
    await delay(query.has('slow') ? 3000 : 100)
    document.documentElement.dataset.connectSettled = 'true'
    if (generations.get(id) !== version) throw new Error('Connection cancelled.')
    if (query.get('connect') === 'fail' && connects[row.target] === 1) { row.phase = 'error'; row.error = 'SSH connection refused. Retry when this host is available.'; delete row.stage; publish(); throw new Error(row.error) }
    row.phase = 'connected'; row.localPort = 43188; delete row.stage; publish()
    return { ...row }
  },
  async disconnect(id) {
    const row = rows.find(row => row.id === id)!
    generations.set(id, (generations.get(id) ?? 0) + 1)
    row.autoConnect = false; row.phase = 'disconnected'; delete row.localPort; delete row.stage; delete row.error; publish()
    return { ...row }
  },
  async update(input) {
    document.documentElement.dataset.updateInput = JSON.stringify(input)
    const row = rows.find(row => row.id === input.id)!
    row.phase = 'updating'; publish()
    await delay(100)
    row.runtime = { version: input.version ?? LATEST_SUPPORTED_REMOTE_VERSION, pid: 123, service: 'systemd' }
    row.phase = 'connected'; row.localPort = 43188; publish()
    return { ...row }
  },
  async open() { return { url: 'http://127.0.0.1:43188/?token=browser-test-token-not-a-real-credential' } },
}
const messages = query.has('zh') ? zh : en
const translate = (key: keyof typeof messages) => messages[key]
const root = createRoot(document.getElementById('root')!)
function NativeSettings({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null), escapes = useRef(0)
  useModalLayer(ref, true, () => { document.documentElement.dataset.parentEscapes = String(++escapes.current) })
  return <div ref={ref} role="dialog" aria-modal="true" aria-label="Native fixture settings">{children}</div>
}
const panel = (current: ConnectionsApi) => <Panel
  onOpen={async id => { if (query.has('slowopen')) await delay(700); document.body.dataset.workspaceOpened = id }}
  onAddWorkspace={async id => { document.body.dataset.workspaceAdded = id }}
  onManagePlugins={async id => { document.body.dataset.pluginsOpened = id }} api={current} t={translate} local={!query.has('remote')} />
const render = (current: ConnectionsApi) => root.render(query.has('parentEscape') ? <NativeSettings>{panel(current)}</NativeSettings> : panel(current))
window.addEventListener('api-swap', () => render({ ...api }))
window.addEventListener('external-disable', () => { const row = rows[0]; if (row) { row.autoConnect = false; row.phase = 'disconnected'; delete row.localPort; publish() } })
if (query.has('parentEscape')) {
  document.documentElement.dataset.parentEscapes = '0'
}
publish(); render(api)
