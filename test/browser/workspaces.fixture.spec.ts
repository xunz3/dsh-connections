import { test, expect, type Page } from '@playwright/test'

async function start(page: Page, query = '') {
  await page.route('http://127.0.0.1:43188/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Remote workspace</title><p>Remote native workspace</p>' }))
  await page.goto(`/workspaces${query}`)
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click()
  await page.getByRole('dialog', { name: 'Open a project', exact: true }).getByRole('button', { name: /Development/ }).click()
}
async function snapshot(page: Page) {
  return page.evaluate(() => (window as unknown as { workspaceFixture: { snapshot(): { connects: number; opens: number; localPicks: number; leases: number; releases: string[]; loads: number; popups: number; external: string[] } } }).workspaceFixture.snapshot())
}

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
