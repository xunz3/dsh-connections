import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { IconCloseOutlineRegular, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './messages.js'

/** Native modal focus containment, Escape handling and focus return. */
export function ConnectionDialog({ title, busy = false, onClose, t, children }: {
  title: string; busy?: boolean; onClose(): void; t: Translate; children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  // Remove browser inertness before the native layer restores its invoking focus.
  useLayoutEffect(() => { const dialog = ref.current!; return () => dialog.close() }, [])
  // Share keyboard ownership with native Settings and its application shortcuts.
  useModalLayer(ref, true, () => { if (!busy) onClose() })
  useEffect(() => {
    ref.current!.showModal()
  }, [])
  return <dialog ref={ref} className="dc-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <div className="dc-dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="dc-icon-button" aria-label={t('close')} title={t('close')} disabled={busy} onClick={onClose}><IconCloseOutlineRegular size={18} /></button></div>
    {children}
  </dialog>
}
