// Refactor helper: reports what a line range of a module depends on, so a block
// can be moved into its own module without silently losing a closure variable.
// Usage: node tools/refactor/analyze-block.mjs <file> <startLine> <endLine> [handlerLine]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { SCOPE_OPTIONS } from './parse-source.mjs';

const require = createRequire(resolve(import.meta.dirname, '../../frontend/package.json'));
const espree = require('espree');
const eslintScope = require('eslint-scope');

const [file, startArg, endArg, handlerArg] = process.argv.slice(2);
if (!file || !startArg || !endArg) {
  console.error('usage: analyze-block.mjs <file> <startLine> <endLine> [handlerLine]');
  process.exit(2);
}
const start = Number(startArg);
const end = Number(endArg);
const source = readFileSync(file, 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true });
const scopeManager = eslintScope.analyze(ast, SCOPE_OPTIONS);
const inRange = (node) => node.loc.start.line >= start && node.loc.end.line <= end;

const reads = new Map();
const writes = new Map();
for (const scope of scopeManager.scopes) {
  for (const reference of scope.references) {
    if (!inRange(reference.identifier)) continue;
    const variable = reference.resolved;
    const name = reference.identifier.name;
    if (!variable) {
      reads.set(name, 'global');
      continue;
    }
    const definition = variable.defs[0];
    if (!definition || inRange(definition.name)) continue;
    const kind = definition.type === 'ImportBinding'
      ? `import from ${definition.parent.source.value}`
      : `${variable.scope.type}-scope ${definition.type} @${definition.name.loc.start.line}`;
    if (reference.isWrite()) writes.set(name, kind);
    if (reference.isRead() || !reference.isWrite()) reads.set(name, kind);
  }
}

// Count `return` statements that exit the enclosing handler function (not nested callbacks).
let handlerReturns = 0;
let awaits = 0;
if (handlerArg) {
  const handlerLine = Number(handlerArg);
  const visit = (node, depth) => {
    if (!node || typeof node.type !== 'string') return;
    const isFunction = /Function/.test(node.type);
    if (isFunction && node.loc.start.line !== handlerLine && inRange(node)) depth += 1;
    if (inRange(node) && depth === 0 && node.type === 'ReturnStatement') handlerReturns += 1;
    if (inRange(node) && depth === 0 && node.type === 'AwaitExpression') awaits += 1;
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach((child) => visit(child, depth));
      else if (value && typeof value.type === 'string') visit(value, depth);
    }
  };
  visit(ast, 0);
}

const group = (map) => {
  const out = {};
  for (const [name, kind] of [...map].sort()) {
    const key = kind.startsWith('import') ? kind : kind.startsWith('global') ? 'global' : kind.replace(/ @\d+$/, '');
    (out[key] ||= []).push(name);
  }
  return out;
};
console.log(JSON.stringify({
  range: [start, end],
  reads: group(reads),
  writesToOuterVariables: Object.fromEntries(writes),
  handlerLevelReturns: handlerArg ? handlerReturns : undefined,
  handlerLevelAwaits: handlerArg ? awaits : undefined,
}, null, 2));
