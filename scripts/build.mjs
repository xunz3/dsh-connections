import { composeNativeSettings } from './native-settings.mjs'
import { composeNativeAccount } from './native-account.mjs'
import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { composeNativeSidebar } from './native-sidebar.mjs'
import { assertNativeShortcutRegistry } from './native-shortcuts.mjs'
import { assertNativeSettingsSlots, nativeSettingsPackages } from './native-contracts.mjs'
import { createHash } from 'node:crypto'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const { name } = manifest
const versions = JSON.parse(await readFile(new URL('../src/shared/harness-versions.json', import.meta.url), 'utf8'))
const nativeContentReleases = {
  rc2: { version: '0.2.1-rc.2', settings: 'native-settings-rc2', account: 'native-account-rc2' },
  rc3: { version: '0.2.1-rc.3', settings: 'native-settings-rc3', account: 'native-account-rc3' },
  rc5: { version: '0.2.1-rc.5', settings: '@deepseek-ai/dsh-client-ui-settings', account: '@deepseek-ai/dsh-client-ui-settings-account' },
}
if (JSON.stringify(Object.values(nativeContentReleases).map(release => release.version)) !== JSON.stringify(versions.remote)) {
  throw new Error('Every admitted remote release needs reviewed native content inputs')
}
const sidebarManifest = JSON.parse(await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-sidebar/package.json')), 'utf8'))
if (manifest.engines.dsh !== sidebarManifest.version || manifest.engines.dsh !== versions.local) throw new Error('The native sidebar adapter must target its exact tested Harness version')
const shortcutsManifest = JSON.parse(await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-client-shortcuts/package.json')), 'utf8'))
if (manifest.engines.dsh !== shortcutsManifest.version) throw new Error('The native shortcuts adapter must target its exact tested Harness version')
assertNativeShortcutRegistry(await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-client-shortcuts/client')), 'utf8'))
const integrity = value => `sha512-${createHash('sha512').update(value).digest('base64')}`
const nativeInputs = { packages: [], adapters: [] }
const settingsSources = {}
for (const id of ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-shortcuts',
  ...Object.values(nativeContentReleases).flatMap(release => [release.settings, release.account]), ...nativeSettingsPackages]) {
  const metadata = JSON.parse(await readFile(new URL(import.meta.resolve(`${id}/package.json`)), 'utf8'))
  const source = await readFile(new URL(import.meta.resolve(`${id}/client`)), 'utf8')
  if (nativeSettingsPackages.includes(id)) {
    if (metadata.version !== versions.local) throw new Error(`Native Settings must match its tested version: ${id}`)
    settingsSources[id] = source
  }
  nativeInputs.packages.push({ name: metadata.name, version: metadata.version, clientIntegrity: integrity(source) })
}
assertNativeSettingsSlots(settingsSources)
for (const id of ['native-sidebar.mjs', 'native-settings.mjs', 'native-account.mjs', 'native-shortcuts.mjs', 'native-contracts.mjs']) {
  nativeInputs.adapters.push({ path: `scripts/${id}`, integrity: integrity(await readFile(new URL(id, import.meta.url))) })
}
const nativeInputManifest = JSON.stringify(nativeInputs, null, 2) + '\n'
await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })
await writeFile('dist/native-inputs.json', nativeInputManifest)
await build({ entryPoints: ['src/host/index.ts'], outdir: 'dist/host', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22' })
// Recompose the installed native sidebar without deploying a second owner of
// its child slots. Its dependencies still resolve through Harness ModuleLoader.
const nativeSidebar = {
  name: 'native-sidebar-composition',
  setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-sidebar\/client$/ }, () => ({ path: 'native-sidebar', namespace: 'native-sidebar' }))
    build.onLoad({ filter: /.*/, namespace: 'native-sidebar' }, async () => {
      const source = await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-sidebar/client')), 'utf8')
      return { contents: composeNativeSidebar(source, name), loader: 'js' }
    })
  },
}
const client = await build({ entryPoints: ['src/client/index.tsx'], bundle: true, packages: 'external', platform: 'browser', format: 'cjs', target: 'es2022', write: false, plugins: [nativeSidebar] })
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory(require){const module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`)
await writeFile('dist/native-sidebar.LICENSE', await readFile(new URL('./LICENSE', import.meta.resolve('@deepseek-ai/dsh-client-ui-sidebar/package.json'))))

// The remote artifact has its own dependency graph: native content and workspace
// protocol only, without the version-pinned local sidebar or SSH management.
const nativeContent = {
  name: 'native-content-composition',
  setup(build) {
    build.onResolve({ filter: /^@connections-native\// }, args => {
      const [scope, release, part, extra] = args.path.split('/')
      if (scope !== '@connections-native' || !Object.hasOwn(nativeContentReleases, release)
        || !['settings', 'account'].includes(part) || extra !== undefined) throw new Error('Unsupported native content')
      return { path: `@connections-native/shared/${part}`, namespace: 'native-content' }
    })
    build.onLoad({ filter: /.*/, namespace: 'native-content' }, async ({ path }) => {
      const [, release, part] = path.split('/')
      const nativeId = { settings: '@deepseek-ai/dsh-client-ui-settings', account: '@deepseek-ai/dsh-client-ui-settings-account' }[part]
      if (!nativeId || release !== 'shared') throw new Error('Unsupported native content')
      const packageId = nativeId
      const metadata = JSON.parse(await readFile(new URL(import.meta.resolve(`${packageId}/package.json`)), 'utf8'))
      if (metadata.name !== nativeId || metadata.version !== versions.local) throw new Error('Native content must match its exact tested version')
      const source = await readFile(new URL(import.meta.resolve(`${packageId}/client`)), 'utf8')
      // Share a factory only after checking every admitted release's actual
      // source. A changed implementation needs a separately reviewed adapter.
      for (const reviewed of Object.values(nativeContentReleases)) {
        const input = JSON.parse(await readFile(new URL(import.meta.resolve(`${reviewed[part]}/package.json`)), 'utf8'))
        const inputSource = await readFile(new URL(import.meta.resolve(`${reviewed[part]}/client`)), 'utf8')
        if (input.name !== nativeId || input.version !== reviewed.version
          || inputSource.replaceAll(input.version, '<release>') !== source.replaceAll(metadata.version, '<release>')) {
          throw new Error(`Native settings releases need separate implementations: ${reviewed.version}/${part}`)
        }
      }
      return { contents: part === 'account' ? composeNativeAccount(source, name) : composeNativeSettings(source), loader: 'js' }
    })
  },
}
const remoteClient = await build({ entryPoints: ['src/client/remote.ts'], bundle: true, packages: 'external', platform: 'browser', format: 'cjs', target: 'es2022', write: false, plugins: [nativeContent] })
const remoteHost = await build({ entryPoints: ['src/host/remote.ts'], bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', write: false })
const staging = await mkdtemp(join(tmpdir(), 'dsh-connections-remote-package-'))
try {
  const root = join(staging, 'package')
  await mkdir(join(root, 'dist/host'), { recursive: true })
  const { devDependencies: _dev, scripts: _scripts, ...runtimeManifest } = manifest
  runtimeManifest.engines = { ...manifest.engines, dsh: versions.remote.join(' || ') }
  runtimeManifest.dependencies = { '@deepseek-ai/schemastery': manifest.dependencies['@deepseek-ai/schemastery'] }
  runtimeManifest.peerDependencies = { '@deepseek-ai/cordis': manifest.peerDependencies['@deepseek-ai/cordis'], '@deepseek-ai/dsh-app-boot': versions.remote.join(' || ') }
  runtimeManifest.dsh = { ...manifest.dsh, client: { ...manifest.dsh.client, inject: [
    '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-workspace',
    '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-theme',
    '@deepseek-ai/dsh-api-workspace-controller', '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-session',
  ] } }
  runtimeManifest.files = ['assets/logo.svg', 'locale/*.json', 'dist', 'cordis.patch.yml', 'LICENSE', 'NOTICE']
  runtimeManifest.exports = { ...manifest.exports, '.': { default: './dist/host/index.js' } }
  await writeFile(join(root, 'package.json'), JSON.stringify(runtimeManifest, null, 2))
  await writeFile(join(root, 'dist/host/index.js'), remoteHost.outputFiles[0].text)
  await writeFile(join(root, 'dist/client.js'), `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory(require){const module={exports:{}};const exports=module.exports;\n${remoteClient.outputFiles[0].text}\nreturn module.exports;}});\n`)
  await writeFile(join(root, 'LICENSE'), await readFile('LICENSE'))
  await writeFile(join(root, 'NOTICE'), await readFile('NOTICE'))
  await writeFile(join(root, 'dist/native-inputs.json'), nativeInputManifest)
  await mkdir(join(root, 'assets'), { recursive: true })
  await mkdir(join(root, 'locale'), { recursive: true })
  await writeFile(join(root, 'assets/logo.svg'), await readFile('assets/logo.svg'))
  for (const locale of ['en', 'zh']) await writeFile(join(root, `locale/${locale}.json`), await readFile(`locale/${locale}.json`))
  for (const part of ['settings', 'account']) {
    const nativeId = { settings: '@deepseek-ai/dsh-client-ui-settings', account: '@deepseek-ai/dsh-client-ui-settings-account' }[part]
    await writeFile(join(root, `dist/native-${part}.LICENSE`), await readFile(new URL('./LICENSE', import.meta.resolve(`${nativeId}/package.json`))))
  }
  await writeFile(join(root, 'cordis.patch.yml'), [
    '- id: ui-settings', "  name: '@deepseek-ai/dsh-client-ui-settings'", '  disabled: true',
    '- id: ui-settings-account', "  name: '@deepseek-ai/dsh-client-ui-settings-account'", '  disabled: true',
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
