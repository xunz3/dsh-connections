import { parseOpenResult } from '../shared/validation.js'

/** SSH forwarding currently binds IPv4. Keep settings and content eligibility identical. */
export function isWorkspaceSurface(page: Pick<Location, 'protocol' | 'hostname'>): boolean {
  return page.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(page.hostname)
}

/** Keep native Strict cookies first-party (desktop guest) or same-site (web iframe). */
export function workspaceUrl(value: string, page: Pick<Location, 'protocol' | 'hostname'>, desktop: boolean): string {
  const { url } = parseOpenResult({ url: value })
  if (desktop) return url
  if (!isWorkspaceSurface(page)) throw new Error('unsupported-workspace-surface')
  const target = new URL(url)
  target.hostname = page.hostname
  return target.href
}
