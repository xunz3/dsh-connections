/** Opt-in real native Host checks; all state and logs stay in disposable homes. */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { WORKSPACE_ENDPOINT, WORKSPACE_PROTOCOL, parseWorkspaceResponse } from '../../src/shared/workspace-protocol.ts'
import { bindViewSurfaceParent } from '../../src/client/view-surface.ts'

const execute = promisify(execFile)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const repository = resolve(import.meta.dirname, '../..')
const versions = JSON.parse(await readFile(join(repository, 'src/shared/harness-versions.json'), 'utf8'))
const local = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
const sourceArchive = join(repository, 'dist/remote-plugin.tgz')
const archiveBytes = await readFile(sourceArchive)
const remote = JSON.parse((await execute('tar', ['-xOzf', sourceArchive, 'package/package.json'])).stdout)
const installations = process.argv.slice(2)
assert.equal(installations.length, versions.remote.length, 'Supply one isolated npm prefix per supported runtime.')
const testedVersions = new Set()

for (const prefix of installations) {
  const cli = join(resolve(prefix), 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  const version = (await execute(process.execPath, [cli, '--version'])).stdout.trim()
  assert(versions.remote.includes(version))
  assert(!testedVersions.has(version), 'Each supported native runtime must be tested once')
  testedVersions.add(version)
  const { evaluatePluginCompatibility } = await import(pathToFileURL(join(resolve(prefix), 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')))
  for (const candidate of versions.remote) {
    assert.equal(evaluatePluginCompatibility(remote, {}, candidate), undefined, `Remote engines must admit ${candidate}`)
    assert.equal(evaluatePluginCompatibility(local, {}, candidate) === undefined, candidate === versions.local, 'Local native sidebar remains exactly pinned')
  }
  for (const candidate of ['0.2.1-rc.1', '0.2.1-rc.4', '0.2.2-alpha.2', '0.2.2', '0.3.0']) assert(evaluatePluginCompatibility(remote, {}, candidate), 'Untested releases must be rejected')
  const root = await mkdtemp(join(tmpdir(), `dsh-connections-compat-${version}-`))
  const archive = join(root, createHash('sha256').update(archiveBytes).digest('hex') + '.tgz')
  await writeFile(archive, archiveBytes, { mode: 0o600 })
  const env = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  env.DSH_HOME = join(root, 'home')
  env.DSH_AGENTS_HOME = join(root, 'agents')
  for (const path of [env.DSH_HOME, env.DSH_AGENTS_HOME]) await mkdir(path, { mode: 0o700 })
  let child
  let handle
  let browser
  let stopSurface
  let passed = false
  try {
    console.log(`${version}: installing the checked remote archive in an isolated profile.`)
    const installed = await execute(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', '--save-exact', archive], { cwd: root, env, timeout: 300000, maxBuffer: 4 * 1024 * 1024 })
    await writeFile(join(root, 'install.log'), installed.stdout + installed.stderr, { mode: 0o600 })
    handle = await open(join(root, 'service.log'), 'w', 0o600)
    child = spawn(process.execPath, [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: root, env, stdio: ['ignore', handle.fd, handle.fd] })
    let launch
    for (let attempt = 0; attempt < 1200; attempt++) {
      launch = (await readFile(join(root, 'service.log'), 'utf8')).match(/^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)$/m)?.[1]
      if (launch) break
      if (child.exitCode !== null) throw new Error(`Native ${version} exited; inspect private log in ${root}`)
      await pause(100)
    }
    assert(launch, `Native ${version} did not become ready; inspect private log in ${root}`)
    const origin = new URL(launch).origin
    const login = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    assert.equal(login.status, 303)
    const expected = 'dsh-auth-' + createHash('sha256').update(new URL(origin).host).digest('base64url') + '='
    let cookie = login.headers.getSetCookie().find(value => value.startsWith(expected))?.split(';')[0]
    assert(cookie)
    async function post(path, body, signal) {
      const response = await fetch(new URL(path, origin), { method: 'POST', redirect: 'error', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]) })
      assert.equal(response.status, 200)
      return response.json()
    }
    async function rpc(method, args, service = 'pluginManager') {
      const response = await post(`/api/${service}/${method}`, { type: 'client-request', rpcId: randomUUID(), method: `${service}/${method}`, payload: { args } })
      assert.equal(response.result?.ok, true)
      return response.result.value
    }
    async function workspace(request, signal) {
      const response = parseWorkspaceResponse(request.op, await post(WORKSPACE_ENDPOINT, request, signal))
      if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code })
      return response.value
    }
    async function uiPreferences() {
      const { namespaces } = await rpc('describe', {}, 'settings')
      return namespaces.filter(row => ['locale', 'ui-theme', 'ui-chat', 'ui-conversation', 'ui-settings'].includes(row.ns))
        .map(({ ns, value, user }) => ({ ns, value, user }))
    }
    const entries = (await rpc('listPlugins', {})).filter(row => row.moduleName === local.name)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].enabled, true)
    const installedClient = join(env.DSH_HOME, 'profiles/web/node_modules', local.name, 'dist/client.js')
    const expectedClient = await readFile(installedClient)
    await rm(installedClient)
    const repairArchive = archive.replace(/\.tgz$/, '-repair-' + randomUUID() + '.tgz')
    await writeFile(repairArchive, archiveBytes, { mode: 0o600 })
    const repaired = await execute(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', '--save-exact', repairArchive], { cwd: root, env, timeout: 300000, maxBuffer: 4 * 1024 * 1024 })
    await writeFile(join(root, 'repair.log'), repaired.stdout + repaired.stderr, { mode: 0o600 })
    assert.deepEqual(await readFile(installedClient), expectedClient, 'Native same-byte repair must restore missing package bytes')
    // Production maintenance authenticates afresh after CLI writes. Match that
    // boundary instead of reusing a pre-install owner session in this fixture.
    const refreshedLogin = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    assert.equal(refreshedLogin.status, 303)
    cookie = refreshedLogin.headers.getSetCookie().find(value => value.startsWith(expected))?.split(';')[0]
    assert(cookie)
    assert.equal((await rpc('setPluginEnabled', { id: entries[0].entryId, enabled: true })).application, 'applied')
    const catalog = await post('/api/connections/workspaces', { op: 'catalog', protocol: WORKSPACE_PROTOCOL })
    assert.equal(catalog.ok, true)
    // Protocol 3 bootstraps the child from its parent's presentation before any
    // native Locale/Theme service can select remote UI preferences.
    let presentation = { locale: 'en', theme: {
      preference: 'light', fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
      textFontFamily: '', codeFontFamily: '', terminalFontFamily: '',
    }, tokens: {}, general: {
      transcriptView: 'standard', collapseTiming: 'completion', performanceUsage: 'compact',
      linkOpening: 'sidebar', busyEnter: 'queue', developerTools: false,
    } }
    const view = await post('/api/connections/workspaces', { op: 'openView', protocol: WORKSPACE_PROTOCOL, clientId: randomUUID(), presentation })
    assert.equal(view.ok, true)
    assert.equal(view.value.protocol, WORKSPACE_PROTOCOL)
    assert.deepEqual(await workspace({ op: 'surfaceSnapshot', channel: view.value.channel }), { nativeVersion: version, presentation })
    if (process.env.DSH_QA_BROWSER === '1') {
      const { chromium, expect } = await import('@playwright/test')
      const previousPreferences = await uiPreferences()
      const externalActions = []
      let revision = view.value.revision
      stopSurface = bindViewSurfaceParent({ channel: view.value.channel, endpoint: workspace,
        getRevision: () => revision, getPresentation: () => presentation,
        perform: async action => { externalActions.push(action); throw new Error('No login action is expected in this fixture') },
      })
      browser = await chromium.launch({ headless: true })
      const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1000, height: 760 } })
      const equals = cookie.indexOf('=')
      await context.addCookies([{ name: cookie.slice(0, equals), value: cookie.slice(equals + 1), url: origin, httpOnly: true, sameSite: 'Strict' }])
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(origin + '/#connections-view=' + view.value.channel)
      const preview = page.getByRole('button', { name: 'Continue', exact: true })
      if (await preview.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await preview.click()
      const welcome = page.getByRole('dialog', { name: 'Get started', exact: true })
      if (await welcome.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await welcome.getByRole('button', { name: 'Close', exact: true }).click()
      revision = (await workspace({ op: 'navigate', channel: view.value.channel, requestId: randomUUID(), target: { kind: 'pick' } })).revision
      const picker = page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
      await expect(picker).toBeVisible({ timeout: 30000 })
      const presented = await post('/api/connections/workspaces', { op: 'viewState', channel: view.value.channel })
      assert.equal(presented.ok, true)
      assert.equal(presented.value.presentedRevision, presented.value.revision)
      const project = join(root, 'project')
      await mkdir(project)
      await writeFile(join(project, 'README.md'), '# Remote compatibility fixture\n')
      await picker.getByRole('button', { name: 'Edit path', exact: true }).click()
      const editor = picker.getByRole('textbox', { name: 'Edit path', exact: true })
      await editor.fill(project)
      await editor.press('Enter')
      await expect(editor).toHaveCount(0)
      await picker.getByRole('button', { name: 'Open', exact: true }).click()
      await expect(picker).toBeHidden()
      await expect.poll(async () => {
        const state = await post('/api/connections/workspaces', { op: 'viewState', channel: view.value.channel })
        return state.value?.sessionId
      }, { timeout: 30000 }).toBeTruthy()
      revision = (await workspace({ op: 'navigate', channel: view.value.channel, requestId: randomUUID(), target: { kind: 'settings' } })).revision
      const settings = page.locator('[data-shortcut-modal="settings"]').filter({ has: page.locator('[data-slot="settings.header"]') })
      // Native onboarding belongs to the sidebar and can first mount when this
      // remote document exposes Settings. Complete that same first-use flow.
      if (await preview.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await preview.click()
      if (await welcome.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await welcome.getByRole('button', { name: 'Close', exact: true }).click()
      const launcher = page.getByRole('button', { name: 'Open settings', exact: true })
      await expect.poll(async () => await settings.isVisible() || await launcher.isVisible(), { timeout: 30000 }).toBe(true)
      if (!await settings.isVisible()) await launcher.click()
      await expect(settings).toBeVisible({ timeout: 30000 })
      await settings.getByRole('button', { name: 'Models', exact: true }).click()
      await expect(settings.getByRole('button', { name: 'Models', exact: true })).toHaveAttribute('aria-current', 'true')
      await settings.getByRole('button', { name: 'Built-in plugins', exact: true }).click()
      await expect(settings.getByRole('searchbox', { name: 'Search plugins', exact: true })).toBeVisible()
      await expect(settings.getByText('Global plugins', { exact: true })).toBeVisible()
      presentation = { ...presentation, locale: 'zh', theme: { ...presentation.theme, preference: 'dark', fontSize: 18 } }
      await expect(page.locator('html')).toHaveAttribute('lang', /^zh/, { timeout: 15000 })
      await expect(page.locator('body')).toHaveAttribute('data-ds-dark-theme', '')
      assert.deepEqual(await uiPreferences(), previousPreferences, 'Parent presentation must not write remote UI preferences')
      assert.deepEqual(externalActions, [], 'The fixture never opens an external sign-in flow')
      assert.deepEqual(errors, [], 'The embedded native UI must load without page errors')
      stopSurface()
      stopSurface = undefined
      await browser.close()
      browser = undefined
      console.log(`${version}: embedded browser, native directory picker, presentation acknowledgement, session selection, Models, Built-in plugins and parent-owned Locale/Theme without remote preference writes passed.`)
    }
    assert.equal((await post('/api/connections/workspaces', { op: 'closeView', channel: view.value.channel })).ok, true)
    assert.equal(child.exitCode, null)
    console.log(`${version}: native compatibility evaluator, isolated install, startup, same-archive repair, activation, catalog and view protocol passed.`)
    passed = true
  } catch (error) {
    // Native errors may contain owner launch URLs. Keep subprocess output private.
    if (error.stdout !== undefined || error.stderr !== undefined) {
      await writeFile(join(root, 'failure.log'), String(error.stdout ?? '') + String(error.stderr ?? ''), { mode: 0o600 })
      throw new Error(`Native ${version} CLI failed; inspect private log in ${root}`)
    }
    throw error
  } finally {
    stopSurface?.()
    await browser?.close()
    child?.kill('SIGTERM')
    if (child) for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) await pause(50)
    if (child?.exitCode === null) child.kill('SIGKILL')
    await handle?.close()
    if (passed) await rm(root, { recursive: true, force: true })
  }
}
