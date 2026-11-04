// Removes bare `import './x.js';` lines that remove-unused-imports left behind for
// load-order safety, when the bare-imported module is still loaded through one of the
// given split-out modules (which the file imports) AND has no top-level expression
// statements (so evaluating it slightly later cannot change behaviour).
// Usage: node tools/refactor/drop-covered-bare-imports.mjs <file> <splitModule> [...] [--dry-run]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(resolve(import.meta.dirname, '../../frontend/package.json'));
const espree = require('espree');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [file, ...splitModules] = args.filter((arg) => arg !== '--dry-run');

const parse = (path) => espree.parse(readFileSync(path, 'utf8'), {
  ecmaVersion: 'latest', sourceType: 'module', range: true, ecmaFeatures: { jsx: true },
});
const resolveSpecifier = (from, specifier) => {
  if (!specifier.startsWith('.')) return specifier;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.jsx`, `${base}.mjs`]) if (existsSync(candidate) && !candidate.endsWith('/')) {
    try { readFileSync(candidate); return candidate; } catch { /* directory */ }
  }
  return base;
};
const covered = new Set();
for (const module of splitModules) {
  for (const node of parse(module).body) {
    if (node.type === 'ImportDeclaration') covered.add(resolveSpecifier(module, node.source.value));
  }
}
const hasTopLevelEffects = (path) => {
  if (path.startsWith('node:')) return false; // Node built-ins have no import-time effects
  if (!path.includes('/') && !path.includes('\\')) return true; // other packages: unknown
  return parse(path).body.some((node) => node.type === 'ExpressionStatement' && !node.directive);
};

const source = readFileSync(file, 'utf8');
const removed = [];
const kept = [];
let next = source;
for (const node of [...parse(file).body].reverse()) {
  if (node.type !== 'ImportDeclaration' || node.specifiers.length) continue;
  const target = resolveSpecifier(file, node.source.value);
  if (!covered.has(target) || hasTopLevelEffects(target)) { kept.push(node.source.value); continue; }
  let end = node.range[1];
  end += (next.slice(end).match(/^\r?\n/) || [''])[0].length;
  next = next.slice(0, node.range[0]) + next.slice(end);
  removed.push(node.source.value);
}
console.log(JSON.stringify({ removed: removed.reverse(), keptBare: kept.reverse() }, null, 2));
if (!dryRun) writeFileSync(file, next);
