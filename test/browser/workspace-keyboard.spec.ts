import { expect, test, type Page } from '@playwright/test'

type CatalogFixture = { calls: unknown[][]; disconnect(): void; replaceAuthority(): void; refresh(): void }
const calls = (page: Page) => page.evaluate(() => (window as unknown as { workspaceCatalogFixture: CatalogFixture }).workspaceCatalogFixture.calls)
const main = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const trigger = (page: Page, title: string) => page.getByRole('button', { name: `Actions: ${title}`, exact: true })

async function clipboard(page: Page, mode: 'copy' | 'missing' | 'denied') {
  await page.addInitScript(mode => {
    const copied: string[] = []
    Object.assign(window, { copiedSessionIds: copied })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'missing' ? undefined : {
      async writeText(value: string) {
        if (mode === 'denied') throw new Error('private clipboard permission diagnostic')
        copied.push(value)
      },
    } })
  }, mode)
}

test('roving rows navigate visible source-qualified order without opening sessions or tabbing through every row', async ({ page }) => {
  await page.goto('/catalog')
  const list = page.getByRole('navigation', { name: 'Workspaces', exact: true })
  await expect(list.locator('.dcw-open[tabindex="0"]')).toHaveCount(1)
  await expect(main(page, 'Local project')).toHaveAttribute('tabindex', '0')
  const local = main(page, 'Local discussion')
  const remote = main(page, 'Remote discussion · devbox')
  await local.focus()
  await expect(list.locator('.dcw-open[tabindex="0"]')).toHaveCount(1)
  await expect(local).toHaveAttribute('tabindex', '0')
  await local.press('ArrowDown')
  await expect(main(page, 'Remote project · devbox')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(local).toBeFocused()
  await page.keyboard.press('Home')
  await expect(main(page, 'Local project')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(main(page, 'Local project')).toBeFocused()
  await page.keyboard.press('End')
  await expect(remote).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(remote).toBeFocused()
  await remote.press('Tab')
  await expect(trigger(page, 'Remote discussion')).toBeFocused()
  expect(await list.locator('.dcw-row button').evaluateAll(buttons => buttons.filter(button => (button as HTMLButtonElement).tabIndex === 0)
    .every(button => button.closest('.dcw-row')?.querySelector('.dcw-open')?.getAttribute('aria-label') === 'Remote discussion · devbox'))).toBe(true)
  expect(await calls(page)).toEqual([])
})

test('collapsed rows are skipped and hiding the focused child restores its parent without stealing toolbar focus', async ({ page }) => {
  await page.goto('/catalog')
  const local = main(page, 'Local discussion')
  const parent = main(page, 'Local project')
  await local.focus()
  // An external collapse need not first move pointer focus onto the fold control.
  await main(page, 'Collapse: Local project').evaluate(button => (button as HTMLButtonElement).click())
  await expect(parent).toBeFocused()
  await expect(local).toHaveCount(0)
  await parent.press('ArrowDown')
  await expect(main(page, 'Remote project · devbox')).toBeFocused()
  const filter = main(page, 'Filter chats')
  await filter.click()
  await page.getByRole('menuitem', { name: 'Archived', exact: true }).click()
  await expect(filter).toBeFocused()
  await expect(page.locator('.dcw-open[tabindex="0"]')).toHaveCount(1)
  expect(await calls(page)).toEqual([])
})

for (const surface of ['menu', 'modal'] as const) {
  test(`hiding a row from its own portaled ${surface} restores the remaining parent seat`, async ({ page }) => {
    await page.goto('/catalog')
    const anchor = trigger(page, 'Remote discussion')
    await anchor.click()
    if (surface === 'menu') {
      await anchor.press('ArrowDown')
      await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused()
    } else {
      await page.getByRole('menuitem', { name: 'Archive', exact: true }).click()
      await page.getByRole('dialog', { name: 'Stop and archive chat?', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).focus()
    }
    await main(page, 'Collapse: Remote project').evaluate(button => (button as HTMLButtonElement).click())
    await expect(main(page, 'Remote project · devbox')).toBeFocused()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await calls(page)).toEqual([])
  })
}

test('search Enter reaches results beyond the mounted page while input navigation and no-match focus stay native', async ({ page }) => {
  await page.goto('/catalog?large&selected')
  const selected = main(page, 'Large discussion 19999 · devbox')
  await expect(selected).toHaveAttribute('tabindex', '0')
  const toggle = main(page, 'Search workspaces and chat titles')
  await toggle.click()
  const search = page.getByRole('searchbox')
  await search.fill('Large discussion 19876')
  for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End']) {
    await search.press(key)
    await expect(search).toBeFocused()
  }
  await search.dispatchEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })
  await expect(search).toBeFocused()
  await search.press('Enter')
  await expect(main(page, 'Remote project · devbox')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(main(page, 'Large discussion 19876 · devbox')).toBeFocused()
  await search.focus()
  await search.fill('not present in any catalog')
  await search.press('Enter')
  await expect(search).toBeFocused()
  await search.press('Escape')
  await expect(toggle).toBeFocused()
  await expect(selected).toBeVisible()
  expect(await calls(page)).toEqual([])
})

test('native menus and rename editors retain arrows, Home/End, composition and focus return', async ({ page }) => {
  await page.goto('/catalog')
  const anchor = trigger(page, 'Remote discussion')
  await anchor.focus()
  await anchor.press('Enter')
  await anchor.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByRole('menuitem', { name: 'Copy session ID', exact: true })).toBeFocused()
  await page.keyboard.press('Home')
  await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  const editor = page.getByRole('textbox', { name: 'Rename', exact: true })
  await expect(editor).toBeFocused()
  await editor.fill('Draft title')
  await editor.dispatchEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true })
  await expect(editor).toBeFocused()
  for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End']) {
    await editor.press(key)
    await expect(editor).toBeFocused()
  }
  await editor.press('Escape')
  await expect(anchor).toBeFocused()
  const row = main(page, 'Remote discussion · devbox')
  await row.focus()
  await row.dispatchEvent('keydown', { key: 'ArrowUp', bubbles: true, isComposing: true })
  await expect(row).toBeFocused()
  await row.press('Shift+ArrowUp')
  await expect(row).toBeFocused()
  expect(await calls(page)).toEqual([])
})

test('inline workspace removal cancellation restores its row action anchor', async ({ page }) => {
  await page.goto('/catalog')
  const anchor = trigger(page, 'Remote project')
  await anchor.click()
  await page.getByRole('menuitem', { name: 'Remove from Workspaces', exact: true }).click()
  await page.locator('[data-source-id="remote"] .dcw-confirm').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('.dcw-confirm')).toHaveCount(0)
  await expect(anchor).toBeFocused()
  expect(await calls(page)).toEqual([])
})

test('copy writes only the native session ID and native menus restore their stable focus anchor', async ({ page }) => {
  await clipboard(page, 'copy')
  await page.goto('/catalog')
  for (const title of ['Remote discussion', 'Local discussion']) {
    const anchor = trigger(page, title)
    await anchor.click()
    await page.getByRole('menuitem', { name: 'Copy session ID', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('Session ID copied.')
    await expect(anchor).toBeFocused()
    await expect(anchor).toBeEnabled()
  }
  expect(await page.evaluate(() => (window as unknown as { copiedSessionIds: string[] }).copiedSessionIds)).toEqual(['same', 'same'])
  expect(await calls(page)).toEqual([])
  await page.getByRole('status').getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(page.getByRole('status')).toHaveCount(0)
})

test('offline and archived rows keep local copy available, while disabled opens and Host mutations stay inert', async ({ page }) => {
  await clipboard(page, 'copy')
  await page.goto('/catalog?offline')
  const anchor = trigger(page, 'Remote discussion')
  await anchor.click()
  await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: 'Archive', exact: true })).toBeDisabled()
  await page.getByRole('menuitem', { name: 'Copy session ID', exact: true }).click()
  await expect(anchor).toBeFocused()
  await main(page, 'Filter chats').click()
  await page.getByRole('menuitem', { name: 'Archived', exact: true }).click()
  const archived = main(page, 'Archived discussion · devbox')
  await main(page, 'Remote project · devbox').focus()
  await page.keyboard.press('ArrowDown')
  await expect(archived).toBeFocused()
  await expect(archived).toBeDisabled()
  await archived.press('Enter')
  await archived.press('Tab')
  const archivedAnchor = trigger(page, 'Archived discussion').last()
  await expect(archivedAnchor).toBeFocused()
  await archivedAnchor.press('Enter')
  await expect(page.getByRole('menuitem', { name: 'Restore', exact: true })).toBeDisabled()
  await archivedAnchor.press('End')
  await expect(page.getByRole('menuitem', { name: 'Copy session ID', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(archivedAnchor).toBeFocused()
  expect(await page.evaluate(() => (window as unknown as { copiedSessionIds: string[] }).copiedSessionIds)).toEqual(['same', 'archived'])
  expect(await calls(page)).toEqual([])
})

for (const mode of ['missing', 'denied'] as const) {
  for (const chinese of [false, true]) {
    test(`${mode} clipboard feedback is localized in ${chinese ? 'Chinese' : 'English'} and preserves menu focus`, async ({ page }) => {
      const pageErrors: string[] = []
      page.on('pageerror', error => pageErrors.push(error.message))
      await clipboard(page, mode)
      await page.goto(`/catalog${chinese ? '?zh' : ''}`)
      const anchor = main(page, `${chinese ? '操作' : 'Actions'}: Remote discussion`)
      await anchor.click()
      await page.getByRole('menuitem', { name: chinese ? '复制会话 ID' : 'Copy session ID', exact: true }).click()
      await expect(page.getByRole('alert')).toHaveText(chinese ? '无法复制会话 ID。请检查剪贴板访问权限后重试。' : 'Could not copy the session ID. Check clipboard access and try again.')
      await expect(anchor).toBeFocused()
      await expect(page.getByText('private clipboard permission diagnostic')).toHaveCount(0)
      expect(pageErrors).toEqual([])
      expect(await calls(page)).toEqual([])
    })
  }
}

for (const interaction of ['menu', 'rename', 'forget', 'archive'] as const) {
  test(`authority replacement retires an old ${interaction} with overlapping native IDs and requires a fresh interaction`, async ({ page }) => {
    await page.goto('/catalog')
    const title = interaction === 'forget' ? 'Remote project' : 'Remote discussion'
    const open = async () => {
      await trigger(page, title).click()
      if (interaction === 'rename') await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
      else if (interaction === 'forget') await page.getByRole('menuitem', { name: 'Remove from Workspaces', exact: true }).click()
      else if (interaction === 'archive') await page.getByRole('menuitem', { name: 'Archive', exact: true }).click()
    }
    await open()
    const editor = page.getByRole('textbox', { name: 'Rename', exact: true })
    if (interaction === 'rename') await editor.fill('Old Host draft')
    await page.evaluate(() => (window as unknown as { workspaceCatalogFixture: CatalogFixture }).workspaceCatalogFixture.refresh())
    if (interaction === 'rename') await expect(editor).toHaveValue('Old Host draft')
    if (interaction === 'menu') await expect(page.getByRole('menu')).toBeVisible()
    await page.evaluate(() => (window as unknown as { workspaceCatalogFixture: CatalogFixture }).workspaceCatalogFixture.replaceAuthority())
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(editor).toHaveCount(0)
    await expect(page.locator('.dcw-confirm')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await calls(page), 'retiring the old interaction never sends a business write to the replacement Host').toEqual([])
    await open()
    if (interaction === 'rename') {
      await expect(editor, 'a new editor cannot inherit the old React draft').toHaveValue('Remote discussion')
      await editor.fill('New Host draft')
      await main(page, 'Save').click()
      expect(await calls(page)).toEqual([['renameSession', 'remote', 'same', 'New Host draft']])
    } else if (interaction === 'forget') {
      await page.locator('[data-source-id="remote"] .dcw-confirm').getByRole('button', { name: 'Remove', exact: true }).click()
      expect(await calls(page)).toEqual([['forgetWorkspace', 'remote', 'project']])
    } else if (interaction === 'archive') {
      await page.getByRole('dialog', { name: 'Stop and archive chat?', exact: true }).getByRole('button', { name: 'Stop and archive', exact: true }).click()
      expect(await calls(page)).toEqual([['archiveSession', 'remote', 'same', true, { stopActivity: true }]])
    } else {
      await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
      expect(await calls(page)).toEqual([['pinSession', 'remote', 'same', true]])
    }
  })
}

test('connection refresh preserves a focused row and custom theme tokens style chrome and focus', async ({ page }) => {
  await page.goto('/catalog')
  const row = main(page, 'Remote discussion · devbox')
  await row.focus()
  await page.evaluate(() => (window as unknown as { workspaceCatalogFixture: CatalogFixture }).workspaceCatalogFixture.disconnect())
  await expect(row).toBeFocused()
  await expect(row).toHaveAttribute('tabindex', '0')
  await page.locator('.dcw').evaluate(node => {
    const style = (node as HTMLElement).style
    style.setProperty('--dsw-alias-label-primary', 'rgb(15, 99, 87)')
    style.setProperty('--dsw-focus-ring-color', 'rgb(176, 39, 147)')
    style.setProperty('--dsw-focus-ring-width', '3px')
  })
  await row.press('ArrowUp')
  const focused = page.locator('.dcw-open:focus')
  await expect(focused).toHaveCSS('outline-color', 'rgb(176, 39, 147)')
  await expect(focused).toHaveCSS('outline-width', '3px')
  await expect(page.locator('.dcw')).toHaveCSS('color', 'rgb(15, 99, 87)')
})
