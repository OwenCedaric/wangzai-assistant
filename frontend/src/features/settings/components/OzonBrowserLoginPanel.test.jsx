import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OzonBrowserLoginPanel } from './OzonBrowserLoginPanel.jsx';

const browserService = vi.hoisted(() => ({
  openOzonBrowserLogin: vi.fn(),
  waitForOzonBrowserLogin: vi.fn(),
  hideOzonBrowserLogin: vi.fn(),
}));
const dataService = vi.hoisted(() => ({
  waitForOzonBrowserDataObserver: vi.fn(),
}));

vi.mock('../services/ozonBrowserLoginService.js', () => browserService);
vi.mock('../services/ozonBrowserDataService.js', () => dataService);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

describe('OzonBrowserLoginPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browserService.openOzonBrowserLogin.mockResolvedValue({ tab: { tabId: 'tab-ozon' } });
    browserService.waitForOzonBrowserLogin.mockResolvedValue({
      result: {
        loggedIn: true,
        cookieSaved: true,
        cookieCount: 6,
        verifiedAt: '2026-07-21T08:00:00.000Z',
      },
    });
    browserService.hideOzonBrowserLogin.mockResolvedValue({ ok: true });
    dataService.waitForOzonBrowserDataObserver.mockResolvedValue({
      result: {
        installed: true,
        enabled: true,
        ready: true,
        extensionVersion: '2.0.0',
      },
    });
  });

  it('saves a stable profile before login and hides the browser only after verified connection state is saved', async () => {
    const onEnsureProfile = vi.fn().mockResolvedValue({ id: 'integration-ozon-a' });
    const onConnected = vi.fn().mockResolvedValue({ id: 'integration-ozon-a' });
    render(
      <OzonBrowserLoginPanel
        onEnsureProfile={onEnsureProfile}
        onConnected={onConnected}
      />
    );

    const loginButton = screen.getByRole('button', { name: '打开 Ozon 登录' });
    expect(loginButton).toHaveStyle({ minWidth: '176px', whiteSpace: 'nowrap' });
    fireEvent.click(loginButton);

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(onEnsureProfile).toHaveBeenCalledTimes(1);
    expect(browserService.openOzonBrowserLogin).toHaveBeenCalledWith({ profileId: 'integration-ozon-a' });
    expect(dataService.waitForOzonBrowserDataObserver).toHaveBeenCalledWith(expect.objectContaining({
      tabId: 'tab-ozon',
      timeoutMs: 15000,
    }));
    expect(browserService.hideOzonBrowserLogin).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/登录窗口已自动关闭/u)).toBeInTheDocument();
    expect(screen.getByText('已启用 v2.0.0')).toBeInTheDocument();
  });

  it('still saves login state and closes the browser when the data observer is slow', async () => {
    dataService.waitForOzonBrowserDataObserver.mockRejectedValue(
      Object.assign(new Error('observer timeout'), { code: 'OZON_DATA_OBSERVER_NOT_READY' }),
    );
    const onEnsureProfile = vi.fn().mockResolvedValue({ id: 'integration-ozon-a' });
    const onConnected = vi.fn().mockResolvedValue({ id: 'integration-ozon-a' });
    render(
      <OzonBrowserLoginPanel
        onEnsureProfile={onEnsureProfile}
        onConnected={onConnected}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '打开 Ozon 登录' }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        loggedIn: true,
        cookieSaved: true,
        dataObserver: null,
      }),
    }));
    expect(browserService.hideOzonBrowserLogin).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/登录窗口已自动关闭/u)).toBeInTheDocument();
    expect(screen.getByText('登录已保存，观察器待就绪')).toBeInTheDocument();
  });

  it('supports shop-setting labels without changing the verified Cookie workflow', async () => {
    const onEnsureProfile = vi.fn().mockResolvedValue({ id: 'seller-shop-2' });
    const onConnected = vi.fn().mockResolvedValue({ id: 'seller-shop-2' });
    render(
      <OzonBrowserLoginPanel
        title="Ozon 卖家后台登录"
        description="Ozon 2店使用独立 Cookie。"
        loginButtonLabel="登录卖家后台"
        reloginButtonLabel="重新登录卖家后台"
        requireCompanyIdentity
        onEnsureProfile={onEnsureProfile}
        onConnected={onConnected}
      />
    );

    expect(screen.getByText('Ozon 卖家后台登录')).toBeInTheDocument();
    expect(screen.getByText('Ozon 2店使用独立 Cookie。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '登录卖家后台' }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(browserService.openOzonBrowserLogin).toHaveBeenCalledWith({ profileId: 'seller-shop-2' });
    expect(browserService.waitForOzonBrowserLogin).toHaveBeenCalledWith(expect.objectContaining({
      requireCompanyIdentity: true,
    }));
    expect(browserService.hideOzonBrowserLogin).toHaveBeenCalledTimes(1);
  });

  it('lets the operator reopen or cancel a pending login instead of locking the panel', async () => {
    browserService.waitForOzonBrowserLogin.mockImplementation(({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('cancelled');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    const onEnsureProfile = vi.fn().mockResolvedValue({ id: 'seller-shop-1' });
    const onConnected = vi.fn();
    render(
      <OzonBrowserLoginPanel
        requireCompanyIdentity
        onEnsureProfile={onEnsureProfile}
        onConnected={onConnected}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '打开 Ozon 登录' }));

    const revealButton = await screen.findByRole('button', { name: '重新显示登录窗口' });
    expect(revealButton).toBeEnabled();
    expect(screen.getByRole('button', { name: '取消等待' })).toBeEnabled();
    expect(screen.getByText(/登录窗口已打开/u)).toBeInTheDocument();

    fireEvent.click(revealButton);
    await waitFor(() => expect(browserService.openOzonBrowserLogin).toHaveBeenCalledTimes(2));
    expect(browserService.openOzonBrowserLogin).toHaveBeenLastCalledWith({ profileId: 'seller-shop-1' });
    expect(await screen.findByText(/登录窗口已重新显示/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '取消等待' }));
    await waitFor(() => expect(browserService.hideOzonBrowserLogin).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/已取消本次登录等待/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开 Ozon 登录' })).toBeEnabled();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('does not save or hide a new login when a cancelled native status request resolves late', async () => {
    const cancelledStatus = deferred();
    const currentStatus = deferred();
    browserService.waitForOzonBrowserLogin
      .mockImplementationOnce(() => cancelledStatus.promise)
      .mockImplementationOnce(() => currentStatus.promise);
    const onEnsureProfile = vi.fn()
      .mockResolvedValueOnce({ id: 'seller-old' })
      .mockResolvedValueOnce({ id: 'seller-current' });
    const onConnected = vi.fn();
    render(<OzonBrowserLoginPanel onEnsureProfile={onEnsureProfile} onConnected={onConnected} />);
    fireEvent.click(screen.getByRole('button', { name: '打开 Ozon 登录' }));
    fireEvent.click(await screen.findByRole('button', { name: '取消等待' }));
    await screen.findByText(/已取消本次登录等待/u);
    fireEvent.click(screen.getByRole('button', { name: '打开 Ozon 登录' }));
    await waitFor(() => expect(browserService.waitForOzonBrowserLogin).toHaveBeenCalledTimes(2));

    await act(async () => {
      cancelledStatus.resolve({ result: { loggedIn: true, cookieSaved: true } });
    });

    expect(onConnected).not.toHaveBeenCalled();
    expect(dataService.waitForOzonBrowserDataObserver).not.toHaveBeenCalled();
    expect(browserService.hideOzonBrowserLogin).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '重新显示登录窗口' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新显示登录窗口' }));
    await waitFor(() => expect(browserService.openOzonBrowserLogin).toHaveBeenLastCalledWith({ profileId: 'seller-current' }));
  });

  it('does not open a native window after the panel unmounts while saving its profile', async () => {
    const pendingProfile = deferred();
    const onConnected = vi.fn();
    const panel = render(<OzonBrowserLoginPanel onEnsureProfile={() => pendingProfile.promise} onConnected={onConnected} />);
    fireEvent.click(screen.getByRole('button', { name: '打开 Ozon 登录' }));
    panel.unmount();

    await act(async () => { pendingProfile.resolve({ id: 'seller-old' }); });

    expect(browserService.openOzonBrowserLogin).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    expect(browserService.hideOzonBrowserLogin).not.toHaveBeenCalled();
  });

  it.each(['open', 'observer', 'save'])('does not continue a login after unmount during %s', async (stage) => {
    const pending = deferred();
    const onConnected = vi.fn().mockResolvedValue({ id: 'seller-old' });
    if (stage === 'open') browserService.openOzonBrowserLogin.mockImplementationOnce(() => pending.promise);
    if (stage === 'observer') dataService.waitForOzonBrowserDataObserver.mockImplementationOnce(() => pending.promise);
    if (stage === 'save') onConnected.mockImplementationOnce(() => pending.promise);
    const panel = render(<OzonBrowserLoginPanel onEnsureProfile={async () => ({ id: 'seller-old' })} onConnected={onConnected} />);
    fireEvent.click(screen.getByRole('button', { name: '打开 Ozon 登录' }));
    await waitFor(() => {
      if (stage === 'open') expect(browserService.openOzonBrowserLogin).toHaveBeenCalledTimes(1);
      if (stage === 'observer') expect(dataService.waitForOzonBrowserDataObserver).toHaveBeenCalledTimes(1);
      if (stage === 'save') expect(onConnected).toHaveBeenCalledTimes(1);
    });
    panel.unmount();
    await act(async () => { pending.resolve({ tab: { tabId: 'tab-old' }, result: { ready: true } }); });

    if (stage === 'open') expect(browserService.waitForOzonBrowserLogin).not.toHaveBeenCalled();
    expect(onConnected).toHaveBeenCalledTimes(stage === 'save' ? 1 : 0);
    expect(browserService.hideOzonBrowserLogin).not.toHaveBeenCalled();
  });

  it('ignores a cancelled reveal failure after a new login starts', async () => {
    const reveal = deferred();
    browserService.openOzonBrowserLogin.mockResolvedValueOnce({ tab: { tabId: 'tab-old' } })
      .mockImplementationOnce(() => reveal.promise)
      .mockResolvedValueOnce({ tab: { tabId: 'tab-current' } });
    browserService.waitForOzonBrowserLogin.mockImplementation(() => new Promise(() => {}));
    render(<OzonBrowserLoginPanel onEnsureProfile={async () => ({ id: 'seller-one' })} />);
    fireEvent.click(screen.getByRole('button', { name: '打开 Ozon 登录' }));
    fireEvent.click(await screen.findByRole('button', { name: '重新显示登录窗口' }));
    fireEvent.click(screen.getByRole('button', { name: '取消等待' }));
    fireEvent.click(await screen.findByRole('button', { name: '打开 Ozon 登录' }));
    await waitFor(() => expect(browserService.waitForOzonBrowserLogin).toHaveBeenCalledTimes(2));
    await act(async () => { reveal.reject(Object.assign(new Error('old window gone'), { code: 'PURCHASE_BROWSER_CEF_PROCESS_EXITED' })); });

    expect(screen.getByRole('button', { name: '重新显示登录窗口' })).toBeInTheDocument();
    expect(screen.queryByText('连接失败')).not.toBeInTheDocument();
    expect(screen.queryByText(/内置浏览器意外退出/u)).not.toBeInTheDocument();
  });
});
