import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { IconCloseOutlineRegular, useModalLayer } from './ui/index.js'
import type { Translate } from './messages.js'

/** Browser-modal dialog with plugin-owned focus, Escape and foreground coordination. */
export function ConnectionDialog({ title, busy = false, onClose, t, children }: {
  title: string; busy?: boolean; onClose(): void; t: Translate; children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  // Remove browser inertness before the owned layer restores its invoking focus.
  useLayoutEffect(() => { const dialog = ref.current!; return () => dialog.close() }, [])
  // Coordinate semantic foreground with native Settings; the shortcut owner
  // routes page.close through ownedModalClose, not the native private layer map.
  useModalLayer(ref, true, () => { if (!busy) onClose() })
  useEffect(() => {
    ref.current!.showModal()
  }, [])
  return <dialog ref={ref} className="dc-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <div className="dc-dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="dc-icon-button" aria-label={t('close')} title={t('close')} disabled={busy} onClick={onClose}><IconCloseOutlineRegular size={18} /></button></div>
    {children}
  </dialog>
}
