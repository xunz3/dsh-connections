import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { connectionsLogoSvg } from './logo.js'

/**
 * Harness rc.3 exposes no settings icon option or section DOM identity. Its
 * native shell renders the complete registry sorted by order. Follow that
 * ledger and guard the exact row structure; a changed host falls back to its
 * own icons. No host nodes or labels are observed or rewritten.
 */
export function mountSettingsIcon(slots: Pick<SlotCore, 'entries' | 'subscribe'>, doc: Document = document): () => void {
  const style = doc.createElement('style')
  const mask = `url("data:image/svg+xml,${encodeURIComponent(connectionsLogoSvg)}") center / contain no-repeat`
  const sync = () => {
    const entries = [...slots.entries('settings.section')].sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))
    const index = entries.findIndex(entry => entry.options.id === 'connections')
    const list = `[data-shortcut-modal="settings"] > nav > div:last-child:has(> button:nth-child(${entries.length}):last-child):not(:has(> :not(button)))`
    const row = `${list} > button:nth-child(${index + 1}):has(> svg:first-child + span:last-child)`
    style.textContent = index < 0 ? '' : `
      ${row} > svg { display: none; }
      ${row}::before {
        content: ''; display: block; width: 16px; height: 16px; flex: 0 0 16px;
        background: currentColor; mask: ${mask}; -webkit-mask: ${mask};
      }
    `
  }
  const unsubscribe = slots.subscribe('settings.section', sync)
  sync()
  doc.head.append(style)
  return () => { unsubscribe(); style.remove() }
}
