import { test, expect } from '@playwright/test'
import { start, snapshot } from './workspaces-helpers.js'

// This fixture exercises the guest adapter directly; production desktop opening is disabled.
test('desktop view delegates sign-in popups to the shell and releases its isolated guest', async ({ page }) => {
  await start(page, '?desktop')
  const guest = page.locator('webview')
  await expect(guest).toHaveCount(1)
  await expect(guest).toHaveAttribute('src', 'about:blank#lease-1')
  await expect(guest).toHaveAttribute('partition', 'fixture-private-partition')
  await expect(guest).toHaveAttribute('allowpopups', '')
  await expect.poll(async () => (await snapshot(page)).loads).toBe(1)
  await page.evaluate(() => (window as unknown as { workspaceFixture: { popup(): void } }).workspaceFixture.popup())
  expect((await snapshot(page)).loads).toBe(1)
  expect((await snapshot(page)).external).toEqual(['https://example.test/'])
  await page.getByRole('button', { name: 'Local discussion', exact: true }).click()
  await expect.poll(async () => (await snapshot(page)).releases).toEqual(['lease-1'])
  await expect(guest).toHaveCount(0)
})

test('returning local during desktop allocation releases a late guest reservation', async ({ page }) => {
  await start(page, '?desktop&slowlease')
  await expect.poll(async () => (await snapshot(page)).leases).toBe(1)
  await page.getByRole('button', { name: 'Local discussion', exact: true }).click()
  await page.evaluate(() => (window as unknown as { workspaceFixture: { settleLease(): void } }).workspaceFixture.settleLease())
  await expect.poll(async () => (await snapshot(page)).releases).toEqual(['lease-1'])
  await expect(page.locator('webview')).toHaveCount(0)
  expect((await snapshot(page)).loads).toBe(0)
})

for (const failure of ['acquirefail', 'loadfail', 'crash']) {
  test(`desktop ${failure} produces a clean failure and releases any guest`, async ({ page }) => {
    await start(page, `?desktop&${failure}`)
    if (failure === 'crash') {
      await expect(page.locator('webview')).toHaveCount(1)
      await page.evaluate(() => (window as unknown as { workspaceFixture: { crash(): void } }).workspaceFixture.crash())
    }
    await expect(page.getByRole('alert')).toHaveText('Unable to open this connection. Check its status in Connections and try again.')
    await expect(page.locator('webview')).toHaveCount(0)
    expect(await page.locator('body').innerText()).not.toContain('fixture-workspace-private-credential')
    if (failure !== 'acquirefail') await expect.poll(async () => (await snapshot(page)).releases).toEqual(['lease-1'])
  })
}
