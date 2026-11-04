import { createSnapshotStore } from '../snapshot-store.js'

/** Dedicated compatibility dependency for the build-checked Settings provider.
 * Its two update sites only assign shallow snapshot fields. This is NOT a
 * replacement for the platform's general Immer draft-store API. */
export function createSettingsSnapshotStore<T extends object>(initial: T) {
  const store = createSnapshotStore(initial)
  return { getSnapshot: store.getSnapshot, subscribe: store.subscribe, set: store.set,
    update(mutate: (draft: T) => void) {
      const previous = store.getSnapshot(), draft = { ...previous }
      mutate(draft)
      const keys = Reflect.ownKeys(previous)
      if (keys.length === Reflect.ownKeys(draft).length && keys.every(key => Object.hasOwn(draft, key) && Object.is(Reflect.get(previous, key), Reflect.get(draft, key)))) return
      store.set(draft)
    } }
}
export const nativeSnapshotStores = { createSnapshotStore: createSettingsSnapshotStore }
