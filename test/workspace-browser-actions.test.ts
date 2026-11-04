import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { buildSync } from 'esbuild'

// Exercise the existing private component with controlled hooks, not a renderer
// or browser substitute. Real browser focus/menu acceptance remains separate.
const nativeRequire = createRequire(import.meta.url)
const compiled = buildSync({
  stdin: {
    contents: `${readFileSync(new URL('../src/client/WorkspaceBrowser.tsx', import.meta.url), 'utf8')}\nexport { Actions }\n`,
    resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), sourcefile: 'WorkspaceBrowser.tsx', loader: 'tsx',
  }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
}).outputFiles[0].text

function fixture() {
  let state: unknown, reference: { current: unknown } | undefined
  let dependencies: unknown[] | undefined, pendingEffect: (() => void) | undefined
  const module = { exports: {} as { Actions(props: unknown): { props: {
    open: boolean; onSelect(id: string): void; onClose(): void; anchor: { props: { onClick(): void } }
  } } } }
  runInNewContext(compiled, { module, exports: module.exports,
    require(name: string) {
      if (name !== 'react') return nativeRequire(name)
      return { ...nativeRequire('react'),
        useState: () => [state, (value: unknown) => { state = value }],
        useRef: (current: unknown) => reference ??= { current },
        useEffect(effect: () => void, next: unknown[]) {
          if (!dependencies || next.some((value, index) => value !== dependencies![index])) pendingEffect = effect
          dependencies = next
        },
      }
    },
  })
  const calls: string[] = []
  return {
    calls,
    render(authority: string, label = authority) {
      return module.exports.Actions({ authority, label: 'Actions', disabled: false, connected: true, tabIndex: 0,
        items: [{ id: 'rename', label: 'Rename', run() { calls.push(label) } }],
      }).props
    },
    effects() { const effect = pendingEffect; pendingEffect = undefined; effect?.() },
  }
}

test('an open row menu loses authority synchronously and retained callbacks cannot select or close its replacement', () => {
  const f = fixture(), first = crypto.randomUUID(), second = crypto.randomUUID()
  let menu = f.render(first)
  f.effects()
  menu.anchor.props.onClick()
  menu = f.render(first)
  assert.equal(menu.open, true)
  const oldSelect = menu.onSelect, oldClose = menu.onClose
  const replacement = f.render(second)
  assert.equal(replacement.open, false, 'connected → connected closes before passive effects run')
  oldSelect('rename')
  replacement.onSelect('rename')
  assert.deepEqual(f.calls, [])
  f.effects()
  replacement.anchor.props.onClick()
  const current = f.render(second)
  assert.equal(current.open, true)
  oldClose(); oldSelect('rename')
  assert.equal(f.render(second).open, true, 'obsolete callbacks cannot consume the newly opened menu')
  current.onSelect('rename')
  assert.deepEqual(f.calls, [second], 'replacement actions require explicitly opening its own menu')
})

test('same-authority callback and catalog refreshes keep the current menu open', () => {
  const f = fixture(), authority = crypto.randomUUID()
  let menu = f.render(authority, 'old callback')
  f.effects()
  menu.anchor.props.onClick()
  menu = f.render(authority, 'fresh callback')
  f.effects()
  assert.equal(menu.open, true)
  assert.equal(f.render(authority, 'fresh callback').open, true)
  menu.onSelect('rename')
  assert.deepEqual(f.calls, ['fresh callback'])
})
