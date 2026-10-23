import { randomUUID } from 'node:crypto'
import { credentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ConnectionRecord, SaveConnection } from '../shared/types.js'
import { parseId, parseLaunchUrl, parseRecord, parseSave } from '../shared/validation.js'

export interface ConnectionStore {
  list(): Promise<ConnectionRecord[]>
  read(id: string): Promise<ConnectionRecord | undefined>
  save(input: SaveConnection): Promise<ConnectionRecord>
  remove(id: string): Promise<void>
}

type Credentials = Pick<CredentialProvider, 'listRecords' | 'readRecord' | 'modifyRecord' | 'deleteRecord'>
const key = (id: string) => credentialKey('connections', parseId(id))

/** Connections and their launch credentials are one native, atomic credential record. */
export function createStore(credentials: Credentials): ConnectionStore {
  const read: ConnectionStore['read'] = async id => {
    const record = await credentials.readRecord(key(id))
    if (record === undefined) return undefined
    if (record.kind !== 'grant') throw new Error('The saved connection record is invalid.')
    const parsed = parseRecord(record.payload)
    if (parsed.id !== id) throw new Error('The saved connection identity is invalid.')
    return parsed
  }
  return {
    read,
    async list() {
      const entries = await credentials.listRecords()
      const ids = entries.filter(entry => entry.key.startsWith('connections/connection-')).map(entry => parseId(entry.key.slice('connections/'.length)))
      if (ids.length > 100) throw new Error('At most 100 saved connections are supported.')
      const records = await Promise.all(ids.map(read))
      return records.filter((record): record is ConnectionRecord => record !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    },
    async save(value) {
      const input = parseSave(value)
      const id = input.id ?? `connection-${randomUUID()}`
      const result = await credentials.modifyRecord(key(id), async current => {
        let previous: ConnectionRecord | undefined
        if (current !== undefined) {
          if (current.kind !== 'grant') throw new Error('The saved connection record is invalid.')
          previous = parseRecord(current.payload)
          if (previous.id !== id) throw new Error('The saved connection identity is invalid.')
        }
        if (input.id !== undefined && previous === undefined) throw new Error('This connection no longer exists.')
        if (input.launchUrl === undefined && (previous === undefined || previous.target !== input.target)) {
          throw new Error('Paste a fresh Harness launch URL when adding a connection or changing its SSH target.')
        }
        const launch = input.launchUrl === undefined ? previous! : parseLaunchUrl(input.launchUrl)
        const record: ConnectionRecord = { id, name: input.name, target: input.target, remotePort: launch.remotePort, token: launch.token }
        return { kind: 'grant', payload: record }
      })
      if (result?.kind !== 'grant') throw new Error('The connection could not be saved.')
      return parseRecord(result.payload)
    },
    async remove(id) { await credentials.deleteRecord(key(id)) },
  }
}
