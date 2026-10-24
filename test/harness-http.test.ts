import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'
import { authenticateHarness, requestWorkspace } from '../src/host/harness-http.js'
import { WORKSPACE_ENDPOINT, WORKSPACE_ERRORS, WORKSPACE_RESPONSE_LIMIT } from '../src/shared/workspace-protocol.js'

const token = 'private-launch-token-never-in-an-error'
const privateMessage = 'server-private-detail-never-in-an-error'
const signal = () => new AbortController().signal
const catalog = { ok: true, value: { workspaces: [], sessions: [], archivedSessionIds: [], pinnedSessionIds: [] } }

function ownerCookie(authority: string, override: Record<string, unknown> = {}): string {
  const name = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
  const payload = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, ...override })).toString('base64url')
  return `${name}=v1.${payload}.${Buffer.alloc(32, 7).toString('base64url')}`
}
const attributes = '; Max-Age=60; Path=/; HttpOnly; SameSite=Strict'
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const listener = createServer(handler)
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  return {
    port: address.port,
    async close() {
      listener.closeAllConnections()
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
    },
  }
}
function safeFailure(error: unknown): boolean {
  assert.ok(error instanceof Error)
  assert.equal(error.message.includes(token), false)
  assert.equal(error.message.includes(privateMessage), false)
  assert.equal(error.message.includes('dsh-auth-'), false)
  return true
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('native owner authentication accepts only its authority cookie and never follows a redirect', async () => {
  let destinationHits = 0
  const destination = await server((_request, response) => { destinationHits++; response.end() })
  let mode = 'valid'
  const requests: Array<{ method?: string; path?: string; host?: string }> = []
  const listener = await server((request, response) => {
    requests.push({ method: request.method, path: request.url, host: request.headers.host })
    const authority = request.headers.host!
    let cookie = ownerCookie(authority)
    let flags = attributes
    let cookies: string[] | undefined
    switch (mode) {
      case 'wrong-name': cookie = ownerCookie('localhost:1234'); break
      case 'wrong-audience': cookie = ownerCookie(authority, { authority: 'localhost:1234' }); break
      case 'non-owner': cookie = ownerCookie(authority, { version: 2 }).replace('=v1.', '=v2.'); break
      case 'fake-payload': cookie = `${cookie.split('=')[0]}=v1.payload.signature`; break
      case 'bad-times': cookie = ownerCookie(authority, { issuedAt: 100, expiresAt: 99 }); break
      case 'wrong-path': flags = flags.replace('Path=/', 'Path=/other'); break
      case 'domain': flags += '; Domain=127.0.0.1'; break
      case 'secure': flags += '; Secure'; break
      case 'not-http-only': flags = flags.replace('; HttpOnly', ''); break
      case 'not-strict': flags = flags.replace('Strict', 'Lax'); break
      case 'duplicate-attribute': flags += '; SameSite=Lax'; break
      case 'expired': flags = flags.replace('Max-Age=60', 'Max-Age=0'); break
      case 'duplicate-cookie': cookies = [cookie + flags, cookie + flags]; break
    }
    response.writeHead(mode === 'unauthorized' ? 401 : 303, {
      location: mode === 'redirect' ? `http://127.0.0.1:${destination.port}/?token=${token}` : './',
      'set-cookie': cookies ?? [cookie + flags, 'unrelated=ignored; HttpOnly; SameSite=Strict'],
    })
    response.end()
  })
  try {
    const cookie = await authenticateHarness(listener.port, token, signal())
    assert.match(cookie, /^dsh-auth-[A-Za-z0-9_-]{43}=v1\./)
    assert.equal(cookie.includes(';'), false)
    for (mode of ['wrong-name', 'wrong-audience', 'non-owner', 'fake-payload', 'bad-times', 'wrong-path', 'domain', 'secure', 'not-http-only', 'not-strict', 'duplicate-attribute', 'expired', 'duplicate-cookie', 'unauthorized', 'redirect']) {
      await assert.rejects(authenticateHarness(listener.port, token, signal()), safeFailure, mode)
    }
    assert.equal(destinationHits, 0)
    assert.equal(requests.length, 16)
    assert.ok(requests.every(row => row.method === 'GET' && row.path === `/?token=${token}` && row.host === `127.0.0.1:${listener.port}`))
  } finally { await listener.close(); await destination.close() }
})

test('workspace transport sends only a validated request to its fixed route and strips response extras', async () => {
  const requests: Array<{ method?: string; path?: string; host?: string; cookie?: string; type?: string; body: string }> = []
  const listener = await server((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      requests.push({ method: request.method, path: request.url, host: request.headers.host, cookie: request.headers.cookie, type: request.headers['content-type'], body: Buffer.concat(chunks).toString() })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ...catalog, privateToken: token, value: { ...catalog.value, privateToken: token } }))
    })
  })
  const cookie = ownerCookie(`127.0.0.1:${listener.port}`)
  try {
    assert.deepEqual(await requestWorkspace(listener.port, cookie, { op: 'catalog' }, signal()), catalog)
    assert.deepEqual(requests, [{ method: 'POST', path: WORKSPACE_ENDPOINT, host: `127.0.0.1:${listener.port}`, cookie, type: 'application/json', body: '{"op":"catalog"}' }])
    for (const input of [{ op: 'prompt', token }, { op: 'catalog', url: `https://example.invalid/${token}` }, { op: 'createDirectory', path: '/', name: '../elsewhere' }]) {
      await assert.rejects(requestWorkspace(listener.port, cookie, input, signal()), safeFailure)
    }
    await assert.rejects(requestWorkspace(listener.port, `${cookie}\r\nX-Token: ${token}`, { op: 'catalog' }, signal()), safeFailure)
    await assert.rejects(requestWorkspace(listener.port, ownerCookie(`127.0.0.1:${listener.port + 1}`), { op: 'catalog' }, signal()), safeFailure)
    const dangerous = { get op() { throw new Error(privateMessage) } }
    await assert.rejects(requestWorkspace(listener.port, cookie, dangerous, signal()), safeFailure)
    assert.equal(requests.length, 1)
  } finally { await listener.close() }
})

test('HTTP failure envelopes preserve safe native errors while redirects and credentials remain private', async () => {
  let mode = 'active'
  let destinationHits = 0
  const destination = await server((_request, response) => { destinationHits++; response.end() })
  const listener = await server((_request, response) => {
    switch (mode) {
      case 'active':
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, error: { code: 'SESSION_ACTIVE', message: privateMessage, token } })); return
      case 'not-found':
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: privateMessage } })); return
      case 'redirect': response.writeHead(307, { location: `http://127.0.0.1:${destination.port}/?token=${token}` }); break
      case 'unauthorized': response.writeHead(401); break
      case 'forbidden': response.writeHead(403); break
      case 'missing': response.writeHead(404, { 'content-type': 'text/plain' }); break
      case 'invalid': response.writeHead(200, { 'content-type': 'application/json' }); break
      case 'wrong-type': response.writeHead(200, { 'content-type': 'text/html' }); break
    }
    response.end(privateMessage)
  })
  const cookie = ownerCookie(`127.0.0.1:${listener.port}`)
  try {
    assert.deepEqual(await requestWorkspace(listener.port, cookie, { op: 'catalog' }, signal()), { ok: false, error: { code: 'SESSION_ACTIVE', message: WORKSPACE_ERRORS.SESSION_ACTIVE } })
    mode = 'not-found'
    assert.deepEqual(await requestWorkspace(listener.port, cookie, { op: 'viewState', channel: 'a'.repeat(43) }, signal()), { ok: false, error: { code: 'NOT_FOUND', message: WORKSPACE_ERRORS.NOT_FOUND } })
    for (mode of ['redirect', 'unauthorized', 'forbidden', 'missing', 'invalid', 'wrong-type']) {
      await assert.rejects(requestWorkspace(listener.port, cookie, { op: 'catalog' }, signal()), safeFailure, mode)
    }
    assert.equal(destinationHits, 0)
  } finally { await listener.close(); await destination.close() }
})

test('oversized and prematurely disconnected workspace responses are rejected promptly', async () => {
  let mode = 'declared-large'
  const listener = await server((_request, response) => {
    if (mode === 'before-headers') { response.destroy(); return }
    response.writeHead(200, {
      'content-type': 'application/json',
      ...(mode === 'declared-large' ? { 'content-length': WORKSPACE_RESPONSE_LIMIT + 1 } : {}),
    })
    if (mode === 'declared-large') { response.flushHeaders(); return }
    if (mode === 'chunked-large') { response.end(Buffer.alloc(WORKSPACE_RESPONSE_LIMIT + 1, 32)); return }
    response.write('{"ok":')
    setImmediate(() => response.destroy())
  })
  const cookie = ownerCookie(`127.0.0.1:${listener.port}`)
  try {
    for (mode of ['declared-large', 'chunked-large', 'partial-body', 'before-headers']) {
      const started = Date.now()
      await assert.rejects(requestWorkspace(listener.port, cookie, { op: 'catalog' }, signal()), safeFailure, mode)
      assert.ok(Date.now() - started < 3000, `${mode} must reject before the transport timeout`)
    }
  } finally { await listener.close() }
})

test('aborting authentication or a workspace long poll closes the request without exposing abort reasons', async () => {
  for (const kind of ['authentication', 'workspace'] as const) {
    const received = deferred()
    const closed = deferred()
    const listener = await server((request, response) => {
      if (kind === 'workspace') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"ok":') }
      request.socket.once('close', closed.resolve)
      received.resolve()
    })
    const cookie = ownerCookie(`127.0.0.1:${listener.port}`)
    const controller = new AbortController()
    const run = () => kind === 'authentication' ? authenticateHarness(listener.port, token, controller.signal) : requestWorkspace(listener.port, cookie, { op: 'catalog' }, controller.signal)
    try {
      const pending = run()
      const rejected = assert.rejects(pending, safeFailure)
      await received.promise
      controller.abort(new Error(`${privateMessage} ${token}`))
      await rejected
      await closed.promise
      await assert.rejects(run(), safeFailure)
    } finally { await listener.close() }
  }
})
