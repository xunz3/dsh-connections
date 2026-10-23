import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { PropsRenderSlots, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionsApi, ConnectionView } from '../shared/types.js'
import { parseId, parseOpenResult } from '../shared/validation.js'
import type { Translate } from './messages.js'

const en = {
  choose: 'Open a project', computer: 'This computer', remote: 'Remote computers',
  hint: 'Choose the computer where your project lives.', empty: 'Add an SSH connection in Settings → Connections.',
  loading: 'Loading connections…', cancel: 'Cancel', back: 'Return to this computer',
  connecting: 'Connecting to remote Harness…', retry: 'Reconnect', failed: 'Unable to open this connection. Check its status in Connections and try again.',
  unavailable: 'Use this Harness on http://127.0.0.1 or http://localhost, or in the desktop app, to open a remote workspace here.',
  localUnavailable: 'The local directory picker is unavailable.', frame: 'Remote Harness',
  disconnected: 'This connection is no longer available. Reconnect to continue.',
} as const
const zh: Record<keyof typeof en, string> = {
  choose: '打开项目', computer: '这台电脑', remote: '远端电脑', hint: '选择项目所在的电脑。',
  empty: '请先在「设置 → 连接」中添加 SSH 连接。', loading: '正在读取连接…', cancel: '取消', back: '返回这台电脑',
  connecting: '正在连接远端 Harness…', retry: '重新连接', failed: '无法打开此连接。请在「连接」中检查状态后重试。',
  unavailable: '请通过 http://127.0.0.1、http://localhost 或桌面应用打开本地 Harness，以在应用内使用远端项目。',
  localUnavailable: '本地目录选择器不可用。', frame: '远端 Harness', disconnected: '此连接已不可用，请重新连接后继续。',
}
export type WorkspaceTranslate = (key: keyof typeof en) => string
export const workspaceMessages = { en, zh }
const STORAGE_KEY = '@xunz/dsh-connections/selected'
type PickerSlot = 'conversation.hero.workspace.directoryFlow' | 'sidebar.workspaces.directoryFlow'
type LocalSlot = 'connections.local.heroDirectoryFlow' | 'connections.local.sidebarDirectoryFlow'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'connections.workspace': keyof typeof en }
  interface SlotMap {
    'connections.local.heroDirectoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
    'connections.local.sidebarDirectoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
  }
}

/** The existing desktop guest bridge owns isolation, partitions and guest disposal. */
export function desktopBrowser(): DesktopBrowserBridge | undefined {
  const carrier = (globalThis as typeof globalThis & {
    dshDesktop?: { protocolVersion: number; browser?: DesktopBrowserBridge }
  }).dshDesktop
  return carrier?.protocolVersion === 1 ? carrier.browser : undefined
}

/** Keep native Strict cookies first-party (desktop guest) or same-site (web iframe). */
export function workspaceUrl(value: string, page: Pick<Location, 'protocol' | 'hostname'>, desktop: boolean): string {
  const { url } = parseOpenResult({ url: value })
  if (desktop) return url
  if (page.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(page.hostname)) throw new Error('unsupported-workspace-surface')
  const target = new URL(url)
  target.hostname = page.hostname
  return target.href
}

export interface WorkspaceState {
  id: string
  name: string
  phase: 'connecting' | 'ready' | 'error'
  url?: string
  error?: 'failed' | 'unavailable' | 'disconnected'
}
interface WorkspaceOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  prepareUrl?: (url: string) => string
}

/** Presentation state only. Connections and remote Harness keep their own lifetimes. */
export class WorkspaceController {
  private state: WorkspaceState | undefined
  private version = 0
  private disposed = false
  private readonly listeners = new Set<() => void>()
  readonly getSnapshot = () => this.state
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  constructor(readonly api: Pick<ConnectionsApi, 'list' | 'connect' | 'open'>, private readonly options: WorkspaceOptions = {}) {}

  private publish(state: WorkspaceState | undefined) {
    this.state = state
    for (const listener of this.listeners) listener()
  }
  private remember(id?: string) {
    try {
      if (id === undefined) this.options.storage?.removeItem(STORAGE_KEY)
      else this.options.storage?.setItem(STORAGE_KEY, id)
    } catch { /* Storage may be disabled; the workspace still works. */ }
  }
  async restore(): Promise<void> {
    let id: string | null | undefined
    try { id = this.options.storage?.getItem(STORAGE_KEY); if (id) parseId(id) }
    catch { this.remember(); return }
    if (id) await this.activate(id, true)
  }
  async open(id: string): Promise<void> {
    await this.activate(id, false)
  }
  private async activate(id: string, restoring: boolean): Promise<void> {
    if (this.disposed) return
    parseId(id)
    const version = ++this.version
    const current = () => !this.disposed && version === this.version
    if (!restoring) this.publish({ id, name: '', phase: 'connecting' })
    try {
      const row = (await this.api.list()).find(row => row.id === id)
      if (!current()) return
      if (!row) { this.remember(); throw new Error('missing-connection') }
      // Remember the last selection, but respect an explicitly disabled automatic
      // connection. A user's later picker action still opens it normally.
      if (restoring && row.autoConnect === false && row.phase !== 'connected') {
        this.publish(undefined)
        return
      }
      this.publish({ id, name: row.name, phase: 'connecting' })
      const connected = row.phase === 'connected' ? row : await this.api.connect(id)
      if (!current()) return
      const result = parseOpenResult(await this.api.open(id))
      if (!current()) return
      // Editing, removing or disconnecting while open is pending must never mount a stale authority.
      const latest = (await this.api.list()).find(row => row.id === id)
      if (!current()) return
      if (latest?.phase !== 'connected' || latest.localPort !== connected.localPort
        || Number(new URL(result.url).port) !== latest.localPort) throw new Error('changed-connection')
      const url = this.options.prepareUrl?.(result.url) ?? result.url
      this.remember(id)
      this.publish({ id, name: latest.name, phase: 'ready', url })
    } catch (error) {
      if (!current()) return
      this.publish({ id, name: this.state?.name ?? '', phase: 'error',
        error: error instanceof Error && error.message === 'unsupported-workspace-surface' ? 'unavailable' : 'failed' })
    }
  }
  /** Returning local only closes the view; it never stops a tunnel or remote work. */
  close(): void { this.version++; this.remember(); this.publish(undefined) }
  async check(): Promise<void> {
    const state = this.state
    if (!state || state.phase !== 'ready') return
    const version = this.version
    try {
      const row = (await this.api.list()).find(row => row.id === state.id)
      if (this.disposed || version !== this.version || this.state !== state) return
      if (row?.phase === 'connected' && row.localPort === Number(new URL(state.url!).port)) return
    } catch { if (this.disposed || version !== this.version || this.state !== state) return }
    this.publish({ id: state.id, name: state.name, phase: 'error', error: 'disconnected' })
  }
  dispose(): void { this.disposed = true; this.version++; this.publish(undefined); this.listeners.clear() }
}

export function HostChooser({ owner, controller, t, renderLocal }: {
  owner: DirectoryFlowOwnerProps
  controller: WorkspaceController
  t: WorkspaceTranslate
  renderLocal: (owner: DirectoryFlowOwnerProps) => ReactNode
}) {
  const [local, setLocal] = useState(false)
  const [rows, setRows] = useState<ConnectionView[]>()
  const [failed, setFailed] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!owner.open) { setLocal(false); return }
    let alive = true
    setRows(undefined); setFailed(false)
    void controller.api.list().then(rows => { if (alive) setRows(rows) }, () => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [owner.open, controller])
  useEffect(() => {
    if (owner.open && !local) dialog.current?.showModal()
    else dialog.current?.close()
  }, [owner.open, local])
  if (!owner.open) return null
  if (local) return renderLocal(owner)
  return <dialog ref={dialog} className="dc-workspace-chooser" aria-label={t('choose')} onCancel={event => { event.preventDefault(); owner.onCancel() }}>
    <style>{workspaceCss}</style>
    <h2>{t('choose')}</h2><p>{t('hint')}</p>
    <button className="dc-host-choice" disabled={owner.busy} onClick={() => setLocal(true)}>{t('computer')}</button>
    <h3>{t('remote')}</h3>
    {failed ? <p role="alert">{t('failed')}</p> : rows === undefined ? <p role="status">{t('loading')}</p> : rows.length === 0 ? <p>{t('empty')}</p> : rows.map(row =>
      <button key={row.id} className="dc-host-choice" disabled={owner.busy} onClick={() => { owner.onCancel(); void controller.open(row.id) }}><strong>{row.name}</strong><span>{row.target}</span></button>)}
    <div className="dc-workspace-chooser-actions"><button onClick={owner.onCancel}>{t('cancel')}</button></div>
  </dialog>
}

interface GuestElement extends HTMLElement { loadURL(url: string): Promise<void> }
/** A thin view over the shell's existing lease API; no Electron or browser service is recreated. */
function DesktopGuest({ bridge, id, url, title, failed }: {
  bridge: DesktopBrowserBridge; id: string; url: string; title: string; failed: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    let lease: DesktopBrowserLeaseId | undefined
    let element: GuestElement | undefined
    let offOpen: (() => void) | undefined
    const release = () => { if (lease) { const current = lease; lease = undefined; void bridge.release(current).catch(() => {}) } }
    void bridge.acquire(`@xunz/dsh-connections/${id}`).then(reservation => {
      lease = reservation.lease
      if (!alive || !host.current) { release(); return }
      element = document.createElement('webview') as GuestElement
      element.setAttribute('name', lease)
      element.setAttribute('partition', reservation.partition)
      element.setAttribute('src', `about:blank#${lease}`)
      element.setAttribute('allowpopups', '')
      element.setAttribute('aria-label', title)
      element.className = 'dc-remote-frame'
      let started = false
      element.addEventListener('dom-ready', () => {
        if (started || !alive) return
        started = true
        void element!.loadURL(url).catch(() => { if (alive) failed() })
      })
      element.addEventListener('did-fail-load', event => {
        const failure = event as Event & { isMainFrame?: boolean; errorCode?: number }
        if (alive && failure.isMainFrame && failure.errorCode !== -3) failed()
      })
      for (const event of ['render-process-gone', 'destroyed']) {
        element.addEventListener(event, () => { if (alive) failed() })
      }
      // The desktop shell already opens HTTP(S) links in the system browser.
      // Keep provider sign-in popups working without navigating the remote workspace.
      offOpen = bridge.onOpenRequested(lease, value => {
        if (!alive) return
        try {
          const target = new URL(value)
          if (['http:', 'https:'].includes(target.protocol) && !target.username && !target.password) {
            window.open(target.href, '_blank', 'noopener,noreferrer')
          }
        } catch { /* Ignore malformed guest navigation. */ }
      })
      host.current.append(element)
    }).catch(() => { if (alive) failed() })
    return () => { alive = false; offOpen?.(); element?.remove(); release() }
  }, [bridge, id, url, title, failed])
  return <div className="dc-remote-guest" ref={host} />
}

export function RemoteWorkspace({ controller, t, bridge }: {
  controller: WorkspaceController; t: WorkspaceTranslate; bridge?: DesktopBrowserBridge
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [guestError, setGuestError] = useState(false)
  const failed = useRef(() => { setGuestError(true) }).current
  const region = useRef<HTMLDialogElement>(null)
  useEffect(() => { setGuestError(false) }, [state?.url])
  useEffect(() => {
    if (!state) return
    const previous = document.activeElement as HTMLElement | null
    region.current?.showModal()
    region.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [!!state])
  useEffect(() => {
    if (state?.phase !== 'ready') return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => { await controller.check(); if (alive) timer = setTimeout(poll, 2500) }
    timer = setTimeout(poll, 2500)
    return () => { alive = false; clearTimeout(timer) }
  }, [controller, state?.phase, state?.url])
  if (!state) return null
  return <dialog ref={region} className="dc-remote-workspace" aria-modal="true" aria-label={state.name || t('frame')} onCancel={event => event.preventDefault()}>
    <style>{workspaceCss}</style>
    <header className="dc-remote-bar"><strong>{state.name || t('frame')}</strong><button onClick={() => controller.close()}>{t('back')}</button></header>
    {state.phase === 'connecting' ? <p className="dc-remote-status" role="status">{t('connecting')}</p>
      : state.phase === 'error' || guestError ? <div className="dc-remote-status"><p role="alert">{t(state.error ?? 'failed')}</p><button onClick={() => { setGuestError(false); void controller.open(state.id) }}>{t('retry')}</button></div>
      : bridge ? <DesktopGuest bridge={bridge} id={state.id} url={state.url!} title={t('frame')} failed={failed} />
        : <iframe key={state.url} className="dc-remote-frame" src={state.url} title={t('frame')} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox" onError={failed} />}
  </dialog>
}

/** Install only native extension points; both local pickers retain their existing implementation. */
export function installWorkspaces(ctx: Context, api: ConnectionsApi, _t: Translate): WorkspaceController {
  const bridge = desktopBrowser()
  let storage: Storage | undefined
  try { storage = window.localStorage } catch { /* Optional preference persistence. */ }
  const controller = new WorkspaceController(api, { storage, prepareUrl: url => workspaceUrl(url, window.location, bridge !== undefined) })
  ctx.effect(() => ctx.locale.register('connections.workspace', { en, zh }))
  const t = ctx.locale.bind('connections.workspace') as WorkspaceTranslate
  ctx.effect(() => () => controller.dispose())
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'connections.workspace', locale: 'connections.workspace' },
    () => <RemoteWorkspace controller={controller} t={t} {...bridge === undefined ? {} : { bridge }} />))

  const installPicker = (slot: PickerSlot, alias: LocalSlot) => ctx.slots.inject(slot, () => {
    const Picker = (props: DirectoryFlowOwnerProps & PropsRenderSlots<LocalSlot>) => {
      // Owner props override injected props in the renderer. Forward only the
      // native owner contract, never this chooser's locale/store/render seats.
      const { open, busy, onPicked, onCancel, onError } = props
      const owner: DirectoryFlowOwnerProps = { open, busy, onPicked, onCancel, onError }
      return <HostChooser owner={owner} controller={controller} t={t}
        renderLocal={owner => props.renderSlot(alias, owner, { fallback: <p role="alert">{t('localUnavailable')} <button onClick={owner.onCancel}>{t('cancel')}</button></p> })} />
    }
    const removePicker = ctx.slots.register({ name: slot, priority: -100, locale: 'connections.workspace', children: { [alias]: { kind: 'single', scope: 'root' } } } as never, Picker as never)
    let delegated: StoredEntry | undefined
    let removeDelegate: (() => void) | undefined
    const sync = () => {
      const entry = ctx.slots.entries(slot).find(entry => entry.component !== Picker)
      if (entry === delegated) return
      removeDelegate?.(); removeDelegate = undefined; delegated = entry
      if (!entry || (entry.children && Object.keys(entry.children).length > 0)) return
      // Native directory flows are leaves. Preserve their component, injected services,
      // locale and store seats through a real child slot rather than invoking them by hand.
      removeDelegate = ctx.slots.register({ name: alias, inject: entry.inject, store: entry.store, locale: entry.locale } as never, entry.component as never)
    }
    const off = ctx.slots.subscribe(slot, sync)
    sync()
    return () => { off(); removeDelegate?.(); removePicker() }
  })
  installPicker('conversation.hero.workspace.directoryFlow', 'connections.local.heroDirectoryFlow')
  installPicker('sidebar.workspaces.directoryFlow', 'connections.local.sidebarDirectoryFlow')
  void controller.restore()
  return controller
}

const workspaceCss = `
.dc-workspace-chooser,.dc-remote-workspace{font:14px/1.5 system-ui,sans-serif;color:var(--dsw-alias-label-primary,#202124);background:var(--dsw-alias-bg-base,#fff)}
.dc-workspace-chooser{width:min(420px,calc(100vw - 48px));border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:14px;padding:24px;box-sizing:border-box;box-shadow:0 16px 70px #0002}.dc-workspace-chooser::backdrop{background:#0005}
.dc-workspace-chooser h2{font-size:19px;margin:0 0 6px}.dc-workspace-chooser h3{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#666);margin:24px 0 8px}.dc-workspace-chooser p{color:var(--dsw-alias-label-secondary,#666);margin:0 0 18px}
.dc-workspace-chooser button,.dc-remote-workspace button{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:7px;padding:7px 12px;cursor:pointer}.dc-workspace-chooser button:hover,.dc-remote-workspace button:hover{background:var(--dsw-alias-bg-layer-1,#f4f4f4)}.dc-workspace-chooser button:focus-visible,.dc-remote-workspace button:focus-visible{outline:2px solid #5785bc;outline-offset:2px}
.dc-workspace-chooser .dc-host-choice{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;text-align:left;margin:6px 0;padding:12px}.dc-host-choice strong{font-weight:500}.dc-host-choice span{font-size:12px;color:var(--dsw-alias-label-secondary,#666);overflow:hidden;text-overflow:ellipsis}.dc-workspace-chooser-actions{display:flex;justify-content:flex-end;margin-top:22px}
.dc-remote-workspace{position:fixed;inset:0;z-index:900;width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:0;overflow:hidden;display:flex;flex-direction:column}.dc-remote-bar{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:48px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#ddd);box-sizing:border-box;flex:none}.dc-remote-bar strong{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dc-remote-bar button{font-size:12px;white-space:nowrap}.dc-remote-status{margin:auto;padding:32px;max-width:520px;text-align:center}.dc-remote-frame,.dc-remote-guest{display:flex;flex:1;min-height:0;width:100%;height:100%;border:0}.dc-remote-guest>.dc-remote-frame{height:100%}
`
