import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { ShortcutCommand, ShortcutContext, Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'

/** Undefined leaves the original native action, including its confirmation flow, intact. */
export type NativeCommandResolver = (
  command: ShortcutCommand, context: ShortcutContext,
) => ReturnType<ShortcutCommand['resolve']> | undefined

type OwnedResolver = { original: ShortcutCommand['resolve']; wrapper: ShortcutCommand['resolve']; enabled: boolean }

/**
 * rc.3 has no public resolver middleware. Its registry retains each registered
 * command by identity in both the menu and binding tables. Adapt only that
 * object's resolver, keeping the live native provider and its dependents intact.
 * The build and runtime both check this deliberately narrow private contract.
 */
export function mountNativeCommandRouting(shortcuts: Shortcuts, resolve: NativeCommandResolver, onReady: (ready: boolean) => void): () => void {
  let active = true
  let ready = false
  let failed = false
  const owned = new Map<ShortcutCommand, OwnedResolver>()
  const publish = (value: boolean) => {
    ready = value
    try { onReady(value) } catch { ready = false; failed = true }
  }
  const restore = (command: ShortcutCommand, entry: OwnedResolver) => {
    entry.enabled = false
    // A later owner may freeze or replace a command. A retained wrapper remains
    // inert once readiness is withdrawn; cleanup must not undo their change.
    try {
      if (Object.getOwnPropertyDescriptor(command, 'resolve')?.value === entry.wrapper) Reflect.set(command, 'resolve', entry.original)
    } catch { /* An externally replaced descriptor retains its ownership. */ }
    owned.delete(command)
  }
  const sync = () => {
    if (!active || failed) return
    try {
      const registry = Reflect.get(shortcuts, 'registry') as {
        commands?: Map<string, ShortcutCommand>; catalog?: Shortcuts['catalog']; config?: Shortcuts['config']
      } | undefined
      if (!registry || registry.catalog !== shortcuts.catalog || registry.config !== shortcuts.config) throw new Error('Unsupported shortcuts registry')
      // Use the intrinsic to check a real Map even across Desktop/VM realms.
      const commands = Map.prototype.entries.call(registry.commands) as MapIterator<[string, ShortcutCommand]>
      const current = new Set<ShortcutCommand>()
      for (const [id, command] of commands) {
        const descriptor = Object.getOwnPropertyDescriptor(command, 'resolve')
        if (command.id !== id || typeof descriptor?.value !== 'function' || descriptor.writable !== true) throw new Error('Unsupported shortcut resolver')
        const entry = owned.get(command)
        if (entry && command.resolve !== entry.wrapper) throw new Error('Shortcut resolver ownership changed')
        current.add(command)
      }
      for (const [command, entry] of owned) if (!current.has(command)) restore(command, entry)
      for (const command of current) {
        if (owned.has(command)) continue
        const original = command.resolve
        const entry: OwnedResolver = {
          original, enabled: true,
          wrapper: context => (active && ready && entry.enabled ? resolve(command, context) : undefined) ?? original.call(command, context),
        }
        command.resolve = entry.wrapper
        owned.set(command, entry)
      }
      publish(true)
    } catch {
      failed = true
      // Withdraw remote surfaces before restoring native local resolution.
      publish(false)
      for (const [command, entry] of owned) restore(command, entry)
    }
  }
  publish(false)
  const unsubscribe = shortcuts.catalog.subscribe(sync)
  sync()
  return () => {
    if (!active) return
    active = false
    unsubscribe()
    publish(false)
    for (const [command, entry] of owned) restore(command, entry)
  }
}

/** Follow the native provider without replacing it or registering input listeners. */
export function installNativeShortcuts(ctx: Context, resolve: NativeCommandResolver, onReady: (ready: boolean) => void = () => {}): Fiber & PromiseLike<Fiber> {
  onReady(false)
  return ctx.inject(['shortcuts'], scope => {
    scope.effect(() => mountNativeCommandRouting(scope.shortcuts, resolve, onReady))
  })
}
