import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const { name } = manifest
await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })
await build({ entryPoints: ['src/host/index.ts'], outdir: 'dist/host', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22' })
const client = await build({ entryPoints: ['src/client/index.tsx'], bundle: true, packages: 'external', platform: 'browser', format: 'cjs', target: 'es2022', write: false })
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory(require){const module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`)

// A self-contained installable bundle for the owned remote profile. Its code is
// identical; only the explicit plugin composition selects the content layout.
const staging = await mkdtemp(join(tmpdir(), 'dsh-connections-remote-package-'))
try {
  const root = join(staging, 'package')
  await mkdir(join(root, 'dist/host'), { recursive: true })
  const { devDependencies: _dev, scripts: _scripts, ...runtimeManifest } = manifest
  runtimeManifest.files = ['dist', 'cordis.patch.yml', 'LICENSE']
  runtimeManifest.exports = { ...manifest.exports, '.': { default: './dist/host/index.js' } }
  await writeFile(join(root, 'package.json'), JSON.stringify(runtimeManifest, null, 2))
  for (const file of ['dist/host/index.js', 'dist/client.js', 'LICENSE']) await writeFile(join(root, file), await readFile(file))
  await writeFile(join(root, 'cordis.patch.yml'), [
    '- id: ui-layout', "  name: '@deepseek-ai/dsh-client-ui-layout'", '  disabled: true',
    '- insert:', '    - id: connections', `      name: '${name}'`, '      config:', '        embedded: true', '',
  ].join('\n'))
  execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', resolve('dist/remote-plugin.tgz'), '-C', staging, 'package'])
} finally { await rm(staging, { recursive: true, force: true }) }
