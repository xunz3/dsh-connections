import test from 'node:test'
import assert from 'node:assert/strict'
import { LATEST_SUPPORTED_REMOTE_VERSION, parseId, parseLaunchUrl, parseOpenResult, parseSave, parseSshCheck, parseSshHosts, parseSupportedVersion, parseTarget, parseUpdate, parseVersion, parseView, SUPPORTED_REMOTE_VERSIONS } from '../src/shared/validation.js'

const id = 'connection-a54d0a10-1234-4567-abcd-123456789012'
const token = 'a-valid-launch-token-with-enough-entropy'
test('only validated remote runtimes are install targets while observed versions remain parseable', () => {
  assert.deepEqual(parseUpdate({ id }), { id }, 'omitting a version requests the latest compatible release')
  assert.equal(LATEST_SUPPORTED_REMOTE_VERSION, '0.2.1-rc.3')
  for (const version of SUPPORTED_REMOTE_VERSIONS) {
    assert.equal(parseSupportedVersion(version), version)
    assert.deepEqual(parseUpdate({ id, version }), { id, version })
  }
  for (const version of ['0.2.1-rc.1', '0.2.1-rc.4', '0.2.2', 'latest', '^0.2.1', '0.3.0']) assert.throws(() => parseUpdate({ id, version }), TypeError)
  assert.equal(parseVersion('0.2.1-rc.1'), '0.2.1-rc.1')
})
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
test('SSH discovery admits only bounded literal destinations across the RPC boundary', () => {
  assert.deepEqual(parseSshHosts(['Dev', 'work', 'Dev']), ['Dev', 'work'])
  for (const value of [{ hosts: ['dev'] }, ['dev', { target: 'other', key: 'private' }], ['*'], ['!dev'], ['-oProxyCommand=id'], Array(1001).fill('dev')]) {
    assert.throws(() => parseSshHosts(value), TypeError)
  }
})
test('wire projections discard private fields and normalize the only open URL', () => {
  const view = parseView({ id, name: 'Server', target: 'Dev', remotePort: 3010, phase: 'connected', localPort: 4000, token, launchUrl: 'secret', nested: { token } })
  assert.equal(JSON.stringify(view).includes(token), false)
  assert.deepEqual(parseOpenResult({ url: `http://localhost:4000/?token=${token}` }), { url: `http://127.0.0.1:4000/?token=${token}` })
  assert.deepEqual(parseSave({ id, name: ' Work ', target: 'Dev', unexpected: token }), { id, name: 'Work', target: 'Dev' })
})
test('SSH checks expose only allowlisted outcomes and connection stages remain transient', () => {
  assert.deepEqual(parseSshCheck({ ok: true, stdout: token }), { ok: true })
  assert.deepEqual(parseSshCheck({ ok: false, code: 'SSH_AUTH', stderr: token }), { ok: false, code: 'SSH_AUTH' })
  for (const value of [{ ok: false, code: token }, { ok: 'true' }, { ok: false }, null]) assert.throws(() => parseSshCheck(value), TypeError)
  const base = { id, name: 'Work', target: 'dev', phase: 'connecting' }
  for (const stage of ['preparing', 'tunnel', 'authenticating']) assert.equal(parseView({ ...base, stage }).stage, stage)
  assert.throws(() => parseView({ ...base, stage: token }), /stage/)
  for (const phase of ['connected', 'error', 'disconnected']) assert.throws(() => parseView({ ...base, phase, stage: 'preparing' }), /stage/)
})
