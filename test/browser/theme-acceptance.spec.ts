import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { expect, test, type Locator, type Page } from '@playwright/test'

test.use({ baseURL: 'http://127.0.0.1:43189' })
const bundles = new Map<string, string>()
let themeCss = ''
test.beforeAll(async () => {
  // Read the installed, exact native theme; do not invent fixture token values.
  const source = await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-theme/client')), 'utf8')
  themeCss = [...source.matchAll(/var \w+_css_default = ("(?:\\.|[^"\\])*");/g)].map(match => JSON.parse(match[1])).join('\n')
  expect(themeCss).toContain('--dsw-alias-button-primary-hover:')
  for (const [name, entry] of Object.entries({ controls: 'theme-acceptance.fixture', panel: 'fixture', rows: 'client-ui.fixture' })) {
    const result = await build({ entryPoints: [`test/browser/${entry}.tsx`], bundle: true, platform: 'browser', format: 'esm', write: false,
      outdir: '/tmp/connections-theme-acceptance', loader: { '.css': 'local-css', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' } })
    bundles.set(name, result.outputFiles.find(file => file.path.endsWith('.js'))!.text)
  }
})
test.beforeEach(async ({ page }) => {
  await page.route('http://127.0.0.1:43189/**', route => {
    const url = new URL(route.request().url()), name = url.pathname.split('/')[1] || 'controls'
    if (url.pathname.endsWith('.js')) return route.fulfill({ contentType: 'text/javascript', body: bundles.get(name.replace('.js', ''))! })
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>${themeCss}body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}main{box-sizing:border-box;padding:12px;max-width:760px}input{max-width:100%;box-sizing:border-box}</style>
      <body ${url.searchParams.has('dark') ? 'data-ds-dark-theme' : ''} style="zoom:${url.searchParams.has('zoom') ? 2 : 1}"><main id="root"></main><script type="module" src="/${name}.js"></script></body></html>` })
  })
})
async function bounded(page: Page, element: Locator) {
  const rect = await element.boundingBox()
  expect(rect).not.toBeNull()
  expect(rect!.x).toBeGreaterThanOrEqual(-1)
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
}
function luminance(color: string): number {
  const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => value / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  return channels.reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0)
}
for (const dark of [false, true]) for (const mode of ['normal', 'zoom', 'forced'] as const) {
  test(`${dark ? 'dark' : 'light'} ${mode}: controls, menu, panel and rows remain usable`, async ({ page }, info) => {
    page.setDefaultTimeout(5000)
    await page.setViewportSize({ width: mode === 'zoom' ? 640 : 360, height: 900 })
    await page.emulateMedia({ forcedColors: mode === 'forced' ? 'active' : 'none', colorScheme: dark ? 'dark' : 'light' })
    const query = `?${dark ? 'dark&' : ''}${mode === 'zoom' ? 'zoom&' : ''}`
    await page.goto(`/controls${query}`)
    const primary = page.getByRole('button', { name: 'Sign in', exact: true })
    for (const hover of [false, true]) {
      if (hover) await primary.hover()
      const colors = await primary.evaluate(element => ({ fg: getComputedStyle(element).color, bg: getComputedStyle(element).backgroundColor }))
      const a = luminance(colors.fg), b = luminance(colors.bg)
      expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toBeGreaterThanOrEqual(4.5)
    }
    await page.keyboard.press('Tab')
    await expect(primary).toBeFocused()
    expect(await primary.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none')
    await primary.press('Enter')
    const dialog = page.getByRole('dialog')
    await bounded(page, dialog)
    await dialog.getByRole('button', { name: 'Continue', exact: true }).focus()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(primary).toBeFocused()
    await page.getByRole('button', { name: 'Host: This computer', exact: true }).click()
    await bounded(page, page.getByRole('menu'))
    for (const dot of await page.locator('.dcs-host-dot').all()) {
      // Forced-colors may suppress backgrounds; the title/accessible label must
      // still expose state rather than relying on color alone.
      expect(await dot.getAttribute('aria-label')).toMatch(/Connecting|Updating/)
      if (mode !== 'forced') expect(await dot.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    }
    await page.screenshot({ path: info.outputPath('host-menu.png') })
    await page.goto(`/panel${query}populated`)
    await expect(page.getByRole('region', { name: 'Connections', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await bounded(page, page.getByRole('dialog'))
    await page.screenshot({ path: info.outputPath('add-connection.png') })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.goto(`/rows${query}rows`)
    const first = page.locator('.dcw-open').first()
    await first.focus(); await first.press('ArrowDown')
    await expect(page.locator('.dcw-open').nth(1)).toBeFocused()
    await bounded(page, page.getByRole('region', { name: 'Workspaces', exact: true }))
    await page.screenshot({ path: info.outputPath('workspace-list.png') })
  })
}
