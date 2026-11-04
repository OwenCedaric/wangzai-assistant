// Lists which top-level declarations of a module contain text that source-reading
// guard tests assert on (regex literals in assert.match/doesNotMatch, expect().toMatch,
// and string literals in toContain/includes/indexOf). Moving such a declaration to
// another file would break (or silently weaken) the guard, so keep them in place.
// Usage: node tools/refactor/guarded-declarations.mjs <module> <guardTest> [...]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(resolve(import.meta.dirname, '../../frontend/package.json'));
const espree = require('espree');
const [file, ...tests] = process.argv.slice(2);
const parse = (text) => espree.parse(text, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true, ecmaFeatures: { jsx: true } });

const patterns = [];
const visit = (node, inGuardCall) => {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'Literal' && inGuardCall) {
    if (node.regex) patterns.push({ kind: 'regex', value: new RegExp(node.regex.pattern, node.regex.flags.replace('g', '')) });
    else if (typeof node.value === 'string' && node.value.length >= 8) patterns.push({ kind: 'text', value: node.value });
  }
  if (node.type === 'TemplateLiteral' && inGuardCall && node.expressions.length === 0) {
    const value = node.quasis[0].value.cooked;
    if (value.length >= 8) patterns.push({ kind: 'text', value });
  }
  let guard = inGuardCall;
  if (node.type === 'CallExpression') {
    const callee = node.callee;
    const name = callee.type === 'MemberExpression' ? callee.property.name : callee.name;
    if (/^(match|doesNotMatch|toMatch|toContain|includes|indexOf|lastIndexOf|ok|equal|strictEqual|toBe)$/.test(name || '')) guard = true;
  }
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach((item) => visit(item, guard));
    else if (child && typeof child.type === 'string') visit(child, guard);
  }
};
for (const test of tests) visit(parse(readFileSync(test, 'utf8')), false);

const source = readFileSync(file, 'utf8');
const hits = [];
for (const statement of parse(source).body) {
  const node = statement.declaration || statement;
  const names = node.type === 'VariableDeclaration' ? node.declarations.map((d) => d.id.name) : node.id ? [node.id.name] : [];
  if (!names.length) continue;
  const text = source.slice(statement.range[0], statement.range[1]);
  const matched = patterns.filter((pattern) => (pattern.kind === 'regex' ? pattern.value.test(text) : text.includes(pattern.value)));
  if (matched.length) hits.push({ names, line: statement.loc.start.line, matches: matched.length, sample: String(matched[0].value).slice(0, 60) });
}
console.log(JSON.stringify({ patterns: patterns.length, guarded: hits }, null, 2));
