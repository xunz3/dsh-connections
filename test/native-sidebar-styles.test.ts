import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import * as stores from '@deepseek-ai/dsh-client-store'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientBundleRegistration, ClientModuleLoaderTarget, WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'

const require = createRequire(import.meta.url)
const nativeId = '@deepseek-ai/dsh-client-ui-sidebar'
const ownerId = '@xunz03/dsh-connections'
const modulesId = '@deepseek-ai/dsh-client-modules'
const nativeSource = readFileSync(require.resolve(`${nativeId}/client`), 'utf8')
const moduleSource = readFileSync(require.resolve(`${modulesId}/client`), 'utf8')

// A style-only document: module ownership needs real tag identity and selectors,
// while layout and component rendering are covered by the native browser suite.
class StyleTag {
  dataset: Record<string, string> = {}
  textContent = ''
  constructor(private document: StyleDocument) {}
  getAttribute(name: string) { return this.dataset[name === 'data-plugin-css' ? 'pluginCss' : 'plugin'] ?? null }
  setAttribute(name: string, value: string) { this.dataset[name === 'data-plugin-css' ? 'pluginCss' : 'plugin'] = value }
  remove() { this.document.tags.delete(this) }
}

class StyleDocument {
  tags = new Set<StyleTag>()
  head = { appendChild: (tag: StyleTag) => { this.tags.add(tag) } }
  createElement(name: string) { assert.equal(name, 'style'); return new StyleTag(this) }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
  querySelectorAll(selector: string) {
    if (selector === 'style[data-plugin]') return [...this.tags].filter(tag => tag.dataset.plugin !== undefined)
    if (selector === 'style:not([data-plugin])') return [...this.tags].filter(tag => tag.dataset.plugin === undefined)
    const match = /^style\[(data-plugin(?:-css)?)=(".*")\]$/.exec(selector)
    assert.ok(match, `Unexpected style selector: ${selector}`)
    return [...this.tags].filter(tag => tag.getAttribute(match[1]) === JSON.parse(match[2]))
  }
  owned(id: string) { return [...this.tags].filter(tag => tag.dataset.plugin === id) }
}

function graph(ids: string[], rev = 'one'): WebBootGraph {
  return {
    rev,
    entries: ids.map(id => ({ id, rev, url: `/??${id}/client.js&rev=${rev}` })),
    batches: ids.map(id => ({ phase: 'application', rev, url: `/??${id}/client.js&rev=${rev}`, entries: [id] })),
  }
}

async function fixture() {
  const document = new StyleDocument()
  let moduleExports!: typeof import('@deepseek-ai/dsh-client-modules/client')
  runInNewContext(moduleSource, { document, console, window: { __ModuleLoader__: { load(registration: ClientBundleRegistration) {
    moduleExports = registration.factory(require as never) as typeof moduleExports
  } } } })
  const target = { mode: 'queue', pendingQueue: [], load() { throw new Error('Module system not initialized') } } as unknown as ClientModuleLoaderTarget
  const staticModules = {
    '@deepseek-ai/dsh-client-store': stores, '@deepseek-ai/dsh-client-ui-slots': slots,
    react: React, 'react/jsx-runtime': jsx, '@deepseek-ai/dsh-client-ui-primitives': {},
  }
  const boot = graph([nativeId])
  const modules = new moduleExports.ClientModuleSystem({
    manifest: moduleExports.parseBootManifest(boot), staticModules, registrationTarget: target,
    bootstrapModule: { id: modulesId, exports: moduleExports },
    async loadBundle(url) {
      const id = url.includes(ownerId) ? ownerId : nativeId
      let nativeFactory!: ClientBundleRegistration['factory']
      if (id === nativeId) {
        runInNewContext(nativeSource, { document, window: { __ModuleLoader__: { load(registration: ClientBundleRegistration) {
          nativeFactory = registration.factory
        } } } })
      } else {
        // Connections owns its own contribution only. It never materializes a
        // second native factory or claims the native provider's CSS ownership.
        nativeFactory = () => ({ apply() {} })
      }
      // Execute the published factory's real CSS side effects. A no-op plugin
      // isolates stylesheet lifecycle from the separately tested sidebar seats.
      target.load({ id, factory(require) { nativeFactory(require); return { apply() {} } } })
    },
  })
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.internal = modules as never
  await modules.entries.start(ctx.loader, modules.manifest)
  return {
    document, modules,
    async sync(ids: string[], rev = 'one') {
      await modules.entries.sync(graph(ids, rev))
      assert.deepEqual([...modules.entries.state.getSnapshot().failures], [])
    },
    async dispose() { await ctx.fiber.dispose() },
  }
}

test('native sidebar styles keep their identity through Connections enable, reload and disable', async () => {
  const f = await fixture()
  try {
    const original = f.document.owned(nativeId)
    assert.ok(original.length >= 2, 'Published sidebar must provide root and leading-control styles')
    const css = original.map(tag => tag.textContent).sort()
    await f.sync([nativeId, ownerId])
    assert.deepEqual(f.document.owned(nativeId), original, 'Enabling a contribution must not retire the native provider')
    assert.equal(f.document.owned(ownerId).length, 0, 'Connections has no copied sidebar styles')
    await f.modules.entries.reload(ownerId, 'two')
    assert.deepEqual(f.document.owned(nativeId), original, 'Reloading Connections leaves native style tag identity unchanged')
    await f.sync([nativeId], 'three')
    assert.deepEqual(f.document.owned(nativeId), original, 'Entry/bundle removal need no sidebar restoration')
    assert.deepEqual(f.document.owned(nativeId).map(tag => tag.textContent).sort(), css)
  } finally { await f.dispose() }
})
