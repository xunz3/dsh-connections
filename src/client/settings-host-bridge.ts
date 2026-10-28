import { parseWorkspaceChannel } from '../shared/workspace-protocol.js'
import { parseSettingsHostSnapshot, type SettingsHostSnapshot } from '../shared/settings-host-protocol.js'
export type { SettingsHostChoice, SettingsHostSnapshot } from '../shared/settings-host-protocol.js'

export interface SettingsHostClient {
  getSnapshot(): SettingsHostSnapshot | undefined
  subscribe(listener: () => void): () => void
  select(id: string): void
  dispose(): void
}

const BRIDGE = '@xunz/dsh-connections/settings-host'
const VERSION = 1
type Hello = { bridge: typeof BRIDGE; version: typeof VERSION; channel: string; nonce: string; type: 'hello' | 'offer' | 'reset' }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}
function message(value: unknown, channel: string): Hello | undefined {
  const input = record(value)
  if (!input || !exact(input, ['bridge', 'version', 'channel', 'nonce', 'type']) || input.bridge !== BRIDGE
    || input.version !== VERSION || input.channel !== channel || typeof input.nonce !== 'string'
    || !/^[a-zA-Z0-9-]{1,64}$/.test(input.nonce) || !['hello', 'offer', 'reset'].includes(String(input.type))) return
  return input as unknown as Hello
}
/** Project only menu metadata. Extra connection fields never cross the document boundary. */
function snapshot(value: unknown): SettingsHostSnapshot | undefined {
  try { return parseSettingsHostSnapshot(value) } catch { return }
}
function closeTransferred(event: MessageEvent): void { for (const port of event.ports) port.close() }
function httpOrigin(value: string): boolean {
  try { const url = new URL(value); return url.origin === value && /^https?:$/.test(url.protocol) }
  catch { return false }
}

/** The parent keeps the Connections API; this capability permits host selection only. */
export function bindSettingsHostParent(options: {
  frame: HTMLIFrameElement
  channel: string
  origin: string
  getSnapshot(): SettingsHostSnapshot
  subscribe(listener: () => void): () => void
  onSelect(id: string): void
  onReady?(ready: boolean): void
}): () => void {
  const { frame, channel, origin } = options
  parseWorkspaceChannel(channel)
  if (!httpOrigin(origin)) throw new TypeError('Invalid settings Host origin')
  const parent = window
  let disposed = false
  let port: MessagePort | undefined
  let nonce: string | undefined
  let ready = false
  let offerTimer: ReturnType<typeof setTimeout> | undefined
  const revoke = () => {
    clearTimeout(offerTimer)
    port?.close(); port = undefined; nonce = undefined
    ready = false; options.onReady?.(false)
  }
  const publish = () => {
    if (!disposed && ready && port) {
      const value = snapshot(options.getSnapshot())
      if (value) port.postMessage({ type: 'snapshot', value })
    }
  }
  const receive = (event: MessageEvent) => {
    const hello = message(event.data, channel)
    // Other frame integrations can also transfer ports through this window.
    if (!hello) return
    if (disposed || event.source !== frame.contentWindow || event.origin !== origin
      || hello.type !== 'hello' || event.ports.length !== 0) { closeTransferred(event); return }
    if (port) {
      if (nonce === hello.nonce) return
      // A freshly activated Settings client (including a new document) gets
      // its own capability even when the iframe has not emitted load yet.
      revoke()
    }
    const pair = new MessageChannel()
    const active = pair.port1
    const source = event.source
    port = active; nonce = hello.nonce
    const current = () => !disposed && port === active && frame.contentWindow === source
    active.onmessage = event => {
      if (event.ports.length) { closeTransferred(event); return }
      if (!current()) return
      const input = record(event.data)
      if (!input) return
      if (input.type === 'ready' && exact(input, ['type']) && !ready) {
        clearTimeout(offerTimer)
        ready = true; options.onReady?.(true); publish()
      } else if (input.type === 'select' && exact(input, ['type', 'id']) && ready) {
        const value = snapshot(options.getSnapshot())
        // Recheck current parent data, not the snapshot that a remote menu rendered.
        if (!value || !value.choices.some(choice => choice.id === input.id)) return
        const id = input.id as string
        if (id === value.selectedId) return
        // A selection consumes this capability before it can trigger asynchronous navigation.
        revoke()
        options.onSelect(id)
      }
    }
    active.start()
    offerTimer = setTimeout(() => { if (current() && !ready) revoke() }, 5000)
    try { frame.contentWindow!.postMessage({ ...hello, type: 'offer' }, origin, [pair.port2]) }
    catch { pair.port2.close(); revoke() }
  }
  const loaded = () => {
    // Child scripts can handshake before the iframe load event. Explicitly ask
    // that document to rebind instead of silently stranding its transferred port.
    try {
      if (nonce) frame.contentWindow?.postMessage({ bridge: BRIDGE, version: VERSION, type: 'reset', channel, nonce }, origin)
    } finally { revoke() }
  }
  options.onReady?.(false)
  parent.addEventListener('message', receive)
  frame.addEventListener('load', loaded)
  const unsubscribe = options.subscribe(publish)
  return () => {
    if (disposed) return
    disposed = true
    parent.removeEventListener('message', receive)
    frame.removeEventListener('load', loaded)
    unsubscribe(); revoke()
  }
}

/** The embedded document receives a menu snapshot, never local RPC or credentials. */
export function createSettingsHostClient(channel: string): SettingsHostClient {
  parseWorkspaceChannel(channel)
  const child = window
  const parent = child.parent
  const listeners = new Set<() => void>()
  let disposed = false
  let value: SettingsHostSnapshot | undefined
  let port: MessagePort | undefined
  let parentOrigin: string | undefined
  let nonce = crypto.randomUUID()
  let offeredAt = 0
  const emit = () => { for (const listener of listeners) listener() }
  const reset = () => {
    port?.close(); port = undefined; value = undefined; parentOrigin = undefined
    nonce = crypto.randomUUID(); emit()
  }
  const hello = () => {
    if (disposed || value || parent === child) return
    // Recover a lost offer/acknowledgement without accepting a second active port.
    if (port && Date.now() - offeredAt >= 6000) reset()
    if (!port) parent.postMessage({ bridge: BRIDGE, version: VERSION, type: 'hello', channel, nonce }, '*')
  }
  const receive = (event: MessageEvent) => {
    const input = message(event.data, channel)
    if (!input || input.nonce !== nonce) return
    if (disposed || event.source !== parent) { closeTransferred(event); return }
    if (input.type === 'reset' && event.ports.length === 0 && (!parentOrigin || event.origin === parentOrigin)) { reset(); hello(); return }
    if (input.type !== 'offer' || event.ports.length !== 1) { closeTransferred(event); return }
    if (port || !httpOrigin(event.origin)) { closeTransferred(event); return }
    parentOrigin = event.origin
    const active = event.ports[0]!
    port = active; offeredAt = Date.now()
    active.onmessage = event => {
      if (event.ports.length) { closeTransferred(event); return }
      if (disposed || port !== active) return
      const input = record(event.data)
      if (!input || input.type !== 'snapshot' || !exact(input, ['type', 'value'])) return
      const next = snapshot(input.value)
      if (!next) return
      value = next; emit()
    }
    active.start()
    active.postMessage({ type: 'ready' })
  }
  child.addEventListener('message', receive)
  const timer = setInterval(hello, 500)
  hello()
  return {
    getSnapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    select(id) {
      if (!disposed && port && value?.choices.some(choice => choice.id === id) && value.selectedId !== id) port.postMessage({ type: 'select', id })
    },
    dispose() {
      if (disposed) return
      disposed = true; clearInterval(timer)
      child.removeEventListener('message', receive)
      port?.close(); port = undefined; value = undefined; listeners.clear()
    },
  }
}
