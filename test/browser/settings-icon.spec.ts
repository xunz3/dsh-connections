import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { expect, test } from '@playwright/test'
import { connectionsLogoSvg } from '../../src/client/logo.js'

interface IconFixture {
  addSection(id: string, order: number, label: string): void
  removeSection(id: string): void
  remount(): void
  disposeIcon(): void
}

test('settings logo follows its slot identity and cleans up without rewriting native nodes', async ({ page }) => {
  await page.setContent('<div id="settings"></div><nav><div><button id="outside"><svg></svg><span>Connections</span></button></div></nav>')
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import { SlotCore, resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots';
    import { mountSettingsIcon } from './src/client/settings-icon.ts';
    const slots = new SlotCore();
    slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } }, () => null);
    // The rc.3 SettingsRoot renders a title then the complete ordered registry.
    const render = () => {
      const panel = document.createElement('div'); panel.dataset.shortcutModal = 'settings';
      const nav = document.createElement('nav'); const title = document.createElement('div');
      title.innerHTML = '<button id="header-action"><svg></svg><span>Connections</span></button>';
      const list = document.createElement('div');
      for (const entry of [...slots.entries('settings.section')].sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))) {
        const button = document.createElement('button'); button.id = entry.options.id;
        button.innerHTML = '<svg></svg><span></span>'; button.lastChild.textContent = resolveSlotLabel(entry.options.label);
        list.append(button);
      }
      nav.append(title, list); panel.append(nav); document.getElementById('settings').replaceChildren(panel);
    };
    const disposers = new Map();
    window.addSection = (id, order, label) => disposers.set(id, slots.register({ name: 'settings.section', id, order, label }, () => null));
    window.removeSection = id => { disposers.get(id)(); disposers.delete(id) };
    window.remount = render;
    slots.subscribe('settings.section', render);
    window.addSection('general', 0, 'General');
    window.addSection('same-label', 50, 'Connections');
    window.disposeIcon = mountSettingsIcon(slots);
  ` }, bundle: true, platform: 'browser', format: 'iife', write: false })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const icon = page.locator('#connections > svg')
  const expectOtherIcons = async () => {
    for (const svg of await page.locator('#general > svg, #same-label > svg, #header-action > svg, #outside > svg, #earlier > svg').all()) {
      await expect(svg).not.toHaveCSS('display', 'none')
    }
  }
  await expectOtherIcons()
  await page.evaluate(() => (window as unknown as IconFixture).addSection('connections', 30, 'Connections'))
  const original = await page.locator('#settings').innerHTML()
  await expect(icon).toHaveCSS('display', 'none')
  expect(await page.locator('#connections').evaluate(el => getComputedStyle(el, '::before').maskImage)).toContain('data:image/svg+xml')
  await expectOtherIcons()
  await page.evaluate(() => (window as unknown as IconFixture).addSection('earlier', 10, 'Earlier'))
  await expect(icon).toHaveCSS('display', 'none')
  await expectOtherIcons()
  await page.evaluate(() => {
    const fixture = window as unknown as IconFixture
    fixture.removeSection('connections'); fixture.addSection('connections', 75, '连接')
  })
  await expect(icon).toHaveCSS('display', 'none')
  await expectOtherIcons()
  await page.evaluate(() => (window as unknown as IconFixture).remount())
  await expect(icon).toHaveCSS('display', 'none')

  // A changed shell must retain its own icon, never move ours onto another row.
  await page.evaluate(() => document.querySelector('#earlier')!.remove())
  await expect(icon).not.toHaveCSS('display', 'none')
  await expectOtherIcons()
  await page.evaluate(() => (window as unknown as IconFixture).remount())
  await page.evaluate(() => document.querySelector('#connections > span')!.before(document.createElement('i')))
  await expect(icon).not.toHaveCSS('display', 'none')
  await expectOtherIcons()
  await page.evaluate(() => {
    const fixture = window as unknown as IconFixture
    fixture.removeSection('connections'); fixture.removeSection('earlier')
    fixture.addSection('connections', 30, 'Connections')
  })
  await expect(icon).toHaveCSS('display', 'none')
  expect(await page.locator('#settings').innerHTML()).toBe(original)
  await page.evaluate(() => (window as unknown as IconFixture).disposeIcon())
  await expect(icon).not.toHaveCSS('display', 'none')
  expect(await page.locator('#settings').innerHTML()).toBe(original)
  await page.evaluate(() => (window as unknown as IconFixture).addSection('later', 100, 'Later'))
  await expect(icon).not.toHaveCSS('display', 'none')
})

test('standalone and inline logo share vector geometry and inherit light/dark colors', async ({ page }, info) => {
  expect((await readFile(new URL('../../assets/logo.svg', import.meta.url), 'utf8')).trim()).toBe(connectionsLogoSvg)
  await page.setContent('<main id="icons" style="display:flex;align-items:center;gap:24px;padding:32px;color:rgb(40,43,48);background:white"></main>')
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ConnectionsIcon } from './src/client/ConnectionsIcon.tsx';
    createRoot(document.getElementById('icons')).render(<><ConnectionsIcon size={16}/><ConnectionsIcon size={24}/><ConnectionsIcon size={48} aria-label="Connections"/></>);
  ` }, bundle: true, platform: 'browser', format: 'iife', write: false })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await expect(page.locator('#icons > svg')).toHaveCount(3)
  await expect(page.locator('#icons > svg').first()).toHaveAttribute('aria-hidden', 'true')
  await expect(page.getByLabel('Connections', { exact: true })).not.toHaveAttribute('aria-hidden', 'true')
  for (const svg of await page.locator('#icons > svg').all()) await expect(svg).toHaveCSS('stroke', 'rgb(40, 43, 48)')
  await page.screenshot({ path: info.outputPath('connections-logo-light.png') })
  await page.locator('#icons').evaluate(element => { element.style.color = 'rgb(233,235,238)'; element.style.background = '#202227' })
  for (const svg of await page.locator('#icons > svg').all()) await expect(svg).toHaveCSS('stroke', 'rgb(233, 235, 238)')
  await page.screenshot({ path: info.outputPath('connections-logo-dark.png') })
})
