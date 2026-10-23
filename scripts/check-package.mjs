import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'dsh-connections-package-'))
try {
  execFileSync('pnpm', ['pack', '--pack-destination', directory], { stdio: 'pipe' })
  const archives = (await readdir(directory)).filter(name => name.endsWith('.tgz'))
  assert.equal(archives.length, 1)
  const archive = join(directory, archives[0])
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
  const read = path => execFileSync('tar', ['-xOzf', archive, `package/${path}`], { encoding: 'utf8' })
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.name, '@xunz/dsh-connections')
  for (const path of ['dist/host/index.js', 'dist/host/index.d.ts', 'dist/client.js', 'cordis.patch.yml', 'README.md', 'LICENSE', 'docs/design.md', 'docs/usage.md']) assert(entries.includes(`package/${path}`), `Missing ${path}`)
  for (const entry of entries) assert(/^package\/(?:package\.json|README\.md|LICENSE|cordis\.patch\.yml|dist\/[\w./-]+|docs\/[\w.-]+\.md)$/.test(entry), `Unexpected packaged file ${entry}`)
  for (const target of [manifest.exports['.'].default, manifest.exports['.'].types, manifest.exports['./client']]) assert(entries.includes(`package/${target.replace(/^\.\//, '')}`))
  assert(read('dist/client.js').includes(`window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)}`))
  assert(read('cordis.patch.yml').includes(manifest.name))
  assert(!read('dist/client.js').includes('node:child_process'), 'Host implementation leaked into the browser bundle')
  for (const entry of entries.filter(path => path.endsWith('.md'))) {
    for (const match of read(entry.slice('package/'.length)).matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      const target = match[1]
      if (/^[a-z]+:/i.test(target)) continue
      const parent = entry.slice(0, entry.lastIndexOf('/') + 1)
      assert(entries.includes(`${parent}${target}`), `Broken packaged link ${target} in ${entry}`)
    }
  }
  console.log(`Package verified: ${entries.length} files; exports, ModuleLoader and documentation links valid.`)
} finally { await rm(directory, { recursive: true, force: true }) }
