import { parseOpenResult } from '../shared/validation.js'

/** Desktop guests own their origin; browser frames require same-site IPv4 forwarding. */
export function isWorkspaceSurface(page: Pick<Location, 'protocol' | 'hostname'>, desktop = false): boolean {
  return desktop || page.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(page.hostname)
}

/** Keep native Strict cookies first-party (desktop guest) or same-site (web iframe). */
export function workspaceUrl(value: string, page: Pick<Location, 'protocol' | 'hostname'>, desktop: boolean): string {
  const { url } = parseOpenResult({ url: value })
  if (!isWorkspaceSurface(page, desktop)) throw new Error('unsupported-workspace-surface')
  if (desktop) return url
  const target = new URL(url)
  target.hostname = page.hostname
  return target.href
}
