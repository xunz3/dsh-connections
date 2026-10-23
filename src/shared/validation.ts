import type { ConnectionRecord, ConnectionView, SaveConnection } from './types.js'

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected an object.')
  return value as Record<string, unknown>
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError('Invalid text value.')
  return value
}

export function parseId(value: unknown): string {
  const id = text(value, 64)
  if (!/^connection-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new TypeError('Invalid connection identifier.')
  return id
}

export function parseTarget(value: unknown): string {
  const target = text(value, 253).trim()
  // SSH destination only. Ports, keys and jump hosts belong in ~/.ssh/config.
  if (!/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(target)) throw new TypeError('Use an SSH alias or user@hostname; put ports and options in SSH config.')
  return target
}

function port(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) throw new TypeError('Invalid port.')
  return value
}

function token(value: unknown): string {
  const result = text(value, 512)
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(result)) throw new TypeError('Invalid Harness launch credential.')
  return result
}

export function parseLaunchUrl(value: unknown): { remotePort: number; token: string } {
  try {
    const raw = text(value, 1024).trim()
    const url = new URL(raw)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.hash || [...url.searchParams.keys()].length !== 1 || !url.searchParams.has('token')) throw new Error()
    return { remotePort: port(Number(url.port || 80)), token: token(url.searchParams.get('token')) }
  } catch {
    // Never include the submitted URL: it is a credential.
    throw new TypeError('Paste the remote Harness launch URL: http://127.0.0.1:PORT/?token=…')
  }
}

export function parseSave(value: unknown): SaveConnection {
  const input = object(value)
  const name = text(input.name, 80).trim()
  if (!name) throw new TypeError('Enter a connection name.')
  const result: SaveConnection = { name, target: parseTarget(input.target) }
  if (input.id !== undefined) result.id = parseId(input.id)
  if (input.launchUrl !== undefined) {
    parseLaunchUrl(input.launchUrl)
    result.launchUrl = (input.launchUrl as string).trim()
  }
  return result
}

export function parseRecord(value: unknown): ConnectionRecord {
  const input = object(value)
  return { id: parseId(input.id), name: text(input.name, 80), target: parseTarget(input.target), remotePort: port(input.remotePort), token: token(input.token) }
}

export function parseView(value: unknown): ConnectionView {
  const input = object(value)
  const phase = input.phase
  if (phase !== 'disconnected' && phase !== 'connecting' && phase !== 'connected' && phase !== 'error') throw new TypeError('Invalid connection state.')
  return {
    id: parseId(input.id), name: text(input.name, 80), target: parseTarget(input.target), remotePort: port(input.remotePort), phase,
    ...(input.localPort === undefined ? {} : { localPort: port(input.localPort) }),
    ...(input.error === undefined ? {} : { error: text(input.error, 1000) }),
  }
}

export function parseViews(value: unknown): ConnectionView[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError('Invalid connections list.')
  return value.map(parseView)
}

export function parseOpenResult(value: unknown): { url: string } {
  const input = object(value)
  const parsed = parseLaunchUrl(input.url)
  // Reconstruct, rather than returning an arbitrary remote-supplied link.
  return { url: `http://127.0.0.1:${parsed.remotePort}/?token=${encodeURIComponent(parsed.token)}` }
}
