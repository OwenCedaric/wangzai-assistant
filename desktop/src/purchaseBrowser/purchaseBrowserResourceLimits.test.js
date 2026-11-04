import assert from 'node:assert/strict';
import test from 'node:test';
import { selectInteractiveTabsToEvict } from './cefPurchaseBrowserController.js';

test('ten opened accounts keep only the active tab and one most-recent warm tab', () => {
  const tabs = Array.from({ length: 10 }, (_, index) => ({
    tabId: `tab-${index + 1}`,
    background: false,
    lastUsedAt: index + 1,
  }));
  const evicted = selectInteractiveTabsToEvict(tabs, 'tab-10', 2);
  assert.deepEqual(evicted.map((tab) => tab.tabId), [
    'tab-8', 'tab-7', 'tab-6', 'tab-5', 'tab-4', 'tab-3', 'tab-2', 'tab-1',
  ]);
});
