import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopAccessGate } from './DesktopAccessGate.jsx';
import {
  activatePurchasedLicense,
  beginFreshLicenseLogin,
  checkDesktopLicense,
  clearRememberedLicenseLogin,
  getCurrentLicenseAccount,
  getLicenseRuntime,
  getLicenseSession,
  getRememberedLicenseLogin,
  heartbeatDesktopLicense,
  listShopLicenseEntitlements,
  loginLicenseAccount,
  loginWithRememberedLicenseAccount,
  logoutLicenseAccount,
  registerLicenseAccount,
  renewPurchasedLicense,
  saveRememberedLicenseLogin,
} from '../services/licenseCenterClient.js';

vi.mock('../services/licenseCenterClient.js', () => ({
  activatePurchasedLicense: vi.fn(),
  beginFreshLicenseLogin: vi.fn(),
  checkDesktopLicense: vi.fn(),
  clearRememberedLicenseLogin: vi.fn(),
  getCurrentLicenseAccount: vi.fn(),
  getLicenseRuntime: vi.fn(),
  getLicenseSession: vi.fn(),
  getRememberedLicenseLogin: vi.fn(),
  heartbeatDesktopLicense: vi.fn(),
  listShopLicenseEntitlements: vi.fn(),
  loginLicenseAccount: vi.fn(),
  loginWithRememberedLicenseAccount: vi.fn(),
  logoutLicenseAccount: vi.fn(),
  registerLicenseAccount: vi.fn(),
  renewPurchasedLicense: vi.fn(),
  saveRememberedLicenseLogin: vi.fn(),
}));

const runtime = {
  projectCode: 'wangzai_desktop',
  deviceCode: 'desktop-device-001',
  version: '1.0.0',
};

describe('DesktopAccessGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    beginFreshLicenseLogin.mockResolvedValue({ ok: true });
    getLicenseRuntime.mockResolvedValue(runtime);
    getLicenseSession.mockResolvedValue({
      authenticated: true,
      authorized: true,
      user: { id: 1, email: 'demo@example.com' },
    });
    getRememberedLicenseLogin.mockResolvedValue({ remembered: false, email: '', persistent: true });
    getCurrentLicenseAccount.mockResolvedValue({ user: { id: 1, email: 'demo@example.com' } });
    heartbeatDesktopLicense.mockResolvedValue({ valid: true });
    listShopLicenseEntitlements.mockResolvedValue([]);
    checkDesktopLicense.mockResolvedValue({ valid: true });
    activatePurchasedLicense.mockResolvedValue({ valid: true });
    renewPurchasedLicense.mockResolvedValue({ valid: true });
    logoutLicenseAccount.mockResolvedValue({ ok: true });
    clearRememberedLicenseLogin.mockResolvedValue({ remembered: false, email: '', persistent: true });
    saveRememberedLicenseLogin.mockResolvedValue({ remembered: true, email: 'demo@example.com', persistent: true });
    Object.defineProperty(window, 'wangzaiDesktop', {
      configurable: true,
      value: { setWindowMode: vi.fn().mockResolvedValue({ ok: true }) },
    });
  });

  it('blocks the workspace until account login succeeds', async () => {
    loginLicenseAccount.mockResolvedValue({ user: { id: 1, email: 'demo@example.com' } });
    getLicenseSession.mockResolvedValue({
      authenticated: true,
      authorized: true,
      user: { id: 1, email: 'demo@example.com' },
    });

    render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );

    expect(await screen.findByRole('heading', { name: '欢迎回来' })).toBeInTheDocument();
    expect(screen.queryByText('业务工作台')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'demo@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'DesktopPass123!' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('业务工作台')).toBeInTheDocument();
    expect(loginLicenseAccount).toHaveBeenCalledWith(runtime, 'demo@example.com', 'DesktopPass123!');
    expect(window.wangzaiDesktop.setWindowMode).toHaveBeenLastCalledWith('workspace');
  });

  it('routes an expired account into the exact shop renewal flow', async () => {
    loginLicenseAccount.mockResolvedValue({ user: { id: 1, email: 'expired@example.com' } });
    checkDesktopLicense
      .mockRejectedValueOnce(Object.assign(new Error('License has expired'), { status: 403 }))
      .mockResolvedValue({ valid: true });
    listShopLicenseEntitlements.mockResolvedValue([{
      license_id: 42,
      plan_name: '月卡',
      status: 'active',
      expire_time: '2026-01-01T00:00:00Z',
      shops: [{ shop_id: 'client-expired', shop_name: '过期店铺', status: 'active' }],
    }]);

    render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );
    await screen.findByRole('heading', { name: '欢迎回来' });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'expired@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'DesktopPass123!' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('heading', { name: '续费店铺授权' })).toBeInTheDocument();
    expect(screen.getByText('当前店铺授权已到期，请选择店铺并输入月卡或年卡续费。')).toBeInTheDocument();
    expect(screen.queryByText('业务工作台')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('续费卡密'), { target: { value: 'aaaa-bbbb-cccc-dddd' } });
    fireEvent.click(screen.getByRole('button', { name: '续费并进入' }));

    expect(await screen.findByText('业务工作台')).toBeInTheDocument();
    expect(renewPurchasedLicense).toHaveBeenCalledWith(runtime, 42, 'AAAA-BBBB-CCCC-DDDD');
    expect(loginLicenseAccount).toHaveBeenCalledTimes(1);
    expect(checkDesktopLicense).toHaveBeenCalledTimes(2);
  });

  it('registers a new account and enters the workspace directly', async () => {
    registerLicenseAccount.mockResolvedValue({ user: { id: 2, email: 'new@example.com' } });
    getLicenseSession.mockResolvedValue({
      authenticated: true,
      authorized: true,
      user: { id: 2, email: 'new@example.com' },
    });

    render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );
    await screen.findByRole('heading', { name: '欢迎回来' });
    fireEvent.click(screen.getByRole('button', { name: '注册账号' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'DesktopPass123!' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'DesktopPass123!' } });
    fireEvent.change(screen.getByLabelText('激活卡密'), { target: { value: 'aaaa-bbbb-cccc-dddd' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并激活' }));

    await waitFor(() => expect(screen.getByText('业务工作台')).toBeInTheDocument());
    expect(registerLicenseAccount).toHaveBeenCalledWith(runtime, {
      password: 'DesktopPass123!',
      email: 'new@example.com',
      cardKey: 'AAAA-BBBB-CCCC-DDDD',
    });
    expect(checkDesktopLicense).toHaveBeenCalledWith(runtime);
  });

  it('does not create an account until a management card is provided', async () => {
    render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );
    await screen.findByRole('heading', { name: '欢迎回来' });
    fireEvent.click(screen.getByRole('button', { name: '注册账号' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'DesktopPass123!' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'DesktopPass123!' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并激活' }));

    expect(await screen.findByText('请输入管理系统发放的 16 位卡密。')).toBeInTheDocument();
    expect(registerLicenseAccount).not.toHaveBeenCalled();
  });

  it('routes an existing account without a license into card activation and enters after activation', async () => {
    loginLicenseAccount.mockResolvedValue({ user: { id: 4, email: 'legacy@example.com' } });
    checkDesktopLicense
      .mockRejectedValueOnce(Object.assign(new Error('License not found'), { status: 404 }))
      .mockResolvedValue({ valid: true });
    getLicenseSession.mockResolvedValue({
      authenticated: true,
      authorized: true,
      user: { id: 4, email: 'legacy@example.com' },
    });

    render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );
    await screen.findByRole('heading', { name: '欢迎回来' });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'legacy@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'DesktopPass123!' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('heading', { name: '激活软件授权' })).toBeInTheDocument();
    expect(screen.getByText('当前账号尚未激活，请输入管理系统发放的卡密。')).toBeInTheDocument();
    expect(screen.queryByText('License not found')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('激活卡密'), { target: { value: 'aaaa-bbbb-cccc-dddd' } });
    fireEvent.click(screen.getByRole('button', { name: '激活并进入' }));

    expect(await screen.findByText('业务工作台')).toBeInTheDocument();
    expect(activatePurchasedLicense).toHaveBeenCalledWith(runtime, 'AAAA-BBBB-CCCC-DDDD');
    expect(checkDesktopLicense).toHaveBeenCalledTimes(2);
  });

  it('never restores a persisted session and requires a fresh login after reopening', async () => {
    getLicenseSession.mockResolvedValue({
      authenticated: true,
      authorized: true,
      user: { id: 4, email: 'legacy@example.com' },
    });

    render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );

    expect(await screen.findByRole('heading', { name: '欢迎回来' })).toBeInTheDocument();
    expect(screen.queryByText('业务工作台')).not.toBeInTheDocument();
    expect(beginFreshLicenseLogin).toHaveBeenCalledTimes(1);
    expect(getCurrentLicenseAccount).not.toHaveBeenCalled();
    expect(checkDesktopLicense).not.toHaveBeenCalled();
  });

  it('hides a preserved workspace immediately while a fresh desktop login is being prepared', async () => {
    let finishReset;
    beginFreshLicenseLogin.mockImplementation(() => new Promise((resolve) => {
      finishReset = resolve;
    }));

    render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );

    expect(screen.queryByText('业务工作台')).not.toBeInTheDocument();
    expect(await screen.findByText('正在确认登录状态')).toBeInTheDocument();
    finishReset({ ok: true });
    expect(await screen.findByRole('heading', { name: '欢迎回来' })).toBeInTheDocument();
    expect(screen.queryByText('业务工作台')).not.toBeInTheDocument();
  });

  it('opens the isolated dashboard visual fixture only when the runtime explicitly disables licensing', async () => {
    Object.defineProperty(window, 'wangzaiDesktop', {
      configurable: true,
      value: {
        setWindowMode: vi.fn().mockResolvedValue({ ok: true }),
        captureDashboardVisual: vi.fn(),
      },
    });
    getLicenseRuntime.mockResolvedValue({ ...runtime, mode: 'off' });

    render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );

    expect(await screen.findByText('业务工作台')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '欢迎回来' })).not.toBeInTheDocument();
    expect(window.wangzaiDesktop.setWindowMode).toHaveBeenLastCalledWith('workspace');
    expect(heartbeatDesktopLicense).not.toHaveBeenCalled();
  });

  it('never lets the dashboard visual flag bypass an enforce runtime', async () => {
    Object.defineProperty(window, 'wangzaiDesktop', {
      configurable: true,
      value: {
        setWindowMode: vi.fn().mockResolvedValue({ ok: true }),
        captureDashboardVisual: vi.fn(),
      },
    });
    getLicenseRuntime.mockResolvedValue({ ...runtime, mode: 'enforce' });

    render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );

    expect(await screen.findByRole('heading', { name: '欢迎回来' })).toBeInTheDocument();
    expect(screen.queryByText('业务工作台')).not.toBeInTheDocument();
  });

  it('renews the online authorization immediately after entering the workspace', async () => {
    loginLicenseAccount.mockResolvedValue({ user: { id: 1, email: 'demo@example.com' } });

    render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );
    await screen.findByRole('heading', { name: '欢迎回来' });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'demo@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'DesktopPass123!' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('业务工作台')).toBeInTheDocument();
    await waitFor(() => expect(heartbeatDesktopLicense).toHaveBeenCalledWith(runtime));
    expect(getCurrentLicenseAccount).toHaveBeenCalled();
  });

  it('keeps the workspace during a temporary heartbeat network failure while the grant is fresh', async () => {
    loginLicenseAccount.mockResolvedValue({ user: { id: 1, email: 'demo@example.com' } });
    heartbeatDesktopLicense.mockRejectedValue(Object.assign(new Error('无法连接授权服务'), { status: 0 }));

    render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );
    await screen.findByRole('heading', { name: '欢迎回来' });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'demo@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'DesktopPass123!' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('业务工作台')).toBeInTheDocument();
    await waitFor(() => expect(heartbeatDesktopLicense).toHaveBeenCalled());
    expect(screen.queryByText('欢迎回来')).not.toBeInTheDocument();
  });

  it('keeps the workspace when the license server is overloaded while the grant is fresh', async () => {
    loginLicenseAccount.mockResolvedValue({ user: { id: 1, email: 'demo@example.com' } });
    heartbeatDesktopLicense.mockRejectedValue(Object.assign(new Error('Service Unavailable'), { status: 503 }));

    render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );
    await screen.findByRole('heading', { name: '欢迎回来' });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'demo@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'DesktopPass123!' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('业务工作台')).toBeInTheDocument();
    await waitFor(() => expect(heartbeatDesktopLicense).toHaveBeenCalled());
    await waitFor(() => expect(getLicenseSession).toHaveBeenCalled());
    expect(screen.queryByText('欢迎回来')).not.toBeInTheDocument();
  });

  it('returns to login when the heartbeat confirms that authorization is invalid', async () => {
    loginLicenseAccount.mockResolvedValue({ user: { id: 1, email: 'demo@example.com' } });
    heartbeatDesktopLicense.mockRejectedValue(Object.assign(new Error('License has expired'), { status: 403 }));
    getLicenseSession
      .mockResolvedValueOnce({
        authenticated: true,
        authorized: true,
        user: { id: 1, email: 'demo@example.com' },
      })
      .mockResolvedValue({ authenticated: true, authorized: false, user: { id: 1, email: 'demo@example.com' } });

    render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );
    await screen.findByRole('heading', { name: '欢迎回来' });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'demo@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'DesktopPass123!' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('授权已到期，请联系管理员续费后再登录。')).toBeInTheDocument();
    expect(screen.queryByText('业务工作台')).not.toBeInTheDocument();
  });

  it('loads remembered account metadata without exposing the saved password to the renderer', async () => {
    getRememberedLicenseLogin.mockResolvedValue({
      remembered: true,
      email: 'saved@example.com',
      persistent: true,
    });
    loginWithRememberedLicenseAccount.mockResolvedValue({
      user: { id: 8, email: 'saved@example.com' },
    });
    getLicenseSession.mockResolvedValue({
      authenticated: true,
      authorized: true,
      user: { id: 8, email: 'saved@example.com' },
    });

    render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );

    expect(await screen.findByDisplayValue('saved@example.com')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '记住账号和密码' })).toBeChecked();
    expect(screen.getByLabelText('密码')).toHaveValue('••••••••••••');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('业务工作台')).toBeInTheDocument();
    expect(loginWithRememberedLicenseAccount).toHaveBeenCalledTimes(1);
    expect(loginLicenseAccount).not.toHaveBeenCalled();
  });

  it('encrypts credentials only after a checked manual login succeeds', async () => {
    loginLicenseAccount.mockResolvedValue({ user: { id: 1, email: 'demo@example.com' } });

    render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );
    await screen.findByRole('heading', { name: '欢迎回来' });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'demo@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'DesktopPass123!' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '记住账号和密码' }));
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('业务工作台')).toBeInTheDocument();
    expect(saveRememberedLicenseLogin).toHaveBeenCalledWith(
      'demo@example.com',
      'DesktopPass123!',
    );
  });

  it('clears a remembered secret immediately when the option is unchecked', async () => {
    getRememberedLicenseLogin.mockResolvedValue({
      remembered: true,
      email: 'saved@example.com',
      persistent: true,
    });

    render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );
    const checkbox = await screen.findByRole('checkbox', { name: '记住账号和密码' });
    fireEvent.click(checkbox);

    expect(checkbox).not.toBeChecked();
    expect(screen.getByLabelText('密码')).toHaveValue('');
    expect(clearRememberedLicenseLogin).toHaveBeenCalledTimes(1);
  });

  it('uses the animated character login experience with the 旺崽助手 brand', async () => {
    const { container } = render(
      <DesktopAccessGate>
        <div>业务工作台</div>
      </DesktopAccessGate>
    );
    await screen.findByRole('heading', { name: '欢迎回来' });
    expect(screen.getByText('旺崽助手')).toBeInTheDocument();
    expect(screen.getByText('使用注册邮箱登录旺崽助手')).toBeInTheDocument();
    const characters = container.querySelector('.desktop-access-characters');
    expect(characters).toBeInTheDocument();
    expect(characters).toHaveAttribute('data-typing', 'true');
    fireEvent.blur(screen.getByLabelText('邮箱'));
    expect(characters).toHaveAttribute('data-typing', 'false');
    fireEvent.focus(screen.getByLabelText('密码'));
    expect(characters).toHaveAttribute('data-typing', 'true');
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'DesktopPass123!' } });
    fireEvent.click(screen.getByRole('button', { name: '显示密码' }));
    expect(characters).toHaveAttribute('data-password-visible', 'true');
    expect(container.querySelector('.desktop-access-character-purple')).toBeInTheDocument();
    expect(container.querySelector('.desktop-access-terminal')).not.toBeInTheDocument();
  });
});
