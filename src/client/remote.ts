import type { Context } from '@deepseek-ai/cordis'
import { createElement, useSyncExternalStore } from 'react'
import { createSnapshotStore } from './snapshot-store.js'
import { applyEmbedded, embeddedChannel, embeddedEndpoint } from './embedded.js'
import { createViewSurfaceClient } from './view-surface.js'
import { createLocalSettingsAdapter, installLocalThemeTokens } from './local-presentation.js'
import { createLoginHost } from './login-host.js'
import { nativeSettingsContent } from './native-content.js'
import { installAccountLoginSlots } from './settings-native/account-slots.js'

// Runtime release admission remains separate from plugin-owned protocol checks.
const bootVersion = (globalThis as typeof globalThis & { __DSH_BOOT__?: { release?: { version?: string } } }).__DSH_BOOT__?.release?.version

// Supply accepted presentation before ConfigForms is published: native consumers
// otherwise cache and subscribe before a runtime form wrapper can safely adapt it.
export const inject = ['slots', 'remote', 'remote.settings']
export async function apply(ctx: Context): Promise<void> {
  const channel = embeddedChannel(window.location.hash)
  if (!channel) {
    ctx.plugin({ name: 'connections-native-settings', ...nativeSettingsContent(bootVersion ?? '', Native => Native) })
    ctx.inject(['locale', 'theme'], content => applyEmbedded(content))
    return
  }
  const surface = createViewSurfaceClient(channel, embeddedEndpoint(document))
  ctx.effect(() => () => surface.dispose())
  const snapshot = await surface.ready
  if (snapshot.nativeVersion !== bootVersion) throw new Error('The remote native runtime changed; reopen this view')
  const failed = createSnapshotStore(false)
  const login = createLoginHost((action, signal) => surface.request(action, signal), () => failed.set(true))
  ctx.effect(() => () => login.dispose())
  // Install the bridge while dependent native providers are still waiting for
  // ConfigForms. It contributes through their later-declared public slots and
  // never imports or instantiates the native Account module or its stylesheet.
  installAccountLoginSlots(ctx, login, bootVersion ?? '')
  ctx.plugin({ name: 'connections-native-settings', ...nativeSettingsContent(bootVersion ?? '', createLocalSettingsAdapter(surface)) })
  installLocalThemeTokens(ctx, surface)
  ctx.inject(['locale', 'theme'], content => {
    applyEmbedded(content)
    // Account state/credentials remain native. Asynchronous system-browser
    // failures get a fixed notice; Copy can retry through the same view bridge.
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
