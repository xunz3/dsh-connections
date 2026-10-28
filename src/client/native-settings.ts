import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

/** The native shell's declared root store, shared with its own Settings command. */
export interface NativeSettingsShell {
  getSnapshot(): { open: boolean; activeId?: string }
  subscribe(listener: () => void): () => void
  actions: { open(): void; close(): void; openSection(id: string): void }
}

/** Versioned adapter: never discover Settings by DOM text or rebind local forms to a remote. */
export function nativeSettingsShell(entry: StoredEntry | undefined): NativeSettingsShell | undefined {
  const handle = entry?.store
  if (entry?.locale !== 'settings') return
  if (!handle || !('create' in handle) || typeof handle.create !== 'function') return
  const instance = handle.create() as unknown as Partial<NativeSettingsShell>
  if ((handle.create() as unknown) !== instance) return
  if (typeof instance.getSnapshot !== 'function' || typeof instance.subscribe !== 'function'
    || typeof instance.actions?.open !== 'function' || typeof instance.actions.close !== 'function'
    || typeof instance.actions.openSection !== 'function') return
  if (typeof instance.getSnapshot()?.open !== 'boolean') return
  return instance as NativeSettingsShell
}

export function settingsShell(ctx: Context): NativeSettingsShell | undefined {
  return nativeSettingsShell(ctx.slots.entries('sidebar.settings')[0])
}
