// Refactor tool: moves pure top-level declarations (functions / classes / consts) from a
// module into a new sibling module, verbatim, and imports them back.
//
// Refuses (exit 1) when:
//   - a name is stateful (its dependency closure reaches module-level mutable state,
//     see module-graph.mjs), or is not a top-level function/const declaration;
//   - a moved declaration depends on a top-level name of the original file that is
//     not moved too (that would need an import back = cycle); the missing names are listed;
//   - a moved declaration shares a multi-declarator `const a = 1, b = 2;` statement.
// The original module keeps its public API: moved names that were exported are re-exported.
//
// Usage: node tools/refactor/move-declarations.mjs --file <src> --module <new file>
//          --names a,b,c [--state extraStateName,...] [--immutable lookupSet,...] [--allow-state] [--append] [--dry-run]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, relative, resolve } from 'node:path';
import { assertImmutable } from './immutable-containers.mjs';
import { SCOPE_OPTIONS, parseSource } from './parse-source.mjs';

const require = createRequire(resolve(import.meta.dirname, '../../frontend/package.json'));
const eslintScope = require('eslint-scope');

const argv = process.argv.slice(2);
const option = (key) => (argv.includes(key) ? argv[argv.indexOf(key) + 1] : undefined);
const file = resolve(option('--file'));
const modulePath = resolve(option('--module'));
const names = (option('--names') || '').split(',').map((name) => name.trim()).filter(Boolean);
const extraState = (option('--state') || '').split(',').filter(Boolean);
const immutable = (option('--immutable') || '').split(',').filter(Boolean);
const dryRun = argv.includes('--dry-run');
// --allow-state: move a whole stateful cluster. Every state root that moves must take
// all of its direct users along, so the state keeps a single owner module and no
// remaining code needs (read-only) imported access to a moved `let` binding.
const allowState = argv.includes('--allow-state');
if (!names.length) throw new Error('missing --names');
// --append: add the declarations to the end of an existing module instead of creating one.
// Refused when that module imports the original file (cycle) or already binds a moved
// name / a needed import name differently.
const append = argv.includes('--append');
if (existsSync(modulePath) && !append) throw new Error(`module already exists: ${modulePath}`);
if (append && !existsSync(modulePath)) throw new Error(`--append target does not exist: ${modulePath}`);

const source = readFileSync(file, 'utf8');
assertImmutable(source, immutable);
// New lines follow the first line's terminator; existing lines keep their own (some files mix CRLF/LF).
const eol = /^[^\n]*\r\n/.test(source) ? '\r\n' : '\n';
const ast = parseSource(source, file, { loc: true, range: true, comment: true });
const scopeManager = eslintScope.analyze(ast, SCOPE_OPTIONS);
const moduleScope = scopeManager.scopes.find((scope) => scope.type === 'module');
const problems = [];

// Top-level declarations with their statements.
const decls = new Map();
for (const statement of ast.body) {
  const exported = statement.type === 'ExportNamedDeclaration' && statement.declaration;
  const node = exported ? statement.declaration : statement;
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
    decls.set(node.id.name, { statement, exported: Boolean(exported), stateRoot: false, multi: false });
  } else if (node.type === 'VariableDeclaration') {
    for (const declarator of node.declarations) {
      if (declarator.id.type !== 'Identifier') continue;
      const init = declarator.init;
      const container = init?.type === 'NewExpression' && /^(Map|Set|WeakMap|WeakSet|AsyncLocalStorage)$/.test(init.callee?.name || '');
      decls.set(declarator.id.name, {
        statement,
        exported: Boolean(exported),
        stateRoot: node.kind === 'let' || node.kind === 'var' || (container && !immutable.includes(declarator.id.name)) || extraState.includes(declarator.id.name),
        multi: node.declarations.length > 1,
      });
    }
  }
}
const imports = new Map(); // local -> { from, imported }
for (const statement of ast.body.filter((node) => node.type === 'ImportDeclaration')) {
  for (const specifier of statement.specifiers) {
    imports.set(specifier.local.name, {
      from: statement.source.value,
      imported: specifier.type === 'ImportDefaultSpecifier' ? 'default'
        : specifier.type === 'ImportNamespaceSpecifier' ? '*' : specifier.imported.name,
    });
  }
}
// Names re-exported via `export { a, b }` lists also form the public API.
const exportedLater = new Set(ast.body
  .filter((node) => node.type === 'ExportNamedDeclaration' && !node.declaration && !node.source)
  .flatMap((node) => node.specifiers.map((specifier) => specifier.local.name)));

// Dependency edges among top-level names.
const owner = (offset) => {
  for (const [name, info] of decls) if (offset >= info.statement.range[0] && offset < info.statement.range[1]) return name;
  return null;
};
const deps = new Map([...decls.keys()].map((name) => [name, new Set()]));
const importUses = new Map([...decls.keys()].map((name) => [name, new Set()]));
for (const scope of scopeManager.scopes) {
  for (const reference of scope.references) {
    const variable = reference.resolved;
    if (!variable || variable.scope !== moduleScope) continue;
    const from = owner(reference.identifier.range[0]);
    if (!from) continue;
    if (decls.has(variable.name) && variable.name !== from) deps.get(from).add(variable.name);
    if (imports.has(variable.name)) importUses.get(from).add(variable.name);
  }
}
const stateful = new Set([...decls].filter(([, info]) => info.stateRoot).map(([name]) => name));
for (let changed = true; changed;) {
  changed = false;
  for (const [name, set] of deps) {
    if (!stateful.has(name) && [...set].some((dependency) => stateful.has(dependency))) {
      stateful.add(name);
      changed = true;
    }
  }
}

const moving = new Set(names);
for (const name of names) {
  if (!decls.has(name)) { problems.push(`"${name}" is not a top-level function/const`); continue; }
  if (stateful.has(name) && !allowState) problems.push(`"${name}" is stateful (reaches module-level mutable state)`);
  if (allowState && decls.get(name)?.stateRoot) {
    const users = [...deps].filter(([user, set]) => set.has(name) && !moving.has(user)).map(([user]) => user);
    if (users.length) problems.push(`state "${name}" is used by non-moved: ${users.join(', ')}`);
  }
  if (decls.get(name).multi) problems.push(`"${name}" shares a multi-declarator statement`);
  const missing = [...deps.get(name)].filter((dependency) => !moving.has(dependency));
  if (missing.length) problems.push(`"${name}" needs non-moved top-level names: ${missing.join(', ')}`);
}
if (problems.length) {
  console.error(`REFUSED (${problems.length}):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

// Statement text including the directly attached leading comments.
const leadingStart = (statement) => {
  let start = statement.range[0];
  const comments = ast.comments.filter((comment) => comment.range[1] <= start).sort((a, b) => b.range[1] - a.range[1]);
  for (const comment of comments) {
    const between = source.slice(comment.range[1], start);
    if (!/^[ \t]*\r?\n[ \t]*$/.test(between) && between !== '') break; // must be directly above (no blank line)
    start = comment.range[0];
  }
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  return /^[ \t]*$/.test(source.slice(lineStart, start)) ? lineStart : start;
};
const statements = [...new Set(names.map((name) => decls.get(name).statement))].sort((a, b) => a.range[0] - b.range[0]);
const pieces = statements.map((statement) => {
  const start = leadingStart(statement);
  let text = source.slice(start, statement.range[1]);
  // Inside the new module every moved name is exported; keep the declaration text otherwise intact.
  if (!text.includes('export ') || !/^(?:\s*\/\/.*\r?\n|\s*\/\*[\s\S]*?\*\/\s*)*export\s/.test(text)) {
    const declStart = statement.range[0] - start;
    text = `${text.slice(0, declStart)}export ${text.slice(declStart)}`;
  }
  // Carry the statement's own line terminator (files may mix CRLF and LF).
  const terminator = (source.slice(statement.range[1]).match(/^\r?\n/) || [eol])[0];
  return { start, end: statement.range[1], text, terminator };
});

// Imports the moved code needs, rebased to the new module location.
const rebase = (specifier) => {
  if (!specifier.startsWith('.')) return specifier;
  let next = relative(dirname(modulePath), resolve(dirname(file), specifier)).replace(/\\/g, '/');
  if (!next.startsWith('.')) next = `./${next}`;
  return next;
};
const neededImports = new Map();
for (const name of names) {
  for (const local of importUses.get(name)) {
    const { from, imported } = imports.get(local);
    if (!neededImports.has(from)) neededImports.set(from, new Map());
    neededImports.get(from).set(local, imported);
  }
}
// Long specifier lists are written one per line, matching the codebase's import style.
function namedList(list) {
  return list.join(', ').length > 70
    ? `{${eol}${list.map((name) => `  ${name},`).join(eol)}${eol}}`
    : `{ ${list.join(', ')} }`;
}
const importText = (from, entries) => {
  const defaults = [...entries].filter(([, imported]) => imported === 'default').map(([local]) => local);
  const namespaces = [...entries].filter(([, imported]) => imported === '*').map(([local]) => `* as ${local}`);
  const named = [...entries].filter(([, imported]) => imported !== 'default' && imported !== '*')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([local, imported]) => (local === imported ? local : `${imported} as ${local}`));
  const parts = [...defaults, ...namespaces];
  if (named.length) parts.push(namedList(named));
  return `import ${parts.join(', ')} from "${from}";`;
};
const moduleImports = [...neededImports].sort(([a], [b]) => a.localeCompare(b)).map(([from, entries]) => importText(rebase(from), entries));
let moduleText;
if (append) {
  const target = readFileSync(modulePath, 'utf8');
  const targetEol = /^[^\n]*\r\n/.test(target) ? '\r\n' : '\n';
  const targetAst = parseSource(target, modulePath, { range: true });
  const targetScope = eslintScope.analyze(targetAst, SCOPE_OPTIONS).scopes.find((scope) => scope.type === 'module');
  const bound = new Map(); // local name -> resolved source of its import ('' for local declarations)
  for (const variable of targetScope.variables) {
    const definition = variable.defs[0];
    if (!definition) continue;
    bound.set(variable.name, definition.type === 'ImportBinding'
      ? resolve(dirname(modulePath), definition.parent.source.value) : '');
  }
  for (const node of targetAst.body.filter((item) => item.type === 'ImportDeclaration')) {
    if (node.source.value.startsWith('.') && resolve(dirname(modulePath), node.source.value).replace(/\.[jt]sx?$/, '') === file.replace(/\.[jt]sx?$/, '')) {
      problems.push(`--append target imports ${relative(process.cwd(), file)} (would form a cycle)`);
    }
  }
  for (const name of names) if (bound.has(name)) problems.push(`--append target already declares "${name}"`);
  const missingImports = [];
  for (const [from, entries] of [...neededImports].sort(([a], [b]) => a.localeCompare(b))) {
    const rebased = rebase(from);
    const absolute = rebased.startsWith('.') ? resolve(dirname(modulePath), rebased) : rebased;
    const needed = new Map();
    for (const [local, imported] of entries) {
      if (!bound.has(local)) { needed.set(local, imported); continue; }
      const existing = bound.get(local);
      if (existing.replace(/\.[jt]sx?$/, '') !== absolute.replace(/\.[jt]sx?$/, '')) problems.push(`--append target binds "${local}" from elsewhere`);
    }
    if (needed.size) missingImports.push(importText(rebased, needed));
  }
  if (problems.length) {
    console.error(`REFUSED (${problems.length}):\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  const lastImport = [...targetAst.body].filter((node) => node.type === 'ImportDeclaration').pop();
  let merged = target;
  if (missingImports.length) {
    const at = lastImport ? lastImport.range[1] : 0;
    merged = `${merged.slice(0, at)}${lastImport ? targetEol : ''}${missingImports.join(targetEol)}${lastImport ? '' : targetEol}${merged.slice(at)}`;
  }
  const body = pieces.map((piece) => piece.text.replace(/\r?\n/g, targetEol)).join(`${targetEol}${targetEol}`);
  moduleText = `${merged.replace(/\s*$/, '')}${targetEol}${targetEol}${body}${targetEol}`;
} else {
  moduleText = [
    ...moduleImports.map((line) => `${line}${eol}`),
    ...(moduleImports.length ? [eol] : []),
    pieces.map((piece) => `${piece.text}${piece.terminator}`).join(eol),
  ].join('');
}

// Original file: drop moved statements, import back what remaining code uses, keep public API.
const stillUsed = new Set();
for (const scope of scopeManager.scopes) {
  for (const reference of scope.references) {
    if (!reference.resolved || reference.resolved.scope !== moduleScope || !moving.has(reference.resolved.name)) continue;
    const from = owner(reference.identifier.range[0]);
    if (!from || !moving.has(from)) stillUsed.add(reference.resolved.name);
  }
}
const reexport = names.filter((name) => decls.get(name).exported || exportedLater.has(name));
const specifier = `./${relative(dirname(file), modulePath).replace(/\\/g, '/')}`.replace(/^\.\/\.\//, './').replace(/^\.\/\.\.\//, '../');
let next = source;
for (const piece of [...pieces].sort((a, b) => b.start - a.start)) {
  // Remove the statement plus its actual line break (CRLF or LF).
  let end = piece.end;
  end += (next.slice(end).match(/^\r?\n/) || [''])[0].length;
  const start = piece.start;
  // Collapse a now-doubled blank line: previous line blank and next line blank.
  const before = next.slice(0, start);
  const following = next.slice(end).match(/^\r?\n/);
  if (following && /\r?\n\r?\n$/.test(before)) end += following[0].length;
  next = next.slice(0, start) + next.slice(end);
}
const importNames = [...new Set([...stillUsed])].filter((name) => !decls.get(name).exported).sort();
const exportNames = reexport.sort();
const headerLines = [];
if (importNames.length) headerLines.push(`import ${namedList(importNames)} from "${specifier}";`);
if (exportNames.length) headerLines.push(`export ${namedList(exportNames)} from "${specifier}";`);
// Exported names that are also used locally need a local binding as well.
const exportedAndUsed = exportNames.filter((name) => stillUsed.has(name));
if (exportedAndUsed.length) headerLines.push(`import ${namedList(exportedAndUsed)} from "${specifier}";`);
const lastImport = [...ast.body].filter((node) => node.type === 'ImportDeclaration').pop();
if (headerLines.length) {
  const insertAt = lastImport ? next.indexOf(source.slice(...lastImport.range)) + (lastImport.range[1] - lastImport.range[0]) : 0;
  next = `${next.slice(0, insertAt)}${eol}${headerLines.join(eol)}${next.slice(insertAt)}`;
}

const report = {
  module: relative(process.cwd(), modulePath),
  moved: names.length,
  movedLines: pieces.reduce((sum, piece) => sum + source.slice(piece.start, piece.end).split(/\r?\n/).length, 0),
  importsIntoNewModule: [...neededImports.keys()],
  importedBack: importNames,
  reExported: exportNames,
};
console.log(JSON.stringify(report, null, 2));
if (!dryRun) {
  writeFileSync(modulePath, moduleText);
  writeFileSync(file, next);
}
void basename;
