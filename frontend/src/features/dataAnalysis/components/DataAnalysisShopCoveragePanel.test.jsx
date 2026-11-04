import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DataAnalysisShopCoveragePanel } from './DataAnalysisShopCoveragePanel.jsx';

describe('DataAnalysisShopCoveragePanel', () => {
  it('shows every selected shop and distinguishes a real zero-order period from a missing shop', () => {
    render(<DataAnalysisShopCoveragePanel quality={{
      expectedShopCount: 3,
      scopeStatus: 'confirmed',
      shopRows: [
        { shopId: 'a', shopName: '一店', historicalOrderRows: 292, productRows: 1433, orderRows: 0, financeRows: 17, analyticsRows: 29, performanceReady: true },
        { shopId: 'b', shopName: '二店', historicalOrderRows: 209, productRows: 4546, orderRows: 106, financeRows: 419, analyticsRows: 29, performanceReady: true },
        { shopId: 'c', shopName: '三店', historicalOrderRows: 1141, productRows: 3414, orderRows: 348, financeRows: 1300, analyticsRows: 29, performanceReady: false },
      ],
      sourceCoverage: [
        { id: 'orders', coveredShopCount: 3, expectedShopCount: 3 },
        { id: 'products', coveredShopCount: 3, expectedShopCount: 3 },
        { id: 'finance', coveredShopCount: 3, expectedShopCount: 3 },
        { id: 'analytics', coveredShopCount: 3, expectedShopCount: 3 },
      ],
      metricCoverage: {
        categoryIdCoveragePercent: 100,
        categoryNameCoveragePercent: 100,
        financeOfficialCurrencyRows: 0,
        financeInferredCurrencyRows: 1736,
        latestAnalyticsDate: '2026-08-25',
        analyticsLagDays: 1,
      },
    }} />);

    expect(screen.getByText('一店')).toBeInTheDocument();
    expect(screen.getByText('二店')).toBeInTheDocument();
    expect(screen.getByText('三店')).toBeInTheDocument();
    expect(screen.getByText('本期0单')).toBeInTheDocument();
    expect(screen.getAllByText('已纳入')).toHaveLength(2);
    expect(screen.getByText('聚合校验通过')).toBeInTheDocument();
    expect(screen.getByText(/核心来源覆盖 12\/12/)).toBeInTheDocument();
  });
});
