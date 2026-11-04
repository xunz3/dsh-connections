import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { foreground, observeComposition, registerOwnedLayer, visible } from './keyboard.js'
import { IconCheckOutlineRegular } from './icons.js'

export interface MenuItem { id: string; label: ReactNode; disabled?: boolean; icon?: ReactNode; danger?: boolean; shortcut?: { keys: readonly string[]; aria?: string } }
export type MenuEntry = MenuItem | { type: 'separator'; id: string } | { type: 'label'; id: string; text: string }
export interface MenuProps {
  open: boolean; anchor: ReactNode; items?: readonly MenuEntry[]; children?: ReactNode; footer?: readonly MenuEntry[]
  selectedId?: string; selectedIds?: readonly string[]; onSelect?(id: string): void; onClose(): void
  align?: 'start' | 'end'; side?: 'top' | 'bottom' | 'right'; portal?: boolean; dense?: boolean; compact?: boolean
  autoFocus?: boolean; className?: string; listClassName?: string; minWidthFromAnchor?: boolean; selection?: 'check' | 'fill'
}

/** The popover stays in its owning React subtree (including focus events), while
 * the browser top layer escapes clipping. `portal` is source-compatible only:
 * this implementation never appends another plugin's DOM or portals to body. */
export function Menu({ open, anchor, items = [], children, footer, selectedId, selectedIds, onSelect, onClose,
  align = 'start', side = 'bottom', dense = false, compact = false, autoFocus = false, className = '', listClassName = '',
  minWidthFromAnchor = false, selection = 'check' }: MenuProps) {
  const root = useRef<HTMLSpanElement>(null), list = useRef<HTMLDivElement>(null)
  const latest = useRef({ open, onClose, onSelect })
  latest.current = { open, onClose, onSelect }
  const trigger = useRef<HTMLElement | null>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const refocus = () => {
    const target = trigger.current?.isConnected ? trigger.current : root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    target?.focus({ preventScroll: true })
  }
  const select = (id: string) => {
    if (!latest.current.open) return
    latest.current.onSelect?.(id)
    queueMicrotask(() => {
      if (latest.current.open) return
      const document = root.current?.ownerDocument
      if (document && (document.activeElement === document.body || list.current?.contains(document.activeElement))) refocus()
    })
  }
  useLayoutEffect(() => {
    const element = list.current, anchor = root.current
    if (!open || !element || !anchor) return
    const document = element.ownerDocument, window = document.defaultView!
    const active = document.activeElement
    trigger.current = active instanceof HTMLElement && anchor.contains(active) ? active : anchor.querySelector('button:not(:disabled)')
    const remove = registerOwnedLayer(element, () => { latest.current.onClose(); refocus() })
    if (typeof element.showPopover === 'function') element.showPopover()
    const place = () => {
      const rect = anchor.getBoundingClientRect(), width = element.offsetWidth, height = element.offsetHeight, margin = 12
      const x = side === 'right' ? rect.right + 4 : align === 'end' ? rect.right - width : rect.left
      const y = side === 'top' ? rect.top - height - 4 : side === 'right' ? rect.top : rect.bottom + 4
      const left = Math.max(margin, Math.min(x, window.innerWidth - width - margin))
      const top = Math.max(margin, Math.min(y, window.innerHeight - height - margin))
      setPosition(value => value.left === left && value.top === top ? value : { left, top })
      if (minWidthFromAnchor) element.style.minWidth = `${Math.min(rect.width, window.innerWidth - margin * 2)}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(anchor); observer.observe(element)
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    if (autoFocus) element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    return () => {
      const active = document.activeElement, restore = active === document.body || element.contains(active)
      remove(); observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true)
      if (typeof element.hidePopover === 'function' && element.matches(':popover-open')) element.hidePopover()
      if (restore) refocus()
    }
  }, [open, align, side, autoFocus, minWidthFromAnchor])
  useEffect(() => {
    const element = list.current, anchor = root.current
    if (!open || !element || !anchor) return
    const document = element.ownerDocument, window = document.defaultView!
    const composition = observeComposition(document)
    const close = (focus = false) => { latest.current.onClose(); if (focus) refocus() }
    const pointer = (event: PointerEvent) => { if (event.target instanceof Node && !anchor.contains(event.target)) close() }
    const blur = () => { if (document.activeElement instanceof HTMLIFrameElement) close() }
    const focused = () => { if (foreground(document) !== element && !anchor.contains(document.activeElement)) close() }
    const keydown = (event: KeyboardEvent) => {
      if (composition.guards(event) || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || foreground(document) !== element) return
      const active = document.activeElement, anchored = anchor.contains(active)
      if (event.key === 'Escape' && !event.shiftKey) {
        event.preventDefault(); event.stopPropagation(); if (!event.repeat) close(anchored)
        return
      }
      if (!anchored) return
      const buttons = [...element.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')].filter(visible)
      if (!buttons.length) return
      const index = buttons.indexOf(active as HTMLButtonElement)
      if (event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation()
        if (event.shiftKey) close(true)
        else if (index >= 0) buttons[index].click()
        else buttons[0].focus()
      } else if (!event.shiftKey && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : index < 0 ? event.key === 'ArrowUp' ? buttons.length - 1 : 0
            : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
        buttons[next].focus()
      }
    }
    window.addEventListener('keydown', keydown, true)
    document.addEventListener('pointerdown', pointer, true); document.addEventListener('focusin', focused)
    window.addEventListener('blur', blur)
    return () => {
      composition.dispose(); window.removeEventListener('keydown', keydown, true)
      document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('focusin', focused); window.removeEventListener('blur', blur)
    }
  }, [open])
  const row = (entry: MenuEntry) => {
    if ('type' in entry) return entry.type === 'separator' ? <div key={entry.id} role="separator" className="dcui-menu-separator" />
      : <div key={entry.id} role="presentation" className="dcui-menu-label">{entry.text}</div>
    const selected = entry.id === selectedId || selectedIds?.includes(entry.id)
    return <button key={entry.id} type="button" role="menuitem" className="dcui-menu-item" disabled={entry.disabled}
      data-selected={selected && selection === 'fill' || undefined} data-danger={entry.danger || undefined}
      aria-keyshortcuts={entry.shortcut?.aria} onClick={() => { if (!entry.disabled) select(entry.id) }}>
      {entry.icon && <span className="dcui-menu-icon">{entry.icon}</span>}<span className="dcui-menu-text">{entry.label}</span>
      {entry.shortcut && <span aria-hidden="true" className="dcui-menu-shortcut">{entry.shortcut.keys.join(' ')}</span>}
      {selected && selection === 'check' && <IconCheckOutlineRegular className="dcui-menu-check" size={14} />}
    </button>
  }
  return <span ref={root} className={`dcui-menu-anchor ${className}`}>{anchor}
    {open && <div ref={list} role="menu" {...{ popover: 'manual' }} className={`dcui-menu ${listClassName}`} data-dense={dense || compact || undefined} style={position}>
      <div role="presentation" className="dcui-menu-viewport">{items.map(row)}{children}</div>
      {footer?.length ? <div role="presentation" className="dcui-menu-footer">{footer.map(row)}</div> : null}
    </div>}
  </span>
}
