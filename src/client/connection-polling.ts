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

type PollDocument = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
interface PollGroup { add(task: () => Promise<void>): () => void }
const visibleGroups = new WeakMap<PollDocument, Map<number, PollGroup>>()

/** Related views share one visible-page timer; each task owns its own in-flight read. */
export function scheduleVisiblePoll(document: PollDocument, task: () => Promise<void>, intervalMs = 2500): () => void {
  let groups = visibleGroups.get(document)
  if (!groups) visibleGroups.set(document, groups = new Map())
  let group = groups.get(intervalMs)
  if (!group) {
    const tasks = new Set<{ task(): Promise<void>; busy: boolean; active: boolean }>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const visible = () => document.visibilityState !== 'hidden'
    const read = (entry: { task(): Promise<void>; busy: boolean; active: boolean }) => {
      if (disposed || !entry.active || entry.busy || !visible()) return
      entry.busy = true
      void Promise.resolve().then(() => { if (entry.active && visible()) return entry.task() })
        .catch(() => {}).finally(() => { entry.busy = false })
    }
    const schedule = () => {
      if (!disposed && visible() && timer === undefined) timer = setTimeout(tick, intervalMs * (0.9 + Math.random() * 0.2))
    }
    const tick = () => {
      clearTimeout(timer); timer = undefined
      if (disposed || !visible()) return
      for (const entry of tasks) read(entry)
      schedule()
    }
    const visibility = () => {
      clearTimeout(timer); timer = undefined
      if (visible()) tick()
    }
    document.addEventListener('visibilitychange', visibility)
    group = { add(task) {
      const entry = { task, busy: false, active: true }
      tasks.add(entry)
      read(entry)
      schedule()
      return () => {
        if (!entry.active) return
        entry.active = false
        tasks.delete(entry)
        if (tasks.size) return
        disposed = true
        clearTimeout(timer)
        document.removeEventListener('visibilitychange', visibility)
        if (groups!.get(intervalMs) === group) groups!.delete(intervalMs)
      }
    } }
    groups.set(intervalMs, group)
  }
  return group.add(task)
}
