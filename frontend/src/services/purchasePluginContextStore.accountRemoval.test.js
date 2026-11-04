import { beforeEach, describe, expect, it } from 'vitest';
import {
  configurePurchasePluginContextStore,
  countPurchasePluginContextMemoryAccountReferences,
  flushPurchasePluginContextWritesForTest,
  purchasePluginSourceContextMemory,
  removePurchasePluginContextMemoryForAccount,
  resetPurchasePluginContextStoreForTest,
  savePurchasePluginSourceContext,
} from './purchasePluginContextStore.js';

describe('purchasePluginContextStore purchase-account removal', () => {
  let canonicalSetting;

  beforeEach(() => {
    resetPurchasePluginContextStoreForTest();
    canonicalSetting = null;
    configurePurchasePluginContextStore({
      getProfileSetting: async () => canonicalSetting,
      saveProfileSetting: async (_namespace, value) => {
        canonicalSetting = { setting: { value } };
        return canonicalSetting;
      },
    });
  });

  it('removes only account A context, preserves account B, and fences late A writes', async () => {
    savePurchasePluginSourceContext({
      purchaseAccountId: 'purchase-a',
      shopId: 'shop-a',
      orderKey: 'order-a',
      productKey: 'product-a',
    });
    await flushPurchasePluginContextWritesForTest();
    expect(countPurchasePluginContextMemoryAccountReferences('purchase-a')).toBe(1);

    removePurchasePluginContextMemoryForAccount('purchase-a');
    expect(countPurchasePluginContextMemoryAccountReferences('purchase-a')).toBe(0);
    expect(purchasePluginSourceContextMemory).toEqual({});
    expect(() => savePurchasePluginSourceContext({
      purchaseAccountId: 'purchase-a',
      shopId: 'shop-a',
    })).toThrow('ACCOUNT_REMOVAL_OWNER_FENCED');

    savePurchasePluginSourceContext({
      purchaseAccountId: 'purchase-b',
      shopId: 'shop-b',
      orderKey: 'order-b',
      productKey: 'product-b',
    });
    await flushPurchasePluginContextWritesForTest();
    removePurchasePluginContextMemoryForAccount('purchase-a');
    expect(countPurchasePluginContextMemoryAccountReferences('purchase-b')).toBe(1);
    expect(purchasePluginSourceContextMemory).toMatchObject({
      purchaseAccountId: 'purchase-b',
      shopId: 'shop-b',
    });
  });
});
