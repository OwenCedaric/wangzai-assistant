import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  CampaignListTable,
  CampaignProductTable,
  PromotionMetricSummary,
} from './PaidPromotionTables.jsx';

describe('paid promotion extracted tables', () => {
  it('renders the same campaign values and CNY conversions in the visible DOM', () => {
    const { container } = render(
      <CampaignListTable
        rows={[
          {
            id: 'campaign-1',
            title: '测试推广计划',
            type: '商品推广',
            statusLabel: '运行中',
            productCount: 12,
            impressions: 1234,
            clicks: 56,
            ctr: 4.54,
            spent: 100,
            cpc: 1.785,
            orders: 8,
            revenue: 500,
            acos: 20,
            roas: 5,
          },
        ]}
        selectedCampaignId="campaign-1"
        onSelect={() => undefined}
        rubToCnyRate={0.08}
      />,
    );

    const text = container.textContent;
    for (const expected of [
      '测试推广计划',
      '商品 12',
      '运行中',
      '1,234',
      '56',
      '4.54%',
      '¥ 8.00',
      '¥ 0.14',
      '8 单',
      '¥ 40.00',
      '20%',
      '5',
      '共 1 个计划',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('renders zero base values and the existing derived-metric empty reasons', () => {
    const { container } = render(
      <PromotionMetricSummary
        summary={{
          impressions: 0,
          clicks: 0,
          ctr: 0,
          spent: 0,
          cpc: 0,
          orders: 0,
          revenue: 0,
          acos: 0,
          roas: 0,
        }}
        rubToCnyRate={0.08}
      />,
    );
    expect(container.textContent).toContain('¥ 0.00');
    expect(container.textContent).toContain('暂无展示');
    expect(container.textContent).toContain('暂无点击');
    expect(container.textContent).toContain('暂无成交');
    expect(container.textContent).toContain('暂无花费');
    expect(container.textContent).not.toContain('未返回');
  });

  it('shows all four independent official bid sources without filling a missing source', () => {
    const { container } = render(
      <CampaignProductTable
        mode="search"
        rows={[
          {
            id: 'campaign-1:sku-1',
            sku: 'sku-1',
            title: '四源出价商品',
            statusLabel: '运行中',
            bid: 10,
            recommendedBid: 11,
            competitiveBid: 13,
            minCpoBid: 8,
            minimumCpcBid: null,
            bidAvailability: {
              recommended: { status: 'returned' },
              competitive: { status: 'returned' },
              minCpo: { status: 'returned' },
              minimumCpc: { status: 'failed' },
            },
          },
        ]}
        rubToCnyRate={0.08}
      />,
    );

    const text = container.textContent;
    expect(text).toContain('推荐 · 竞争 · 最低订单出价 · 最低点击出价');
    expect(text).toContain('推荐¥ 0.88');
    expect(text).toContain('竞争¥ 1.04');
    expect(text).toContain('最低¥ 0.64');
    expect(text).toContain('最低点击读取失败');
    expect(text).not.toContain('最低点击¥ 0.64');
  });
});
