import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareHost } from '../src/host/lifecycle.js'

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
