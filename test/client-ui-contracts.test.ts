import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildSync } from 'esbuild'
import { Button, StateDot, UiStyles, relativeTime } from '../src/client/ui/index.js'

test('the owned UI entry has no runtime Harness Client import or body portal', () => {
  const result = buildSync({ entryPoints: ['src/client/ui/index.tsx'], bundle: true, packages: 'external', format: 'esm', platform: 'browser', write: false, metafile: true })
  const dependencies = Object.values(result.metafile!.outputs).flatMap(output => output.imports.map(value => value.path))
  assert.ok(dependencies.length > 0)
  assert.ok(dependencies.every(name => name === 'react' || name === 'react/jsx-runtime'), JSON.stringify(dependencies))
  assert.equal(/createPortal|appendChild\(|document\.body\.append/.test(result.outputFiles[0].text), false)
})

test('row atoms share one control stylesheet at the view boundary', () => {
  const controls = Array.from({ length: 200 }, (_, i) => createElement('div', { key: i },
    createElement(Button, { variant: 'outline' }, 'Action'), createElement(StateDot, { state: 'ongoing' })))
  const html = renderToStaticMarkup(createElement('div', null, createElement(UiStyles), ...controls))
  assert.equal((html.match(/<style/g) ?? []).length, 1)
  assert.equal((html.match(/data-state="ongoing"/g) ?? []).length, 200)
})

test('relative-time buckets retain native boundaries without loading the native utility', () => {
  const minute = 60_000, day = 86_400_000
  for (const [age, unit, n] of [[-1, 'now', 0], [minute - 1, 'now', 0], [minute, 'minutes', 1],
    [60 * minute, 'hours', 1], [day, 'days', 1], [30 * day, 'months', 1], [365 * day, 'years', 1]] as const) {
    assert.deepEqual(relativeTime(1000, 1000 + age), { unit, n })
  }
})
