// Refactor tool: moves a contiguous block of route `if` statements out of the
// createApp request handler into its own route module, without changing the
// moved code. Route order is preserved because the block is replaced in place
// by a single `if (handleX(...)) return;` call.
//
// Safety: refuses (exit 1) when a dependency is declared after the factory
// insertion point, is reassigned outside the block, when the block writes to
// an outer variable that is not listed with --state, or when a handler-level
// `return` carries a value.
//
// Usage:
//   node tools/refactor/extract-route-block.mjs --file <createApp.js> --start N --end N
//     --handler-line N --insert-after N --module <new file> --factory createXRoute
//     [--state name=initialDependencyName] [--dry-run]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, relative, resolve } from 'node:path';
import { SCOPE_OPTIONS } from './parse-source.mjs';

const require = createRequire(resolve(import.meta.dirname, '../../frontend/package.json'));
const espree = require('espree');
const eslintScope = require('eslint-scope');

function parseArgs(argv) {
  const args = { state: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--dry-run') { args.dryRun = true; continue; }
    const value = argv[index + 1];
    index += 1;
    if (key === '--state') args.state.push(value);
    else args[key.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
for (const key of ['file', 'start', 'end', 'handlerLine', 'insertAfter', 'module', 'factory']) {
  if (!args[key]) throw new Error(`missing --${key}`);
}
const file = resolve(args.file);
const modulePath = resolve(args.module);
const start = Number(args.start);
const end = Number(args.end);
const handlerLine = Number(args.handlerLine);
const insertAfter = Number(args.insertAfter);
const handlerName = args.factory.replace(/^create/, 'handle');
if (existsSync(modulePath)) throw new Error(`module already exists: ${modulePath}`);

const source = readFileSync(file, 'utf8');
// New lines follow the first line's terminator; existing lines keep their own (some files mix CRLF/LF).
const eol = /^[^\n]*\r\n/.test(source) ? '\r\n' : '\n';
// This tool re-joins the whole file with one terminator, so mixed files would be rewritten.
const crlfCount = (source.match(/\r\n/g) || []).length;
if (crlfCount && crlfCount !== (source.match(/\n/g) || []).length) {
  throw new Error('file mixes CRLF and LF line endings; extract-route-block would normalize them');
}
const lines = source.split(/\r?\n/);
const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true });
const scopeManager = eslintScope.analyze(ast, SCOPE_OPTIONS);
const inRange = (node) => node.loc.start.line >= start && node.loc.end.line <= end;
const problems = [];

// Block boundaries must be whole top-level statements of the handler.
if (!/^\s*if \(/.test(lines[start - 1])) problems.push(`line ${start} does not start an if statement`);
if (!/^    \}$/.test(lines[end - 1])) problems.push(`line ${end} is not a handler-level closing brace`);

// 1. Classify every outside binding the block references.
const stateMap = new Map(args.state.map((entry) => entry.split('=')));
const imports = new Map(); // source -> Map(local -> imported|default|namespace)
const deps = new Map(); // name -> variable
const perRequest = new Set();
for (const scope of scopeManager.scopes) {
  for (const reference of scope.references) {
    if (!inRange(reference.identifier)) continue;
    const variable = reference.resolved;
    if (!variable) continue; // global
    const definition = variable.defs[0];
    if (!definition || inRange(definition.name)) continue;
    const name = reference.identifier.name;
    if (reference.isWrite() && !stateMap.has(name)) {
      problems.push(`block writes outer variable "${name}" (declared line ${definition.name.loc.start.line}); pass --state`);
    }
    if (definition.type === 'ImportBinding') {
      const declaration = definition.parent;
      const specifier = definition.node;
      const imported = specifier.type === 'ImportDefaultSpecifier'
        ? 'default'
        : specifier.type === 'ImportNamespaceSpecifier'
          ? '*'
          : specifier.imported.name;
      if (!imports.has(declaration.source.value)) imports.set(declaration.source.value, new Map());
      imports.get(declaration.source.value).set(name, imported);
      continue;
    }
    if (definition.name.loc.start.line >= handlerLine) perRequest.add(name);
    else if (!stateMap.has(name)) deps.set(name, variable);
  }
}

// 2. Dependencies must exist before the factory runs and never be reassigned later.
for (const [name, variable] of deps) {
  const declaredAt = variable.defs[0].name.loc.start.line;
  if (declaredAt > insertAfter) problems.push(`dependency "${name}" is declared at line ${declaredAt}, after --insert-after ${insertAfter}`);
  // A write is safe only when it runs once, directly in the declaring scope, before the factory.
  const outsideWrites = variable.references.filter((reference) => (
    reference.isWrite() && !reference.init && !inRange(reference.identifier)
    && !(reference.from === variable.scope && reference.identifier.loc.start.line < insertAfter)
  ));
  if (outsideWrites.length) {
    problems.push(`dependency "${name}" is reassigned at line(s) ${outsideWrites.map((r) => r.identifier.loc.start.line).join(', ')}`);
  }
}
for (const [name] of stateMap) {
  const variable = scopeManager.scopes.flatMap((scope) => scope.variables).find((candidate) => candidate.name === name);
  const usedOutside = variable?.references.some((reference) => !inRange(reference.identifier) && !reference.init);
  if (usedOutside) problems.push(`state "${name}" is also used outside the block; it cannot move`);
}

// 3. Handler-level returns (not inside nested callbacks) become `return true;`.
const returnEdits = [];
const visit = (node, depth) => {
  if (!node || typeof node.type !== 'string') return;
  let nextDepth = depth;
  if (/Function/.test(node.type) && node.loc.start.line !== handlerLine && inRange(node)) nextDepth += 1;
  if (inRange(node) && depth === 0 && node.type === 'ReturnStatement') {
    if (node.argument) problems.push(`handler-level return with a value at line ${node.loc.start.line}`);
    else returnEdits.push(node.range);
  }
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => visit(child, nextDepth));
    else if (value && typeof value.type === 'string') visit(value, nextDepth);
  }
};
visit(ast, 0);

if (problems.length) {
  console.error(`REFUSED (${problems.length}):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

// 4. Build the module body from the exact original text.
const lineStartOffset = (line) => {
  let offset = 0;
  for (let index = 0; index < line - 1; index += 1) offset += lines[index].length + (source.slice(offset + lines[index].length, offset + lines[index].length + 2) === '\r\n' ? 2 : 1);
  return offset;
};
const blockStart = lineStartOffset(start);
const blockEnd = lineStartOffset(end) + lines[end - 1].length;
let block = source.slice(blockStart, blockEnd);
for (const [from, to] of [...returnEdits].sort((a, b) => b[0] - a[0])) {
  const text = block.slice(from - blockStart, to - blockStart);
  if (text !== 'return;') throw new Error(`unexpected return text at ${from}: ${text}`);
  block = `${block.slice(0, from - blockStart)}return true;${block.slice(to - blockStart)}`;
}

const moduleDir = dirname(modulePath);
const fileDir = dirname(file);
const rebaseImport = (specifier) => {
  if (!specifier.startsWith('.')) return specifier;
  let rebased = relative(moduleDir, resolve(fileDir, specifier)).replace(/\\/g, '/');
  if (!rebased.startsWith('.')) rebased = `./${rebased}`;
  return rebased;
};
const importLines = [...imports].sort(([a], [b]) => a.localeCompare(b)).map(([from, names]) => {
  const target = rebaseImport(from);
  const defaults = [...names].filter(([, imported]) => imported === 'default').map(([local]) => local);
  const namespaces = [...names].filter(([, imported]) => imported === '*').map(([local]) => local);
  const named = [...names].filter(([, imported]) => imported !== 'default' && imported !== '*')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([local, imported]) => (local === imported ? local : `${imported} as ${local}`));
  const parts = [...defaults, ...namespaces.map((local) => `* as ${local}`)];
  if (named.length) parts.push(`{ ${named.join(', ')} }`);
  return `import ${parts.join(', ')} from "${target}";`;
});

const depNames = [...deps.keys()].sort();
const stateDeps = [...stateMap.values()].sort();
const requestNames = [...perRequest].sort();
const factoryParams = [...new Set([...depNames, ...stateDeps])].sort();
const moduleText = [
  ...importLines,
  '',
  `export function ${args.factory}({`,
  ...factoryParams.map((name) => `  ${name},`),
  '}) {',
  ...[...stateMap].map(([name, initial]) => `  let ${name} = ${initial};`),
  `  return function ${handlerName}({ ${requestNames.join(', ')} }) {`,
  block,
  '    return false;',
  '  };',
  '}',
  '',
].join(eol);

// 5. Rewrite the source: call in place of the block, factory after insertAfter.
const callText = `    if (${handlerName}({ ${requestNames.join(', ')} })) return;`;
const factoryText = [
  `  const ${handlerName} = ${args.factory}({`,
  ...factoryParams.map((name) => `    ${name},`),
  '  });',
].join(eol);
const nextLines = [...lines];
nextLines.splice(start - 1, end - start + 1, callText);
nextLines.splice(insertAfter, 0, factoryText);
const importSpecifier = `./${basename(modulePath).replace(/\\/g, '/')}`;
const lastImport = nextLines.findLastIndex((line) => /^import .* from ".*";$/.test(line) || /^\} from ".*";$/.test(line));
nextLines.splice(lastImport + 1, 0, `import { ${args.factory} } from "${relative(fileDir, modulePath).startsWith('.') ? relative(fileDir, modulePath).replace(/\\/g, '/') : importSpecifier}";`);
const nextSource = nextLines.join(eol);

const report = {
  moved: { from: start, to: end, lines: end - start + 1 },
  module: relative(process.cwd(), modulePath),
  dependencies: depNames,
  state: Object.fromEntries(stateMap),
  perRequest: requestNames,
  imports: [...imports.keys()],
  returnsRewritten: returnEdits.length,
};
if (args.dryRun) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
writeFileSync(modulePath, moduleText);
writeFileSync(file, nextSource);
console.log(JSON.stringify(report, null, 2));
