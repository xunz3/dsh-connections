import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { prepareHost, RemoteHostError } from '../src/host/lifecycle.js'
import { REMOTE_BOOTSTRAP_COMMAND } from '../src/host/remote-bootstrap.js'

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

async function fixture(t: TestContext, version?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh node bootstrap '))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bin = join(directory, 'bin')
  await mkdir(bin)
  await symlink('/bin/sh', join(bin, 'sh'))
  if (version) {
    const override = join(directory, 'node-version.cjs')
    await writeFile(override, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });\n`)
    await writeFile(join(bin, 'node'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} --require ${shellQuote(override)} "$@"\n`, { mode: 0o755 })
  }
  const startupMarker = join(directory, 'startup-marker')
  const shell = join(directory, 'login shell')
  await writeFile(shell, `#!/bin/sh\nprintf 'unexpected startup' > ${shellQuote(startupMarker)}\nexit 1\n`, { mode: 0o755 })
  const env = { ...process.env, PATH: bin, SHELL: shell }
  return {
    async run(script: string) {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn('/bin/sh', ['-c', REMOTE_BOOTSTRAP_COMMAND], { env, stdio: ['pipe', 'pipe', 'pipe'], signal: t.signal })
        let stdout = ''; let stderr = ''
        child.stdout.on('data', chunk => { stdout += chunk })
        child.stderr.on('data', chunk => { stderr += chunk })
        child.stdin.on('error', () => {})
        child.on('error', reject)
        child.on('close', code => resolve({ code, stdout, stderr }))
        child.stdin.end(script)
      })
      await assert.rejects(readFile(startupMarker), { code: 'ENOENT' })
      return result
    },
  }
}

test('supported SSH Node preserves complete management stdin without login startup', async t => {
  const f = await fixture(t, process.versions.node)
  const data = 'management request with spaces and $shell syntax; '.repeat(4096)
  const result = await f.run(`import {createHash} from 'node:crypto';\nconsole.log(createHash('sha256').update(${JSON.stringify(data)}).digest('hex'));\n`)
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.trim(), createHash('sha256').update(data).digest('hex'))
})

for (const version of ['22.19.0', '24.0.0']) {
  test(`Node ${version} on the noninteractive PATH can run management`, async t => {
    const f = await fixture(t, version)
    const result = await f.run('console.log("management started");\n')
    assert.deepEqual(result, { code: 0, stdout: 'management started\n', stderr: '' })
  })
}

for (const version of [undefined, '18.19.1', '22.18.0', '23.11.0']) {
  test(`${version ? `Node ${version}` : 'missing SSH Node'} reports a fixed diagnostic without login startup or management`, async t => {
    const f = await fixture(t, version)
    const result = await f.run('throw new Error("management must not start");\n')
    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), { error: 'node' })
  })
}

test('management SSH failures expose actionable categories without private diagnostics', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-management-ssh-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const ssh = join(directory, 'ssh')
  const secret = 'http://127.0.0.1:3080/?token=private-launch-credential'
  for (const [diagnostic, expected] of [
    ['Permission denied (publickey).', 'ssh-auth'],
    ['Host key verification failed.', 'ssh-host-key'],
    ['connect to host dev port 22: Connection timed out', 'ssh-timeout'],
    ['unexpected SSH failure', 'ssh'],
  ]) {
    await writeFile(ssh, `#!/bin/sh\nprintf '%s\\n' ${shellQuote(`${secret}\n${diagnostic}`)} >&2\nexit 255\n`, { mode: 0o755 })
    await assert.rejects(prepareHost({ target: 'dev' }, { workspacePlugin: false, sshPath: ssh }), error => {
      assert.ok(error instanceof RemoteHostError)
      assert.equal(error.code, expected)
      assert.ok(!error.message.includes(secret))
      return true
    })
  }
  await assert.rejects(prepareHost({ target: 'dev' }, { workspacePlugin: false, sshPath: join(directory, 'missing-ssh') }), { code: 'ssh-unavailable' })
})
