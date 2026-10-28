import type { Context, Fiber } from '@deepseek-ai/cordis'
import NativeShortcutsService, { type ShortcutCommand, type ShortcutContext } from '@deepseek-ai/dsh-client-shortcuts/client'

/** Undefined leaves the original native action, including its confirmation flow, intact. */
export type NativeCommandResolver = (
  command: ShortcutCommand, context: ShortcutContext,
) => ReturnType<ShortcutCommand['resolve']> | undefined

/**
 * The native service owns keybindings, platform input, menus and configuration.
 * Resolve the selected source at dispatch time, before a retained local action can run.
 * This composition replaces the separate native deployment; it never patches a live service.
 */
export function installNativeShortcuts(ctx: Context, resolve: NativeCommandResolver): Fiber & PromiseLike<Fiber> {
  class ConnectionsShortcuts extends NativeShortcutsService {
    override register(command: ShortcutCommand): () => void {
      return super.register({
        ...command,
        resolve: context => resolve(command, context) ?? command.resolve(context),
      })
    }
  }
  return ctx.plugin(ConnectionsShortcuts)
}
