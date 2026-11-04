import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { SshTunnelError, type ProcessResult } from './ssh-common.js'

// The group leader remains alive until the entire SSH group is disposed, so
// its PGID cannot be recycled between TERM and KILL. The parent owns its stdin
// and IPC pipe: even SIGKILL of the Host closes those pipes and starts cleanup.
// This helper never connects to or manages the remote Harness lifecycle.
const masterOwner = String.raw`
const { spawn } = require('node:child_process');
const { rm } = require('node:fs/promises');
const [executable, argumentsJson, directory, grace] = process.argv.slice(1);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  try { process.kill(-process.pid, 'SIGTERM'); } catch {}
  void rm(directory, { recursive: true, force: true }).catch(() => {}).finally(() => {
    setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } }, Number(grace));
  });
};
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdin.resume();
process.on('disconnect', stop);
const report = result => { if (process.connected) { try { process.send(result, () => {}); } catch {} } };
report({ ready: true });
try {
  const ssh = spawn(executable, JSON.parse(argumentsJson), { shell: false, stdio: ['ignore', 'ignore', 'inherit'] });
  ssh.once('error', error => { report({ code: null, error: { code: error.code } }); stop(); });
  ssh.once('exit', code => { report({ code }); stop(); });
} catch (error) { report({ code: null, error: { code: error.code } }); stop(); }
`

const supervisorError = () => new SshTunnelError('SSH_FAILED', undefined, 'SUPERVISOR')

/** Own a POSIX OpenSSH master through a parent-liveness pipe and private group. */
export function spawnSshMaster(executable: string, args: string[], directory: string, graceMs: number, env: NodeJS.ProcessEnv): { child: ChildProcess; result: Promise<ProcessResult> } {
  let child: ChildProcess
  try {
    child = spawn(process.execPath, ['--input-type=commonjs', '-e', masterOwner, executable, JSON.stringify(args), directory, String(graceMs)], {
      shell: false, detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
      env: process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env,
    })
  } catch { throw supervisorError() }
  // The supervisor never consumes data; stdin is only an ownership lease.
  child.stdin?.on('error', () => {})
  let ready = false
  let reported: ProcessResult | undefined
  let spawnError = false
  child.on('message', message => {
    if (!message || typeof message !== 'object') return
    const result = message as { ready?: unknown; code?: unknown; error?: { code?: string } }
    if (result.ready === true) { ready = true; return }
    if ((typeof result.code !== 'number' && result.code !== null) || reported) return
    reported = { code: result.code, ...(result.error ? { error: Object.assign(new Error('SSH spawn failed.'), { code: result.error.code }) } : {}) }
  })
  child.on('error', () => { spawnError = true })
  const result = new Promise<ProcessResult>(resolve => child.once('close', code => resolve(reported ?? { code, ...(!ready || spawnError ? { error: supervisorError() } : {}) })))
  return { child, result }
}

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
        try { execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: Math.max(1_000, graceMs) }, () => resolve()) }
        catch { resolve() /* A failed cleanup launch must not become an unhandled rejection. */ }
      })
    }
  } else if (alive()) {
    // A numeric process-group ID is no longer an ownership token after the
    // leader exits. Never signal it once Node has observed that exit.
    try { process.kill(-child.pid!, 'SIGTERM') } catch { /* Already exited. */ }
  }
  await bounded(done, graceMs)
  try {
    if (process.platform === 'win32') { if (alive()) child.kill('SIGKILL') }
    else if (alive()) process.kill(-child.pid!, 'SIGKILL')
  } catch { /* Already exited. */ }
  child.stdin?.destroy()
  child.stdout?.destroy()
  child.stderr?.destroy()
  await bounded(done, graceMs)
}
