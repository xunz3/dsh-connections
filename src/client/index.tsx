import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createApi, mountRpc } from './rpc.js'
import { Panel } from './Panel.js'
import { en, zh, type CopyKey, type Translate } from './messages.js'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { connections: CopyKey } }
export const inject = ['slots', 'locale', 'remote']
export async function apply(ctx: Context) {
  await mountRpc(ctx)
  ctx.inject(['remote.connections'], ctx => {
    const api = createApi(ctx)
    ctx.effect(() => ctx.locale.register('connections', { en, zh }))
    const t = ctx.locale.bind('connections') as Translate
    const SettingsPanel = () => <Panel api={api} t={t} />
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'connections', locale: 'connections', order: 30, label: () => t('title') }, SettingsPanel))
  })
}
