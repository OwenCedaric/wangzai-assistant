import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRODUCT_MATERIAL_SOURCE_SUPPLIER,
  configureProductMaterialProfileStore,
  getProductMaterialProfileKey,
  hydrateProductMaterialProfilesFromLocalFile,
  readProductMaterialProfiles,
  resetProductMaterialProfileStoreForTest,
  saveSupplierProductMaterialProfile,
  saveSupplierProductMaterialProfileCanonical,
} from './productMaterialProfileStore';

afterEach(() => {
  resetProductMaterialProfileStoreForTest();
  globalThis.localStorage?.clear();
});

describe('product material profiles use SQLite as their runtime source', () => {
  it('builds a stable shop-scoped material key', () => {
    expect(getProductMaterialProfileKey({ offerId: ' offer-1 ' }, { id: 'shop-1' })).toBe('shop-1:offer-1');
  });

  it('hydrates canonical SQLite rows and ignores the retired browser key', async () => {
    globalThis.localStorage.setItem('wangzai-product-material-profiles-v1', JSON.stringify({
      'shop-1:legacy': { shopId: 'shop-1', offerId: 'legacy', weight: '99' },
    }));
    configureProductMaterialProfileStore({
      readProfilesFromLocalApi: vi.fn(async () => ({
        'shop-1:offer-1': { shopId: 'shop-1', offerId: 'offer-1', weight: '0.25', length: '20', width: '10', height: '8' },
      })),
    });

    const hydrated = await hydrateProductMaterialProfilesFromLocalFile();

    expect(hydrated['shop-1:offer-1'].weight).toBe('0.25');
    expect(hydrated['shop-1:legacy']).toBeUndefined();
  });

  it('writes an explicit supplier change to SQLite without browser persistence', async () => {
    const saveProfileToLocalApi = vi.fn(async () => ({ ok: true }));
    configureProductMaterialProfileStore({ saveProfileToLocalApi });

    const profile = saveSupplierProductMaterialProfile(
      { offerId: 'offer-1' },
      { id: 'shop-1' },
      { weight: '0.25', length: '20', width: '10', height: '8' },
    );
    await vi.waitFor(() => expect(saveProfileToLocalApi).toHaveBeenCalledTimes(1));

    expect(profile.source).toBe(PRODUCT_MATERIAL_SOURCE_SUPPLIER);
    expect(readProductMaterialProfiles()['shop-1:offer-1']).toBeTruthy();
  });

  it('awaits canonical SQLite confirmation before exposing a normal supplier save', async () => {
    let releaseSave;
    const saveProfileToLocalApi = vi.fn(() => new Promise((resolve) => {
      releaseSave = () => resolve({ ok: true });
    }));
    const writeLocalDataFile = vi.fn(async () => undefined);
    configureProductMaterialProfileStore({ saveProfileToLocalApi, writeLocalDataFile });

    const saving = saveSupplierProductMaterialProfileCanonical(
      { offerId: 'offer-2' },
      { id: 'shop-1' },
      { weight: '0.3', length: '21', width: '11', height: '9' },
    );
    await vi.waitFor(() => expect(saveProfileToLocalApi).toHaveBeenCalledTimes(1));
    expect(readProductMaterialProfiles()['shop-1:offer-2']).toBeUndefined();

    releaseSave();
    const profile = await saving;

    expect(profile.source).toBe(PRODUCT_MATERIAL_SOURCE_SUPPLIER);
    expect(readProductMaterialProfiles()['shop-1:offer-2']).toEqual(profile);
    expect(writeLocalDataFile).not.toHaveBeenCalled();
  });

  it('throws on canonical SQLite failure and never falls back to the legacy JSON file', async () => {
    const writeLocalDataFile = vi.fn(async () => undefined);
    configureProductMaterialProfileStore({
      saveProfileToLocalApi: vi.fn(async () => ({ ok: false, error: { message: 'sqlite unavailable' } })),
      writeLocalDataFile,
    });

    await expect(saveSupplierProductMaterialProfileCanonical(
      { offerId: 'offer-3' },
      { id: 'shop-1' },
      { weight: '0.3', length: '21', width: '11', height: '9' },
    )).rejects.toThrow('sqlite unavailable');

    expect(readProductMaterialProfiles()['shop-1:offer-3']).toBeUndefined();
    expect(writeLocalDataFile).not.toHaveBeenCalled();
  });
});
