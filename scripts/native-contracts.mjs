import ts from 'typescript'

const expected = {
  '@deepseek-ai/dsh-client-ui-settings-models': ['settings.section', 'models'],
  '@deepseek-ai/dsh-client-ui-permission-presets': ['settings.general.item', 'permission'],
  '@deepseek-ai/dsh-client-ui-settings-session-log': ['settings.general.item', 'session-log-deepseek'],
}

/** Check the native registrations the remote adapter selects by ID. */
export function assertNativeSettingsSlots(sources) {
  for (const [name, [slot, id]] of Object.entries(expected)) {
    const source = sources[name]
    if (typeof source !== 'string') throw new Error(`Missing native Settings input: ${name}`)
    const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const bindings = new Map()
    function constants(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteral(node.initializer)) {
        const values = bindings.get(node.name.text) ?? new Set()
        values.add(node.initializer.text)
        bindings.set(node.name.text, values)
      }
      ts.forEachChild(node, constants)
    }
    constants(tree)
    const literal = value => ts.isStringLiteral(value) ? value.text
      : ts.isIdentifier(value) && bindings.get(value.text)?.size === 1 ? [...bindings.get(value.text)][0] : undefined
    let matches = 0
    function registrations(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'register' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const fields = new Map(node.arguments[0].properties.filter(ts.isPropertyAssignment)
          .map(property => [property.name.getText(tree), literal(property.initializer)]))
        if (fields.get('name') === slot && fields.get('id') === id) matches++
      }
      ts.forEachChild(node, registrations)
    }
    registrations(tree)
    if (matches !== 1) throw new Error(`Unsupported native Settings slot contract: ${name} (${slot}/${id})`)
  }
}

export const nativeSettingsPackages = Object.keys(expected)
