import type { ShortcutCatalogEntry, ShortcutGesture, Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'

type WorkspaceShortcuts = Pick<Shortcuts, 'runtime' | 'platform' | 'catalog' | 'config' | 'observeFixedInput'>
export type BlockedWorkspaceCommand = 'session.archive' | 'session.fork'

export interface WorkspaceShortcutCallbacks {
  /** Read the main panel's current owner at keydown, not a retained local session. */
  getRemoteSourceId(): string | undefined
  onNewSession(sourceId: string): void
  onSearch(): void
  onAddWorkspace(): void
  onBlocked(command: BlockedWorkspaceCommand, sourceId: string): void
}

/**
 * These runtimes send DOM keyboard input through fixed observers before native dispatch.
 * Linux desktop menus still bypass observers; this does not make desktop remote views safe.
 */
export function supportsWorkspaceShortcutRouting(shortcuts: Pick<Shortcuts, 'runtime' | 'platform'>): boolean {
  return shortcuts.runtime === 'web' || shortcuts.platform === 'linux'
}

const modifiers = ['control', 'alt', 'shift', 'meta'] as const
const commands = new Set(['session.new', 'session.search', 'workspace.add', 'session.archive', 'session.fork'])

function matches(row: ShortcutCatalogEntry, gesture: ShortcutGesture, pair: boolean): boolean {
  const binding = row.binding
  if (binding === null || row.issue !== null
    || modifiers.some(modifier => gesture[modifier] !== binding.modifiers.includes(modifier))) return false
  if (!pair) return binding.secondCode === undefined && binding.code === gesture.code
  return binding.secondCode !== undefined && gesture.secondCode !== undefined
    && ((binding.code === gesture.code && binding.secondCode === gesture.secondCode)
      || (binding.code === gesture.secondCode && binding.secondCode === gesture.code))
}

/**
 * Route only the replaced workspace controls, using the accepted native catalog verbatim.
 * Fixed observers run after local controls and before configurable DOM shortcut dispatch.
 * Consuming first prevents a callback failure from falling through onto a retained local chat.
 */
export function installWorkspaceShortcuts(shortcuts: WorkspaceShortcuts, callbacks: WorkspaceShortcutCallbacks): () => void {
  if (!supportsWorkspaceShortcutRouting(shortcuts)) return () => {}
  return shortcuts.observeFixedInput(input => {
    if (input.type !== 'keydown') return
    const { gesture, context } = input
    if (gesture.defaultPrevented || gesture.composing || context.modal !== null || context.region === 'terminal'
      || (context.source !== undefined && context.source !== 'keyboard')
      || shortcuts.config.getSnapshot().status === 'loading') return

    const catalog = shortcuts.catalog.getSnapshot()
    // Native dispatch gives an exact two-key match (including conflicts) precedence.
    // Do not steal its single-key fallback for an unrelated command.
    const row = (gesture.secondCode === undefined ? undefined : catalog.find(row => matches(row, gesture, true)))
      ?? catalog.find(row => matches(row, gesture, false))
    if (row === undefined || row.conflicts.length !== 0 || !commands.has(row.id)) return

    const sourceId = callbacks.getRemoteSourceId()
    if (row.id !== 'session.search' && row.id !== 'workspace.add' && row.id !== 'session.new' && sourceId === undefined) return
    input.consume()
    if (gesture.repeat) return
    switch (row.id) {
      case 'session.search': callbacks.onSearch(); break
      case 'workspace.add': callbacks.onAddWorkspace(); break
      case 'session.new': callbacks.onNewSession(sourceId ?? 'local'); break
      case 'session.archive': callbacks.onBlocked('session.archive', sourceId!); break
      case 'session.fork': callbacks.onBlocked('session.fork', sourceId!); break
    }
  })
}
