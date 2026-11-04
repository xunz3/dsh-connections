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
import { nativeSnapshotStores } from '../src/client/settings-native/snapshot-store.js'
import type { LocalPresentation } from '../src/shared/view-surface-protocol.js'
const require = createRequire(import.meta.url)
const { composeNativeSettings } = await import(new URL('../scripts/native-settings.mjs', import.meta.url).href) as { composeNativeSettings(source: string): string }
const modules: Record<string, unknown> = { '@deepseek-ai/cordis': cordis, '@deepseek-ai/dsh-client-store': stores,
  react: React, 'react/jsx-runtime': jsx, '@deepseek-ai/dsh-client-ui-primitives': {} }
function nativeFactory(packageName: string, adapter?: NativeSettingsAdapter): NativePresentationFactory {
  let factory!: NativePresentationFactory
  const environment = { console, structuredClone, navigator: { languages: ['en'], language: 'en' },
    require: (id: string) => { assert.ok(id in modules, `unexpected native dependency ${id}`); return modules[id] },
    window: { __ModuleLoader__: { load(registration: { factory(require: (id: string) => unknown): NativePresentationFactory }) { factory = registration.factory(environment.require) } } } }
  const source = readFileSync(require.resolve(`${packageName}/client`), 'utf8')
  if (adapter) return runInNewContext(composeNativeSettings(source).replace(/^export /, '') + '\ncreateNativeSettings', environment)(adapter, nativeSnapshotStores)
  runInNewContext(source, environment); return factory
}
const releases = {
  'rc.2': { settings: 'native-settings-rc2', locale: 'native-locale-rc2', theme: 'native-theme-rc2' },
  'rc.3': { settings: 'native-settings-rc3', locale: 'native-locale-rc3', theme: 'native-theme-rc3' },
  'rc.5': { settings: '@deepseek-ai/dsh-client-ui-settings', locale: '@deepseek-ai/dsh-client-locale', theme: '@deepseek-ai/dsh-client-ui-theme' },
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve))
const presentation = (): LocalPresentation => ({ locale: 'zh',
  theme: { mode: 'mirrored', preference: 'dark', fontSize: 16, codeFontSize: 12, terminalFontSize: 15, textFontFamily: 'Inter', codeFontFamily: 'Consolas', terminalFontFamily: 'Monaco' },
  general: { transcriptView: 'standard', collapseTiming: 'next-input', performanceUsage: 'compact', linkOpening: 'new-tab', busyEnter: 'steer', developerTools: true },
  tokens: { '--dsw-alias-bg-base': '#121212', '--dsw-specific-sidebar-fill': '#181818' } })
async function fixture(version: keyof typeof releases, adapt = true, ready = true) {
  const packages = releases[version], ctx = new cordis.Context(), source = stores.createSnapshotStore<LocalPresentation | undefined>(ready ? presentation() : undefined)
  let subscribers = 0
  const observed = { getSnapshot: source.getSnapshot, subscribe(listener: () => void) { subscribers++; const off = source.subscribe(listener); return () => { subscribers--; off() } } }
  const values: Record<string, object> = { locale: { preference: 'en' }, 'ui-theme': { ...presentation().theme, preference: 'light', fontSize: 12 },
    'ui-chat': { ...presentation().general, transcriptView: 'compact' }, 'ui-conversation': { busyEnter: 'queue' }, 'ui-settings': { enabled: false },
    'llm-fixture': { enabled: true }, permission: { enabled: true }, 'session-log-deepseek': { enabled: true } }
  const rows = Object.entries(values).map(([ns, value]) => ({ ns, autoGenerate: false, applies: 'live', secrets: [], revision: 1,
    schema: { type: 'object', dict: Object.fromEntries(Object.entries(value).map(([key, value]) => [key, { type: typeof value }])) }, value }))
  const writes: unknown[][] = []
  ctx.provide('remote', { $on: () => () => {}, settings: {
    describe: async () => ({ ok: true, value: { writable: true, hasDocument: true, namespaces: structuredClone(rows) } }),
    mutate: async (...args: [string, Array<{ value: boolean }>, number]) => { writes.push(args); const row = rows.find(row => row.ns === args[0])!; row.value = { enabled: args[1][0].value }; row.revision++; return { ok: true, value: structuredClone(row) } },
  } } as never)
  ctx.provide('remote.settings' as never, {} as never); ctx.provide('slots', { installLocale() {}, inject() {} } as never)
  const settings = ctx.plugin({ name: 'fixture-native-settings', ...nativeFactory(packages.settings, adapt ? createLocalSettingsAdapter(observed) : undefined) }); await settings
  await ctx.configForms.describe().ensure()
  const cached = ['locale', 'ui-theme', 'ui-chat', 'ui-conversation', 'ui-settings'].map(ns => ctx.configForms.get(ns))
  const counts = cached.map(() => 0), offs = cached.map((form, index) => form.subscribe(() => { counts[index]++ }))
  await ctx.plugin({ name: 'fixture-native-locale', ...nativeFactory(packages.locale) }); await ctx.plugin({ name: 'fixture-native-theme', ...nativeFactory(packages.theme) })
  for (let attempt = 0; attempt < 30 && !ctx.theme; attempt++) await settled()
  for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) await fiber.await()
  return { ctx, source, observed, writes, rows, cached, counts, settings, get subscribers() { return subscribers }, dispose: async () => { offs.forEach(off => off()); await ctx.fiber.dispose() } }
}
for (const version of ['rc.2', 'rc.3', 'rc.5'] as const) {
  test(`${version} constructor projection precedes native consumers and preserves remote execution queues`, async t => {
    const f = await fixture(version); t.after(f.dispose)
    const nativeExecutionForm = f.ctx.configForms.get('llm-fixture')
    const tokenOwner = f.ctx.plugin({ apply(scope: cordis.Context) { installLocalThemeTokens(scope, f.observed) } }); await tokenOwner
    assert.equal(f.ctx.locale.getSnapshot().active, 'zh'); assert.equal(f.ctx.theme.getTheme().active.colorScheme, 'dark')
    assert.equal(f.ctx.theme.getTheme().fontSizes.text, 16); assert.equal(f.ctx.theme.getTheme().fontFamilies.code, '"Consolas"')
    assert.equal(f.ctx.configForms.developerTools.enabled.getSnapshot(), true)
    assert.deepEqual(f.cached[2].getSnapshot().value, { transcriptView: 'standard', collapseTiming: 'next-input', performanceUsage: 'compact', linkOpening: 'new-tab' })
    const counts = [...f.counts]
    f.source.set({ ...presentation(), theme: { ...presentation().theme }, general: { ...presentation().general } })
    assert.deepEqual(f.counts, counts, 'equal source updates do not fan out')
    for (const form of f.cached) { assert.equal(form.getSnapshot().writable, false); assert.equal(await form.set('preference', 'other'), false); assert.equal(await form.unset('preference'), false); assert.equal(await form.mutate([{ op: 'set', path: ['preference'], value: 'other' }]), false) }
    f.ctx.locale.setLocale('en'); f.ctx.theme.setTheme('light'); f.ctx.theme.setTheme('system'); f.ctx.theme.setFontSize('text', 20); await settled()
    assert.equal(f.ctx.locale.getSnapshot().active, 'zh'); assert.equal(f.ctx.theme.getTheme().active.colorScheme, 'dark'); assert.equal(f.ctx.theme.getTheme().fontSizes.text, 16)
    assert.deepEqual(f.writes, [])
    f.source.set({ ...presentation(), locale: 'en', theme: { ...presentation().theme, preference: 'light', fontSize: 18 }, general: { ...presentation().general, developerTools: false }, tokens: {} })
    assert.equal(f.ctx.locale.getSnapshot().active, 'en'); assert.equal(f.ctx.theme.getTheme().active.colorScheme, 'light'); assert.equal(f.ctx.theme.getTheme().fontSizes.text, 18)
    assert.equal(f.ctx.configForms.developerTools.enabled.getSnapshot(), false)
    assert.equal(f.ctx.configForms.get('llm-fixture'), nativeExecutionForm, 'execution form identity and its native queue are unchanged')
    for (const namespace of ['llm-fixture', 'permission', 'session-log-deepseek']) { const form = f.ctx.configForms.get<{ enabled: boolean }>(namespace); assert.equal(await form.set('enabled', false), true); assert.equal(form.getSnapshot().revision, 2) }
    assert.deepEqual(f.writes.map(args => [args[0], args[2]]), [['llm-fixture', 1], ['permission', 1], ['session-log-deepseek', 1]])
    assert.deepEqual(Array.from(f.ctx.configForms.describe().getSnapshot().view!.namespaces, row => [row.ns, row.revision, row.value]), f.rows.map(row => [row.ns, row.revision, row.value]))
    await tokenOwner.dispose(); await f.settings.dispose(); assert.equal(f.subscribers, 0)
  })
}
test('late public method replacement is insufficient for already-cached native subscriptions, without forging Host mirror data', async t => {
  const f = await fixture('rc.5', false); t.after(f.dispose)
  const form = f.cached[0], original = form.getSnapshot, before = [...f.counts]
  try {
    form.getSnapshot = () => ({ ...original.call(form), value: { preference: 'zh' } })
    f.source.set({ ...presentation(), locale: 'zh' })
    assert.deepEqual(f.counts, before)
    assert.equal(f.ctx.locale.getSnapshot().active, 'en', 'a real cached native consumer does not magically receive a new subscription')
  } finally { form.getSnapshot = original }
})
test('missing parent presentation never falls back to writable remote UI preferences', async t => {
  const f = await fixture('rc.5', true, false); t.after(f.dispose)
  for (const form of f.cached) { assert.equal(form.getSnapshot().status, 'loading'); assert.equal(form.getSnapshot().writable, false); assert.equal(await form.set('enabled', true), false) }
  assert.equal(f.ctx.configForms.developerTools.enabled.getSnapshot(), false)
  assert.deepEqual(f.writes, [])
  f.source.set(presentation()); assert.equal(f.ctx.locale.getSnapshot().active, 'zh')
})
test('owned Settings stores preserve set reference semantics and shallow-update notification suppression', () => {
  const first = { value: { nested: true }, revision: 1 }, store = nativeSnapshotStores.createSnapshotStore(first)
  let changed = 0; const off = store.subscribe(() => { changed++ })
  store.set(first); store.update(draft => { draft.revision = 1 }); assert.equal(changed, 0)
  const equal = { ...first }; store.set(equal); assert.equal(changed, 1, 'set follows whole reference, not a deep document scan')
  store.update(draft => { draft.revision = 2 }); assert.equal(changed, 2); assert.equal(first.revision, 1)
  off()
})
test('native Settings dependency injection rejects draft or import contract drift', () => {
  const source = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-settings/client'), 'utf8')
  const adapted = composeNativeSettings(source)
  assert.ok(!adapted.includes('require("@deepseek-ai/dsh-client-store")'))
  assert.throws(() => composeNativeSettings(source.replaceAll('new ConfigForms(', 'new OtherForms(')), /constructor contract/)
  assert.throws(() => composeNativeSettings(source.replace('draft.status =', 'draft.value.nested =')), /shallow update/)
  assert.throws(() => composeNativeSettings(source.replace('createSnapshotStore', 'createOtherStore')), /store usage/)
})
test('parent snapshots normalize legacy preferences and copy resolved palette tokens', () => {
  const tokens = { '--dsw-alias-bg-base': '#abcdef' }
  const ctx = { locale: { getSnapshot: () => ({ active: 'zh' }) }, theme: { getTheme: () => ({ preference: 'system', active: { colorScheme: 'dark', tokens }, fontSizes: { text: 16, code: 12, terminal: 15 }, fontFamilies: { text: 'Inter', code: 'Consolas', terminal: 'Monaco' } }) },
    configForms: { get: () => ({ getSnapshot: () => ({ value: { transcriptView: 'expanded' } }) }), developerTools: { enabled: { getSnapshot: () => false } } } } as unknown as cordis.Context
  const captured = readLocalPresentation(ctx); assert.equal(captured.theme.preference, 'dark'); assert.equal(captured.general.transcriptView, 'detailed'); assert.notEqual(captured.tokens, tokens)
})
