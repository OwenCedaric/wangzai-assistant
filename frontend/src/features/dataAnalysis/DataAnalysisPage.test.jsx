import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  analyze: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('./model/useDataAnalysisCenter.js', () => ({
  useDataAnalysisCenter: () => ({
    activeModuleId: 'overview',
    setActiveModuleId: vi.fn(),
    filters: { shopId: 'shop-1', startDate: '2026-07-01', endDate: '2026-07-21' },
    payload: {
      dashboard: {
        overview: { metrics: [] },
        sales: { metrics: [], trend: [], statusBreakdown: [], productRanking: [] },
        products: { metrics: [] },
        finance: { metrics: [] },
      },
      updatedAt: '2026-07-21T00:00:00.000Z',
    },
    status: 'success',
    setShopId: vi.fn(),
    setPreset: vi.fn(),
    setCustomRange: vi.fn(),
    refreshOfficialData: vi.fn(),
    rebuild: vi.fn(),
    refresh: runtime.refresh,
  }),
}));
vi.mock('./model/useDataAnalysisCurrency.js', () => ({
  useDataAnalysisCurrency: ({ dashboard }) => ({ dashboard, status: 'success' }),
}));
vi.mock('./model/useDataAnalysisPerformance.js', () => ({
  useDataAnalysisPerformance: () => ({}),
}));
vi.mock('./model/useDataAnalysisInsight.js', () => ({
  useDataAnalysisInsight: () => ({
    status: 'idle',
    insight: '',
    error: null,
    meta: null,
    modelOptions: [],
    selectedModelId: 'auto',
    modelSelection: { ready: true, accountId: 'account-1', model: 'gpt-5.5' },
    setSelectedModelId: vi.fn(),
    analyze: runtime.analyze,
  }),
}));
vi.mock('./components/DataAnalysisToolbar.jsx', () => ({ DataAnalysisToolbar: () => null }));
vi.mock('./components/DataAnalysisModuleNav.jsx', () => ({ DataAnalysisModuleNav: () => null }));
vi.mock('./components/DataAnalysisModuleContent.jsx', () => ({ DataAnalysisModuleContent: () => null }));
vi.mock('./components/DataAnalysisInfoDrawer.jsx', () => ({ DataAnalysisInfoDrawer: () => null }));
vi.mock('./components/DataAnalysisStatusBanner.jsx', () => ({
  DataAnalysisErrorState: () => null,
  DataAnalysisLoadingState: () => null,
}));

import { DataAnalysisPage } from './DataAnalysisPage.jsx';

describe('DataAnalysisPage', () => {
  it('starts the analysis immediately when the header action opens the dialog', () => {
    render(<DataAnalysisPage shops={[]} activeShopId="shop-1" isActive />);

    fireEvent.click(screen.getByRole('button', { name: '数据分析' }));

    expect(runtime.refresh).not.toHaveBeenCalled();
    expect(runtime.analyze).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toHaveTextContent('正在分析当前店铺');
    expect(screen.queryByText('点击右上角“生成诊断”')).not.toBeInTheDocument();
  });
});
