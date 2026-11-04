import { describe, expect, it } from 'vitest';
import { formatProfitOrderReviewUserText } from './profitOrderReviewText.js';

describe('profitOrderReviewText', () => {
  it('translates internal field paths into user-facing Chinese labels', () => {
    const value = [
      'market.metrics.stock 为未知',
      'market.metrics.followSellerCount 为未知',
      'market.metrics.recentSalesChange 为未知',
      'product.category 为空，但 Seerfar record.category 已返回',
      'product.imageUrl 为空',
    ].join('；');
    const output = formatProfitOrderReviewUserText(value);
    expect(output).toContain('市场库存 为未知');
    expect(output).toContain('跟卖卖家数量 为未知');
    expect(output).toContain('近期销量变化 为未知');
    expect(output).toContain('店内商品类目 为空');
    expect(output).toContain('外部市场类目 已返回');
    expect(output).toContain('商品主图 为空');
    expect(output).not.toMatch(/market\.|product\.|record\./u);
  });
});

