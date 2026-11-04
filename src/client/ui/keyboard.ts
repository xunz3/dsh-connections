import { useLayoutEffect, useRef, type RefObject } from 'react'

/** Match the native semantic foreground without importing its private layer map. */
export const modalSelector = '[role="dialog"][aria-modal="true"], [role="menu"]'
interface Layer { element: HTMLElement; close(): void }
const owned = new WeakMap<Document, Map<HTMLElement, Layer>>()

export function visible(element: HTMLElement): boolean {
  return !element.closest('[hidden], [inert]') && element.getClientRects().length > 0
    && element.ownerDocument.defaultView?.getComputedStyle(element).visibility !== 'hidden'
}
export function foreground(document: Document): HTMLElement | undefined {
  const active = document.activeElement
  // A browser-modal dialog is in the top layer even when its DOM precedes an
  // older native body portal. Menus inside that dialog remain above its card.
  const modal = active instanceof Element ? active.closest<HTMLDialogElement>('dialog:modal') : null
  const root = modal ?? document
  const entries = [...root.querySelectorAll<HTMLElement>(modalSelector)].filter(visible)
  return entries.at(-1) ?? modal ?? undefined
}

/** A read-only shortcut seam. The returned capability rechecks its registration
 * and foreground at invocation; a queued page.close cannot close a newer view. */
export function ownedModalClose(document: Document): (() => void) | undefined {
  const element = foreground(document)
  const layer = element && owned.get(document)?.get(element)
  if (!layer) return
  return () => { if (owned.get(document)?.get(layer.element) === layer && foreground(document) === layer.element) layer.close() }
}

export function registerOwnedLayer(element: HTMLElement, close: () => void): () => void {
  const document = element.ownerDocument
  let layers = owned.get(document)
  if (!layers) owned.set(document, layers = new Map())
  const layer = { element, close }
  layers.set(element, layer)
  return () => {
    if (layers!.get(element) === layer) layers!.delete(element)
    if (layers!.size === 0) owned.delete(document)
  }
}

/** IME's closing key can arrive after compositionend without isComposing. */
export function observeComposition(document: Document) {
  let composing = false, ended = false
  const start = () => { composing = true }
  const end = () => { composing = false; ended = true }
  const release = () => { ended = false }
  const blur = () => { composing = false; ended = false }
  document.addEventListener('compositionstart', start, true)
  document.addEventListener('compositionend', end, true)
  document.addEventListener('keyup', release, true)
  document.defaultView?.addEventListener('blur', blur)
  return {
    guards(event: KeyboardEvent) { const result = composing || ended || event.isComposing || event.keyCode === 229; ended = false; return result },
    dispose() {
      document.removeEventListener('compositionstart', start, true)
      document.removeEventListener('compositionend', end, true)
      document.removeEventListener('keyup', release, true)
      document.defaultView?.removeEventListener('blur', blur)
    },
  }
}
const focusable = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'
export const focusableElements = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>(focusable)].filter(visible)

/** DOM-foreground coordination, deliberately not a duplicate native WeakMap.
 * Native modal/menu ahead: yield. Owned modal ahead: consume before the native
 * document bubble handler and the native window-bubble shortcut dispatcher. */
export function useModalLayer(dialog: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const element = dialog.current
    if (!open || !element) return
    const document = element.ownerDocument, window = document.defaultView
    const previous = document.activeElement
    const composition = observeComposition(document)
    const remove = registerOwnedLayer(element, () => close.current())
    const initial = element.querySelector<HTMLElement>('[data-modal-autofocus]') ?? focusableElements(element)[0] ?? element
    if (!element.contains(document.activeElement)) initial.focus({ preventScroll: true })
    const keydown = (event: KeyboardEvent) => {
      if (composition.guards(event) || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || foreground(document) !== element) return
      if (event.key === 'Escape' && !event.shiftKey) {
        event.preventDefault(); event.stopPropagation()
        if (!event.repeat) close.current()
      } else if (event.key === 'Tab') {
        const items = focusableElements(element), first = items[0] ?? element, last = items.at(-1) ?? element
        const edge = event.shiftKey ? document.activeElement === first : document.activeElement === last
        if (edge || document.activeElement === element || !element.contains(document.activeElement)) {
          event.preventDefault(); event.stopPropagation(); (event.shiftKey ? last : first).focus()
        }
      }
    }
    window?.addEventListener('keydown', keydown, true)
    return () => {
      // React may detach a portal/row before this cleanup, so a removed top
      // layer is no longer discoverable by DOM order. Body focus is its lost
      // seat; never take focus back from a still-active newer native layer.
      const active = document.activeElement
      const restore = foreground(document) === element || active === document.body || active === null || element.contains(active)
      remove(); composition.dispose(); window?.removeEventListener('keydown', keydown, true)
      if (restore && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [dialog, open])
}
