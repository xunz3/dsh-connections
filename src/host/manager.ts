import { randomUUID } from 'node:crypto'
import type { ConnectionRecord, ConnectionView, ConnectionsApi, SaveConnection, SshCheckResult, UpdateConnection } from '../shared/types.js'
import { parseId, parseSave, parseTarget, parseUpdate } from '../shared/validation.js'
import { connectTunnel, SshTunnelError, type Tunnel } from './ssh.js'
import type { ConnectionStore } from './store.js'
import { prepareHost, updateHost, RemoteHostError, type ManagedHost } from './lifecycle.js'
import { discoverSshHosts } from './ssh-config.js'
import { authenticateHarness, createWorkspaceAgent, HarnessAuthorizationError, requestWorkspace } from './harness-http.js'
import { parseWorkspaceRequest } from '../shared/workspace-protocol.js'
import { checkSshTarget } from './ssh-check.js'
import { SSH_ERROR_MESSAGES } from './ssh-common.js'

export type Probe = typeof authenticateHarness
export interface ManagerOptions {
  sshHosts?: () => Promise<string[]>
  connectTunnel?: typeof connectTunnel
  probe?: Probe
  prepareHost?: typeof prepareHost
  updateHost?: typeof updateHost
  checkSshTarget?: typeof checkSshTarget
}

/** Verify Harness's launch-token exchange without following any redirect or exposing the URL. */
export const probeHarness: Probe = authenticateHarness

interface Runtime {
  phase: ConnectionView['phase']
  stage?: ConnectionView['stage']
  error?: string
  generation: number
  transportId?: string
  controller?: AbortController
  pending?: Promise<ConnectionView>
  tunnel?: Tunnel
  workspaceAgent?: ReturnType<typeof createWorkspaceAgent>
  unsubscribe?: () => void
  record?: ConnectionRecord
  managed?: ManagedHost
  cookie?: Promise<string>
  authenticating?: Promise<string>
}

function sameDestination(a: ConnectionRecord, b: ConnectionRecord): boolean {
  return a.target === b.target && (a.mode ?? 'existing') === (b.mode ?? 'existing') && (a.mode === 'managed' || (a.remotePort === b.remotePort && a.token === b.token))
}

function sshFailure(error: unknown): string {
  return SSH_ERROR_MESSAGES[error instanceof SshTunnelError ? error.code : 'SSH_FAILED']
}

/** Owns only connection attempts and tunnels; the remote Harness owns all work. */
export class ConnectionsManager implements ConnectionsApi {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly reconnections = new Map<string, Promise<ConnectionView>>()
  private readonly createTunnel: typeof connectTunnel
  private readonly probe: Probe
  private readonly prepare: typeof prepareHost
  private readonly updateRemote: typeof updateHost
  private readonly discoverHosts: () => Promise<string[]>
  private readonly checkTarget: typeof checkSshTarget
  private readonly sshChecks = new Map<string, { controller: AbortController; pending: Promise<SshCheckResult> }>()
  private operations: Promise<unknown> = Promise.resolve()
  private disposed = false
  private disposal?: Promise<void>

  constructor(private readonly store: ConnectionStore, options: ManagerOptions = {}) {
    this.createTunnel = options.connectTunnel ?? connectTunnel
    this.probe = options.probe ?? probeHarness
    this.prepare = options.prepareHost ?? prepareHost
    this.updateRemote = options.updateHost ?? updateHost
    this.discoverHosts = options.sshHosts ?? discoverSshHosts
    this.checkTarget = options.checkSshTarget ?? checkSshTarget
  }

  async sshHosts(): Promise<string[]> {
    this.assertActive()
    const hosts = await this.discoverHosts()
    this.assertActive()
    return hosts
  }

  /** Read-only SSH preflight, independent of saved connections and their live transports. */
  checkSsh(value: string): Promise<SshCheckResult> {
    const target = parseTarget(value)
    this.assertActive()
    const existing = this.sshChecks.get(target)
    if (existing) return existing.pending
    if (this.sshChecks.size >= 4) return Promise.resolve({ ok: false, code: 'SSH_FAILED' })
    const controller = new AbortController()
    const pending = Promise.resolve().then(async (): Promise<SshCheckResult> => {
      try {
        controller.signal.throwIfAborted()
        await this.checkTarget({ target, signal: controller.signal })
        controller.signal.throwIfAborted()
        return { ok: true }
      } catch (error) {
        return { ok: false, code: error instanceof SshTunnelError ? error.code : 'SSH_FAILED' }
      }
    })
    this.sshChecks.set(target, { controller, pending })
    void pending.then(() => { if (this.sshChecks.get(target)?.pending === pending) this.sshChecks.delete(target) })
    return pending
  }

  /** Restore transport access; the OS-managed remote Host has its own lifetime. */
  async restore(): Promise<void> {
    const pending = (await this.store.list()).filter(record => record.autoConnect)
    const worker = async () => {
      for (let record; !this.disposed && (record = pending.shift());) {
        try { await this.start(record.id, undefined, record) }
        catch { /* One unavailable Host must not block the remaining startup snapshot. */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker))
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
      id: record.id, name: record.name, target: record.target,
      ...(record.mode === undefined ? {} : { mode: record.mode }),
      ...(record.autoConnect === undefined ? {} : { autoConnect: record.autoConnect }),
      ...((runtime?.managed?.remotePort ?? record.remotePort) === undefined ? {} : { remotePort: runtime?.managed?.remotePort ?? record.remotePort }),
      ...(runtime?.managed === undefined ? {} : { runtime: { version: runtime.managed.version, service: runtime.managed.service, pid: runtime.managed.pid } }),
      phase: runtime?.phase ?? 'disconnected',
      ...((runtime?.phase === 'connecting' || runtime?.phase === 'updating') && runtime.stage ? { stage: runtime.stage } : {}),
      ...(runtime?.phase === 'connected' && runtime.tunnel !== undefined ? { localPort: runtime.tunnel.port, transportId: runtime.transportId } : {}),
      ...(runtime?.error === undefined ? {} : { error: runtime.error }),
    }
  }

  private async stop(runtime: Runtime): Promise<void> {
    ++runtime.generation
    runtime.phase = 'disconnected'
    delete runtime.stage
    delete runtime.error
    runtime.unsubscribe?.()
    delete runtime.unsubscribe
    runtime.controller?.abort()
    delete runtime.controller
    runtime.workspaceAgent?.destroy()
    delete runtime.workspaceAgent
    const tunnel = runtime.tunnel
    delete runtime.tunnel
    delete runtime.record
    delete runtime.managed
    delete runtime.cookie
    delete runtime.authenticating
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
      const previous = input.id === undefined ? undefined : await this.record(input.id)
      // Commit validation and credential storage before changing a live transport.
      // Names and automatic-restore preferences do not change its destination.
      const saved = await this.store.save(input)
      const runtime = this.runtimes.get(saved.id)
      if (runtime && previous && !sameDestination(runtime.record ?? previous, saved)) await this.stop(runtime)
      else if (runtime?.record) Object.assign(runtime.record, { name: saved.name, autoConnect: saved.autoConnect })
      return this.view(saved)
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

  /** Explicit connection enables automatic restoration even when this attempt fails. */
  async connect(id: string): Promise<ConnectionView> {
    return this.start(id)
  }

  /** Re-resolve managed credentials and rebuild access without restarting remote work. */
  reconnect(id: string): Promise<ConnectionView> {
    // Coalesce at entry, before credential reads yield: a fast first attempt
    // can finish before a simultaneous request reaches the management queue.
    const existing = this.reconnections.get(id)
    if (existing) return existing
    const pending = this.start(id, undefined, undefined, true)
    this.reconnections.set(id, pending)
    const clear = () => { if (this.reconnections.get(id) === pending) this.reconnections.delete(id) }
    void pending.then(clear, clear)
    return pending
  }

  async update(value: UpdateConnection): Promise<ConnectionView> {
    const { id, version } = parseUpdate(value)
    return this.start(id, { version })
  }

  private async start(id: string, update?: Pick<UpdateConnection, 'version'>, restoring?: ConnectionRecord, reconnect = false): Promise<ConnectionView> {
    parseId(id)
    const operation = await this.serialize(async () => {
      this.assertActive()
      let record = await this.record(id)
      // A later restore worker must not undo a disconnect/edit while an earlier
      // host was slow. Check current settings and manual activity inside the
      // same queue that owns those actions, before creating an automatic runtime.
      if (restoring !== undefined && (!record.autoConnect || this.runtimes.has(id) || !sameDestination(restoring, record))) {
        return { pending: Promise.resolve(this.view(record)) }
      }
      // Persist explicit intent before touching the live transport. Restore and
      // maintenance retain the preference chosen by the user. The store updates
      // only this field, so another writer's name, target and credential survive.
      if (restoring === undefined && update === undefined) record = await this.store.setAutoConnect(id, true)
      const runtime = this.runtime(id)
      if (update !== undefined) {
        if (record.mode !== 'managed') throw new Error('Only a managed remote Host can be updated here.')
        if (runtime.phase === 'updating') throw new Error('A remote update is already in progress.')
        await this.stop(runtime)
      }
      if (runtime.record !== undefined && !sameDestination(runtime.record, record)) await this.stop(runtime)
      if (runtime.record !== undefined) Object.assign(runtime.record, { name: record.name, autoConnect: record.autoConnect })
      if (runtime.pending !== undefined) return { pending: runtime.pending }
      if (reconnect) await this.stop(runtime)
      if (runtime.phase === 'connected') return { pending: Promise.resolve(this.view(record)) }
      const generation = ++runtime.generation
      runtime.phase = update === undefined ? 'connecting' : 'updating'
      runtime.stage = record.mode === 'managed' ? 'preparing' : 'tunnel'
      delete runtime.error
      delete runtime.cookie
      const controller = new AbortController()
      runtime.controller = controller
      runtime.record = record
      const pending = this.establish(record, runtime, generation, controller, update)
      runtime.pending = pending
      void pending.finally(() => { if (runtime.pending === pending) delete runtime.pending }).catch(() => {})
      return { pending }
    })
    return operation.pending
  }

  private async establish(record: ConnectionRecord, runtime: Runtime, generation: number, controller: AbortController, update?: Pick<UpdateConnection, 'version'>): Promise<ConnectionView> {
    let tunnel: Tunnel | undefined
    let stage = 'ssh'
    let transportFailure: { generation: number; message: string } | undefined
    const current = () => !this.disposed && runtime.generation === generation && !controller.signal.aborted
    try {
      if (record.mode === 'managed') {
        stage = 'managed'
        const managed = update === undefined
          ? await this.prepare({ target: record.target, signal: controller.signal })
          : await this.updateRemote({ target: record.target, ...update, signal: controller.signal })
        if (!current()) throw new Error('Connection cancelled.')
        runtime.managed = managed
        record = { ...record, remotePort: managed.remotePort, token: managed.token }
        runtime.record = record
      }
      if (record.remotePort === undefined || record.token === undefined) throw new Error('This connection has no remote launch credential.')
      stage = 'ssh'
      runtime.stage = 'tunnel'
      tunnel = await this.createTunnel({ target: record.target, remotePort: record.remotePort, preferredLocalPort: record.lastLocalPort, signal: controller.signal })
      if (!current()) throw new Error('Connection cancelled.')
      await this.store.rememberPort(record.id, record.target, tunnel.port)
      if (!current()) throw new Error('Connection cancelled.')
      runtime.tunnel = tunnel
      runtime.unsubscribe = tunnel.onClose(error => {
        if (!current()) return
        ++runtime.generation
        runtime.phase = 'error'
        delete runtime.stage
        runtime.workspaceAgent?.destroy()
        delete runtime.workspaceAgent
        runtime.error = error instanceof SshTunnelError ? sshFailure(error) : 'The SSH connection closed. Connect again to resume access.'
        transportFailure = { generation: runtime.generation, message: runtime.error }
        delete runtime.tunnel
        runtime.unsubscribe?.()
        delete runtime.unsubscribe
        controller.abort()
      })
      stage = 'authentication'
      runtime.stage = 'authenticating'
      await this.cookie(runtime, tunnel.port, record.token, controller.signal)
      if (!current()) throw new Error('Connection cancelled.')
      runtime.transportId = randomUUID()
      runtime.workspaceAgent = createWorkspaceAgent()
      runtime.phase = 'connected'
      delete runtime.stage
      return this.view(record)
    } catch (error) {
      const active = current()
      if (active) {
        runtime.phase = 'error'
        delete runtime.stage
        runtime.workspaceAgent?.destroy()
        delete runtime.workspaceAgent
        runtime.error = stage === 'managed'
          ? error instanceof RemoteHostError ? error.message : 'The managed remote Host could not be prepared. Check its systemd user service and network access.'
          : stage === 'ssh'
          ? sshFailure(error)
          : 'Harness authentication failed. Check the running remote Host and update its launch URL.'
        runtime.unsubscribe?.()
        delete runtime.unsubscribe
        delete runtime.tunnel
        controller.abort()
      }
      await tunnel?.close().catch(() => {})
      // A stdio tunnel authenticates SSH on the first Harness request. Keep its
      // classified failure when it closes during that request; a later manual
      // disconnect or new attempt still wins over this old completion.
      if (!active) throw new Error(transportFailure?.generation === runtime.generation ? transportFailure.message : 'Connection cancelled.')
      throw new Error(runtime.error)
    }
  }

  disconnect(id: string): Promise<ConnectionView> {
    parseId(id)
    return this.serialize(async () => {
      this.assertActive()
      const record = await this.store.setAutoConnect(id, false)
      await this.stop(this.runtime(id))
      return this.view(record)
    })
  }

  async open(id: string): Promise<{ url: string }> {
    parseId(id)
    const lease = await this.serialize(async () => {
      this.assertActive()
      const record = await this.record(id)
      const runtime = this.runtime(id)
      if (runtime.record !== undefined && !sameDestination(runtime.record, record)) await this.stop(runtime)
      if (runtime.phase !== 'connected' || runtime.tunnel === undefined || runtime.controller === undefined) throw new Error('Connect before opening this Host.')
      const token = runtime.record?.token
      if (token === undefined) throw new Error('Connect again to refresh the remote Host credential.')
      return { runtime, generation: runtime.generation, tunnel: runtime.tunnel, controller: runtime.controller, token,
        cookie: this.cookie(runtime, runtime.tunnel.port, token, runtime.controller.signal, true),
      }
    })
    try {
      // An SSH master can survive a remote Host restart. Check its HTTP identity
      // before issuing a launch URL, outside the management queue so it cancels.
      await lease.cookie
      if (this.disposed || lease.runtime.generation !== lease.generation || lease.controller.signal.aborted) throw new Error('Connection changed. Open the Host again.')
      return { url: `http://127.0.0.1:${lease.tunnel.port}/?token=${encodeURIComponent(lease.token)}` }
    } catch {
      await this.invalidate(lease.runtime, lease.generation, 'The remote Host could not be reached or its authorization changed. Reconnect to refresh access.')
      throw new Error('The remote Host could not be reached or its authorization changed. Reconnect to refresh access.')
    }
  }

  /** Share concurrent exchanges and keep the verified cookie entirely on the Host. */
  private cookie(runtime: Runtime, port: number, token: string, signal: AbortSignal, refresh = false): Promise<string> {
    if (runtime.authenticating) return runtime.authenticating
    if (!refresh && runtime.cookie) return runtime.cookie
    const pending = this.probe(port, token, signal)
    runtime.cookie = pending
    runtime.authenticating = pending
    void pending.then(() => {
      if (runtime.authenticating === pending) delete runtime.authenticating
    }, () => {
      if (runtime.authenticating === pending) delete runtime.authenticating
      if (runtime.cookie === pending) delete runtime.cookie
    })
    return pending
  }

  private invalidate(runtime: Runtime, generation: number, message: string): Promise<void> {
    return this.serialize(async () => {
      if (this.disposed || runtime.generation !== generation) return
      await this.stop(runtime)
      runtime.phase = 'error'
      runtime.error = message
    })
  }

  /** Keep remote credentials and the transport lease entirely on the local Host. */
  async workspace(id: string, input: unknown): Promise<unknown> {
    const request = parseWorkspaceRequest(input)
    const lease = await this.serialize(async () => {
      this.assertActive()
      const record = await this.record(id)
      const runtime = this.runtime(id)
      if (runtime.record && !sameDestination(runtime.record, record)) await this.stop(runtime)
      if (runtime.phase !== 'connected' || !runtime.tunnel || !runtime.controller || !runtime.workspaceAgent || !runtime.record?.token) {
        throw new Error('Connect before opening this workspace.')
      }
      const { generation, controller, tunnel, workspaceAgent } = runtime
      const token = runtime.record.token
      // View allocation must follow authentication even when a caller has not
      // requested its launch URL yet. Read polling can reuse the current cookie.
      const cookie = this.cookie(runtime, tunnel.port, token, controller.signal, request.op === 'openView')
      return { runtime, generation, controller, tunnel, token, cookie, workspaceAgent }
    })
    const current = () => !this.disposed && lease.runtime.generation === lease.generation && !lease.controller.signal.aborted
    let credential = lease.cookie
    for (let attempt = 0; ; attempt++) {
      try {
        const cookie = await credential
        if (!current()) throw new Error('Connection changed. Select the workspace again.')
        const result = await requestWorkspace(lease.tunnel.port, cookie, request, lease.controller.signal, lease.workspaceAgent)
        if (!current()) throw new Error('Connection changed. Select the workspace again.')
        return result
      } catch (error) {
        if (error instanceof HarnessAuthorizationError && current()) {
          if (attempt === 0) {
            const refreshed = await this.serialize(async () => {
              if (!current()) throw new Error('Connection changed. Select the workspace again.')
              // Another rejected request may already have refreshed this cookie.
              return { cookie: lease.runtime.cookie && lease.runtime.cookie !== credential ? lease.runtime.cookie
                : this.cookie(lease.runtime, lease.tunnel.port, lease.token, lease.controller.signal, true) }
            })
            credential = refreshed.cookie
            continue
          }
          if (lease.runtime.cookie === credential) delete lease.runtime.cookie
        }
        // Never replay an ambiguous transport failure: a mutation may already
        // have committed. HTTP failure also does not revoke the SSH lease.
        throw error
      }
    }
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    for (const check of this.sshChecks.values()) check.controller.abort()
    this.disposal = this.serialize(async () => {
      await Promise.all([
        ...[...this.runtimes.values()].map(runtime => this.stop(runtime)),
        ...[...this.sshChecks.values()].map(check => check.pending),
      ])
      this.runtimes.clear()
      this.sshChecks.clear()
    })
    return this.disposal
  }
}
