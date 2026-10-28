import assert from 'node:assert/strict'
import test from 'node:test'
import { metadata, releasePlan } from '../scripts/release.js'

test('release planning skips published versions and keeps prereleases off latest', () => {
  const registry = { versions: { '0.1.0': {} }, 'dist-tags': { latest: '0.1.0' } }
  assert.deepEqual(releasePlan('0.1.0', registry), { publish: false, tag: 'latest' })
  assert.deepEqual(releasePlan('0.2.0-rc.0', registry), { publish: true, tag: 'next' })
  assert.deepEqual(releasePlan('0.1.1', registry), { publish: true, tag: 'latest' })
  assert.throws(() => releasePlan('0.0.9', registry), /backwards/)
  for (const version of ['latest', '1.01.0', '1.0.0-01', '1.0.0+build']) assert.throws(() => releasePlan(version, registry))
})

test('first stable release can replace a bootstrap prerelease on latest without downgrading', () => {
  const registry = { versions: { '0.1.0-rc.0': {} }, 'dist-tags': { latest: '0.1.0-rc.0' } }
  assert.deepEqual(releasePlan('0.1.0', registry), { publish: true, tag: 'latest' })
  assert.deepEqual(releasePlan('0.1.1', registry), { publish: true, tag: 'latest' })
  assert.throws(() => releasePlan('0.0.9', registry), /backwards/)
})

test('registry lookup treats only 404 as a new package and fails closed on errors', async () => {
  const respond = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
  assert.deepEqual(await metadata('@xunz03/dsh-connections', respond(404)), { versions: {}, 'dist-tags': {} })
  for (const status of [401, 403, 429, 500]) await assert.rejects(metadata('@xunz03/dsh-connections', respond(status)), /HTTP/)
  await assert.rejects(metadata('@xunz03/dsh-connections', respond(200, [])), /Invalid npm metadata/)
})
