import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'

test.use({ baseURL: 'http://connections-client-ui.test' })
let script = '', styles = ''
test.beforeAll(async () => {
  const result = await build({ entryPoints: ['test/browser/client-ui.fixture.tsx'], bundle: true, platform: 'browser', format: 'esm', write: false,
    outdir: '/tmp/dsh-client-ui-dev-only', loader: { '.css': 'local-css', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' } })
  script = result.outputFiles.find(file => file.path.endsWith('.js'))!.text
  styles = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n')
})
test.beforeEach(async ({ page }) => {
  await page.route('http://connections-client-ui.test/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/client-ui.js') return route.fulfill({ contentType: 'text/javascript', body: script })
    if (path === '/client-ui.css') return route.fulfill({ contentType: 'text/css', body: styles })
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><style>
      :root{--dsw-alias-bg-base:white;--dsw-alias-bg-layer-1:#f1f3f5;--dsw-alias-bg-layer-2:#fafafa;--dsw-alias-bg-overlay:#0004;--dsw-alias-label-primary:#20242a;--dsw-alias-label-secondary:#666;--dsw-alias-border-l1:#ddd;--dsw-alias-border-l2:#aaa;--dsw-alias-brand-primary:#2477ba;--dsw-alias-state-error-primary:#b24;--dsw-alias-state-idle-primary:#aaa;--dsw-alias-state-success-primary:#283;--dsw-alias-state-warn-primary:#a70}
      body{margin:0;font:14px/1.5 system-ui}button,input{font:inherit}main{width:300px;height:100vh}
      </style><link rel="stylesheet" href="/client-ui.css"></head><body><main id="root"></main><script type="module" src="/client-ui.js"></script></body></html>` })
  })
})
type Fixture = { pageClose(): void; captureClose(): void; runCaptured(): void; owned(): boolean }
const action = (page: Page, action: keyof Omit<Fixture, 'owned'>) => page.evaluate(action => (window as unknown as { clientUiFixture: Fixture }).clientUiFixture[action](), action)
async function openOwned(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open owned dialog', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Owned dialog', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Owned input' })).toBeFocused()
}
const counts = async (page: Page) => JSON.parse((await page.getByTestId('closed').textContent())!)

test('owned dialog above real native Settings consumes Escape and restores its invoking focus', async ({ page }) => {
  await openOwned(page)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Owned dialog', exact: true })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Native settings', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open owned dialog', exact: true })).toBeFocused()
  expect(await counts(page)).toEqual({ native: 0, owned: 1, child: 0 })
})

test('native page.close resolution gives only the owned foreground its authority and rechecks queued callbacks', async ({ page }) => {
  await openOwned(page)
  await action(page, 'captureClose')
  await page.getByRole('button', { name: 'Open native above', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Native above owned', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { clientUiFixture: Fixture }).clientUiFixture.owned())).toBe(false)
  await action(page, 'runCaptured')
  expect(await counts(page)).toEqual({ native: 0, owned: 0, child: 0 })
  await action(page, 'pageClose')
  await expect(page.getByRole('dialog', { name: 'Native above owned', exact: true })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Owned dialog', exact: true })).toBeVisible()
  await action(page, 'pageClose')
  await expect(page.getByRole('dialog', { name: 'Owned dialog', exact: true })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Native settings', exact: true })).toBeVisible()
  expect(await counts(page)).toEqual({ native: 0, owned: 1, child: 1 })
  await page.getByRole('button', { name: 'Open owned dialog', exact: true }).click()
  await action(page, 'runCaptured')
  await expect(page.getByRole('dialog', { name: 'Owned dialog', exact: true })).toBeVisible()
})

test('a real native Modal above an owned layer takes one Escape without closing either background', async ({ page }) => {
  await openOwned(page)
  const invoke = page.getByRole('button', { name: 'Open native above', exact: true })
  await invoke.click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Native above owned', exact: true })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Owned dialog', exact: true })).toBeVisible()
  await expect(invoke).toBeFocused()
  expect(await counts(page)).toEqual({ native: 0, owned: 0, child: 1 })
})

for (const close of ['Escape', 'page.close'] as const) {
  test(`owned menu above owned dialog takes ${close} first and returns focus`, async ({ page }) => {
    await openOwned(page)
    const anchor = page.getByRole('button', { name: 'Owned menu', exact: true })
    await anchor.click()
    await expect(page.getByRole('menu')).toBeVisible()
    if (close === 'Escape') await page.keyboard.press('Escape')
    else await action(page, 'pageClose')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: 'Owned dialog', exact: true })).toBeVisible()
    await expect(anchor).toBeFocused()
    expect(await counts(page)).toEqual({ native: 0, owned: 0, child: 0 })
  })
}

test('real native Menu above owned dialog retains its own Escape keyboard ownership', async ({ page }) => {
  await openOwned(page)
  const anchor = page.getByRole('button', { name: 'Native menu', exact: true })
  await anchor.click()
  await expect(page.getByRole('menuitem', { name: 'Native action', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(anchor).toBeFocused()
  expect(await counts(page)).toEqual({ native: 0, owned: 0, child: 0 })
})

test('owned modal protects IME closing Escape and wraps Tab only at its own edges', async ({ page }) => {
  await openOwned(page)
  const input = page.getByRole('textbox', { name: 'Owned input' })
  await input.dispatchEvent('compositionstart')
  await page.keyboard.press('Escape')
  await expect(input).toBeVisible()
  await input.dispatchEvent('compositionend')
  await input.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
  await expect(input).toBeVisible()
  await input.dispatchEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true })
  const first = page.getByRole('button', { name: 'Close owned dialog', exact: true }), last = page.getByRole('button', { name: 'Last owned action', exact: true })
  await last.focus(); await page.keyboard.press('Tab'); await expect(first).toBeFocused()
  await page.keyboard.press('Shift+Tab'); await expect(last).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Owned dialog', exact: true })).toHaveCount(0)
  expect(await counts(page)).toEqual({ native: 0, owned: 1, child: 0 })
})

test('owned menu preserves arrows Home End disabled rows Tab selection and focus return', async ({ page }) => {
  await openOwned(page)
  const anchor = page.getByRole('button', { name: 'Owned menu', exact: true })
  await anchor.click(); await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'First action', exact: true })).toBeFocused()
  await page.keyboard.press('End'); await expect(page.getByRole('menuitem', { name: 'Second action', exact: true })).toBeFocused()
  await page.keyboard.press('Home'); await expect(page.getByRole('menuitem', { name: 'First action', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(anchor).toBeFocused(); await expect(page.getByTestId('selected')).toHaveText('first')
})

for (const close of ['Escape', 'page.close'] as const) {
  test(`browser showModal ConnectionDialog keeps ${close} and focus restoration scoped above native Settings`, async ({ page }) => {
    await page.goto('/')
    const trigger = page.getByRole('button', { name: 'Open browser dialog', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Browser dialog', exact: true })
    await expect(dialog).toBeVisible()
    expect(await dialog.evaluate(element => element.matches('dialog:modal'))).toBe(true)
    await dialog.getByRole('textbox', { name: 'Browser input', exact: true }).focus()
    if (close === 'Escape') await page.keyboard.press('Escape')
    else await action(page, 'pageClose')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.getByTestId('browser-closed')).toHaveText('1')
    expect(await counts(page)).toEqual({ native: 0, owned: 0, child: 0 })
  })
}

test('owned popover menu inside browser-modal ConnectionDialog takes the first Escape only', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open browser dialog', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Browser dialog', exact: true })
  const anchor = dialog.getByRole('button', { name: 'Browser menu', exact: true })
  await anchor.click()
  await expect(page.getByRole('menuitem', { name: 'Browser menu item', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(dialog).toBeVisible(); await expect(anchor).toBeFocused()
  await action(page, 'pageClose')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('browser-closed')).toHaveText('1')
  expect(await counts(page)).toEqual({ native: 0, owned: 0, child: 0 })
})

test('tooltip is owned and bounded, and row controls do not duplicate complete style sheets', async ({ page }) => {
  await openOwned(page)
  await page.getByRole('button', { name: 'Tooltip anchor', exact: true }).hover()
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toHaveText('Owned help')
  const box = await tooltip.boundingBox()
  expect(box?.x).toBeGreaterThanOrEqual(0)
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(1000)
  await page.goto('/?rows')
  await expect(page.locator('.dcw-session')).toHaveCount(100)
  await expect(page.locator('style[data-connections-ui]')).toHaveCount(1)
  await expect(page.locator('.dcui-state-dot')).toHaveCount(100)
})
