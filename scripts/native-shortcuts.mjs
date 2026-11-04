import ts from 'typescript'

const nativeId = '@deepseek-ai/dsh-client-shortcuts'

/** Refuse build drift in the private rc.5 content-command adapter; copy no native code. */
export function assertNativeShortcutRegistry(source) {
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
  const classes = new Map()
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isClassExpression(node.initializer)) {
      classes.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  const member = (name, key) => classes.get(name)?.members.find(node => key === 'constructor'
    ? ts.isConstructorDeclaration(node) : node.name?.getText(tree) === key)?.getText(tree).replace(/\s+/g, ' ')
  const checks = [
    [member('ShortcutsService', 'constructor'), /this\.registry = new ShortcutRegistry\(/],
    [member('ShortcutsService', 'constructor'), /this\.catalog = this\.registry\.catalog;/],
    [member('ShortcutsService', 'constructor'), /this\.config = this\.registry\.config;/],
    [member('ShortcutRegistry', 'register'), /this\.commands\.set\(command\.id, command\); this\.refreshLabels\(\);/],
    [member('ShortcutRegistry', 'register'), /this\.commands\.get\(command\.id\) !== command/],
    [member('ShortcutRegistry', 'refreshLabels'), /this\.bindings\.set\(bindingKey\(row\.binding\), command\)/],
    [member('ShortcutRegistry', 'invoke'), /const command = this\.commands\.get\(id\);/],
    [member('ShortcutRegistry', 'invoke'), /command\.resolve\(\{/],
    [member('ShortcutRegistry', 'dispatch'), /const command = this\.bindings\.get\(key\) \?\? this\.conflicts\.get\(key\);/],
    [member('ShortcutRegistry', 'dispatch'), /command\.resolve\(context\)/],
  ]
  if (checks.some(([text, pattern]) => !text || !pattern.test(text))) throw new Error('Unsupported native shortcuts command identity contract')
}
