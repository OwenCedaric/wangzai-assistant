// Audit: lists identifiers a module uses without declaring or importing them
// (excluding standard JS / Node / browser globals). A moved declaration that
// referenced a module-level name the move tools did not track would show up
// here as a free name and fail at runtime with ReferenceError.
// Usage: node tools/refactor/free-names.mjs <file> [<file> ...]   (exit 1 if any)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { SCOPE_OPTIONS, parseSource } from './parse-source.mjs';

const require = createRequire(resolve(import.meta.dirname, '../../frontend/package.json'));
const eslintScope = require('eslint-scope');
const globals = require('globals');
const known = new Set([
  ...Object.keys(globals.builtin),
  ...Object.keys(globals.node),
  ...Object.keys(globals.browser),
  ...Object.keys(globals.es2021 || {}),
]);

let found = 0;
for (const file of process.argv.slice(2)) {
  const ast = parseSource(readFileSync(file, 'utf8'), file, { loc: true, range: true });
  const scopeManager = eslintScope.analyze(ast, SCOPE_OPTIONS);
  const globalScope = scopeManager.globalScope;
  const free = new Map();
  for (const reference of globalScope.through) {
    const name = reference.identifier.name;
    if (known.has(name)) continue;
    if (!free.has(name)) free.set(name, reference.identifier.loc.start.line);
  }
  if (free.size) {
    found += free.size;
    console.log(`${file}: ${[...free].map(([name, line]) => `${name}@${line}`).join(', ')}`);
  }
}
console.log(found ? `FREE NAMES: ${found}` : 'no free names');
process.exit(found ? 1 : 0);
