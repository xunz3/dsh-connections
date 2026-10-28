import { useEffect, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable, PropsRenderSlots, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { EmbeddedLayoutController } from './embedded-layout.js'
import { settingsShell, type NativeSettingsShell } from './native-settings.js'
import { createSettingsHostClient, type SettingsHostSnapshot } from './settings-host-bridge.js'

export interface EmbeddedSettingsAdapter {
  open(signal: AbortSignal): Promise<void>
  close(): void
}

/** Keep the menu bridge for this settings operation, including native onboarding between dialog mounts. */
export function createEmbeddedSettingsHosts(
  state: HostObservable<{ active: boolean; generation?: number }>, channel: string,
  create = createSettingsHostClient,
): ReturnType<typeof createSettingsHostClient> {
  const snapshot = createSnapshotStore<SettingsHostSnapshot | undefined>(undefined)
  let client: ReturnType<typeof createSettingsHostClient> | undefined
  let unsubscribe = () => {}
  let generation: number | undefined
  let pendingSelection: string | undefined
  const stop = () => { unsubscribe(); unsubscribe = () => {}; client?.dispose(); client = undefined; pendingSelection = undefined; snapshot.set(undefined) }
  const sync = () => {
    const current = state.getSnapshot()
    if (!current.active) { stop(); generation = undefined; return }
    if (client && generation === current.generation) return
    stop()
    generation = current.generation
    client = create(channel)
    const active = client
    const update = () => {
      if (client !== active) return
      const value = active.getSnapshot()
      snapshot.set(value)
      if (value && pendingSelection !== undefined) {
        const id = pendingSelection
        pendingSelection = undefined
        if (value.choices.some(row => row.id === id)) active.select(id)
      }
    }
    unsubscribe = active.subscribe(update)
    update()
  }
  const off = state.subscribe(sync)
  sync()
  return {
    getSnapshot: snapshot.getSnapshot, subscribe: snapshot.subscribe,
    select: id => {
      if (!client) return
      if (client.getSnapshot() === undefined) pendingSelection = id
      else client.select(id)
    },
    dispose: () => { off(); stop() },
  }
}

interface SettingsOperation {
  mounted: boolean
  presented: boolean
  confirmed: boolean
  returningLocal?: boolean
  shell?: NativeSettingsShell
  openedShell?: NativeSettingsShell
  resolve(): void
  reject(error: Error): void
  dispose(): void
}

/** A dedicated document drives the original root store; native slots keep every form and write path. */
export class EmbeddedSettingsController implements EmbeddedSettingsAdapter {
  readonly state = createSnapshotStore<{ active: boolean; open: boolean; available: boolean; generation?: number; returningLocal?: boolean }>({ active: false, open: false, available: false })
  private operation?: SettingsOperation
  private generation = 0

  constructor(private readonly ctx: Context, private readonly layout: Pick<EmbeddedLayoutController, 'showSettings'>,
    private readonly onClosed: () => void, private readonly onLocalGeneral: () => void = () => {}) {}

  open(signal: AbortSignal): Promise<void> {
    this.close()
    return new Promise((resolve, reject) => {
      let unsubscribeShell = () => {}
      let observeShell = () => {}
      const operation: SettingsOperation = {
        mounted: false, presented: false, confirmed: false, resolve: () => { clearTimeout(timer); resolve() }, reject,
        dispose: () => { clearTimeout(timer); unsubscribeSlot(); unsubscribeSections(); unsubscribeShell(); signal.removeEventListener('abort', aborted) },
      }
      const aborted = () => { if (this.operation === operation) this.close() }
      const sync = () => {
        if (this.operation !== operation) return
        const shell = settingsShell(this.ctx)
        if (shell !== operation.shell) {
          unsubscribeShell()
          operation.shell?.actions.close()
          operation.shell = shell
          operation.openedShell = undefined
          operation.confirmed = false
          this.state.set({ ...this.state.getSnapshot(), open: shell?.getSnapshot().open ?? false, available: shell !== undefined })
          observeShell = () => {
            if (this.operation !== operation || !shell) return
            const { open, activeId } = shell.getSnapshot()
            const sections = [...this.ctx.slots.entries('settings.section')].sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))
            const activeSection = sections.some(row => row.options.id === activeId) ? activeId : sections[0]?.options.id
            if (open && (activeSection === 'general' || activeId === 'general' || operation.returningLocal)) {
              const requested = operation.returningLocal
              operation.returningLocal = true
              operation.confirmed = false
              this.state.set({ ...this.state.getSnapshot(), returningLocal: true })
              // Observe the native store synchronously, before React can commit remote General.
              // This is a handoff, so its close must not report SETTINGS_CLOSED.
              shell.actions.close()
              if (!requested) this.onLocalGeneral()
              return
            }
            this.state.set({ ...this.state.getSnapshot(), open })
            if (!open && operation.confirmed) { operation.confirmed = false; this.onClosed() }
          }
          unsubscribeShell = shell?.subscribe(observeShell) ?? (() => {})
        }
        this.present(operation)
      }
      const unsubscribeSlot = this.ctx.slots.subscribe('sidebar.settings', sync)
      // Native Settings falls back to its first section when the selected plugin is withdrawn.
      const unsubscribeSections = this.ctx.slots.subscribe('settings.section', () => {
        if (operation.openedShell) observeShell()
        this.present(operation)
      })
      const timer = setTimeout(() => {
        if (this.operation !== operation || operation.presented) return
        this.close()
      }, 30_000)
      this.operation = operation
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) { this.close(); return }
      this.state.set({ active: true, open: false, available: false, generation: ++this.generation })
      this.layout.showSettings(true)
      sync()
    })
  }

  /** The original sidebar has committed; its native onboarding is now operable too. */
  mounted(): void {
    const operation = this.operation
    if (!operation) return
    operation.mounted = true
    this.present(operation)
  }

  private present(operation: SettingsOperation): void {
    if (!operation.mounted || !operation.shell || operation.returningLocal || operation.openedShell === operation.shell) return
    // Feature factories arrive independently. Opening before Models registers
    // would let native Settings fall back to General and trigger a local handoff.
    if (!operation.presented && !this.ctx.slots.entries('settings.section').some(row => row.options.id === 'models')) return
    operation.openedShell = operation.shell
    operation.shell.actions.openSection('models')
    this.state.set({ ...this.state.getSnapshot(), open: operation.shell.getSnapshot().open })
    if (!operation.presented) { operation.presented = true; operation.resolve() }
  }

  /** Registered inside the native dialog. Startup onboarding can close it before this confirmation. */
  dialogCommitted(): void {
    const operation = this.operation
    const shell = operation?.shell
    queueMicrotask(() => {
      if (operation && this.operation === operation && operation.shell === shell && shell?.getSnapshot().open) operation.confirmed = true
    })
  }

  reopen(): void { if (!this.operation?.returningLocal) this.operation?.shell?.actions.openSection('models') }

  close(): void {
    const operation = this.operation
    this.operation = undefined
    operation?.dispose()
    operation?.shell?.actions.close()
    if (operation && !operation.presented) operation.reject(new Error('Native settings unavailable or navigation cancelled'))
    this.layout.showSettings(false)
    this.state.set({ active: false, open: false, available: false })
  }
}

/** Mounts the native sidebar in the frame; Settings keeps its original body portal and child declarations. */
export function applyEmbeddedSettings(ctx: Context, layout: EmbeddedLayoutController,
  options: { onClosed(): void; onLocalGeneral(): void; label: string; unavailableLabel: string }): EmbeddedSettingsController {
  const controller = new EmbeddedSettingsController(ctx, layout, options.onClosed, options.onLocalGeneral)
  installEmbeddedPermissionSettings(ctx)
  const Launcher = () => {
    const state = useSyncExternalStore(controller.state.subscribe, controller.state.getSnapshot)
    useEffect(() => { if (state.active) controller.mounted() }, [state.active, state.generation])
    return state.active && !state.open && !state.returningLocal ? <div className="dc-embedded-settings-launcher">
      {state.available ? <button type="button" onClick={() => controller.reopen()}>{options.label}</button>
        : <p role="status">{options.unavailableLabel}</p>}
    </div> : null
  }
  const Confirmation = () => { useEffect(() => { controller.dialogCommitted() }, []); return null }
  ctx.slots.register({ name: 'shell.overlay', id: 'connections.embedded.settings' }, Launcher)
  ctx.slots.inject('settings.action', () => ctx.slots.register({ name: 'settings.action', id: 'connections.embedded.settings-confirmed' }, Confirmation))
  ctx.effect(() => () => controller.close())
  return controller
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'connections.settings.permission': { kind: 'single'; scope: 'root'; owner: {} }
    'connections.settings.sessionLog': { kind: 'single'; scope: 'root'; owner: {} }
  }
}

/** Execution defaults and upload consent remain remote even though General belongs to Desktop. */
export function installEmbeddedPermissionSettings(ctx: Context): void {
  const rows = [
    { id: 'permission', slot: 'connections.settings.permission' },
    { id: 'session-log-deepseek', slot: 'connections.settings.sessionLog' },
  ] as const
  const PermissionSection = (props: PropsRenderSlots<typeof rows[number]['slot']>) => <>
    {props.renderSlot('connections.settings.permission', {})}
    {props.renderSlot('connections.settings.sessionLog', {})}
  </>
  ctx.slots.inject('settings.general.item', () => {
    let delegated: Array<StoredEntry | undefined> = []
    let remove: (() => void) | undefined
    let aliases: Array<() => void> = []
    const clear = () => { for (const off of aliases) off(); aliases = []; remove?.(); remove = undefined }
    const sync = () => {
      const available = ctx.slots.entriesOfSlot('settings.general.item')
      const entries = rows.map(row => available.find(entry => entry.options.id === row.id
        && (!entry.children || Object.keys(entry.children).length === 0)))
      if (entries.length === delegated.length && entries.every((entry, index) => entry === delegated[index])) return
      clear(); delegated = entries
      if (!entries.some(Boolean)) return
      remove = ctx.slots.register({ name: 'settings.section', id: 'connections-permissions', order: 15,
        label: () => ctx.locale.getSnapshot().active.startsWith('zh') ? '权限与隐私' : 'Permissions and privacy',
        children: {
          'connections.settings.permission': { kind: 'single', scope: 'root' },
          'connections.settings.sessionLog': { kind: 'single', scope: 'root' },
        },
      }, PermissionSection)
      entries.forEach((entry, index) => {
        if (entry) aliases.push(ctx.slots.register({ name: rows[index].slot, inject: entry.inject, store: entry.store, locale: entry.locale } as never, entry.component as never))
      })
    }
    const off = ctx.slots.subscribe('settings.general.item', sync)
    sync()
    return () => { off(); clear() }
  })
}
