import { randomUUID } from 'node:crypto'
import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { ConnectionRecord, SaveConnection } from '../shared/types.js'
import { parseId, parseLaunchUrl, parseRecord, parseSave } from '../shared/validation.js'

export interface ConnectionStore {
  list(): Promise<ConnectionRecord[]>
  read(id: string): Promise<ConnectionRecord | undefined>
  save(input: SaveConnection): Promise<ConnectionRecord>
  remove(id: string): Promise<void>
  rememberPort(id: string, target: string, port: number): Promise<void>
}

type Credentials = Pick<CredentialProvider, 'listRecords' | 'readRecord' | 'modifyRecord' | 'deleteRecord'>
// The native provider permits lowercase hyphenated scope segments, not npm names.
const SCOPE = 'xunz-dsh-connections'
const LEGACY_SCOPE = 'connections'
const key = (id: string) => credentialKey(SCOPE, parseId(id))
const legacyKey = (id: string) => credentialKey(LEGACY_SCOPE, parseId(id))
// Migration touches two native records. Share one per-id transaction queue
// across stores backed by the same provider so deletion cannot be overtaken.
const providerOperations = new WeakMap<Credentials, Map<string, Promise<unknown>>>()

class InvalidConnectionRecord extends Error {}
function decode(record: CredentialRecord, id: string): ConnectionRecord {
  try {
    if (record.kind !== 'grant') throw new TypeError()
    const parsed = parseRecord(record.payload)
    if (parsed.id !== id) throw new TypeError()
    return parsed
  } catch { throw new InvalidConnectionRecord('The saved connection record is invalid.') }
}

function connectionId(value: string): string | undefined {
  const [scope, id, extra] = value.split('/')
  if ((scope !== SCOPE && scope !== LEGACY_SCOPE) || extra !== undefined) return undefined
  try { return parseId(id) } catch { return undefined }
}

/** Connections and their launch credentials are one native, atomic credential record. */
export function createStore(credentials: Credentials): ConnectionStore {
  let operations = providerOperations.get(credentials)
  if (!operations) { operations = new Map(); providerOperations.set(credentials, operations) }
  const serialize = <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    parseId(id)
    const pending = (operations.get(id) ?? Promise.resolve()).then(operation, operation)
    operations.set(id, pending)
    void pending.then(() => { if (operations.get(id) === pending) operations.delete(id) },
      () => { if (operations.get(id) === pending) operations.delete(id) })
    return pending
  }
  const readCurrent: ConnectionStore['read'] = async id => {
    const record = await credentials.readRecord(key(id))
    if (record !== undefined) return decode(record, id)
    const legacy = await credentials.readRecord(legacyKey(id))
    if (legacy === undefined) return undefined
    const parsed = decode(legacy, id)
    // Copy before deleting so interruption cannot lose the credential. An
    // already-written destination wins if migration raced another operation.
    const migrated = await credentials.modifyRecord(key(id), async current => current ?? { kind: 'grant', payload: parsed })
    if (migrated === undefined) throw new Error('The connection could not be migrated.')
    const saved = decode(migrated, id)
    await credentials.deleteRecord(legacyKey(id))
    return saved
  }
  const read: ConnectionStore['read'] = id => serialize(id, () => readCurrent(id))
  return {
    read,
    async list() {
      const entries = await credentials.listRecords()
      const ids = [...new Set(entries.flatMap(entry => {
        const id = connectionId(entry.key)
        return id === undefined ? [] : [id]
      }))]
      const records = await Promise.all(ids.map(async id => {
        try { return await read(id) }
        catch (error) { if (error instanceof InvalidConnectionRecord) return undefined; throw error }
      }))
      const valid = records.filter((record): record is ConnectionRecord => record !== undefined)
      if (valid.length > 100) throw new Error('At most 100 saved connections are supported.')
      return valid.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    },
    async save(value) {
      const input = parseSave(value)
      const id = input.id ?? `connection-${randomUUID()}`
      return serialize(id, async () => {
        if (input.id !== undefined) await readCurrent(id)
        const result = await credentials.modifyRecord(key(id), async current => {
          const previous = current === undefined ? undefined : decode(current, id)
          if (input.id !== undefined && previous === undefined) throw new Error('This connection no longer exists.')
          const mode = input.mode ?? previous?.mode
          if (mode !== 'managed' && input.launchUrl === undefined && (previous === undefined || previous.mode === 'managed' || previous.target !== input.target)) {
            throw new Error('Paste a fresh Harness launch URL when adding a connection or changing its SSH target.')
          }
          const launch = mode === 'managed' ? undefined : input.launchUrl === undefined ? previous! : parseLaunchUrl(input.launchUrl)
          const autoConnect = input.autoConnect ?? previous?.autoConnect ?? (mode === 'managed' ? true : undefined)
          const record: ConnectionRecord = { id, name: input.name, target: input.target,
            ...(mode === undefined ? {} : { mode }), ...(autoConnect === undefined ? {} : { autoConnect }),
            ...(launch === undefined ? {} : { remotePort: launch.remotePort, token: launch.token }),
            ...(previous?.target === input.target && (previous.mode ?? 'existing') === (mode ?? 'existing') && previous.lastLocalPort !== undefined ? { lastLocalPort: previous.lastLocalPort } : {}),
          }
          return { kind: 'grant', payload: record }
        })
        if (result?.kind !== 'grant') throw new Error('The connection could not be saved.')
        return parseRecord(result.payload)
      })
    },
    async remove(id) {
      return serialize(id, async () => {
        // Delete any recognized legacy copy first; otherwise it could reappear
        // when the current record is removed after an interrupted migration.
        const legacy = await credentials.readRecord(legacyKey(id))
        if (legacy !== undefined) {
          try { decode(legacy, id); await credentials.deleteRecord(legacyKey(id)) }
          catch (error) { if (!(error instanceof InvalidConnectionRecord)) throw error }
        }
        await credentials.deleteRecord(key(id))
      })
    },
    async rememberPort(id, target, port) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid port.')
      return serialize(id, async () => {
        await credentials.modifyRecord(key(id), async current => {
          if (current?.kind !== 'grant') throw new Error('This connection no longer exists.')
          const previous = parseRecord(current.payload)
          if (previous.id !== id || previous.target !== target) throw new Error('This connection has changed.')
          return { kind: 'grant', payload: { ...previous, lastLocalPort: port } }
        })
      })
    },
  }
}
