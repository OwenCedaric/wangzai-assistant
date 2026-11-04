import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('preload keeps one native browser IPC listener while ten UI subscribers share the broker', () => {
  const source = fs.readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
  const nativeListeners = source.match(/ipcRenderer\.on\('desktop:purchase-browser-event'/gu) || [];
  assert.equal(nativeListeners.length, 1);
  assert.match(source, /const purchaseBrowserEventListeners = new Set\(\)/u);
  assert.match(source, /purchaseBrowserEventListeners\.add\(callback\)/u);
  assert.match(source, /purchaseBrowserEventListeners\.delete\(callback\)/u);
});
