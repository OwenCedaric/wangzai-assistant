import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./mainWindow.js', import.meta.url), 'utf8');

test('desktop persists only the approved profit timing info messages alongside warnings and errors', () => {
  assert.match(source, /\[profit-hydration-ready\]/);
  assert.match(source, /\[profit-calculation-lane-ready\]/);
  assert.match(source, /level !== "warning" && level !== "error" && !allowedInfo/);
});
