import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createApi, mountRpc } from './rpc.js'
import { Panel } from './Panel.js'
import { en, zh, type CopyKey, type Translate } from './messages.js'
import { installWorkspaces } from './workspaces.js'
import { applyEmbedded } from './embedded.js'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { connections: CopyKey } }
export const inject = ['slots', 'locale', 'remote', 'theme']
export async function apply(ctx: Context) {
  if ((globalThis as typeof globalThis & { __DSH_CONNECTIONS_EMBEDDED__?: boolean }).__DSH_CONNECTIONS_EMBEDDED__ === true) {
    applyEmbedded(ctx)
    return
  }
  await mountRpc(ctx)
  ctx.inject(['remote.connections'], ctx => {
    const api = createApi(ctx)
    ctx.effect(() => ctx.locale.register('connections', { en, zh }))
    const t = ctx.locale.bind('connections') as Translate
    const workspaces = installWorkspaces(ctx, api, t)
    const SettingsPanel = () => <Panel api={api} t={t} onOpen={id => workspaces.open(id)} />
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'connections', locale: 'connections', order: 30, label: () => t('title') }, SettingsPanel))
  })
}
