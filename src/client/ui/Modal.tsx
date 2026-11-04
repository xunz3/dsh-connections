import { useRef, type KeyboardEventHandler, type ReactNode } from 'react'
import { foreground, useModalLayer } from './keyboard.js'
import { IconCloseOutlineRegular } from './icons.js'
import { uiStyles } from './styles.js'

interface ModalBaseProps {
  open: boolean; onClose(): void; title: string; description?: string; children?: ReactNode; footer?: ReactNode
  className?: string; contentClassName?: string; shortcutModal?: string; onKeyDownCapture?: KeyboardEventHandler<HTMLDivElement>; backdropBlur?: boolean
}
export type ModalProps = ModalBaseProps & ({ headless: true; closeLabel?: never } | { headless?: false; closeLabel: string })

/** Owned overlay in the caller's slot subtree, not a new body portal or app.
 * This preserves parent/row React event ownership and lets later native modals
 * paint and focus above it. Native page.close is bridged by ownedModalClose. */
export function Modal({ open, onClose, title, closeLabel, description, children, footer, className = '', contentClassName = '',
  shortcutModal, onKeyDownCapture, headless = false }: ModalProps) {
  const dialog = useRef<HTMLDivElement>(null)
  useModalLayer(dialog, open, onClose)
  if (!open) return null
  return <div className="dcui-modal-root" role="presentation" onKeyDownCapture={onKeyDownCapture}>
    <style>{uiStyles}</style>
    <div className="dcui-modal-mask" aria-hidden="true" onClick={() => { if (dialog.current && foreground(dialog.current.ownerDocument) === dialog.current) onClose() }} />
    <div ref={dialog} className={`dcui-modal ${className}`} role="dialog" aria-modal="true" aria-label={title} data-shortcut-modal={shortcutModal} tabIndex={-1}>
      {headless ? children : <>
        <div className={`dcui-modal-content ${contentClassName}`}>
          <header className="dcui-modal-header"><h2>{title}</h2><button type="button" className="dcui-modal-close" aria-label={closeLabel} onClick={onClose}><IconCloseOutlineRegular size={14} /></button></header>
          {description && <p className="dcui-modal-description">{description}</p>}
          {children !== undefined && <div className="dcui-modal-body">{children}</div>}
        </div>
        {footer !== undefined && <footer className="dcui-modal-footer">{footer}</footer>}
      </>}
    </div>
  </div>
}
