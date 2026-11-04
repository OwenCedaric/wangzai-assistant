// Shared parser / scope options for the refactor tools. `.jsx` files are parsed with
// JSX enabled, and eslint-scope runs with `jsx: true` so component names in tags
// (`<Foo>`, root `Foo` of `<Foo.Bar>`) count as references. Without that a component
// used only in JSX would look unused / dependency-free and a move could leave it behind
// (a runtime ReferenceError that free-names would miss too). Lowercase intrinsic tags
// (`<div>`) are not references.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(resolve(import.meta.dirname, '../../frontend/package.json'));
const espree = require('espree');

export function parseSource(source, file = '', options = {}) {
  const jsx = /\.jsx$/i.test(file);
  return espree.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ...options,
    ...(jsx ? { ecmaFeatures: { ...(options.ecmaFeatures || {}), jsx: true } } : {}),
  });
}

export const SCOPE_OPTIONS = Object.freeze({
  ecmaVersion: 2022,
  sourceType: 'module',
  childVisitorKeys: espree.VisitorKeys,
  fallback: 'iteration',
  jsx: true,
});
