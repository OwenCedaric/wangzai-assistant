// Analyzes the inner declarations of one top-level factory function.
// An inner function is "bound" when it (transitively) uses a factory parameter
// or any non-function inner binding (prepared statements, caches, lets...).
// Unbound inner functions only use module-level names and can be hoisted out.
// Also reports which module-level (non-import) names each one uses, since a
// hoisted function in a new module cannot import those back without a cycle.
//
// Usage: node tools/refactor/factory-graph.mjs <file> <factoryName> [--json]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { SCOPE_OPTIONS, parseSource } from './parse-source.mjs';

const require = createRequire(resolve(import.meta.dirname, '../../frontend/package.json'));
const eslintScope = require('eslint-scope');

const [file, factoryName] = process.argv.slice(2);
const source = readFileSync(file, 'utf8');
const ast = parseSource(source, file, { loc: true, range: true });
const scopeManager = eslintScope.analyze(ast, SCOPE_OPTIONS);
const moduleScope = scopeManager.scopes.find((scope) => scope.type === 'module');

const factoryStatement = ast.body.find((node) => {
  const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
  return decl?.type === 'FunctionDeclaration' && decl.id.name === factoryName;
});
if (!factoryStatement) throw new Error(`factory ${factoryName} not found`);
const factory = factoryStatement.type === 'ExportNamedDeclaration' ? factoryStatement.declaration : factoryStatement;
const factoryScope = scopeManager.acquire(factory);

const inner = new Map(); // name -> { kind, start, end, root }
for (const statement of factory.body.body) {
  if (statement.type === 'FunctionDeclaration') {
    inner.set(statement.id.name, { kind: 'function', start: statement.loc.start.line, end: statement.loc.end.line, root: false });
  } else if (statement.type === 'VariableDeclaration') {
    for (const declarator of statement.declarations) {
      for (const variable of factoryScope.variables.filter((v) => v.defs.some((d) => d.node === declarator))) {
        inner.set(variable.name, { kind: statement.kind, start: statement.loc.start.line, end: statement.loc.end.line, root: true });
      }
    }
  }
}
const params = new Set(factoryScope.variables.filter((v) => v.defs[0]?.type === 'Parameter').map((v) => v.name));
const owner = (line) => {
  for (const [name, info] of inner) if (info.kind === 'function' && line >= info.start && line <= info.end) return name;
  return null;
};
const deps = new Map([...inner.keys()].map((name) => [name, new Set()]));
const moduleUses = new Map([...inner.keys()].map((name) => [name, new Set()]));
const moduleDecls = new Set(moduleScope.variables.filter((v) => v.defs[0] && v.defs[0].type !== 'ImportBinding').map((v) => v.name));
for (const scope of scopeManager.scopes) {
  for (const reference of scope.references) {
    const from = owner(reference.identifier.loc.start.line);
    if (!from) continue;
    const variable = reference.resolved;
    if (!variable) continue;
    if (variable.scope === factoryScope) {
      if (params.has(variable.name)) deps.get(from).add(`param:${variable.name}`);
      else if (inner.has(variable.name) && variable.name !== from) deps.get(from).add(variable.name);
    } else if (variable.scope === moduleScope && moduleDecls.has(variable.name) && variable.name !== factoryName) {
      moduleUses.get(from).add(variable.name);
    }
  }
}
const bound = new Set([...inner].filter(([, info]) => info.root).map(([name]) => name));
for (let changed = true; changed;) {
  changed = false;
  for (const [name, set] of deps) {
    if (bound.has(name)) continue;
    if ([...set].some((dependency) => dependency.startsWith('param:') || bound.has(dependency))) {
      bound.add(name);
      changed = true;
    }
  }
}
const functions = [...inner].filter(([, info]) => info.kind === 'function');
const rows = functions.map(([name, info]) => ({
  name,
  start: info.start,
  lines: info.end - info.start + 1,
  hoistable: !bound.has(name),
  innerDeps: [...deps.get(name)],
  moduleNames: [...moduleUses.get(name)],
}));
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const hoistable = rows.filter((row) => row.hoistable);
  console.log(JSON.stringify({
    innerFunctions: rows.length,
    hoistable: { count: hoistable.length, lines: hoistable.reduce((sum, row) => sum + row.lines, 0) },
    bound: { count: rows.length - hoistable.length, lines: rows.filter((row) => !row.hoistable).reduce((sum, row) => sum + row.lines, 0) },
  }, null, 2));
}
