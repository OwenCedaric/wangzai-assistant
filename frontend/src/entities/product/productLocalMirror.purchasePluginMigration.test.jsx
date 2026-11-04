import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configurePurchasePluginContextStore,
  flushPurchasePluginContextWritesForTest,
  hydratePurchasePluginSourceContextFromLocalFile,
  migrateLegacyPurchasePluginSourceContextAtStartup,
  normalizePurchasePluginSourceContextStore,
  resetPurchasePluginContextStoreForTest,
  savePurchasePluginSourceContext,
} from './productLocalMirror.jsx';

const profileApi = { get: vi.fn(), save: vi.fn() };
const legacyFile = { read: vi.fn(), mark: vi.fn() };
let fileValue;

function contextStore(context) {
  return normalizePurchasePluginSourceContextStore({
    context,
    updatedAt: context?.updatedAt || context?.lockedAt || '',
  });
}

function configureAdapters() {
  configurePurchasePluginContextStore({
    getProfileSetting: profileApi.get,
    saveProfileSetting: profileApi.save,
    readLegacyFile: legacyFile.read,
    writeLegacyFileMarker: legacyFile.mark,
  });
}

beforeEach(() => {
  resetPurchasePluginContextStoreForTest();
  fileValue = {};
  configureAdapters();
  profileApi.get.mockResolvedValue({ setting: null });
  profileApi.save.mockResolvedValue({ setting: null });
  legacyFile.read.mockImplementation(async () => fileValue);
  legacyFile.mark.mockImplementation(async (_key, marker) => {
    fileValue = marker;
    return true;
  });
});

afterEach(() => {
  resetPurchasePluginContextStoreForTest();
  vi.clearAllMocks();
});

describe('purchase plugin source context SQLite migration', () => {
  it('independently reads back profile SQLite before marking the matching retired JSON file', async () => {
    const context = {
      offerId: 'offer-1',
      lockedAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:01.000Z',
    };
    const canonical = contextStore(context);
    fileValue = { version: 1, context, updatedAt: context.updatedAt };
    profileApi.save.mockResolvedValue({ setting: { value: canonical } });
    profileApi.get.mockResolvedValueOnce({ setting: null }).mockResolvedValueOnce({ setting: { value: canonical } });

    await expect(hydratePurchasePluginSourceContextFromLocalFile()).resolves.toEqual(context);

    expect(profileApi.save).toHaveBeenCalledWith('purchase-plugin-context', canonical, { timeoutMs: 30000 });
    expect(profileApi.get).toHaveBeenCalledTimes(2);
    expect(legacyFile.mark).toHaveBeenCalledWith(
      'purchase-source-plugin-context',
      expect.objectContaining({ migration: 'profile-settings', namespace: 'purchase-plugin-context' })
    );
    expect(fileValue).toMatchObject({ migration: 'profile-settings', namespace: 'purchase-plugin-context' });
  });

  it('fails closed for malformed or lossy legacy values instead of normalizing them before comparison', async () => {
    fileValue = { version: 1, context: { offerId: 'offer-1', apiKey: 'must-not-be-dropped' }, updatedAt: '' };

    await expect(hydratePurchasePluginSourceContextFromLocalFile()).resolves.toEqual({});

    expect(profileApi.save).not.toHaveBeenCalled();
    expect(legacyFile.mark).not.toHaveBeenCalled();
  });

  it('does not migrate when the retired JSON input cannot be read', async () => {
    legacyFile.read.mockRejectedValue(new Error('disk unavailable'));

    await expect(hydratePurchasePluginSourceContextFromLocalFile()).resolves.toEqual({});

    expect(profileApi.save).not.toHaveBeenCalled();
  });

  it('keeps legacy inputs if profile write succeeds but independent readback is missing or differs', async () => {
    const context = { offerId: 'offer-1', lockedAt: '2026-07-13T00:00:00.000Z' };
    fileValue = { version: 1, context, updatedAt: context.lockedAt };
    profileApi.save.mockResolvedValue({ setting: { value: contextStore(context) } });
    profileApi.get.mockResolvedValueOnce({ setting: null }).mockResolvedValueOnce({ setting: null });

    await expect(hydratePurchasePluginSourceContextFromLocalFile()).rejects.toThrow('回读');

    expect(legacyFile.mark).not.toHaveBeenCalled();
  });

  it('uses restored canonical SQLite data and preserves a nonmatching retired file', async () => {
    const canonical = contextStore({ offerId: 'canonical-offer', lockedAt: '2026-07-13T00:00:00.000Z' });
    profileApi.get.mockResolvedValue({ setting: { value: canonical } });
    fileValue = { version: 1, context: { offerId: 'different-offer' }, updatedAt: '' };

    await expect(migrateLegacyPurchasePluginSourceContextAtStartup()).resolves.toEqual(canonical.context);

    expect(profileApi.save).not.toHaveBeenCalled();
    expect(legacyFile.mark).not.toHaveBeenCalled();
  });

  it('uses SQLite for normal saves, independently reads it back, and never writes the retired JSON runtime file', async () => {
    const context = { orderKey: 'posting-1', offerId: 'offer-1', lockedAt: '2026-07-13T00:00:00.000Z' };
    const canonical = contextStore(context);
    profileApi.save.mockResolvedValue({ setting: { value: canonical } });
    profileApi.get.mockResolvedValue({ setting: { value: canonical } });

    expect(savePurchasePluginSourceContext(context)).toEqual(canonical.context);
    await expect(flushPurchasePluginContextWritesForTest()).resolves.toEqual(canonical.context);

    expect(profileApi.save).toHaveBeenCalledWith('purchase-plugin-context', canonical, { timeoutMs: 30000 });
    expect(profileApi.get).toHaveBeenCalledTimes(1);
    expect(legacyFile.mark).not.toHaveBeenCalled();
  });

  it('makes a failed normal-save readback observable and lets the next queued save recover', async () => {
    const first = contextStore({ offerId: 'first', lockedAt: '2026-07-13T00:00:00.000Z' });
    const second = contextStore({ offerId: 'second', lockedAt: '2026-07-13T00:00:01.000Z' });
    profileApi.save.mockResolvedValueOnce({ setting: { value: first } }).mockResolvedValueOnce({ setting: { value: second } });
    profileApi.get.mockResolvedValueOnce({ setting: { value: second } }).mockResolvedValueOnce({ setting: { value: second } });

    savePurchasePluginSourceContext(first.context);
    await expect(flushPurchasePluginContextWritesForTest()).rejects.toThrow('回读不一致');
    savePurchasePluginSourceContext(second.context);
    await expect(flushPurchasePluginContextWritesForTest()).resolves.toEqual(second.context);
  });

  it('does not let a delayed startup migration overwrite a newer user selection', async () => {
    const legacy = { offerId: 'legacy-offer' };
    const newer = contextStore({ offerId: 'newer-offer', lockedAt: '2026-07-13T00:00:01.000Z' });
    let resolveInitialRead;
    const initialRead = new Promise((resolve) => {
      resolveInitialRead = resolve;
    });
    let getCalls = 0;
    profileApi.get.mockImplementation(() => {
      getCalls += 1;
      return getCalls === 1 ? initialRead : Promise.resolve({ setting: { value: newer } });
    });
    profileApi.save.mockResolvedValue({ setting: { value: newer } });
    fileValue = { version: 1, context: legacy, updatedAt: '' };

    const migration = hydratePurchasePluginSourceContextFromLocalFile();
    savePurchasePluginSourceContext(newer.context);
    await expect(flushPurchasePluginContextWritesForTest()).resolves.toEqual(newer.context);
    resolveInitialRead({ setting: null });

    await expect(migration).resolves.toEqual(newer.context);
    expect(profileApi.save).toHaveBeenCalledTimes(1);
  });

  it('keeps only documented purchase-plugin context fields and safe product indexes for normal runtime input', () => {
    const normalized = normalizePurchasePluginSourceContextStore({
      context: {
        shopName: '夹具店铺',
        shopId: 'shop-1',
        shopClientId: 'client-1',
        orderKey: 'posting-1',
        productKey: 'product-1',
        offerId: 'offer-1',
        productIndex: 2,
        productName: '夹具商品',
        lockedAt: '2026-07-13T00:00:00.000Z',
        debugPayload: 'must-not-persist',
        nested: { unknown: true },
      },
    });

    expect(normalized.context).toMatchObject({
      shopName: '夹具店铺', shopId: 'shop-1', shopClientId: 'client-1', orderKey: 'posting-1',
      productKey: 'product-1', offerId: 'offer-1', productIndex: 2, productName: '夹具商品',
      lockedAt: '2026-07-13T00:00:00.000Z',
    });
    expect(normalized.context).not.toHaveProperty('debugPayload');
    expect(normalized.context).not.toHaveProperty('nested');
    expect(normalizePurchasePluginSourceContextStore({ context: { productIndex: Number.MAX_SAFE_INTEGER + 1 } }).context)
      .toEqual({ productIndex: 0 });
  });
});
