import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(currentDirectory, '..', '..');

async function readMainWindowSource() {
  return fs.readFile(path.join(desktopRoot, 'src', 'window', 'mainWindow.js'), 'utf8');
}

test('retired R8 high-cardinality browser cursor runner cannot return to the desktop window', async () => {
  const source = await readMainWindowSource();
  const retiredSymbols = [
    'readEveryLegacyCursorPage',
    'readEveryRecoveryScopeShop',
    'LEGACY_RETIREMENT_MAX_SUPPORT_PAGE_COUNT',
    "cursorMode: 'legacy-migration'",
    'CURSOR_PAGE_SHAPE_INVALID',
    'CURSOR_PAGE_TOTAL_MISMATCH',
    'CURSOR_NEXT_CURSOR_INVALID',
    'CURSOR_PAGE_INCOMPLETE',
    'CURSOR_PAGE_LIMIT_REACHED',
    'materialProfilesResponse',
    'productSourceLinksResponse',
    'purchaseOverridesResponse',
    'purchaseSourceLinksResponse',
    'salesSourceLinksResponse',
  ];
  retiredSymbols.forEach((symbol) => assert.equal(source.includes(symbol), false, symbol));
});

test('retired R8 browser migration routes stay absent from the desktop window', async () => {
  const source = await readMainWindowSource();
  const retiredRoutes = [
    '/api/products/material',
    '/api/products/source-links',
    '/api/purchase/source-links',
    '/api/sales/source-links',
    '/api/purchase/orders/overrides',
    '/api/model-api/accounts',
    '/api/purchase/accounts',
    '/api/integrations/profiles',
    '/api/performance/accounts',
    '/api/products/support',
  ];
  retiredRoutes.forEach((route) => assert.equal(source.includes(route), false, route));
});
