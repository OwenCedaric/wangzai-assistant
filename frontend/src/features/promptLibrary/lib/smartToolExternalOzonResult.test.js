import { describe, expect, it } from 'vitest';
import {
  buildExternalOzonQueryResult,
  formatExternalOzonRecord,
} from './smartToolExternalOzonResult.js';

describe('smartToolExternalOzonResult', () => {
  it('reads the official nested response and keeps overview plus records', () => {
    const result = buildExternalOzonQueryResult(
      { id: 'linkfox-seerfar-ozon-shop-search' },
      {
        ok: true,
        data: {
          code: 200,
          data: {
            total: 143,
            totalSales: 11782,
            hasNextPage: true,
            products: [{ sku: 1310550649, sales: 1098, price: 2591, reviewRating: 4.9 }],
          },
        },
      },
      { id: 1275208 },
    );

    expect(result.returned).toBe(1);
    expect(result.summary).toContain('还有下一页');
    expect(result.sections.find((section) => section.title === '数据概况')?.rows[0])
      .toContain('总销量 11782');
    expect(result.sections.find((section) => section.title.includes('店铺商品'))?.rows[0])
      .toContain('SKU 1310550649');
    expect(result.sections.find((section) => section.title === '本次查询')?.rows[0])
      .toBe('店铺 ID 1275208');
  });

  it('formats pagination in plain language instead of showing an empty raw page field', () => {
    const result = buildExternalOzonQueryResult(
      { id: 'linkfox-seerfar-ozon-market-keyword-search' },
      { data: { code: 200, data: { total: 1, records: [{ query: 'платье' }] } } },
      {
        keywords: ['платье'],
        matchType: 1,
        page: { page: 1, pageSize: 20, orders: [{ field: 'searchVolume', direction: 'DESC' }] },
      },
    );
    const queryRow = result.sections.find((section) => section.title === '本次查询')?.rows[0];
    expect(queryRow).toContain('关键词 платье');
    expect(queryRow).toContain('第 1 页 · 每页 20 条 · 按搜索量降序');
    expect(queryRow).not.toContain('page:');
  });

  it('also reads a direct response whose data field is the record array', () => {
    const result = buildExternalOzonQueryResult(
      { id: 'linkfox-seerfar-ozon-market-keyword-search' },
      { data: { code: 200, total: 1, data: [{ query: 'платье', searchVolume: 12000 }] } },
      {},
    );

    expect(result.returned).toBe(1);
    expect(result.viewType).toBe('market-keywords');
    expect(result.marketKeywordAnalysis.records[0]).toMatchObject({ query: 'платье', searchVolume: 12000 });
  });

  it('marks merged pagination as complete and retains the structured records', () => {
    const records = Array.from({ length: 205 }, (_, index) => ({
      query: `keyword-${index + 1}`,
      searchVolume: 205 - index,
    }));
    const result = buildExternalOzonQueryResult(
      { id: 'linkfox-seerfar-ozon-market-keyword-search' },
      {
        data: {
          code: 200,
          data: {
            total: 205,
            records,
            allPagesLoaded: true,
            loadedPages: 3,
            hasNextPage: false,
          },
        },
      },
      { page: { page: 1, pageSize: 100, allPages: true, loadedPages: 3 } },
    );

    expect(result.summary).toBe('已完整读取 205 条真实数据。');
    expect(result.records).toHaveLength(205);
    expect(result).toMatchObject({ allPagesLoaded: true, loadedPages: 3, returned: 205 });
    expect(result.marketKeywordAnalysis.recordCount).toBe(205);
    expect(result.sections.at(-1).rows[0]).toContain('已读取全部 3 页');
  });

  it('flattens keyword-back dimensions and removes duplicate aliases', () => {
    const row = formatExternalOzonRecord({
      sku: 175924376,
      productId: 175924376,
      query: 'платье',
      queryCn: '连衣裙',
      dimension: { naturalRank: 3, exposure: 0.42, conversion: 0.18 },
    });

    expect(row).toContain('自然排名 3');
    expect(row).toContain('曝光 0.42');
    expect(row.match(/SKU 175924376/gu)).toHaveLength(1);
  });

  it('shows a clear empty-state instead of raw protocol fields', () => {
    const result = buildExternalOzonQueryResult(
      { id: 'linkfox-seerfar-ozon-product-report-search' },
      { data: { code: 200, data: { total: 0, records: [] } } },
      {},
    );
    expect(result.status).toBe('empty');
    expect(result.statusLabel).toBe('没有查到数据');
    expect(result.summary).toContain('没有查到符合当前条件的真实数据');
    expect(result.sections[0].rows[0]).toContain('没有查到');
  });

  it('does not report a missing product detail as a successful zero result', () => {
    const result = buildExternalOzonQueryResult(
      { id: 'linkfox-seerfar-ozon-product-detail-search' },
      { data: { requestId: 'request-a', code: 200, msg: 'SUCCESS', data: null } },
      { sku: '4391289819', dateRange: 'past_30_days' },
    );

    expect(result).toMatchObject({
      status: 'empty',
      statusLabel: '没有查到数据',
      returned: 0,
    });
    expect(result.summary).toContain('SKU 4391289819');
    expect(result.summary).not.toContain('查询完成');
  });

  it('shows manually supplied business data with Chinese labels only', () => {
    const result = buildExternalOzonQueryResult(
      { id: 'linkfox-seerfar-ozon-product-detail-search' },
      { data: { data: { product: { sku: 1, title: '商品', price: 1000 } } } },
      {
        sku: '1',
        analysisMode: 'own',
        manualData: {
          productCostRub: 400,
          commissionRate: 15,
          fulfillmentFeeRub: 100,
          taxRate: 5,
          returnCancelRate: 8,
        },
      },
    );
    const queryRow = result.sections.find((section) => section.title === '本次查询')?.rows[0];
    expect(queryRow).toContain('补充经营数据：商品成本 400₽');
    expect(queryRow).toContain('退货取消率 8%');
    expect(queryRow).not.toContain('productCostRub');
    expect(result.externalAnalysis.overview).toMatchObject({ estimatedUnitProfitRub: 300 });
  });
});
