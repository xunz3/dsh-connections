export interface LoginAction { kind: 'openLogin' | 'copyLogin'; url: string }
export type SendLoginAction = (action: LoginAction, signal: AbortSignal) => Promise<void>

/** The browser-window operations used by the pinned native login presenter. */
export interface PendingLoginWindow {
  opener: null
  readonly closed: boolean
  close(): void
  readonly location: { replace(url: string): void }
}

export interface LoginHost {
  prepare(): PendingLoginWindow
  copy(url: string): Promise<void>
  dispose(): void
}

function loginUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 16_384 || value.trim() !== value) throw new TypeError('Invalid sign-in URL')
  let url: URL
  try { url = new URL(value) } catch { throw new TypeError('Invalid sign-in URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Invalid sign-in URL')
  return url.href
}

const closedError = () => new DOMException('The sign-in view is closed', 'AbortError')

/**
 * Adapt only native login presentation to the active view's browser capabilities.
 * The native account plugin continues to own authorization attempts and credentials.
 */
export function createLoginHost(send: SendLoginAction, onOpenFailure: (error: Error) => void): LoginHost {
  const pending = new Set<AbortController>()
  let disposed = false
  const begin = () => {
    if (disposed) throw closedError()
    const lifetime = new AbortController()
    pending.add(lifetime)
    return lifetime
  }
  return {
    prepare() {
      const lifetime = begin()
      let navigated = false
      const close = () => { lifetime.abort(); pending.delete(lifetime) }
      return {
        opener: null,
        get closed() { return lifetime.signal.aborted || disposed },
        close,
        location: { replace(value) {
          if (lifetime.signal.aborted || disposed || navigated) return
          const url = loginUrl(value)
          navigated = true
          // Native BrowserLogin navigates synchronously. Report an asynchronous
          // desktop failure through the integration's notice, leaving Copy usable.
          void Promise.resolve().then(() => {
            lifetime.signal.throwIfAborted()
            return send({ kind: 'openLogin', url }, lifetime.signal)
          }).catch(() => {
            if (!lifetime.signal.aborted) onOpenFailure(new Error('Unable to open the sign-in page in your browser'))
          }).finally(() => { pending.delete(lifetime) })
        } },
      }
    },
    async copy(value) {
      const url = loginUrl(value)
      const lifetime = begin()
      try {
        await send({ kind: 'copyLogin', url }, lifetime.signal)
        lifetime.signal.throwIfAborted()
      } finally { pending.delete(lifetime) }
    },
    dispose() {
      disposed = true
      for (const lifetime of pending) lifetime.abort()
      pending.clear()
    },
  }
}
