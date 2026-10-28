import { WORKSPACE_PROTOCOL } from '../../src/shared/workspace-protocol.js'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, request as apiRequest, test, type FrameLocator, type Page, type Request, type Route } from '@playwright/test'
import type { WorkspaceCatalog, WorkspaceViewState } from '../../src/shared/workspace-protocol.js'

type Surface = Page | FrameLocator
const fixturePath = process.env.DSH_UNIFIED_FIXTURE
const connectionName = 'Unified native SSH'

async function launch(path: string): Promise<string> {
  const value = (await readFile(path, 'utf8')).match(/dsh web: (http[^\s]+)/)?.[1]
  if (!value) throw new Error('The isolated Host has no startup URL.')
  return value
}
async function dismissWelcome(surface: Surface): Promise<void> {
  const preview = surface.getByRole('button', { name: 'Continue', exact: true })
  if (await preview.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await preview.click()
  const welcome = surface.getByRole('dialog', { name: 'Get started', exact: true })
  if (await welcome.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await welcome.getByRole('button', { name: 'Close', exact: true }).click()
  const apiSetup = surface.getByRole('dialog', { name: 'Add an API key to get started', exact: true })
  if (await apiSetup.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await apiSetup.getByRole('button', { name: 'Configure later', exact: true }).click()
}
async function chooseDirectory(surface: Surface, path: string): Promise<void> {
  const picker = surface.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
  await picker.getByRole('button', { name: 'Edit path', exact: true }).click()
  const editor = picker.getByRole('textbox', { name: 'Edit path', exact: true })
  await editor.fill(path)
  await editor.press('Enter')
  await expect(editor).toHaveCount(0)
  await picker.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(picker).toBeHidden()
}
async function prepareConnection(page: Page, alias: string, remoteUrl: string): Promise<void> {
  await expect(page.getByRole('button', { name: 'Account menu', exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Connections', exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: 'Connections', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Connections', exact: true })
  await expect(panel.getByText('Loading connections…')).toHaveCount(0)
  if (!await panel.getByText(connectionName, { exact: true }).count()) {
    await panel.getByRole('button', { name: 'Add connection', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Refresh SSH hosts', exact: true })).toBeEnabled()
    const manual = panel.getByRole('button', { name: 'Add manually', exact: true })
    if (await manual.isVisible()) await manual.click()
    await panel.getByLabel('Name', { exact: true }).fill(connectionName)
    await panel.getByLabel('SSH host', { exact: false }).fill(alias)
    await panel.getByRole('combobox', { name: /Remote Harness/ }).selectOption('existing')
    await panel.getByLabel('Remote Harness URL', { exact: false }).fill(remoteUrl)
    await panel.getByRole('button', { name: 'Save connection', exact: true }).click()
    await expect(panel.getByText(connectionName, { exact: true })).toBeVisible()
  } else {
    // The owned remote Host may have restarted between acceptance runs.
    await panel.getByLabel(`More actions: ${connectionName}`).click()
    await panel.getByRole('button', { name: 'Edit', exact: true }).click()
    await panel.getByLabel('Remote Harness URL', { exact: false }).fill(remoteUrl)
    await panel.getByRole('button', { name: 'Save connection', exact: true }).click()
    await expect(panel.getByRole('form', { name: 'Edit', exact: true })).toHaveCount(0)
  }
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
}
async function showFiles(surface: Surface): Promise<void> {
  const toggle = surface.getByRole('button', { name: 'Open right sidebar', exact: true })
  const guide = surface.getByRole('button', { name: /^Workspace files/ })
  const files = surface.getByRole('tab', { name: /^Files(?:\s|$)/ })
  await expect.poll(async () => await toggle.isVisible() || await guide.isVisible() || await files.isVisible()).toBe(true)
  if (await toggle.isVisible()) await toggle.click()
  await expect.poll(async () => await guide.isVisible() || await files.isVisible()).toBe(true)
  if (await guide.isVisible()) await guide.click()
  else await files.click()
}
async function verifyFiles(surface: Surface, path: string, side: 'local' | 'remote'): Promise<void> {
  await showFiles(surface)
  const tree = surface.locator('[data-files-state="tree"]')
  await expect(tree).toHaveAttribute('data-files-root', path)
  const directory = tree.locator('[data-files-path$="/nested"] > button')
  if (await directory.getAttribute('aria-expanded') !== 'true') await directory.click()
  await tree.locator('[data-files-path$="/nested/source.txt"] > button').click()
  await expect(surface.getByText(`native ${side} sidebar nested file`, { exact: false })).toBeVisible()
}
async function verifyRemoteUpload(page: Page, remote: FrameLocator): Promise<void> {
  const origin = new URL((await page.locator('iframe[title="Remote workspace"]').getAttribute('src'))!).origin
  const uploaded = page.context().waitForEvent('response', { predicate: response => new URL(response.url()).pathname === '/api/session/uploadFileBinary', timeout: 15_000 })
  await remote.locator('input[type="file"]').setInputFiles({ name: 'remote-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('Isolated remote upload fixture.\n') })
  const response = await uploaded
  expect(new URL(response.url()).origin).toBe(origin)
  expect(response.ok()).toBe(true)
  // Harness terminates its dedicated upload worker as soon as it accepts the
  // receipt, so CDP cannot reliably read that worker's response body afterwards.
  // The native ready card is the consumer's confirmation of a successful receipt.
  await expect(remote.getByText('remote-upload.txt', { exact: true })).toBeVisible()
  await expect(remote.locator('[title="remote-upload.txt"]').getByText(/^TXT /)).toBeVisible()
  await remote.getByRole('button', { name: 'Remove file remote-upload.txt', exact: true }).click()
  await expect(remote.getByText('remote-upload.txt', { exact: true })).toHaveCount(0)
}
async function verifyRemoteMedia(page: Page, remote: FrameLocator): Promise<void> {
  const origin = new URL((await page.locator('iframe[title="Remote workspace"]').getAttribute('src'))!).origin
  await showFiles(remote)
  const file = remote.locator('[data-files-state="tree"] [data-files-path$="/media.md"] > button')
  await expect(file).toBeVisible()
  const media = page.context().waitForEvent('response', { predicate: response => {
    const url = new URL(response.url())
    return url.pathname === '/api/file' && url.searchParams.get('path')?.endsWith('/media.svg') === true
  }, timeout: 15_000 })
  const [response] = await Promise.all([media, file.click()])
  expect(new URL(response.url()).origin).toBe(origin)
  expect(response.ok()).toBe(true)
  const image = remote.getByRole('img', { name: 'Native remote preview', exact: true })
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(120)
}
async function remoteView(remote: FrameLocator): Promise<WorkspaceViewState | undefined> {
  return remote.locator('body').evaluate(async () => {
    const channel = new URLSearchParams(window.location.hash.slice(1)).get('connections-view')
    const response = await fetch(new URL('/api/connections/workspaces', document.baseURI), {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'viewState', channel }),
    })
    const value = await response.json() as { ok: boolean; value?: WorkspaceViewState }
    return value.ok ? value.value : undefined
  })
}
async function selectedRemoteSession(remote: FrameLocator): Promise<string | undefined> {
  return (await remoteView(remote))?.sessionId
}
async function catalog(surface: Surface): Promise<WorkspaceCatalog> {
  return surface.locator('body').evaluate(async (_body, protocol) => {
    const response = await fetch('/api/connections/workspaces', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'catalog', protocol }),
    })
    const result = await response.json() as { ok: boolean; value?: WorkspaceCatalog }
    if (!result.ok || result.value === undefined) throw new Error('The native workspace catalog was unavailable.')
    return result.value
  }, WORKSPACE_PROTOCOL)
}
/** Read a Host before mounting its native UI; this cannot run its first-use navigation. */
async function catalogBeforeUi(startup: string): Promise<WorkspaceCatalog> {
  const request = await apiRequest.newContext()
  try {
    const authenticated = await request.get(startup).catch(() => { throw new Error('The isolated Host authentication failed.') })
    if (!authenticated.ok()) throw new Error('The isolated Host authentication failed.')
    const response = await request.post(new URL('/api/connections/workspaces', startup).href, { data: { op: 'catalog', protocol: WORKSPACE_PROTOCOL } })
    const result = await response.json() as { ok: boolean; value?: WorkspaceCatalog }
    if (!result.ok || result.value === undefined) throw new Error('The isolated Host catalog was unavailable.')
    return result.value
  } finally { await request.dispose() }
}
async function verifyNewSession(page: Page, source: 'local' | 'remote'): Promise<void> {
  const remote = page.frameLocator('iframe[title="Remote workspace"]')
  const surface = source === 'local' ? page : remote
  const expectedOrigin = source === 'local' ? new URL(page.url()).origin
    : new URL((await page.locator('iframe[title="Remote workspace"]').getAttribute('src'))!).origin
  if (source === 'remote') {
    const selectedSource = await page.evaluate(() => {
      const saved = localStorage.getItem('@xunz/dsh-connections/selection')
      return saved ? (JSON.parse(saved) as { sourceId?: string }).sourceId : undefined
    })
    expect(selectedSource).toBeTruthy()
    expect(selectedSource).not.toBe('local')
  }
  const before = (await catalog(surface)).sessions.map(session => session.id).sort()
  const selection = () => surface.locator('body').evaluate(() =>
    (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId)
  await expect.poll(selection).toBeTruthy()
  const selectedBefore = await selection()
  const editor = surface.locator('[data-composer-input][contenteditable="true"]')
  const draft = `Unsent ${source} rc.3 draft`
  await editor.fill(draft)
  const origins: string[] = []
  const observe = (request: Request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/session/create') origins.push(url.origin)
  }
  page.context().on('request', observe)
  try {
    const created = page.context().waitForEvent('response', {
      predicate: response => new URL(response.url()).pathname === '/api/session/create', timeout: 15_000,
    })
    await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click()
    const response = await created
    expect(new URL(response.url()).origin).toBe(expectedOrigin)
    expect(response.ok()).toBe(true)
    // rc.3 returns to the workspace's reusable blank, including its unsent draft.
    await expect.poll(selection).toBe(selectedBefore)
    await expect(editor).toHaveText(draft)
    expect((await catalog(surface)).sessions.map(session => session.id).sort()).toEqual(before)
    if (source === 'remote') {
      await expect(page.locator('.dc-remote-loading')).toHaveCount(0)
      await expect.poll(async () => {
        const selected = await selectedRemoteSession(remote)
        return selected
      }).toBe(selectedBefore)
    } else await expect(page.locator('iframe[title="Remote workspace"]')).toHaveCount(0)
    expect(origins.length).toBeGreaterThan(0)
    expect(origins.every(origin => origin === expectedOrigin)).toBe(true)
  } finally { page.context().off('request', observe); await editor.fill('') }
}
async function verifyLoadingAcknowledgement(page: Page, open: () => Promise<void>): Promise<void> {
  let acknowledge!: () => void
  let received = false
  const release = new Promise<void>(resolve => { acknowledge = resolve })
  const intercept = async (route: Route) => {
    const body = route.request().postDataJSON() as { op?: string; presented?: boolean } | null
    if (body?.op === 'reportView' && body.presented === true) { received = true; await release }
    await route.continue()
  }
  await page.context().route('**/api/connections/workspaces', intercept)
  try {
    await open()
    const remote = page.frameLocator('iframe[title="Remote workspace"]')
    await expect(remote.locator('.dc-embedded-layout')).toBeVisible({ timeout: 30_000 })
    await expect(remote.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })).toBeVisible()
    await expect.poll(() => received, { timeout: 15_000 }).toBe(true)
    await expect(page.locator('.dc-remote-loading')).toBeVisible()
    const pending = await remoteView(remote)
    expect(pending!.presentedRevision).toBeLessThan(pending!.revision)
    acknowledge()
    await expect(page.locator('.dc-remote-loading')).toHaveCount(0, { timeout: 15_000 })
    const presented = await remoteView(remote)
    expect(presented!.presentedRevision).toBe(presented!.revision)
  } finally { acknowledge(); await page.context().unroute('**/api/connections/workspaces', intercept) }
}
async function verifyParentShortcutGuard(page: Page): Promise<void> {
  const workspaces = page.getByRole('region', { name: 'Workspaces', exact: true })
  const focusTarget = workspaces.getByRole('button', { name: `remote-project · ${connectionName}`, exact: true })
  await focusTarget.focus()
  await page.keyboard.press('Control+Slash')
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })
  await expect(shortcuts).toBeVisible()
  // Linux Web leaves workspace commands unbound by default. Configure through
  // the native recorder so the guard must honor accepted user bindings.
  for (const [label, keys] of [['Archive session', 'Control+Shift+Period'], ['Fork session', 'Control+Shift+Comma']] as const) {
    await shortcuts.getByRole('button', { name: `Edit shortcut for ${label}`, exact: true }).click()
    await shortcuts.getByRole('button', { name: 'Press a shortcut', exact: true }).focus()
    await page.keyboard.press(keys)
    await expect(shortcuts.getByRole('button', { name: `Edit shortcut for ${label}`, exact: true })).toBeVisible()
  }
  const accepted = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.keybindings.v1') ?? '{}') as {
    profiles?: Record<string, Record<string, { code: string }>>
  })
  expect(accepted.profiles?.['web:linux']?.['session.archive']?.code).toBe('Period')
  expect(accepted.profiles?.['web:linux']?.['session.fork']?.code).toBe('Comma')
  await shortcuts.getByRole('button', { name: 'Close keyboard shortcuts', exact: true }).click()
  const archived = async () => page.evaluate(async protocol => {
    const response = await fetch('/api/connections/workspaces', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'catalog', protocol }),
    })
    const result = await response.json() as { ok: boolean; value?: { archivedSessionIds: string[] } }
    if (!result.ok) throw new Error('The local workspace catalog was unavailable.')
    return result.value!.archivedSessionIds
  }, WORKSPACE_PROTOCOL)
  const before = await archived()
  const localOrigin = new URL(page.url()).origin
  const mutations: string[] = []
  const observe = (request: Request) => {
    const url = new URL(request.url())
    if (url.origin === localOrigin && (url.pathname === '/api/workspace/archiveSession'
      || url.pathname === '/api/session/fork'
      || url.pathname === '/api/connections/workspace' && request.postData()?.includes('archiveSession'))) mutations.push(url.pathname)
  }
  page.context().on('request', observe)
  try {
    for (const keys of ['Control+Shift+Period', 'Control+Shift+Comma']) {
      await focusTarget.focus()
      await page.keyboard.press(keys)
      const notice = page.locator('.dcw-command-note')
      await expect(notice).toContainText('Use the selected remote chat’s actions or focus its conversation before using this shortcut.')
      await notice.getByRole('button', { name: 'Cancel', exact: true }).click()
    }
    expect(await archived()).toEqual(before)
    expect(mutations).toEqual([])
  } finally { page.context().off('request', observe) }
}

test('dedicated remote profile boots its public embedded layout without a second sidebar', async ({ page }, info) => {
  test.skip(!fixturePath, 'Set DSH_UNIFIED_FIXTURE to an isolated two-Host native fixture')
  page.setDefaultTimeout(15_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message.replace(/([?&]token=)[^&\s"']+/gi, '$1[redacted]')))
  await page.goto(await launch(join(fixturePath!, 'remote.log')), { waitUntil: 'domcontentloaded' }).catch(() => { throw new Error('The isolated remote Host could not load.') })
  await expect(page.locator('.dc-embedded-layout')).toBeVisible({ timeout: 30_000 })
  await dismissWelcome(page)
  await expect(page.getByText('Open this remote workspace from Connections on your computer.', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Workspaces', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Account menu', exact: true })).toHaveCount(0)
  await expect(page.getByText('Failed to load plugins', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
  await page.screenshot({ path: info.outputPath('embedded-direct-visit.png'), fullPage: true })
})

test('composed native sidebar keeps its styles when the shell preloads and unloads its own sidebar CSS', async ({ page }, info) => {
  test.skip(!fixturePath, 'Set DSH_UNIFIED_FIXTURE to an isolated two-Host native fixture')
  page.setDefaultTimeout(15_000)
  const nativeSource = await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-sidebar/client')), 'utf8')
  const originalStyleIds = [...new Set([...nativeSource.matchAll(/"(@deepseek-ai\/dsh-client-ui-sidebar\/[^"\n]+\.css)"/g)].map(match => match[1]))]
  expect(originalStyleIds.length).toBeGreaterThan(0)
  await page.addInitScript(ids => {
    // Desktop can preload another compiled copy of the sidebar under these
    // same CSS IDs. Its class names need not match our installed native copy.
    const install = () => {
      if (!document.head) return false
      for (const id of ids) {
        const tag = document.createElement('style')
        tag.dataset.plugin = '@deepseek-ai/dsh-client-ui-sidebar'
        tag.dataset.pluginCss = id
        tag.dataset.connectionsRegression = 'preloaded-sidebar'
        tag.textContent = '.preloaded-desktop-sidebar { display: flex; }'
        document.head.appendChild(tag)
      }
      return true
    }
    if (!install()) {
      const observer = new MutationObserver(() => { if (install()) observer.disconnect() })
      observer.observe(document, { childList: true, subtree: true })
    }
  }, originalStyleIds)
  await page.goto(await launch(join(fixturePath!, 'host.log')), { waitUntil: 'domcontentloaded' }).catch(() => { throw new Error('The isolated local Host could not load.') })
  await dismissWelcome(page)
  await expect(page.getByRole('region', { name: 'Workspaces', exact: true })).toHaveCount(1)
  const newSession = page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' })
  const panels = page.getByRole('navigation', { name: 'Global panels', exact: true })
  const more = panels.getByRole('button', { name: 'More', exact: true })
  const plugins = panels.getByRole('button', { name: 'Plugins', exact: true })
  const assertAppearance = async () => {
    await expect(newSession).toHaveCSS('display', 'flex')
    await expect(newSession).toHaveCSS('height', '38px')
    await expect(panels).toHaveCSS('flex-direction', 'column')
    await expect(more).toHaveCSS('border-top-style', 'none')
    await expect(more).toHaveCSS('min-height', '36px')
    const pluginBounds = await plugins.boundingBox(), moreBounds = await more.boundingBox()
    expect(pluginBounds).not.toBeNull()
    expect(moreBounds).not.toBeNull()
    expect(moreBounds!.y).toBeGreaterThanOrEqual(pluginBounds!.y + pluginBounds!.height)
  }
  await assertAppearance()
  await expect(page.locator('style[data-connections-regression="preloaded-sidebar"]')).toHaveCount(originalStyleIds.length)
  await page.evaluate(() => {
    for (const tag of document.querySelectorAll('style[data-plugin="@deepseek-ai/dsh-client-ui-sidebar"]')) tag.remove()
  })
  await assertAppearance()
  await more.click()
  await expect(page.getByRole('menuitem', { name: 'Browse other plugins', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(more).toBeFocused()
  await page.screenshot({ path: info.outputPath('native-sidebar-css-ownership.png'), fullPage: true })
})

test('one native sidebar switches local and SSH projects while remote content stays native', async ({ page }, info) => {
  test.skip(!fixturePath, 'Set DSH_UNIFIED_FIXTURE to an isolated two-Host native fixture')
  page.setDefaultTimeout(15_000)
  test.setTimeout(180_000)
  const metadata = JSON.parse(await readFile(join(fixturePath!, 'processes.json'), 'utf8')) as { alias: string; remote: { pid: number }; projects: { local: string; remote: string } }
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message.replace(/([?&]token=)[^&\s"']+/gi, '$1[redacted]')))
  await page.goto(await launch(join(fixturePath!, 'host.log')), { waitUntil: 'domcontentloaded' }).catch(() => { throw new Error('The isolated local Host could not load.') })
  await dismissWelcome(page)
  const workspaces = page.getByRole('region', { name: 'Workspaces', exact: true })
  await expect(workspaces).toHaveCount(1)
  const more = page.getByRole('navigation', { name: 'Global panels', exact: true }).getByRole('button', { name: 'More', exact: true })
  await more.click()
  await expect(page.getByRole('menuitem', { name: 'Browse other plugins', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Create your plugin', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(more).toBeFocused()
  const localProject = workspaces.getByRole('button', { name: 'local-project', exact: true })
  if (!await localProject.count()) {
    await workspaces.getByRole('button', { name: 'Add workspace', exact: true }).click()
    await page.getByRole('dialog', { name: 'Open a project', exact: true }).getByRole('button', { name: 'This computer', exact: true }).click()
    await chooseDirectory(page, metadata.projects.local)
  }
  await expect(localProject).toBeVisible()
  await localProject.click()
  await expect(workspaces.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Open|Close) right sidebar$/ })).toBeVisible()
  await prepareConnection(page, metadata.alias, await launch(join(fixturePath!, 'remote.log')))
  await verifyLoadingAcknowledgement(page, async () => {
    await workspaces.getByRole('button', { name: 'Add workspace', exact: true }).click()
    const chooser = page.getByRole('dialog', { name: 'Open a project', exact: true })
    await expect(chooser.getByRole('button', { name: 'This computer', exact: true })).toBeVisible()
    await chooser.getByRole('button').filter({ hasText: connectionName }).click()
  })
  await expect(page.locator('iframe[title="Remote workspace"]')).toBeVisible({ timeout: 30_000 })
  const remote = page.frameLocator('iframe[title="Remote workspace"]')
  await expect(remote.locator('.dc-embedded-layout')).toBeVisible({ timeout: 30_000 })
  await dismissWelcome(remote)
  await chooseDirectory(remote, metadata.projects.remote)
  const remoteProject = workspaces.getByRole('button', { name: `remote-project · ${connectionName}`, exact: true })
  await expect(remoteProject).toBeVisible({ timeout: 15_000 })
  await expect(localProject).toBeVisible()
  await expect(remote.getByRole('region', { name: 'Workspaces', exact: true })).toHaveCount(0)
  await expect(remote.getByRole('button', { name: 'Account menu', exact: true })).toHaveCount(0)
  await verifyRemoteUpload(page, remote)
  await verifyRemoteMedia(page, remote)
  await verifyNewSession(page, 'remote')
  await verifyFiles(remote, metadata.projects.remote, 'remote')
  await expect(workspaces.locator('.dcw-session button[aria-current="page"]')).toHaveCount(1)
  const selectedRemote = await workspaces.locator('.dcw-session button[aria-current="page"]').getAttribute('aria-label')
  await page.screenshot({ path: info.outputPath('unified-remote-native-files.png'), fullPage: true })

  await workspaces.getByRole('button', { name: 'Add workspace', exact: true }).click()
  await page.getByRole('dialog', { name: 'Open a project', exact: true }).getByRole('button').filter({ hasText: connectionName }).click()
  await remote.getByRole('dialog', { name: 'Select Workspace Directory', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(workspaces.locator('.dcw-session button[aria-current="page"]')).toHaveAttribute('aria-label', selectedRemote!)
  await expect(remote.getByText('native remote sidebar nested file', { exact: false })).toBeVisible()

  await localProject.click()
  await expect(workspaces.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('iframe[title="Remote workspace"]')).toHaveCount(0)
  await verifyFiles(page, metadata.projects.local, 'local')
  await verifyNewSession(page, 'local')
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add workspace…', exact: true }).click()
  const heroChooser = page.getByRole('dialog', { name: 'Open a project', exact: true })
  await expect(heroChooser.getByRole('button', { name: 'This computer', exact: true })).toBeVisible()
  await heroChooser.getByRole('button').filter({ hasText: connectionName }).click()
  await expect(remote.locator('.dc-embedded-layout')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.dc-remote-loading')).toHaveCount(0, { timeout: 15_000 })
  await chooseDirectory(remote, metadata.projects.remote)
  await expect(workspaces.locator('.dcw-session button[aria-current="page"]')).toHaveCount(1)
  await verifyParentShortcutGuard(page)
  // Reload only after both the remote acknowledgement and local persistence settle.
  await expect.poll(async () => {
    const view = await remoteView(remote)
    return view !== undefined && view.reportedRevision === view.revision && view.presentedRevision === view.revision
  }).toBe(true)
  const sessionId = await selectedRemoteSession(remote)
  expect(sessionId).toBeTruthy()
  await expect.poll(() => page.evaluate(() => {
    const saved = localStorage.getItem('@xunz/dsh-connections/selection')
    return saved ? (JSON.parse(saved) as { sessionId?: string }).sessionId : undefined
  })).toBe(sessionId)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(remote.locator('.dc-embedded-layout')).toBeVisible({ timeout: 30_000 })
  await dismissWelcome(page)
  await dismissWelcome(remote)
  await expect.poll(() => selectedRemoteSession(remote), { timeout: 15_000 }).toBe(sessionId)
  await expect(workspaces).toHaveCount(1)
  await expect(localProject).toBeVisible()
  const remoteBefore = (await readFile(`/proc/${metadata.remote.pid}/stat`, 'utf8')).split(') ')[1]!.split(' ')[19]
  await promisify(execFile)(process.execPath, ['test/integration/native-fixture.mjs', 'restart', fixturePath!])
  await page.goto(await launch(join(fixturePath!, 'host.log')), { waitUntil: 'domcontentloaded' }).catch(() => { throw new Error('The restarted isolated local Host could not load.') })
  await dismissWelcome(page)
  await expect(remote.locator('.dc-embedded-layout')).toBeVisible({ timeout: 30_000 })
  await dismissWelcome(remote)
  await expect.poll(() => selectedRemoteSession(remote), { timeout: 15_000 }).toBe(sessionId)
  expect((await readFile(`/proc/${metadata.remote.pid}/stat`, 'utf8')).split(') ')[1]!.split(' ')[19]).toBe(remoteBefore)
  await verifyFiles(remote, metadata.projects.remote, 'remote')
  await expect(workspaces).toHaveCount(1)
  await expect(localProject).toBeVisible()
  await expect(page.getByText('Failed to load plugins', { exact: true })).toHaveCount(0)
  await expect(remote.getByText('Failed to load plugins', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
  await page.screenshot({ path: info.outputPath('unified-after-local-restart.png'), fullPage: true })
})

test('native settings switch Hosts and keep model, plugin and preference ownership on the selected Host', async ({ page }, info) => {
  test.skip(!fixturePath, 'Set DSH_UNIFIED_FIXTURE to an isolated two-Host native fixture')
  test.setTimeout(120_000)
  page.setDefaultTimeout(15_000)
  const metadata = JSON.parse(await readFile(join(fixturePath!, 'processes.json'), 'utf8')) as { alias: string; projects: { local: string } }
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message.replace(/([?&]token=)[^&\s"']+/gi, '$1[redacted]')))
  await page.goto(await launch(join(fixturePath!, 'host.log')), { waitUntil: 'domcontentloaded' }).catch(() => { throw new Error('The isolated local Host could not load.') })
  await dismissWelcome(page)
  const workspaces = page.getByRole('region', { name: 'Workspaces', exact: true })
  const localProject = workspaces.getByRole('button', { name: 'local-project', exact: true })
  if (!await localProject.count()) {
    await workspaces.getByRole('button', { name: 'Add workspace', exact: true }).click()
    await page.getByRole('dialog', { name: 'Open a project', exact: true }).getByRole('button', { name: 'This computer', exact: true }).click()
    await chooseDirectory(page, metadata.projects.local)
  }
  await localProject.click()
  await expect(page.getByRole('button', { name: /^(Open|Close) right sidebar$/ })).toBeVisible()
  const remoteLaunch = await launch(join(fixturePath!, 'remote.log'))
  await prepareConnection(page, metadata.alias, remoteLaunch)
  const selection = () => page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId)
  await expect.poll(selection).toBeTruthy()
  const beforeSelection = await selection()
  const selectedLocal = workspaces.locator('.dcw-session button[aria-current="page"]')
  await expect(selectedLocal).toHaveCount(1)
  const selectedLabel = await selectedLocal.getAttribute('aria-label')
  const beforeCatalog = await catalog(page)
  expect(beforeCatalog.sessions.find(session => session.id === beforeSelection)?.cwd).toBe(metadata.projects.local)
  const beforeSessions = beforeCatalog.sessions.map(session => session.id).sort()
  const beforeWorkspaces = beforeCatalog.workspaces.map(workspace => workspace.id).sort()
  const beforeRemote = await catalogBeforeUi(remoteLaunch)
  // A fresh native profile may report that this test account has no configured
  // XDG Documents directory. Let its own transient toast finish before Settings.
  await expect(page.getByText('Unable to create default workspace. Use Choose workspace to select a folder.', { exact: true })).toHaveCount(0, { timeout: 15_000 })
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  const localSettings = page.locator('[data-shortcut-modal="settings"]').filter({ has: page.locator('[data-slot="settings.header"]') })
  await localSettings.getByRole('button', { name: 'General', exact: true }).click()
  const localToggle = localSettings.getByRole('switch', { name: 'Show coding view', exact: true })
  await expect(localToggle).toBeEnabled()
  const localValue = await localToggle.getAttribute('aria-checked')
  const localHost = localSettings.getByRole('button', { name: 'Host: This computer', exact: true })
  await localHost.click()
  const localMenu = page.getByRole('menu')
  await expect(localMenu.getByText('Host', { exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('native-settings-local-host-menu.png'), fullPage: true })
  let release!: () => void, entered = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const pauseFrame = async (route: Route) => {
    const request = route.request()
    if (request.isNavigationRequest() && request.frame().parentFrame() !== null) { entered = true; await gate }
    await route.continue().catch(() => {})
  }
  await page.context().route('**/*', pauseFrame)
  try {
    await localMenu.getByRole('menuitem', { name: new RegExp(connectionName) }).click()
    await expect.poll(() => entered).toBe(true)
    const loading = page.locator('.dcs-settings-status')
    await expect(loading).toBeVisible()
    await page.keyboard.press('Tab')
    expect(await loading.evaluate(panel => panel.contains(document.activeElement))).toBe(true)
    await loading.getByRole('button', { name: 'Return to this computer', exact: true }).click()
    await expect(page.locator('.dcs-remote-settings')).toHaveCount(0)
    await expect(localSettings).toBeVisible()
  } finally { release(); await page.context().unroute('**/*', pauseFrame) }
  await localHost.click()
  await localMenu.getByRole('menuitem', { name: new RegExp(connectionName) }).click()
  const settings = page.locator('.dcs-remote-settings')
  const remote = page.frameLocator('iframe[title="Remote settings"]')
  await expect(settings).toBeVisible()
  await expect(remote.locator('.dc-embedded-layout')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.dcs-settings-status')).toHaveCount(0, { timeout: 30_000 })
  await expect(settings.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.dcs-panel')).toHaveCount(0)
  await expect(settings.locator('iframe')).toBeVisible()
  await expect(remote.locator('.dc-embedded-main, .dc-embedded-right, [data-shell-bottom]')).toHaveCount(0)
  expect(await remote.locator('body').evaluate(body => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(body).backgroundColor])).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
  // A fresh remote Host may run its native first-use flow. It remains inside
  // the visible remote document, and dismissal exposes the settings launcher.
  await dismissWelcome(remote)
  const nativeSettings = remote.locator('[data-shortcut-modal="settings"]').filter({ has: remote.locator('[data-slot="settings.header"]') })
  if (!await nativeSettings.isVisible()) await remote.getByRole('button', { name: 'Open settings', exact: true }).click()
  await expect(nativeSettings).toBeVisible()
  const remoteCatalog = await catalog(remote)
  expect(remoteCatalog.workspaces.map(workspace => workspace.id).sort()).toEqual(beforeRemote.workspaces.map(workspace => workspace.id).sort())
  expect(remoteCatalog.sessions.map(session => session.id).sort()).toEqual(beforeRemote.sessions.map(session => session.id).sort())
  await nativeSettings.getByRole('button', { name: 'Models', exact: true }).click()
  await expect(nativeSettings.getByRole('button', { name: 'Models', exact: true })).toHaveAttribute('aria-current', 'true')
  await page.screenshot({ path: info.outputPath('native-remote-models.png'), fullPage: true })
  await nativeSettings.getByRole('button', { name: 'Built-in plugins', exact: true }).click()
  await expect(nativeSettings.getByRole('searchbox', { name: 'Search plugins', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(nativeSettings.getByText('Global plugins', { exact: true })).toBeVisible()
  await nativeSettings.getByRole('button', { name: 'General', exact: true }).click()
  const remoteToggle = nativeSettings.getByRole('switch', { name: 'Show coding view', exact: true })
  await expect(remoteToggle).toBeEnabled()
  const remoteValue = await remoteToggle.getAttribute('aria-checked')
  const remoteOrigin = new URL((await settings.locator('iframe').getAttribute('src'))!).origin
  const writes: string[] = []
  const observe = (request: Request) => { const url = new URL(request.url()); if (url.pathname === '/api/settings/mutate') writes.push(url.origin) }
  page.context().on('request', observe)
  try {
    await remoteToggle.click()
    await expect(remoteToggle).toHaveAttribute('aria-checked', remoteValue === 'true' ? 'false' : 'true')
    await expect(remoteToggle).toBeEnabled()
    await expect.poll(() => writes.length).toBe(1)
    expect(writes).toEqual([remoteOrigin])
    await nativeSettings.getByRole('button', { name: `Host: ${connectionName}`, exact: true }).click()
    await page.screenshot({ path: info.outputPath('native-settings-remote-host-menu.png'), fullPage: true })
    await remote.getByRole('menu').getByRole('menuitem', { name: 'This computer', exact: true }).click()
    await expect(settings).toHaveCount(0)
    await expect(localSettings).toBeVisible()
    await expect(localToggle).toHaveAttribute('aria-checked', localValue!)
    expect(await selection()).toBe(beforeSelection)
    await expect(selectedLocal).toHaveAttribute('aria-label', selectedLabel!)
    expect((await catalog(page)).sessions.map(session => session.id).sort()).toEqual(beforeSessions)
    expect((await catalog(page)).workspaces.map(workspace => workspace.id).sort()).toEqual(beforeWorkspaces)
    await localHost.click()
    await localMenu.getByRole('menuitem', { name: new RegExp(connectionName) }).click()
    await expect(remote.locator('.dc-embedded-layout')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.dcs-settings-status')).toHaveCount(0, { timeout: 30_000 })
    await expect(settings.getByRole('alert')).toHaveCount(0)
    await dismissWelcome(remote)
    if (!await nativeSettings.isVisible()) await remote.getByRole('button', { name: 'Open settings', exact: true }).click()
    await nativeSettings.getByRole('button', { name: 'General', exact: true }).click()
    await expect(remoteToggle).toHaveAttribute('aria-checked', remoteValue === 'true' ? 'false' : 'true')
    await remoteToggle.click()
    await expect(remoteToggle).toHaveAttribute('aria-checked', remoteValue!)
    await expect.poll(() => writes.length).toBe(2)
    expect(writes).toEqual([remoteOrigin, remoteOrigin])
    await page.screenshot({ path: info.outputPath('native-remote-settings.png'), fullPage: true })
    const currentFrame = await settings.locator('iframe').elementHandle()
    const frameUrl = await settings.locator('iframe').getAttribute('src')
    const remoteHost = nativeSettings.getByRole('button', { name: `Host: ${connectionName}`, exact: true })
    await remoteHost.click()
    await remote.getByRole('menu').getByRole('menuitem', { name: new RegExp(connectionName) }).click()
    await expect(remote.getByRole('menu')).toHaveCount(0)
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.setViewportSize({ width: 640, height: 900 })
    await expect(remote.locator('body')).toHaveAttribute('data-ds-dark-theme', '')
    await remoteHost.click()
    const menu = remote.getByRole('menu')
    await expect(menu).toBeVisible()
    const bounds = await menu.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(640)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900)
    await page.screenshot({ path: info.outputPath('native-settings-dark-narrow-menu.png'), fullPage: true })
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(nativeSettings).toBeVisible()
    await expect(settings.locator('iframe')).toHaveAttribute('src', frameUrl!)
    expect(await settings.locator('iframe').evaluate((frame, previous) => frame === previous, currentFrame)).toBe(true)
    await currentFrame?.dispose()
    await page.emulateMedia({ colorScheme: 'light' })
    await page.setViewportSize({ width: 1360, height: 940 })
    await nativeSettings.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(settings).toHaveCount(0, { timeout: 10_000 })
    expect(await selection()).toBe(beforeSelection)
    await expect(selectedLocal).toHaveAttribute('aria-label', selectedLabel!)
    const afterRemote = await catalogBeforeUi(remoteLaunch)
    expect(afterRemote.workspaces.map(workspace => workspace.id).sort()).toEqual(beforeRemote.workspaces.map(workspace => workspace.id).sort())
    expect(afterRemote.sessions.map(session => session.id).sort()).toEqual(beforeRemote.sessions.map(session => session.id).sort())
    expect(errors).toEqual([])
  } finally { page.context().off('request', observe) }
})
