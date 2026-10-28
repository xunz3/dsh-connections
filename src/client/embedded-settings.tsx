import { useEffect, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
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
  const stop = () => { unsubscribe(); unsubscribe = () => {}; client?.dispose(); client = undefined; snapshot.set(undefined) }
  const sync = () => {
    const current = state.getSnapshot()
    if (!current.active) { stop(); generation = undefined; return }
    if (client && generation === current.generation) return
    stop()
    generation = current.generation
    client = create(channel)
    const active = client
    const update = () => { if (client === active) snapshot.set(active.getSnapshot()) }
    unsubscribe = active.subscribe(update)
    update()
  }
  const off = state.subscribe(sync)
  sync()
  return {
    getSnapshot: snapshot.getSnapshot, subscribe: snapshot.subscribe,
    select: id => { client?.select(id) },
    dispose: () => { off(); stop() },
  }
}

interface SettingsOperation {
  mounted: boolean
  presented: boolean
  confirmed: boolean
  shell?: NativeSettingsShell
  openedShell?: NativeSettingsShell
  resolve(): void
  reject(error: Error): void
  dispose(): void
}

/** A dedicated document drives the original root store; native slots keep every form and write path. */
export class EmbeddedSettingsController implements EmbeddedSettingsAdapter {
  readonly state = createSnapshotStore<{ active: boolean; open: boolean; available: boolean; generation?: number }>({ active: false, open: false, available: false })
  private operation?: SettingsOperation
  private generation = 0

  constructor(private readonly ctx: Context, private readonly layout: Pick<EmbeddedLayoutController, 'showSettings'>,
    private readonly onClosed: () => void) {}

  open(signal: AbortSignal): Promise<void> {
    this.close()
    return new Promise((resolve, reject) => {
      let unsubscribeShell = () => {}
      const operation: SettingsOperation = {
        mounted: false, presented: false, confirmed: false, resolve: () => { clearTimeout(timer); resolve() }, reject,
        dispose: () => { clearTimeout(timer); unsubscribeSlot(); unsubscribeShell(); signal.removeEventListener('abort', aborted) },
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
          unsubscribeShell = shell?.subscribe(() => {
            if (this.operation !== operation) return
            const open = shell.getSnapshot().open
            this.state.set({ ...this.state.getSnapshot(), open })
            if (!open && operation.confirmed) { operation.confirmed = false; this.onClosed() }
          }) ?? (() => {})
        }
        this.present(operation)
      }
      const unsubscribeSlot = this.ctx.slots.subscribe('sidebar.settings', sync)
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
    if (!operation.mounted || !operation.shell || operation.openedShell === operation.shell) return
    operation.openedShell = operation.shell
    operation.shell.actions.open()
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

  reopen(): void { this.operation?.shell?.actions.open() }

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
  options: { onClosed(): void; label: string; unavailableLabel: string }): EmbeddedSettingsController {
  const controller = new EmbeddedSettingsController(ctx, layout, options.onClosed)
  const Launcher = () => {
    const state = useSyncExternalStore(controller.state.subscribe, controller.state.getSnapshot)
    useEffect(() => { if (state.active) controller.mounted() }, [state.active, state.generation])
    return state.active && !state.open ? <div className="dc-embedded-settings-launcher">
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
