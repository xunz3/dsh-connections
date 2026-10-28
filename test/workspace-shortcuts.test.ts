import assert from 'node:assert/strict'
import test from 'node:test'
import type { ShortcutCommand, ShortcutContext } from '@deepseek-ai/dsh-client-shortcuts/client'
import { workspaceCommandResolver, remoteSettingsCommand } from '../src/client/workspace-shortcuts.js'

const context: ShortcutContext = { region: 'page', modal: null, target: null }
const command = (id: string) => ({ id }) as ShortcutCommand
function fixture() {
  let source: string | undefined = 'remote-a'
  const calls: string[] = []
  const resolve = workspaceCommandResolver({
    getRemoteSourceId: () => source,
    onNewSession: id => { calls.push(`new:${id}`) },
    onSearch: () => { calls.push('search') }, onAddWorkspace: () => { calls.push('add') },
    onClose: id => { calls.push(`close:${id}`) }, onBlocked: (id, source) => { calls.push(`blocked:${source}:${id}`) },
  })
  return { calls, select: (id?: string) => { source = id }, resolve,
    run(id: string, extra: Partial<ShortcutContext> = {}) {
      const result = resolve(command(id), { ...context, ...extra })
      if (result?.status === 'handled') result.run()
      return result?.status
    },
  }
}

test('native command resolution captures current source for navigation and keeps unified search/add', () => {
  const h = fixture()
  for (const source of ['remote-a', 'remote-b', undefined]) {
    h.select(source)
    assert.equal(h.run('session.new'), 'handled')
    assert.equal(h.run('session.search'), 'handled')
    assert.equal(h.run('workspace.add'), 'handled')
  }
  assert.deepEqual(h.calls, ['new:remote-a', 'search', 'add', 'new:remote-b', 'search', 'add', 'new:local', 'search', 'add'])
  h.select('remote-a')
  const result = h.resolve(command('session.new'), context)
  h.select('remote-b')
  if (result?.status === 'handled') result.run()
  assert.equal(h.calls.at(-1), 'new:remote-a', 'execution must not silently retarget after resolution')
})

test('remote commands cannot mutate retained local sessions or close the Desktop window', () => {
  const h = fixture()
  for (const id of ['session.archive', 'session.fork', 'session.rename', 'sidebar.right.toggle', 'pane.split', 'page.refresh', 'terminal.new', 'browser.new']) {
    assert.equal(h.run(id), 'handled')
    assert.equal(h.calls.at(-1), `blocked:remote-a:${id}`)
  }
  assert.equal(h.run('page.close', { source: 'menu' }), 'handled')
  assert.equal(h.calls.at(-1), 'close:remote-a')
  h.select(undefined)
  for (const id of ['session.archive', 'session.fork', 'session.rename', 'sidebar.right.toggle', 'page.close']) assert.equal(h.run(id), undefined)
  assert.equal(h.run('settings.open'), undefined, 'native global controls retain their owner')
})

test('local modal, stale guest, and settings ownership are resolved before background navigation', () => {
  const h = fixture()
  assert.equal(h.run('session.new', { modal: 'settings' }), 'blocked')
  assert.equal(h.run('page.close', { modal: 'shortcuts' }), undefined)
  assert.equal(h.run('session.new', { source: 'webview', target: { getAttribute: () => 'retired-remote' } as never }), 'blocked')
  assert.equal(h.run('session.new', { source: 'webview', target: { getAttribute: () => 'remote-a' } as never }), 'handled')
  assert.deepEqual(h.calls, ['new:remote-a'])
  let closed = 0
  const close = () => { closed++ }
  const result = remoteSettingsCommand(command('page.close'), { ...context, modal: 'settings', source: 'menu' }, close)
  assert.equal(result?.status, 'handled')
  if (result?.status === 'handled') result.run()
  assert.equal(closed, 1)
  assert.equal(remoteSettingsCommand(command('session.new'), context, close)?.status, 'blocked')
  assert.equal(remoteSettingsCommand(command('page.close'), { ...context, modal: 'shortcuts' }, close), undefined)
})
