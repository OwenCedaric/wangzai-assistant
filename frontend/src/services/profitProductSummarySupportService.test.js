import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildProfitProductSummarySourceLinks,
  readProfitProductSummarySupport,
} from './profitProductSummarySupportService';

describe('profitProductSummarySupportService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
  });

  it('builds source link map keys compatible with profit source lookup', () => {
    const sourceLinks = buildProfitProductSummarySourceLinks(
      [
        {
          shopId: 'ozon-shop-1',
          productId: '101',
          offerId: 'offer-101',
          sku: 'sku-101',
          sourceRecord: {
            primaryIndex: 0,
            links: [{ link: 'https://yangkeduo.com/goods.html?goods_id=101', platform: 'PDD', priceValue: 12.5 }],
          },
        },
      ],
      [{ id: 'ozon-shop-1', clientId: '4616153', shopAlias: 'Ozon 1店' }]
    );

    expect(sourceLinks['ozon-shop-1:offer-101'].links[0]).toMatchObject({ platform: 'PDD', priceValue: 12.5 });
    expect(sourceLinks['4616153:offer-101'].links[0]).toMatchObject({ platform: 'PDD' });
    expect(sourceLinks['Ozon 1店:offer-101'].links[0]).toMatchObject({ platform: 'PDD' });
    expect(sourceLinks['offer-101'].links[0]).toMatchObject({ platform: 'PDD' });
    expect(sourceLinks['ozon-shop-1:101'].links[0]).toMatchObject({ platform: 'PDD' });
  });

  it('reads local-api product summary once and returns entity map plus source link map for profit', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          rows: [
            {
              shopId: 'ozon-shop-1',
              productId: '101',
              offerId: 'offer-101',
              name: '利润商品',
              primaryImageUrl: 'https://img.example/101.jpg',
              commissionPercent: 12,
              acquiringFeeValue: 0.54,
              materialProfile: { source: 'cross-border-bus', weight: '0.3', length: '30', width: '20', height: '10' },
              sourceRecord: {
                primaryIndex: 0,
                links: [{ link: 'https://1688.com/item/101', platform: '1688', priceValue: 9.8 }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await readProfitProductSummarySupport(
      [
        {
          id: 'posting-1',
          shopId: 'ozon-shop-1',
          products: [{ offerId: 'offer-101' }],
        },
      ],
      [{ id: 'ozon-shop-1', clientId: '4616153', shopAlias: 'Ozon 1店' }],
      { getRecordKey: (row) => row.id }
    );

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/products/summary');
    expect(url.searchParams.get('offerIds')).toBe('offer-101');
    expect(result.entityMap.get('posting-1:0')).toMatchObject({
      materialProfile: { source: 'cross-border-bus', weight: '0.3' },
      sourceRecord: { links: [{ platform: '1688', priceValue: 9.8 }] },
    });
    expect(result.productSourceLinks['ozon-shop-1:offer-101'].links[0]).toMatchObject({ platform: '1688' });
  });
});
