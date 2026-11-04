import { WORKSPACE_PROTOCOL } from '../../src/shared/workspace-protocol.js'
import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, request as apiRequest, test, type FrameLocator, type Page, type Request, type Route } from '@playwright/test'
import type { WorkspaceCatalog, WorkspaceViewState } from '../../src/shared/workspace-protocol.js'
import { en as connectionMessages } from '../../src/client/messages.js'

type Surface = Page | FrameLocator
const fixturePath = process.env.DSH_UNIFIED_FIXTURE
const connectionName = 'Unified native SSH'

async function expectContentOnlyShell(surface: Surface): Promise<void> {
  await expect(surface.locator('[data-shell-leading]')).toHaveCount(0)
  await expect(surface.getByRole('button', { name: 'Open sidebar', exact: true })).toHaveCount(0)
  await expect(surface.getByRole('button', { name: 'New session', exact: true })).toHaveCount(0)
}

async function launch(path: string): Promise<string> {
  const value = (await readFile(path, 'utf8')).match(/dsh web: (http[^\s]+)/)?.[1]
  if (!value) throw new Error('The isolated Host has no startup URL.')
  return value
}
async function dismissWelcome(surface: Surface): Promise<void> {
  const preview = surface.getByRole('button', { name: /^(Continue|继续)$/ })
  if (await preview.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await preview.click()
  const welcome = surface.getByRole('dialog', { name: /^(Get started|开始使用)$/ })
  if (await welcome.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await welcome.getByRole('button', { name: /^(Close|关闭)$/ }).click()
  const apiSetup = surface.getByRole('dialog', { name: /^(Add an API key to get started|添加一个 API Key 开始使用)$/ })
  if (await apiSetup.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await apiSetup.getByRole('button', { name: /^(Configure later|稍后配置)$/ }).click()
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
    const add = panel.getByRole('button', { name: connectionMessages.add, exact: true })
    await add.click()
    await expect(panel.getByRole('button', { name: 'Refresh SSH hosts', exact: true })).toBeEnabled()
    // The owned browser-modal layer must take exactly one Escape above the
    // independently deployed native Settings dialog, then restore its trigger.
    await page.keyboard.press('Escape')
    await expect(add).toBeFocused()
    await expect(panel).toBeVisible()
    await add.click()
    await expect(panel.getByRole('button', { name: 'Refresh SSH hosts', exact: true })).toBeEnabled()
    const manual = panel.getByRole('button', { name: 'Add manually', exact: true })
    if (await manual.isVisible()) await manual.click()
    await panel.getByLabel('Name', { exact: true }).fill(connectionName)
    await panel.getByLabel('SSH host', { exact: false }).fill(alias)
    await panel.getByRole('combobox', { name: /Remote Harness/ }).selectOption('existing')
    await panel.getByLabel('Remote Harness URL', { exact: false }).fill(remoteUrl)
    await panel.getByRole('button', { name: 'Add and connect', exact: true }).click()
    await expect(panel.getByText(connectionName, { exact: true })).toBeVisible()
  } else {
    // The owned remote Host may have restarted between acceptance runs.
    await panel.getByLabel(`More actions: ${connectionName}`).click()
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
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
  // setInputFiles can dispatch into a disabled native input. Wait for the
  // actual native composer capability, not merely the hidden input's presence.
  await expect(remote.getByRole('button', { name: 'Add files or run commands', exact: true })).toBeEnabled()
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
/** Read accepted presentation values from the Host, independently of the embedded UI facade. */
interface PresentationSetting { ns: string; value: unknown; user: unknown }
async function presentationBeforeUi(startup: string): Promise<PresentationSetting[]> {
  const request = await apiRequest.newContext()
  try {
    const authenticated = await request.get(startup).catch(() => { throw new Error('The isolated Host authentication failed.') })
    if (!authenticated.ok()) throw new Error('The isolated Host authentication failed.')
    const response = await request.post(new URL('/api/settings/describe', startup).href, { data: {
      type: 'client-request', rpcId: 'connections-presentation-qa', method: 'settings/describe', payload: { args: {} },
    } })
    const result = (await response.json()).result as { ok: boolean; value?: { namespaces: PresentationSetting[] } }
    if (!result.ok || !result.value) throw new Error('The isolated Host settings were unavailable.')
    return result.value.namespaces.filter(row => ['locale', 'ui-theme', 'ui-chat', 'ui-conversation', 'ui-settings'].includes(row.ns))
      .map(({ ns, value, user }) => ({ ns, value, user }))
  } finally { await request.dispose() }
}
/** Restore only the isolated local preferences this test changes, including after an assertion fails. */
async function restorePresentation(startup: string, previous: PresentationSetting[]): Promise<void> {
  const current = await presentationBeforeUi(startup)
  const changed = previous.filter(row => ['locale', 'ui-theme', 'ui-settings'].includes(row.ns)
    && JSON.stringify(current.find(value => value.ns === row.ns)?.user) !== JSON.stringify(row.user))
  if (!changed.length) return
  const request = await apiRequest.newContext()
  try {
    const authenticated = await request.get(startup).catch(() => { throw new Error('The isolated Host authentication failed.') })
    if (!authenticated.ok()) throw new Error('The isolated Host authentication failed.')
    for (const { ns, user } of changed) {
      const response = await request.post(new URL('/api/settings/replace', startup).href, { data: {
        type: 'client-request', rpcId: `connections-restore-${ns}`, method: 'settings/replace', payload: { args: { ns, section: user } },
      } })
      if (!(await response.json()).result?.ok) throw new Error(`Could not restore the isolated ${ns} preference`)
    }
  } finally { await request.dispose() }
}
/** Linux Web deliberately has no default New Session binding. Exercise an
 * accepted native user binding instead of assuming Ctrl+N was intercepted. */
async function bindNewSession(page: Page): Promise<() => Promise<void>> {
  const open = async () => {
    await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).focus()
    await page.keyboard.press('Control+Slash')
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Edit shortcut for New Session', exact: true }).click()
    return dialog
  }
  const dialog = await open()
  await dialog.getByRole('button', { name: 'Press a shortcut', exact: true }).focus()
  await page.keyboard.press('Control+Shift+Comma')
  await expect(dialog.getByRole('button', { name: 'Edit shortcut for New Session', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const config = JSON.parse(localStorage.getItem('dsh.keybindings.v1') ?? '{}') as {
      profiles?: Record<string, Record<string, { code: string }>>
    }
    return config.profiles?.['web:linux']?.['session.new']?.code
  })).toBe('Comma')
  await dialog.getByRole('button', { name: 'Close keyboard shortcuts', exact: true }).click()
  return async () => {
    const dialog = await open()
    await dialog.getByRole('button', { name: 'Restore default', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Edit shortcut for New Session', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Close keyboard shortcuts', exact: true }).click()
  }
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
  const draft = `Unsent ${source} rc.5 draft`
  await editor.fill(draft)
  const origins: string[] = []
  const observe = (request: Request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/session/create') origins.push(url.origin)
  }
  const restoreBinding = source === 'remote' ? await bindNewSession(page) : undefined
  page.context().on('request', observe)
  try {
    const created = page.context().waitForEvent('response', {
      predicate: response => new URL(response.url()).pathname === '/api/session/create', timeout: 15_000,
    })
    const nativeNew = page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' })
    if (source === 'remote') {
      // The retained native brand is deliberately local. Source-aware New
      // Session remains available through Connections' guarded shortcut/list.
      await nativeNew.focus()
      await page.keyboard.press('Control+Shift+Comma')
    } else await nativeNew.click()
    const response = await created
    expect(new URL(response.url()).origin).toBe(expectedOrigin)
    expect(response.ok()).toBe(true)
    // rc.5 returns to the workspace's reusable blank, including its unsent draft.
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
  } finally {
    page.context().off('request', observe)
    try { await editor.fill('') } finally { await restoreBinding?.() }
  }
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
      await expect(notice).toContainText('Use the selected remote chat’s menus and pane controls for this action.')
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
  await expectContentOnlyShell(page)
  await expect(page.getByText('Failed to load plugins', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
  await page.screenshot({ path: info.outputPath('embedded-direct-visit.png'), fullPage: true })
})

test('independently deployed native sidebar owns its styles without a copied Connections factory', async ({ page }, info) => {
  test.skip(!fixturePath, 'Set DSH_UNIFIED_FIXTURE to an isolated two-Host native fixture')
  page.setDefaultTimeout(15_000)
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
  expect(await page.locator('style[data-plugin="@deepseek-ai/dsh-client-ui-sidebar"]').count()).toBeGreaterThan(0)
  await expect(page.locator('style[data-plugin-css^="@xunz03/dsh-connections/native-sidebar/"]')).toHaveCount(0)
  await more.click()
  await expect(page.getByRole('menuitem', { name: 'Browse other plugins', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(more).toBeFocused()
  await page.screenshot({ path: info.outputPath('native-sidebar-css-ownership.png'), fullPage: true })
})

test('hot enable and disable preserve the native root, sidebar and unsent session draft', async ({ page }, info) => {
  test.skip(!fixturePath, 'Set DSH_UNIFIED_FIXTURE to an isolated two-Host native fixture')
  test.setTimeout(120_000)
  page.setDefaultTimeout(15_000)
  const startup = await launch(join(fixturePath!, 'host.log'))
  const metadata = JSON.parse(await readFile(join(fixturePath!, 'processes.json'), 'utf8')) as { projects: { local: string } }
  const owner = await apiRequest.newContext()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message.replace(/([?&]token=)[^&\s"']+/gi, '$1[redacted]')))
  const setEnabled = async (enabled: boolean) => {
    // Use a separate authenticated request context so cleanup works even if a
    // regression blanks the renderer. This is the native bundle lifecycle API.
    const response = await owner.post(new URL('/api/pluginManager/setBundleEnabled', startup).href, { data: {
      type: 'client-request', rpcId: `connections-hot-enable-${enabled}-${Date.now()}`,
      method: 'pluginManager/setBundleEnabled', payload: { args: { name: '@xunz03/dsh-connections', enabled } },
    } })
    expect(response.ok()).toBe(true)
    const result = (await response.json()).result as { ok: boolean; value?: { application: string } }
    expect(result.ok).toBe(true)
    expect(result.value?.application).toBe('applied')
  }
  try {
    expect((await owner.get(startup)).ok()).toBe(true)
    await page.goto(startup, { waitUntil: 'domcontentloaded' }).catch(() => { throw new Error('The isolated local Host could not load.') })
    await dismissWelcome(page)
    const workspaces = page.getByRole('region', { name: 'Workspaces', exact: true })
    const project = workspaces.getByRole('button', { name: 'local-project', exact: true })
    if (!await project.count()) {
      await workspaces.getByRole('button', { name: 'Add workspace', exact: true }).click()
      await page.getByRole('dialog', { name: 'Open a project', exact: true }).getByRole('button', { name: 'This computer', exact: true }).click()
      await chooseDirectory(page, metadata.projects.local)
    }
    await project.click()
    const editor = page.locator('[data-composer-input][contenteditable="true"]')
    await expect(editor).toBeVisible()
    const selection = () => page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId)
    await expect.poll(selection).toBeTruthy()
    const selected = await selection()
    const previousDraft = await editor.innerText()
    const draft = 'Unsent draft across native Connections enable and disable'
    await editor.fill(draft)
    // Retain the actual native composer node, not just its replacement's text:
    // taking down layout/root must not silently recreate a matching-looking UI.
    const monitor = await editor.evaluateHandle(element => {
      const state = { detached: false, observer: new MutationObserver(records => {
        if (!element.isConnected || records.some(record => [...record.removedNodes].some(node => node === element || node.contains(element)))) state.detached = true
      }) }
      state.observer.observe(document.body, { childList: true, subtree: true })
      return state
    })
    const panels = page.getByRole('navigation', { name: 'Global panels', exact: true })
    const newSession = page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' })
    const copiedCss = page.locator('style[data-plugin-css^="@xunz03/dsh-connections/native-sidebar/"]')
    const nativeStyles = await page.locator('style[data-plugin="@deepseek-ai/dsh-client-ui-sidebar"]').elementHandles()
    expect(nativeStyles.length).toBeGreaterThan(0)
    const assertShell = async () => {
      // Native shell/provider ownership remains independent of the contribution.
      await dismissWelcome(page)
      await expect(panels).toHaveCount(1)
      await expect(copiedCss).toHaveCount(0)
      for (const style of nativeStyles) expect(await style.evaluate(tag => tag.isConnected)).toBe(true)
      await expect(newSession).toHaveCount(1)
      await expect(newSession).toHaveCSS('display', 'flex')
      await expect(newSession).toHaveCSS('height', '38px')
      await expect(panels).toHaveCSS('flex-direction', 'column')
      await expect(editor).toHaveText(draft)
      expect(await selection()).toBe(selected)
      expect(await monitor.evaluate(state => state.detached)).toBe(false)
      expect(errors).toEqual([])
      const more = panels.getByRole('button', { name: 'More', exact: true })
      await more.click()
      await expect(page.getByRole('menuitem', { name: 'Browse other plugins', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(more).toBeFocused()
    }
    try {
      // Both entry states share this same independently deployed native shell.
      await setEnabled(false)
      await expect(copiedCss).toHaveCount(0)
      await assertShell()
      for (let cycle = 0; cycle < 2; cycle++) {
        await setEnabled(true)
        await expect(page.getByRole('region', { name: 'Workspaces', exact: true })).toHaveCount(1)
        await expect(copiedCss).toHaveCount(0)
        await assertShell()
        await page.getByRole('button', { name: 'Account menu', exact: true }).click()
        await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
        await page.getByRole('button', { name: 'Connections', exact: true }).click()
        const panel = page.getByRole('region', { name: 'Connections', exact: true })
        const add = panel.getByRole('button', { name: connectionMessages.add, exact: true })
        await expect(add).toBeEnabled()
        await add.click()
        const dialog = page.getByRole('dialog', { name: connectionMessages.addSsh, exact: true })
        await expect(dialog).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        await expect(add).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(panel).toBeHidden()
        await assertShell()
        if (cycle === 0) {
          await setEnabled(false)
          await expect(copiedCss).toHaveCount(0)
          await assertShell()
        }
      }
      await page.screenshot({ path: info.outputPath('native-hot-enable-preserves-draft.png'), fullPage: true })
    } finally {
      await monitor.evaluate(state => state.observer.disconnect()).catch(() => {})
      await monitor.dispose()
      if (await editor.count()) await editor.fill(previousDraft).catch(() => {})
    }
  } finally {
    try { await setEnabled(true) } finally { await owner.dispose() }
  }
})

test('one native sidebar switches local and SSH projects while remote content stays native', async ({ page }, info) => {
  test.skip(!fixturePath, 'Set DSH_UNIFIED_FIXTURE to an isolated two-Host native fixture')
  page.setDefaultTimeout(15_000)
  test.setTimeout(180_000)
  const storageTrace: unknown[] = []
  await page.exposeFunction('__connectionsQaStorage', (entry: unknown) => { if (storageTrace.length < 200) storageTrace.push(entry) })
  await page.addInitScript(() => {
    const record = (operation: string, key: string, value?: string) => {
      if (key !== '@xunz/dsh-connections/selection') return
      const callback = (window as unknown as { __connectionsQaStorage?: (entry: unknown) => Promise<void> }).__connectionsQaStorage
      void callback?.({ operation, origin: location.origin, value, stack: new Error().stack?.replace(/([?&]token=)[^&\s"')]+/gi, '$1[redacted]') }).catch(() => {})
    }
    const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem
    Storage.prototype.setItem = function(key, value) { record('set', key, value); return set.call(this, key, value) }
    Storage.prototype.removeItem = function(key) { record('remove', key); return remove.call(this, key) }
  })
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
  await expectContentOnlyShell(remote)
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

  const localCreate = page.context().waitForEvent('response', { predicate: response => new URL(response.url()).pathname === '/api/session/create' })
  await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click()
  expect(new URL((await localCreate).url()).origin).toBe(new URL(page.url()).origin)
  await expect(page.locator('iframe[title="Remote workspace"]')).toHaveCount(0)
  await localProject.click()
  await expect(workspaces.getByRole('alert')).toHaveCount(0)
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
  try { await expect(remote.locator('.dc-embedded-layout')).toBeVisible({ timeout: 30_000 }) }
  catch (error) {
    const tracePath = info.outputPath('selection-storage-trace.json')
    await writeFile(tracePath, JSON.stringify(storageTrace, null, 2))
    await info.attach('selection-storage-trace.json', { path: tracePath, contentType: 'application/json' })
    throw error
  }
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

test('native settings keep models and plugins remote while General and presentation belong to this computer', async ({ page }, info) => {
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
  const beforeRemotePresentation = await presentationBeforeUi(remoteLaunch)
  const localLaunch = await launch(join(fixturePath!, 'host.log'))
  const beforeLocalPresentation = await presentationBeforeUi(localLaunch)
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
  const remote = page.frameLocator('.dcs-remote-settings iframe')
  await expect(settings).toBeVisible()
  await expect(remote.locator('.dc-embedded-layout')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.dcs-settings-status')).toHaveCount(0, { timeout: 30_000 })
  await expect(settings.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.dcs-panel')).toHaveCount(0)
  await expect(settings.locator('iframe')).toBeVisible()
  await expect(remote.locator('.dc-embedded-main, .dc-embedded-right, [data-shell-bottom]')).toHaveCount(0)
  await expectContentOnlyShell(remote)
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
  await expect(nativeSettings.getByRole('button', { name: 'Models', exact: true })).toHaveAttribute('aria-current', 'true')
  await page.screenshot({ path: info.outputPath('native-remote-models.png'), fullPage: true })
  await nativeSettings.getByRole('button', { name: 'Built-in plugins', exact: true }).click()
  await expect(nativeSettings.getByRole('searchbox', { name: 'Search plugins', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(nativeSettings.getByText('Global plugins', { exact: true })).toBeVisible()
  const localOrigin = new URL(page.url()).origin
  const writes: string[] = []
  const observe = (request: Request) => { const url = new URL(request.url()); if (url.pathname === '/api/settings/mutate') writes.push(url.origin) }
  page.context().on('request', observe)
  try {
    // General is the existing local page. Merely selecting it from remote
    // Settings must not expose a remote form or write to that Host.
    await nativeSettings.getByRole('button', { name: 'General', exact: true }).click()
    await expect(settings).toHaveCount(0)
    await expect(localSettings).toBeVisible()
    await expect(localSettings.getByRole('button', { name: 'General', exact: true })).toHaveAttribute('aria-current', 'true')
    await expect(localToggle).toHaveAttribute('aria-checked', localValue!)
    expect(writes).toEqual([])
    expect(await selection()).toBe(beforeSelection)
    await expect(selectedLocal).toHaveAttribute('aria-label', selectedLabel!)

    await localToggle.click()
    await expect(localToggle).toHaveAttribute('aria-checked', localValue === 'true' ? 'false' : 'true')
    await expect(localToggle).toBeEnabled()
    await localSettings.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect(localSettings.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await localSettings.getByRole('button', { name: 'English', exact: true }).click()
    await page.getByRole('menuitem', { name: '中文', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', /^zh/)
    await expect.poll(() => writes.length).toBe(3)
    expect(writes).toEqual([localOrigin, localOrigin, localOrigin])

    await localSettings.getByRole('button', { name: '主机: 本地电脑', exact: true }).click()
    await localMenu.getByRole('menuitem', { name: new RegExp(connectionName) }).click()
    await expect(remote.locator('.dc-embedded-layout')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.dcs-settings-status')).toHaveCount(0, { timeout: 30_000 })
    await expect(settings.getByRole('alert')).toHaveCount(0)
    await expect(nativeSettings.getByRole('button', { name: '模型', exact: true })).toHaveAttribute('aria-current', 'true')
    await dismissWelcome(remote)
    await expect(remote.locator('html')).toHaveAttribute('lang', /^zh/)
    await expect(remote.locator('body')).toHaveAttribute('data-ds-dark-theme', '')
    expect(await presentationBeforeUi(remoteLaunch)).toEqual(beforeRemotePresentation)
    expect(writes).toEqual([localOrigin, localOrigin, localOrigin])
    await page.screenshot({ path: info.outputPath('native-remote-local-presentation.png'), fullPage: true })

    // Native Host selection and Escape retain the existing frame and form.
    const currentFrame = await settings.locator('iframe').elementHandle()
    const frameUrl = await settings.locator('iframe').getAttribute('src')
    const remoteHost = nativeSettings.getByRole('button', { name: `主机: ${connectionName}`, exact: true })
    await remoteHost.click()
    await remote.getByRole('menu').getByRole('menuitem', { name: new RegExp(connectionName) }).click()
    await expect(remote.getByRole('menu')).toHaveCount(0)
    await page.setViewportSize({ width: 640, height: 900 })
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
    await page.setViewportSize({ width: 1360, height: 940 })

    await nativeSettings.getByRole('button', { name: '通用设置', exact: true }).click()
    await expect(settings).toHaveCount(0)
    await expect(localSettings).toBeVisible()
    await localSettings.getByRole('button', { name: '中文', exact: true }).click()
    await page.getByRole('menuitem', { name: 'English', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', /^en/)
    await localSettings.getByRole('button', { name: 'System', exact: true }).click()
    await expect(localSettings.getByRole('button', { name: 'System', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await localToggle.click()
    await expect(localToggle).toHaveAttribute('aria-checked', localValue!)
    await expect(localToggle).toBeEnabled()
    await expect.poll(() => writes.length).toBe(6)
    expect(writes.every(origin => origin === localOrigin)).toBe(true)
    await localSettings.getByRole('button', { name: 'Close', exact: true }).click()
    expect(await selection()).toBe(beforeSelection)
    await expect(selectedLocal).toHaveAttribute('aria-label', selectedLabel!)
    expect((await catalog(page)).sessions.map(session => session.id).sort()).toEqual(beforeSessions)
    expect((await catalog(page)).workspaces.map(workspace => workspace.id).sort()).toEqual(beforeWorkspaces)

    await page.getByRole('button', { name: 'Account menu', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await localSettings.getByRole('button', { name: 'Connections', exact: true }).click()
    const connections = localSettings.getByRole('region', { name: 'Connections', exact: true })
    await connections.getByLabel(`More actions: ${connectionName}`).click()
    const inventory = page.context().waitForEvent('response', {
      predicate: response => new URL(response.url()).pathname === '/api/pluginManager/listBundles'
        && new URL(response.url()).origin !== localOrigin,
    })
    void inventory.catch(() => {})
    await page.getByRole('menuitem', { name: 'Manage plugins', exact: true }).click()
    const pluginFrame = page.locator('iframe[title="Remote workspace"]')
    const plugins = page.frameLocator('iframe[title="Remote workspace"]')
    await expect(plugins.locator('.dc-embedded-layout')).toBeVisible({ timeout: 30_000 })
    await dismissWelcome(plugins)
    await expect(plugins.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible()
    await expect(plugins.getByRole('heading', { name: 'Installed plugins', exact: true })).toBeVisible()
    await expect(plugins.getByRole('button', { name: /^View .*connections/i })).toBeVisible()
    const listed = await inventory
    expect(listed.ok()).toBe(true)
    expect(new URL(listed.url()).origin).toBe(new URL((await pluginFrame.getAttribute('src'))!).origin)
    await page.screenshot({ path: info.outputPath('native-remote-plugin-manager.png'), fullPage: true })
    await localProject.click()
    await expect(pluginFrame).toHaveCount(0)
    expect(await selection()).toBe(beforeSelection)
    await expect(selectedLocal).toHaveAttribute('aria-label', selectedLabel!)

    const afterRemote = await catalogBeforeUi(remoteLaunch)
    expect(afterRemote.workspaces.map(workspace => workspace.id).sort()).toEqual(beforeRemote.workspaces.map(workspace => workspace.id).sort())
    expect(afterRemote.sessions.map(session => session.id).sort()).toEqual(beforeRemote.sessions.map(session => session.id).sort())
    expect(await presentationBeforeUi(remoteLaunch)).toEqual(beforeRemotePresentation)
    expect(errors).toEqual([])
  } finally {
    page.context().off('request', observe)
    await restorePresentation(localLaunch, beforeLocalPresentation)
  }
})
