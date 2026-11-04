import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  RETIRED_OZON_SHOP_BROWSER_KEY,
  getLegacyRetirementFixture,
} from './legacyRetirementHarness.js';

test('legacy retirement harness keeps the remaining audited Ozon fixture unchanged after extraction', () => {
  assert.equal(RETIRED_OZON_SHOP_BROWSER_KEY, 'wangzai-ozon-shops');
  const fixture = getLegacyRetirementFixture('ozon-shop-settings');
  assert.equal(fixture.canonicalKind, 'ozon-shop-settings');
  assert.equal(fixture.expectedShopId, 'legacy-retirement-ozon-shop');
  assert.equal(fixture.expectedWarehouseId, 'fixture-warehouse');
  assert.equal(fixture.legacyEntries.length, 1);
  assert.equal(fixture.legacyEntries[0].key, RETIRED_OZON_SHOP_BROWSER_KEY);
  assert.equal(fixture.legacyEntries[0].value[0].clientId, 'fixture-client-id');
});

test('normal desktop packaging does not ship or eagerly load the legacy retirement harness', () => {
  const desktopRoot = path.resolve(import.meta.dirname, '..');
  const mainWindowSource = readFileSync(path.join(desktopRoot, 'src', 'window', 'mainWindow.js'), 'utf8');
  const packageConfig = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
  assert.equal(mainWindowSource.includes('from "./legacyRetirementHarness.js"'), false);
  assert.equal(mainWindowSource.includes('await import("../../test-support/legacyRetirementHarness.js")'), true);
  assert.equal(packageConfig.build.files.some((entry) => String(entry).includes('test-support')), false);
});
