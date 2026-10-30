/** Presentation and two browser capabilities owned by the surrounding Desktop/browser. */
export interface LocalPresentation {
  locale: string
  theme: {
    preference: 'light' | 'dark'
    fontSize: number; codeFontSize: number; terminalFontSize: number
    textFontFamily: string; codeFontFamily: string; terminalFontFamily: string
  }
  tokens: Record<string, string>
  general: {
    transcriptView: 'compact' | 'standard' | 'detailed' | 'verbose'
    collapseTiming: 'completion' | 'next-input'
    performanceUsage: 'compact' | 'detailed'
    linkOpening: 'sidebar' | 'new-tab'
    busyEnter: 'queue' | 'steer'
    developerTools: boolean
  }
}
export interface LoginAction { kind: 'openLogin' | 'copyLogin'; url: string }
export interface SurfaceRequest { id: string; revision: number; action: LoginAction }
export interface SurfaceAck { id: string; ok: boolean }
export interface SurfaceSnapshot { nativeVersion: string; presentation?: LocalPresentation }
export type SurfaceActionResult = { status: 'pending' | 'done' | 'failed' }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid view surface data')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError('Invalid view surface text')
  return value
}
export function parseLocalPresentation(value: unknown): LocalPresentation {
  const input = object(value), theme = object(input.theme), tokens = object(input.tokens), general = object(input.general)
  const locale = text(input.locale, 64)
  if (!/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(locale)) throw new TypeError('Invalid locale')
  if (theme.preference !== 'light' && theme.preference !== 'dark') throw new TypeError('Invalid theme')
  const size = (key: string, max: number): number => {
    const n = theme[key]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 10 || n > max) throw new TypeError('Invalid font size')
    return n
  }
  if (Object.keys(tokens).length > 512) throw new TypeError('Too many theme tokens')
  const accepted: Record<string, string> = {}
  for (const [key, value] of Object.entries(tokens)) {
    // A third-party palette may contain an unsupported token. Keep the native
    // remote fallback for that token instead of failing the whole document.
    if (!/^--dsw-[a-z0-9-]{1,110}$/.test(key) || typeof value !== 'string'
      || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) continue
    const token = value
    // Native alias values are colors/lengths; no URL-fetching CSS crosses hosts.
    if (/[;{}]|url\s*\(|@import/i.test(token)) continue
    accepted[key] = token
  }
  const choice = <T extends string>(key: string, allowed: readonly T[]): T => {
    if (!allowed.includes(general[key] as T)) throw new TypeError('Invalid general preference')
    return general[key] as T
  }
  if (typeof general.developerTools !== 'boolean') throw new TypeError('Invalid developer tools preference')
  return { locale, general: {
    transcriptView: choice('transcriptView', ['compact', 'standard', 'detailed', 'verbose']),
    collapseTiming: choice('collapseTiming', ['completion', 'next-input']),
    performanceUsage: choice('performanceUsage', ['compact', 'detailed']),
    linkOpening: choice('linkOpening', ['sidebar', 'new-tab']), busyEnter: choice('busyEnter', ['queue', 'steer']), developerTools: general.developerTools,
  }, theme: { preference: theme.preference, fontSize: size('fontSize', 22), codeFontSize: size('codeFontSize', 16), terminalFontSize: size('terminalFontSize', 20),
    textFontFamily: text(theme.textFontFamily, 512), codeFontFamily: text(theme.codeFontFamily, 512), terminalFontFamily: text(theme.terminalFontFamily, 512) }, tokens: accepted }
}
export function parseLoginAction(value: unknown): LoginAction {
  const input = object(value)
  if (input.kind !== 'openLogin' && input.kind !== 'copyLogin') throw new TypeError('Invalid login capability')
  const url = text(input.url, 8192), parsed = new URL(url)
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new TypeError('Invalid login URL')
  return { kind: input.kind, url }
}
export function parseSurfaceSnapshot(value: unknown): SurfaceSnapshot {
  const input = object(value)
  return { nativeVersion: text(input.nativeVersion, 64), ...(input.presentation === undefined ? {} : { presentation: parseLocalPresentation(input.presentation) }) }
}
export function parseSurfaceActionResult(value: unknown): SurfaceActionResult {
  const input = object(value)
  if (!['pending', 'done', 'failed'].includes(String(input.status))) throw new TypeError('Invalid surface result')
  return { status: input.status as SurfaceActionResult['status'] }
}
