import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getLocalShops: vi.fn(),
  getProfileSetting: vi.fn(),
  saveLocalShop: vi.fn(),
  saveProfileSetting: vi.fn(),
}));

vi.mock('../api/localApiClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getLocalShops: mocks.getLocalShops,
  getProfileSetting: mocks.getProfileSetting,
  saveLocalShop: mocks.saveLocalShop,
  saveProfileSetting: mocks.saveProfileSetting,
}));

import {
  drainOzonShopSettingsWrites,
  hydrateOzonShopSettingsFromLocalFile,
  hydrateOzonShopSettingsWithRetry,
  persistOzonShopSettings,
  PROFILE_OZON_SHOP_PREFERENCES_NAMESPACE,
  saveOzonShopPreferences,
  saveOzonShopSettings,
  toOzonShopPreferences,
} from './ozonShopSettingsStore.js';

const store = {
  shops: [{
    id: 'shop-demo', shopAlias: '演示店铺', sellerName: '演示卖家',
    clientId: '10001', apiKey: 'api-key', connectionStatus: '连接成功',
  }],
  activeShopId: 'shop-demo',
  defaultWarehouseIds: { 'shop-demo': 'warehouse-1' },
};
const publicShop = {
  id: 'shop-demo', name: '演示卖家', alias: '演示店铺', status: 'active', hasClientId: true, hasApiKey: true,
};
const preferences = (value = toOzonShopPreferences(store)) => ({
  setting: { namespace: PROFILE_OZON_SHOP_PREFERENCES_NAMESPACE, value },
});

afterEach(() => {
  globalThis.localStorage.clear();
  vi.clearAllMocks();
});

describe('Ozon shop accounts use SQLite as the only runtime source', () => {
  it('keeps License Center verification in memory and excludes it from ordinary preferences', () => {
    const value = toOzonShopPreferences({
      ...store,
      shops: [{
        ...store.shops[0],
        licenseAuthorizationStatus: 'active',
        licenseAuthorized: true,
        licenseId: 31,
        licenseExpireAt: '2027-08-01T00:00:00.000Z',
      }],
    });

    expect(value.shops[0]).toMatchObject({ id: 'shop-demo', shopAlias: '演示店铺' });
    expect(value.shops[0]).not.toHaveProperty('licenseAuthorizationStatus');
    expect(value.shops[0]).not.toHaveProperty('licenseAuthorized');
    expect(value.shops[0]).not.toHaveProperty('licenseId');
    expect(value.shops[0]).not.toHaveProperty('licenseExpireAt');
  });

  it('still loads every canonical shop when the preference endpoint is temporarily unavailable', async () => {
    mocks.getProfileSetting.mockRejectedValue(new Error('preference endpoint timeout'));
    mocks.getLocalShops.mockResolvedValue({ shops: [publicShop] });

    const hydrated = await hydrateOzonShopSettingsFromLocalFile();

    expect(hydrated.shops).toHaveLength(1);
    expect(hydrated.shops[0]).toMatchObject({
      id: 'shop-demo',
      hasClientId: true,
      hasApiKey: true,
    });
    expect(hydrated.shops.some((shop) => shop.id === 'ozon-shop-1')).toBe(false);
  });

  it('retries transient canonical shop read failures until the real list is restored', async () => {
    mocks.getProfileSetting.mockResolvedValue(preferences());
    mocks.getLocalShops
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockRejectedValueOnce(new Error('local api timeout'))
      .mockResolvedValueOnce({ shops: [publicShop] });

    const hydrated = await hydrateOzonShopSettingsWithRetry({
      maxAttempts: 3,
      retryDelaysMs: [0, 0],
    });

    expect(mocks.getLocalShops).toHaveBeenCalledTimes(3);
    expect(hydrated.shops).toMatchObject([{ id: 'shop-demo', hasApiKey: true }]);
  });

  it('drains an in-flight account save before deletion preview can inspect canonical state', async () => {
    let releaseSave;
    const saveGate = new Promise((resolve) => { releaseSave = resolve; });
    mocks.saveLocalShop.mockReturnValue(saveGate);
    mocks.saveProfileSetting.mockResolvedValue(preferences());
    mocks.getProfileSetting.mockResolvedValue(preferences());
    mocks.getLocalShops.mockResolvedValue({ shops: [publicShop] });

    saveOzonShopSettings(store.shops, store.activeShopId, { defaultWarehouseIds: store.defaultWarehouseIds });
    const drained = vi.fn();
    const drainPromise = drainOzonShopSettingsWrites().then(drained);
    await vi.waitFor(() => expect(mocks.saveLocalShop).toHaveBeenCalledTimes(1));
    expect(drained).not.toHaveBeenCalled();

    releaseSave({ shop: publicShop });
    await drainPromise;
    expect(drained).toHaveBeenCalledTimes(1);
    expect(mocks.getLocalShops).toHaveBeenCalled();
  });

  it('ignores the retired browser shop key and returns canonical accounts', async () => {
    globalThis.localStorage.setItem('wangzai-ozon-shops', JSON.stringify([{ id: 'legacy-only', apiKey: 'legacy-key' }]));
    mocks.getProfileSetting.mockResolvedValue(preferences());
    mocks.getLocalShops.mockResolvedValue({ shops: [publicShop] });

    const hydrated = await hydrateOzonShopSettingsFromLocalFile();

    expect(hydrated.shops).toMatchObject([{ id: 'shop-demo', hasClientId: true, hasApiKey: true }]);
    expect(hydrated.shops.some((shop) => shop.id === 'legacy-only')).toBe(false);
    expect(mocks.saveLocalShop).not.toHaveBeenCalled();
    expect(mocks.saveProfileSetting).not.toHaveBeenCalled();
    expect(globalThis.localStorage.getItem('wangzai-ozon-shops')).not.toBeNull();
  });

  it('does not create accounts or preferences from a retired browser shop payload when SQLite is empty', async () => {
    globalThis.localStorage.setItem('wangzai-ozon-shops', JSON.stringify(store.shops));
    mocks.getProfileSetting.mockResolvedValue({ setting: null });
    mocks.getLocalShops.mockResolvedValue({ shops: [] });

    const hydrated = await hydrateOzonShopSettingsFromLocalFile();

    expect(hydrated.shops.some((shop) => shop.id === 'shop-demo')).toBe(false);
    expect(mocks.saveLocalShop).not.toHaveBeenCalled();
    expect(mocks.saveProfileSetting).not.toHaveBeenCalled();
  });

  it('ignores the retired active-shop browser value and keeps the SQLite preference', async () => {
    globalThis.localStorage.setItem('wangzai-active-ozon-shop-id', 'legacy-active-shop');
    mocks.getProfileSetting.mockResolvedValue(preferences());
    mocks.getLocalShops.mockResolvedValue({ shops: [publicShop] });

    const hydrated = await hydrateOzonShopSettingsFromLocalFile();

    expect(hydrated.activeShopId).toBe('shop-demo');
    expect(mocks.saveProfileSetting).not.toHaveBeenCalled();
    expect(globalThis.localStorage.getItem('wangzai-active-ozon-shop-id')).toBe('legacy-active-shop');
  });

  it('ignores the retired default-warehouse browser value and keeps SQLite preferences', async () => {
    globalThis.localStorage.setItem('wangzai-ozon-default-warehouse-by-shop', JSON.stringify({ 'shop-demo': 'legacy-warehouse' }));
    mocks.getProfileSetting.mockResolvedValue(preferences());
    mocks.getLocalShops.mockResolvedValue({ shops: [publicShop] });

    const hydrated = await hydrateOzonShopSettingsFromLocalFile();

    expect(hydrated.defaultWarehouseIds).toEqual({ 'shop-demo': 'warehouse-1' });
    expect(mocks.saveProfileSetting).not.toHaveBeenCalled();
  });

  it('keeps explicit account saves in encrypted shop storage and excludes the API key from preferences', async () => {
    mocks.saveLocalShop.mockResolvedValue({ shop: publicShop });
    mocks.saveProfileSetting.mockResolvedValue(preferences());
    mocks.getProfileSetting.mockResolvedValue(preferences());
    mocks.getLocalShops.mockResolvedValue({ shops: [publicShop] });

    saveOzonShopSettings(store.shops, store.activeShopId, { defaultWarehouseIds: store.defaultWarehouseIds });
    await vi.waitFor(() => expect(mocks.saveProfileSetting).toHaveBeenCalledTimes(1));

    expect(mocks.saveLocalShop).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'api-key' }), { timeoutMs: 30000 });
    expect(JSON.stringify(mocks.saveProfileSetting.mock.calls[0][1])).not.toContain('api-key');
  });

  it('exposes a strict save barrier for connection tests and waits for verified readback', async () => {
    let persistedPreferences;
    mocks.saveLocalShop.mockResolvedValue({ shop: publicShop });
    mocks.saveProfileSetting.mockImplementation(async (namespace, value) => {
      persistedPreferences = value;
      return { setting: { namespace, value } };
    });
    mocks.getProfileSetting.mockImplementation(async () => preferences(persistedPreferences));
    mocks.getLocalShops.mockResolvedValue({ shops: [publicShop] });

    const saved = await persistOzonShopSettings(store.shops, store.activeShopId, {
      defaultWarehouseIds: store.defaultWarehouseIds,
    });

    expect(saved.shops).toMatchObject([{ id: 'shop-demo', hasClientId: true, hasApiKey: true }]);
    expect(mocks.saveLocalShop).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'api-key' }), { timeoutMs: 30000 });
    expect(mocks.getProfileSetting).toHaveBeenCalledAfter(mocks.saveProfileSetting);
  });

  it('saves only the selected shop so an unrelated legacy account cannot block a new licensed shop', async () => {
    const multiStore = {
      ...store,
      shops: [
        {
          id: 'legacy-shop', shopAlias: '旧店', sellerName: '旧店',
          clientId: 'legacy-client', apiKey: 'legacy-api-key', connectionStatus: '连接成功',
        },
        {
          id: 'new-shop', shopAlias: '新店', sellerName: '新店',
          clientId: 'new-client', apiKey: 'new-api-key', connectionStatus: '未测试',
        },
      ],
      activeShopId: 'new-shop',
    };
    const publicShops = [
      { id: 'legacy-shop', name: '旧店', alias: '旧店', status: 'active', hasClientId: true, hasApiKey: true },
      { id: 'new-shop', name: '新店', alias: '新店', status: 'active', hasClientId: true, hasApiKey: true },
    ];
    let persistedPreferences;
    mocks.saveLocalShop.mockImplementation(async (payload) => {
      if (payload.id === 'legacy-shop') throw new Error('旧店授权不应参与本次保存');
      return { shop: publicShops[1] };
    });
    mocks.saveProfileSetting.mockImplementation(async (namespace, value) => {
      persistedPreferences = value;
      return { setting: { namespace, value } };
    });
    mocks.getProfileSetting.mockImplementation(async () => ({
      setting: { namespace: PROFILE_OZON_SHOP_PREFERENCES_NAMESPACE, value: persistedPreferences },
    }));
    mocks.getLocalShops.mockResolvedValue({ shops: publicShops });

    const saved = await persistOzonShopSettings(multiStore.shops, multiStore.activeShopId);

    expect(saved.shops).toHaveLength(2);
    expect(mocks.saveLocalShop).toHaveBeenCalledTimes(1);
    expect(mocks.saveLocalShop).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new-shop', clientId: 'new-client', apiKey: 'new-api-key' }),
      { timeoutMs: 30000 },
    );
  });

  it('rejects the strict save barrier when encrypted account persistence fails', async () => {
    mocks.saveLocalShop.mockRejectedValue(new Error('local-api account write failed'));

    await expect(persistOzonShopSettings(store.shops, store.activeShopId, {
      defaultWarehouseIds: store.defaultWarehouseIds,
    })).rejects.toThrow('local-api account write failed');
    expect(mocks.saveProfileSetting).not.toHaveBeenCalled();
    await expect(drainOzonShopSettingsWrites()).resolves.toMatchObject({ drained: true, lastWriteFailed: true, failedWrites: 1 });
  });

  it('keeps an active-shop selection as a preference-only write', async () => {
    mocks.saveProfileSetting.mockResolvedValue(preferences());
    mocks.getProfileSetting.mockResolvedValue(preferences());

    saveOzonShopPreferences(store.shops, store.activeShopId, { defaultWarehouseIds: store.defaultWarehouseIds });
    await vi.waitFor(() => expect(mocks.saveProfileSetting).toHaveBeenCalledTimes(1));
    expect(mocks.saveLocalShop).not.toHaveBeenCalled();
  });
});
