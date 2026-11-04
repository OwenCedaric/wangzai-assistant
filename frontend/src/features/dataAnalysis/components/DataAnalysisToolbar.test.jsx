import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataAnalysisToolbar } from './DataAnalysisToolbar.jsx';

function renderToolbar(overrides = {}) {
  const actions = {
    onShopChange: vi.fn(),
    onPresetChange: vi.fn(),
    onRangeChange: vi.fn(),
    onRefresh: vi.fn(),
  };
  render(
    <DataAnalysisToolbar
      shops={[{ id: 'shop-1', name: '测试店铺' }]}
      filters={{
        shopId: 'shop-1',
        presetId: '30d',
        startDate: '2026-06-30',
        endDate: '2026-07-29',
      }}
      loading={false}
      {...actions}
      {...overrides}
    />,
  );
  return actions;
}

describe('DataAnalysisToolbar', () => {
  it('uses one labelled compact filter surface and keeps every existing action wired', () => {
    const actions = renderToolbar();
    const toolbar = screen.getByRole('region', { name: '数据筛选条件' });
    expect(toolbar).toHaveClass('data-analysis-toolbar-card');
    expect(within(toolbar).getByText('店铺范围')).toBeInTheDocument();
    expect(within(toolbar).getByText('统计周期')).toBeInTheDocument();
    expect(within(toolbar).getByText('日期范围')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: '店铺范围' }));
    fireEvent.click(screen.getByRole('option', { name: '全部店铺' }));
    expect(actions.onShopChange).toHaveBeenCalledWith('');

    fireEvent.mouseDown(screen.getByRole('combobox', { name: '统计周期' }));
    fireEvent.click(screen.getByRole('option', { name: '近7天' }));
    expect(actions.onPresetChange).toHaveBeenCalledWith('7d');

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-07-01' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-07-28' } });
    expect(actions.onRangeChange).toHaveBeenNthCalledWith(1, { startDate: '2026-07-01' });
    expect(actions.onRangeChange).toHaveBeenNthCalledWith(2, { endDate: '2026-07-28' });

    fireEvent.click(screen.getByRole('button', { name: '同步流量' }));
    expect(actions.onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables the sync action while the page is loading', () => {
    renderToolbar({ loading: true });
    expect(screen.getByRole('button', { name: '同步流量' })).toBeDisabled();
  });

  it('uses the same seller name, external id, and alias fields as the data backup selector', () => {
    renderToolbar({
      shops: [{
        id: 'shop-1',
        clientId: '46000123',
        sellerName: 'Ozon 官方旗舰店',
        shopAlias: '俄罗斯主店',
      }],
    });

    expect(screen.getByText('Ozon 官方旗舰店')).toBeInTheDocument();
    expect(screen.getByText('店铺 ID：46000123 · 简称：俄罗斯主店')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: '店铺范围' }));
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByText('Ozon 官方旗舰店')).toBeInTheDocument();
    expect(within(listbox).getByText('店铺 ID：46000123 · 简称：俄罗斯主店')).toBeInTheDocument();
  });

  it('falls back to the available id without rendering undefined or an empty alias separator', () => {
    renderToolbar({
      shops: [{ id: 'shop-without-alias', name: '备用店铺', clientId: '' }],
      filters: {
        shopId: 'shop-without-alias',
        presetId: '30d',
        startDate: '2026-06-30',
        endDate: '2026-07-29',
      },
    });

    expect(screen.getByText('备用店铺')).toBeInTheDocument();
    expect(screen.getByText('店铺 ID：shop-without-alias')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/u)).not.toBeInTheDocument();
  });
});
