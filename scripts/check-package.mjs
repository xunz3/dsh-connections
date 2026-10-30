import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { 'output-dir': { type: 'string' } } })
const directory = await mkdtemp(join(tmpdir(), 'dsh-connections-package-'))
const versions = JSON.parse(await readFile(new URL('../src/shared/harness-versions.json', import.meta.url), 'utf8'))
try {
  execFileSync('pnpm', ['pack', '--pack-destination', directory], { stdio: 'pipe' })
  const archives = (await readdir(directory)).filter(name => name.endsWith('.tgz'))
  assert.equal(archives.length, 1)
  const archive = join(directory, archives[0])
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split('\n')
  const read = path => execFileSync('tar', ['-xOzf', archive, `package/${path}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.name, '@xunz03/dsh-connections')
  assert.equal(manifest.repository.url, 'git+https://github.com/xunz3/dsh-connections.git')
  assert.equal(manifest.publishConfig.access, 'public')
  assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/')
  assert(read('dist/host/index.js').includes(manifest.name), 'Host RPC identity must match the published package')
  assert.equal(manifest.engines.dsh, versions.local)
  for (const [name, version] of Object.entries(manifest.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(version, versions.local, `${name} must match the tested local Host`)
  }
  for (const path of ['assets/logo.svg', 'locale/en.json', 'locale/zh.json', 'dist/native-inputs.json', 'dist/host/index.js', 'dist/host/index.d.ts', 'dist/client.js', 'dist/remote-plugin.tgz', 'cordis.patch.yml', 'README.md', 'LICENSE', 'NOTICE', 'docs/design.md', 'docs/usage.md']) assert(entries.includes(`package/${path}`), `Missing ${path}`)
  for (const entry of entries) assert(/^package\/(?:package\.json|README\.md|LICENSE|NOTICE|cordis\.patch\.yml|assets\/logo\.svg|locale\/(?:en|zh)\.json|dist\/[\w./-]+|docs\/[\w.-]+\.md)$/.test(entry), `Unexpected packaged file ${entry}`)
  assert.equal(manifest.exports['./icon'], './assets/logo.svg')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  for (const locale of ['en', 'zh']) {
    const { meta } = JSON.parse(read(`locale/${locale}.json`))
    assert.equal(typeof meta.title, 'string')
    assert(meta.title.trim() && meta.description.trim(), 'Plugin metadata needs a readable title and description')
  }
  const inputs = JSON.parse(read('dist/native-inputs.json'))
  assert(inputs.packages.length >= 9 && inputs.adapters.length === 5)
  for (const input of inputs.packages) assert.match(input.clientIntegrity, /^sha512-[A-Za-z0-9+/]{86}==$/)
  for (const input of inputs.adapters) {
    assert.equal(input.integrity, `sha512-${createHash('sha512').update(await readFile(input.path)).digest('base64')}`, `Stale adapter input: ${input.path}`)
  }
  assert.match(read('NOTICE'), /Copyright \(c\) 2026 DeepSeek/)
  assert.match(read('assets/logo.svg'), /viewBox="0 0 24 24"[^>]+stroke="currentColor"/, 'Connections must ship its scalable theme-aware logo')
  for (const target of [manifest.exports['.'].default, manifest.exports['.'].types, manifest.exports['./client'], manifest.exports['./icon']]) assert(entries.includes(`package/${target.replace(/^\.\//, '')}`))
  assert(read('dist/client.js').includes(`window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)}`))
  assert(read('cordis.patch.yml').includes(manifest.name))
  assert.match(read('cordis.patch.yml'), /id: ui-sidebar[\s\S]*disabled: true/)
  assert(!read('cordis.patch.yml').includes('directory-picker'), 'The local profile must retain its native picker choice')
  assert(!read('cordis.patch.yml').includes('id: shortcuts'), 'The native shortcuts provider must survive Connections installation and reload')
  assert(!read('dist/client.js').includes('ShortcutsService'), 'Connections must not bundle a replacement keyboard provider')
  assert(!read('dist/host/index.js').includes('__DSH_SHORTCUTS_CONFIG__'), 'Shortcut configuration stays owned by its native deployment')
  assert.match(read('dist/native-sidebar.LICENSE'), /Copyright \(c\) 2026 DeepSeek/)
  assert(!read('dist/client.js').includes('require("@deepseek-ai/dsh-client-ui-sidebar/client")'), 'Disabled sidebar must be composed from the installed native factory')
  assert(read('dist/client.js').includes('require("@deepseek-ai/dsh-client-ui-primitives")'), 'UI primitives must use the native ModuleLoader baseline')
  assert(!read('dist/client.js').includes('node:child_process'), 'Host implementation leaked into the browser bundle')
  const remoteArchive = join(directory, 'remote-content.tgz')
  await writeFile(remoteArchive, execFileSync('tar', ['-xOzf', archive, 'package/dist/remote-plugin.tgz'], { maxBuffer: 8 * 1024 * 1024 }))
  assert((await readFile(remoteArchive)).byteLength <= 4 * 1024 * 1024, 'Remote archive must fit the managed SSH installer limit')
  const remoteEntries = execFileSync('tar', ['-tzf', remoteArchive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split('\n')
  const remoteRead = path => execFileSync('tar', ['-xOzf', remoteArchive, `package/${path}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const remoteManifest = JSON.parse(remoteRead('package.json'))
  assert.equal(remoteManifest.name, manifest.name)
  assert.equal(remoteManifest.version, manifest.version)
  assert.equal(remoteManifest.devDependencies, undefined)
  assert.equal(remoteManifest.scripts, undefined)
  assert.deepEqual(JSON.parse(remoteRead('dist/native-inputs.json')), inputs)
  assert.equal(remoteManifest.dependencies['@deepseek-ai/schemastery'], manifest.dependencies['@deepseek-ai/schemastery'])
  for (const path of ['NOTICE', 'assets/logo.svg', 'locale/en.json', 'locale/zh.json']) assert(remoteEntries.includes(`package/${path}`), `Missing remote metadata: ${path}`)
  assert(remoteEntries.includes('package/dist/client.js'))
  assert(!remoteEntries.includes('package/dist/remote-plugin.tgz'), 'Remote archive must not contain itself')
  assert.equal(remoteManifest.engines.dsh, versions.remote.join(' || '))
  assert.notEqual(remoteRead('dist/client.js'), read('dist/client.js'))
  assert(!/nativeSidebar|installNativeSidebar/.test(remoteRead('dist/client.js')), 'Remote surface must be independent of the local shell')
  assert(remoteRead('dist/client.js').includes('require("@deepseek-ai/dsh-client-ui-primitives")'), 'Remote settings must use its own Host native menu primitives')
  assert(!/ConnectionsManager|node:child_process|DSH_HOME/.test(remoteRead('dist/host/index.js')), 'Remote Host must not manage SSH or local configuration')
  assert(!remoteEntries.includes('package/dist/native-sidebar.LICENSE'))
  const remotePatch = remoteRead('cordis.patch.yml')
  assert.match(remotePatch, /id: ui-layout[\s\S]*disabled: true/)
  assert.match(remotePatch, /embedded: true/)
  for (const part of ['settings', 'account']) assert.match(remoteRead(`dist/native-${part}.LICENSE`), /Copyright \(c\) 2026 DeepSeek/)
  assert.match(remotePatch, /id: ui-settings\n[^\n]+\n  disabled: true/)
  assert.match(remotePatch, /id: ui-settings-account\n[^\n]+\n  disabled: true/)
  assert(!remotePatch.includes('id: locale') && !remotePatch.includes('id: ui-theme'), 'Native presentation providers remain installed')
  assert.match(remotePatch, /- id: directory-picker\n  name: '@deepseek-ai\/dsh-host-directory-picker-auto'\n  disabled: true/,
    'Remote profiles must disable auto selection before pinning the browser picker')
  assert.match(remotePatch, /    - id: directory-picker-browse\n      name: '@deepseek-ai\/dsh-host-directory-picker-browse'/,
    'Remote profiles need the native browser directory service')
  assert.match(remotePatch, /    - id: ui-directory-picker-browse\n      name: '@deepseek-ai\/dsh-client-ui-directory-picker-browse'/,
    'Remote profiles need the matching native browser directory surface')
  assert(!remotePatch.includes('directory-picker-native'), 'Remote profiles must not open a server-side system dialog')
  for (const entry of entries.filter(path => path.endsWith('.md'))) {
    for (const match of read(entry.slice('package/'.length)).matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      const target = match[1]
      if (/^[a-z]+:/i.test(target)) continue
      const parent = entry.slice(0, entry.lastIndexOf('/') + 1)
      assert(entries.includes(`${parent}${target}`), `Broken packaged link ${target} in ${entry}`)
    }
  }
  console.log(`Package verified: ${entries.length} files; exports, ModuleLoader and documentation links valid.`)
  if (values['output-dir']) {
    const output = resolve(values['output-dir'])
    await mkdir(output, { recursive: true })
    const integrity = `sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`
    await copyFile(archive, join(output, archives[0]))
    await writeFile(join(output, 'release-package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, tarball: archives[0], integrity }, null, 2) + '\n')
    console.log(`Checked release artifact: ${join(output, archives[0])}`)
  }
} finally { await rm(directory, { recursive: true, force: true }) }
