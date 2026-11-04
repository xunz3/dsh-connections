import ts from 'typescript'

const nativeId = '@deepseek-ai/dsh-client-ui-settings'
/** One explicit constructor boundary remains: the Client boot graph cannot
 * compose provider isolation or wait for parent presentation before consumers.
 * Inject an owned, narrowly checked store dependency; never import Client values. */
export function composeNativeSettings(source) {
  const prefix = 'window.__ModuleLoader__.load('
  const tree = ts.createSourceFile('native-settings.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const statement = tree.statements[0]
  const call = statement && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) ? statement.expression : undefined
  const registration = call?.arguments[0]
  const id = registration && ts.isObjectLiteralExpression(registration)
    ? registration.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(tree) === 'id') : undefined
  if (!source.startsWith(prefix) || !id || !ts.isStringLiteral(id.initializer) || id.initializer.text !== nativeId) throw new Error('Unsupported native settings bundle format')
  let seam, dependency, binding, creations = 0, updates = 0
  const replacements = []
  const keys = ['status', 'writable', 'revision', 'base', 'user', 'value']
  function visit(node) {
    if (ts.isIdentifier(node) && ['adaptConfigForms', 'nativeSnapshotStores'].includes(node.text)) throw new Error('Unsupported native settings adapter binding')
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '@deepseek-ai/dsh-client-store') {
      if (dependency || !ts.isVariableDeclaration(node.parent) || !ts.isIdentifier(node.parent.name)) throw new Error('Unsupported native Settings store dependency')
      dependency = node; binding = node.parent.name.text
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'ConfigForms') {
      if (seam || node.arguments?.length !== 2 || node.arguments[0].getText(tree) !== 'ctx' || !ts.isObjectLiteralExpression(node.arguments[1])
        || node.arguments[1].properties.length !== 2 || !node.arguments[1].properties.every(property => ts.isShorthandPropertyAssignment(property) && ['mirror', 'schema'].includes(property.name.text))) throw new Error('Unsupported native settings constructor contract')
      seam = node.expression
    }
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'this.store.update') {
      const update = node.arguments[0]
      if (node.arguments.length !== 1 || !ts.isArrowFunction(update) || update.parameters.length !== 1 || update.parameters[0].name.getText(tree) !== 'draft') throw new Error('Unsupported native Settings shallow update')
      function check(child) {
        if (ts.isIdentifier(child) && child.text === 'draft' && child !== update.parameters[0].name) {
          const field = child.parent
          if (!ts.isPropertyAccessExpression(field) || field.expression !== child || !keys.includes(field.name.text)
            || !ts.isBinaryExpression(field.parent) || field.parent.left !== field || field.parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken) throw new Error('Unsupported native Settings shallow update')
        }
        ts.forEachChild(child, check)
      }
      check(update.body); updates++
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (!seam) throw new Error('Unsupported native settings constructor contract')
  if (!dependency || !binding || updates !== 2) throw new Error('Unsupported native Settings store dependency')
  function uses(node) {
    if (ts.isIdentifier(node) && node.text === binding && node !== dependency.parent.name) {
      if (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node || node.parent.name.text !== 'createSnapshotStore') throw new Error('Unsupported native Settings store usage')
      creations++
    }
    ts.forEachChild(node, uses)
  }
  uses(tree)
  if (creations !== 2) throw new Error('Unsupported native Settings store usage')
  replacements.push({ start: seam.getStart(tree), end: seam.end, value: '(adaptConfigForms(ConfigForms))' },
    { start: dependency.getStart(tree), end: dependency.end, value: 'nativeSnapshotStores' })
  for (const edit of replacements.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.value + source.slice(edit.end)
  return 'export function createNativeSettings(adaptConfigForms, nativeSnapshotStores) {\n' + source.replace(prefix, 'const entry = (') + '\nreturn entry.factory(require);\n}\n'
}
