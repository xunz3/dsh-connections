import { localSurface } from './local-surface.js'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { DesktopBrowserBridge } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { PropsRenderSlots, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionsApi, ConnectionView } from '../shared/types.js'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceApi } from '../shared/workspace-rpc.js'
import type { WorkspaceNavigationTarget } from '../shared/workspace-protocol.js'
import { WorkspaceController, viewClientId } from './workspace-controller.js'
import { WorkspaceBrowser } from './WorkspaceBrowser.js'
import { scheduleVisiblePoll } from './connection-polling.js'
import { workspaceUrl } from './workspace-surface.js'
import { workspaceCommandResolver } from './workspace-shortcuts.js'
import type { NativeCommandResolver } from './native-shortcuts.js'
import { waitForNativeStartup } from './native-shell-routing.js'
import { desktopBrowser, DesktopGuest } from './desktop-guest.js'
export { desktopBrowser } from './desktop-guest.js'
export { WorkspaceController } from './workspace-controller.js'

const en = {
  choose: 'Open a project', searchHosts: 'Search computers', computer: 'This computer',
  hint: 'Choose the computer where your project lives.', empty: 'Add an SSH connection in Settings → Connections.',
  loading: 'Loading connections…', cancel: 'Cancel', back: 'Return to this computer',
  connecting: 'Connecting to remote Harness…', retry: 'Reconnect', failed: 'Unable to open this connection. Check its status in Connections and try again.',
  opening: 'Opening workspace…', timeout: 'The remote workspace did not finish loading through SSH. Check the connection and retry.',
  unavailable: 'Open Harness in a local HTTP browser to use remote workspaces. Use the native Desktop app or a local HTTP browser.',
  shortcutBlocked: 'Use the selected remote chat’s menus and pane controls for this action.',
  localUnavailable: 'The local directory picker is unavailable.', frame: 'Remote workspace',
  disconnected: 'This connection is no longer available. Reconnect to continue.',
  protocolMismatch: 'The remote content plugin uses an incompatible protocol. Update the remote content bundle and reconnect.',
  compositionUnavailable: 'Native workspace navigation is unavailable. Reload Harness and check for incompatible versions or conflicting navigation plugins.',
  pluginRequired: 'Install the remote content bundle on this Harness profile to open its workspaces. See the Connections usage guide.',
} as const
const zh: Record<keyof typeof en, string> = {
  choose: '打开项目', searchHosts: '搜索电脑', computer: '这台电脑', hint: '选择项目所在的电脑。',
  empty: '请先在「设置 → 连接」中添加 SSH 连接。', loading: '正在读取连接…', cancel: '取消', back: '返回这台电脑',
  connecting: '正在连接远端 Harness…', retry: '重新连接', failed: '无法打开此连接。请在「连接」中检查状态后重试。',
  opening: '正在打开工作区…', timeout: '远端工作区未能通过 SSH 完成加载，请检查连接后重试。',
  unavailable: '请通过本机 HTTP 浏览器打开 Harness 使用远端工作区。也可以使用原生桌面应用。',
  shortcutBlocked: '请使用当前远端会话的菜单和面板按钮完成此操作。',
  localUnavailable: '本地目录选择器不可用。', frame: '远端工作区', disconnected: '此连接已不可用，请重新连接后继续。',
  protocolMismatch: '远端内容插件的协议版本不兼容。请更新远端内容插件包后重新连接。',
  compositionUnavailable: '原生工作区导航暂不可用。请重新加载 Harness，并检查版本兼容性或导航插件冲突。',
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
      : state.phase === 'error' || guestError ? <div className="dc-remote-status"><p role="alert">{t(state.error ?? 'failed')}</p>{(!state.error || ['failed', 'timeout', 'disconnected'].includes(state.error)) && <button onClick={() => { setGuestError(false); void controller.reconnect(state.id) }}>{t('retry')}</button>}{' '}<button onClick={() => controller.close()}>{t('cancel')}</button></div>
      : <>
        {bridge ? <DesktopGuest bridge={bridge} id={state.id} url={state.url!} title={t('frame')} failed={failed} />
          : <iframe key={state.url} className="dc-remote-frame" src={state.url} title={t('frame')} referrerPolicy="no-referrer" allow="clipboard-write" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox" onError={failed} />}
        {!state.presented && <div className="dc-remote-loading"><p role="status">{t('opening')} {state.name}</p><button onClick={() => controller.close()}>{t('cancel')}</button></div>}
      </>}
  </section>
}

/** Compose the native shell through public slots; remote content owns no local Session. */
export function installWorkspaces(ctx: Context, api: ConnectionsApi & WorkspaceApi, canRoute = () => true, onCommands?: (resolver: NativeCommandResolver) => () => void, navigatePanel: (action: () => void) => void = action => action()): WorkspaceController {
  const bridge = desktopBrowser()
  let workspaceReady = false
  let ownsWorkspaces = () => false
  let storage: Storage | undefined
  try { storage = window.localStorage } catch { /* Optional preference persistence. */ }
  let localNavigate: (target: WorkspaceNavigationTarget) => Promise<void> = async () => { throw new Error('Local workspace navigation is not ready.') }
  let sessionStorage: Storage | undefined
  try { sessionStorage = window.sessionStorage } catch { /* Optional per-tab leases. */ }
  const viewOwner = new AbortController()
  ctx.effect(() => () => viewOwner.abort())
  const controller = new WorkspaceController(api, {
    schedulePoll: task => scheduleVisiblePoll(document, task),
    clientId: viewClientId(sessionStorage, 'workspace', window, viewOwner.signal), storage, surface: localSurface(ctx), prepareUrl: url => {
      if (!canRoute() || !workspaceReady || !ownsWorkspaces()) throw new Error('sidebar-composition-unavailable')
      return workspaceUrl(url, window.location, bridge !== undefined)
    },
    localNavigate: target => localNavigate(target),
  })
  let controls: { search(): void; add(): void; blocked(): void } | undefined
  const resolveCommand = workspaceCommandResolver({
    getRemoteSourceId: () => controller.getSnapshot()?.id,
    onNewSession: source => { if ((controller.getSnapshot()?.id ?? 'local') === source) void controller.newSession() },
    onClose: source => { if (controller.getSnapshot()?.id === source) controller.close() },
    onSearch: () => controls?.search(), onAddWorkspace: () => controls?.add(),
    onBlocked: (_command, source) => { if (controller.getSnapshot()?.id === source) controls?.blocked() },
  })
  // Command ownership follows the view controller even when the sidebar is unmounted.
  ctx.effect(() => onCommands?.(resolveCommand) ?? (() => {}))
  ctx.effect(() => ctx.locale.register('connections.workspace', { en, zh }))
  const t = ctx.locale.bind('connections.workspace') as WorkspaceTranslate
  ctx.effect(() => () => controller.dispose())
  const panel = 'connections.workspace' as MainPanelId

  const delegate = (slot: PickerSlot, alias: LocalSlot, excluded?: unknown, onFailure?: () => void) => {
    let delegated: StoredEntry | undefined
    let remove: (() => void) | undefined
    let active = true
    const stop = () => { active = false; off(); remove?.(); remove = undefined }
    const sync = () => {
      if (!active) return
      try {
        const entry = ctx.slots.entries(slot).find(entry => entry.component !== excluded)
        if (entry === delegated) return
        remove?.(); remove = undefined; delegated = entry
        if (!entry || (entry.children && Object.keys(entry.children).length > 0)) return
        remove = ctx.slots.register({ name: alias, inject: entry.inject, store: entry.store, locale: entry.locale } as never, entry.component as never)
      } catch {
        // A failed alias must not retain a subscriber that later writes into a
        // retired child declaration or rolls back the independent native shell.
        stop()
        onFailure?.()
        ctx.logger.warn('Connections could not delegate the native directory picker; native navigation is preserved.')
      }
    }
    const off = ctx.slots.subscribe(slot, sync)
    sync()
    return stop
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
        useEffect(() => {
          const current = {
            search: () => setSearchRequest(value => value + 1),
            add: () => { props.expandSidebar(); setError(false); setOpen(true) },
            blocked: () => setShortcutNote(true),
          }
          controls = current
          return () => { if (controls === current) controls = undefined }
        }, [props.expandSidebar])
        useEffect(() => { setShortcutNote(false) }, [selected.sourceId, selected.sessionId])
        const mutate = (id: string, request: Parameters<WorkspaceController['mutate']>[1]) =>
          controller.mutate(id, request, sources.find(source => source.id === id)?.info?.transportId)
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
            onRenameWorkspace={(id, workspaceId, title) => mutate(id, { op: 'renameWorkspace', id: workspaceId, title })}
            onForgetWorkspace={(id, workspaceId) => mutate(id, { op: 'forgetWorkspace', id: workspaceId })}
            onRenameSession={(id, sessionId, title) => mutate(id, { op: 'renameSession', id: sessionId, title })}
            onArchiveSession={(id, sessionId, archived, options) => mutate(id, { op: 'archiveSession', id: sessionId, archived, ...options })}
            onPinSession={(id, sessionId, pinned) => mutate(id, { op: 'pinSession', id: sessionId, pinned })} />
          {shortcutNote && <p className="dcw-command-note" role="status">{t('shortcutBlocked')} <button onClick={() => setShortcutNote(false)}>{t('cancel')}</button></p>}
          {error && <p role="alert">{t('failed')} <button onClick={() => setError(false)}>{t('cancel')}</button></p>}
          <HostChooser owner={owner} controller={controller} t={t} renderLocal={owner => props.renderSlot('connections.local.sidebarDirectoryFlow', owner, { fallback: <p role="alert">{t('localUnavailable')} <button onClick={owner.onCancel}>{t('cancel')}</button></p> })} />
        </>
      }
      let remove: (() => void) | undefined
      let stopDelegate: (() => void) | undefined
      let syncing = false
      let failed = false
      let warned = false
      const conflict = () => ctx.slots.entries('sidebar.workspaces').some(entry => entry.component !== Browser && (entry.options.priority ?? 0) < 0)
      ownsWorkspaces = () => remove !== undefined && !conflict() && ctx.slots.entriesOfSlot('sidebar.workspaces')[0]?.component === Browser
      const retire = () => {
        workspaceReady = false
        stopDelegate?.(); stopDelegate = undefined
        remove?.(); remove = undefined
        if (controller.getSnapshot()) controller.close()
      }
      const sync = () => {
        if (syncing || failed) return
        syncing = true
        try {
          if (conflict()) {
            if (!warned) ctx.logger.warn('Connections left sidebar.workspaces to another priority provider; remote workspace navigation is unavailable.')
            warned = true
            retire()
          } else {
            warned = false
            if (!remove) {
              remove = ctx.slots.register({ name: 'sidebar.workspaces', priority: -1, locale: 'connections.workspace',
                children: { 'connections.local.sidebarDirectoryFlow': { kind: 'single', scope: 'root' } },
              }, Browser)
              stopDelegate = delegate('sidebar.workspaces.directoryFlow', 'connections.local.sidebarDirectoryFlow', undefined, () => { failed = true; retire() })
            }
            workspaceReady = ownsWorkspaces()
            if (!workspaceReady && controller.getSnapshot()) controller.close()
          }
        } catch {
          failed = true
          retire()
          ctx.logger.warn('Connections could not compose sidebar.workspaces; native navigation is preserved.')
        } finally { syncing = false }
      }
      const unsubscribe = ctx.slots.subscribe('sidebar.workspaces', sync)
      sync()
      return () => { unsubscribe(); ownsWorkspaces = () => false; retire() }
    })
    // The empty-state picker keeps its native adoption semantics for this computer.
    ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => {
      const Picker = (props: DirectoryFlowOwnerProps & PropsRenderSlots<'connections.local.heroDirectoryFlow'>) => {
        const { open, busy, onPicked, onCancel, onError } = props
        return <HostChooser owner={{ open, busy, onPicked, onCancel, onError }} controller={controller} t={t}
          renderLocal={owner => props.renderSlot('connections.local.heroDirectoryFlow', owner, { fallback: <p role="alert">{t('localUnavailable')} <button onClick={owner.onCancel}>{t('cancel')}</button></p> })} />
      }
      let remove: (() => void) | undefined
      let removeAlias: (() => void) | undefined
      let delegated: StoredEntry | undefined
      let syncing = false
      let failed = false
      let warned = false
      const nativeLeaf = () => {
        const entries = ctx.slots.entries('conversation.hero.workspace.directoryFlow').filter(entry => entry.component !== Picker)
        if (entries.some(entry => (entry.options.priority ?? 0) < 0)) return
        const entry = entries[0]
        if (!entry || entry.children && Object.keys(entry.children).length > 0) return
        return entry
      }
      const retire = () => {
        removeAlias?.(); removeAlias = undefined
        remove?.(); remove = undefined
        delegated = undefined
      }
      const sync = () => {
        if (syncing || failed) return
        syncing = true
        try {
          const entry = nativeLeaf()
          if (!entry) {
            retire()
            if (!warned && ctx.slots.entries('conversation.hero.workspace.directoryFlow').length > 0) {
              warned = true
              ctx.logger.warn('Connections left the workspace directory picker to another provider; native navigation is preserved.')
            }
            return
          }
          warned = false
          if (entry === delegated) return
          retire()
          // Validate the delegated leaf before shadowing it. Both registrations
          // commit synchronously before batched slot publication; an alias error
          // withdraws the wrapper instead of leaving a non-functional chooser.
          remove = ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', priority: -1, locale: 'connections.workspace',
            children: { 'connections.local.heroDirectoryFlow': { kind: 'single', scope: 'root' } },
          }, Picker)
          removeAlias = ctx.slots.register({ name: 'connections.local.heroDirectoryFlow', inject: entry.inject, store: entry.store, locale: entry.locale } as never, entry.component as never)
          delegated = entry
        } catch {
          failed = true
          retire()
          ctx.logger.warn('Connections could not compose the workspace directory picker; native navigation is preserved.')
        } finally { syncing = false }
      }
      const unsubscribe = ctx.slots.subscribe('conversation.hero.workspace.directoryFlow', sync)
      sync()
      return () => { unsubscribe(); retire() }
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
          if (remote && !wasRemote) navigatePanel(() => { ctx.layout.beginNavigation(); ctx.layout.selectPanel(panel); wasRemote = true })
          else if (!remote && wasRemote) navigatePanel(() => { wasRemote = false; if (ctx.layout.panelInfo.getSnapshot().activePanelId === panel) ctx.layout.selectPanel(null) })
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
      // Before a first native main binding exists, beginNavigation cannot tell
      // automatic blank restoration from a user action. During only this cold
      // saved-selection restore, trusted local activity cancels the automatic
      // intent conservatively; it never intercepts or reroutes the input.
      const startup = new AbortController()
      const cancelColdRestore = (event: Event) => {
        if (event.isTrusted && ctx.uiSession.adapter.current.getSnapshot().key === undefined
          && !controller.getSnapshot() && controller.hasNavigationIntent()) controller.close()
      }
      const cold = ctx.uiSession.adapter.current.getSnapshot().key === undefined
      if (cold) {
        document.addEventListener('pointerdown', cancelColdRestore, { capture: true })
        document.addEventListener('keydown', cancelColdRestore, { capture: true })
      }
      const stopColdRestore = () => {
        startup.abort()
        if (!cold) return
        document.removeEventListener('pointerdown', cancelColdRestore, { capture: true })
        document.removeEventListener('keydown', cancelColdRestore, { capture: true })
      }
      void controller.restore(() => waitForNativeStartup(ctx.uiSession.adapter.current, ctx.workspaces.list,
        AbortSignal.any([viewOwner.signal, startup.signal]))).finally(stopColdRestore)
      // Capture the remote preference before sampling already-restored native state.
      controller.localSelection(ctx.uiSession.adapter.current.getSnapshot().key)
      return () => { stopColdRestore(); document.removeEventListener('visibilitychange', visibility); offController(); offPanel(); offSession() }
    })
  })
  return controller
}

const workspaceCss = `
.dc-workspace-chooser,.dc-remote-workspace{font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.dc-workspace-chooser{max-height:calc(100dvh - 48px);overflow:auto;width:min(420px,calc(100vw - 48px));border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:24px;box-sizing:border-box;box-shadow:var(--dsw-elevation-panel)}.dc-workspace-chooser::backdrop{background:color-mix(in srgb,var(--dsw-static-neutral-1000) 32%,transparent)}
.dc-workspace-chooser h2{font-size:19px;margin:0 0 6px}.dc-workspace-chooser h3{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);margin:24px 0 8px}.dc-workspace-chooser p{color:var(--dsw-alias-label-secondary);margin:0 0 18px}
.dc-workspace-chooser button,.dc-remote-workspace button{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:7px 12px;cursor:pointer}.dc-workspace-chooser button:hover,.dc-remote-workspace button:hover{background:var(--dsw-alias-bg-layer-1)}.dc-workspace-chooser button:focus-visible,.dc-remote-workspace button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dc-workspace-chooser .dc-host-search{box-sizing:border-box;width:100%;font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);padding:8px;border-radius:6px;margin-bottom:8px}.dc-workspace-chooser .dc-host-choice{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;text-align:left;margin:6px 0;padding:12px}.dc-host-choice strong{font-weight:500}.dc-host-choice span{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis}.dc-workspace-chooser-actions{display:flex;justify-content:flex-end;margin-top:22px}
.dc-remote-workspace{position:relative;flex:1;min-width:0;min-height:0;width:100%;height:100%;margin:0;padding:0;border:0;overflow:hidden;display:flex;flex-direction:column}.dc-remote-loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--dsw-alias-bg-base);padding:32px;text-align:center}.dc-remote-loading p{color:var(--dsw-alias-label-secondary)}.dc-remote-status{margin:auto;padding:32px;max-width:520px;text-align:center}.dc-remote-frame,.dc-remote-guest{display:flex;flex:1;min-height:0;width:100%;height:100%;border:0}.dc-remote-guest>.dc-remote-frame{height:100%}
`
