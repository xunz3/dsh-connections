import { useLayoutEffect, useRef, type CSSProperties, type PointerEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from './snapshot-store.js'
import type { ILayout, MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

interface EmbeddedLayoutState {
  readonly panelInfo: PanelInfo
  readonly viewport: number
  readonly preferredWidth?: number
  readonly settings: boolean
  readonly rightbar: { readonly shown: boolean; readonly track: boolean; readonly fullscreen: boolean }
}

/** Geometry belongs to this document; the native rightbar owns its expanded/fullscreen state. */
export function embeddedColumns(viewport: number, preferredWidth?: number) {
  const width = Math.max(0, Number.isFinite(viewport) ? viewport : 0)
  const maximum = Math.min(width * 0.7, width - 400)
  const rightbar = maximum < 300 ? 0 : Math.min(maximum, Math.max(300, preferredWidth ?? width * 0.45))
  return { viewport: width, rightbar, canShow: rightbar > 0 }
}

/** Public ILayout adapter for a dedicated remote document, never for a second context in the parent page. */
export class EmbeddedLayoutController implements ILayout {
  readonly state
  readonly panelInfo: HostObservable<PanelInfo>
  private navigation = new AbortController()
  private disposed = false

  constructor(private readonly hasPanel: (id: MainPanelId) => boolean, private readonly revealNavigation?: () => void, viewport = 0) {
    this.state = createSnapshotStore<EmbeddedLayoutState>({
      panelInfo: { activePanelId: null },
      viewport: embeddedColumns(viewport).viewport,
      settings: false,
      rightbar: { shown: false, track: false, fullscreen: false },
    })
    this.panelInfo = {
      getSnapshot: () => this.state.getSnapshot().panelInfo,
      subscribe: listener => {
        let previous = this.state.getSnapshot().panelInfo
        return this.state.subscribe(() => {
          const current = this.state.getSnapshot().panelInfo
          if (current !== previous) { previous = current; listener() }
        })
      },
    }
  }

  selectPanel(id: MainPanelId | null): void {
    if (id !== null && !this.hasPanel(id)) throw new Error(`connections: unknown main panel "${id}"`)
    if (this.disposed) return
    this.navigation.abort()
    const state = this.state.getSnapshot()
    // A native selection can finish on the same blank Session and panel. Keep
    // this completion observable even when its panel identity did not change.
    this.state.set({ ...state, panelInfo: { activePanelId: id } })
  }

  showSettings(settings: boolean): void {
    if (!this.disposed && this.state.getSnapshot().settings !== settings) this.state.set({ ...this.state.getSnapshot(), settings })
  }

  beginNavigation(): AbortSignal {
    this.navigation.abort()
    this.navigation = new AbortController()
    if (this.disposed) this.navigation.abort()
    return this.navigation.signal
  }

  toggleSidebar(): void {
    if (this.disposed) return
    if (!this.revealNavigation) throw Object.assign(new Error('connections: workspace navigation is controlled by the local application'), { code: 'NAVIGATION_UNAVAILABLE' })
    this.revealNavigation()
  }
  openRightbar(track: boolean, fullscreen: boolean): void { this.present(true, track, fullscreen) }
  closeRightbar(): void { this.present(false, false, false) }

  measure = (viewport: number): void => {
    if (this.disposed || !Number.isFinite(viewport) || viewport <= 0) return
    const state = this.state.getSnapshot()
    if (state.viewport !== viewport) this.state.set({ ...state, viewport })
  }

  resize = (width: number): void => {
    if (this.disposed || !Number.isFinite(width)) return
    const state = this.state.getSnapshot()
    const preferredWidth = embeddedColumns(state.viewport, width).rightbar
    if (preferredWidth > 0 && state.preferredWidth !== preferredWidth) this.state.set({ ...state, preferredWidth })
  }

  dispose(): void { this.disposed = true; this.navigation.abort() }

  private present(shown: boolean, track: boolean, fullscreen: boolean): void {
    if (this.disposed) return
    const state = this.state.getSnapshot()
    const current = state.rightbar
    if (current.shown === shown && current.track === track && current.fullscreen === fullscreen) return
    this.state.set({ ...state, rightbar: { shown, track, fullscreen } })
  }
}

/** Applies public theme values and restores only the DOM values this adapter still owns. */
export class EmbeddedThemePresentation {
  private writes = new Map<string, { original: string | null; value: string | null; read(): string | null; write(value: string | null): void }>()
  private tokens = new Set<string>()
  private backgrounds?: Array<{ style: CSSStyleDeclaration; property: string; original: string; priority: string; value: string }>

  constructor(private readonly document: Document) {}

  apply(snapshot: ThemeSnapshot): void {
    const { documentElement: html, body } = this.document
    const scheme = snapshot.active.colorScheme
    this.style('scheme', html.style, 'color-scheme', scheme)
    this.attribute('source', html, 'data-ds-theme-source', snapshot.preference === 'system' ? 'system' : scheme)
    this.attribute('dark', body, 'data-ds-dark-theme', scheme === 'dark' ? '' : null)
    for (const role of ['text', 'code', 'terminal'] as const) {
      this.style(`size:${role}`, body.style, role === 'text' ? '--dsh-content-font-size' : `--dsh-${role}-font-size`, `${snapshot.fontSizes[role]}px`)
      this.style(`font:${role}`, body.style, `--dsh-font-family-${role}`, snapshot.fontFamilies[role] || null)
    }
    const next = new Set(Object.keys(snapshot.active.tokens))
    for (const name of this.tokens) if (!next.has(name)) this.restore(`token:${name}`)
    for (const [name, value] of Object.entries(snapshot.active.tokens)) this.style(`token:${name}`, body.style, name, value)
    this.tokens = next
  }

  /** Let the remote native modal's own mask cover the parent page, without a second canvas. */
  settings(active: boolean): void {
    if (!active) {
      for (const entry of this.backgrounds ?? []) {
        if (entry.style.getPropertyValue(entry.property) !== entry.value || entry.style.getPropertyPriority(entry.property) !== '') continue
        if (entry.original) entry.style.setProperty(entry.property, entry.original, entry.priority)
        else entry.style.removeProperty(entry.property)
      }
      this.backgrounds = undefined
      return
    }
    if (this.backgrounds) return
    this.backgrounds = [this.document.documentElement, this.document.body].flatMap(element =>
      [['background-color', 'transparent'], ['background-image', 'none']].map(([property, value]) => {
        const { style } = element
        const original = style.getPropertyValue(property), priority = style.getPropertyPriority(property)
        style.setProperty(property, value)
        return { style, property, original, priority, value: style.getPropertyValue(property) }
      }))
  }

  dispose(): void { this.settings(false); for (const key of [...this.writes.keys()]) this.restore(key); this.tokens.clear() }

  private style(key: string, style: CSSStyleDeclaration, property: string, value: string | null): void {
    this.set(key, () => style.getPropertyValue(property) || null, value => {
      if (value === null) style.removeProperty(property)
      else style.setProperty(property, value)
    }, value)
  }

  private attribute(key: string, element: HTMLElement, name: string, value: string | null): void {
    this.set(key, () => element.getAttribute(name), value => {
      if (value === null) element.removeAttribute(name)
      else element.setAttribute(name, value)
    }, value)
  }

  private set(key: string, read: () => string | null, write: (value: string | null) => void, value: string | null): void {
    const previous = this.writes.get(key)
    this.writes.set(key, { original: previous === undefined ? read() : previous.original, value, read, write })
    write(value)
  }

  private restore(key: string): void {
    const entry = this.writes.get(key)
    if (entry && entry.read() === entry.value) entry.write(entry.original)
    this.writes.delete(key)
  }
}

type FrameSlots = 'sidebar' | 'main' | 'rightbar' | 'shell.bottom' | 'shell.overlay' | 'shell.leading'
interface EmbeddedInjected {
  hooks: { embeddedLayout: HostObservable<EmbeddedLayoutState> }
  measure(width: number): void
  resize(width: number): void
  resizeLabel: string
}
type FrameProps = PropsRuntime<'root'> & PropsRenderSlots<FrameSlots> & InjectFace<EmbeddedInjected>

function EmbeddedFrame({ useEmbeddedLayout, renderSlot, measure, resize, resizeLabel }: FrameProps) {
  const state = useEmbeddedLayout(value => value)
  const frame = useRef<HTMLDivElement>(null)
  const dragging = useRef<{ pointer: number; element: HTMLElement; origin: number; width: number }>()
  const columns = embeddedColumns(state.viewport, state.preferredWidth)
  const conversation = !state.settings && state.panelInfo.activePanelId === null
  const track = conversation && state.rightbar.track ? columns.rightbar : 0
  const resizeVisible = conversation && state.rightbar.shown && !state.rightbar.fullscreen && columns.canShow

  useLayoutEffect(() => {
    const element = frame.current
    if (!element) return
    const update = () => measure(element.getBoundingClientRect().width)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      observer.disconnect()
      const active = dragging.current
      if (active?.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer)
      dragging.current = undefined
    }
  }, [measure])

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current?.pointer !== event.pointerId) return
    dragging.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return <div ref={frame} className="dc-embedded-layout" data-settings={state.settings || undefined} style={{ gridTemplateColumns: `minmax(0,1fr) ${track}px` } as CSSProperties}>
    <style>{embeddedStyles}</style>
    {state.settings ? <div hidden>{renderSlot('sidebar', { collapsed: true, width: 56 })}</div> : <>
      <div className="dc-embedded-main">{renderSlot('main', {}, { entryKey: state.panelInfo.activePanelId ?? 'conversation' })}</div>
      <div className="dc-embedded-right" data-rightbar-col>{renderSlot('rightbar', { width: columns.rightbar, viewportWidth: columns.viewport, canShow: columns.canShow })}</div>
      <div className="dc-embedded-bottom" data-shell-bottom>{renderSlot('shell.bottom', {})}</div>
    </>}
    <div className="dc-embedded-leading" data-shell-leading>{renderSlot('shell.leading', {})}</div>
    <div className="dc-embedded-overlays" data-shell-overlay>{renderSlot('shell.overlay', {})}</div>
    {resizeVisible && <div className="dc-embedded-resize" role="separator" tabIndex={0} aria-orientation="vertical" aria-label={resizeLabel}
      aria-valuemin={300} aria-valuemax={Math.floor(Math.min(columns.viewport * 0.7, columns.viewport - 400))} aria-valuenow={Math.round(columns.rightbar)}
      style={{ right: columns.rightbar - 4 }}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        dragging.current = { pointer: event.pointerId, element: event.currentTarget, origin: event.clientX, width: columns.rightbar }
      }}
      onPointerMove={event => {
        const active = dragging.current
        if (active?.pointer === event.pointerId) resize(active.width + active.origin - event.clientX)
      }}
      onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={() => { dragging.current = undefined }}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        resize(event.key === 'Home' ? 300 : event.key === 'End' ? columns.viewport : columns.rightbar + (event.key === 'ArrowLeft' ? 20 : -20))
      }} />}
  </div>
}

export interface EmbeddedLayoutOptions {
  /** Without an authenticated owner callback navigation is explicitly unsupported;
   * this adapter deliberately registers no local sidebar keyboard/menu command. */
  onToggleSidebar?: () => void
  resizeLabel?: string
  document?: Document
}

/** Install after disabling native ui-layout in the dedicated profile; never rewrite the boot graph. */
export function applyEmbeddedLayout(ctx: Context, options: EmbeddedLayoutOptions = {}): EmbeddedLayoutController {
  if (ctx.get('layout') !== undefined || ctx.slots.entries('root').length > 0) {
    throw new Error('connections: embedded layout requires a dedicated profile with native ui-layout disabled')
  }
  const document = options.document ?? globalThis.document
  const layout = new EmbeddedLayoutController(id => ctx.slots.entries('main').some(entry => entry.options.key === id), options.onToggleSidebar, document.documentElement.clientWidth)
  ctx.effect(() => ctx.reflect.provide('layout', layout))
  ctx.effect(() => () => layout.dispose())
  ctx.slots.provideRoot({ hooks: { panelInfo: layout.panelInfo } })
  ctx.slots.register({
    name: 'root',
    children: {
      sidebar: { kind: 'single', scope: 'root' },
      main: { kind: 'keyed', scope: 'root' },
      rightbar: { kind: 'single', scope: 'root' },
      'shell.bottom': { kind: 'single', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'shell.leading': { kind: 'single', scope: 'root' },
    },
    inject: (): EmbeddedInjected => ({ hooks: { embeddedLayout: layout.state }, measure: layout.measure, resize: layout.resize, resizeLabel: options.resizeLabel ?? 'Resize files panel' }),
  }, EmbeddedFrame)
  const theme = new EmbeddedThemePresentation(document)
  theme.apply(ctx.theme.getTheme())
  ctx.on('theme/change', snapshot => theme.apply(snapshot))
  ctx.effect(() => {
    const sync = () => theme.settings(layout.state.getSnapshot().settings)
    sync()
    const off = layout.state.subscribe(sync)
    return () => { off(); theme.dispose() }
  })
  return layout
}

const embeddedStyles = `
.dc-embedded-layout{position:relative;display:grid;grid-template-rows:minmax(0,1fr) auto;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dc-embedded-layout[data-settings]{background:transparent}
.dc-embedded-main{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.dc-embedded-right{position:relative;min-width:0;min-height:0;overflow:visible}
.dc-embedded-bottom{grid-column:1/-1;min-width:0;min-height:0;overflow:auto}
.dc-embedded-leading{position:absolute;inset-block-start:0;inset-inline-start:0;z-index:40;pointer-events:none}.dc-embedded-leading>*{pointer-events:auto}
.dc-embedded-overlays{position:absolute;inset:0;z-index:50;pointer-events:none}.dc-embedded-overlays>*{pointer-events:auto}
.dc-embedded-settings-launcher{position:absolute;inset:0;display:grid;place-items:center}
.dc-embedded-settings-launcher button{padding:8px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;cursor:pointer}
.dc-embedded-resize{position:absolute;top:0;bottom:0;width:8px;z-index:10;cursor:col-resize;touch-action:none}.dc-embedded-resize:hover,.dc-embedded-resize:focus-visible{background:var(--dsw-alias-bg-layer-2)}.dc-embedded-resize:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
`
