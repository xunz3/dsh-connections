import { test, expect } from '@playwright/test'
import { start, snapshot } from './workspaces-helpers.js'

test('choosing this computer delegates local adoption while a remote never adopts a local path', async ({ page }) => {
  await page.route('http://127.0.0.1:43188/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Remote native workspace</p>' }))
  await page.goto('/workspaces')
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click()
  await page.getByRole('button', { name: 'This computer', exact: true }).click()
  await page.getByRole('dialog', { name: 'Native local directory picker' }).getByRole('button', { name: 'Confirm local folder' }).click()
  await expect(page.locator('output')).toHaveText('/local/project')
  expect((await snapshot(page)).localPicks).toBe(1)
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click()
  await page.getByRole('button', { name: /Development/ }).click()
  await expect(page.frameLocator('iframe').getByText('Remote native workspace')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.locator('iframe').evaluate(frame => frame.getBoundingClientRect().left)).toBeGreaterThanOrEqual(266)
  expect((await snapshot(page)).localPicks).toBe(1)
  await page.getByRole('button', { name: 'Local discussion', exact: true }).click()
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Local native workspace', exact: true })).toBeVisible()
})

test('remote frame hides on lost connection and selected identity restores without storing a credential', async ({ page }) => {
  await start(page)
  await expect(page.locator('iframe')).toHaveCount(1)
  const entries = await page.evaluate(() => Object.entries(localStorage))
  expect(entries).toEqual([['@xunz/dsh-connections/selection', JSON.stringify({ sourceId: 'connection-11111111-1111-4111-a111-111111111111' })]])
  await page.reload()
  await expect(page.locator('iframe')).toHaveCount(1)
  await page.evaluate(() => (window as unknown as { workspaceFixture: { disconnect(): Promise<void> } }).workspaceFixture.disconnect())
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveText('This connection is no longer available. Reconnect to continue.')
})

test('switching remote chats keeps the content document and shared workspace navigation mounted', async ({ page }) => {
  await start(page)
  await expect(page.locator('iframe')).toHaveCount(1)
  await page.locator('iframe').evaluate(frame => frame.setAttribute('data-instance', 'original'))
  await page.getByRole('button', { name: 'Remote discussion · Development', exact: true }).click()
  await page.getByRole('button', { name: 'Another remote discussion · Development', exact: true }).click()
  await expect(page.locator('iframe')).toHaveAttribute('data-instance', 'original')
  await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Local discussion', exact: true })).toBeVisible()
  expect((await snapshot(page)).opens).toBe(1)
})

test('a loaded HTTP frame stays in progress until the native workspace acknowledges presentation', async ({ page }) => {
  await start(page, '?unpresented')
  await expect(page.frameLocator('iframe').getByText('Remote native workspace')).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Opening workspace…')
  await page.evaluate(() => (window as unknown as { workspaceFixture: { presented(): Promise<void> } }).workspaceFixture.presented())
  await expect(page.getByText('Opening workspace…', { exact: false })).toHaveCount(0)
})

test('an unresponsive remote document becomes a visible retryable error instead of a blank panel', async ({ page }) => {
  await start(page, '?unpresented&timeout')
  await expect(page.getByRole('status')).toContainText('Opening workspace…')
  await expect(page.getByRole('alert')).toHaveText('The remote workspace did not finish loading through SSH. Check the connection and retry.')
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Local discussion', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Local native workspace', exact: true })).toBeVisible()
})
