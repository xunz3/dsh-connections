import type { Context } from '@deepseek-ai/cordis'
import { useState, useSyncExternalStore } from 'react'
import type { PropsRenderSlots, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { IconGlobeOutlineRegular, IconSlidersTwoOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsHostSnapshot } from './settings-host-bridge.js'

const messages = {
  en: { host: 'Host', local: 'This computer', loading: 'Loading hosts…', failed: 'Could not select this host.', connected: 'Connected', connecting: 'Connecting', disconnected: 'Disconnected', updating: 'Updating', error: 'Connection failed' },
  zh: { host: '主机', local: '本地电脑', loading: '正在加载主机…', failed: '无法选择此主机。', connected: '已连接', connecting: '正在连接', disconnected: '未连接', updating: '正在更新', error: '连接失败' },
}

export interface SettingsHostSource {
  getSnapshot(): SettingsHostSnapshot | undefined
  subscribe(listener: () => void): () => void
  select(id: string): void | Promise<void>
  refresh?(): void | Promise<void>
}

/** Native menu owns placement, keyboard navigation, selection and focus return. */
export function SettingsHostMenu({ snapshot, locale, onSelect, onOpen }: {
  snapshot?: SettingsHostSnapshot
  locale: string
  onSelect(id: string): void | Promise<void>
  onOpen?(): void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const t = locale.startsWith('zh') ? messages.zh : messages.en
  const remote = snapshot !== undefined && snapshot.selectedId !== 'local'
  const current = remote ? snapshot.choices.find(row => row.id === snapshot.selectedId)?.name ?? t.host : t.local
  const items: MenuEntry[] = [{ type: 'label', id: 'host-label', text: t.host }, ...(snapshot?.choices.map(row => ({
    id: row.id,
    icon: row.id === 'local' ? <IconSlidersTwoOutlineRegular /> : <IconGlobeOutlineRegular />,
    label: <span className="dcs-host-row"><span>{row.id === 'local' ? t.local : row.name}</span>
      {row.id !== 'local' && <i className="dcs-host-dot" data-phase={row.phase} aria-label={t[row.phase]} title={t[row.phase]} />}</span>,
  })) ?? [{ id: 'loading', label: t.loading, disabled: true }])]
  return <>
    <style>{styles}</style>
    <Menu open={open} onClose={() => setOpen(false)} items={items} selectedId={snapshot?.selectedId} portal dense align="end"
      className="dcs-host-menu" listClassName="dcs-host-list"
      footer={failed ? [{ type: 'label', id: 'host-error', text: t.failed }] : undefined}
      onSelect={id => {
        if (!snapshot?.choices.some(row => row.id === id)) return
        setOpen(false); setFailed(false)
        void Promise.resolve().then(() => onSelect(id)).catch(() => { setFailed(true); setOpen(true) })
      }}
      anchor={<button type="button" className="dcs-host-trigger" aria-label={`${t.host}: ${current}`} title={`${t.host}: ${current}`}
        aria-haspopup="menu" aria-expanded={open} onClick={() => {
          if (!open) { setFailed(false); void Promise.resolve().then(onOpen).catch(() => setFailed(true)) }
          setOpen(!open)
        }}><IconSlidersTwoOutlineRegular size={16} /></button>} />
  </>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap { 'connections.settings.nativeHeader': { kind: 'single'; scope: 'root'; owner: {} } }
}

/** Wrap the public header leaf; the original title keeps its own locale and injection. */
export function installSettingsHostHeader(ctx: Context, source: SettingsHostSource): void {
  const subscribeLocale = (listener: () => void) => ctx.locale.subscribe(listener)
  const locale = () => ctx.locale.getSnapshot()
  const Header = (props: PropsRenderSlots<'connections.settings.nativeHeader'>) => {
    const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
    const language = useSyncExternalStore(subscribeLocale, locale).active
    return <div className="dcs-host-header">
      {props.renderSlot('connections.settings.nativeHeader', {})}
      <SettingsHostMenu snapshot={snapshot} locale={language} onSelect={source.select} onOpen={source.refresh} />
    </div>
  }
  ctx.slots.inject('settings.header', () => {
    const remove = ctx.slots.register({ name: 'settings.header', priority: -100,
      children: { 'connections.settings.nativeHeader': { kind: 'single', scope: 'root' } },
    }, Header)
    let delegated: StoredEntry | undefined
    let removeAlias: (() => void) | undefined
    const sync = () => {
      const entry = ctx.slots.entries('settings.header').find(row => row.component !== Header)
      if (entry === delegated) return
      removeAlias?.(); removeAlias = undefined; delegated = entry
      if (!entry || entry.children && Object.keys(entry.children).length > 0) return
      removeAlias = ctx.slots.register({ name: 'connections.settings.nativeHeader', inject: entry.inject, store: entry.store, locale: entry.locale } as never, entry.component as never)
    }
    const unsubscribe = ctx.slots.subscribe('settings.header', sync)
    sync()
    return () => { unsubscribe(); removeAlias?.(); remove() }
  })
}

const styles = `
.dcs-host-header{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-width:0}
.dcs-host-menu{display:inline-flex;flex:none;font-weight:400}
.dcs-host-trigger{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-width:28px;max-width:100%;height:28px;padding:5px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dcs-host-trigger>svg{flex:none}
.dcs-host-trigger:hover,.dcs-host-trigger[aria-expanded=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dcs-host-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dcs-host-list{max-width:min(300px,calc(100vw - 24px));font-weight:400}
.dcs-host-row{display:flex;align-items:center;gap:10px;min-width:0;width:100%}.dcs-host-row>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcs-host-dot{flex:none;display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#9ca3af)}
.dcs-host-dot[data-phase=connected]{background:var(--dsw-alias-state-success-primary,#28a76b)}.dcs-host-dot[data-phase=connecting],.dcs-host-dot[data-phase=updating]{background:var(--dsw-alias-state-warning-primary,#ca9230)}.dcs-host-dot[data-phase=error]{background:var(--dsw-alias-state-error-primary,#d65353)}
`
