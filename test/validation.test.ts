import test from 'node:test'
import assert from 'node:assert/strict'
import { parseId, parseLaunchUrl, parseOpenResult, parseSave, parseTarget, parseView } from '../src/shared/validation.js'

const id = 'connection-a54d0a10-1234-4567-abcd-123456789012'
const token = 'a-valid-launch-token-with-enough-entropy'
test('SSH inputs are destinations, not command lines', () => {
  for (const input of ['Dev', 'ICT_IGL16', 'user@server.example.com', 'my-server']) assert.equal(parseTarget(input), input)
  for (const input of ['-oProxyCommand=id', 'user@host -p 22', 'x;id', '$(id)', '`id`', 'x\ny', 'ssh://host', '../host', 'host:22']) assert.throws(() => parseTarget(input))
  assert.equal(parseId(id), id)
  assert.throws(() => parseId('../credentials'))
})
test('launch credential admission only accepts the remote Harness loopback root', () => {
  assert.deepEqual(parseLaunchUrl(`http://127.0.0.1:3010/?token=${token}`), { remotePort: 3010, token })
  assert.deepEqual(parseLaunchUrl(`http://localhost:3010/?token=${token}`), { remotePort: 3010, token })
  for (const value of [`https://evil.test/?token=${token}`, `http://127.0.0.1.evil.test/?token=${token}`, `http://user@127.0.0.1:3/?token=${token}`, `http://127.0.0.1:3/path?token=${token}`, `http://127.0.0.1:3/?token=${token}&token=another`, `http://127.0.0.1:3/?token=${token}#fragment`, 'http://127.0.0.1:3/?token=short']) {
    assert.throws(() => parseLaunchUrl(value), error => error instanceof Error && !error.message.includes(token))
  }
})
test('wire projections discard private fields and normalize the only open URL', () => {
  const view = parseView({ id, name: 'Server', target: 'Dev', remotePort: 3010, phase: 'connected', localPort: 4000, token, launchUrl: 'secret', nested: { token } })
  assert.equal(JSON.stringify(view).includes(token), false)
  assert.deepEqual(parseOpenResult({ url: `http://localhost:4000/?token=${token}` }), { url: `http://127.0.0.1:4000/?token=${token}` })
  assert.deepEqual(parseSave({ id, name: ' Work ', target: 'Dev', unexpected: token }), { id, name: 'Work', target: 'Dev' })
})
