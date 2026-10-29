import type { Context } from '@deepseek-ai/cordis'
import { useSyncExternalStore, type ComponentType } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createApi, mountRpc } from './rpc.js'
import { Panel } from './Panel.js'
import { en, zh, type CopyKey, type Translate } from './messages.js'
import { installWorkspaces } from './workspaces.js'
import { applyEmbedded } from './embedded.js'
import { installHostSettings } from './host-settings.js'
import { installNativeSidebar } from './native-shell-routing.js'
import { installNativeShortcuts, type NativeCommandResolver } from './native-shortcuts.js'
import { remoteSettingsCommand } from './workspace-shortcuts.js'
import { settingsShell } from './native-settings.js'
import { mountSettingsIcon } from './settings-icon.js'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { connections: CopyKey } }
export const inject = ['locale']
export function apply(ctx: Context) {
  if ((globalThis as typeof globalThis & { __DSH_CONNECTIONS_EMBEDDED__?: boolean }).__DSH_CONNECTIONS_EMBEDDED__ === true) {
    ctx.inject(['slots', 'theme'], scope => applyEmbedded(scope))
    return
  }
  let commands: NativeCommandResolver | undefined
  let remoteSettings: ReturnType<typeof installHostSettings> | undefined
  let shortcutsReady = false
  let closeRemote: (() => void) | undefined
  installNativeShortcuts(ctx, (command, context) => remoteSettings?.getSnapshot()
    ? remoteSettingsCommand(command, context, () => remoteSettings?.close())
    : commands?.(command, context), ready => {
      const lost = shortcutsReady && !ready
      shortcutsReady = ready
      if (lost) closeRemote?.()
    })
  ctx.inject(['slots', 'theme', 'configForms'], scope => installShell(scope, {
    canRoute: () => shortcutsReady,
    setClose: close => { closeRemote = close; return () => { if (closeRemote === close) closeRemote = undefined } },
    setCommands: resolver => { commands = resolver; return () => { if (commands === resolver) commands = undefined } },
    setSettings: value => { remoteSettings = value; return () => { if (remoteSettings === value) remoteSettings = undefined } },
  }))
}

function installShell(ctx: Context, routing: {
  canRoute(): boolean
  setClose(close: () => void): () => void
  setCommands(resolver: NativeCommandResolver): () => void
  setSettings(value: ReturnType<typeof installHostSettings>): () => void
}) {
  // Mount the native shell independently of the RPC/data plane. A failed
  // connection service must never remove navigation or access to Settings.
  let startRemote: ((id?: string) => void) | undefined
  let closeRemote: (() => void) | undefined
  let routed = false
  const setSidebarReady = (ready: boolean) => {
    const lost = routed && !ready
    routed = ready
    // Initial dependency/slot discovery is not navigation. Closing here would
    // erase the saved remote selection before its restoration can finish.
    if (lost) closeRemote?.()
  }
  ctx.inject(['uiWorkspace', 'layout', 'shortcuts'], scope => {
    installNativeSidebar(scope, { startSession: id => {
      if (startRemote) startRemote(id)
      else scope.uiWorkspace.startSession(id)
    }, onReady: setSidebarReady })
    return () => { setSidebarReady(false) }
  })
  ctx.effect(() => ctx.locale.register('connections', { en, zh }))
  const t = ctx.locale.bind('connections') as Translate
  const settings = createSnapshotStore<{ panel?: ComponentType; failed: boolean }>({ failed: false })
  ctx.effect(() => {
    const timer = setTimeout(() => { if (!settings.getSnapshot().panel) settings.set({ failed: true }) }, 10_000)
    return () => clearTimeout(timer)
  })
  const SettingsPanel = () => {
    const state = useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot)
    return state.panel ? <state.panel /> : <p role={state.failed ? 'alert' : 'status'}>{t(state.failed ? 'serviceUnavailable' : 'loading')}</p>
  }
  // This entry and the shell belong to the stable parent. Cordis rolls back a
  // rejected async apply, so RPC setup must run in a separately owned child.
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'connections', locale: 'connections', order: 30, label: () => t('title') }, SettingsPanel))
  if (typeof document !== 'undefined') ctx.effect(() => mountSettingsIcon(ctx.slots))
  ctx.inject(['remote'], scope => {
    let active = true
    scope.effect(() => () => { active = false; settings.set({ failed: true }) })
    const data = scope.plugin({ name: 'connections-data', async apply(data: Context) {
      await mountRpc(data)
      const connection = data.inject(['remote.connections'], connection => {
        const api = createApi(connection)
        const canRoute = () => routed && routing.canRoute()
        const workspaces = installWorkspaces(connection, api, t, canRoute, routing.setCommands)
        const hostSettings = installHostSettings(connection, api, canRoute)
        const close = () => { workspaces.close(); hostSettings.close() }
        closeRemote = close
        connection.effect(() => routing.setClose(close))
        connection.effect(() => routing.setSettings(hostSettings))
        const route = (id?: string) => { void workspaces.newSession(id) }
        const ReadyPanel = () => <Panel api={api} t={t} onOpen={id => {
          settingsShell(connection)?.actions.close()
          return workspaces.open(id)
        }} onAddWorkspace={id => {
          settingsShell(connection)?.actions.close()
          return workspaces.pick(id)
        }} onManagePlugins={id => {
          settingsShell(connection)?.actions.close()
          return workspaces.open(id, { kind: 'plugins' })
        }} />
        startRemote = route
        settings.set({ panel: ReadyPanel, failed: false })
        connection.effect(() => () => {
          if (closeRemote === close) closeRemote = undefined
          if (startRemote === route) startRemote = undefined
          if (settings.getSnapshot().panel === ReadyPanel) settings.set({ failed: true })
        })
      })
      void Promise.resolve(connection).catch(() => { if (active) settings.set({ failed: true }) })
    } })
    void Promise.resolve(data).catch(() => { if (active) settings.set({ failed: true }) })
  })
}
