import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type FrameLocator, type Page, type Request } from '@playwright/test'

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
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
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
async function selectedRemoteSession(remote: FrameLocator): Promise<string | undefined> {
  return remote.locator('body').evaluate(async () => {
    const channel = new URLSearchParams(window.location.hash.slice(1)).get('connections-view')
    const response = await fetch(new URL('/api/connections/workspaces', document.baseURI), {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'viewState', channel }),
    })
    const value = await response.json() as { ok: boolean; value?: { sessionId?: string } }
    return value.ok ? value.value?.sessionId : undefined
  })
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
  const archived = async () => page.evaluate(async () => {
    const response = await fetch('/api/connections/workspaces', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'catalog' }),
    })
    const result = await response.json() as { ok: boolean; value?: { archivedSessionIds: string[] } }
    if (!result.ok) throw new Error('The local workspace catalog was unavailable.')
    return result.value!.archivedSessionIds
  })
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
  await workspaces.getByRole('button', { name: 'Add workspace', exact: true }).click()
  await page.getByRole('dialog', { name: 'Open a project', exact: true }).getByRole('button').filter({ hasText: connectionName }).click()
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
  await verifyFiles(remote, metadata.projects.remote, 'remote')
  await verifyRemoteMedia(page, remote)
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
  await remoteProject.click()
  await expect(remote.locator('.dc-embedded-layout')).toBeVisible({ timeout: 30_000 })
  await verifyFiles(remote, metadata.projects.remote, 'remote')
  await expect(workspaces.locator('.dcw-session button[aria-current="page"]')).toHaveCount(1)
  await verifyParentShortcutGuard(page)
  const sessionId = await selectedRemoteSession(remote)
  expect(sessionId).toBeTruthy()
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
