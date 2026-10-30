import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import test from 'node:test'
import { terminateSshProcess } from '../src/host/ssh-process.js'

test('cleanup never signals a PID or process group after its leader has exited', async t => {
  const kill = t.mock.method(process, 'kill', () => true)
  let destroyed = 0
  const child = {
    pid: 12345, exitCode: 0, signalCode: null,
    stdin: { destroy: () => { destroyed++ } }, stdout: { destroy: () => { destroyed++ } }, stderr: { destroy: () => { destroyed++ } },
    kill: () => { assert.fail('an exited child cannot be killed') },
  } as unknown as ChildProcess
  await terminateSshProcess(child, Promise.resolve(), 1)
  assert.equal(kill.mock.callCount(), 0)
  assert.equal(destroyed, 3)
})

test('POSIX cleanup does not send a late SIGKILL after observing leader exit', { skip: process.platform === 'win32' }, async t => {
  const kill = t.mock.method(process, 'kill', () => true)
  const child = { pid: 12345, exitCode: null as number | null, signalCode: null }
  const done = Promise.resolve().then(() => { child.exitCode = 0 })
  await terminateSshProcess(child as ChildProcess, done, 1)
  assert.deepEqual(kill.mock.calls.map(call => call.arguments), [[-12345, 'SIGTERM']])
})
