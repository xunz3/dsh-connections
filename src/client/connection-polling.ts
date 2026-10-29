interface PollingOptions<T> {
  read: () => Promise<T>
  onValue: (value: T) => void
  onError: () => void
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  intervalMs?: number
}

/** One visible-page read at a time; invalidated replies never reach the view. */
export function pollConnections<T>(options: PollingOptions<T>) {
  let disposed = false
  let visible = options.document.visibilityState !== 'hidden'
  let running = false
  let requested = false
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => { clearTimeout(timer); timer = undefined }
  const read = async () => {
    running = true
    requested = false
    const version = generation
    try {
      const value = await options.read()
      if (!disposed && visible && version === generation) options.onValue(value)
    } catch {
      if (!disposed && visible && version === generation) options.onError()
    } finally {
      running = false
      if (!disposed && visible) {
        if (requested) void read()
        else timer = setTimeout(refresh, options.intervalMs ?? 2500)
      }
    }
  }
  const refresh = () => {
    if (disposed) return
    clear()
    requested = true
    if (visible && !running) void read()
  }
  const visibilityChanged = () => {
    const next = options.document.visibilityState !== 'hidden'
    if (visible === next || disposed) return
    visible = next
    generation++
    clear()
    if (visible) refresh()
  }
  options.document.addEventListener('visibilitychange', visibilityChanged)
  refresh()
  return {
    refresh,
    invalidate() { generation++ },
    dispose() {
      disposed = true
      generation++
      clear()
      options.document.removeEventListener('visibilitychange', visibilityChanged)
    },
  }
}
