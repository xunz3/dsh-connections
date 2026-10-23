import { createHash } from 'node:crypto'
import { request } from 'node:http'
import type { ConnectionRecord, ConnectionView, ConnectionsApi, SaveConnection } from '../shared/types.js'
import { parseId, parseSave } from '../shared/validation.js'
import { connectTunnel, SshTunnelError, type Tunnel } from './ssh.js'
import type { ConnectionStore } from './store.js'

export type Probe = (port: number, token: string, signal: AbortSignal) => Promise<void>
export interface ManagerOptions {
  connectTunnel?: typeof connectTunnel
  probe?: Probe
}

/** Verify Harness's launch-token exchange without following any redirect or exposing the URL. */
export const probeHarness: Probe = async (port, token, signal) => {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  bounded.throwIfAborted()
  const cookieName = `dsh-auth-${createHash('sha256').update(`127.0.0.1:${port}`).digest('base64url')}`
  await new Promise<void>((resolve, reject) => {
    const fail = () => reject(new Error('Harness authentication failed. Check the running remote Host and update its launch URL.'))
    const req = request({
      hostname: '127.0.0.1', port, method: 'GET', path: `/?token=${encodeURIComponent(token)}`,
      signal: bounded, agent: false, maxHeaderSize: 16_384,
    }, response => {
      const cookie = response.headers['set-cookie']?.find(value => value.startsWith(`${cookieName}=`))
      const expectedCookie = cookie !== undefined && /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cookie.slice(cookieName.length + 1).split(';', 1)[0] ?? '')
        && /;\s*HttpOnly(?:;|$)/i.test(cookie) && /;\s*SameSite=Strict(?:;|$)/i.test(cookie)
      const valid = response.statusCode === 303 && response.headers.location === './' && expectedCookie
      response.destroy()
      if (valid) resolve()
      else fail()
    })
    req.once('error', fail)
    req.end()
  })
}

interface Runtime {
  phase: ConnectionView['phase']
  error?: string
  generation: number
  controller?: AbortController
  pending?: Promise<ConnectionView>
  tunnel?: Tunnel
  unsubscribe?: () => void
  record?: ConnectionRecord
}

function sameDestination(a: ConnectionRecord, b: ConnectionRecord): boolean {
  return a.target === b.target && a.remotePort === b.remotePort && a.token === b.token
}

function sshFailure(error: unknown): string {
  if (error instanceof SshTunnelError) {
    switch (error.code) {
      case 'SSH_UNAVAILABLE': return 'OpenSSH is unavailable. Install the system SSH client and ensure ssh is on PATH.'
      case 'SSH_HOST_KEY': return 'SSH host identity is not trusted or has changed. Verify this host in a terminal before connecting.'
      case 'SSH_AUTH': return 'SSH authentication failed. Check your key or agent; Connections uses noninteractive authentication.'
      case 'SSH_TIMEOUT': return 'SSH connection timed out. Check the host, network, and SSH config.'
      case 'SSH_FORWARD': return 'SSH could not create the tunnel. Check the server forwarding permissions.'
      case 'SSH_CLOSED': return 'The SSH connection closed. Connect again to resume access.'
    }
  }
  return 'SSH could not connect. Check the target, key or agent, known_hosts, and forwarding permissions.'
}

/** Owns only connection attempts and tunnels; the remote Harness owns all work. */
export class ConnectionsManager implements ConnectionsApi {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly createTunnel: typeof connectTunnel
  private readonly probe: Probe
  private operations: Promise<unknown> = Promise.resolve()
  private disposed = false
  private disposal?: Promise<void>

  constructor(private readonly store: ConnectionStore, options: ManagerOptions = {}) {
    this.createTunnel = options.connectTunnel ?? connectTunnel
    this.probe = options.probe ?? probeHarness
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.operations.then(action)
    this.operations = pending.catch(() => {})
    return pending
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Connections has been unloaded.')
  }

  private async record(id: string): Promise<ConnectionRecord> {
    const record = await this.store.read(parseId(id))
    if (record === undefined) throw new Error('This connection no longer exists.')
    return record
  }

  private runtime(id: string): Runtime {
    let runtime = this.runtimes.get(id)
    if (runtime === undefined) {
      runtime = { phase: 'disconnected', generation: 0 }
      this.runtimes.set(id, runtime)
    }
    return runtime
  }

  private view(record: ConnectionRecord): ConnectionView {
    const runtime = this.runtimes.get(record.id)
    return {
      id: record.id, name: record.name, target: record.target, remotePort: record.remotePort,
      phase: runtime?.phase ?? 'disconnected',
      ...(runtime?.phase === 'connected' && runtime.tunnel !== undefined ? { localPort: runtime.tunnel.port } : {}),
      ...(runtime?.error === undefined ? {} : { error: runtime.error }),
    }
  }

  private async stop(runtime: Runtime): Promise<void> {
    ++runtime.generation
    runtime.phase = 'disconnected'
    delete runtime.error
    runtime.unsubscribe?.()
    delete runtime.unsubscribe
    runtime.controller?.abort()
    delete runtime.controller
    const tunnel = runtime.tunnel
    delete runtime.tunnel
    delete runtime.record
    const closed = await Promise.allSettled([tunnel?.close(), runtime.pending])
    if (closed[0]?.status === 'rejected') throw new Error('The SSH tunnel could not be closed.')
  }

  list(): Promise<ConnectionView[]> {
    return this.serialize(async () => {
      this.assertActive()
      const records = await this.store.list()
      const byId = new Map(records.map(record => [record.id, record]))
      for (const [id, runtime] of this.runtimes) {
        const saved = byId.get(id)
        if (runtime.record !== undefined && (saved === undefined || !sameDestination(runtime.record, saved))) await this.stop(runtime)
      }
      return records.map(record => this.view(record))
    })
  }

  save(value: SaveConnection): Promise<ConnectionView> {
    const input = parseSave(value)
    return this.serialize(async () => {
      this.assertActive()
      if (input.id === undefined && (await this.store.list()).length >= 100) throw new Error('At most 100 saved connections are supported.')
      if (input.id !== undefined) {
        await this.record(input.id)
        await this.stop(this.runtime(input.id))
      }
      return this.view(await this.store.save(input))
    })
  }

  remove(id: string): Promise<void> {
    parseId(id)
    return this.serialize(async () => {
      this.assertActive()
      await this.stop(this.runtime(id))
      await this.store.remove(id)
      this.runtimes.delete(id)
    })
  }

  async connect(id: string): Promise<ConnectionView> {
    parseId(id)
    const operation = await this.serialize(async () => {
      this.assertActive()
      const record = await this.record(id)
      const runtime = this.runtime(id)
      if (runtime.record !== undefined && !sameDestination(runtime.record, record)) await this.stop(runtime)
      if (runtime.pending !== undefined) return { pending: runtime.pending }
      if (runtime.phase === 'connected') return { pending: Promise.resolve(this.view(record)) }
      const generation = ++runtime.generation
      runtime.phase = 'connecting'
      delete runtime.error
      const controller = new AbortController()
      runtime.controller = controller
      runtime.record = record
      const pending = this.establish(record, runtime, generation, controller)
      runtime.pending = pending
      void pending.finally(() => { if (runtime.pending === pending) delete runtime.pending }).catch(() => {})
      return { pending }
    })
    return operation.pending
  }

  private async establish(record: ConnectionRecord, runtime: Runtime, generation: number, controller: AbortController): Promise<ConnectionView> {
    let tunnel: Tunnel | undefined
    let stage = 'ssh'
    const current = () => !this.disposed && runtime.generation === generation && !controller.signal.aborted
    try {
      tunnel = await this.createTunnel({ target: record.target, remotePort: record.remotePort, signal: controller.signal })
      if (!current()) throw new Error('Connection cancelled.')
      runtime.tunnel = tunnel
      runtime.unsubscribe = tunnel.onClose(() => {
        if (!current()) return
        ++runtime.generation
        runtime.phase = 'error'
        runtime.error = 'The SSH connection closed. Connect again to resume access.'
        delete runtime.tunnel
        runtime.unsubscribe?.()
        delete runtime.unsubscribe
        controller.abort()
      })
      stage = 'authentication'
      await this.probe(tunnel.port, record.token, controller.signal)
      if (!current()) throw new Error('Connection cancelled.')
      runtime.phase = 'connected'
      return this.view(record)
    } catch (error) {
      const active = current()
      if (active) {
        runtime.phase = 'error'
        runtime.error = stage === 'ssh'
          ? sshFailure(error)
          : 'Harness authentication failed. Check the running remote Host and update its launch URL.'
        runtime.unsubscribe?.()
        delete runtime.unsubscribe
        delete runtime.tunnel
        controller.abort()
      }
      await tunnel?.close().catch(() => {})
      if (!active) throw new Error('Connection cancelled.')
      throw new Error(runtime.error)
    }
  }

  disconnect(id: string): Promise<ConnectionView> {
    parseId(id)
    return this.serialize(async () => {
      this.assertActive()
      const record = await this.record(id)
      await this.stop(this.runtime(id))
      return this.view(record)
    })
  }

  open(id: string): Promise<{ url: string }> {
    parseId(id)
    return this.serialize(async () => {
      this.assertActive()
      const record = await this.record(id)
      const runtime = this.runtime(id)
      if (runtime.record !== undefined && !sameDestination(runtime.record, record)) await this.stop(runtime)
      if (runtime.phase !== 'connected' || runtime.tunnel === undefined) throw new Error('Connect before opening this Host.')
      return { url: `http://127.0.0.1:${runtime.tunnel.port}/?token=${encodeURIComponent(record.token)}` }
    })
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.disposal = this.serialize(async () => {
      await Promise.all([...this.runtimes.values()].map(runtime => this.stop(runtime)))
      this.runtimes.clear()
    })
    return this.disposal
  }
}
