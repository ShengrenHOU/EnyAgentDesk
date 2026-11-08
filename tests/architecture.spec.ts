/** Guard the dependency directions documented in 007; inspect import syntax without loading host code. */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dependencies = readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' }).filter(file => /\.tsx?$/.test(file))
  .flatMap(name => {
    const file = join(ROOT, 'src', name)
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const result: { file: string; target: string; typeOnly: boolean }[] = []
    const add = (specifier: string, typeOnly: boolean) => result.push({ file: relative(ROOT, file).replaceAll('\\', '/'),
      target: specifier.startsWith('.') ? relative(ROOT, resolve(dirname(file), specifier.split('?')[0]!)).replaceAll('\\', '/') : specifier,
      typeOnly })
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause, bindings = clause?.namedBindings
        const typeOnly = !!clause && (clause.isTypeOnly || !clause.name && !!bindings && ts.isNamedImports(bindings)
          && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly))
        add(node.moduleSpecifier.text, typeOnly)
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        add(node.moduleSpecifier.text, node.isTypeOnly)
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]
        && ts.isStringLiteral(node.arguments[0])) add(node.arguments[0].text, false)
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        add(node.argument.literal.text, true)
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    return result
  })

it('keeps core independent of I/O and outer layers', () => {
  const core = dependencies.filter(item => item.file.startsWith('src/core/'))
  expect(core.length).toBeGreaterThan(0)
  expect(core.filter(item => !item.target.startsWith('src/core/') && item.target !== 'node:crypto')).toEqual([])
})

it('keeps Source plugins independent of application internals', () => {
  expect(dependencies.filter(item => item.file.startsWith('src/sources/') && item.target.startsWith('src/app/'))).toEqual([])
})

it('limits panel host-value imports to the documented plain modules', () => {
  const allowed = new Set(['src/admission.ts', 'src/limits.ts', 'src/setup.ts', 'src/navigation.ts', 'src/sources/host.ts',
    'src/core/errors.ts', 'src/core/reasons.ts', 'src/app/api.ts'])
  expect(dependencies.filter(item => item.file.startsWith('src/client/') && item.target.startsWith('src/')
    && !item.target.startsWith('src/client/') && !item.typeOnly && !allowed.has(item.target))).toEqual([])
})
