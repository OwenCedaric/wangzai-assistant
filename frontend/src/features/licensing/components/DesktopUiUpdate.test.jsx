import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopAccountMenu } from './DesktopAccountMenu.jsx';
import { DesktopAuthProvider } from '../model/DesktopAuthContext.jsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup(enabled, result) {
  const reload = vi.fn();
  const check = vi.fn(async () => result);
  vi.stubGlobal('wangzaiDesktop', { uiUpdates: { status: async () => ({ enabled }), check }, reloadWindow: reload });
  render(<DesktopAuthProvider value={{ session: { user: { email: 'fixture@example.test' } }, logout: async () => {} }}><DesktopAccountMenu /></DesktopAuthProvider>);
  return { check, reload };
}
it('keeps the current client menu unchanged when updates are disabled', async () => {
  setup(false);
  fireEvent.click(screen.getByLabelText('打开账户菜单'));
  await screen.findByText('退出登录');
  expect(screen.queryByText('检查软件更新')).toBeNull();
});
it('keeps the result dialog after closing the menu and never restarts a running order workflow', async () => {
  const { check, reload } = setup(true, { ok: true, state: 'staged' });
  fireEvent.click(screen.getByLabelText('打开账户菜单'));
  fireEvent.click(await screen.findByText('检查软件更新'));
  await screen.findByText(/更新已下载并验证/);
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(check).toHaveBeenCalledTimes(1); expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('知道了'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
it('shows failure without claiming the new version has been applied', async () => {
  setup(true, { ok: false, code: 'UI_UPDATE_SIGNATURE_INVALID' });
  fireEvent.click(screen.getByLabelText('打开账户菜单'));
  fireEvent.click(await screen.findByText('检查软件更新'));
  await screen.findByText(/更新未应用，继续使用当前版本/);
  expect(screen.queryByText(/更新已下载并验证/)).toBeNull();
});
