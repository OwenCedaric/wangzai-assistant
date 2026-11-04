// Builds the dependency graph between a module's top-level declarations and
// marks everything that (transitively) touches module-level mutable state.
// Only "pure" declarations - whose whole dependency closure avoids that state -
// can move to another module without changing shared-state identity or
// creating an import cycle back into the original file.
//
// Usage: node tools/refactor/module-graph.mjs <file> [--state name,name] [--json]
//   --state  extra names to treat as state roots (all top-level `let` and
//            `new Map/Set/WeakMap/AsyncLocalStorage(...)` consts are roots already)
//   --immutable  container consts that are only read (e.g. lookup Sets); refused if the
//            file mutates them (see immutable-containers.mjs)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { assertImmutable } from './immutable-containers.mjs';
import { SCOPE_OPTIONS, parseSource } from './parse-source.mjs';

const require = createRequire(resolve(import.meta.dirname, '../../frontend/package.json'));
const eslintScope = require('eslint-scope');

const args = process.argv.slice(2);
const file = args[0];
const extraState = (args[args.indexOf('--state') + 1] || '').split(',').filter((name) => args.includes('--state') && name);
const immutable = (args[args.indexOf('--immutable') + 1] || '').split(',').filter((name) => args.includes('--immutable') && name);
const source = readFileSync(file, 'utf8');
assertImmutable(source, immutable);
const ast = parseSource(source, file, { loc: true, range: true });
const scopeManager = eslintScope.analyze(ast, SCOPE_OPTIONS);
const moduleScope = scopeManager.scopes.find((scope) => scope.type === 'module');

// Top-level declarations (unwrap `export`).
const declarations = new Map(); // name -> { node, kind, start, end, exported, stateRoot }
for (const statement of ast.body) {
  const exported = statement.type.startsWith('Export') && statement.declaration;
  const node = exported ? statement.declaration : statement;
  const outer = exported ? statement : statement;
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
    declarations.set(node.id.name, { kind: node.type === 'ClassDeclaration' ? 'class' : 'function', start: outer.loc.start.line, end: outer.loc.end.line, exported: Boolean(exported), stateRoot: false });
  } else if (node.type === 'VariableDeclaration') {
    for (const declarator of node.declarations) {
      if (declarator.id.type !== 'Identifier') continue;
      const init = declarator.init;
      const isMutableContainer = init?.type === 'NewExpression' && /^(Map|Set|WeakMap|WeakSet|AsyncLocalStorage)$/.test(init.callee?.name || '');
      declarations.set(declarator.id.name, {
        kind: node.kind,
        start: outer.loc.start.line,
        end: outer.loc.end.line,
        exported: Boolean(exported),
        stateRoot: node.kind === 'let' || (isMutableContainer && !immutable.includes(declarator.id.name)) || extraState.includes(declarator.id.name),
        multi: node.declarations.length > 1,
      });
    }
  }
}

// Edges: which top-level names each declaration's code references.
const deps = new Map([...declarations.keys()].map((name) => [name, new Set()]));
const lineOwner = (line) => {
  for (const [name, info] of declarations) if (line >= info.start && line <= info.end) return name;
  return null;
};
for (const scope of scopeManager.scopes) {
  for (const reference of scope.references) {
    const variable = reference.resolved;
    if (!variable || variable.scope !== moduleScope || !declarations.has(variable.name)) continue;
    const owner = lineOwner(reference.identifier.loc.start.line);
    if (owner && owner !== variable.name) deps.get(owner).add(variable.name);
  }
}

// Stateful = state roots plus everything that transitively depends on one.
const stateful = new Set([...declarations].filter(([, info]) => info.stateRoot).map(([name]) => name));
let changed = true;
while (changed) {
  changed = false;
  for (const [name, set] of deps) {
    if (stateful.has(name)) continue;
    if ([...set].some((dependency) => stateful.has(dependency))) {
      stateful.add(name);
      changed = true;
    }
  }
}

const lineCount = (name) => declarations.get(name).end - declarations.get(name).start + 1;
const pure = [...declarations.keys()].filter((name) => !stateful.has(name));
const summary = {
  declarations: declarations.size,
  stateRoots: [...declarations].filter(([, info]) => info.stateRoot).map(([name]) => name),
  stateful: { count: stateful.size, lines: [...stateful].reduce((sum, name) => sum + lineCount(name), 0) },
  pure: { count: pure.length, lines: pure.reduce((sum, name) => sum + lineCount(name), 0) },
};
if (args.includes('--json')) {
  console.log(JSON.stringify({
    summary,
    declarations: Object.fromEntries([...declarations].map(([name, info]) => [name, {
      ...info, lines: lineCount(name), stateful: stateful.has(name), deps: [...deps.get(name)],
    }])),
  }, null, 2));
} else {
  console.log(JSON.stringify(summary, null, 2));
}
