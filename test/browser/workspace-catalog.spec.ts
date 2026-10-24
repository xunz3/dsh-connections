import { test, expect, type Page } from '@playwright/test'

interface CatalogFixture { calls: unknown[][]; disconnect(): void; resolveReconnect(): void }
const fixture = (page: Page) => page.evaluate(() => (window as unknown as { workspaceCatalogFixture: CatalogFixture }).workspaceCatalogFixture.calls)

test('a single workspace list opens equal native IDs on their owning computers', async ({ page }) => {
  await page.goto('/catalog')
  await expect(page.getByRole('heading', { name: 'Workspaces' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Remote discussion · devbox', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Remote discussion · devbox', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: 'Local discussion', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Local discussion', exact: true })).toHaveAttribute('aria-current', 'page')
  expect(await fixture(page)).toEqual([['openSession', 'remote', 'same'], ['openSession', 'local', 'same']])
  await page.getByRole('button', { name: 'Collapse: Remote project' }).click()
  await expect(page.getByRole('button', { name: 'Remote discussion · devbox', exact: true })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Local discussion', exact: true })).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(0)
})

test('search and archive filters keep native ownership and restore archived sessions', async ({ page }) => {
  await page.goto('/catalog')
  await page.getByRole('button', { name: 'Search workspaces and chat titles' }).click()
  await page.getByRole('searchbox').fill('remote discussion')
  await expect(page.getByRole('button', { name: 'Local project', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remote discussion · devbox', exact: true })).toBeVisible()
  await page.getByRole('searchbox').fill('')
  await page.getByRole('button', { name: 'Filter chats' }).click()
  await page.getByRole('combobox', { name: 'Filter chats' }).selectOption('archived')
  const remote = page.locator('[data-source-id="remote"]')
  await expect(remote.getByRole('button', { name: 'Archived discussion · devbox', exact: true })).toBeDisabled()
  await remote.getByLabel('Actions: Archived discussion', { exact: true }).click()
  await remote.getByRole('button', { name: 'Restore', exact: true }).click()
  expect(await fixture(page)).toEqual([['archiveSession', 'remote', 'archived', false]])
})

test('an offline computer keeps its projects and reconnect does not block local navigation', async ({ page }) => {
  await page.goto('/catalog?offline')
  await expect(page.getByRole('button', { name: 'Remote project · devbox', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Local discussion', exact: true }).click()
  expect(await fixture(page)).toEqual([['reconnect', 'remote'], ['openSession', 'local', 'same']])
  await page.evaluate(() => (window as unknown as { workspaceCatalogFixture: CatalogFixture }).workspaceCatalogFixture.resolveReconnect())
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(0)
})

test('rename errors remain visible and disconnected menus cannot mutate native records', async ({ page }) => {
  await page.goto('/catalog?failRename')
  const remote = page.locator('[data-source-id="remote"]')
  await remote.getByLabel('Actions: Remote discussion', { exact: true }).click()
  await remote.getByRole('button', { name: 'Rename', exact: true }).click()
  await remote.getByRole('textbox', { name: 'Rename', exact: true }).fill('Renamed chat')
  await remote.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('The session is no longer available.')
  await remote.getByRole('button', { name: 'Cancel', exact: true }).click()
  await remote.getByLabel('Actions: Remote discussion', { exact: true }).click()
  await page.evaluate(() => (window as unknown as { workspaceCatalogFixture: CatalogFixture }).workspaceCatalogFixture.disconnect())
  await expect(remote.getByRole('button', { name: 'Archive', exact: true })).toBeHidden()
  expect(await fixture(page)).toEqual([['renameSession', 'remote', 'same', 'Renamed chat']])
})

test('native collapsed sidebar keeps search and add available through its owner share', async ({ page }) => {
  await page.goto('/catalog?rail')
  await expect(page.getByRole('heading', { name: 'Workspaces' })).toHaveCount(0)
  await expect(page.locator('aside button')).toHaveCount(2)
  await page.getByRole('button', { name: 'Search workspaces and chat titles' }).click()
  await expect(page.getByRole('searchbox')).toBeFocused()
  await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible()
  expect(await fixture(page)).toEqual([['expandSidebar']])
  await page.goto('/catalog?rail')
  await page.getByRole('button', { name: 'Add workspace' }).click()
  await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible()
  expect(await fixture(page)).toEqual([['expandSidebar'], ['add']])
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`narrow sidebar remains readable in ${colorScheme} mode`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme })
    await page.setViewportSize({ width: 720, height: 600 })
    await page.goto('/catalog?long&zh')
    await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible()
    expect(await page.locator('.dcw-scroll').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.locator('aside').screenshot({ path: testInfo.outputPath(`workspace-catalog-${colorScheme}.png`) })
  })
}
