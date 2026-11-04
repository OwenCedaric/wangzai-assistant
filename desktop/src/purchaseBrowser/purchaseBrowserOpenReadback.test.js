import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePurchaseBrowserOpenReadback } from './purchaseBrowserOpenReadback.js';

const baseState = {
  visible: true,
  activeTabId: 'tab-a',
  tabs: [{
    tabId: 'tab-a',
    accountId: 'account-pdd',
    requestedUrl: 'https://mobile.yangkeduo.com/search_result.html?search_key=test',
  }],
};

test('PDD dedicated window satisfies an originally embedded order-workbench request', () => {
  const state = {
    ...baseState,
    tabs: [{
      ...baseState.tabs[0],
      displayMode: 'window',
      browserLayout: 'pinduoduo-dedicated',
      embedding: { requested: false, embedded: false, childStyle: false },
    }],
  };
  assert.deepEqual(evaluatePurchaseBrowserOpenReadback({
    state,
    accountId: 'account-pdd',
    requestedUrl: baseState.tabs[0].requestedUrl,
    requestedEmbedded: true,
  }), { ok: true, code: '', mode: 'pinduoduo-dedicated' });
});

test('ordinary embedded windows still require the exact native parent readback', () => {
  const failed = evaluatePurchaseBrowserOpenReadback({
    state: {
      ...baseState,
      tabs: [{
        ...baseState.tabs[0],
        displayMode: 'embedded',
        browserLayout: '',
        embedding: {
          requested: true,
          embedded: true,
          childStyle: true,
          parentHwnd: '123',
          actualParentHwnd: '999',
        },
      }],
    },
    accountId: 'account-pdd',
    requestedUrl: baseState.tabs[0].requestedUrl,
    requestedEmbedded: true,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'PURCHASE_BROWSER_EMBED_READBACK_FAILED');
});

test('a different account or URL remains a target mismatch', () => {
  const failed = evaluatePurchaseBrowserOpenReadback({
    state: baseState,
    accountId: 'another-account',
    requestedUrl: baseState.tabs[0].requestedUrl,
    requestedEmbedded: true,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'PURCHASE_BROWSER_TARGET_MISMATCH');
});
