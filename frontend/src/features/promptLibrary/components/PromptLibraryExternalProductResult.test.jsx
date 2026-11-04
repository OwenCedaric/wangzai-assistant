import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PromptLibraryExternalProductResult } from './PromptLibraryExternalProductResult.jsx';

describe('PromptLibraryExternalProductResult', () => {
  it('keeps headers aligned with product data and opens the shared workbench', () => {
    const onOpenProduct = vi.fn();
    render(<PromptLibraryExternalProductResult
      onOpenProduct={onOpenProduct}
      result={{
        externalAnalysis: {
          overview: {
            recordCount: 1,
            totalSales: 300,
            totalRevenue: 179700,
            averagePrice: 599,
          },
          insights: ['销售额最高：测试商品。'],
          analysisModeLabel: '竞对商品分析',
          records: [{
            sku: '2962820304',
            title: '测试商品',
            price: 599,
            sales: 300,
            revenue: 179700,
            stock: 50,
            rating: 4.7,
            reviews: 88,
            seller: '测试卖家',
            fulfillmentModel: 'FBO',
            returnCancelRate: 3.1,
            sfEnrich: true,
          }],
        },
      }}
    />);

    expect(screen.getByText('价格')).toBeVisible();
    expect(screen.getByText('竞对商品分析结果')).toBeVisible();
    expect(screen.getAllByText('599 ₽')).toHaveLength(2);
    expect(screen.getAllByText('179,700 ₽')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '打开商品操作台：测试商品' }));
    expect(onOpenProduct).toHaveBeenCalledWith(expect.objectContaining({
      sku: '2962820304',
      sfEnrich: true,
    }));
  });

  it('does not render zero metric cards or an empty table for an upstream empty result', () => {
    const { container } = render(<PromptLibraryExternalProductResult
      result={{
        status: 'empty',
        externalAnalysis: {
          overview: { recordCount: 0, totalSales: null, totalRevenue: null },
          records: [],
        },
      }}
    />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('商品数')).not.toBeInTheDocument();
    expect(screen.queryByText('总销量')).not.toBeInTheDocument();
  });
});
