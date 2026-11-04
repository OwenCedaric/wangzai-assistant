import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(fileURLToPath(new URL('./desktopIpc.js', import.meta.url)), 'utf8');

test('manual payment login bypasses the native CEF presentation queue', () => {
  const visibleCommandLine = source.match(/opensVisiblePurchaseWindow\s*=\s*\[([^\]]*)\]/u)?.[1] || '';
  assert.doesNotMatch(visibleCommandLine, /open-purchase-payment-login/u);
  assert.match(source, /Payment login owns its independent Electron BrowserWindow/u);
});
