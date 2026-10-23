import { test, expect } from '@playwright/test'

test('save, connect, securely open, edit without redisplaying the secret, then remove', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('No SSH connections yet.')).toBeVisible()
  await page.getByRole('button', { name: 'Add connection' }).click()
  await page.getByLabel('Name', { exact: true }).fill('Development')
  await page.getByLabel('SSH host', { exact: false }).fill('Dev')
  const credential = page.getByLabel('Remote Harness URL')
  await expect(credential).toHaveAttribute('type', 'password')
  await credential.fill('http://127.0.0.1:3000/?token=browser-test-token-not-a-real-credential')
  await page.getByRole('button', { name: 'Save connection' }).click()
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await page.evaluate(() => { window.open = () => null })
  await page.getByRole('button', { name: 'Open Harness' }).click()
  await expect(page.getByRole('link', { name: 'Open Harness' })).toHaveAttribute('rel', 'noopener noreferrer')
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Open Harness' })).toHaveCount(0)
  await page.getByLabel('More actions: Development').click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(credential).toHaveValue('')
  await page.getByLabel('Name', { exact: true }).fill('Build server')
  await page.getByRole('button', { name: 'Save connection' }).click()
  await page.getByLabel('More actions: Build server').click()
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByText('The tunnel will close. Remote Harness keeps running.')).toBeVisible()
  await page.locator('.dc-confirm').getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByText('No SSH connections yet.')).toBeVisible()
})

test('connecting can be cancelled without a stale success restoring the connection', async ({ page }) => {
  await page.goto('/?populated&slow')
  const row = page.locator('li').filter({ hasText: 'Research workstation' })
  await row.getByRole('button', { name: 'Connect', exact: true }).click()
  await row.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(row.getByText('Disconnected', { exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()
  await expect(row.getByText('Connected', { exact: true })).toHaveCount(0)
  await page.waitForTimeout(3100) // Wait for the original connect rejection.
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a late Open reply cannot navigate or restore a credential after disconnect', async ({ page }) => {
  await page.goto('/?populated&slowopen')
  await page.evaluate(() => { window.open = () => { document.body.dataset.opened = 'yes'; return null } })
  await page.getByRole('button', { name: 'Open Harness' }).click()
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await page.waitForTimeout(800) // Deliver the stale authenticated URL.
  await expect(page.getByRole('link', { name: 'Open Harness' })).toHaveCount(0)
  expect(await page.evaluate(() => document.body.dataset.opened)).toBeUndefined()
})

test('remote browser shows local tunnel boundary and disables connect', async ({ page }) => {
  await page.goto('/?populated&remote')
  await expect(page.getByText('This page is not on a local address.', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Open Harness', exact: true })).toBeDisabled()
})

test('Chinese mobile layout fits and keyboard can close an edit', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/?zh&populated')
  await page.getByRole('button', { name: '添加连接' }).click()
  await expect(page.getByLabel('名称', { exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('form')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/connections-mobile.png', fullPage: true })
})

test('light and dark settings overview', async ({ page }) => {
  await page.goto('/?populated')
  await expect(page.getByText('Development', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/connections-light.png', fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: 'test-results/connections-dark.png', fullPage: true })
})
