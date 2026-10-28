import ts from 'typescript'

const nativeId = '@deepseek-ai/dsh-client-ui-settings-account'
const hostName = 'connectionsLoginHost'

/** Preserve the pinned account UI and flow; inject only its browser capabilities. */
export function composeNativeAccount(source, owner) {
  const prefix = 'window.__ModuleLoader__.load('
  const tree = ts.createSourceFile('native-account.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const statement = tree.statements[0]
  const call = statement && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
    ? statement.expression : undefined
  const registration = call?.arguments[0]
  const id = registration && ts.isObjectLiteralExpression(registration)
    ? registration.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(tree) === 'id') : undefined
  if (!source.startsWith(prefix) || !id || !ts.isStringLiteral(id.initializer) || id.initializer.text !== nativeId) {
    throw new Error('Unsupported native account bundle format')
  }
  const edits = [], styles = new Set()
  let owners = 0, prepare = 0, copy = 0, version
  let versionUses = 0
  const replace = (node, text) => edits.push({ start: node.getStart(tree), end: node.end, text })
  const enclosing = (node, predicate) => {
    for (let parent = node.parent; parent; parent = parent.parent) if (predicate(parent)) return true
    return false
  }
  function visit(node) {
    if (ts.isStringLiteral(node) && /^0\.2\.1-rc\.[23]$/.test(node.text)) {
      if (version && version !== node.text) throw new Error('Ambiguous native account release')
      version = node.text; versionUses++; replace(node, 'nativeRelease')
    }
    if (ts.isIdentifier(node) && node.text === hostName) throw new Error('Unsupported native account capability binding')
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'window.open'
      && node.arguments.length === 2 && node.arguments.every(ts.isStringLiteral)
      && node.arguments[0].text === 'about:blank' && node.arguments[1].text === '_blank'
      && enclosing(node, parent => ts.isClassExpression(parent) && ts.isVariableDeclaration(parent.parent)
        && parent.parent.name.getText(tree) === 'BrowserLogin')) {
      replace(node, `(${hostName} ? ${hostName}.prepare() : ${node.getText(tree)})`)
      prepare++
    }
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'navigator.clipboard.writeText'
      && node.arguments.length === 1 && ts.isCallExpression(node.arguments[0])
      && node.arguments[0].expression.getText(tree) === 'authorizeUrlWithTheme'
      && enclosing(node, parent => ts.isFunctionDeclaration(parent) && parent.name?.text === 'SignInDialog')) {
      replace(node, `(${hostName} ? ${hostName}.copy(${node.arguments[0].getText(tree)}) : ${node.getText(tree)})`)
      copy++
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'plugin'
      && ts.isPropertyAccessExpression(node.left.expression) && node.left.expression.name.text === 'dataset'
      && ts.isStringLiteral(node.right) && node.right.text === nativeId) {
      replace(node.right, JSON.stringify(owner)); owners++
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isStringLiteral(node.initializer)
      && node.initializer.text.startsWith(`${nativeId}/`) && node.initializer.text.endsWith('.css')) {
      styles.add(node.initializer.text)
      replace(node.initializer, JSON.stringify(`${owner}/native-account/${node.initializer.text.slice(nativeId.length + 1)}`))
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (!version || versionUses !== 2) throw new Error('Unsupported native account release contract')
  if (prepare !== 1 || copy !== 1) throw new Error('Unsupported native account browser capability contract')
  if (!owners || owners !== styles.size) throw new Error('Unsupported native account stylesheet ownership format')
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  return `export function createNativeAccount(${hostName}, nativeRelease = ${JSON.stringify(version)}) {\n`
    + source.replace(prefix, 'const nativeAccountEntry = (')
    + '\nreturn nativeAccountEntry.factory(require);\n}\n'
}
