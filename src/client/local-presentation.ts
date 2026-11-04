import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm, ConfigFormSnapshot, ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { LocalPresentation } from '../shared/view-surface-protocol.js'

export interface NativePresentationFactory { inject: string[]; apply(ctx: Context): void | Promise<void> }

/** Capture resolved native presentation; remote Hosts keep their own durable settings. */
export function readLocalPresentation(ctx: Context): LocalPresentation {
  const theme = ctx.theme.getTheme()
  const chat = ctx.configForms.get<Partial<LocalPresentation['general']>>('ui-chat').getSnapshot().value
  const conversation = ctx.configForms.get<Partial<LocalPresentation['general']>>('ui-conversation').getSnapshot().value
  const transcriptView = chat?.transcriptView as string | undefined
  return {
    locale: ctx.locale.getSnapshot().active,
    theme: { mode: 'mirrored', preference: theme.active.colorScheme, fontSize: theme.fontSizes.text, codeFontSize: theme.fontSizes.code,
      terminalFontSize: theme.fontSizes.terminal, textFontFamily: theme.fontFamilies.text, codeFontFamily: theme.fontFamilies.code, terminalFontFamily: theme.fontFamilies.terminal },
    general: {
      transcriptView: transcriptView === 'normal' || transcriptView === 'expanded' ? 'detailed'
        : ['compact', 'standard', 'detailed', 'verbose'].includes(transcriptView ?? '') ? transcriptView as LocalPresentation['general']['transcriptView'] : 'dshDesktop' in globalThis ? 'standard' : 'detailed',
      collapseTiming: chat?.collapseTiming ?? 'completion', performanceUsage: chat?.performanceUsage ?? 'detailed',
      linkOpening: chat?.linkOpening ?? 'sidebar', busyEnter: conversation?.busyEnter ?? 'queue', developerTools: ctx.configForms.developerTools.enabled.getSnapshot(),
    }, tokens: { ...theme.active.tokens },
  }
}
const sameValues = (left: object | undefined, right: object) => left !== undefined && Object.keys(left).length === Object.keys(right).length && Object.entries(right).every(([key, value]) => Reflect.get(left, key) === value)
function readOnlyForm<T extends object>() {
  let snapshot: ConfigFormSnapshot<T> = Object.freeze({ status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false })
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const refuse = async () => { notify(); return false }
  const form: ConfigForm<T> = { getSnapshot: () => snapshot, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } }, set: refuse, unset: refuse, mutate: refuse }
  return { form, update(value: T) {
    if (sameValues(snapshot.value, value)) return
    snapshot = Object.freeze({ status: 'ready', value: Object.freeze({ ...value }), base: undefined, user: undefined, revision: (snapshot.revision ?? 0) + 1, writable: false })
    notify()
  } }
}
export type NativeSettingsAdapter = (Native: typeof ConfigForms) => typeof ConfigForms
/**
 * rc.5 exposes no form override registration and its root Client entries activate
 * concurrently; Host isolate options do not cross the Client graph. Keep this
 * one build-checked constructor boundary until a real public composition seam
 * exists. Never monkeypatch cached native forms or synthesize mirror revisions.
 */
export function createLocalSettingsAdapter(source: HostObservable<LocalPresentation | undefined>): NativeSettingsAdapter {
  return Native => {
    const locale = readOnlyForm<{ preference: string }>(), theme = readOnlyForm<LocalPresentation['theme']>()
    const chat = readOnlyForm<Pick<LocalPresentation['general'], 'transcriptView' | 'collapseTiming' | 'performanceUsage' | 'linkOpening'>>()
    const conversation = readOnlyForm<Pick<LocalPresentation['general'], 'busyEnter'>>(), developerTools = readOnlyForm<{ enabled: boolean }>()
    const forms = new Map<string, ConfigForm<unknown>>([['locale', locale.form], ['ui-theme', theme.form], ['ui-chat', chat.form], ['ui-conversation', conversation.form], ['ui-settings', developerTools.form]])
    const sync = () => {
      const current = source.getSnapshot(); if (!current) return
      locale.update({ preference: current.locale }); theme.update(current.theme)
      const { transcriptView, collapseTiming, performanceUsage, linkOpening, busyEnter, developerTools: enabled } = current.general
      chat.update({ transcriptView, collapseTiming, performanceUsage, linkOpening }); conversation.update({ busyEnter }); developerTools.update({ enabled })
    }
    sync()
    return class extends Native {
      constructor(...args: ConstructorParameters<typeof ConfigForms>) { super(...args); args[0].effect(() => { const off = source.subscribe(sync); sync(); return off }) }
      override get<T>(entry: string): ConfigForm<T> { return (forms.get(entry) as ConfigForm<T> | undefined) ?? super.get<T>(entry) }
    }
  }
}
/** Mirror only accepted local palette tokens; all remote execution settings stay native. */
export function installLocalThemeTokens(ctx: Context, source: HostObservable<LocalPresentation | undefined>): void {
  ctx.inject(['theme'], mirror => {
    let previous: LocalPresentation['tokens'] | undefined, remove: (() => void) | undefined
    const syncTokens = () => {
      const current = source.getSnapshot()?.tokens; if (!current || sameValues(previous, current)) return
      const next = mirror.theme.overrideTokens('connections.local-presentation', Object.fromEntries(Object.entries(current).map(([name, value]) => [name, { light: value, dark: value }])))
      remove?.(); remove = next; previous = { ...current }
    }
    mirror.effect(() => { const off = source.subscribe(syncTokens); syncTokens(); return () => { off(); remove?.() } })
  })
}
