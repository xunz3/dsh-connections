import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { createLoginHost, type LoginAction, type LoginHost, type PendingLoginWindow } from '../src/client/login-host.js'

const require = createRequire(import.meta.url)
const nativeId = '@deepseek-ai/dsh-client-ui-settings-account'
// The same suite can verify another supported, separately installed native release.
const source = readFileSync(process.env.DSH_QA_ACCOUNT_SOURCE ?? require.resolve(`${nativeId}/client`), 'utf8')
const { composeNativeAccount } = await import(new URL('../scripts/native-account.mjs', import.meta.url).href) as {
  composeNativeAccount(source: string, owner: string): string
}
const adapted = composeNativeAccount(source, '@xunz03/dsh-connections')
const tree = ts.createSourceFile('native-account.js', adapted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const declarations = new Map<string, string>()
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
    && ['BrowserLogin', 'copyLink'].includes(node.name.text)) declarations.set(node.name.text, node.initializer.getText(tree))
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'authorizeUrlWithTheme') declarations.set(node.name.text, node.getText(tree))
  ts.forEachChild(node, visit)
}
visit(tree)
assert.equal(declarations.size, 3, 'Execute the published native presenter and clipboard action, not a duplicate flow')

interface AccountView { attempt?: { id: string; phase: string; authorizeUrl?: string } }
interface BrowserLogin {
  start(request: () => Promise<AccountView>, latest: () => AccountView | undefined): Promise<void>
  update(view: AccountView): void
  dispose(): void
}
function browser(host?: LoginHost, open = (): PendingLoginWindow | null => { throw new Error('Unexpected guest popup') }) {
  const Browser = runInNewContext(`(${declarations.get('BrowserLogin')})`, {
    connectionsLoginHost: host, window: { open },
  }) as new (destination: (url: string) => string) => BrowserLogin
  return new Browser(url => `${url}?theme=dark`)
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('native login owns delayed attempt navigation and cancellation through the desktop capability', async () => {
  const actions: LoginAction[] = [], signals: AbortSignal[] = []
  const host = createLoginHost(async (action, signal) => { actions.push(action); signals.push(signal) }, assert.fail)
  const login = browser(host)
  const response = deferred<AccountView>()
  const starting = login.start(() => response.promise, () => undefined)
  await tick()
  assert.equal(actions.length, 0, 'Preparing a native login must not open about:blank in Desktop')
  response.resolve({ attempt: { id: 'one', phase: 'initializing' } })
  await starting
  login.update({ attempt: { id: 'other-view', phase: 'waiting-browser', authorizeUrl: 'https://login.example.test/unowned' } })
  login.update({ attempt: { id: 'one', phase: 'waiting-browser', authorizeUrl: 'https://login.example.test/authorize' } })
  login.update({ attempt: { id: 'one', phase: 'waiting-browser', authorizeUrl: 'https://login.example.test/authorize' } })
  await tick()
  assert.deepEqual(actions, [{ kind: 'openLogin', url: 'https://login.example.test/authorize?theme=dark' }])
  login.dispose()
  assert.equal(signals[0].aborted, true)

  await login.start(async () => ({ attempt: { id: 'two', phase: 'initializing' } }), () => undefined)
  login.update({ attempt: { id: 'two', phase: 'cancelled' } })
  login.update({ attempt: { id: 'two', phase: 'waiting-browser', authorizeUrl: 'https://login.example.test/late' } })
  await tick()
  assert.equal(actions.length, 1, 'A late authorization URL cannot revive the cancelled native attempt')
  host.dispose()
})

test('desktop login reports asynchronous opening failure and cancels work when its view closes', async () => {
  const failures: Error[] = []
  const response = deferred<void>()
  let sent = 0
  const host = createLoginHost(async () => { sent++; return response.promise }, error => failures.push(error))
  const abandoned = host.prepare()
  abandoned.location.replace('https://login.example.test/abandoned')
  abandoned.close()
  await tick()
  assert.equal(sent, 0, 'Close before dispatch revokes the pending external action')
  const opening = host.prepare()
  opening.location.replace('https://login.example.test/authorize')
  await tick()
  response.reject(new Error('Transport failure with private URL details'))
  await tick()
  assert.equal(failures.length, 1)
  assert.equal(failures[0].message, 'Unable to open the sign-in page in your browser')

  let signal: AbortSignal | undefined
  const pending = deferred<void>()
  const closing = createLoginHost(async (_action, value) => { signal = value; await pending.promise }, assert.fail)
  const popup = closing.prepare()
  popup.location.replace('https://login.example.test/pending')
  await tick()
  closing.dispose()
  assert.equal(signal?.aborted, true)
  assert.equal(popup.closed, true)
  pending.reject(new Error('Cancelled transport'))
  await tick()
  assert.throws(() => closing.prepare(), { name: 'AbortError' })
  host.dispose()
})

test('native Copy feedback waits for desktop acknowledgement, preserves errors, and keeps normal Web APIs', async () => {
  const response = deferred<void>()
  const results: string[] = [], actions: LoginAction[] = []
  const host = createLoginHost(async action => { actions.push(action); await response.promise }, assert.fail)
  function copy(host?: LoginHost, webCopy?: (value: string) => Promise<void>) {
    return runInNewContext(`(() => { ${declarations.get('authorizeUrlWithTheme')}; return ${declarations.get('copyLink')}; })()`, {
      URL, connectionsLoginHost: host, navigator: { clipboard: { writeText: webCopy } }, colorScheme: 'dark',
      setCopyResult: (result: { messageKey: string }) => results.push(result.messageKey),
    }) as (url: string) => Promise<void>
  }
  const copied = copy(host)('https://login.example.test/authorize?state=opaque')
  assert.deepEqual(results, [])
  assert.deepEqual(actions, [{ kind: 'copyLogin', url: 'https://login.example.test/authorize?state=opaque&theme=dark' }])
  response.resolve()
  await copied
  assert.deepEqual(results, ['copiedLink'])
  await copy(createLoginHost(async () => { throw new Error('Clipboard unavailable') }, assert.fail))('https://login.example.test/authorize')
  assert.equal(results.at(-1), 'copyFailed')

  const acknowledgement = deferred<void>()
  let copySignal: AbortSignal | undefined
  const closing = createLoginHost(async (_action, signal) => { copySignal = signal; await acknowledgement.promise }, assert.fail)
  const abandoned = copy(closing)('https://login.example.test/closing')
  closing.dispose()
  assert.equal(copySignal?.aborted, true)
  acknowledgement.resolve()
  await abandoned
  assert.equal(results.at(-1), 'copyFailed', 'A late acknowledgement cannot report success after the view closes')

  let webUrl: string | undefined
  await copy(undefined, async value => { webUrl = value })('https://login.example.test/web')
  assert.equal(webUrl, 'https://login.example.test/web?theme=dark')
  const webPopup: PendingLoginWindow = { opener: null, closed: false, close() {}, location: { replace(value) { webUrl = value } } }
  const web = browser(undefined, () => webPopup)
  await web.start(async () => ({ attempt: { id: 'web', phase: 'waiting-browser', authorizeUrl: 'https://login.example.test/web-native' } }), () => undefined)
  assert.equal(webUrl, 'https://login.example.test/web-native?theme=dark')
  web.dispose()
  host.dispose()
})

test('login capability rejects non-web or credential-bearing URLs without dispatch', async () => {
  const host = createLoginHost(async () => assert.fail('Invalid URL reached Desktop'), assert.fail)
  for (const url of ['file:///tmp/private', 'javascript:alert(1)', 'https://user:password@example.test/', 'not-a-url']) {
    assert.throws(() => host.prepare().location.replace(url), /Invalid sign-in URL/)
    await assert.rejects(host.copy(url), /Invalid sign-in URL/)
  }
  host.dispose()
})

test('native account composition rejects changed seams and gives copied styles independent ownership', () => {
  assert.throws(() => composeNativeAccount('export const apply = () => {}', 'owner'), /bundle format/)
  for (const unsupported of ['0.2.1-rc.4', '0.2.2-alpha.2']) {
    const unreviewed = ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.5']
      .reduce((text, version) => text.replaceAll(version, unsupported), source)
    assert.throws(() => composeNativeAccount(unreviewed, 'owner'), /release contract/)
  }
  assert.throws(() => composeNativeAccount(source.replace('window.open("about:blank", "_blank")', 'window.open("", "_blank")'), 'owner'), /capability contract/)
  assert.throws(() => composeNativeAccount(source.replace('navigator.clipboard.writeText', 'clipboard.writeText'), 'owner'), /capability contract/)
  assert.throws(() => composeNativeAccount(source.replaceAll('tag.dataset.plugin =', 'tag.dataset.unsupportedOwner ='), 'owner'), /stylesheet ownership format/)
  const originalCss: string[] = [], adaptedCss: string[] = [], owners: string[] = [], ids: string[] = []
  function readStyles(text: string, css: string[], owned = false) {
    const file = ts.createSourceFile('account.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
        if (/^css(?:\$\d+)?$/.test(node.name.getText(file))) css.push(node.initializer.text)
        if (owned && /^tagId(?:\$\d+)?$/.test(node.name.getText(file))) ids.push(node.initializer.text)
      }
      if (owned && ts.isBinaryExpression(node) && node.left.getText(file) === 'tag.dataset.plugin'
        && ts.isStringLiteral(node.right)) owners.push(node.right.text)
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  readStyles(source, originalCss)
  readStyles(adapted, adaptedCss, true)
  assert.ok(originalCss.length > 0)
  assert.deepEqual(adaptedCss, originalCss, 'Native design and generated class names stay unchanged')
  assert.equal(owners.length, originalCss.length)
  assert.ok(owners.every(owner => owner === '@xunz03/dsh-connections'))
  assert.equal(new Set(ids).size, originalCss.length)
  assert.ok(ids.every(id => id.startsWith('@xunz03/dsh-connections/native-account/')))
})
