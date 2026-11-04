import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const nativeTheme = await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-theme/client')), 'utf8')
const defined = new Set([...nativeTheme.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)].map(match => match[1]))
assert.ok(defined.size > 0, 'The installed native theme must expose its token definitions')

for (const file of ['styles.ts', 'workspace-browser.css.ts', 'workspaces.tsx', 'settings-host-menu.tsx', 'embedded-layout.tsx', 'embedded.tsx', 'ui/styles.ts']) {
  test(`Connections chrome references defined native theme tokens: ${file}`, async () => {
    const source = await readFile(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
    const tokens = new Set([...source.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map(match => match[1]))
    assert.ok(tokens.size > 0, 'The chrome must consume native theme tokens')
    assert.deepEqual([...tokens].filter(token => !defined.has(token)), [], 'Undefined native theme tokens')
    assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\s*\(/i)
    assert.doesNotMatch(source, /\bsystem-ui\b/)
  })
}
