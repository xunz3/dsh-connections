import assert from 'node:assert/strict'
import test from 'node:test'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { EmbeddedLayoutController, EmbeddedThemePresentation, applyEmbeddedLayout, embeddedColumns } from '../src/client/embedded-layout.js'

test('embedded layout preserves native panel selection and cancels superseded navigation', () => {
  const settings = 'settings' as MainPanelId
  let revealed = 0
  const layout = new EmbeddedLayoutController(id => id === settings, () => revealed++, 1000)
  const first = layout.beginNavigation()
  const second = layout.beginNavigation()
  assert.equal(first.aborted, true)
  assert.equal(second.aborted, false)
  assert.throws(() => layout.selectPanel('missing' as MainPanelId), /unknown main panel/)
  assert.equal(second.aborted, false, 'an invalid destination must not cancel navigation')
  layout.selectPanel(settings)
  assert.equal(second.aborted, true)
  assert.equal(layout.panelInfo.getSnapshot().activePanelId, settings)
  layout.selectPanel(null)
  assert.equal(layout.panelInfo.getSnapshot().activePanelId, null)
  layout.toggleSidebar()
  assert.equal(revealed, 1)
  const pending = layout.beginNavigation()
  layout.dispose()
  assert.equal(pending.aborted, true)
  assert.equal(layout.beginNavigation().aborted, true)
})

test('rightbar geometry protects the conversation and preserves user width across viewport changes', () => {
  const layout = new EmbeddedLayoutController(() => true, undefined, 1200)
  layout.resize(640)
  assert.equal(embeddedColumns(1200, layout.state.getSnapshot().preferredWidth).rightbar, 640)
  layout.measure(800)
  assert.equal(embeddedColumns(800, layout.state.getSnapshot().preferredWidth).rightbar, 400)
  layout.measure(1200)
  assert.equal(embeddedColumns(1200, layout.state.getSnapshot().preferredWidth).rightbar, 640)
  layout.measure(390)
  assert.deepEqual(embeddedColumns(390, layout.state.getSnapshot().preferredWidth), { viewport: 390, rightbar: 0, canShow: false })
  layout.resize(100)
  assert.equal(layout.state.getSnapshot().preferredWidth, 640, 'narrow native fullscreen must not destroy saved width')
  layout.measure(NaN)
  assert.equal(layout.state.getSnapshot().viewport, 390)
})

test('native fullscreen reports retain their requested track and repeated reports do not republish', () => {
  const layout = new EmbeddedLayoutController(() => true)
  layout.openRightbar(true, true)
  const fullscreen = layout.state.getSnapshot()
  assert.deepEqual(fullscreen.rightbar, { shown: true, track: true, fullscreen: true })
  layout.openRightbar(true, true)
  assert.equal(layout.state.getSnapshot(), fullscreen)
  layout.openRightbar(false, true)
  assert.deepEqual(layout.state.getSnapshot().rightbar, { shown: true, track: false, fullscreen: true })
  layout.closeRightbar()
  assert.deepEqual(layout.state.getSnapshot().rightbar, { shown: false, track: false, fullscreen: false })
})

function element() {
  const styles = new Map<string, string>()
  const attributes = new Map<string, string>()
  return {
    clientWidth: 1000,
    style: {
      getPropertyValue: (name: string) => styles.get(name) ?? '',
      setProperty: (name: string, value: string) => { styles.set(name, value) },
      removeProperty: (name: string) => { const value = styles.get(name) ?? ''; styles.delete(name); return value },
    },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => { attributes.set(name, value) },
    removeAttribute: (name: string) => { attributes.delete(name) },
  }
}
const theme = (colorScheme: 'light' | 'dark', tokens: Record<string, string> = {}): ThemeSnapshot => ({
  preference: 'system', active: { id: colorScheme, colorScheme, tokens },
  fontSizes: { text: 16, code: 14, terminal: 13 }, fontFamilies: { text: '', code: 'monospace', terminal: '' }, themes: [], revision: 1,
})

test('theme presentation follows public values and restores previous or independently changed DOM values', () => {
  const document = { documentElement: element(), body: element() }
  document.documentElement.style.setProperty('color-scheme', 'normal')
  document.body.style.setProperty('--dsw-alias-bg-base', 'original')
  const presentation = new EmbeddedThemePresentation(document as unknown as Document)
  presentation.apply(theme('dark', { '--dsw-alias-bg-base': '#111' }))
  assert.equal(document.body.getAttribute('data-ds-dark-theme'), '')
  assert.equal(document.body.style.getPropertyValue('--dsh-content-font-size'), '16px')
  presentation.apply(theme('light'))
  assert.equal(document.body.getAttribute('data-ds-dark-theme'), null)
  assert.equal(document.body.style.getPropertyValue('--dsw-alias-bg-base'), 'original')
  document.body.style.setProperty('--dsh-code-font-size', '20px')
  presentation.dispose()
  assert.equal(document.documentElement.style.getPropertyValue('color-scheme'), 'normal')
  assert.equal(document.body.style.getPropertyValue('--dsh-content-font-size'), '')
  assert.equal(document.body.style.getPropertyValue('--dsh-code-font-size'), '20px', 'teardown must not undo another owner’s change')
})

test('embedded registration exposes native content and overlay slots while requiring exclusive layout ownership', () => {
  const document = { documentElement: element(), body: element() }
  const registrations: Array<{ name: string; children: Record<string, unknown> }> = []
  const effects: Array<() => void> = []
  let provided: unknown
  let hooks: unknown
  const context = {
    get: () => undefined,
    reflect: { provide: (_name: string, value: unknown) => { provided = value; return () => { provided = undefined } } },
    effect: (effect: () => () => void) => { effects.push(effect()) },
    on: () => {},
    theme: { getTheme: () => theme('light') },
    slots: {
      entries: () => [],
      provideRoot: (value: unknown) => { hooks = value },
      register: (value: { name: string; children: Record<string, unknown> }) => { registrations.push(value) },
    },
  }
  const layout = applyEmbeddedLayout(context as never, { document: document as unknown as Document })
  assert.equal(provided, layout)
  assert.deepEqual(hooks, { hooks: { panelInfo: layout.panelInfo } })
  assert.deepEqual(Object.keys(registrations[0].children).sort(), ['main', 'rightbar', 'shell.bottom', 'shell.leading', 'shell.overlay', 'sidebar'])
  assert.equal(registrations[0].name, 'root')
  const pending = layout.beginNavigation()
  for (const dispose of effects.reverse()) dispose()
  assert.equal(pending.aborted, true)
  assert.equal(provided, undefined)
  context.get = () => layout as never
  assert.throws(() => applyEmbeddedLayout(context as never), /native ui-layout disabled/)
})
