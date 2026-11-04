import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { SshTunnelError, sshProcessError, type ProcessResult, type SshTunnelOptions, type Tunnel, type TunnelInput } from './ssh-common.js'
import { terminateSshProcess } from './ssh-process.js'

interface Channel {
  socket: Socket
  child: ChildProcessWithoutNullStreams
  done: Promise<void>
  stopping?: Promise<void>
  cancelled: boolean
}

const maximumChannels = 32
const cancelled = () => new DOMException('SSH connection cancelled.', 'AbortError')

/**
 * Windows OpenSSH does not implement ControlMaster. Own the loopback listener
 * ourselves and delegate each TCP stream to its native stdio forward instead.
 *
 * Binding is not remote readiness: ConnectionsManager authenticates Harness
 * through this listener before advertising a connected connection. An idle
 * bridge has no SSH session; later streams authenticate again using the same
 * system SSH configuration. HTTP keepalive and WebSockets retain their stream.
 */
export async function connectStdioTunnel(input: TunnelInput, options: SshTunnelOptions): Promise<Tunnel> {
  const channels = new Set<Channel>()
  const listeners = new Set<(error?: Error) => void>()
  const shutdownGraceMs = options.shutdownGraceMs ?? 500
  let closed = false
  let closeError: Error | undefined
  let cleanup: Promise<void> | undefined
  let port = 0
  let forwardedData = false
  const server = createServer({ pauseOnConnect: true, allowHalfOpen: true })

  const stopChannel = (channel: Channel): Promise<void> => {
    if (channel.stopping) return channel.stopping
    channel.cancelled = true
    channel.socket.destroy()
    channel.stopping = (async () => {
      await terminateSshProcess(channel.child, channel.done, shutdownGraceMs)
      channels.delete(channel)
    })()
    return channel.stopping
  }

  const stop = (error?: Error): Promise<void> => {
    if (cleanup) return cleanup
    closed = true
    closeError = error
    input.signal?.removeEventListener('abort', onAbort)
    cleanup = Promise.resolve().then(async () => {
      const stopped = new Promise<void>(resolve => server.close(() => resolve()))
      await Promise.all([...channels].map(stopChannel))
      await stopped
    })
    // Notify immediately so the manager retains the SSH reason before its
    // in-flight HTTP probe observes the sockets being destroyed.
    for (const listener of [...listeners]) {
      try { listener(error) } catch { /* Subscriber errors cannot block cleanup. */ }
    }
    listeners.clear()
    return cleanup
  }
  const onAbort = () => { void stop(cancelled()).catch(() => {}) }
  const failChannel = (socket: Socket, error: Error) => {
    // Auth/host-identity failures invalidate the connection even after first use:
    // later streams must not silently keep advertising an authenticated bridge.
    // Forwarding/network/launch failures otherwise own only their TCP stream,
    // except before any data has established the manager's initial probe.
    const fatal = error instanceof SshTunnelError && (error.code === 'SSH_AUTH' || error.code === 'SSH_HOST_KEY')
    if (fatal || !forwardedData && channels.size === 0) void stop(error).catch(() => {})
    socket.destroy()
  }

  server.on('connection', socket => {
    if (closed || channels.size >= maximumChannels) { socket.destroy(); return }
    let child: ChildProcessWithoutNullStreams
    try { child = spawn(options.sshPath ?? 'ssh', [
      ...(options.configFile ? ['-F', options.configFile] : []),
      '-T', '-W', `127.0.0.1:${input.remotePort}`,
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
      '-o', 'ClearAllForwardings=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'Tunnel=no',
      '-o', 'PermitLocalCommand=no', '-o', 'RemoteCommand=none',
      '-o', 'IgnoreUnknown=ForkAfterAuthentication,StdinNull', '-o', 'ForkAfterAuthentication=no', '-o', 'StdinNull=no',
      '-o', `ConnectTimeout=${Math.max(1, Math.min(15, Math.ceil((options.startupTimeoutMs ?? 20_000) / 1_000)))}`,
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '--', input.target,
    ], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', env: options.env ?? process.env }) }
    catch (error) {
      // Windows can throw synchronously (e.g. spawn UNKNOWN). This callback
      // runs after connectTunnel resolves, outside its async error boundary.
      failChannel(socket, sshProcessError('', { code: null, error: error instanceof Error ? error : new Error('SSH spawn failed.') }, 'SSH_FORWARD'))
      return
    }
    let stderr = ''
    let spawnError: Error | undefined
    let finish!: () => void
    const channel: Channel = { socket, child, done: new Promise<void>(resolve => { finish = resolve }), cancelled: false }
    channels.add(channel)
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-8_192) })
    child.on('error', error => { spawnError = error })
    // Broken pipes accompany an SSH exit; classify its exit and stderr rather
    // than losing the useful authentication/host-key reason to EPIPE.
    child.stdin.on('error', () => {})
    child.stdout.on('error', () => {})
    child.stderr.on('error', () => {})
    socket.on('error', () => { void stopChannel(channel) })
    socket.on('close', () => { void stopChannel(channel) })
    child.once('close', code => {
      channels.delete(channel)
      finish()
      if (channel.cancelled || closed) { socket.destroy(); return }
      const result: ProcessResult = { code, ...(spawnError ? { error: spawnError } : {}) }
      if (code !== 0 || spawnError) {
        failChannel(socket, sshProcessError(stderr, result, 'SSH_FORWARD'))
      } else { socket.end(); socket.destroySoon() }
    })
    // Keep the socket open until SSH's exit is classified. Letting stdout EOF
    // close it first would misclassify an auth failure as a client cancellation.
    child.stdout.on('data', (chunk: Buffer) => { if (chunk.length) forwardedData = true })
    child.stdout.pipe(socket, { end: false })
    socket.pipe(child.stdin)
    socket.resume()
  })
  server.on('error', error => { if (port) void stop(error).catch(() => {}) })
  input.signal?.addEventListener('abort', onAbort, { once: true })

  const bind = (candidate: number) => new Promise<void>((resolve, reject) => {
    const clear = () => {
      server.removeListener('listening', onListening)
      server.removeListener('error', onError)
      input.signal?.removeEventListener('abort', onBindAbort)
    }
    const onError = (error: Error) => { clear(); reject(error) }
    const onListening = () => { clear(); resolve() }
    const onBindAbort = () => { clear(); reject(cancelled()) }
    server.once('error', onError)
    server.once('listening', onListening)
    input.signal?.addEventListener('abort', onBindAbort, { once: true })
    server.listen({ port: candidate, host: '127.0.0.1', exclusive: true, ...(input.signal ? { signal: input.signal } : {}) })
  })
  try {
    input.signal?.throwIfAborted()
    try { await bind(input.preferredLocalPort ?? 0) }
    catch (error) {
      if (!input.preferredLocalPort || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      input.signal?.throwIfAborted()
      await bind(0)
    }
    // An abort can win while listen is pending; close the newly bound handle.
    if (closed || input.signal?.aborted) {
      await new Promise<void>(resolve => server.close(() => resolve()))
      throw cancelled()
    }
    const address = server.address()
    if (!address || typeof address === 'string') throw new SshTunnelError('SSH_FORWARD', 'Could not allocate a local SSH port.')
    port = address.port
    return {
      get port() { return port },
      close: () => stop(),
      onClose(listener) {
        let active = true
        if (closed) queueMicrotask(() => { if (active) { try { listener(closeError) } catch { /* Subscriber error. */ } } })
        else listeners.add(listener)
        return () => { active = false; listeners.delete(listener) }
      },
    }
  } catch (error) {
    await stop(error instanceof Error ? error : new SshTunnelError('SSH_FORWARD', 'Could not allocate a local SSH port.'))
    throw error
  }
}
