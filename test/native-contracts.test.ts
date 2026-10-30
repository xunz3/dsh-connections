import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { assertNativeSettingsSlots, nativeSettingsPackages } = await import(new URL('../scripts/native-contracts.mjs', import.meta.url).href) as {
  assertNativeSettingsSlots(sources: Record<string, string>): void
  nativeSettingsPackages: string[]
}
const sources = Object.fromEntries(nativeSettingsPackages.map(name => [name, readFileSync(require.resolve(`${name}/client`), 'utf8')]))

test('native Settings contract checks reject missing or renamed upstream rows', () => {
  assertNativeSettingsSlots(sources)
  for (const name of nativeSettingsPackages) {
    const { [name]: _missing, ...missing } = sources
    assert.throws(() => assertNativeSettingsSlots(missing), /Missing native Settings input/)
    assert.throws(() => assertNativeSettingsSlots({ ...sources, [name]: sources[name].replaceAll('settings.section', 'settings.changed').replaceAll('settings.general.item', 'settings.changed') }), /Unsupported native Settings slot contract/)
  }
  const name = '@deepseek-ai/dsh-client-ui-settings-session-log'
  assert.throws(() => assertNativeSettingsSlots({ ...sources, [name]: sources[name].replace('"session-log-deepseek"', '"renamed"') }), /Unsupported native Settings slot contract/)
})
