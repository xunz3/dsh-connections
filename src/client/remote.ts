import type { Context } from '@deepseek-ai/cordis'
import { createElement, useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { applyEmbedded, embeddedChannel, embeddedEndpoint } from './embedded.js'
import { createViewSurfaceClient } from './view-surface.js'
import { createLocalSettingsAdapter, installLocalThemeTokens, type NativeSettingsAdapter } from './local-presentation.js'
import { createLoginHost, type LoginHost } from './login-host.js'
import { nativeContent } from './native-content.js'

// Materialize the selected native CSS during ModuleLoader's factory inventory,
// so its standard unload/rollback owns these styles too. Runtime capabilities
// are supplied only after the authenticated view has bootstrapped.
const bootVersion = (globalThis as typeof globalThis & { __DSH_BOOT__?: { release?: { version?: string } } }).__DSH_BOOT__?.release?.version
let adaptSettings: NativeSettingsAdapter = Native => Native
let loginHost: LoginHost | undefined
const requireLogin = () => { if (!loginHost) throw new Error('The login view is unavailable'); return loginHost }
const factories = nativeContent(bootVersion ?? '', window.parent === window ? {
  prepare: () => requireLogin().prepare(), copy: url => requireLogin().copy(url), dispose() {},
 } : undefined, Native => adaptSettings(Native))

// Bootstrap local presentation before any native content can choose remote UI
// preferences. Execution/configuration services remain those of this Host.
export const inject = ['slots', 'remote', 'remote.settings']
export async function apply(ctx: Context): Promise<void> {
  const channel = embeddedChannel(window.location.hash)
  if (!channel) {
    ctx.plugin({ name: 'connections-native-settings', ...factories.settings })
    ctx.inject(['locale', 'theme'], content => applyEmbedded(content))
    return
  }
  const surface = createViewSurfaceClient(channel, embeddedEndpoint(document))
  ctx.effect(() => () => surface.dispose())
  const snapshot = await surface.ready
  const failed = createSnapshotStore(false)
  const login = createLoginHost((action, signal) => surface.request(action, signal), () => failed.set(true))
  if (snapshot.nativeVersion !== bootVersion) throw new Error('The remote native runtime changed; reopen this view')
  loginHost = login
  adaptSettings = createLocalSettingsAdapter(surface)
  ctx.effect(() => () => { login.dispose(); if (loginHost === login) loginHost = undefined })
  ctx.plugin({ name: 'connections-native-settings', ...factories.settings })
  installLocalThemeTokens(ctx, surface)
  ctx.plugin({ name: 'connections-native-account', ...factories.account })
  ctx.inject(['locale', 'theme'], content => {
    applyEmbedded(content)
    // Native account owns retry/copy/cancel. An asynchronous system-browser
    // failure is an explicit status, never an unhandled promise or fake success.
    const Notice = () => {
      const show = useSyncExternalStore(failed.subscribe, failed.getSnapshot)
      if (!show) return null
      const zh = content.locale.getSnapshot().active.startsWith('zh')
      return createElement('div', { role: 'alert', className: 'dc-embedded-notice', style: { zIndex: 10000 } },
        zh ? '未能打开登录页面，请在登录窗口复制链接后重试。' : 'Unable to open sign-in. Copy the link in the sign-in dialog and try again.',
        createElement('button', { type: 'button', onClick: () => failed.set(false) }, zh ? '关闭' : 'Dismiss'))
    }
    content.slots.register({ name: 'shell.overlay', id: 'connections.login-status' }, Notice)
  })
}
