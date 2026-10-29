import { useEffect, useRef } from 'react'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

/** The existing desktop guest bridge owns isolation, partitions and guest disposal. */
export function desktopBrowser(): DesktopBrowserBridge | undefined {
  const carrier = (globalThis as typeof globalThis & {
    dshDesktop?: { protocolVersion: number; browser?: DesktopBrowserBridge }
  }).dshDesktop
  const bridge = carrier?.protocolVersion === 1 ? carrier.browser : undefined
  return bridge && typeof bridge.acquire === 'function' && typeof bridge.release === 'function'
    && typeof bridge.onOpenRequested === 'function' ? bridge : undefined
}

interface GuestElement extends HTMLElement { loadURL(url: string): Promise<void> }
/** A thin view over the shell's existing lease API; no Electron or browser service is recreated. */
export function DesktopGuest({ bridge, id, url, title, failed, className = 'dc-remote-guest' }: {
  bridge: DesktopBrowserBridge; id: string; url: string; title: string; failed: () => void; className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const onFailure = useRef(failed)
  const label = useRef(title)
  onFailure.current = failed
  label.current = title
  useEffect(() => { host.current?.querySelector('webview')?.setAttribute('aria-label', title) }, [title])
  useEffect(() => {
    let alive = true
    let lease: DesktopBrowserLeaseId | undefined
    let element: GuestElement | undefined
    let offOpen: (() => void) | undefined
    const release = () => { if (lease) { const current = lease; lease = undefined; void bridge.release(current).catch(() => {}) } }
    void bridge.acquire(`@xunz/dsh-connections/${id}`).then(reservation => {
      lease = reservation.lease
      if (!alive || !host.current) { release(); return }
      element = document.createElement('webview') as GuestElement
      element.setAttribute('name', lease)
      element.setAttribute('data-sidebar-browser-frame', '')
      element.setAttribute('data-connections-source', id)
      element.setAttribute('partition', reservation.partition)
      element.setAttribute('src', `about:blank#${lease}`)
      element.setAttribute('allowpopups', '')
      element.setAttribute('aria-label', label.current)
      element.className = 'dc-remote-frame'
      let started = false
      element.addEventListener('dom-ready', () => {
        if (started || !alive) return
        started = true
        void element!.loadURL(url).catch(() => { if (alive) onFailure.current() })
      })
      element.addEventListener('did-fail-load', event => {
        const failure = event as Event & { isMainFrame?: boolean; errorCode?: number }
        if (alive && failure.isMainFrame && failure.errorCode !== -3) onFailure.current()
      })
      for (const event of ['render-process-gone', 'destroyed']) {
        element.addEventListener(event, () => { if (alive) onFailure.current() })
      }
      // The desktop shell already opens HTTP(S) links in the system browser.
      // Keep provider sign-in popups working without navigating the remote workspace.
      offOpen = bridge.onOpenRequested(lease, value => {
        if (!alive) return
        try {
          const target = new URL(value)
          if (['http:', 'https:'].includes(target.protocol) && !target.username && !target.password) {
            window.open(target.href, '_blank', 'noopener,noreferrer')
          }
        } catch { /* Ignore malformed guest navigation. */ }
      })
      host.current.append(element)
    }).catch(() => { if (alive) onFailure.current() })
    return () => { alive = false; offOpen?.(); element?.remove(); release() }
  }, [bridge, id, url])
  return <div className={className} ref={host} />
}
