import ts from 'typescript'

const nativeId = '@deepseek-ai/dsh-client-shortcuts'

/** Reuse the pinned public service class; its registry and input adapters stay native. */
export function composeNativeShortcuts(source) {
  const prefix = 'window.__ModuleLoader__.load('
  const tree = ts.createSourceFile('native-shortcuts.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const statement = tree.statements[0]
  const call = statement && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
    ? statement.expression : undefined
  const registration = call?.arguments[0]
  const id = registration && ts.isObjectLiteralExpression(registration)
    ? registration.properties.find(property => ts.isPropertyAssignment(property)
      && property.name.getText(tree) === 'id') : undefined
  if (!source.startsWith(prefix) || !id || !ts.isPropertyAssignment(id)
    || !ts.isStringLiteral(id.initializer) || id.initializer.text !== nativeId) {
    throw new Error('Unsupported native shortcuts bundle format')
  }
  return source.replace(prefix, 'const NativeShortcutsService = (entry => entry.factory(require))(')
    + '\nif (typeof NativeShortcutsService !== "function" || typeof NativeShortcutsService.prototype.register !== "function") throw new Error("Unsupported native shortcuts service");\n'
    + 'export default NativeShortcutsService;\n'
}
