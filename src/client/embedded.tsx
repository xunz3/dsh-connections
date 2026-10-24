import { useSyncExternalStore } from 'react'
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

const en = {
  missing: 'Open this remote workspace from Connections on your computer.',
  waiting: 'Opening remote workspace…',
  disconnected: 'Connection interrupted. Reconnecting…',
  expired: 'This workspace view has closed. Open it again from Connections.',
  failed: 'Unable to open this workspace. Select it again from Connections to retry.',
  pickerUnavailable: 'The remote directory picker is unavailable.',
  cancel: 'Cancel', resize: 'Resize files panel',
} as const
const zh: Record<keyof typeof en, string> = {
  missing: '请从这台电脑的「连接」中打开远端工作区。', waiting: '正在打开远端工作区…',
  disconnected: '连接已中断，正在重新连接…', expired: '此工作区视图已关闭，请从「连接」中重新打开。',
  failed: '无法打开此工作区，请从「连接」中再次选择以重试。', pickerUnavailable: '远端目录选择器不可用。',
  cancel: '取消', resize: '调整文件栏宽度',
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

export function embeddedEndpoint(document: Pick<Document, 'baseURI'>, request: typeof fetch = fetch): EmbeddedEndpoint {
  const endpoint = new URL(WORKSPACE_ENDPOINT, document.baseURI)
  return async (body, signal) => {
    const response = await request(endpoint, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const text = await response.text()
    if (text.length > WORKSPACE_RESPONSE_LIMIT) throw new Error('Invalid workspace response')
    const result = parseWorkspaceResponse(body.op, JSON.parse(text))
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    if (!response.ok) throw new Error('Workspace request failed')
    return result.value
  }
}

interface EmbeddedState {
  readonly message?: 'waiting' | 'disconnected' | 'expired' | 'failed'
  readonly picker?: { readonly generation: number; readonly busy: boolean }
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
  private unsubscribe?: () => void

  constructor(
    private readonly ctx: Context,
    private readonly channel: string,
    private readonly endpoint: EmbeddedEndpoint,
    readonly state = createSnapshotStore<EmbeddedState>({ message: 'waiting' }),
  ) {}

  start(): void {
    if (this.unsubscribe || this.lifetime.signal.aborted) return
    this.unsubscribe = this.ctx.uiSession.adapter.current.subscribe(() => {
      if (this.received && !this.applying && !this.state.getSnapshot().picker) this.report()
    })
    void this.poll()
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) return
    this.lifetime.abort()
    this.operation.abort()
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

  private active(generation: number): boolean {
    return !this.lifetime.signal.aborted && !this.operation.signal.aborted && generation === this.generation
  }

  private begin(): number {
    this.operation.abort()
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
      if (intent.target.kind === 'pick') {
        this.state.set({ picker: { generation, busy: false } })
        return
      }
      if (intent.target.kind === 'session') {
        const id = intent.target.id
        this.ctx.uiWorkspace.openSession(id as Parameters<UiWorkspace['openSession']>[0])
        await waitFor(this.ctx.uiSession.adapter.current, value => value.key === id, this.operation.signal)
      } else {
        await this.openWorkspace(intent.target.id, generation)
      }
      if (!this.active(generation)) return
      this.applying = false
      this.state.set({})
      this.report()
    } catch { this.failed(generation) }
  }

  private async openWorkspace(id: string, generation: number): Promise<void> {
    let selected: string | undefined
    await this.ctx.uiWorkspace.openWorkspace(id as Parameters<UiWorkspace['openWorkspace']>[0], sessionId => { selected = sessionId })
    if (!this.active(generation)) return
    if (selected !== undefined) await waitFor(this.ctx.uiSession.adapter.current, value => value.key === selected, this.operation.signal)
  }

  private async picked(generation: number, path: string): Promise<void> {
    const picker = this.state.getSnapshot().picker
    if (!this.active(generation) || picker?.generation !== generation || picker.busy) return
    this.state.set({ picker: { generation, busy: true } })
    try {
      const workspace = await this.ctx.workspaces.create({ path })
      if (!this.active(generation)) return
      await this.openWorkspace(workspace.workspaceId, generation)
      if (!this.active(generation)) return
      this.applying = false
      this.state.set({})
      this.report()
    } catch { this.failed(generation) }
  }

  private failed(generation: number): void {
    if (!this.active(generation)) return
    this.applying = false
    this.state.set({ message: 'failed' })
    this.report('NAVIGATION_FAILED')
  }

  private report(error?: WorkspaceNavigationError): void {
    if (this.lifetime.signal.aborted || this.revision === 0) return
    const sessionId = this.ctx.uiSession.adapter.current.getSnapshot().key
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
    const view = new EmbeddedViewController(ctx, channel, embeddedEndpoint(document), initial)
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
        remove = ctx.slots.register({ name: 'connections.embedded.directoryFlow', inject: entry.inject, store: entry.store, locale: entry.locale } as never, entry.component as never)
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
