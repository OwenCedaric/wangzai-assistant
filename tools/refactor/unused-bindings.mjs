// Lists imports and createApp-level variables that nothing references any more.
// Usage: node tools/refactor/unused-bindings.mjs <file>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { SCOPE_OPTIONS, parseSource } from './parse-source.mjs';

const require = createRequire(resolve(import.meta.dirname, '../../frontend/package.json'));
const eslintScope = require('eslint-scope');
const source = readFileSync(process.argv[2], 'utf8');
const ast = parseSource(source, process.argv[2], { loc: true, range: true });
const scopeManager = eslintScope.analyze(ast, SCOPE_OPTIONS);
for (const scope of scopeManager.scopes) {
  if (!['module', 'function'].includes(scope.type) || (scope.type === 'function' && scope.upper?.type !== 'module')) continue;
  for (const variable of scope.variables) {
    const definition = variable.defs[0];
    if (!definition || definition.type === 'Parameter' || variable.name === 'arguments') continue;
    if (scope.type === 'module' && definition.type !== 'ImportBinding') continue;
    const reads = variable.references.filter((reference) => reference.isRead());
    if (!reads.length) console.log(`${definition.name.loc.start.line}\t${definition.type}\t${variable.name}`);
  }
}
