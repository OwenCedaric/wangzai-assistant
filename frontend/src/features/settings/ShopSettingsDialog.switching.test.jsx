import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import ShopSettingsDialog from './ShopSettingsDialog.jsx';

vi.mock('./SettingsModuleContent.jsx', () => ({
  default: ({ activeSettingsModule, saveRequestId, ...rest }) => (
    <div
      data-testid="settings-module-content"
      data-save-request-id={saveRequestId}
      data-has-surface-visible={Object.prototype.hasOwnProperty.call(rest, 'surfaceVisible') ? 'true' : 'false'}
    >
      当前分区：{activeSettingsModule}
    </div>
  ),
}));

const shop = {
  id: 'shop-switching',
  shopAlias: '切换测试店铺',
  clientId: 'client-switching',
  hasClientId: true,
  hasApiKey: true,
  connectionStatus: '本地已保存',
};

const dialogProps = {
  open: true,
  shops: [shop],
  activeShopId: shop.id,
  onClose: () => {},
  onSelect: () => {},
  onAdd: () => {},
  onRemove: () => {},
  onChange: () => {},
  onSave: () => {},
  onTest: () => {},
  onConfirmPurchaseBinding: () => {},
  onResetPurchaseBinding: () => {},
};

describe('ShopSettingsDialog section switching', () => {
  it('switches settings sections directly without rendering a loading placeholder', () => {
    const { container } = render(<ShopSettingsDialog {...dialogProps} />);

    expect(container.querySelector('.api-check-card')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /跨境巴士/u }));
    expect(screen.getByText('当前分区：crossBorderBus')).toBeInTheDocument();
    expect(screen.queryByText('正在加载当前设置分区…')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /模型接口/u }));
    expect(screen.getByText('当前分区：modelApi')).toBeInTheDocument();
    expect(screen.queryByText('正在加载当前设置分区…')).not.toBeInTheDocument();
  });

  it('disables transition animation on the settings section tabs', () => {
    const stylesSource = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
    expect(stylesSource).toMatch(/\.settings-module-tab\s*\{[^}]*transition:\s*none\s*!important;/su);
    expect(stylesSource).toMatch(/\.settings-module-tab\s*\{[^}]*transform:\s*none\s*!important;/su);
    expect(stylesSource).toMatch(/\.shop-settings-dialog-paper\s*\{[^}]*height:\s*calc\(100vh - 64px\);/su);
    expect(stylesSource).toMatch(/\.shop-settings-dialog-paper \.shop-settings-content\s*\{[^}]*overflow-y:\s*scroll;/su);
  });

  it('resets the shared scroll viewport before switching sections', () => {
    const { container } = render(<ShopSettingsDialog {...dialogProps} />);
    const content = container.querySelector('.shop-settings-content');
    content.scrollTop = 260;

    fireEvent.click(screen.getByRole('tab', { name: /外部接口/u }));

    expect(content.scrollTop).toBe(0);
  });

  it('keeps the Ozon panel mounted when switching away and back', async () => {
    render(<ShopSettingsDialog {...dialogProps} deferInitialRender />);

    const apiKeyInput = await screen.findByLabelText(
      'Ozon API Key',
      {},
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByRole('tab', { name: /跨境巴士/u }));
    await waitFor(() => expect(screen.getByText('当前分区：crossBorderBus')).toBeInTheDocument());
    expect(apiKeyInput).toBeInTheDocument();
    expect(apiKeyInput.closest('[hidden]')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Ozon 店铺/u }));
    await waitFor(() => expect(screen.getByLabelText('Ozon API Key')).toBe(apiKeyInput));
    expect(apiKeyInput.closest('[hidden]')).toBeNull();
  });

  it('does not put the shop-list render gate in a starvable transition', () => {
    const dialogSource = readFileSync(join(process.cwd(), 'src', 'features', 'settings', 'ShopSettingsDialog.jsx'), 'utf8');
    const sectionsSource = readFileSync(join(process.cwd(), 'src', 'features', 'settings', 'OzonShopSettingsSections.jsx'), 'utf8');

    expect(dialogSource).not.toContain('React.startTransition(() => setRenderStage');
    expect(sectionsSource).not.toContain('React.startTransition(() => setRenderStage');
    expect(dialogSource).not.toContain('window.requestAnimationFrame(advance)');
    expect(sectionsSource).not.toContain('window.requestAnimationFrame(advance)');
  });

  it('uses one bottom-right Save action and forwards it to the current settings page', () => {
    render(<ShopSettingsDialog {...dialogProps} initialModule="platformApi" />);

    const saveButton = screen.getByRole('button', { name: '保存' });
    expect(screen.queryByRole('button', { name: '保存本地草稿' })).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-module-content')).toHaveAttribute('data-save-request-id', '0');

    fireEvent.click(saveButton);

    expect(screen.getByTestId('settings-module-content')).toHaveAttribute('data-save-request-id', '1');
  });

  it('does not bind the standalone purchase login window lifecycle to settings visibility', () => {
    const { rerender } = render(<ShopSettingsDialog {...dialogProps} initialModule="purchaseAccount" />);
    expect(screen.getByTestId('settings-module-content')).toHaveAttribute('data-has-surface-visible', 'false');

    rerender(<ShopSettingsDialog {...dialogProps} open={false} initialModule="purchaseAccount" />);
    expect(screen.getByTestId('settings-module-content')).toHaveAttribute('data-has-surface-visible', 'false');
  });
});
