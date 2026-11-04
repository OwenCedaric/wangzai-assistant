// Refactor tool: hoists unbound inner functions of a factory into a new module.
// The function text is copied verbatim (only the factory's extra two-space
// indent is removed, never inside multi-line template literals).
//
// Module-level names the hoisted code uses are provided to the new module as:
//   - imports of the original file          -> same import, rebased;
//   - names destructured from an imported namespace (`const {a} = ns;`)
//                                            -> named import from that module, after
//                                               verifying it really exports the name;
//   - plain module-level consts listed with --move-const
//                                            -> declaration moved + exported, and the
//                                               original imports it (single identity).
// Refuses when a name is bound to factory state, depends on a non-hoisted inner
// declaration, or uses a module-level name it cannot provide.
//
// Usage: node tools/refactor/hoist-factory-functions.mjs --file <src> --factory <name>
//          --module <new file> --names a,b [--move-const X,Y] [--dry-run]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { SCOPE_OPTIONS } from './parse-source.mjs';

const require = createRequire(resolve(import.meta.dirname, '../../frontend/package.json'));
const espree = require('espree');
const eslintScope = require('eslint-scope');

const argv = process.argv.slice(2);
const option = (key) => (argv.includes(key) ? argv[argv.indexOf(key) + 1] : '');
const file = resolve(option('--file'));
const factoryName = option('--factory');
const modulePath = resolve(option('--module'));
const names = option('--names').split(',').filter(Boolean);
const moveConsts = option('--move-const').split(',').filter(Boolean);
const dryRun = argv.includes('--dry-run');
if (existsSync(modulePath)) throw new Error(`module already exists: ${modulePath}`);

const parse = (text) => espree.parse(text, { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true });
const source = readFileSync(file, 'utf8');
// New lines follow the first line's terminator; existing lines keep their own (some files mix CRLF/LF).
const eol = /^[^\n]*\r\n/.test(source) ? '\r\n' : '\n';
const ast = parse(source);
const scopeManager = eslintScope.analyze(ast, SCOPE_OPTIONS);
const moduleScope = scopeManager.scopes.find((scope) => scope.type === 'module');
const problems = [];

const factoryStatement = ast.body.find((node) => {
  const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
  return decl?.type === 'FunctionDeclaration' && decl.id.name === factoryName;
});
const factory = factoryStatement.type === 'ExportNamedDeclaration' ? factoryStatement.declaration : factoryStatement;
const factoryScope = scopeManager.acquire(factory);
const innerFunctions = new Map(factory.body.body.filter((node) => node.type === 'FunctionDeclaration').map((node) => [node.id.name, node]));

// Classify module-level bindings.
const importsByLocal = new Map();
for (const node of ast.body.filter((statement) => statement.type === 'ImportDeclaration')) {
  for (const specifier of node.specifiers) {
    importsByLocal.set(specifier.local.name, {
      from: node.source.value,
      imported: specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.type === 'ImportNamespaceSpecifier' ? '*' : specifier.imported.name,
    });
  }
}
const destructuredFromNamespace = new Map(); // local -> { from, imported }
const moduleConsts = new Map(); // name -> statement
for (const node of ast.body.filter((statement) => statement.type === 'VariableDeclaration')) {
  for (const declarator of node.declarations) {
    if (declarator.id.type === 'ObjectPattern' && declarator.init?.type === 'Identifier' && importsByLocal.get(declarator.init.name)?.imported === '*') {
      const from = importsByLocal.get(declarator.init.name).from;
      for (const property of declarator.id.properties) {
        if (property.type === 'Property' && property.value.type === 'Identifier' && !property.computed) {
          destructuredFromNamespace.set(property.value.name, { from, imported: property.key.name });
        }
      }
    } else if (declarator.id.type === 'Identifier') {
      moduleConsts.set(declarator.id.name, { statement: node, kind: node.kind, multi: node.declarations.length > 1 });
    }
  }
}

// Per hoisted function: inner deps and module names used.
const usesOf = new Map(names.map((name) => [name, { inner: new Set(), module: new Set(), param: new Set() }]));
const ownerOf = (offset) => names.find((name) => {
  const node = innerFunctions.get(name);
  return node && offset >= node.range[0] && offset < node.range[1];
});
for (const name of names) if (!innerFunctions.has(name)) problems.push(`"${name}" is not an inner function of ${factoryName}`);
for (const scope of scopeManager.scopes) {
  for (const reference of scope.references) {
    const from = ownerOf(reference.identifier.range[0]);
    if (!from || !reference.resolved) continue;
    const variable = reference.resolved;
    if (variable.scope === factoryScope) {
      if (variable.defs[0]?.type === 'Parameter') usesOf.get(from).param.add(variable.name);
      else if (variable.name !== from) usesOf.get(from).inner.add(variable.name);
    } else if (variable.scope === moduleScope) {
      usesOf.get(from).module.add(variable.name);
    }
  }
}
const moduleNeeds = new Set();
for (const [name, uses] of usesOf) {
  if (uses.param.size) problems.push(`"${name}" uses factory parameter(s): ${[...uses.param].join(', ')}`);
  const missing = [...uses.inner].filter((dependency) => !names.includes(dependency));
  if (missing.length) problems.push(`"${name}" uses non-hoisted inner names: ${missing.join(', ')}`);
  for (const moduleName of uses.module) {
    if (importsByLocal.has(moduleName) || destructuredFromNamespace.has(moduleName)) moduleNeeds.add(moduleName);
    else if (moveConsts.includes(moduleName)) moduleNeeds.add(moduleName);
    else problems.push(`"${name}" uses module-level "${moduleName}" which is neither an import, a namespace destructure, nor listed in --move-const`);
  }
}
for (const name of moveConsts) {
  const info = moduleConsts.get(name);
  if (!info) problems.push(`--move-const "${name}" is not a module-level const`);
  else if (info.kind !== 'const' || info.multi) problems.push(`--move-const "${name}" must be a single const declaration`);
}

// Verify namespace destructures are real named exports of their module.
const exportCache = new Map();
const exportsOf = (specifier) => {
  if (!exportCache.has(specifier)) {
    const target = resolve(dirname(file), specifier);
    const targetAst = parse(readFileSync(target, 'utf8'));
    const exported = new Set();
    for (const node of targetAst.body) {
      if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration?.id) exported.add(node.declaration.id.name);
        for (const declarator of node.declaration?.declarations || []) if (declarator.id.type === 'Identifier') exported.add(declarator.id.name);
        for (const specifier of node.specifiers || []) exported.add(specifier.exported.name);
      }
      if (node.type === 'ExportAllDeclaration') exported.add('*unknown*');
    }
    exportCache.set(specifier, exported);
  }
  return exportCache.get(specifier);
};
for (const name of moduleNeeds) {
  const entry = destructuredFromNamespace.get(name);
  if (entry && !exportsOf(entry.from).has(entry.imported) && !exportsOf(entry.from).has('*unknown*')) {
    problems.push(`"${name}" is destructured from ${entry.from} but that module does not export "${entry.imported}"`);
  }
}
if (problems.length) {
  console.error(`REFUSED (${problems.length}):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

// De-indent function text by two spaces, except inside multi-line template literals.
const templateLines = new Set();
const walk = (node) => {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'TemplateLiteral' && node.loc.start.line !== node.loc.end.line) {
    for (let line = node.loc.start.line + 1; line <= node.loc.end.line; line += 1) templateLines.add(line);
  }
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value.type === 'string') walk(value);
  }
};
walk(factory);
// Keep every line's own terminator: some files mix CRLF and LF, and moved code
// must stay byte-identical apart from the removed indent.
const sourceLines = source.match(/[^\n]*\n|[^\n]+$/g);
const functionText = (node) => {
  let out = '';
  for (let line = node.loc.start.line; line <= node.loc.end.line; line += 1) {
    let text = sourceLines[line - 1];
    if (line === node.loc.end.line) text = text.replace(/\r?\n$/, '');
    out += templateLines.has(line) ? text : text.replace(/^ {2}/, '');
  }
  return `export ${out}`;
};
const ordered = names.map((name) => innerFunctions.get(name)).sort((a, b) => a.range[0] - b.range[0]);

// New module.
const rebase = (specifier) => {
  if (!specifier.startsWith('.')) return specifier;
  let next = relative(dirname(modulePath), resolve(dirname(file), specifier)).replace(/\\/g, '/');
  if (!next.startsWith('.')) next = `./${next}`;
  return next;
};
const namedList = (list) => (list.join(', ').length > 70
  ? `{${eol}${list.map((name) => `  ${name},`).join(eol)}${eol}}`
  : `{ ${list.join(', ')} }`);
const importGroups = new Map();
const addImport = (from, local, imported) => {
  if (!importGroups.has(from)) importGroups.set(from, new Map());
  importGroups.get(from).set(local, imported);
};
for (const name of moduleNeeds) {
  if (importsByLocal.has(name)) addImport(importsByLocal.get(name).from, name, importsByLocal.get(name).imported);
  else if (destructuredFromNamespace.has(name)) addImport(destructuredFromNamespace.get(name).from, name, destructuredFromNamespace.get(name).imported);
}
const importLines = [...importGroups].sort(([a], [b]) => a.localeCompare(b)).map(([from, entries]) => {
  const named = [...entries].filter(([, imported]) => imported !== '*' && imported !== 'default').map(([local, imported]) => (local === imported ? local : `${imported} as ${local}`)).sort();
  const others = [...entries].filter(([, imported]) => imported === '*' || imported === 'default').map(([local, imported]) => (imported === '*' ? `* as ${local}` : local));
  return `import ${[...others, ...(named.length ? [namedList(named)] : [])].join(', ')} from "${rebase(from)}";`;
});
const constTexts = moveConsts.map((name) => `export ${source.slice(...moduleConsts.get(name).statement.range)}`);
const moduleText = [...importLines, '', ...constTexts.flatMap((text) => [text, '']), ordered.map(functionText).join(`${eol}${eol}`), ''].join(eol);

// Original file: remove hoisted functions (and the blank line after each) and moved consts; import them back.
let next = source;
const removals = [
  ...ordered.map((node) => [node.range[0] - (source.slice(0, node.range[0]).match(/[ \t]*$/)[0].length), node.range[1]]),
  ...moveConsts.map((name) => moduleConsts.get(name).statement.range),
].sort((a, b) => b[0] - a[0]);
for (const [start, end] of removals) {
  let stop = end;
  if (next.slice(stop, stop + eol.length) === eol) stop += eol.length;
  if (next.slice(stop, stop + eol.length) === eol) stop += eol.length;
  next = next.slice(0, start) + next.slice(stop);
}
const specifier = rebase(`./${relative(dirname(file), modulePath).replace(/\\/g, '/')}`) .replace(/^\.\/\.\//, './');
const importBack = [...moveConsts, ...names].filter((name) => {
  // still referenced anywhere in the remaining original code?
  const pattern = new RegExp(`\\b${name}\\b`, 'u');
  return pattern.test(next);
});
const lastImport = ast.body.filter((node) => node.type === 'ImportDeclaration').pop();
const insertAt = next.indexOf(source.slice(...lastImport.range)) + (lastImport.range[1] - lastImport.range[0]);
if (importBack.length) next = `${next.slice(0, insertAt)}${eol}import ${namedList(importBack)} from "./${relative(dirname(file), modulePath).replace(/\\/g, '/')}";${next.slice(insertAt)}`;

console.log(JSON.stringify({
  module: relative(process.cwd(), modulePath),
  hoisted: names.length,
  movedConsts: moveConsts,
  lines: ordered.reduce((sum, node) => sum + node.loc.end.line - node.loc.start.line + 1, 0),
  importsIntoNewModule: [...importGroups.keys()],
  importedBack: importBack.length,
  templateLinesKeptVerbatim: [...templateLines].filter((line) => ordered.some((node) => line >= node.loc.start.line && line <= node.loc.end.line)).length,
}, null, 2));
void specifier;
if (!dryRun) {
  writeFileSync(modulePath, moduleText);
  writeFileSync(file, next);
}
