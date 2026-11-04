import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OzonShopSellerLoginPanel } from './OzonShopSellerLoginPanel.jsx';

const service = vi.hoisted(() => ({
  readOzonShopSellerLoginProfile: vi.fn(),
  ensureOzonShopSellerLoginProfile: vi.fn(),
  completeOzonShopSellerLogin: vi.fn(),
  isOzonShopSellerLoginConnected: vi.fn((profile) => (
    profile?.configStatus === '连接成功'
      && profile?.tokenStatus === 'Cookie 已保存'
      && profile?.identityStatus === 'verified'
  )),
}));

vi.mock('../services/ozonShopSellerLoginService.js', () => service);
vi.mock('./OzonBrowserLoginPanel.jsx', () => ({
  OzonBrowserLoginPanel: ({
    connected,
    description,
    loginButtonLabel,
    reloginButtonLabel,
    onEnsureProfile,
    onConnected,
  }) => (
    <section>
      <div>{description}</div>
      <div>{connected ? 'Cookie 已连接' : 'Cookie 未连接'}</div>
      <button
        type="button"
        onClick={async () => {
          const profile = await onEnsureProfile();
          await onConnected({ profile, result: { loggedIn: true, cookieSaved: true } });
        }}
      >
        {connected ? reloginButtonLabel : loginButtonLabel}
      </button>
    </section>
  ),
}));

describe('OzonShopSellerLoginPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.readOzonShopSellerLoginProfile.mockImplementation(async ({ shopId }) => (
      shopId === 'shop-a'
        ? {
            id: 'seller-shop-a',
            shopId: 'shop-a',
            configStatus: '连接成功',
            tokenStatus: 'Cookie 已保存',
            browserCompanyId: '4616153',
            apiIdentityId: '4616153',
            identityStatus: 'verified',
          }
        : null
    ));
    service.ensureOzonShopSellerLoginProfile.mockImplementation(async ({ shopId }) => ({
      id: `seller-${shopId}`,
      shopId,
      configStatus: '待登录',
      tokenStatus: 'Cookie 未保存',
    }));
    service.completeOzonShopSellerLogin.mockImplementation(async ({ profile, shopId }) => ({
      ...profile,
      shopId,
      configStatus: '连接成功',
      tokenStatus: 'Cookie 已保存',
      browserCompanyId: '4616153',
      apiIdentityId: '4616153',
      identityStatus: 'verified',
    }));
  });

  it('switches the displayed Cookie state and login action by exact shop id', async () => {
    const { rerender } = render(
      <OzonShopSellerLoginPanel activeShop={{
        id: 'shop-a',
        shopAlias: 'Ozon 1店',
        licenseAuthorizationStatus: 'active',
        licenseAuthorized: true,
      }} />
    );
    await waitFor(() => expect(screen.getByText('Cookie 已连接')).toBeInTheDocument());
    expect(screen.getByText(/已自动对应.*4616153.*4616153/u)).toBeInTheDocument();
    expect(screen.getByTestId('ozon-shop-seller-login')).toHaveAttribute('data-shop-id', 'shop-a');
    expect(screen.getByText(/Ozon 1店.*独立浏览器配置和 Cookie/u)).toBeInTheDocument();

    rerender(<OzonShopSellerLoginPanel activeShop={{
      id: 'shop-b',
      shopAlias: 'Ozon 2店',
      licenseAuthorizationStatus: 'active',
      licenseAuthorized: true,
    }} />);
    await waitFor(() => expect(screen.getByText('Cookie 未连接')).toBeInTheDocument());
    expect(screen.getByTestId('ozon-shop-seller-login')).toHaveAttribute('data-shop-id', 'shop-b');
    fireEvent.click(screen.getByRole('button', { name: '登录卖家后台' }));

    await waitFor(() => expect(service.completeOzonShopSellerLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ id: 'seller-shop-b', shopId: 'shop-b' }),
        shopId: 'shop-b',
        shopName: 'Ozon 2店',
      })
    ));
    expect(service.ensureOzonShopSellerLoginProfile).toHaveBeenCalledWith({
      shopId: 'shop-b',
      shopName: 'Ozon 2店',
    });
  });

  it('does not expose or read Seller login state before the exact shop card is active', async () => {
    render(
      <OzonShopSellerLoginPanel activeShop={{
        id: 'shop-unlicensed',
        shopAlias: '未授权店铺',
        licenseAuthorizationStatus: 'missing',
        licenseAuthorized: false,
      }} />
    );

    expect(screen.getByTestId('ozon-shop-seller-license-required')).toHaveTextContent(
      '当前店铺尚未绑定有效卡密'
    );
    expect(screen.queryByRole('button', { name: /登录卖家后台/u })).not.toBeInTheDocument();
    expect(service.readOzonShopSellerLoginProfile).not.toHaveBeenCalled();
    expect(service.ensureOzonShopSellerLoginProfile).not.toHaveBeenCalled();
  });
});
