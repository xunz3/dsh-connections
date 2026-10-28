import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Modal, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionsApi } from '../shared/types.js'
import type { WorkspaceApi } from '../shared/workspace-rpc.js'
import { WorkspaceController, viewClientId } from './workspace-controller.js'
import { workspaceMessages } from './workspaces.js'
import { workspaceUrl } from './workspace-surface.js'
import { settingsShell } from './native-settings.js'
import { bindSettingsHostParent, type SettingsHostSnapshot } from './settings-host-bridge.js'
import { installSettingsHostHeader, SettingsHostMenu } from './settings-host-menu.js'

const en = {
  settings: 'Settings', local: 'This computer', close: 'Close settings', remote: 'Remote settings',
  opening: 'Opening settings…', retry: 'Retry', back: 'Return to this computer',
  unavailable: 'The native settings shell is unavailable. Reload this page to try again.',
  update: 'Update the Connections content bundle on this host to use the settings host menu.',
}
const zh: typeof en = {
  settings: '设置', local: '本地电脑', close: '关闭设置', remote: '远端设置',
  opening: '正在打开设置…', retry: '重试', back: '返回本地电脑',
  unavailable: '原生设置页面暂时不可用，请重新加载页面后重试。',
  update: '请更新此主机上的 Connections 内容插件，以使用设置主机菜单。',
}

/** Host selection lives in the native title. Each document keeps its own native forms. */
export function installHostSettings(ctx: Context, api: ConnectionsApi & WorkspaceApi): void {
  let storage: Storage | undefined
  try { storage = window.sessionStorage } catch { /* Optional per-tab view lease. */ }
  const controller = new WorkspaceController(api, {
    clientId: viewClientId(storage, 'settings'), catalogs: false,
    prepareUrl: url => workspaceUrl(url, window.location, false),
  })
  const hosts = createSnapshotStore<SettingsHostSnapshot>({ choices: [{ id: 'local', name: en.local, phase: 'connected' }], selectedId: 'local' })
  let disposed = false
  const refresh = async () => {
    const rows = await api.list()
    if (disposed) return
    hosts.set({ selectedId: controller.getSnapshot()?.id ?? 'local', choices: [
      { id: 'local', name: en.local, phase: 'connected' },
      ...rows.map(({ id, name, phase }) => ({ id, name, phase })),
    ] })
  }
  const subscribeLocale = (listener: () => void) => ctx.locale.subscribe(listener)
  const getLocale = () => ctx.locale.getSnapshot()
  const copy = () => getLocale().active.startsWith('zh') ? zh : en
  const choose = async (id: string) => {
    if (!hosts.getSnapshot().choices.some(row => row.id === id)) return
    if (id === hosts.getSnapshot().selectedId) return
    const native = settingsShell(ctx)
    if (id === 'local') { controller.close(); native?.actions.open(); return }
    if (!native) throw new Error(copy().unavailable)
    native.actions.close()
    await controller.open(id, { kind: 'settings' })
  }
  installSettingsHostHeader(ctx, { ...hosts, select: choose, refresh })

  const RemoteSettings = () => {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const choices = useSyncExternalStore(hosts.subscribe, hosts.getSnapshot)
    const language = useSyncExternalStore(subscribeLocale, getLocale).active
    const frame = useRef<HTMLIFrameElement>(null)
    const layer = useRef<HTMLDivElement>(null)
    const close = useRef(() => controller.close()).current
    const [ready, setReady] = useState<string>()
    const [failed, setFailed] = useState<string>()
    const [expired, setExpired] = useState<string>()
    const [switchError, setSwitchError] = useState<string>()
    const t = copy()
    const messages = language.startsWith('zh') ? workspaceMessages.zh : workspaceMessages.en
    const url = state?.phase === 'ready' ? state.url : undefined
    const channel = state?.channel
    const presented = url !== undefined && state?.presented && ready === url
    const error = switchError ?? (state?.phase === 'error' ? messages[state.error ?? 'failed']
      : failed === url && url !== undefined ? messages.failed
      : expired === url && url !== undefined && ready !== url ? t.update : undefined)
    const remoteVisible = !!presented && !error
    // The native status Modal owns focus until the remote native dialog is ready.
    useModalLayer(layer, remoteVisible, close)
    useEffect(() => { if (remoteVisible) frame.current?.focus() }, [remoteVisible])
    useEffect(() => {
      if (!url || !channel || !frame.current) return
      setReady(undefined); setFailed(undefined); setExpired(undefined); setSwitchError(undefined)
      let active = true
      let timer = setTimeout(() => setExpired(url), 30_000)
      const dispose = bindSettingsHostParent({
        frame: frame.current, channel, origin: new URL(url).origin,
        getSnapshot: hosts.getSnapshot, subscribe: hosts.subscribe,
        onSelect: id => { void choose(id).catch(() => setSwitchError(copy().unavailable)) },
        onReady: value => {
          if (!active) return
          clearTimeout(timer); setExpired(undefined); setReady(value ? url : undefined)
          if (!value) timer = setTimeout(() => setExpired(url), 30_000)
        },
      })
      return () => { active = false; clearTimeout(timer); dispose() }
    }, [url, channel])
    if (!state) return null
    return createPortal(<div ref={layer} role={remoteVisible ? 'dialog' : undefined} aria-modal={remoteVisible || undefined} aria-label={`${t.remote}: ${state.name}`} tabIndex={-1}
      className="dcs-remote-settings" data-shortcut-modal="settings" style={{ pointerEvents: remoteVisible ? 'auto' : 'none' }}>
      <style>{styles}</style>
      {url && <iframe key={url} ref={frame} className="dcs-settings-frame" title={t.remote} src={url} tabIndex={0}
        style={{ visibility: remoteVisible ? 'visible' : 'hidden' }} referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox"
        onError={() => setFailed(url)} />}
      {(!presented || error) && <Modal open title={t.settings} onClose={close} headless className="dcs-settings-status" shortcutModal="settings">
        <header><span className="dcs-host-header">{t.settings}<SettingsHostMenu snapshot={choices} locale={language} onSelect={choose} onOpen={refresh} /></span>
          <button type="button" aria-label={t.close} onClick={close}>×</button></header>
        <p role={error ? 'alert' : 'status'}>{error ?? t.opening}</p>
        <footer>{error && (state.phase === 'error' && ['failed', 'timeout', 'disconnected'].includes(state.error ?? 'failed') || failed === url && url !== undefined) && <button onClick={() => {
          if (state.phase === 'error') void controller.retry(state.id)
          else { controller.close(); void controller.open(state.id, { kind: 'settings' }) }
        }}>{t.retry}</button>}
          <button onClick={() => { void choose('local') }}>{t.back}</button></footer>
      </Modal>}
    </div>, document.body)
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'connections.settings' }, RemoteSettings))
  ctx.effect(() => {
    const unsubscribe = controller.subscribe(() => {
      const current = hosts.getSnapshot(), selectedId = controller.getSnapshot()?.id ?? 'local'
      if (current.selectedId !== selectedId) hosts.set({ ...current, selectedId })
    })
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (!document.hidden && controller.getSnapshot()) {
        await refresh().catch(() => {})
        await controller.check()
      }
      if (!disposed) timer = setTimeout(tick, 2500)
    }
    void refresh().catch(() => {})
    void tick()
    return () => { disposed = true; clearTimeout(timer); unsubscribe(); controller.dispose() }
  })
}

const styles = `
.dcs-remote-settings{position:fixed;inset:0;z-index:1000;outline:none}
.dcs-settings-frame{display:block;width:100%;height:100%;border:0;background:transparent}
.dcs-settings-status{width:min(420px,calc(100vw - 32px));padding:20px;color:var(--dsw-alias-label-primary)}
.dcs-settings-status header{display:flex;align-items:center;justify-content:space-between;gap:24px;font-weight:500}.dcs-settings-status .dcs-host-header{width:auto;gap:12px}
.dcs-settings-status p{margin:24px 0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1.6}.dcs-settings-status footer{display:flex;justify-content:flex-end;gap:8px}
.dcs-settings-status button{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:inherit;padding:6px 10px;font:inherit;cursor:pointer}.dcs-settings-status header>button{border:0;font-size:20px;padding:2px 4px}.dcs-settings-status button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
`
