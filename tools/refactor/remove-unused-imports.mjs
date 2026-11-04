// Removes import specifiers that nothing reads. A declaration that would become
// empty is kept as a bare `import "x";` so module load order/side effects stay identical.
// Usage: node tools/refactor/remove-unused-imports.mjs <file> [--dry-run]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { SCOPE_OPTIONS, parseSource } from './parse-source.mjs';

const require = createRequire(resolve(import.meta.dirname, '../../frontend/package.json'));
const eslintScope = require('eslint-scope');
const [file, flag] = process.argv.slice(2);
const source = readFileSync(file, 'utf8');
const ast = parseSource(source, file, { loc: true, range: true });
const scopeManager = eslintScope.analyze(ast, SCOPE_OPTIONS);
const moduleScope = scopeManager.scopes.find((scope) => scope.type === 'module');
const unused = new Set(moduleScope.variables
  .filter((variable) => variable.defs[0]?.type === 'ImportBinding' && !variable.references.some((ref) => ref.isRead()))
  .map((variable) => variable.defs[0].node));

const edits = [];
const removed = [];
const keptAsBare = [];
for (const declaration of ast.body.filter((node) => node.type === 'ImportDeclaration')) {
  const drop = declaration.specifiers.filter((specifier) => unused.has(specifier));
  if (!drop.length) continue;
  removed.push(...drop.map((specifier) => specifier.local.name));
  const keep = declaration.specifiers.filter((specifier) => !unused.has(specifier));
  const quote = source[declaration.source.range[0]];
  const from = `${quote}${declaration.source.value}${quote}`;
  let replacement;
  if (!keep.length) {
    replacement = `import ${from};`;
    keptAsBare.push(declaration.source.value);
  } else {
    const defaults = keep.filter((s) => s.type === 'ImportDefaultSpecifier').map((s) => s.local.name);
    const namespaces = keep.filter((s) => s.type === 'ImportNamespaceSpecifier').map((s) => `* as ${s.local.name}`);
    const named = keep.filter((s) => s.type === 'ImportSpecifier')
      .map((s) => (s.imported.name === s.local.name ? s.local.name : `${s.imported.name} as ${s.local.name}`));
    const multiline = source.slice(...declaration.range).includes('\n') && named.length > 1;
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const namedText = named.length
      ? (multiline ? `{${eol}${named.map((name) => `  ${name},`).join(eol)}${eol}}` : `{ ${named.join(', ')} }`)
      : '';
    replacement = `import ${[...defaults, ...namespaces, namedText].filter(Boolean).join(', ')} from ${from};`;
  }
  edits.push([declaration.range[0], declaration.range[1], replacement]);
}
let next = source;
for (const [startOffset, endOffset, text] of edits.sort((a, b) => b[0] - a[0])) {
  next = next.slice(0, startOffset) + text + next.slice(endOffset);
}
console.log(JSON.stringify({ removed, keptAsBareImport: keptAsBare }, null, 2));
if (flag !== '--dry-run') writeFileSync(file, next);
