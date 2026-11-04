import { createHash, randomUUID } from 'node:crypto'
import { serialize as serializeRecord } from 'node:v8'
import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { ConnectionDiagnostic, ConnectionDiagnosticsApi, ConnectionDiagnosticScope, ConnectionRecord, SaveConnection } from '../shared/types.js'
import { parseDeleteDiagnostic, parseDiagnosticRef, parseId, parseLaunchUrl, parseRecord, parseSave } from '../shared/validation.js'

export interface ConnectionStore {
  diagnostics?: ConnectionDiagnosticsApi
  list(): Promise<ConnectionRecord[]>
  read(id: string): Promise<ConnectionRecord | undefined>
  save(input: SaveConnection): Promise<ConnectionRecord>
  /** Change only the persistent connection intent, preserving concurrent metadata edits. */
  setAutoConnect(id: string, enabled: boolean): Promise<ConnectionRecord>
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
// across this process's stores using the same provider object, not other writers.
const providerOperations = new WeakMap<Credentials, Map<string, Promise<unknown>>>()
interface DiagnosticReceipt {
  id: string
  scope: ConnectionDiagnosticScope
  digest?: string
  expires: number
  exported: boolean
}
const providerReceipts = new WeakMap<Credentials, Map<string, DiagnosticReceipt>>()
const RECEIPT_TTL = 10 * 60_000
const scopedKey = (id: string, scope: ConnectionDiagnosticScope) => scope === 'current' ? key(id) : legacyKey(id)

// Hash the entire native record, not its decoded (lossy) projection. Keep the
// digest only in Host memory behind a random receipt. Nonserializable or huge
// records remain diagnosable, but are never eligible for deletion.
function recordDigest(record: CredentialRecord): string | undefined {
  try {
    // Native JSON-like data only. V8 serialization can omit custom properties
    // on exotic objects; never treat such a lossy digest as deletion evidence.
    const ancestors = new Set<object>()
    let budget = 1024 * 1024
    const safe = (value: unknown, depth: number): boolean => {
      if (--budget < 0 || depth > 64) return false
      if (value === null || value === undefined || typeof value === 'boolean') return true
      if (typeof value === 'number') return Number.isFinite(value)
      if (typeof value === 'string') { budget -= value.length; return budget >= 0 }
      if (typeof value !== 'object' || ancestors.has(value)) return false
      const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
      if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) return false
      ancestors.add(value)
      for (const property of Reflect.ownKeys(value)) {
        if (typeof property !== 'string') return false
        if (array && property === 'length') continue
        budget -= property.length
        const descriptor = Object.getOwnPropertyDescriptor(value, property)!
        if (!descriptor.enumerable || !('value' in descriptor) || !safe(descriptor.value, depth + 1)) return false
      }
      ancestors.delete(value)
      return budget >= 0
    }
    if (!safe(record, 0)) return undefined
    const bytes = serializeRecord(record)
    if (bytes.byteLength > 1024 * 1024) return undefined
    return createHash('sha256').update(bytes).digest('hex')
  } catch { return undefined }
}
function invalid(record: CredentialRecord, id: string): boolean {
  try { decode(record, id); return false }
  catch (error) { if (error instanceof InvalidConnectionRecord) return true; throw error }
}

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

/** Connections and their launch credentials share one native credential record. */
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
    if (record !== undefined) {
      const parsed = decode(record, id)
      // A valid destination proves this id belongs to Connections. Finish an
      // interrupted migration even when its obsolete copy became damaged.
      if (await credentials.readRecord(legacyKey(id)) !== undefined) await credentials.deleteRecord(legacyKey(id))
      return parsed
    }
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
  let receipts = providerReceipts.get(credentials)
  if (!receipts) { receipts = new Map(); providerReceipts.set(credentials, receipts) }
  const pruneReceipts = () => {
    for (const [receipt, value] of receipts) if (value.expires <= Date.now()) receipts.delete(receipt)
    while (receipts.size >= 1000) receipts.delete(receipts.keys().next().value!)
  }
  const receiptFor = (input: { id: string; scope: ConnectionDiagnosticScope; receipt: string }) => {
    const saved = receipts.get(input.receipt)
    return saved && saved.expires > Date.now() && saved.id === input.id && saved.scope === input.scope ? saved : undefined
  }
  const diagnostics: ConnectionDiagnosticsApi = {
    async list() {
      try {
        pruneReceipts()
        const entries = await credentials.listRecords()
        const seen = new Set<string>(), records: ConnectionDiagnostic[] = []
        for (const entry of entries) {
          const id = connectionId(entry.key)
          if (id === undefined || seen.has(entry.key)) continue
          seen.add(entry.key)
          const scope = entry.key === key(id) ? 'current' : 'legacy'
          // Deliberately do not call read/readCurrent: diagnostics never migrate,
          // normalize, or remove a current/legacy credential as a side effect.
          const found = await serialize<ConnectionDiagnostic | undefined>(id, async () => {
            const record = await credentials.readRecord(scopedKey(id, scope))
            if (record === undefined || !invalid(record, id)) return undefined
            const digest = recordDigest(record), receipt = randomUUID()
            pruneReceipts()
            receipts.set(receipt, { id, scope, digest, expires: Date.now() + RECEIPT_TTL, exported: false })
            return { id, scope, receipt, issue: 'invalid-record' as const, canDelete: digest !== undefined }
          })
          if (!found) continue
          if (records.length === 200) return { records, truncated: true }
          records.push(found)
        }
        return { records, truncated: false }
      } catch { throw new Error('Connection record diagnostics are unavailable.') }
    },
    async export(value) {
      const input = parseDiagnosticRef(value)
      return serialize(input.id, async () => {
        try {
          const saved = receiptFor(input)
          if (!saved) return { ok: false, code: 'STALE' }
          const record = await credentials.readRecord(scopedKey(input.id, input.scope))
          if (record === undefined || !invalid(record, input.id)) return { ok: false, code: 'STALE' }
          const digest = recordDigest(record)
          if (saved.digest !== undefined && digest !== saved.digest) return { ok: false, code: digest === undefined ? 'UNSAFE_RECORD' : 'STALE' }
          // A redacted report is not a recoverable credential backup. Export is
          // still useful for unsafe-to-hash records, but never enables cleanup.
          saved.exported = saved.digest !== undefined
          return { ok: true, value: { format: 'connections-redacted-diagnostic-v1', redacted: true, credentialBackup: false,
            concurrency: 'same-process-provider-queue-only', record: { id: input.id, scope: input.scope, issue: 'invalid-record', canDelete: saved.exported } } }
        } catch { return { ok: false, code: 'UNAVAILABLE' } }
      })
    },
    async remove(value) {
      const input = parseDeleteDiagnostic(value)
      return serialize(input.id, async () => {
        const saved = receiptFor(input)
        if (!saved) return { ok: false, code: 'STALE' }
        if (saved.digest === undefined) return { ok: false, code: 'UNSAFE_RECORD' }
        if (!saved.exported) return { ok: false, code: 'EXPORT_REQUIRED' }
        // Consume before I/O: an uncertain provider failure must not be retried
        // under the same receipt. Refresh and export again instead.
        receipts.delete(input.receipt)
        try {
          const record = await credentials.readRecord(scopedKey(input.id, input.scope))
          if (record === undefined || !invalid(record, input.id)) return { ok: false, code: 'STALE' }
          const digest = recordDigest(record)
          if (digest === undefined) return { ok: false, code: 'UNSAFE_RECORD' }
          if (digest !== saved.digest || saved.expires <= Date.now()) return { ok: false, code: 'STALE' }
          // CredentialProvider has no compare-and-delete. This recheck and delete
          // share only this process's per-id queue for this provider object. A
          // different process/provider can still race between these awaits.
          await credentials.deleteRecord(scopedKey(input.id, input.scope))
          return { ok: true, value: { deleted: true } }
        } catch { return { ok: false, code: 'UNAVAILABLE' } }
      })
    },
  }
  return {
    diagnostics,
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
    async setAutoConnect(id, enabled) {
      if (typeof enabled !== 'boolean') throw new TypeError('Expected a boolean.')
      return serialize(id, async () => {
        await readCurrent(id)
        const result = await credentials.modifyRecord(key(id), async current => {
          if (current === undefined) throw new Error('This connection no longer exists.')
          const previous = decode(current, id)
          return previous.autoConnect === enabled ? current : { kind: 'grant', payload: { ...previous, autoConnect: enabled } }
        })
        if (result === undefined) throw new Error('The connection could not be saved.')
        return decode(result, id)
      })
    },
    async remove(id) {
      return serialize(id, async () => {
        // Explicit removal includes damaged legacy copies at this exact id.
        // Delete the legacy copy first; otherwise it could reappear
        // when the current record is removed after an interrupted migration.
        await credentials.deleteRecord(legacyKey(id))
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
