import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

for (const file of ['styles.ts', 'workspace-browser.css.ts', 'workspaces.tsx', 'settings-host-menu.tsx']) {
  test(`Connections chrome uses theme tokens instead of literal colors/fonts: ${file}`, async () => {
    const source = await readFile(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|\brgba?\s*\(/i)
    assert.doesNotMatch(source, /\bsystem-ui\b/)
  })
}
