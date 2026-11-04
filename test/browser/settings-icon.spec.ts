import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { expect, test } from '@playwright/test'
import { connectionsLogoSvg } from '../../src/client/logo.js'

// Settings navigation keeps the native shell's own icon. Connections artwork is
// used only on plugin-owned surfaces and in its declared display resources.
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
