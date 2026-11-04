import { cloneElement, forwardRef, useEffect, useId, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react'

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'; size?: 'md' | 'sm'; icon?: ReactNode
}>(function Button({ variant = 'ghost', size = 'md', icon, className = '', children, type = 'button', ...props }, ref) {
  return <button ref={ref} type={type} className={`dcui-button ${className}`} data-variant={variant} data-size={size} {...props}>{icon}{children}</button>
})

export function StateDot({ state, size = state === 'ongoing' ? 14 : 10, className = '' }: {
  state: 'done' | 'warning' | 'ongoing' | 'error' | 'idle'; size?: number; className?: string; appearance?: 'dot' | 'step'
}) {
  return <span aria-hidden="true" className={`dcui-state-dot ${className}`} data-state={state} style={{ width: size, height: size, boxSizing: 'border-box' }} />
}

export function relativeTime(at: number, now: number): { unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'; n: number } {
  const diff = Math.max(0, now - at), minute = 60_000, day = 86_400_000
  if (diff < minute) return { unit: 'now', n: 0 }
  if (diff < 60 * minute) return { unit: 'minutes', n: Math.floor(diff / minute) }
  if (diff < day) return { unit: 'hours', n: Math.floor(diff / (60 * minute)) }
  if (diff < 30 * day) return { unit: 'days', n: Math.floor(diff / day) }
  if (diff < 365 * day) return { unit: 'months', n: Math.floor(diff / (30 * day)) }
  return { unit: 'years', n: Math.floor(diff / (365 * day)) }
}

/** Inline-owned, browser top-layer tooltip; an anchor never remounts to show it. */
export function Tooltip({ label, children, delayMs = 0, focusDelayMs = 0, side = 'right', align = 'center', disabled = false, maxWidth, gap = 8 }: {
  label: string | (() => string); children: ReactElement; delayMs?: number; focusDelayMs?: number; side?: 'top' | 'bottom' | 'left' | 'right'; align?: 'center' | 'end'
  disabled?: boolean; portal?: boolean; maxWidth?: number; gap?: number
}) {
  const id = useId(), anchor = useRef<HTMLSpanElement>(null), tooltip = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(), pointer = useRef(false)
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0 })
  const cancel = () => { clearTimeout(timer.current); timer.current = undefined }
  const hide = () => { cancel(); setOpen(false) }
  const show = (delay: number) => { cancel(); if (!disabled) timer.current = setTimeout(() => setOpen(true), Math.max(0, delay)) }
  useEffect(() => { if (disabled) hide(); return cancel }, [disabled])
  useLayoutEffect(() => {
    const element = tooltip.current, owner = anchor.current
    if (!open || !element || !owner) return
    if (typeof element.showPopover === 'function') element.showPopover()
    const place = () => {
      const rect = owner.getBoundingClientRect(), width = element.offsetWidth, height = element.offsetHeight
      const window = owner.ownerDocument.defaultView!
      const x = side === 'left' ? rect.left - width - gap : side === 'right' ? rect.right + gap : align === 'end' ? rect.right - width : rect.left + (rect.width - width) / 2
      const y = side === 'top' ? rect.top - height - gap : side === 'bottom' ? rect.bottom + gap : rect.top + (rect.height - height) / 2
      setPosition({ left: Math.max(12, Math.min(x, window.innerWidth - width - 12)), top: Math.max(12, Math.min(y, window.innerHeight - height - 12)) })
    }
    place()
    const window = owner.ownerDocument.defaultView!
    window.addEventListener('resize', hide); window.addEventListener('scroll', hide, true)
    return () => {
      window.removeEventListener('resize', hide); window.removeEventListener('scroll', hide, true)
      if (typeof element.hidePopover === 'function' && element.matches(':popover-open')) element.hidePopover()
    }
  }, [open, side, align, gap])
  const child = children as ReactElement<{ 'aria-describedby'?: string }>
  return <span ref={anchor} className="dcui-tooltip-anchor" onMouseEnter={() => show(delayMs)} onMouseLeave={hide}
    onPointerDownCapture={() => { pointer.current = true; hide() }} onClickCapture={hide}
    onFocusCapture={() => { if (!pointer.current) show(focusDelayMs) }} onBlurCapture={hide} onKeyDownCapture={() => { pointer.current = false; hide() }}>
    {cloneElement(child, { 'aria-describedby': open ? [child.props['aria-describedby'], id].filter(Boolean).join(' ') : child.props['aria-describedby'] })}
    {open && !disabled && <span id={id} ref={tooltip} role="tooltip" {...{ popover: 'manual' }} className="dcui-tooltip" style={{ ...position, ...(maxWidth === undefined ? {} : { maxWidth }) }}>{typeof label === 'function' ? label() : label}</span>}
  </span>
}
