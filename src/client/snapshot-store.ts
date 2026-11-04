/**
 * Connections-owned, synchronous observable value. Deliberately implements only
 * the structural getSnapshot/subscribe/set face used by this plugin: no Harness
 * Client module, persistence, Immer, rendering or global lifetime is involved.
 */
export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(next: T): void
}

export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      // Registrations have independent ownership even when a caller reuses the
      // same function. A retained cleanup cannot remove its replacement.
      const registration = () => listener()
      listeners.add(registration)
      let active = true
      return () => { if (active) { active = false; listeners.delete(registration) } }
    },
    set(next) {
      if (Object.is(value, next)) return
      value = next
      // A misbehaving observer must not starve another mounted view. Snapshot
      // iteration also makes add/remove during a notification deterministic.
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue
        try { listener() } catch (error) { console.error('Connections snapshot observer failed', error) }
      }
    },
  }
}
