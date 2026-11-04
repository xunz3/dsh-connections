import { createHash } from 'node:crypto'
import type { WorkspaceCatalog } from '../shared/workspace-protocol.js'

const fields = ['workspaces', 'sessions', 'archivedSessionIds', 'pinnedSessionIds'] as const
/** Hash precisely the original projected JSON, without allocating one complete
 * catalog-sized string. All row fields and native ordering still participate.
 * This remains O(N), and does not replace the authoritative native list. */
export function workspaceCatalogRevision(catalog: WorkspaceCatalog): string {
  const hash = createHash('sha256')
  hash.update('{')
  for (let field = 0; field < fields.length; field++) {
    const key = fields[field]!
    hash.update(`${field ? ',' : ''}"${key}":[`)
    const rows = catalog[key]
    // Small native-serialized batches avoid a hash.update/JSON call per session
    // while bounding large session-array strings. Never split JSON text inside a
    // Unicode surrogate pair; trim only the array's ASCII delimiters.
    for (let offset = 0; offset < rows.length; offset += 128) {
      if (offset) hash.update(',')
      hash.update(JSON.stringify(rows.slice(offset, offset + 128)).slice(1, -1))
    }
    hash.update(']')
  }
  hash.update('}')
  return hash.digest('base64url')
}
