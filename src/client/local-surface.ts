import type { Context } from '@deepseek-ai/cordis'
import { readLocalPresentation } from './local-presentation.js'
import type { LocalSurface } from './view-surface.js'
import { parseLoginAction } from '../shared/view-surface-protocol.js'

export function localSurface(ctx: Context): LocalSurface {
  return {
    getPresentation: () => readLocalPresentation(ctx),
    async perform(input, signal) {
      signal.throwIfAborted()
      const action = parseLoginAction(input)
      if (action.kind === 'copyLogin') await navigator.clipboard.writeText(action.url)
      else {
        // Desktop's normal top-level window handler opens the system browser.
        // The guest itself is never granted popup/clipboard permissions.
        window.open(action.url, '_blank', 'noopener,noreferrer')
      }
    },
  }
}
