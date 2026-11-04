import type { ShortcutCommand, ShortcutContext } from '@deepseek-ai/dsh-client-shortcuts/client'
import { isContentCommand, type NativeCommandResolver } from './native-shortcuts.js'
type ShortcutResolution = ReturnType<ShortcutCommand['resolve']>

export interface WorkspaceShortcutCallbacks {
  /** Read ownership when the native registry resolves a command, never from a retained local chat. */
  getRemoteSourceId(): string | undefined
  onNewSession(sourceId: string): void
  onSearch(): void
  onAddWorkspace(): void
  onClose(sourceId: string): void
  onBlocked(command: string, sourceId: string): void
}

const handled = (run: () => void): ShortcutResolution => ({ status: 'handled', run })
const blocked = (): ShortcutResolution => ({ status: 'blocked', reason: 'remote-content-owner' })

/** Native dispatch continues to own gestures, conflicts, repeats, menus and user bindings. */
export function workspaceCommandResolver(callbacks: WorkspaceShortcutCallbacks): NativeCommandResolver {
  return (command, context) => {
    const id = command.id, source = callbacks.getRemoteSourceId()
    if (!isContentCommand(id)) return
    // Native commands retain local modal policy. Above remote content only native
    // Close may dismiss the local dialog; other commands must not act behind it.
    if (context.modal !== null) return source === undefined || id === 'page.close' ? undefined : blocked()
    const guest = context.target?.getAttribute('data-connections-source')
    if (guest && guest !== source) return blocked()
    if (id === 'session.new') return handled(() => callbacks.onNewSession(source ?? 'local'))
    if (id === 'session.search') return handled(callbacks.onSearch)
    if (id === 'workspace.add') return handled(callbacks.onAddWorkspace)
    if (source === undefined) return
    if (id === 'page.close') return handled(() => callbacks.onClose(source))
    // Native remote controls retain confirmations and their current document state.
    // Never dispatch these commands against the local Session retained behind the guest.
    return handled(() => callbacks.onBlocked(id, source))
  }
}

/** A settings guest has its own native forms and must not navigate the retained workspace. */
export function remoteSettingsCommand(command: ShortcutCommand, context: ShortcutContext, close: () => void): ShortcutResolution | undefined {
  if (command.id === 'settings.open') return blocked()
  if (!isContentCommand(command.id)) return
  if (context.modal !== null && context.modal !== 'settings') return command.id === 'page.close' ? undefined : blocked()
  return command.id === 'page.close' ? handled(close) : blocked()
}
