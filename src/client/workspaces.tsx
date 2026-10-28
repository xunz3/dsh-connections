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
import type { Translate } from './messages.js'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceApi } from '../shared/workspace-rpc.js'
import type { WorkspaceNavigationTarget } from '../shared/workspace-protocol.js'
import { WorkspaceController, viewClientId } from './workspace-controller.js'
import { WorkspaceBrowser } from './WorkspaceBrowser.js'
import { workspaceUrl } from './workspace-surface.js'
import { installWorkspaceShortcuts } from './workspace-shortcuts.js'
export { WorkspaceController } from './workspace-controller.js'

const en = {
  choose: 'Open a project', searchHosts: 'Search computers', computer: 'This computer',
  hint: 'Choose the computer where your project lives.', empty: 'Add an SSH connection in Settings → Connections.',
  loading: 'Loading connections…', cancel: 'Cancel', back: 'Return to this computer',
  connecting: 'Connecting to remote Harness…', retry: 'Reconnect', failed: 'Unable to open this connection. Check its status in Connections and try again.',
  opening: 'Opening workspace…', timeout: 'The remote workspace did not finish loading through SSH. Check the connection and retry.',
  unavailable: 'Open Harness in a local HTTP browser to use remote workspaces. Native desktop command routing is not supported yet.',
  shortcutBlocked: 'Use the selected remote chat’s actions or focus its conversation before using this shortcut.',
  localUnavailable: 'The local directory picker is unavailable.', frame: 'Remote workspace',
  disconnected: 'This connection is no longer available. Reconnect to continue.',
  protocolMismatch: 'The remote content plugin uses an incompatible protocol. Update the remote content bundle and reconnect.',
  compositionUnavailable: 'The native sidebar is owned by another plugin. Disable the conflicting sidebar composition and reload to open remote workspaces.',
  pluginRequired: 'Install the remote content bundle on this Harness profile to open its workspaces. See the Connections usage guide.',
} as const
const zh: Record<keyof typeof en, string> = {
  choose: '打开项目', searchHosts: '搜索电脑', computer: '这台电脑', hint: '选择项目所在的电脑。',
  empty: '请先在「设置 → 连接」中添加 SSH 连接。', loading: '正在读取连接…', cancel: '取消', back: '返回这台电脑',
  connecting: '正在连接远端 Harness…', retry: '重新连接', failed: '无法打开此连接。请在「连接」中检查状态后重试。',
  opening: '正在打开工作区…', timeout: '远端工作区未能通过 SSH 完成加载，请检查连接后重试。',
  unavailable: '请通过本机 HTTP 浏览器打开 Harness 使用远端工作区。原生桌面的命令路由暂未支持。',
  shortcutBlocked: '请使用远端会话的操作菜单，或先聚焦远端聊天内容再使用此快捷键。',
  localUnavailable: '本地目录选择器不可用。', frame: '远端工作区', disconnected: '此连接已不可用，请重新连接后继续。',
  protocolMismatch: '远端内容插件的协议版本不兼容。请更新远端内容插件包后重新连接。',
  compositionUnavailable: '另一个插件正在管理原生侧栏。请停用冲突的侧栏插件并重新加载，再打开远端工作区。',
  pluginRequired: '请在远端 Harness 配置中安装内容插件包，再打开工作区。安装步骤见 Connections 使用文档。',
}
export type WorkspaceTranslate = (key: keyof typeof en) => string
export const workspaceMessages = { en, zh }
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

export { workspaceUrl } from './workspace-surface.js'

export function HostChooser({ owner, controller, t, renderLocal }: {
  owner: DirectoryFlowOwnerProps
  controller: WorkspaceController
  t: WorkspaceTranslate
  renderLocal: (owner: DirectoryFlowOwnerProps) => ReactNode
}) {
  const [local, setLocal] = useState(false)
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<ConnectionView[]>()
  const [failed, setFailed] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!owner.open) { setLocal(false); setQuery(''); return }
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
    {(rows?.length ?? 0) > 8 && <input className="dc-host-search" type="search" aria-label={t('searchHosts')} placeholder={t('searchHosts')} value={query} onChange={event => setQuery(event.target.value)} />}
    <button className="dc-host-choice" disabled={owner.busy} onClick={() => setLocal(true)}><strong>{t('computer')}</strong></button>
    {failed ? <p role="alert">{t('failed')}</p> : rows === undefined ? <p role="status">{t('loading')}</p> : rows.length === 0 ? <p>{t('empty')}</p> : rows.filter(row => `${row.name} ${row.target}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(row =>
      <button key={row.id} className="dc-host-choice" disabled={owner.busy} onClick={() => { owner.onCancel(); void controller.pick(row.id) }}><strong>{row.name}</strong>{row.target !== row.name && <span>{row.target}</span>}</button>)}
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
  useEffect(() => { setGuestError(false) }, [state?.url])
  if (!state) return null
  return <section className="dc-remote-workspace" aria-label={state.name || t('frame')}>
    <style>{workspaceCss}</style>
    {state.phase === 'connecting' ? <div className="dc-remote-status"><p role="status">{t('connecting')} {state.name}</p><button onClick={() => controller.close()}>{t('cancel')}</button></div>
      : state.phase === 'error' || guestError ? <div className="dc-remote-status"><p role="alert">{t(state.error ?? 'failed')}</p>{(!state.error || ['failed', 'timeout', 'disconnected'].includes(state.error)) && <button onClick={() => { setGuestError(false); void controller.retry(state.id) }}>{t('retry')}</button>}{' '}<button onClick={() => controller.close()}>{t('cancel')}</button></div>
      : <>
        {bridge ? <DesktopGuest bridge={bridge} id={state.id} url={state.url!} title={t('frame')} failed={failed} />
          : <iframe key={state.url} className="dc-remote-frame" src={state.url} title={t('frame')} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox" onError={failed} />}
        {!state.presented && <div className="dc-remote-loading"><p role="status">{t('opening')} {state.name}</p><button onClick={() => controller.close()}>{t('cancel')}</button></div>}
      </>}
  </section>
}

/** Compose the native shell through public slots; remote content owns no local Session. */
export function installWorkspaces(ctx: Context, api: ConnectionsApi & WorkspaceApi, _t: Translate, canRoute = () => true): WorkspaceController {
  const bridge = desktopBrowser()
  let storage: Storage | undefined
  try { storage = window.localStorage } catch { /* Optional preference persistence. */ }
  let localNavigate: (target: WorkspaceNavigationTarget) => Promise<void> = async () => { throw new Error('Local workspace navigation is not ready.') }
  let sessionStorage: Storage | undefined
  try { sessionStorage = window.sessionStorage } catch { /* Optional per-tab leases. */ }
  const controller = new WorkspaceController(api, {
    clientId: viewClientId(sessionStorage, 'workspace'), storage, prepareUrl: url => {
      // Native desktop menu accelerators bypass the document-local input hook.
      // Enable this surface only after the shell can route commands to the selected source.
      if (!canRoute()) throw new Error('sidebar-composition-unavailable')
      if (bridge !== undefined) throw new Error('unsupported-workspace-surface')
      return workspaceUrl(url, window.location, false)
    },
    localNavigate: target => localNavigate(target),
  })
  ctx.effect(() => ctx.locale.register('connections.workspace', { en, zh }))
  const t = ctx.locale.bind('connections.workspace') as WorkspaceTranslate
  ctx.effect(() => () => controller.dispose())
  const panel = 'connections.workspace' as MainPanelId

  const delegate = (slot: PickerSlot, alias: LocalSlot, excluded?: unknown) => {
    let delegated: StoredEntry | undefined
    let remove: (() => void) | undefined
    const sync = () => {
      const entry = ctx.slots.entries(slot).find(entry => entry.component !== excluded)
      if (entry === delegated) return
      remove?.(); remove = undefined; delegated = entry
      if (!entry || (entry.children && Object.keys(entry.children).length > 0)) return
      remove = ctx.slots.register({ name: alias, inject: entry.inject, store: entry.store, locale: entry.locale } as never, entry.component as never)
    }
    const off = ctx.slots.subscribe(slot, sync)
    sync()
    return () => { off(); remove?.() }
  }

  ctx.inject(['layout', 'uiWorkspace', 'uiSession', 'workspaces', 'shortcuts'], ctx => {
    localNavigate = async target => {
      if (target.kind === 'session') ctx.uiWorkspace.openSession(target.id as Parameters<typeof ctx.uiWorkspace.openSession>[0])
      else if (target.kind === 'workspace') await ctx.uiWorkspace.openWorkspace(target.id as Parameters<typeof ctx.uiWorkspace.openWorkspace>[0])
      else if (target.kind === 'newSession') ctx.uiWorkspace.startSession(target.id as Parameters<typeof ctx.uiWorkspace.startSession>[0])
      // Native navigation may reuse a blank session without emitting a key change.
      controller.localSelection(ctx.uiSession.adapter.current.getSnapshot().key)
    }

    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panel, locale: 'connections.workspace' },
      () => <RemoteWorkspace controller={controller} t={t} {...bridge === undefined ? {} : { bridge }} />))
    ctx.slots.inject('sidebar.workspaces', () => {
      const Browser = (props: PropsRenderSlots<'connections.local.sidebarDirectoryFlow'> & { wide: boolean; expandSidebar(): void }) => {
        const { sources, selected } = useSyncExternalStore(controller.subscribe, controller.getCatalogs)
        const [open, setOpen] = useState(false)
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState(false)
        const [shortcutNote, setShortcutNote] = useState(false)
        const [searchRequest, setSearchRequest] = useState(0)
        useEffect(() => installWorkspaceShortcuts(ctx.shortcuts, {
          getRemoteSourceId: () => controller.getSnapshot()?.id,
          onSearch: () => setSearchRequest(value => value + 1),
          onAddWorkspace: () => { props.expandSidebar(); setError(false); setOpen(true) },
          onBlocked: () => setShortcutNote(true),
          onNewSession: () => { void controller.newSession() },
        }), [props.expandSidebar])
        useEffect(() => { setShortcutNote(false) }, [selected.sourceId, selected.sessionId])
        const owner: DirectoryFlowOwnerProps = {
          open, busy, onCancel: () => { if (!busy) setOpen(false) }, onError: () => { setOpen(false); setError(true) },
          onPicked: path => {
            if (busy) return
            setBusy(true)
            void ctx.workspaces.create({ path }).then(async value => {
              setOpen(false)
              await controller.navigate('local', { kind: 'workspace', id: value.workspaceId })
            }).catch(() => { setError(true); setOpen(false) }).finally(() => setBusy(false))
          },
        }
        return <>
          <style>{`.dcw-command-note{margin:8px 16px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5}.dcw-command-note button{background:none;border:0;color:inherit;cursor:pointer;text-decoration:underline}`}</style>
          <WorkspaceBrowser searchRequest={searchRequest} sources={sources} selected={selected} locale={ctx.locale.getSnapshot().active}
            wide={props.wide} expandSidebar={props.expandSidebar}
            onOpenSession={(id, sessionId) => controller.navigate(id, { kind: 'session', id: sessionId })}
            onOpenWorkspace={(id, workspaceId) => controller.navigate(id, { kind: 'workspace', id: workspaceId })}
            onNewSession={(id, workspaceId) => controller.navigate(id, { kind: 'newSession', id: workspaceId })}
            onAddWorkspace={() => { setError(false); setOpen(true) }} onReconnect={id => controller.retry(id)}
            onRenameWorkspace={(id, workspaceId, title) => controller.mutate(id, { op: 'renameWorkspace', id: workspaceId, title })}
            onForgetWorkspace={(id, workspaceId) => controller.mutate(id, { op: 'forgetWorkspace', id: workspaceId })}
            onRenameSession={(id, sessionId, title) => controller.mutate(id, { op: 'renameSession', id: sessionId, title })}
            onArchiveSession={(id, sessionId, archived) => controller.mutate(id, { op: 'archiveSession', id: sessionId, archived })}
            onPinSession={(id, sessionId, pinned) => controller.mutate(id, { op: 'pinSession', id: sessionId, pinned })} />
          {shortcutNote && <p className="dcw-command-note" role="status">{t('shortcutBlocked')} <button onClick={() => setShortcutNote(false)}>{t('cancel')}</button></p>}
          {error && <p role="alert">{t('failed')} <button onClick={() => setError(false)}>{t('cancel')}</button></p>}
          <HostChooser owner={owner} controller={controller} t={t} renderLocal={owner => props.renderSlot('connections.local.sidebarDirectoryFlow', owner, { fallback: <p role="alert">{t('localUnavailable')} <button onClick={owner.onCancel}>{t('cancel')}</button></p> })} />
        </>
      }
      const remove = ctx.slots.register({ name: 'sidebar.workspaces', priority: -100, locale: 'connections.workspace',
        children: { 'connections.local.sidebarDirectoryFlow': { kind: 'single', scope: 'root' } },
      }, Browser)
      const stop = delegate('sidebar.workspaces.directoryFlow', 'connections.local.sidebarDirectoryFlow')
      return () => { stop(); remove() }
    })
    // The empty-state picker keeps its native adoption semantics for this computer.
    ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => {
      const Picker = (props: DirectoryFlowOwnerProps & PropsRenderSlots<'connections.local.heroDirectoryFlow'>) => {
        const { open, busy, onPicked, onCancel, onError } = props
        return <HostChooser owner={{ open, busy, onPicked, onCancel, onError }} controller={controller} t={t}
          renderLocal={owner => props.renderSlot('connections.local.heroDirectoryFlow', owner, { fallback: <p role="alert">{t('localUnavailable')} <button onClick={owner.onCancel}>{t('cancel')}</button></p> })} />
      }
      const remove = ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', priority: -100, locale: 'connections.workspace',
        children: { 'connections.local.heroDirectoryFlow': { kind: 'single', scope: 'root' } },
      }, Picker)
      const stop = delegate('conversation.hero.workspace.directoryFlow', 'connections.local.heroDirectoryFlow', Picker)
      return () => { stop(); remove() }
    })
    ctx.effect(() => {
      let wasRemote = false
      let transitioning = false
      let lastPanel = ctx.layout.panelInfo.getSnapshot().activePanelId
      const sync = () => {
        if (transitioning) return
        const remote = controller.getSnapshot() !== undefined
        transitioning = true
        try {
          if (remote && !wasRemote) { ctx.layout.beginNavigation(); ctx.layout.selectPanel(panel); wasRemote = true }
          else if (!remote && wasRemote) { wasRemote = false; if (ctx.layout.panelInfo.getSnapshot().activePanelId === panel) ctx.layout.selectPanel(null) }
          lastPanel = ctx.layout.panelInfo.getSnapshot().activePanelId
        } finally { transitioning = false }
      }
      const offController = controller.subscribe(sync)
      const offPanel = ctx.layout.panelInfo.subscribe(() => {
        if (transitioning) return
        const active = ctx.layout.panelInfo.getSnapshot().activePanelId
        const leaving = lastPanel === panel && active !== panel
        lastPanel = active
        if (leaving && controller.getSnapshot()) controller.close()
        if (!controller.getSnapshot()) controller.localSelection(ctx.uiSession.adapter.current.getSnapshot().key)
      })
      const offSession = ctx.uiSession.adapter.current.subscribe(() => controller.localSelection(ctx.uiSession.adapter.current.getSnapshot().key))
      sync()
      const visibility = () => controller.setVisible(!document.hidden)
      visibility()
      document.addEventListener('visibilitychange', visibility)
      controller.start()
      void controller.restore()
      // Capture the remote preference before sampling already-restored native state.
      controller.localSelection(ctx.uiSession.adapter.current.getSnapshot().key)
      return () => { document.removeEventListener('visibilitychange', visibility); offController(); offPanel(); offSession() }
    })
  })
  return controller
}

const workspaceCss = `
.dc-workspace-chooser,.dc-remote-workspace{font:14px/1.5 system-ui,sans-serif;color:var(--dsw-alias-label-primary,#202124);background:var(--dsw-alias-bg-base,#fff)}
.dc-workspace-chooser{max-height:calc(100dvh - 48px);overflow:auto;width:min(420px,calc(100vw - 48px));border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:14px;padding:24px;box-sizing:border-box;box-shadow:0 16px 70px #0002}.dc-workspace-chooser::backdrop{background:#0005}
.dc-workspace-chooser h2{font-size:19px;margin:0 0 6px}.dc-workspace-chooser h3{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#666);margin:24px 0 8px}.dc-workspace-chooser p{color:var(--dsw-alias-label-secondary,#666);margin:0 0 18px}
.dc-workspace-chooser button,.dc-remote-workspace button{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:7px;padding:7px 12px;cursor:pointer}.dc-workspace-chooser button:hover,.dc-remote-workspace button:hover{background:var(--dsw-alias-bg-layer-1,#f4f4f4)}.dc-workspace-chooser button:focus-visible,.dc-remote-workspace button:focus-visible{outline:2px solid #5785bc;outline-offset:2px}
.dc-workspace-chooser .dc-host-search{box-sizing:border-box;width:100%;font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);padding:8px;border-radius:6px;margin-bottom:8px}.dc-workspace-chooser .dc-host-choice{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;text-align:left;margin:6px 0;padding:12px}.dc-host-choice strong{font-weight:500}.dc-host-choice span{font-size:12px;color:var(--dsw-alias-label-secondary,#666);overflow:hidden;text-overflow:ellipsis}.dc-workspace-chooser-actions{display:flex;justify-content:flex-end;margin-top:22px}
.dc-remote-workspace{position:relative;flex:1;min-width:0;min-height:0;width:100%;height:100%;margin:0;padding:0;border:0;overflow:hidden;display:flex;flex-direction:column}.dc-remote-loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--dsw-alias-bg-base,#fff);padding:32px;text-align:center}.dc-remote-loading p{color:var(--dsw-alias-label-secondary,#666)}.dc-remote-status{margin:auto;padding:32px;max-width:520px;text-align:center}.dc-remote-frame,.dc-remote-guest{display:flex;flex:1;min-height:0;width:100%;height:100%;border:0}.dc-remote-guest>.dc-remote-frame{height:100%}
`
