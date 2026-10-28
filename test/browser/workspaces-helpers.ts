import type { Page } from '@playwright/test'

export async function start(page: Page, query = '') {
  await page.route('http://127.0.0.1:43188/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Remote workspace</title><p>Remote native workspace</p>' }))
  await page.goto(`/workspaces${query}`)
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click()
  await page.getByRole('dialog', { name: 'Open a project', exact: true }).getByRole('button', { name: /Development/ }).click()
}
export async function snapshot(page: Page) {
  return page.evaluate(() => (window as unknown as { workspaceFixture: { snapshot(): { opens: number; localPicks: number; leases: number; releases: string[]; loads: number; external: string[] } } }).workspaceFixture.snapshot())
}
