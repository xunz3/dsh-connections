import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { discoverSshHosts, SshConfigError, type SshConfigOptions } from '../src/host/ssh-config.js'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-config-test-'))
  const home = join(directory, 'home')
  const systemConfigFile = join(directory, 'etc', 'ssh', 'ssh_config')
  const options: SshConfigOptions = { homeDirectory: home, systemConfigFile, env: { HOME: home } }
  async function write(path: string, contents: string) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  }
  return {
    directory, home, systemConfigFile, options,
    user: (name: string, contents: string) => write(join(home, '.ssh', name), contents),
    system: (name: string, contents: string) => write(join(dirname(systemConfigFile), name), contents),
    dispose: () => rm(directory, { recursive: true, force: true }),
  }
}

test('lists concrete Host aliases, with OpenSSH quoting, case-insensitive keys and deduplication', async () => {
  const f = await fixture()
  try {
    await f.user('config', `
# Do not reveal HostName, user, keys, paths, or command fields.
Host Dev WSL_Ubuntu_R
  HostName private.example.com
  User secret-user
  IdentityFile /private/key-file
host = "quoted-alias" Dev # duplicate
HOST=DH_H800
Host * !excluded wildcard? bracket[ab] "with spaces" -option
`)
    await f.system('ssh_config', 'Host system-host Dev\n')
    assert.deepEqual(await discoverSshHosts(f.options), ['Dev', 'WSL_Ubuntu_R', 'quoted-alias', 'DH_H800', 'system-host'])
  } finally { await f.dispose() }
})

test('reads Include globs in lexical order and resolves relative paths against their SSH root', async () => {
  const f = await fixture()
  try {
    await f.user('config', 'Include "conf d/*.conf" extra\nHost last\n')
    await f.user('conf d/20.conf', 'Host second\nInclude root-relative\n')
    await f.user('conf d/10.conf', 'Host first\n')
    await f.user('root-relative', 'Host root-relative\n')
    await f.user('extra', 'Host extra\n')
    await f.system('ssh_config', 'Include ssh_config.d/*.conf\n')
    await f.system('ssh_config.d/10.conf', 'Host system-included\nInclude relative-root\n')
    await f.system('relative-root', 'Host system-root\n')
    assert.deepEqual(await discoverSshHosts(f.options), ['first', 'second', 'root-relative', 'extra', 'last', 'system-included', 'system-root'])
  } finally { await f.dispose() }
})

test('supports current-user home and environment includes without inventing target-dependent paths', async () => {
  const f = await fixture()
  try {
    await f.user('config', 'Include ~/.ssh/tilde "${HOME}/.ssh/environment" %d/.ssh/token ~otheruser/config "%h/config" "${UNSET}/config"\n')
    await f.user('tilde', 'Host tilde-host\n')
    await f.user('environment', 'Host environment-host\n')
    await f.user('token', 'Host token-host\n')
    assert.deepEqual(await discoverSshHosts(f.options), ['tilde-host', 'environment-host', 'token-host'])
  } finally { await f.dispose() }
})

test('a shared include keeps the user and system relative Include roots distinct', async () => {
  const f = await fixture()
  try {
    const shared = join(f.directory, 'shared-config')
    await writeFile(shared, 'Include relative\n')
    await f.user('config', `Include ${shared}\n`)
    await f.system('ssh_config', `Include ${shared}\n`)
    await f.user('relative', 'Host user-relative\n')
    await f.system('relative', 'Host system-relative\n')
    assert.deepEqual(await discoverSshHosts(f.options), ['user-relative', 'system-relative'])
  } finally { await f.dispose() }
})

test('preserves glob character classes and literal braces, parentheses and at signs', async () => {
  const f = await fixture()
  try {
    await f.user('config', 'Include "config@(prod)/*.conf" "config{a,b}/*.conf" "classes/[!a].conf"\n')
    await f.user('config@(prod)/one.conf', 'Host parentheses\n')
    await f.user('config{a,b}/one.conf', 'Host braces\n')
    await f.user('classes/a.conf', 'Host excluded\n')
    await f.user('classes/b.conf', 'Host selected\n')
    assert.deepEqual(await discoverSshHosts(f.options), ['parentheses', 'braces', 'selected'])
  } finally { await f.dispose() }
})

test('only discovers candidates inside conditional includes and never evaluates commands', async () => {
  const f = await fixture()
  try {
    const sentinel = join(f.directory, 'executed')
    await f.user('config', `Match exec "touch ${sentinel}"
  Include conditional
Host base
  ProxyCommand touch ${sentinel}
  LocalCommand touch ${sentinel}
  Include host-conditional
`)
    await f.user('conditional', 'Host conditional-host\n')
    await f.user('host-conditional', 'Host nested-host\n')
    assert.deepEqual(await discoverSshHosts(f.options), ['conditional-host', 'base', 'nested-host'])
    await assert.rejects(readFile(sentinel), { code: 'ENOENT' })
  } finally { await f.dispose() }
})

test('handles direct and symbolic include cycles and refreshes changed files', async () => {
  const f = await fixture()
  try {
    await f.user('config', 'Host before\nInclude loop alias\n')
    await f.user('loop', 'Include config\nHost loop-host\n')
    await symlink(join(f.home, '.ssh', 'config'), join(f.home, '.ssh', 'alias'))
    assert.deepEqual(await discoverSshHosts(f.options), ['before', 'loop-host'])
    await f.user('config', 'Host after\n')
    assert.deepEqual(await discoverSshHosts(f.options), ['after'])
  } finally { await f.dispose() }
})

test('missing config files and unmatched includes are empty, while actual read failures stay visible and sanitized', async () => {
  const f = await fixture()
  try {
    assert.deepEqual(await discoverSshHosts(f.options), [])
    await f.user('config', 'Include missing missing/*.conf\nHost available\n')
    assert.deepEqual(await discoverSshHosts(f.options), ['available'])
    await f.user('config', 'Include unreadable\n')
    await f.user('unreadable', 'Host secret-alias\n')
    await chmod(join(f.home, '.ssh', 'unreadable'), 0)
    try {
      await assert.rejects(discoverSshHosts(f.options), (error: unknown) => {
        assert.ok(error instanceof SshConfigError)
        assert.equal(error.code, 'read')
        assert.doesNotMatch(error.message, /secret|unreadable|dsh-ssh-config-test/)
        return true
      })
    } finally { await chmod(join(f.home, '.ssh', 'unreadable'), 0o600) }
    await f.user('restricted/config', 'Host hidden\n')
    await f.user('config', 'Include restricted/*\n')
    await chmod(join(f.home, '.ssh', 'restricted'), 0)
    try { await assert.rejects(discoverSshHosts(f.options), { code: 'read' }) }
    finally { await chmod(join(f.home, '.ssh', 'restricted'), 0o700) }
    await f.user('profiles/restricted/config', 'Host hidden\n')
    await f.user('config', 'Include profiles/*/config\n')
    await chmod(join(f.home, '.ssh', 'profiles/restricted'), 0)
    try { await assert.rejects(discoverSshHosts(f.options), { code: 'read' }) }
    finally { await chmod(join(f.home, '.ssh', 'profiles/restricted'), 0o700) }
    await mkdir(join(f.home, '.ssh', 'is-directory'))
    await f.user('config', 'Include is-directory\n')
    await assert.rejects(discoverSshHosts(f.options), { code: 'read' })
  } finally { await f.dispose() }
})

test('sanitizes parser failures and bounds file sizes and include depth', async () => {
  const f = await fixture()
  try {
    await f.user('config', 'Include "private-secret-path\n')
    await assert.rejects(discoverSshHosts(f.options), (error: unknown) => {
      assert.ok(error instanceof SshConfigError)
      assert.equal(error.code, 'parse')
      assert.doesNotMatch(error.message, /private-secret-path/)
      return true
    })
    await f.user('config', '#'.repeat(512 * 1024 + 1))
    await assert.rejects(discoverSshHosts(f.options), { code: 'limits' })
    for (let index = 0; index < 18; index++) await f.user(index === 0 ? 'config' : `depth-${index}`, `Include depth-${index + 1}\n`)
    await assert.rejects(discoverSshHosts(f.options), { code: 'limits' })
    await f.user('config', `Include ${'missing '.repeat(8193)}\n`)
    await assert.rejects(discoverSshHosts(f.options), { code: 'limits' })
  } finally { await f.dispose() }
})

test('bounds broad globs and treats double stars as one directory segment like OpenSSH', async () => {
  const f = await fixture()
  try {
    await f.user('config', 'Include configs/**/*.conf\n')
    await f.user('configs/one/a.conf', 'Host direct\n')
    await f.user('configs/one/two/b.conf', 'Host too-deep\n')
    assert.deepEqual(await discoverSshHosts(f.options), ['direct'])
    await f.user('config', 'Include broad/*\n')
    await Promise.all(Array.from({ length: 257 }, (_, index) => f.user(`broad/${index}`, 'Host same\n')))
    await assert.rejects(discoverSshHosts(f.options), { code: 'limits' })
  } finally { await f.dispose() }
})
