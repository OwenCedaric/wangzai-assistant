import { describe, expect, it, vi } from 'vitest';
import {
  completeOzonShopSellerLogin,
  ensureOzonShopSellerLoginProfile,
  isOzonShopSellerLoginConnected,
  readOzonShopSellerLoginProfile,
  selectExactOzonShopSellerLoginProfile,
} from './ozonShopSellerLoginService.js';

describe('ozonShopSellerLoginService', () => {
  it('selects only the exact shop browser profile', () => {
    const profiles = [
      { id: 'seller-a', integrationType: 'ozon-browser-session', shopId: 'shop-a' },
      { id: 'seller-b', integrationType: 'ozon-browser-session', shopId: 'shop-b' },
      { id: 'front', integrationType: 'ozon-follow-seller-session', shopId: '' },
    ];
    expect(selectExactOzonShopSellerLoginProfile(profiles, 'shop-b')?.id).toBe('seller-b');
    expect(selectExactOzonShopSellerLoginProfile(profiles, 'shop-c')).toBeNull();
  });

  it('reuses an existing exact profile instead of creating another Cookie context', async () => {
    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{
        id: 'seller-shop-1',
        integrationType: 'ozon-browser-session',
        shopId: 'shop-1',
        configStatus: '连接成功',
        tokenStatus: 'Cookie 已保存',
        identityStatus: 'verified',
      }],
    });
    const saveProfile = vi.fn();
    const profile = await ensureOzonShopSellerLoginProfile(
      { shopId: 'shop-1', shopName: 'Ozon 1店' },
      { listProfiles, saveProfile },
    );
    expect(profile.id).toBe('seller-shop-1');
    expect(isOzonShopSellerLoginConnected(profile)).toBe(true);
    expect(saveProfile).not.toHaveBeenCalled();
  });

  it('creates a new seller profile with the exact shop binding', async () => {
    const listProfiles = vi.fn().mockResolvedValue({ profiles: [] });
    const saveProfile = vi.fn().mockImplementation(async (payload) => ({
      profile: { id: 'seller-shop-2', ...payload },
    }));
    const profile = await ensureOzonShopSellerLoginProfile(
      { shopId: 'shop-2', shopName: 'Ozon 2店' },
      { listProfiles, saveProfile },
    );
    expect(profile).toMatchObject({
      id: 'seller-shop-2',
      integrationType: 'ozon-browser-session',
      shopId: 'shop-2',
      configStatus: '待登录',
      tokenStatus: 'Cookie 未保存',
    });
    expect(saveProfile).toHaveBeenCalledWith(expect.objectContaining({
      shopId: 'shop-2',
      note: expect.stringContaining('独立浏览器 Profile/RequestContext 和 Cookie'),
    }), expect.any(Object));
  });

  it('connects only after the browser company id and exact shop API identity match', async () => {
    const verifyIdentity = vi.fn().mockResolvedValue({
      connected: true,
      identityMatched: true,
      profile: {
        id: 'seller-shop-3',
        shopId: 'shop-3',
        configStatus: '连接成功',
        tokenStatus: 'Cookie 已保存',
        browserCompanyId: '4616153',
        apiIdentityId: '4616153',
        identityStatus: 'verified',
      },
    });
    const profile = await completeOzonShopSellerLogin({
      profile: { id: 'seller-shop-3', shopId: 'shop-3' },
      shopId: 'shop-3',
      shopName: 'Ozon 3店',
      result: {
        loggedIn: true,
        cookieSaved: true,
        identityStatus: 'browser-matched',
        profile: { id: 'seller-shop-3', shopId: 'shop-3', browserCompanyId: '4616153' },
      },
    }, { verifyIdentity });
    expect(profile).toMatchObject({
      id: 'seller-shop-3',
      shopId: 'shop-3',
      configStatus: '连接成功',
      tokenStatus: 'Cookie 已保存',
      identityStatus: 'verified',
    });
    expect(verifyIdentity).toHaveBeenCalledWith('seller-shop-3', 'shop-3', expect.any(Object));
    await expect(completeOzonShopSellerLogin({
      profile: { id: 'seller-shop-3', shopId: 'shop-3' },
      shopId: 'shop-2',
      result: { loggedIn: true, cookieSaved: true },
    }, { verifyIdentity })).rejects.toThrow('与当前店铺不一致');
  });

  it('fails closed when the browser account and API identity do not match', async () => {
    await expect(completeOzonShopSellerLogin({
      profile: { id: 'seller-shop-4', shopId: 'shop-4' },
      shopId: 'shop-4',
      result: {
        loggedIn: true,
        cookieSaved: true,
        identityStatus: 'mismatch',
        profile: { browserCompanyId: '111', apiIdentityId: '222' },
      },
    }, { verifyIdentity: vi.fn() })).rejects.toThrow(/111.*222/u);
  });

  it('reads the exact shop from the local profile list', async () => {
    const listProfiles = vi.fn().mockResolvedValue({ profiles: [
      { id: 'seller-a', integrationType: 'ozon-browser-session', shopId: 'shop-a' },
      { id: 'seller-b', integrationType: 'ozon-browser-session', shopId: 'shop-b' },
    ] });
    const profile = await readOzonShopSellerLoginProfile(
      { shopId: 'shop-b' },
      { listProfiles },
    );
    expect(profile?.id).toBe('seller-b');
  });
});
