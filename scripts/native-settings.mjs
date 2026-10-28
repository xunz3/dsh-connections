import ts from 'typescript'

const nativeId = '@deepseek-ai/dsh-client-ui-settings'

/** Preserve native settings transport/lifecycle; specialize only its public form accessor. */
export function composeNativeSettings(source) {
  const prefix = 'window.__ModuleLoader__.load('
  const tree = ts.createSourceFile('native-settings.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const statement = tree.statements[0]
  const call = statement && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) ? statement.expression : undefined
  const registration = call?.arguments[0]
  const id = registration && ts.isObjectLiteralExpression(registration)
    ? registration.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(tree) === 'id') : undefined
  if (!source.startsWith(prefix) || !id || !ts.isStringLiteral(id.initializer) || id.initializer.text !== nativeId) {
    throw new Error('Unsupported native settings bundle format')
  }
  let seam
  function visit(node) {
    if (ts.isIdentifier(node) && node.text === 'adaptConfigForms') throw new Error('Unsupported native settings adapter binding')
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'ConfigForms') {
      if (seam || node.arguments?.length !== 2 || node.arguments[0].getText(tree) !== 'ctx'
        || !ts.isObjectLiteralExpression(node.arguments[1])
        || node.arguments[1].properties.length !== 2
        || !node.arguments[1].properties.every(property => ts.isShorthandPropertyAssignment(property) && ['mirror', 'schema'].includes(property.name.text))) {
        throw new Error('Unsupported native settings constructor contract')
      }
      seam = node.expression
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (!seam) throw new Error('Unsupported native settings constructor contract')
  source = source.slice(0, seam.getStart(tree)) + '(adaptConfigForms(ConfigForms))' + source.slice(seam.end)
  return 'export function createNativeSettings(adaptConfigForms) {\n'
    + source.replace(prefix, 'const entry = (') + '\nreturn entry.factory(require);\n}\n'
}
