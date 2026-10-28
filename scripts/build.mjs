import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const { name } = manifest
const versions = JSON.parse(await readFile(new URL('../src/shared/harness-versions.json', import.meta.url), 'utf8'))
const sidebarManifest = JSON.parse(await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-sidebar/package.json')), 'utf8'))
if (manifest.engines.dsh !== sidebarManifest.version || manifest.engines.dsh !== versions.local) throw new Error('The native sidebar adapter must target its exact tested Harness version')
await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })
await build({ entryPoints: ['src/host/index.ts'], outdir: 'dist/host', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22' })
// Recompose the installed native sidebar without deploying a second owner of
// its child slots. Its dependencies still resolve through Harness ModuleLoader.
const nativeSidebar = {
  name: 'native-sidebar-composition',
  setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-sidebar\/client$/ }, () => ({ path: 'native-sidebar', namespace: 'native-sidebar' }))
    build.onLoad({ filter: /.*/, namespace: 'native-sidebar' }, async () => {
      const source = await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-sidebar/client')), 'utf8')
      const prefix = 'window.__ModuleLoader__.load('
      if (!source.startsWith(prefix)) throw new Error('Unsupported native sidebar bundle format')
      return { contents: source.replace(prefix, 'const nativeSidebar = (entry => entry.factory(require))(')
        + '\nexport const apply = nativeSidebar.apply; export const inject = nativeSidebar.inject;\n', loader: 'js' }
    })
  },
}
const client = await build({ entryPoints: ['src/client/index.tsx'], bundle: true, packages: 'external', platform: 'browser', format: 'cjs', target: 'es2022', write: false, plugins: [nativeSidebar] })
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory(require){const module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`)
await writeFile('dist/native-sidebar.LICENSE', await readFile(new URL('./LICENSE', import.meta.resolve('@deepseek-ai/dsh-client-ui-sidebar/package.json'))))

// The remote artifact has its own dependency graph: native content and workspace
// protocol only, without the version-pinned local sidebar or SSH management.
const remoteClient = await build({ entryPoints: ['src/client/remote.ts'], bundle: true, packages: 'external', platform: 'browser', format: 'cjs', target: 'es2022', write: false })
const remoteHost = await build({ entryPoints: ['src/host/remote.ts'], bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', write: false })
const staging = await mkdtemp(join(tmpdir(), 'dsh-connections-remote-package-'))
try {
  const root = join(staging, 'package')
  await mkdir(join(root, 'dist/host'), { recursive: true })
  const { devDependencies: _dev, scripts: _scripts, ...runtimeManifest } = manifest
  runtimeManifest.engines = { ...manifest.engines, dsh: versions.remote.join(' || ') }
  runtimeManifest.dependencies = {}
  runtimeManifest.peerDependencies = { '@deepseek-ai/cordis': manifest.peerDependencies['@deepseek-ai/cordis'] }
  runtimeManifest.dsh = { ...manifest.dsh, client: { ...manifest.dsh.client, inject: [
    '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-workspace',
    '@deepseek-ai/dsh-api-workspace-controller', '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-theme',
    '@deepseek-ai/dsh-client-ui-settings',
  ] } }
  runtimeManifest.files = ['dist', 'cordis.patch.yml', 'LICENSE']
  runtimeManifest.exports = { ...manifest.exports, '.': { default: './dist/host/index.js' } }
  await writeFile(join(root, 'package.json'), JSON.stringify(runtimeManifest, null, 2))
  await writeFile(join(root, 'dist/host/index.js'), remoteHost.outputFiles[0].text)
  await writeFile(join(root, 'dist/client.js'), `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory(require){const module={exports:{}};const exports=module.exports;\n${remoteClient.outputFiles[0].text}\nreturn module.exports;}});\n`)
  await writeFile(join(root, 'LICENSE'), await readFile('LICENSE'))
  await writeFile(join(root, 'cordis.patch.yml'), [
    '- id: ui-layout', "  name: '@deepseek-ai/dsh-client-ui-layout'", '  disabled: true',
    // A persistent Host can inherit a display without its original SSH launch
    // markers. Pin both native browse faces so it never waits on a host GUI.
    '- id: directory-picker', "  name: '@deepseek-ai/dsh-host-directory-picker-auto'", '  disabled: true',
    '- insert:',
    '    - id: directory-picker-browse', "      name: '@deepseek-ai/dsh-host-directory-picker-browse'",
    '    - id: ui-directory-picker-browse', "      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'",
    '    - id: connections', `      name: '${name}'`, '      config:', '        embedded: true', '',
  ].join('\n'))
  execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', resolve('dist/remote-plugin.tgz'), '-C', staging, 'package'])
} finally { await rm(staging, { recursive: true, force: true }) }
