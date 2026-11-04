import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataAnalysisModuleNav } from './DataAnalysisModuleNav.jsx';

describe('DataAnalysisModuleNav', () => {
  it('uses ten lightweight business tabs without row-count or source-status cards', () => {
    const onChange = vi.fn();
    render(<DataAnalysisModuleNav activeModuleId="overview" onChange={onChange} />);

    const tabList = screen.getByRole('tablist', { name: '数据分析模块' });
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(10);
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      '总览',
      '销售',
      '商品',
      '流量',
      '广告',
      '利润',
      '库存',
      '售后',
      '促销',
      '市场',
    ]);
    expect(screen.getByRole('tab', { name: '总览' })).toHaveAttribute('aria-selected', 'true');
    expect(tabList.querySelector('.MuiChip-root')).toBeNull();
    expect(tabList.closest('.MuiTabs-root')).toHaveStyle({ overflowX: 'hidden' });
    expect(tabList).toHaveStyle({ flexWrap: 'wrap' });
    expect(tabList.closest('.MuiTabs-root').querySelector('.MuiTabs-scrollButtons')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: '销售' }));
    expect(onChange).toHaveBeenCalledWith('sales');
  });
});
