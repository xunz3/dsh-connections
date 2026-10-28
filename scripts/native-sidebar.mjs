import ts from 'typescript'

const nativeId = '@deepseek-ai/dsh-client-ui-sidebar'

/** Compose the pinned native factory, including ownership of its compiled CSS. */
export function composeNativeSidebar(source, owner) {
  const prefix = 'window.__ModuleLoader__.load('
  if (!source.startsWith(prefix)) throw new Error('Unsupported native sidebar bundle format')
  const tree = ts.createSourceFile('native-sidebar.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const edits = []
  let owners = 0
  const styles = new Set()
  const replace = (node, value) => edits.push({ start: node.getStart(tree), end: node.end, text: JSON.stringify(value) })
  function visit(node) {
    // Keep native CSS and class names byte-for-byte. Only change the loader's
    // ownership and deduplication metadata: desktop may already have its own
    // separately compiled sidebar, which must be free to unload independently.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'plugin'
      && ts.isPropertyAccessExpression(node.left.expression) && node.left.expression.name.text === 'dataset'
      && ts.isStringLiteral(node.right) && node.right.text === nativeId) {
      replace(node.right, owner)
      owners++
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isStringLiteral(node.initializer)
      && node.initializer.text.startsWith(`${nativeId}/`) && node.initializer.text.endsWith('.css')) {
      const id = node.initializer.text
      styles.add(id)
      replace(node.initializer, `${owner}/native-sidebar/${id.slice(nativeId.length + 1)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (!owners || owners !== styles.size) throw new Error('Unsupported native sidebar stylesheet ownership format')
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  return source.replace(prefix, 'const nativeSidebar = (entry => entry.factory(require))(')
    + '\nexport const apply = nativeSidebar.apply; export const inject = nativeSidebar.inject;\n'
}
