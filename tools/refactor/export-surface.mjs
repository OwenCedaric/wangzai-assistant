// Compares a module's public exports before (static parse of an old copy) and
// after (dynamic import of the current file). Exit 1 if any export disappeared,
// appeared, or now resolves to undefined.
// Usage: node tools/refactor/export-surface.mjs <old-copy.js> <current-module.js>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSource } from './parse-source.mjs';

const require = createRequire(resolve(import.meta.dirname, '../../frontend/package.json'));
const [oldCopy, current] = process.argv.slice(2);
const staticExports = (file) => {
  const names = new Set();
  for (const node of parseSource(readFileSync(file, 'utf8'), file).body) {
    if (node.type !== 'ExportNamedDeclaration') continue;
    if (node.declaration?.id) names.add(node.declaration.id.name);
    for (const declarator of node.declaration?.declarations || []) names.add(declarator.id.name);
    for (const specifier of node.specifiers || []) names.add(specifier.exported.name);
  }
  return names;
};
const before = staticExports(oldCopy);
// Node cannot import .jsx (or Vite-style extensionless specifiers): compare the static
// export lists (including re-exports) instead.
const compareStatic = (reason) => {
  const after = staticExports(current);
  const missing = [...before].filter((name) => !after.has(name));
  const added = [...after].filter((name) => !before.has(name));
  console.log(JSON.stringify({ static: reason, before: before.size, after: after.size, missing, added }));
  process.exit(missing.length || added.length ? 1 : 0);
};
if (/\.jsx$/i.test(current)) compareStatic('jsx');
let loaded;
try {
  loaded = await import(pathToFileURL(resolve(current)).href);
} catch (error) {
  compareStatic(`dynamic import failed: ${error.code || error.message}`);
}
const after = new Set(Object.keys(loaded));
const missing = [...before].filter((name) => !after.has(name));
const added = [...after].filter((name) => !before.has(name));
const undefinedExports = [...after].filter((name) => loaded[name] === undefined);
console.log(JSON.stringify({ before: before.size, after: after.size, missing, added, undefinedExports }));
process.exit(missing.length || added.length || undefinedExports.length ? 1 : 0);
