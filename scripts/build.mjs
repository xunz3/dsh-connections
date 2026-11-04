import { composeNativeSettings } from './native-settings.mjs'
import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  throw new Error('Every admitted remote release needs reviewed native contract inputs')
}
if (manifest.engines.dsh !== versions.local) throw new Error('The local engine must match the reviewed Harness contract boundary')
const shortcutsManifest = JSON.parse(await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-client-shortcuts/package.json')), 'utf8'))
if (manifest.engines.dsh !== shortcutsManifest.version) throw new Error('The native shortcuts adapter must target its exact tested Harness version')
assertNativeShortcutRegistry(await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-client-shortcuts/client')), 'utf8'))
const integrity = value => `sha512-${createHash('sha512').update(value).digest('base64')}`
const nativeInputs = {
  schema: 2, packages: [], adapters: [],
  boundaries: {
    clientRuntimeImports: 'forbidden',
    settingsFactory: 'constructor-only-owned-store',
    accountFactory: 'none-public-slot-delegation',
    shortcuts: 'private-content-and-settings-resolvers',
    settingsIcon: 'native-owned',
  },
}
const settingsSources = {}
for (const id of ['@deepseek-ai/dsh-client-shortcuts',
  ...Object.values(nativeContentReleases).flatMap(release => [release.settings, release.account]), ...nativeSettingsPackages]) {
  const metadata = JSON.parse(await readFile(new URL(import.meta.resolve(`${id}/package.json`)), 'utf8'))
  const source = await readFile(new URL(import.meta.resolve(`${id}/client`)), 'utf8')
  if (nativeSettingsPackages.includes(id)) {
    if (metadata.version !== versions.local) throw new Error(`Native Settings must match its tested version: ${id}`)
    settingsSources[id] = source
  }
  for (const release of Object.values(nativeContentReleases)) {
    for (const part of ['settings', 'account']) {
      if (release[part] === id && (metadata.version !== release.version
        || metadata.name !== (part === 'settings' ? '@deepseek-ai/dsh-client-ui-settings' : '@deepseek-ai/dsh-client-ui-settings-account'))) {
        throw new Error(`Native contract input does not match its reviewed version: ${id}`)
      }
    }
  }
  nativeInputs.packages.push({ name: metadata.name, version: metadata.version, clientIntegrity: integrity(source) })
}
assertNativeSettingsSlots(settingsSources)
for (const id of ['native-settings.mjs', 'native-shortcuts.mjs', 'native-contracts.mjs']) {
  nativeInputs.adapters.push({ path: `scripts/${id}`, integrity: integrity(await readFile(new URL(id, import.meta.url))) })
}
const nativeInputManifest = JSON.stringify(nativeInputs, null, 2) + '\n'
const contracts = JSON.parse(await readFile(new URL('../src/shared/contracts.json', import.meta.url), 'utf8'))
const contractManifest = JSON.stringify({
  package: name, version: manifest.version, contracts,
  buildInputHarness: versions.local, testedRemoteHarness: versions.remote,
  runtimeAdmission: 'exact-reviewed-versions',
  managedProfile: { owner: name, kind: 'connections-embedded', contract: 1 },
  nativeInputsIntegrity: integrity(nativeInputManifest),
}, null, 2) + '\n'
const uiLicense = await readFile(new URL('./LICENSE', import.meta.resolve('@deepseek-ai/dsh-client-ui-primitives/package.json')))
// Verify the complete emitted graph, including composed Settings source, rather
// than checking only our handwritten import declarations or a few known names.
function assertClientRuntimeImports(result) {
  for (const output of Object.values(result.metafile.outputs)) {
    for (const item of output.imports) {
      if (item.external && item.path.startsWith('@deepseek-ai/dsh-client')) throw new Error(`Harness Client runtime imports are forbidden: ${item.path}`)
    }
  }
}
function moduleBundle(source) {
  return `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory(require){const module={exports:{}};const exports=module.exports;\n${source}\nreturn module.exports;}});\n`
}
// This build owns only this checkout's dist, never a runtime installation.
const outputDirectory = resolve('dist')
if (outputDirectory !== resolve(fileURLToPath(new URL('../dist', import.meta.url)))) throw new Error('Build must run from the repository root')
await rm(outputDirectory, { recursive: true, force: true })
await mkdir('dist', { recursive: true })
await writeFile('dist/native-inputs.json', nativeInputManifest)
await writeFile('dist/contracts.json', contractManifest)
await writeFile('dist/native-ui.LICENSE', uiLicense)
await build({ entryPoints: ['src/host/index.ts'], outdir: 'dist/host', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22' })
// Local native sidebar/layout providers keep independent ownership.
const client = await build({ entryPoints: ['src/client/index.tsx'], bundle: true, packages: 'external', platform: 'browser', format: 'cjs', target: 'es2022', write: false, metafile: true })
assertClientRuntimeImports(client)
await writeFile('dist/client.js', moduleBundle(client.outputFiles[0].text))

// Only the Settings constructor needs a pre-consumer composition seam. Account
// remains an ordinary native plugin, not an extracted or re-registered factory.
const nativeContent = {
  name: 'native-settings-bootstrap',
  setup(build) {
    build.onResolve({ filter: /^@connections-native\// }, args => {
      const [scope, release, part, extra] = args.path.split('/')
      if (scope !== '@connections-native' || !Object.hasOwn(nativeContentReleases, release)
        || part !== 'settings' || extra !== undefined) throw new Error('Unsupported native content')
      return { path: '@connections-native/shared/settings', namespace: 'native-content' }
    })
    build.onLoad({ filter: /.*/, namespace: 'native-content' }, async () => {
      const nativeId = '@deepseek-ai/dsh-client-ui-settings'
      const metadata = JSON.parse(await readFile(new URL(import.meta.resolve(`${nativeId}/package.json`)), 'utf8'))
      if (metadata.version !== versions.local) throw new Error('Native Settings must match its exact tested version')
      const source = await readFile(new URL(import.meta.resolve(`${nativeId}/client`)), 'utf8')
      for (const reviewed of Object.values(nativeContentReleases)) {
        const input = JSON.parse(await readFile(new URL(import.meta.resolve(`${reviewed.settings}/package.json`)), 'utf8'))
        const inputSource = await readFile(new URL(import.meta.resolve(`${reviewed.settings}/client`)), 'utf8')
        if (input.name !== nativeId || input.version !== reviewed.version
          || inputSource.replaceAll(input.version, '<release>') !== source.replaceAll(metadata.version, '<release>')) {
          throw new Error(`Native Settings releases need separate implementations: ${reviewed.version}`)
        }
      }
      return { contents: composeNativeSettings(source), loader: 'js' }
    })
  },
}
const remoteClient = await build({ entryPoints: ['src/client/remote.ts'], bundle: true, packages: 'external', platform: 'browser', format: 'cjs', target: 'es2022', write: false, metafile: true, plugins: [nativeContent] })
assertClientRuntimeImports(remoteClient)
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
    '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-workspace',
    '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-theme',
    '@deepseek-ai/dsh-api-workspace-controller', '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-session',
  ] } }
  runtimeManifest.files = ['assets/logo.svg', 'locale/*.json', 'dist', 'cordis.patch.yml', 'LICENSE', 'NOTICE']
  runtimeManifest.exports = { ...manifest.exports, '.': { default: './dist/host/index.js' } }
  await writeFile(join(root, 'package.json'), JSON.stringify(runtimeManifest, null, 2))
  await writeFile(join(root, 'dist/host/index.js'), remoteHost.outputFiles[0].text)
  await writeFile(join(root, 'dist/client.js'), moduleBundle(remoteClient.outputFiles[0].text))
  await writeFile(join(root, 'LICENSE'), await readFile('LICENSE'))
  await writeFile(join(root, 'NOTICE'), await readFile('NOTICE'))
  await writeFile(join(root, 'dist/native-ui.LICENSE'), uiLicense)
  await writeFile(join(root, 'dist/native-inputs.json'), nativeInputManifest)
  await writeFile(join(root, 'dist/contracts.json'), contractManifest)
  await mkdir(join(root, 'assets'), { recursive: true })
  await mkdir(join(root, 'locale'), { recursive: true })
  await writeFile(join(root, 'assets/logo.svg'), await readFile('assets/logo.svg'))
  for (const locale of ['en', 'zh']) await writeFile(join(root, `locale/${locale}.json`), await readFile(`locale/${locale}.json`))
  await writeFile(join(root, 'dist/native-settings.LICENSE'), await readFile(new URL('./LICENSE', import.meta.resolve('@deepseek-ai/dsh-client-ui-settings/package.json'))))
  await writeFile(join(root, 'cordis.patch.yml'), [
    '- id: ui-settings', "  name: '@deepseek-ai/dsh-client-ui-settings'", '  disabled: true',
    '- id: ui-layout', "  name: '@deepseek-ai/dsh-client-ui-layout'", '  disabled: true',
    // A persistent Host must never wait on a server-side system dialog.
    '- id: directory-picker', "  name: '@deepseek-ai/dsh-host-directory-picker-auto'", '  disabled: true',
    '- insert:',
    '    - id: directory-picker-browse', "      name: '@deepseek-ai/dsh-host-directory-picker-browse'",
    '    - id: ui-directory-picker-browse', "      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'",
    '    - id: connections', `      name: '${name}'`, '      config:', '        embedded: true', '',
  ].join('\n'))
  execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', resolve('dist/remote-plugin.tgz'), '-C', staging, 'package'])
} finally { await rm(staging, { recursive: true, force: true }) }
