import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'

test('installed bundle activates in native Harness and persists a private connection', async ({ page }, info) => {
  test.skip(!process.env.DSH_WEB_LOG, 'Set DSH_WEB_LOG to an isolated native Harness startup log')
  const log = await readFile(process.env.DSH_WEB_LOG!, 'utf8')
  const launch = log.match(/dsh web: (http[^\s]+)/)?.[1]
  if (!launch) throw new Error('The isolated Host has no startup URL.')
  await page.goto(launch, { waitUntil: 'networkidle' }).catch(() => { throw new Error('The isolated Host could not load.') })
  // The disposable profile has no provider account; dismiss its native welcome
  // without signing in or changing provider settings.
  const close = page.getByRole('button', { name: 'Close', exact: true })
  if (await close.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) await close.click()
  await expect(page.getByText('Failed to load plugins', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Connections', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Connections', exact: true })
  await expect(panel.getByRole('button', { name: 'Add connection' })).toBeVisible()
  await expect(panel.getByText('Loading connections…')).toHaveCount(0)
  if (await panel.getByText('Native integration test', { exact: true }).count()) {
    await panel.getByLabel('More actions: Native integration test').click()
    await panel.getByRole('button', { name: 'Remove', exact: true }).click()
    await panel.locator('.dc-confirm').getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(panel.getByText('Native integration test', { exact: true })).toHaveCount(0)
  }
  await panel.getByRole('button', { name: 'Add connection' }).click()
  await expect(panel.getByRole('button', { name: 'Refresh SSH hosts', exact: true })).toBeEnabled()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(panel.getByText('Unable to read SSH config.', { exact: false })).toHaveCount(0)
  if (process.env.DSH_EXPECT_SSH_HOSTS === '1') {
    const hosts = panel.getByRole('combobox', { name: /SSH host/ })
    await expect(hosts).toBeVisible()
    expect(await hosts.locator('option[value]:not([value=""])').count()).toBeGreaterThan(0)
  }
  await page.screenshot({ path: info.outputPath('native-ssh-picker.png'), fullPage: true })
  const manual = panel.getByRole('button', { name: 'Add manually', exact: true })
  if (await manual.isVisible()) await manual.click()
  await panel.getByLabel('Name', { exact: true }).fill('Native integration test')
  await panel.getByLabel('SSH host', { exact: false }).fill('fixture')
  await panel.getByRole('combobox', { name: /Remote Harness/ }).selectOption('existing')
  await panel.getByLabel('Remote Harness URL').fill('http://127.0.0.1:3000/?token=isolated-native-test-credential-only')
  await panel.getByRole('button', { name: 'Save connection' }).click()
  await expect(panel.getByText('Native integration test', { exact: true })).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('native-connections.png'), fullPage: true })
  await page.reload({ waitUntil: 'networkidle' })
  if (await close.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) await close.click()
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Connections', exact: true }).click()
  await expect(panel.getByText('Native integration test', { exact: true })).toBeVisible()
  await panel.getByLabel('More actions: Native integration test').click()
  await panel.getByRole('button', { name: 'Remove', exact: true }).click()
  await panel.locator('.dc-confirm').getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(panel.getByText('Native integration test', { exact: true })).toHaveCount(0)
  await expect(panel.getByRole('alert')).toHaveCount(0)
})
