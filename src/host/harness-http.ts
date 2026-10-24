import { createHash } from 'node:crypto'
import { request } from 'node:http'
import type { ClientRequest, IncomingMessage } from 'node:http'
import {
  WORKSPACE_ENDPOINT, WORKSPACE_REQUEST_LIMIT, WORKSPACE_RESPONSE_LIMIT,
  parseWorkspaceRequest, parseWorkspaceResponse,
} from '../shared/workspace-protocol.js'

const authenticationError = () => new Error('Harness authentication failed. Check the running remote Host and update its launch URL.')
const unreachable = 'The remote workspace could not be reached. Reconnect and try again.'
const invalidResponse = 'The remote Host returned an invalid workspace response.'
const missingPlugin = 'This Host needs the Connections workspace plugin. Update its managed workspace support, or install the plugin in its dedicated profile.'
const expiredAuthorization = 'The remote workspace authorization expired. Reconnect and try again.'

function validPort(port: number): boolean { return Number.isInteger(port) && port >= 1 && port <= 65535 }
function cookieName(port: number): string {
  return `dsh-auth-${createHash('sha256').update(`127.0.0.1:${port}`).digest('base64url')}`
}
function base64url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  const bytes = Buffer.from(value, 'base64url')
  return bytes.toString('base64url') === value ? bytes : undefined
}
/** Check the native v1 owner-cookie shape and audience; only the remote Host can verify its MAC. */
function validCookiePair(pair: string, port: number): boolean {
  if (pair.length > 4096 || !pair.startsWith(`${cookieName(port)}=`)) return false
  const parts = pair.slice(cookieName(port).length + 1).split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return false
  const body = base64url(parts[1]!)
  const signature = base64url(parts[2]!)
  if (!body || signature?.byteLength !== 32) return false
  try {
    const payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>
    return payload !== null && !Array.isArray(payload) && payload.version === 1
      && payload.authority === `127.0.0.1:${port}`
      && Number.isSafeInteger(payload.issuedAt) && Number.isSafeInteger(payload.expiresAt)
      && (payload.issuedAt as number) >= 0 && (payload.expiresAt as number) > (payload.issuedAt as number)
  } catch { return false }
}
function ownerCookie(response: IncomingMessage, port: number): string | undefined {
  const cookies = response.headers['set-cookie']?.filter(value => value.startsWith(`${cookieName(port)}=`))
  if (cookies?.length !== 1) return undefined
  const [pair, ...segments] = cookies[0]!.split(';')
  if (!pair || !validCookiePair(pair, port)) return undefined
  const attributes = new Map<string, string | undefined>()
  for (const segment of segments) {
    const at = segment.indexOf('=')
    const key = (at === -1 ? segment : segment.slice(0, at)).trim().toLowerCase()
    const value = at === -1 ? undefined : segment.slice(at + 1).trim()
    if (!key || attributes.has(key)) return undefined
    attributes.set(key, value)
  }
  if (attributes.get('path') !== '/' || !attributes.has('httponly') || attributes.get('httponly') !== undefined
    || attributes.get('samesite')?.toLowerCase() !== 'strict' || attributes.has('domain') || attributes.has('secure')) return undefined
  if (attributes.has('max-age') && !/^[1-9][0-9]*$/.test(attributes.get('max-age') ?? '')) return undefined
  return pair
}

/** Exchange a launch credential only with an acknowledged, owned loopback tunnel. Never follow redirects. */
export async function authenticateHarness(port: number, token: string, signal: AbortSignal): Promise<string> {
  if (!validPort(port) || !/^[A-Za-z0-9_-]{20,512}$/.test(token) || signal.aborted) throw authenticationError()
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  return new Promise((resolve, reject) => {
    let settled = false
    let req: ClientRequest | undefined
    const fail = () => {
      if (settled) return
      settled = true
      req?.destroy()
      reject(authenticationError())
    }
    try {
      req = request({ hostname: '127.0.0.1', port, method: 'GET', path: `/?token=${encodeURIComponent(token)}`,
        signal: bounded, agent: false, maxHeaderSize: 16_384 }, response => {
        const pair = response.statusCode === 303 && response.headers.location === './' ? ownerCookie(response, port) : undefined
        if (!pair) { response.destroy(); fail(); return }
        settled = true
        response.destroy()
        resolve(pair)
      })
      req.once('error', fail)
      req.once('close', () => { if (!settled) fail() })
      req.end()
    } catch { fail() }
  })
}

/** One fixed owner endpoint, with typed inputs and bounded, projected responses. */
export async function requestWorkspace(port: number, cookie: string, value: unknown, signal: AbortSignal): Promise<unknown> {
  let input: ReturnType<typeof parseWorkspaceRequest>
  let payload: Buffer
  try {
    input = parseWorkspaceRequest(value)
    payload = Buffer.from(JSON.stringify(input))
  } catch { throw new Error('The workspace request is invalid.') }
  if (payload.byteLength > WORKSPACE_REQUEST_LIMIT) throw new Error('The workspace request is too large.')
  if (!validPort(port) || !validCookiePair(cookie, port) || signal.aborted) throw new Error(unreachable)
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  return new Promise((resolve, reject) => {
    let settled = false
    let req: ClientRequest | undefined
    let incoming: IncomingMessage | undefined
    const fail = (message = unreachable) => {
      if (settled) return
      settled = true
      incoming?.destroy()
      req?.destroy()
      reject(new Error(message))
    }
    try {
      req = request({ hostname: '127.0.0.1', port, method: 'POST', path: WORKSPACE_ENDPOINT,
        headers: { cookie, 'content-type': 'application/json', 'content-length': payload.byteLength },
        signal: bounded, agent: false, maxHeaderSize: 16_384 }, response => {
        incoming = response
        const status = response.statusCode ?? 0
        if (status === 401 || status === 403) { fail(expiredAuthorization); return }
        // Never honor Location, including redirects to another loopback authority.
        if (status >= 300 && status < 400) { fail(); return }
        if (response.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          fail(status === 404 ? missingPlugin : invalidResponse); return
        }
        const length = response.headers['content-length']
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > WORKSPACE_RESPONSE_LIMIT)) {
          fail('The remote workspace list is too large.'); return
        }
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          if (settled) return
          bytes += chunk.byteLength
          if (bytes > WORKSPACE_RESPONSE_LIMIT) { fail('The remote workspace list is too large.'); return }
          chunks.push(chunk)
        })
        response.once('aborted', () => fail())
        response.once('error', () => fail())
        response.once('close', () => { if (!response.complete) fail() })
        response.once('end', () => {
          if (settled) return
          try {
            if (!response.complete) { fail(); return }
            const result = parseWorkspaceResponse(input.op, JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')))
            if ((status === 200) !== result.ok) { fail(status === 404 ? missingPlugin : invalidResponse); return }
            settled = true
            resolve(result)
          } catch { fail(status === 404 ? missingPlugin : invalidResponse) }
        })
      })
      req.once('error', () => fail())
      req.once('close', () => { if (!incoming && !settled) fail() })
      req.end(payload)
    } catch { fail() }
  })
}
