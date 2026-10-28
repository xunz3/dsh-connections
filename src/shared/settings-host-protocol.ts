import { parseId } from './validation.js'

export interface SettingsHostChoice {
  id: string
  name: string
  phase: 'connected' | 'connecting' | 'disconnected' | 'error' | 'updating'
}
export interface SettingsHostSnapshot {
  choices: readonly SettingsHostChoice[]
  selectedId: string
}
export interface SettingsHostExchange {
  revision: number
  snapshot?: SettingsHostSnapshot
  /** The embedded settings operation has requested the published menu. */
  ready?: true
  /** A settings operation can select another host only once. */
  selection?: string
}

const phases = new Set(['connected', 'connecting', 'disconnected', 'error', 'updating'])
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid settings host metadata')
  return value as Record<string, unknown>
}
export function parseSettingsHostId(value: unknown): string { return value === 'local' ? value : parseId(value) }

/** Only menu metadata crosses documents; never connection addresses, configuration or credentials. */
export function parseSettingsHostSnapshot(value: unknown): SettingsHostSnapshot {
  const input = record(value)
  if (!Array.isArray(input.choices) || input.choices.length > 101) throw new TypeError('Invalid settings host metadata')
  const ids = new Set<string>()
  const choices = input.choices.map(value => {
    const row = record(value)
    if (typeof row.name !== 'string' || row.name.length > 200 || /[\x00-\x1f\x7f]/.test(row.name)
      || !phases.has(String(row.phase))) throw new TypeError('Invalid settings host choice')
    const id = parseSettingsHostId(row.id)
    if (ids.has(id)) throw new TypeError('Duplicate settings host choice')
    ids.add(id)
    return { id, name: row.name, phase: row.phase as SettingsHostChoice['phase'] }
  })
  const selectedId = parseSettingsHostId(input.selectedId)
  if (!ids.has('local') || !ids.has(selectedId)) throw new TypeError('Invalid selected settings host')
  return { choices, selectedId }
}

export function parseSettingsHostExchange(value: unknown): SettingsHostExchange {
  const input = record(value)
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) throw new TypeError('Invalid settings revision')
  const snapshot = input.snapshot === undefined ? undefined : parseSettingsHostSnapshot(input.snapshot)
  if (input.ready !== undefined && (input.ready !== true || snapshot === undefined)) throw new TypeError('Invalid settings readiness')
  const selection = input.selection === undefined ? undefined : parseSettingsHostId(input.selection)
  if (selection !== undefined && (!snapshot?.choices.some(row => row.id === selection) || selection === snapshot.selectedId)) throw new TypeError('Invalid settings host selection')
  return { revision: input.revision as number, ...(snapshot ? { snapshot } : {}), ...(input.ready === true ? { ready: true } : {}), ...(selection === undefined ? {} : { selection }) }
}
