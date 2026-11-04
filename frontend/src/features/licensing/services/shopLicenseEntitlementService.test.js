import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activatePurchasedLicense,
  bindOwnedLicenseToOzonShop,
  listShopLicenseEntitlements,
  renewPurchasedLicense,
} from './licenseCenterClient.js';
import {
  applyOzonShopLicenseResolution,
  authorizeAdditionalShopSlot,
  authorizeOzonShopSave,
  createOzonShopLicenseIdentityKey,
  findOzonShopLicenseEntitlement,
  findPendingAdditionalShopLicense,
  getOzonShopLicenseExpiration,
  isShopBoundElsewhereError,
  resolveOzonShopLicenseStates,
  renewOzonShopLicense,
  shopLicenseIsCurrent,
} from './shopLicenseEntitlementService.js';

vi.mock('./licenseCenterClient.js', () => ({
  activatePurchasedLicense: vi.fn(),
  bindOwnedLicenseToOzonShop: vi.fn(),
  listShopLicenseEntitlements: vi.fn(),
  renewPurchasedLicense: vi.fn(),
}));

const runtime = { projectCode: 'wangzai_desktop' };
const shop = { clientId: 'client-100', sellerName: '第一店' };
const future = '2099-01-01T00:00:00Z';
const past = '2020-01-01T00:00:00Z';

describe('shopLicenseEntitlementService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listShopLicenseEntitlements.mockResolvedValue([]);
    activatePurchasedLicense.mockResolvedValue({ valid: true });
    bindOwnedLicenseToOzonShop.mockResolvedValue({ id: 1 });
    renewPurchasedLicense.mockResolvedValue({ valid: true });
  });

  it('recognizes only active unexpired entitlements', () => {
    expect(shopLicenseIsCurrent({ status: 'active', expire_time: future })).toBe(true);
    expect(shopLicenseIsCurrent({ status: 'active', expire_time: past })).toBe(false);
    expect(shopLicenseIsCurrent({ status: 'disabled', expire_time: future })).toBe(false);
  });

  it('reads the expiration from the entitlement bound to the exact Ozon shop', async () => {
    listShopLicenseEntitlements.mockResolvedValue([
      {
        license_id: 30,
        status: 'active',
        expire_time: '2098-01-01T00:00:00Z',
        shops: [{ shop_id: 'client-other', status: 'active' }],
      },
      {
        license_id: 31,
        status: 'active',
        expire_time: future,
        shops: [{ shop_id: 'client-100', status: 'active' }],
      },
    ]);

    expect(findOzonShopLicenseEntitlement(
      await listShopLicenseEntitlements(runtime),
      shop,
    )?.license_id).toBe(31);
    await expect(getOzonShopLicenseExpiration(runtime, shop)).resolves.toEqual({
      licenseId: 31,
      expireAt: future,
      status: 'active',
    });
  });

  it('does not leak another shop expiration when the requested shop has no binding', async () => {
    listShopLicenseEntitlements.mockResolvedValue([{
      license_id: 32,
      status: 'active',
      expire_time: future,
      shops: [{ shop_id: 'client-other', status: 'active' }],
    }]);

    await expect(getOzonShopLicenseExpiration(runtime, shop)).resolves.toBeNull();
  });

  it('never treats an account-level card as an exact shop binding', async () => {
    await expect(getOzonShopLicenseExpiration(runtime, shop)).resolves.toBeNull();
  });

  it('marks only exactly bound shops as readable', async () => {
    listShopLicenseEntitlements.mockResolvedValue([{
      license_id: 31,
      status: 'active',
      expire_time: future,
      shops: [{ shop_id: 'client-100', status: 'active' }],
    }]);
    await expect(resolveOzonShopLicenseStates(runtime, [
      { id: 'shop-1', clientId: 'client-100', connectionStatus: '连接成功' },
      { id: 'shop-2', clientId: 'client-200', connectionStatus: '连接成功' },
    ])).resolves.toEqual([
      expect.objectContaining({
        id: 'shop-1',
        licenseAuthorizationStatus: 'active',
        licenseAuthorized: true,
      }),
      expect.objectContaining({
        id: 'shop-2',
        licenseAuthorizationStatus: 'missing',
        licenseAuthorized: false,
        connectionStatus: '未授权',
      }),
    ]);
  });

  it('does not let a delayed bootstrap license result erase hydrated SQLite shops', () => {
    const bootstrapSnapshot = [{ id: 'ozon-shop-1', clientId: '', shopAlias: 'Ozon 1店' }];
    const delayedBootstrapResult = [{
      ...bootstrapSnapshot[0],
      licenseAuthorizationStatus: 'missing',
      licenseAuthorized: false,
    }];
    const canonicalShops = [
      { id: 'shop-1', clientId: 'client-100', shopAlias: 'Ozon 1店' },
      { id: 'shop-2', clientId: 'client-200', shopAlias: 'Ozon 2店' },
      { id: 'shop-3', clientId: 'client-300', shopAlias: 'Ozon 3店' },
    ];

    expect(createOzonShopLicenseIdentityKey(canonicalShops))
      .not.toBe(createOzonShopLicenseIdentityKey(bootstrapSnapshot));
    expect(applyOzonShopLicenseResolution(
      canonicalShops,
      bootstrapSnapshot,
      delayedBootstrapResult,
    )).toBe(canonicalShops);
  });

  it('applies a license result when it still belongs to the current shop snapshot', () => {
    const currentShops = [{ id: 'shop-1', clientId: 'client-100' }];
    const resolvedShops = [{
      ...currentShops[0],
      licenseAuthorizationStatus: 'active',
      licenseAuthorized: true,
    }];

    expect(applyOzonShopLicenseResolution(
      currentShops,
      currentShops,
      resolvedShops,
    )).toBe(resolvedShops);
  });

  it('does not consume a card when this shop already has a current binding', async () => {
    listShopLicenseEntitlements.mockResolvedValue([{
      license_id: 10,
      status: 'active',
      expire_time: future,
      shops: [{ shop_id: 'client-100', status: 'active' }],
    }]);
    await expect(authorizeOzonShopSave(runtime, shop)).resolves.toEqual({
      action: 'already-authorized',
      licenseId: 10,
    });
    expect(activatePurchasedLicense).not.toHaveBeenCalled();
    expect(renewPurchasedLicense).not.toHaveBeenCalled();
  });

  it('never accepts a persisted local row id as a substitute for the exact Ozon Client ID', async () => {
    const existingShop = {
      id: 'ozon-shop-example-01',
      clientId: '4616153',
      hasClientId: true,
      sellerName: 'SuperBaiss',
    };
    listShopLicenseEntitlements.mockResolvedValue([{
      license_id: 14,
      status: 'active',
      expire_time: '2027-08-01T00:00:00Z',
      shops: [{ shop_id: 'ozon-shop-example-01', status: 'active' }],
    }]);

    await expect(authorizeOzonShopSave(runtime, existingShop)).rejects.toMatchObject({
      code: 'ADDITIONAL_SHOP_PREACTIVATION_REQUIRED',
    });
    expect(bindOwnedLicenseToOzonShop).not.toHaveBeenCalled();
  });

  it('does not read a sealed shop expiration through its persisted local row id', async () => {
    const sealedShop = {
      id: 'ozon-shop-example-02',
      clientId: '',
      hasClientId: true,
    };
    listShopLicenseEntitlements.mockResolvedValue([{
      license_id: 15,
      status: 'active',
      expire_time: '2027-08-02T00:00:00Z',
      shops: [{ shop_id: 'ozon-shop-example-02', status: 'active' }],
    }]);

    await expect(getOzonShopLicenseExpiration(runtime, sealedShop)).resolves.toBeNull();
  });

  it('blocks a persisted shop when it has no exact per-shop ledger', async () => {
    const persistedShop = {
      id: 'ozon-shop-example-02',
      clientId: '4067587',
      hasClientId: true,
      hasApiKey: true,
      sellerName: '测试别人店铺',
    };
    listShopLicenseEntitlements.mockResolvedValue([]);
    await expect(authorizeOzonShopSave(runtime, persistedShop)).rejects.toMatchObject({
      code: 'ADDITIONAL_SHOP_PREACTIVATION_REQUIRED',
    });
    expect(bindOwnedLicenseToOzonShop).not.toHaveBeenCalled();
  });

  it('binds the unassigned registration entitlement to the first shop', async () => {
    listShopLicenseEntitlements.mockResolvedValue([{
      license_id: 11,
      status: 'active',
      expire_time: future,
      shops: [],
    }]);
    await expect(authorizeOzonShopSave(runtime, shop)).resolves.toMatchObject({
      action: 'bound-existing',
      licenseId: 11,
    });
    expect(bindOwnedLicenseToOzonShop).toHaveBeenCalledWith(runtime, {
      licenseId: 11,
      shopId: 'client-100',
      shopName: '第一店',
    });
  });

  it('refuses to activate an additional shop from the ordinary save path', async () => {
    listShopLicenseEntitlements.mockResolvedValue([{
      license_id: 12,
      status: 'active',
      expire_time: future,
      shops: [{ shop_id: 'client-existing', status: 'active' }],
    }]);
    await expect(authorizeOzonShopSave(runtime, shop)).rejects.toMatchObject({
      code: 'ADDITIONAL_SHOP_PREACTIVATION_REQUIRED',
    });
    expect(activatePurchasedLicense).not.toHaveBeenCalled();
  });

  it('recognizes only an active unbound standard card as a pending additional-shop slot', () => {
    const pending = {
      license_id: 20,
      license_role: 'shop_standard_monthly',
      status: 'active',
      expire_time: future,
      shops: [],
    };
    expect(findPendingAdditionalShopLicense([
      { ...pending, license_id: 18, license_role: 'shop_intro' },
      { ...pending, license_id: 19, shops: [{ shop_id: 'bound', status: 'active' }] },
      pending,
    ])).toEqual(pending);
  });

  it('activates the card before exposing a new shop slot and verifies readback', async () => {
    listShopLicenseEntitlements
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        license_id: 21,
        license_role: 'shop_standard_annual',
        status: 'active',
        expire_time: future,
        shops: [],
      }]);
    await expect(
      authorizeAdditionalShopSlot(runtime, 'aaaa-bbbb-cccc-dddd'),
    ).resolves.toEqual({ action: 'activated', licenseId: 21 });
    expect(activatePurchasedLicense).toHaveBeenCalledWith(runtime, 'AAAA-BBBB-CCCC-DDDD');
  });

  it('resumes an already activated unbound card without consuming another card', async () => {
    listShopLicenseEntitlements.mockResolvedValue([{
      license_id: 22,
      license_role: 'shop_standard_monthly',
      status: 'active',
      expire_time: future,
      shops: [],
    }]);
    await expect(authorizeAdditionalShopSlot(runtime, '')).resolves.toEqual({
      action: 'resume-pending',
      licenseId: 22,
    });
    expect(activatePurchasedLicense).not.toHaveBeenCalled();
  });

  it('requires the dedicated renewal action when the exact shop license is expired', async () => {
    listShopLicenseEntitlements.mockResolvedValue([{
      license_id: 13,
      status: 'active',
      expire_time: past,
      shops: [{ shop_id: 'client-100', status: 'active' }],
    }]);
    await expect(authorizeOzonShopSave(runtime, shop)).rejects.toMatchObject({
      code: 'SHOP_LICENSE_RENEWAL_CARD_REQUIRED',
    });
    expect(renewPurchasedLicense).not.toHaveBeenCalled();
    expect(activatePurchasedLicense).not.toHaveBeenCalled();
  });

  it('renews the exact current shop license from the dedicated renewal action', async () => {
    listShopLicenseEntitlements.mockResolvedValue([{
      license_id: 41,
      status: 'active',
      expire_time: future,
      shops: [{ shop_id: 'client-100', status: 'active' }],
    }]);
    renewPurchasedLicense.mockResolvedValue({ expire: '2100-01-31T00:00:00Z' });

    await expect(
      renewOzonShopLicense(runtime, shop, 'aaaa-bbbb-cccc-dddd'),
    ).resolves.toEqual({
      action: 'renewed',
      licenseId: 41,
      expireAt: '2100-01-31T00:00:00Z',
    });
    expect(renewPurchasedLicense).toHaveBeenCalledWith(
      runtime,
      41,
      'AAAA-BBBB-CCCC-DDDD',
    );
    expect(activatePurchasedLicense).not.toHaveBeenCalled();
  });

  it('binds a pending dedicated shop card when the selected shop has no ledger', async () => {
    listShopLicenseEntitlements.mockResolvedValue([{
      license_id: 42,
      license_role: 'shop_standard_annual',
      status: 'active',
      expire_time: future,
      shops: [],
    }]);
    bindOwnedLicenseToOzonShop.mockResolvedValue({ expire: future });

    await expect(
      renewOzonShopLicense(runtime, shop, 'AAAA-BBBB-CCCC-DDDD'),
    ).resolves.toEqual({
      action: 'activated-and-bound',
      licenseId: 42,
      expireAt: future,
    });
    expect(renewPurchasedLicense).not.toHaveBeenCalled();
    expect(activatePurchasedLicense).not.toHaveBeenCalled();
    expect(bindOwnedLicenseToOzonShop).toHaveBeenCalledWith(runtime, {
      licenseId: 42,
      shopId: 'client-100',
      shopName: '第一店',
    });
  });

  it('activates and binds a new shop card instead of renewing an account-level license', async () => {
    listShopLicenseEntitlements
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        license_id: 43,
        license_role: 'shop_standard_monthly',
        status: 'active',
        expire_time: future,
        shops: [],
      }]);
    bindOwnedLicenseToOzonShop.mockResolvedValue({ expire_time: future });

    await expect(
      renewOzonShopLicense(runtime, shop, 'AAAA-BBBB-CCCC-DDDD'),
    ).resolves.toEqual({
      action: 'activated-and-bound',
      licenseId: 43,
      expireAt: future,
    });
    expect(activatePurchasedLicense).toHaveBeenCalledWith(
      runtime,
      'AAAA-BBBB-CCCC-DDDD',
    );
    expect(renewPurchasedLicense).not.toHaveBeenCalled();
  });

  it('explains a Client ID owned by another account in Chinese without renewing or consuming a new card', async () => {
    listShopLicenseEntitlements.mockResolvedValue([{
      license_id: 11,
      license_role: 'shop_standard_annual',
      status: 'active',
      expire_time: future,
      shops: [],
    }]);
    bindOwnedLicenseToOzonShop.mockRejectedValue(Object.assign(
      new Error('This shop is already assigned to another card'),
      { status: 409 },
    ));

    const saveError = await authorizeOzonShopSave(runtime, shop).catch((error) => error);
    expect(saveError.code).toBe('SHOP_BOUND_TO_ANOTHER_LICENSE');
    expect(saveError.message).toContain('Ozon Client ID client-100 已被其他账号的卡密绑定');
    expect(saveError.message).toContain('不需要续费');
    expect(saveError.message).not.toMatch(/already assigned/u);
    expect(isShopBoundElsewhereError(saveError)).toBe(true);

    const renewalError = await renewOzonShopLicense(runtime, shop, 'AAAA-BBBB-CCCC-DDDD').catch((error) => error);
    expect(renewalError.code).toBe('SHOP_BOUND_TO_ANOTHER_LICENSE');
    expect(activatePurchasedLicense).not.toHaveBeenCalled();
    expect(renewPurchasedLicense).not.toHaveBeenCalled();
  });

  it('keeps unrelated bind failures unchanged', async () => {
    listShopLicenseEntitlements.mockResolvedValue([{
      license_id: 11,
      status: 'active',
      expire_time: future,
      shops: [],
    }]);
    bindOwnedLicenseToOzonShop.mockRejectedValue(new Error('License not found'));
    await expect(authorizeOzonShopSave(runtime, shop)).rejects.toThrow('License not found');
    expect(isShopBoundElsewhereError(new Error('License not found'))).toBe(false);
  });

  it('defers sealed existing credentials to the main-process guard', async () => {
    await expect(authorizeOzonShopSave(runtime, { hasClientId: true })).resolves.toEqual({
      action: 'main-process-verification',
    });
    expect(listShopLicenseEntitlements).not.toHaveBeenCalled();
  });
});
