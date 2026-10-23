import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { posix } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'

type Surface = Page | FrameLocator

async function dismissWelcome(surface: Surface): Promise<void> {
  const preview = surface.getByRole('button', { name: 'Continue', exact: true })
  if (await preview.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await preview.click()
  const welcome = surface.getByRole('dialog', { name: 'Get started', exact: true })
  if (await welcome.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) {
    await welcome.getByRole('button', { name: 'Close', exact: true }).click()
  }
}

async function createProject(surface: Surface, path: string): Promise<void> {
  await surface.getByRole('button', { name: 'Add workspace', exact: true }).click()
  const picker = surface.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
  await picker.getByRole('button', { name: 'Edit path', exact: true }).click()
  const editor = picker.getByRole('textbox', { name: 'Edit path', exact: true })
  await editor.fill(path)
  await editor.press('Enter')
  await expect(editor).toHaveCount(0)
  await picker.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(picker).toBeHidden()
}

async function prepareExistingConnection(page: Page, name: string): Promise<void> {
  const remoteLog = process.env.DSH_REMOTE_LOG
  const target = process.env.DSH_REMOTE_TARGET
  if (!remoteLog || !target) return
  const launch = (await readFile(remoteLog, 'utf8')).match(/dsh web: (http[^\s]+)/)?.[1]
  if (!launch) throw new Error('The isolated remote Host has no startup URL.')
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Connections', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Connections', exact: true })
  await expect(panel.getByText('Loading connections…')).toHaveCount(0)
  if (!await panel.getByText(name, { exact: true }).count()) {
    await panel.getByRole('button', { name: 'Add connection', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Refresh SSH hosts', exact: true })).toBeEnabled()
    const manual = panel.getByRole('button', { name: 'Add manually', exact: true })
    if (await manual.isVisible()) await manual.click()
    await panel.getByLabel('Name', { exact: true }).fill(name)
    await panel.getByLabel('SSH host', { exact: false }).fill(target)
    await panel.getByRole('combobox', { name: /Remote Harness/ }).selectOption('existing')
    await panel.getByLabel('Remote Harness URL', { exact: false }).fill(launch)
    await panel.getByRole('button', { name: 'Save connection', exact: true }).click()
    await expect(panel.getByText(name, { exact: true })).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
}

async function selectSavedProject(surface: Surface, title: string): Promise<void> {
  await surface.getByRole('button', { name: 'Choose workspace', exact: true }).click()
  await surface.getByRole('menuitem', { name: title, exact: true }).click()
}

async function verifyNativeFiles(surface: Surface, root: string): Promise<void> {
  const open = surface.getByRole('button', { name: 'Open right sidebar', exact: true })
  if (await open.isVisible()) await open.click()
  const guide = surface.getByRole('button', { name: /^Workspace files/ })
  if (await guide.isVisible()) await guide.click()
  else await surface.getByRole('tab', { name: /^Files(?:\s|$)/ }).click()
  const tree = surface.locator('[data-files-state="tree"]')
  await expect(tree).toHaveAttribute('data-files-root', root)
  await expect(tree.locator('[data-files-path$="/README.md"]')).toBeVisible()
  const directory = tree.locator('[data-files-path$="/nested"] > button')
  if (await directory.getAttribute('aria-expanded') !== 'true') await directory.click()
  await tree.locator('[data-files-path$="/nested/source.txt"] > button').click()
  await expect(surface.getByText('native sidebar nested file', { exact: false })).toBeVisible()
}

// The operator supplies an isolated local Host and a prepared remote fixture.
// Run again with DSH_REMOTE_REOPEN=1 after restarting only the local Host to
// verify that the saved remote workspace remains usable. This test never
// installs software, starts remote services, or invokes a model.
test('native project picker opens a remote Harness workspace and native files', async ({ page }, info) => {
  const logPath = process.env.DSH_WEB_LOG
  const remoteName = process.env.DSH_REMOTE_NAME
  const project = process.env.DSH_REMOTE_PROJECT
  test.skip(!logPath || !remoteName || !project, 'Set DSH_WEB_LOG, DSH_REMOTE_NAME and DSH_REMOTE_PROJECT for an isolated native integration fixture')
  test.setTimeout(120_000)
  const log = await readFile(logPath!, 'utf8')
  const launch = log.match(/dsh web: (http[^\s]+)/)?.[1]
  if (!launch) throw new Error('The isolated local Host has no startup URL.')
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message.replace(/([?&]token=)[^&\s"']+/gi, '$1[redacted]')))
  await page.goto(launch, { waitUntil: 'networkidle' }).catch(() => { throw new Error('The isolated local Host could not load.') })
  await dismissWelcome(page)
  await prepareExistingConnection(page, remoteName!)
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click()
  await page.getByRole('dialog', { name: 'Open a project', exact: true })
    .getByRole('button', { name: 'This computer', exact: true }).click()
  const localPicker = page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
  await expect(localPicker.getByRole('button', { name: 'Edit path', exact: true })).toBeVisible()
  await localPicker.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(localPicker).toBeHidden()
  const workspaceRows = page.locator('[data-row-key^="workspace:"]')
  const originalLocalWorkspaces = await workspaceRows.evaluateAll(rows => rows.map(row => row.getAttribute('data-row-key')).sort())
  const title = posix.basename(project!.replace(/\/+$/, ''))

  const openRemote = async (): Promise<FrameLocator> => {
    await page.getByRole('button', { name: 'Add workspace', exact: true }).click()
    const chooser = page.getByRole('dialog', { name: 'Open a project', exact: true })
    await expect(chooser.getByRole('button', { name: 'This computer', exact: true })).toBeVisible()
    await chooser.getByRole('button').filter({ hasText: remoteName! }).click()
    const overlay = page.getByRole('dialog', { name: remoteName!, exact: true })
    await expect(overlay).toBeVisible()
    await expect(overlay.locator('iframe[title="Remote Harness"]')).toBeVisible({ timeout: 20_000 })
    const remote = page.frameLocator('iframe[title="Remote Harness"]')
    await dismissWelcome(remote)
    await expect(remote.getByRole('button', { name: 'Add workspace', exact: true })).toBeVisible()
    return remote
  }

  let remote = await openRemote()
  if (process.env.DSH_REMOTE_REOPEN === '1') await selectSavedProject(remote, title)
  else await createProject(remote, project!)
  await expect(remote.locator('[data-row-key^="workspace:"]').filter({ hasText: title })).toHaveCount(1)
  await verifyNativeFiles(remote, project!)
  await page.screenshot({ path: info.outputPath('remote-native-files.png'), fullPage: true })

  await page.getByRole('button', { name: 'Return to this computer', exact: true }).click()
  await expect(page.locator('iframe[title="Remote Harness"]')).toHaveCount(0)
  expect(await workspaceRows.evaluateAll(rows => rows.map(row => row.getAttribute('data-row-key')).sort())).toEqual(originalLocalWorkspaces)

  remote = await openRemote()
  await selectSavedProject(remote, title)
  await verifyNativeFiles(remote, project!)
  await expect(remote.getByText('Failed to load plugins', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])

  // Optional subprocess boundary check: the helper validates ownership before
  // stopping only its own local Host, then binds the same local browser origin.
  const fixture = process.env.DSH_QA_RESTART_FIXTURE
  if (fixture) {
    const selected = remote.locator('[data-row-key^="session:"][aria-selected="true"]')
    const sessionKey = await selected.getAttribute('data-row-key')
    expect(sessionKey).toBeTruthy()
    const source = await page.locator('iframe[title="Remote Harness"]').getAttribute('src')
    const remoteOrigin = new URL(source!).origin
    const remotePid = process.env.DSH_QA_REMOTE_PID
    const before = remotePid ? await readFile(`/proc/${remotePid}/stat`, 'utf8') : undefined
    await promisify(execFile)(process.execPath, ['test/integration/native-fixture.mjs', 'restart', fixture])
    const nextLog = await readFile(logPath!, 'utf8')
    const nextLaunch = nextLog.match(/dsh web: (http[^\s]+)/)?.[1]
    if (!nextLaunch) throw new Error('The restarted isolated Host has no startup URL.')
    await page.goto(nextLaunch, { waitUntil: 'networkidle' }).catch(() => { throw new Error('The restarted isolated Host could not load.') })
    await expect(page.getByRole('button', { name: 'Return to this computer', exact: true })).toBeVisible()
    await expect(page.locator('iframe[title="Remote Harness"]')).toBeVisible({ timeout: 20_000 })
    const restoredSource = await page.locator('iframe[title="Remote Harness"]').getAttribute('src')
    expect(new URL(restoredSource!).origin).toBe(remoteOrigin)
    await expect(remote.locator('[data-row-key^="session:"][aria-selected="true"]')).toHaveAttribute('data-row-key', sessionKey!, { timeout: 20_000 })
    await expect(remote.getByText('native sidebar nested file', { exact: false })).toBeVisible()
    if (remotePid) {
      const after = await readFile(`/proc/${remotePid}/stat`, 'utf8')
      // Linux start time is stable even while process CPU/accounting changes.
      expect(after.split(') ')[1]!.split(' ')[19]).toBe(before!.split(') ')[1]!.split(' ')[19])
    }
    await page.screenshot({ path: info.outputPath('remote-native-after-local-restart.png'), fullPage: true })
  }
})
