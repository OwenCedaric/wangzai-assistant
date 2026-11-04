import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fenceProductListCachesForOwnerIdentifiers,
  getProductListPageCacheKey,
  productListCursorMemoryCache,
  productListMemoryCache,
  productListPageMetaMemoryCache,
  writeProductListPageMemoryCache,
} from '../../../../entities/product/productLocalData.jsx';
import {
  fenceAndDrainOzonSnapshotCachesForOwner,
  isOzonSnapshotOwnerFenced,
  ozonSnapshotInFlight,
  ozonSnapshotManualRefreshAt,
  ozonSnapshotMemoryCache,
} from '../../../../shared/config/appConfigRuntime.jsx';
import {
  fenceAndDrainMarketingActivityViewStateWrites,
  getMarketingActivityViewStateFenceStatus,
  getOzonSnapshotSourceKey,
  rememberMarketingActivityCacheSnapshot,
} from '../../../../entities/order/orderShopScope.jsx';
import {
  configurePurchasePluginContextStore,
  fenceAndDrainPurchasePluginContextWrites,
  flushPurchasePluginContextWritesForTest,
  resetPurchasePluginContextStoreForTest,
  savePurchasePluginSourceContext,
} from '../../../../services/purchasePluginContextStore.js';
import {
  fenceAndDrainOzonShopSettingsWrites,
  isOzonShopSettingsOwnerFenced,
  mergeLocalApiOzonShopSettings,
} from '../../../../services/ozonShopSettingsStore.js';

function shop(shopIncarnation, credentialRevision = 1) {
  return {
    id: 'generation-aware-shop',
    clientId: 'generation-aware-client',
    shopAlias: 'Generation shop',
    hasClientId: true,
    hasApiKey: true,
    shopIncarnation,
    credentialRevision,
  };
}

afterEach(() => {
  productListMemoryCache.clear();
  productListPageMetaMemoryCache.clear();
  productListCursorMemoryCache.clear();
  ozonSnapshotMemoryCache.clear();
  ozonSnapshotInFlight.clear();
  ozonSnapshotManualRefreshAt.clear();
  resetPurchasePluginContextStoreForTest();
});

describe('Ozon account-removal generation fences', () => {
  it('rejects old product/snapshot callbacks but permits a same-id new incarnation', async () => {
    const oldShop = shop('incarnation-old', 3);
    const reboundShop = shop('incarnation-rebound', 1);
    const oldProductKey = getProductListPageCacheKey(oldShop, '全部商品', 20, 1);
    const reboundProductKey = getProductListPageCacheKey(reboundShop, '全部商品', 20, 1);

    expect(oldProductKey).not.toBe(reboundProductKey);
    expect(writeProductListPageMemoryCache(oldProductKey, [{ id: 'old' }])).toBe(true);
    fenceProductListCachesForOwnerIdentifiers(oldShop);
    expect(writeProductListPageMemoryCache(oldProductKey, [{ id: 'late-old' }])).toBe(false);
    expect(writeProductListPageMemoryCache(reboundProductKey, [{ id: 'new' }])).toBe(true);

    const oldSnapshotKey = `products:${getOzonSnapshotSourceKey(oldShop)}`;
    const reboundSnapshotKey = `products:${getOzonSnapshotSourceKey(reboundShop)}`;
    ozonSnapshotMemoryCache.set(oldSnapshotKey, { value: 'old' });
    await fenceAndDrainOzonSnapshotCachesForOwner(oldShop);
    expect(isOzonSnapshotOwnerFenced(oldSnapshotKey)).toBe(true);
    expect(isOzonSnapshotOwnerFenced(reboundSnapshotKey)).toBe(false);
  });

  it('keeps lifecycle fields from local-api and scopes marketing/settings fences to one generation', async () => {
    const oldShop = shop('incarnation-settings-old', 4);
    const reboundShop = shop('incarnation-settings-new', 1);
    const merged = mergeLocalApiOzonShopSettings(
      { shops: [{ id: oldShop.id, shopAlias: 'Preference' }], activeShopId: oldShop.id, defaultWarehouseIds: {} },
      { shops: [{ ...oldShop, profileId: 'default' }] },
    );
    expect(merged.shops[0]).toMatchObject({
      shopIncarnation: 'incarnation-settings-old',
      credentialRevision: 4,
      profileId: 'default',
    });

    await fenceAndDrainOzonShopSettingsWrites(oldShop);
    await fenceAndDrainMarketingActivityViewStateWrites(oldShop);
    expect(isOzonShopSettingsOwnerFenced(oldShop)).toBe(true);
    expect(isOzonShopSettingsOwnerFenced(reboundShop)).toBe(false);
    expect(getMarketingActivityViewStateFenceStatus(oldShop).fenced).toBe(true);
    expect(getMarketingActivityViewStateFenceStatus(reboundShop).fenced).toBe(false);
    expect(rememberMarketingActivityCacheSnapshot(oldShop, { activities: [] })).toBe(false);
    expect(rememberMarketingActivityCacheSnapshot(reboundShop, { activities: [] })).toBe(true);
  });

  it('rejects an old purchase-plugin write and accepts the rebound generation', async () => {
    let canonicalStore = null;
    configurePurchasePluginContextStore({
      saveProfileSetting: vi.fn(async (_namespace, value) => {
        canonicalStore = value;
        return { setting: { value } };
      }),
      getProfileSetting: vi.fn(async () => ({ setting: { value: canonicalStore } })),
    });
    const oldShop = shop('incarnation-plugin-old', 2);
    const reboundShop = shop('incarnation-plugin-new', 1);
    await fenceAndDrainPurchasePluginContextWrites(oldShop);

    expect(() => savePurchasePluginSourceContext({
      shopId: oldShop.id,
      shopClientId: oldShop.clientId,
      shopIncarnation: oldShop.shopIncarnation,
      credentialRevision: oldShop.credentialRevision,
      orderKey: 'old-order',
      productKey: 'old-product',
    })).toThrow('ACCOUNT_REMOVAL_OWNER_FENCED');

    expect(() => savePurchasePluginSourceContext({
      shopId: reboundShop.id,
      shopClientId: reboundShop.clientId,
      shopIncarnation: reboundShop.shopIncarnation,
      credentialRevision: reboundShop.credentialRevision,
      orderKey: 'new-order',
      productKey: 'new-product',
    })).not.toThrow();
    await expect(flushPurchasePluginContextWritesForTest()).resolves.toMatchObject({
      shopIncarnation: reboundShop.shopIncarnation,
      credentialRevision: reboundShop.credentialRevision,
    });
  });
});

