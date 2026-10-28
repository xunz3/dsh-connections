import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import * as cordis from '@deepseek-ai/cordis'
import * as stores from '@deepseek-ai/dsh-client-store'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { createLocalSettingsAdapter, installLocalThemeTokens, readLocalPresentation, type NativePresentationFactory, type NativeSettingsAdapter } from '../src/client/local-presentation.js'
import type { LocalPresentation } from '../src/shared/view-surface-protocol.js'

const require = createRequire(import.meta.url)
const { composeNativeSettings } = await import(new URL('../scripts/native-settings.mjs', import.meta.url).href) as {
  composeNativeSettings(source: string): string
}
const modules: Record<string, unknown> = {
  '@deepseek-ai/cordis': cordis, '@deepseek-ai/dsh-client-store': stores,
  react: React, 'react/jsx-runtime': jsx, '@deepseek-ai/dsh-client-ui-primitives': {},
}
function nativeFactory(packageName: string, settingsAdapter?: NativeSettingsAdapter): NativePresentationFactory {
  let factory!: NativePresentationFactory
  const environment = {
    console, structuredClone, navigator: { languages: ['en'], language: 'en' },
    require: (id: string) => { assert.ok(id in modules, `unexpected native dependency ${id}`); return modules[id] },
    window: { __ModuleLoader__: { load(registration: { factory(require: (id: string) => unknown): NativePresentationFactory }) {
      factory = registration.factory(environment.require)
    } } },
  }
  const source = readFileSync(require.resolve(`${packageName}/client`), 'utf8')
  if (settingsAdapter) {
    const create = runInNewContext(composeNativeSettings(source).replace(/^export /, '') + '\ncreateNativeSettings', environment)
    return create(settingsAdapter)
  }
  runInNewContext(source, environment)
  return factory
}
const nativePackages = {
  'rc.2': { settings: 'native-settings-rc2', locale: 'native-locale-rc2', theme: 'native-theme-rc2' },
  'rc.3': { settings: '@deepseek-ai/dsh-client-ui-settings', locale: '@deepseek-ai/dsh-client-locale', theme: '@deepseek-ai/dsh-client-ui-theme' },
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve))
const presentation = (): LocalPresentation => ({
  locale: 'zh',
  theme: { preference: 'dark', fontSize: 16, codeFontSize: 12, terminalFontSize: 15, textFontFamily: 'Inter', codeFontFamily: 'Consolas', terminalFontFamily: 'Monaco' },
  general: { transcriptView: 'standard', collapseTiming: 'next-input', performanceUsage: 'compact', linkOpening: 'new-tab', busyEnter: 'steer', developerTools: true },
  tokens: { '--dsw-alias-bg-base': '#121212', '--dsw-specific-sidebar-fill': '#181818' },
})

async function fixture(version: keyof typeof nativePackages) {
  const packages = nativePackages[version], ctx = new cordis.Context()
  const source = stores.createSnapshotStore<LocalPresentation | undefined>(presentation())
  let subscribers = 0
  const observed = { getSnapshot: source.getSnapshot, subscribe(listener: () => void) {
    subscribers++
    const off = source.subscribe(listener)
    return () => { subscribers--; off() }
  } }
  const writes: unknown[][] = []
  const rows = ['llm-fixture', 'permission', 'session-log-deepseek'].map(ns => ({
    ns, autoGenerate: false, applies: 'live', secrets: [], revision: 1,
    schema: { type: 'object', dict: { enabled: { type: 'boolean' } } }, value: { enabled: true },
  }))
  ctx.provide('remote', { $on: () => () => {}, settings: {
    describe: async () => ({ ok: true, value: { writable: true, hasDocument: true, namespaces: structuredClone(rows) } }),
    mutate: async (...args: [string, Array<{ value: boolean }>, number]) => {
      writes.push(args)
      const row = rows.find(row => row.ns === args[0])!
      row.value = { enabled: args[1][0].value }; row.revision++
      return { ok: true, value: structuredClone(row) }
    },
  } } as never)
  ctx.provide('remote.settings' as never, {} as never)
  ctx.provide('slots', { installLocale() {}, inject() {} } as never)
  const settings = nativeFactory(packages.settings, createLocalSettingsAdapter(observed))
  const installed = ctx.plugin({ name: 'fixture-native-settings', ...settings })
  await installed
  const presentationOwner = ctx.plugin({ name: 'fixture-token-mirror', apply(scope: cordis.Context) { installLocalThemeTokens(scope, observed) } })
  await ctx.plugin({ name: 'fixture-native-locale', ...nativeFactory(packages.locale) })
  await ctx.plugin({ name: 'fixture-native-theme', ...nativeFactory(packages.theme) })
  for (let attempt = 0; attempt < 30 && !ctx.theme; attempt++) await settled()
  for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) await fiber.await()
  await ctx.configForms.describe().ensure()
  return { ctx, source, writes, installed, presentationOwner, get subscribers() { return subscribers } }
}

for (const version of ['rc.2', 'rc.3'] as const) {
  test(`${version} native settings provider shares local UI preferences with unchanged native locale/theme runtimes`, async t => {
    const f = await fixture(version)
    t.after(() => f.ctx.fiber.dispose())
    assert.equal(f.ctx.locale.getSnapshot().active, 'zh')
    assert.equal(f.ctx.theme.getTheme().active.colorScheme, 'dark')
    assert.equal(f.ctx.theme.getTheme().fontSizes.text, 16)
    assert.equal(f.ctx.theme.getTheme().fontFamilies.code, '"Consolas"')
    assert.equal(f.ctx.theme.getTheme().active.tokens['--dsw-alias-bg-base'], '#121212')
    assert.equal(f.ctx.theme.getTheme().active.tokens['--dsw-specific-sidebar-fill'], '#181818', 'native specific tokens survive alongside alias colors')
    assert.deepEqual(f.ctx.configForms.get('ui-chat').getSnapshot().value, {
      transcriptView: 'standard', collapseTiming: 'next-input', performanceUsage: 'compact', linkOpening: 'new-tab',
    })
    assert.deepEqual(f.ctx.configForms.get('ui-conversation').getSnapshot().value, { busyEnter: 'steer' })
    assert.equal(f.ctx.configForms.developerTools.enabled.getSnapshot(), true, 'native constructor sees the shared value through its public get hook')
    const nativeLocale = f.ctx.locale, nativeTheme = f.ctx.theme
    f.source.set({ ...presentation(), locale: 'en', theme: { ...presentation().theme, preference: 'light', fontSize: 18 },
      general: { ...presentation().general, developerTools: false, busyEnter: 'queue' }, tokens: {} })
    assert.equal(f.ctx.locale, nativeLocale)
    assert.equal(f.ctx.theme, nativeTheme)
    assert.equal(f.ctx.locale.getSnapshot().active, 'en')
    assert.equal(f.ctx.theme.getTheme().active.colorScheme, 'light')
    assert.equal(f.ctx.theme.getTheme().fontSizes.text, 18)
    assert.equal(f.ctx.theme.getTheme().active.tokens['--dsw-alias-bg-base'], undefined)
    assert.equal(f.ctx.configForms.developerTools.enabled.getSnapshot(), false)
    assert.deepEqual(f.ctx.configForms.get('ui-conversation').getSnapshot().value, { busyEnter: 'queue' })
  })

  test(`${version} shared UI forms refuse mutations while native remote forms retain their write queue and revision`, async t => {
    const f = await fixture(version)
    t.after(() => f.ctx.fiber.dispose())
    for (const namespace of ['locale', 'ui-theme', 'ui-chat', 'ui-conversation', 'ui-settings']) {
      const form = f.ctx.configForms.get(namespace)
      assert.equal(form.getSnapshot().writable, false)
      assert.equal(await form.set('preference', 'other'), false)
      assert.equal(await form.unset('preference'), false)
      assert.equal(await form.mutate([{ op: 'set', path: ['preference'], value: 'other' }]), false)
    }
    f.ctx.locale.setLocale('en')
    f.ctx.theme.setTheme('light')
    f.ctx.theme.setFontSize('text', 20)
    await settled()
    assert.equal(f.ctx.locale.getSnapshot().active, 'zh')
    assert.equal(f.ctx.theme.getTheme().active.colorScheme, 'dark')
    assert.equal(f.ctx.theme.getTheme().fontSizes.text, 16)
    assert.deepEqual(f.writes, [])
    for (const namespace of ['llm-fixture', 'permission', 'session-log-deepseek']) {
      const form = f.ctx.configForms.get<{ enabled: boolean }>(namespace)
      assert.equal(form.getSnapshot().writable, true)
      assert.equal(await form.set('enabled', false), true)
      assert.equal(form.getSnapshot().value?.enabled, false)
      assert.equal(form.getSnapshot().revision, 2)
    }
    assert.deepEqual(f.writes.map(args => [args[0], args[2]]), [['llm-fixture', 1], ['permission', 1], ['session-log-deepseek', 1]])
    assert.deepEqual(Array.from(f.ctx.configForms.describe().getSnapshot().view?.namespaces ?? [], row => row.ns), ['llm-fixture', 'permission', 'session-log-deepseek'], 'native describe remains the remote schema directory')
  })

  test(`${version} settings provider disposal releases presentation subscriptions and dependent native services`, async t => {
    const f = await fixture(version)
    t.after(() => f.ctx.fiber.dispose())
    assert.equal(f.subscribers, 2)
    await f.presentationOwner.dispose()
    await f.installed.dispose()
    await settled()
    assert.equal(f.subscribers, 0)
    assert.equal(f.ctx.get('configForms'), undefined)
    assert.equal(f.ctx.get('locale'), undefined)
    assert.equal(f.ctx.get('theme'), undefined)
    f.source.set({ ...presentation(), locale: 'en' })
    assert.deepEqual(f.writes, [])
  })
}

test('parent snapshots use resolved native values and normalize legacy transcript preferences', () => {
  const tokens = { '--dsw-alias-bg-base': '#abcdef' }
  const ctx = {
    locale: { getSnapshot: () => ({ active: 'zh' }) },
    theme: { getTheme: () => ({ preference: 'system', active: { colorScheme: 'dark', tokens }, fontSizes: { text: 16, code: 12, terminal: 15 }, fontFamilies: { text: 'Inter', code: 'Consolas', terminal: 'Monaco' } }) },
    configForms: { get: () => ({ getSnapshot: () => ({ value: { transcriptView: 'expanded' } }) }), developerTools: { enabled: { getSnapshot: () => false } } },
  } as unknown as cordis.Context
  const captured = readLocalPresentation(ctx)
  assert.equal(captured.theme.preference, 'dark')
  assert.equal(captured.locale, 'zh')
  assert.deepEqual(captured.tokens, tokens)
  assert.notEqual(captured.tokens, tokens)
  assert.equal(captured.general.transcriptView, 'detailed')
  assert.equal(captured.general.developerTools, false)
  tokens['--dsw-alias-bg-base'] = '#fedcba'
  assert.equal(captured.tokens['--dsw-alias-bg-base'], '#abcdef')
})

test('settings composition rejects renamed constructors or changed native constructor arguments', () => {
  const source = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-settings/client'), 'utf8')
  assert.throws(() => composeNativeSettings(source.replaceAll('new ConfigForms(', 'new OtherForms(')), /constructor contract/)
  assert.throws(() => composeNativeSettings(source.replace('new ConfigForms(ctx,', 'new ConfigForms(other,')), /constructor contract/)
})
