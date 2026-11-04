import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PromptLibraryMarketKeywordResult } from './PromptLibraryMarketKeywordResult.jsx';

describe('PromptLibraryMarketKeywordResult', () => {
  it('shows the complete meaningful SF market profile and opens Top products in the workbench', () => {
    const onOpenProduct = vi.fn();
    render(<PromptLibraryMarketKeywordResult
      onOpenProduct={onOpenProduct}
      result={{
        marketKeywordAnalysis: {
          platformCounts: { ozon: 1, wildberries: 0 },
          categoryCount: 1,
          topProductCount: 1,
          querySummary: '关键词 платье · 按搜索量降序',
          records: [{
            id: 'market-1',
            query: 'платье женское летнее',
            queryCn: '夏季女装',
            platform: 0,
            searchVolume: 1167418,
            count30GrowthRate: -4.7,
            sales: 3604,
            revenue: 8403960,
            productCount: 519605,
            competingProducts: 6221,
            sellers: 974,
            avgPrice: 2635,
            ratings: 4.4,
            reviews: 10843,
            itemsViews: 131.3,
            viewSharing: 16.9,
            conversionSharing: 17.9,
            marketSpace: 188,
            returnCancellationRate: 51.7,
            ca: 13.1,
            uniqQueriesWCa: 153707,
            searchUsersToOrdUsers: 4.39,
            queryTime: '2026-07-29',
            createTime: '2026-07-30 02:56:24',
            categories: ['15621031_200000933_93182'],
            categoryInfos: [{
              id: '15621031_200000933_93182',
              cnTitlePath: '服装 > 服装 > 连衣裙',
              crossBorderSellable: true,
            }],
            products: [{ sku: 4380710124, title: 'Платье T-SOD', advert: 0 }],
          }],
        },
      }}
    />);

    expect(screen.getByText('платье женское летнее')).toBeVisible();
    expect(screen.getByText('夏季女装')).toBeVisible();
    expect(screen.getByText('1,167,418')).toBeVisible();
    expect(screen.getByText('-4.7%')).toBeVisible();
    expect(screen.getByText('8,403,960 ₽')).toBeVisible();
    expect(screen.getByText('4.39%')).toBeVisible();
    expect(screen.getByText(/数据日期 2026-07-29/u)).toBeVisible();
    expect(screen.getByText(/服装 > 服装 > 连衣裙/u)).toBeVisible();
    expect(screen.getByText(/可跨境销售/u)).toBeVisible();
    expect(screen.getByText('Платье T-SOD')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '打开商品操作台：Платье T-SOD' }));
    expect(onOpenProduct).toHaveBeenCalledWith(expect.objectContaining({
      sku: '4380710124',
      productUrl: 'https://www.ozon.ru/product/4380710124/',
    }));
  });
});
