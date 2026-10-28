import { createElement, useEffect, useSyncExternalStore } from 'react'
import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { DirectoryFlowOwnerProps, UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { HostObservable, PropsRenderSlots, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import {
  WORKSPACE_ENDPOINT, WORKSPACE_RESPONSE_LIMIT, parseWorkspaceChannel, parseWorkspaceResponse,
  type WorkspaceNavigationError, type WorkspaceRequest, type WorkspaceViewIntent, type WorkspaceViewState,
} from '../shared/workspace-protocol.js'
import { applyEmbeddedLayout } from './embedded-layout.js'
import { applyEmbeddedSettings, createEmbeddedSettingsHosts, type EmbeddedSettingsAdapter } from './embedded-settings.js'
import { installSettingsHostHeader } from './settings-host-menu.js'
import { createSettingsHostClient } from './settings-host-bridge.js'
import { createSettingsHostRelayClient, type SettingsHostEndpoint } from './settings-host-relay.js'

const en = {
  missing: 'Open this remote workspace from Connections on your computer.',
  waiting: 'Opening remote workspace…',
  disconnected: 'Connection interrupted. Reconnecting…',
  expired: 'This workspace view has closed. Open it again from Connections.',
  failed: 'Unable to open this workspace. Select it again from Connections to retry.',
  pickerUnavailable: 'The remote directory picker is unavailable.',
  cancel: 'Cancel', resize: 'Resize files panel',
  openSettings: 'Open settings',
  settingsUnavailable: 'Settings are unavailable on this Host. Enable its native Settings plugin to continue.',
  pluginsUnavailable: 'Plugin management is unavailable on this Host. Enable its native Plugin Manager to continue.',
} as const
const zh: Record<keyof typeof en, string> = {
  missing: '请从这台电脑的「连接」中打开远端工作区。', waiting: '正在打开远端工作区…',
  disconnected: '连接已中断，正在重新连接…', expired: '此工作区视图已关闭，请从「连接」中重新打开。',
  failed: '无法打开此工作区，请从「连接」中再次选择以重试。', pickerUnavailable: '远端目录选择器不可用。',
  cancel: '取消', resize: '调整文件栏宽度',
  openSettings: '打开设置',
  settingsUnavailable: '此 Host 的设置暂不可用，请启用其原生设置插件后继续。',
  pluginsUnavailable: '此 Host 的插件管理暂不可用，请启用其原生插件管理器后继续。',
}
type Message = keyof typeof en
type Translate = (key: Message) => string
type PickerSlot = 'connections.embedded.directoryFlow'
type EmbeddedRequest = Extract<WorkspaceRequest, { op: 'pollView' | 'reportView' }>
type Report = Extract<EmbeddedRequest, { op: 'reportView' }>
export type EmbeddedEndpoint = (request: EmbeddedRequest, signal: AbortSignal) => Promise<WorkspaceViewState>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'connections.embedded': Message }
  interface SlotMap {
    'connections.embedded.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
  }
}

/** A fragment is a view capability, never a remote URL or an instruction payload. */
export function embeddedChannel(hash: string): string | undefined {
  try {
    const values = new URLSearchParams(hash.replace(/^#/, '')).getAll('connections-view')
    return values.length === 1 ? parseWorkspaceChannel(values[0]) : undefined
  } catch { return undefined }
}

export function embeddedEndpoint(document: Pick<Document, 'baseURI'>, request: typeof fetch = fetch): SettingsHostEndpoint {
  const endpoint = new URL(WORKSPACE_ENDPOINT, document.baseURI)
  return async <R extends WorkspaceRequest>(body: R, signal: AbortSignal) => {
    const response = await request(endpoint, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const text = await response.text()
    if (text.length > WORKSPACE_RESPONSE_LIMIT) throw new Error('Invalid workspace response')
    const result = parseWorkspaceResponse<R['op']>(body.op, JSON.parse(text))
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    if (!response.ok) throw new Error('Workspace request failed')
    return result.value
  }
}

interface EmbeddedState {
  readonly message?: 'waiting' | 'disconnected' | 'expired' | 'failed' | 'pluginsUnavailable'
  readonly picker?: { readonly generation: number; readonly busy: boolean; readonly newSession?: true }
  readonly settings?: { readonly generation: number }
}

function waitFor<T>(source: HostObservable<T>, ready: (value: T) => boolean, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {}
    const finish = (error?: unknown) => {
      unsubscribe()
      signal.removeEventListener('abort', aborted)
      clearTimeout(timer)
      if (error !== undefined) reject(error)
      else resolve(source.getSnapshot())
    }
    const aborted = () => finish(signal.reason ?? new Error('Navigation cancelled'))
    const check = () => { if (ready(source.getSnapshot())) finish() }
    const timer = setTimeout(() => finish(new Error('Native workspace state unavailable')), 30_000)
    unsubscribe = source.subscribe(check)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    else check()
  })
}

function delay(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, 1000)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}

/** Coordinates selection only; all conversation, session and directory behavior stays native. */
export class EmbeddedViewController {
  private readonly lifetime = new AbortController()
  private operation = new AbortController()
  private generation = 0
  private revision = 0
  private received = false
  private applying = false
  private queuedReport?: Report
  private reporting = false
  private presentedGeneration?: number
  private unsubscribe?: () => void

  constructor(
    private readonly ctx: Context,
    private readonly channel: string,
    private readonly endpoint: EmbeddedEndpoint,
    readonly state = createSnapshotStore<EmbeddedState>({ message: 'waiting' }),
    private readonly settings?: EmbeddedSettingsAdapter,
  ) {}

  start(): void {
    if (this.unsubscribe || this.lifetime.signal.aborted) return
    const changed = () => {
      if (this.received && !this.applying && !this.state.getSnapshot().picker && !this.state.getSnapshot().settings) this.report()
    }
    const offSession = this.ctx.uiSession.adapter.current.subscribe(changed)
    // Native Plugin Manager can open a conversation itself. Its panel transition
    // commits after session selection and makes that destination reportable.
    const offPanel = this.ctx.layout.panelInfo.subscribe(changed)
    this.unsubscribe = () => { offSession(); offPanel() }
    void this.poll()
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) return
    this.lifetime.abort()
    this.operation.abort()
    this.settings?.close()
    this.ctx.layout.beginNavigation()
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.queuedReport = undefined
  }

  pickerOwner(generation: number): DirectoryFlowOwnerProps {
    const current = () => this.active(generation) && this.state.getSnapshot().picker?.generation === generation
    return {
      open: current(),
      busy: this.state.getSnapshot().picker?.busy ?? false,
      onPicked: path => { void this.picked(generation, path) },
      onCancel: () => {
        if (!current() || this.state.getSnapshot().picker?.busy) return
        this.state.set({})
        this.applying = false
        this.report('PICK_CANCELLED')
      },
      onError: () => { if (current()) this.failed(generation) },
    }
  }

  /** Called after the delegated native picker commits, not when its intent arrives. */
  pickerPresented(generation: number): void {
    if (!this.active(generation) || this.state.getSnapshot().picker?.generation !== generation
      || this.presentedGeneration === generation) return
    this.presentedGeneration = generation
    this.queuedReport = { op: 'reportView', channel: this.channel, revision: this.revision, presented: true }
    if (!this.reporting) void this.flushReports()
  }

  settingsClosed(): void {
    const settings = this.state.getSnapshot().settings
    if (settings && this.active(settings.generation)) this.report('SETTINGS_CLOSED')
  }

  private active(generation: number): boolean {
    return !this.lifetime.signal.aborted && !this.operation.signal.aborted && generation === this.generation
  }

  private begin(): number {
    this.operation.abort()
    this.settings?.close()
    this.operation = new AbortController()
    this.ctx.layout.beginNavigation()
    this.applying = true
    this.state.set({})
    return ++this.generation
  }

  private async poll(): Promise<void> {
    while (!this.lifetime.signal.aborted) {
      try {
        const state = await this.endpoint({ op: 'pollView', channel: this.channel, afterRevision: this.revision }, this.lifetime.signal)
        if (this.lifetime.signal.aborted) return
        const initial = !this.received
        this.received = true
        const changed = state.revision > this.revision
        this.revision = Math.max(this.revision, state.revision)
        if ((initial || changed) && state.intent && state.intent.revision > state.reportedRevision) {
          const generation = this.begin()
          void this.navigate(state.intent, generation)
        } else if (initial && state.intent?.target.kind === 'plugins' && !state.error) {
          // This fixed panel is safe to restore; no install operation is replayed.
          const generation = this.begin()
          void this.navigate(state.intent, generation)
        } else if (initial && state.sessionId) {
          // Restore the acknowledged selection, never replay an acknowledged directory picker.
          const generation = this.begin()
          void this.navigate({ revision: state.revision, requestId: 'restore', target: { kind: 'session', id: state.sessionId } }, generation)
        } else if (this.state.getSnapshot().message === 'disconnected') {
          this.state.set({ ...this.state.getSnapshot(), message: undefined })
        }
      } catch (error) {
        if (this.lifetime.signal.aborted) return
        if (error && typeof error === 'object' && 'code' in error && error.code === 'NOT_FOUND') {
          this.dispose()
          this.state.set({ message: 'expired' })
          return
        }
        this.state.set({ ...this.state.getSnapshot(), message: 'disconnected' })
        await delay(this.lifetime.signal)
      }
    }
  }

  private async ready(generation: number): Promise<boolean> {
    await Promise.all([
      waitFor(this.ctx.workspaces.list, value => value.phase === 'ready', this.operation.signal),
      waitFor(this.ctx.sessions.list, value => value.phase === 'ready', this.operation.signal),
    ])
    return this.active(generation)
  }

  private async navigate(intent: WorkspaceViewIntent, generation: number): Promise<void> {
    try {
      if (!await this.ready(generation)) return
      if (intent.target.kind === 'settings') {
        if (!this.settings) throw new Error('Native settings are unavailable')
        this.state.set({ settings: { generation } })
        await this.settings.open(this.operation.signal)
        if (!this.active(generation)) return
        this.applying = false
        this.report()
        return
      }
      if (intent.target.kind === 'pick') {
        this.state.set({ picker: { generation, busy: false } })
        return
      }
      if (intent.target.kind === 'newSession' && intent.target.id === undefined
        && this.ctx.workspaces.list.getSnapshot().items.length === 0) {
        this.state.set({ picker: { generation, busy: false, newSession: true } })
        return
      }
      if (intent.target.kind === 'session') {
        const id = intent.target.id
        this.ctx.uiWorkspace.openSession(id as Parameters<UiWorkspace['openSession']>[0])
        await waitFor(this.ctx.uiSession.adapter.current, value => value.key === id, this.operation.signal)
      } else if (intent.target.kind === 'newSession') {
        await this.startSession(intent.target.id)
      } else if (intent.target.kind === 'workspace') {
        await this.openWorkspace(intent.target.id, generation)
      } else if (intent.target.kind === 'plugins') {
        this.ctx.layout.selectPanel('plugins' as MainPanelId)
        await waitFor(this.ctx.layout.panelInfo, value => value.activePanelId === 'plugins', this.operation.signal)
      } else {
        throw new Error('Native navigation target is unavailable')
      }
      if (!this.active(generation)) return
      this.applying = false
      this.state.set({})
      this.report()
    } catch { this.failed(generation, intent.target.kind === 'plugins' ? 'pluginsUnavailable' : 'failed') }
  }

  private async openWorkspace(id: string, generation: number): Promise<void> {
    let selected: string | undefined
    await this.ctx.uiWorkspace.openWorkspace(id as Parameters<UiWorkspace['openWorkspace']>[0], sessionId => { selected = sessionId })
    if (!this.active(generation)) return
    if (selected !== undefined) await waitFor(this.ctx.uiSession.adapter.current, value => value.key === selected, this.operation.signal)
  }

  private async startSession(id: string | undefined): Promise<void> {
    if (id !== undefined && !this.ctx.workspaces.list.getSnapshot().items.some(workspace => workspace.workspaceId === id)) {
      throw new Error('Native workspace is unavailable')
    }
    // The native void command may reuse the currently selected blank Session.
    // Its final selectPanel(null), emitted by our layout adapter even for the
    // same panel, acknowledges completion without mistaking the old selection
    // for a successful pending creation.
    let selected = false
    const panel = this.ctx.layout.panelInfo
    const waiting = new AbortController()
    const completion = waitFor({ getSnapshot: panel.getSnapshot, subscribe: listener => panel.subscribe(() => { selected = true; listener() }) },
      value => selected && value.activePanelId === null && this.ctx.uiSession.adapter.current.getSnapshot().key !== undefined,
      AbortSignal.any([this.operation.signal, waiting.signal]))
    try {
      await Promise.all([completion, Promise.resolve().then(() => this.ctx.uiWorkspace.startSession(id as Parameters<UiWorkspace['startSession']>[0]))])
    } finally { waiting.abort() }
  }

  private async picked(generation: number, path: string): Promise<void> {
    const picker = this.state.getSnapshot().picker
    if (!this.active(generation) || picker?.generation !== generation || picker.busy) return
    this.state.set({ picker: { ...picker, busy: true } })
    try {
      const workspace = await this.ctx.workspaces.create({ path })
      if (!this.active(generation)) return
      if (picker.newSession) await this.startSession(workspace.workspaceId)
      else await this.openWorkspace(workspace.workspaceId, generation)
      if (!this.active(generation)) return
      this.applying = false
      this.state.set({})
      this.report()
    } catch { this.failed(generation) }
  }

  private failed(generation: number, message: 'failed' | 'pluginsUnavailable' = 'failed'): void {
    if (!this.active(generation)) return
    this.applying = false
    this.state.set({ message })
    this.report('NAVIGATION_FAILED')
  }

  private report(error?: WorkspaceNavigationError): void {
    if (this.lifetime.signal.aborted || this.revision === 0) return
    const sessionId = this.state.getSnapshot().settings || this.ctx.layout.panelInfo.getSnapshot().activePanelId === 'plugins'
      ? undefined : this.ctx.uiSession.adapter.current.getSnapshot().key
    this.queuedReport = {
      op: 'reportView', channel: this.channel, revision: this.revision,
      ...(sessionId === undefined ? {} : { sessionId }), ...(error === undefined ? {} : { error }),
    }
    if (!this.reporting) void this.flushReports()
  }

  private async flushReports(): Promise<void> {
    this.reporting = true
    try {
      while (this.queuedReport && !this.lifetime.signal.aborted) {
        const report = this.queuedReport
        this.queuedReport = undefined
        if (report.revision !== this.revision) continue
        try { await this.endpoint(report, this.lifetime.signal) }
        catch {
          if (!this.queuedReport && report.revision === this.revision) this.queuedReport = report
          await delay(this.lifetime.signal)
        }
      }
    } finally { this.reporting = false }
  }
}

/** Synchronously provides layout so the remaining native UI plugins can activate. */
export function applyEmbedded(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('connections.embedded', { en, zh }))
  const t = ctx.locale.bind('connections.embedded') as Translate
  const layout = applyEmbeddedLayout(ctx, { resizeLabel: t('resize') })
  const channel = embeddedChannel(window.location.hash)
  const statusPanel = 'connections.embedded.status' as MainPanelId
  const initial = createSnapshotStore<EmbeddedState>({ message: 'waiting' })
  const Status = () => {
    const state = useSyncExternalStore(initial.subscribe, initial.getSnapshot)
    return <div className="dc-embedded-status"><p role="status">{t(channel === undefined ? 'missing' : state.message ?? 'waiting')}</p></div>
  }
  ctx.slots.register({ name: 'main', key: statusPanel, locale: 'connections.embedded' }, Status)
  layout.selectPanel(statusPanel)
  ctx.slots.register({ name: 'shell.overlay', id: 'connections.embedded.style' }, () => <style>{embeddedCss}</style>)
  if (channel === undefined) return

  ctx.inject(['uiWorkspace', 'uiSession', 'sessions', 'workspaces'], ctx => {
    const settings = applyEmbeddedSettings(ctx, layout, {
      onClosed: () => view.settingsClosed(), onLocalGeneral: () => hosts.select('local'),
      label: t('openSettings'), unavailableLabel: t('settingsUnavailable'),
    })
    const endpoint = embeddedEndpoint(document)
    const hosts = createEmbeddedSettingsHosts(settings.state, channel, channel => window.parent === window
      ? createSettingsHostRelayClient(channel, endpoint) : createSettingsHostClient(channel))
    ctx.effect(() => () => hosts.dispose())
    installSettingsHostHeader(ctx, hosts)
    const view = new EmbeddedViewController(ctx, channel, endpoint, initial, settings)
    const Overlay = ({ renderSlot }: PropsRenderSlots<PickerSlot>) => {
      const state = useSyncExternalStore(view.state.subscribe, view.state.getSnapshot)
      const picker = state.picker
      const owner = picker === undefined ? undefined : view.pickerOwner(picker.generation)
      return <>
        {state.message && state.message !== 'waiting' && <div className="dc-embedded-notice" role="status">{t(state.message)}</div>}
        {owner && renderSlot('connections.embedded.directoryFlow', owner, { fallback: <div className="dc-embedded-picker-fallback" role="alert">
          <p>{t('pickerUnavailable')}</p><button onClick={owner.onCancel}>{t('cancel')}</button>
        </div> })}
      </>
    }
    ctx.slots.register({ name: 'shell.overlay', id: 'connections.embedded.navigation', locale: 'connections.embedded',
      children: { 'connections.embedded.directoryFlow': { kind: 'single', scope: 'root' } },
    }, Overlay)
    // Directory flows are public leaf occupants; preserve their native inject/store/locale seats.
    ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => {
      let delegated: StoredEntry | undefined
      let remove: (() => void) | undefined
      const sync = () => {
        const entry = ctx.slots.entries('conversation.hero.workspace.directoryFlow')[0]
        if (entry === delegated) return
        remove?.(); remove = undefined; delegated = entry
        if (!entry || (entry.children && Object.keys(entry.children).length > 0)) return
        const NativePicker = entry.component as ComponentType<DirectoryFlowOwnerProps>
        const PresentedPicker = (props: DirectoryFlowOwnerProps) => {
          const picker = useSyncExternalStore(view.state.subscribe, view.state.getSnapshot).picker
          useEffect(() => {
            if (props.open && picker) view.pickerPresented(picker.generation)
          }, [props.open, picker?.generation])
          return createElement(NativePicker, props)
        }
        remove = ctx.slots.register({ name: 'connections.embedded.directoryFlow', inject: entry.inject, store: entry.store, locale: entry.locale } as never, PresentedPicker as never)
      }
      const off = ctx.slots.subscribe('conversation.hero.workspace.directoryFlow', sync)
      sync()
      return () => { off(); remove?.() }
    })
    ctx.effect(() => {
      view.start()
      return () => view.dispose()
    })
  })
}

const embeddedCss = `
.dc-embedded-status{display:grid;place-items:center;flex:1;min-height:0;padding:32px;text-align:center;color:var(--dsw-alias-label-secondary);font:inherit}
.dc-embedded-notice{position:absolute;top:12px;left:50%;transform:translateX(-50%);max-width:calc(100% - 40px);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:13px}
.dc-embedded-picker-fallback{position:absolute;inset:0;display:grid;place-content:center;gap:12px;text-align:center;padding:24px;background:var(--dsw-alias-bg-base)}
.dc-embedded-picker-fallback button{justify-self:center;padding:6px 16px;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font:inherit;cursor:pointer}
`
