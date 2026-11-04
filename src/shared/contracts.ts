import versions from './contracts.json' with { type: 'json' }

/** Plugin-owned seams, not a claim about a future Harness runtime's private APIs.
 * 0 means absent: the local sidebar is native and no event/control peer exists. */
export const CONNECTION_CONTRACTS: Readonly<ConnectionContracts> = Object.freeze({ ...versions })
export interface ConnectionContracts {
  schema: number
  sidebarAdapter: number
  shortcutRegistry: number
  settingsFactory: number
  accountFactory: number
  workspaceProtocol: number
  viewSurfaceProtocol: number
  remoteEventProtocol: number
}
const fields = Object.keys(versions) as Array<keyof ConnectionContracts>

export function parseConnectionContracts(value: unknown): ConnectionContracts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Connections contracts.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== fields.length || Object.keys(input).some(key => !fields.includes(key as keyof ConnectionContracts))) {
    throw new TypeError('Invalid Connections contracts.')
  }
  const result = {} as ConnectionContracts
  for (const key of fields) {
    const version = input[key]
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0 || version > 1_000_000) throw new TypeError('Invalid Connections contracts.')
    result[key] = version
  }
  return result
}

/** Only the seams consumed by this remote surface are requirements. Local
 * shortcut/sidebar revisions and an optional future event plane do not gate it. */
const remoteFields: Array<keyof ConnectionContracts> = ['schema', 'settingsFactory', 'accountFactory', 'workspaceProtocol', 'viewSurfaceProtocol']
/** Fail closed for remote content only; caller retains native navigation/management. */
export function matchingConnectionContracts(value: unknown): boolean {
  try {
    const remote = parseConnectionContracts(value)
    return remoteFields.every(key => remote[key] === CONNECTION_CONTRACTS[key])
  } catch { return false }
}
