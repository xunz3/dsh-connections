import { accessSync, constants, statSync } from 'node:fs'
import { access, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { globIterate } from 'glob'
import SSHConfig, { type Directive } from 'ssh-config'
import { parseTarget } from '../shared/validation.js'

const MAX_FILE_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024
const MAX_FILES = 256
const MAX_DEPTH = 16
const MAX_HOSTS = 1000
const MAX_SCAN_ENTRIES = 8192

export interface SshConfigOptions {
  homeDirectory?: string
  userConfigFile?: string
  systemConfigFile?: string
  env?: NodeJS.ProcessEnv
}

export class SshConfigError extends Error {
  constructor(readonly code: 'read' | 'parse' | 'limits') {
    super({
      read: 'Could not read SSH configuration. Check its file permissions, then refresh.',
      parse: 'Could not parse SSH configuration. Check its syntax, then refresh.',
      limits: 'SSH configuration is too large or deeply nested to list. Add the host manually.',
    }[code])
    this.name = 'SshConfigError'
  }
}

function missing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

function values(value: Directive['value']): string[] {
  return typeof value === 'string' ? [value] : value.map(item => item.val)
}

/** List static Host candidates; OpenSSH remains responsible for resolving each connection. */
export async function discoverSshHosts(options: SshConfigOptions = {}): Promise<string[]> {
  const home = options.homeDirectory ?? homedir()
  const env = options.env ?? process.env
  const userDirectory = join(home, '.ssh')
  const systemFile = options.systemConfigFile ?? (process.platform === 'win32'
    ? join(env.ProgramData ?? 'C:\\ProgramData', 'ssh', 'ssh_config') : '/etc/ssh/ssh_config')
  const hosts = new Set<string>()
  const visited = new Set<string>()
  let bytes = 0
  let scanned = 0

  function includePath(argument: string, base: string, userConfig: boolean): string | undefined {
    let unresolved = false
    let path = argument.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
      const value = env[name]
      if (value === undefined) unresolved = true
      return value ?? ''
    }).replace(/%(.?)/g, (_, token: string) => {
      if (token === '%') return '%'
      if (token === 'd') return home
      // Host-dependent expansion is unknowable during a static listing.
      unresolved = true
      return ''
    })
    if (unresolved || !path || path.includes('\0')) return undefined
    if (path.startsWith('~')) {
      if (!userConfig || !/^~(?:[/\\]|$)/.test(path)) return undefined
      path = join(home, path.slice(2))
    }
    if (path.length > 4096) throw new SshConfigError('limits')
    return isAbsolute(path) ? path : resolve(base, path)
  }

  async function include(argument: string, base: string, userConfig: boolean, depth: number): Promise<void> {
    if (++scanned > MAX_SCAN_ENTRIES) throw new SshConfigError('limits')
    const path = includePath(argument, base, userConfig)
    if (!path) return
    if (!/[*?\[]/.test(path)) return visit(path, base, userConfig, depth)
    // Glob walkers skip unreadable directories. Surface these as read
    // failures instead of presenting a misleading empty list.
    const prefix = path.slice(0, path.search(/[*?\[]/))
    const directory = prefix.slice(0, prefix.lastIndexOf(sep)) || sep
    try { await access(directory, constants.R_OK | constants.X_OK) }
    catch (error) { if (missing(error)) return; throw new SshConfigError('read') }
    const matches: string[] = []
    const controller = new AbortController()
    const stop = (code: 'read' | 'limits'): true => {
      controller.abort(new SshConfigError(code))
      return true
    }
    try { for await (const match of globIterate(path, {
      withFileTypes: true,
      // OpenSSH does not make ** recursive or expand braces/extglob groups.
      nobrace: true, noext: true, noglobstar: true,
      windowsPathsNoEscape: process.platform === 'win32',
      signal: controller.signal,
      ignore: {
        ignored: () => {
          if (++scanned > MAX_SCAN_ENTRIES) return stop('limits')
          return controller.signal.aborted
        },
        childrenIgnored: entry => {
          if (++scanned > MAX_SCAN_ENTRIES) return stop('limits')
          if (controller.signal.aborted) return true
          const candidate = entry.fullpath()
          try {
            if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(candidate).isDirectory())) {
              accessSync(candidate, constants.R_OK | constants.X_OK)
            }
          } catch (error) { if (!missing(error)) return stop('read') }
          return false
        },
      },
    })) {
      if (matches.length >= MAX_FILES) throw new SshConfigError('limits')
      matches.push(match.fullpath())
    } } catch (error) { controller.abort(error); throw error }
    for (const match of matches.sort()) await visit(match, base, userConfig, depth)
  }

  async function directives(config: SSHConfig, base: string, userConfig: boolean, depth: number): Promise<void> {
    for (const line of config) {
      if (line.type !== SSHConfig.DIRECTIVE) continue
      const name = line.param.toLowerCase()
      if (name === 'host') {
        for (const candidate of values(line.value)) {
          try {
            const target = parseTarget(candidate)
            // Do not change a quoted alias by trimming its spelling.
            if (target === candidate) hosts.add(target)
          } catch { /* Patterns and aliases unsupported by the connection API are not candidates. */ }
          if (hosts.size > MAX_HOSTS) throw new SshConfigError('limits')
        }
      } else if (name === 'include') {
        for (const argument of values(line.value)) await include(argument, base, userConfig, depth + 1)
      }
      // Includes inside Host/Match are candidates too. Never evaluate Match exec,
      // ProxyCommand, canonicalization, or SSHConfig.compute().
      if ('config' in line) await directives(line.config, base, userConfig, depth)
    }
  }

  async function visit(path: string, base: string, userConfig: boolean, depth: number): Promise<void> {
    let canonical: string
    try { canonical = await realpath(path) } catch (error) {
      if (missing(error)) return
      throw new SshConfigError('read')
    }
    // A shared file can have different relative Include roots in user/system config.
    const key = `${base}\0${canonical}`
    if (visited.has(key)) return
    if (depth > MAX_DEPTH || visited.size >= MAX_FILES) throw new SshConfigError('limits')
    visited.add(key)
    let contents: string
    try {
      // Nonblocking open plus a regular-file check prevents a config FIFO/device
      // from stalling discovery. Read at most one byte beyond the per-file limit.
      const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        const info = await file.stat()
        if (!info.isFile()) throw new SshConfigError('read')
        if (info.size > MAX_FILE_BYTES) throw new SshConfigError('limits')
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
        let length = 0
        while (length < buffer.length) {
          const result = await file.read(buffer, length, buffer.length - length, length)
          if (!result.bytesRead) break
          length += result.bytesRead
        }
        bytes += length
        if (length > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES) throw new SshConfigError('limits')
        contents = buffer.toString('utf8', 0, length)
      } finally { await file.close() }
    } catch (error) {
      if (missing(error)) return
      throw error instanceof SshConfigError ? error : new SshConfigError('read')
    }
    let config: SSHConfig
    try { config = SSHConfig.parse(contents) } catch { throw new SshConfigError('parse') }
    await directives(config, base, userConfig, depth)
  }

  try {
    await visit(options.userConfigFile ?? join(userDirectory, 'config'), userDirectory, true, 0)
    await visit(systemFile, dirname(systemFile), false, 0)
  } catch (error) {
    // Parser and filesystem exceptions may contain credentials, paths or config text.
    throw error instanceof SshConfigError ? error : new SshConfigError('read')
  }
  return [...hosts]
}
