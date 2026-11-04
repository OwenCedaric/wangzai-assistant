import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MinimizedTaskBar } from '../../shared/ui/minimizedTasks/MinimizedTaskBar.jsx';
import { MinimizedTaskProvider } from '../../shared/ui/minimizedTasks/MinimizedTaskProvider.jsx';

const mocks = vi.hoisted(() => ({
  getProfileSetting: vi.fn(),
  listModelApiAccounts: vi.fn(),
  loadIntegrationState: vi.fn(),
}));

vi.mock('../../api/localApiClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getProfileSetting: mocks.getProfileSetting,
  listModelApiAccounts: mocks.listModelApiAccounts,
}));

vi.mock('./services/smartToolIntegrationProfileService.js', () => ({
  loadSmartToolIntegrationState: mocks.loadIntegrationState,
}));

import { PromptLibraryPage } from './PromptLibraryPage.jsx';

function useButtonForTool(title) {
  const card = screen.getByText(title, { selector: 'h6' }).closest('article');
  expect(card).toBeTruthy();
  return within(card)
    .getAllByRole('button')
    .find((button) => button.textContent !== '编辑 Skill');
}

function minimizeButton(dialog) {
  return within(dialog)
    .getAllByRole('button')
    .find((button) => String(button.getAttribute('aria-label') || '').startsWith('最小化'));
}

describe('PromptLibraryPage minimized run sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProfileSetting.mockResolvedValue({ setting: null });
    mocks.listModelApiAccounts.mockResolvedValue({ accounts: [] });
    mocks.loadIntegrationState.mockResolvedValue({
      integrationTypes: [],
      hasThirdPartyToolAccount: false,
    });
  });

  it('opens another tool without replacing the minimized task and restores the original tool', async () => {
    render(
      <MinimizedTaskProvider>
        <PromptLibraryPage />
        <MinimizedTaskBar />
      </MinimizedTaskProvider>
    );

    await screen.findByText('Seerfar 类目商品', { selector: 'h6' });
    fireEvent.click(useButtonForTool('Seerfar 类目商品'));
    const categoryDialog = await screen.findByRole('dialog', {}, { timeout: 15000 });
    expect(categoryDialog).toHaveTextContent('使用功能：Seerfar 类目商品');
    expect(within(categoryDialog).getByLabelText('Seerfar 类目 ID')).toBeVisible();
    fireEvent.click(minimizeButton(categoryDialog));

    const firstTaskBar = await screen.findByRole('region', { name: '已最小化的订单任务' });
    expect(firstTaskBar).toHaveTextContent('Seerfar 类目商品');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(useButtonForTool('Seerfar 商品筛选'));
    const reportDialog = await screen.findByRole('dialog', {}, { timeout: 15000 });
    expect(reportDialog).toHaveTextContent('使用功能：Seerfar 商品筛选');
    expect(firstTaskBar).toHaveTextContent('Seerfar 类目商品');
    expect(firstTaskBar).not.toHaveTextContent('Seerfar 商品筛选');
    fireEvent.click(minimizeButton(reportDialog));

    await waitFor(() => expect(within(firstTaskBar).getByText('2')).toBeVisible());
    expect(firstTaskBar).toHaveTextContent('Seerfar 类目商品');
    expect(firstTaskBar).toHaveTextContent('Seerfar 商品筛选');
    const restoreCategory = [...firstTaskBar.querySelectorAll('button')].find(
      (button) =>
        String(button.getAttribute('aria-label') || '').startsWith('恢复') &&
        String(button.getAttribute('aria-label') || '').includes('Seerfar 类目商品')
    );
    expect(restoreCategory).toBeTruthy();
    fireEvent.click(restoreCategory);

    const restoredDialog = await screen.findByRole('dialog', {}, { timeout: 15000 });
    expect(restoredDialog).toHaveTextContent('使用功能：Seerfar 类目商品');
    expect(restoredDialog).not.toHaveTextContent('使用功能：Seerfar 商品筛选');
    expect(within(restoredDialog).getByLabelText('Seerfar 类目 ID')).toBeVisible();
  });

  it('captures the selected page shop when opening a new tool session', async () => {
    const onActiveShopChange = vi.fn();
    render(
      <MinimizedTaskProvider>
        <PromptLibraryPage
          shops={[
            { id: 'shop-1', name: 'Ozon 1店', clientId: '1001' },
            { id: 'shop-2', name: 'Ozon 2店', clientId: '1002' },
          ]}
          activeShopId="shop-1"
          onActiveShopChange={onActiveShopChange}
        />
      </MinimizedTaskProvider>
    );

    await screen.findByText('Seerfar 类目商品', { selector: 'h6' });
    const selector = screen.getByRole('combobox', { name: '智能工具当前店铺' });
    fireEvent.mouseDown(selector);
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Ozon 2店'));
    expect(onActiveShopChange).toHaveBeenCalledWith('shop-2');

    fireEvent.click(useButtonForTool('Seerfar 类目商品'));
    const dialog = await screen.findByRole('dialog', {}, { timeout: 15000 });
    expect(dialog).toHaveTextContent('当前店铺：Ozon 2店');
  });
});
