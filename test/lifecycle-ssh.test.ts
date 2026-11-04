import assert from 'node:assert/strict'
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { prepareHost, RemoteHostError } from '../src/host/lifecycle.js'

for (const multibyte of [false, true]) test(`management bounds ${multibyte ? 'UTF-8 bytes' : 'ASCII output'} before decoding and ignores output after failure`, async t => {
  // A no-PID child double cannot signal or contact any real SSH process. Keep
  // emitting while cleanup awaits close to exercise the post-limit drain window.
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null,
  }) as unknown as ChildProcessWithoutNullStreams
  let pending: ReturnType<typeof prepareHost> | undefined
  try {
    t.mock.method(childProcess, 'spawn', () => child)
    syncBuiltinESMExports()
    pending = prepareHost({ target: 'fixture' }, { workspacePlugin: false })
    const rejected = assert.rejects(pending, error => error instanceof RemoteHostError && error.code === 'protocol')
    let decoded = 0
    const chunk = (value: Buffer) => {
      const decode = value.toString.bind(value)
      value.toString = (...args: Parameters<Buffer['toString']>) => { decoded++; return decode(...args) }
      return value
    }
    child.stdout.emit('data', chunk(Buffer.alloc(8192, 'x')))
    child.stdout.emit('data', chunk(multibyte ? Buffer.from('界'.repeat(3000)) : Buffer.alloc(8193, 'x')))
    for (let index = 0; index < 32; index++) child.stdout.emit('data', chunk(Buffer.alloc(8192, 'x')))
    child.emit('close', 0)
    await rejected
    assert.equal(decoded, 1, 'only the first within-budget chunk may be decoded or retained')
  } finally {
    child.emit('close', 0)
    await Promise.allSettled([pending])
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('management cancellation settles when an exited SSH leader leaves inherited pipes open', { timeout: 6_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-management-pipes-'))
  const ssh = join(directory, 'ssh')
  const pidFile = join(directory, 'descendant.pid')
  const controller = new AbortController()
  let descendant: number | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    // Simulate a ProxyCommand worker surviving its SSH leader. A separate
    // process group keeps the inherited pipes open even after group cleanup,
    // exercising the same bounded-EOF requirement as Windows cancellation.
    await writeFile(ssh, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 1, 2] });
child.unref();
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
process.exit(0);
`, { mode: 0o755 })
    const pending = prepareHost({ target: 'fixture', signal: controller.signal }, { workspacePlugin: false, sshPath: ssh })
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    for (let i = 0; i < 100; i++) {
      const recorded = await readFile(pidFile, 'utf8').catch(() => '')
      if (recorded) { descendant = Number(recorded); break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(descendant, 'the inherited-pipe fixture must be running')
    process.kill(descendant, 0)
    controller.abort()
    await Promise.race([
      rejected,
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Cancellation waited for an unrelated pipe owner.')), 3_000) }),
    ])
  } finally {
    clearTimeout(deadline)
    controller.abort()
    if (descendant) { try { process.kill(-descendant, 'SIGKILL') } catch { /* Already exited. */ } }
    await rm(directory, { recursive: true, force: true })
  }
})
