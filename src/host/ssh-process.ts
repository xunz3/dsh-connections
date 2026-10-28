import { execFile, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

async function bounded(done: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([done, new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds) })]) }
  finally { clearTimeout(timer) }
}

/** Dispose an owned SSH tree without waiting forever for inherited pipe EOF. */
export async function terminateSshProcess(child: ChildProcess, done: Promise<unknown>, graceMs = 500): Promise<void> {
  const alive = () => child.pid && child.exitCode === null && child.signalCode === null
  if (process.platform === 'win32') {
    // A Windows PID identifies only the live process, not an owned process
    // group. Never address it after exit, when it could have been reused.
    if (alive()) {
      const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
      await new Promise<void>(resolve => {
        execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: Math.max(1_000, graceMs) }, () => resolve())
      })
    }
  } else if (child.pid) {
    // ProxyCommand descendants can survive the leader's exit. The private
    // group remains ours until its last descendant exits.
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* Already exited. */ }
  }
  await bounded(done, graceMs)
  try {
    if (process.platform === 'win32') { if (alive()) child.kill('SIGKILL') }
    else if (child.pid) process.kill(-child.pid, 'SIGKILL')
  } catch { /* Already exited. */ }
  child.stdin?.destroy()
  child.stdout?.destroy()
  child.stderr?.destroy()
  await bounded(done, graceMs)
}
