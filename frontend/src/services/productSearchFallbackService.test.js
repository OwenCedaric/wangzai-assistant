import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureProductSearchFallbackService,
  getProductSearchIdentityKeys,
  mergeProductSearchMirrorRows,
  readLocalProductMirrorRowsForShops,
  readLocalProductMirrorStatusCountsForShops,
  readLocalProductSearchMirrorRows,
  replaceProductSearchResultRow,
  resetProductSearchFallbackServiceForTest,
} from './productSearchFallbackService';

const tabs = [
  { label: '全部商品', visibility: 'ALL' },
  { label: '出售中', visibility: 'IN_SALE' },
  { label: '已下架', visibility: 'ARCHIVED' },
];

describe('productSearchFallbackService', () => {
  afterEach(() => {
    resetProductSearchFallbackServiceForTest();
    vi.restoreAllMocks();
  });

  it('builds scoped identity keys and merges search rows without duplicates', () => {
    configureProductSearchFallbackService({
      getProductRowShopScopeKey: (product) => product.shopId || 'shop-1',
      getProductRowCacheKey: (product) => product.cacheKey || product.productId || '',
    });

    const row = { shopId: 'shop-1', productId: '101', offerId: 'offer-101' };
    expect(getProductSearchIdentityKeys(row)).toEqual(expect.arrayContaining(['shop-1:101', 'shop-1:offer-101']));

    const merged = mergeProductSearchMirrorRows(
      [{ shopId: 'shop-1', productId: '101', name: 'base' }],
      [
        { shopId: 'shop-1', productId: '101', name: 'duplicate' },
        { shopId: 'shop-1', productId: '102', name: 'search hit' },
      ]
    );

    expect(merged.map((item) => item.name)).toEqual(['search hit', 'base']);
  });

  it('replaces matching search result row and prepends new rows', () => {
    configureProductSearchFallbackService({
      getProductRowShopScopeKey: (product) => product.shopId || 'shop-1',
      getProductRowCacheKey: (product) => product.productId || '',
    });

    const replaced = replaceProductSearchResultRow([{ shopId: 'shop-1', productId: '101', name: 'old' }], {
      shopId: 'shop-1',
      productId: '101',
      name: 'new',
    });
    const prepended = replaceProductSearchResultRow(replaced, { shopId: 'shop-1', productId: '102', name: 'added' });

    expect(replaced).toEqual([{ shopId: 'shop-1', productId: '101', name: 'new', localSearchResult: true }]);
    expect(prepended[0]).toMatchObject({ productId: '102', name: 'added', localSearchResult: true });
  });

  it('reads local-api SQLite product pages for status and keyword search only', async () => {
    const readLocalApiProductPage = vi.fn(async (shop, tab, options) => ({
      rows: [{ shopId: shop.id, productId: `${tab.visibility}-${options.keyword || 'page'}` }],
      total: 1,
      counts: { ALL: 1 },
    }));
    configureProductSearchFallbackService({
      productStatusTabs: tabs,
      readLocalApiProductPage,
      getProductRowShopScopeKey: (product) => product.shopId || 'shop-1',
      getProductRowCacheKey: (product) => product.productId || '',
    });

    const rows = await readLocalProductMirrorRowsForShops([{ id: 'shop-1' }], {
      statusLabel: '已下架',
      keyword: 'abc',
    });
    const searchRows = await readLocalProductSearchMirrorRows([{ id: 'shop-1' }], 'abc');

    expect(readLocalApiProductPage).toHaveBeenCalledWith(
      { id: 'shop-1' },
      { label: '已下架', visibility: 'ARCHIVED' },
      expect.objectContaining({ pageSize: 1000, page: 1, keyword: 'abc', sort: 'stable' })
    );
    expect(rows).toEqual([{ shopId: 'shop-1', productId: 'ARCHIVED-abc' }]);
    expect(searchRows.map((item) => item.productId)).toEqual(['ALL-abc', 'IN_SALE-abc', 'ARCHIVED-abc']);
  });

  it('continues local-api mirror reads past the first page instead of treating 100 rows as the full list', async () => {
    const readLocalApiProductPage = vi.fn(async (shop, tab, options) => ({
      rows:
        options.page === 1
          ? [{ shopId: shop.id, productId: `${tab.visibility}-1` }]
          : [{ shopId: shop.id, productId: `${tab.visibility}-2` }],
      total: 1001,
      counts: { ALL: 1001 },
    }));
    configureProductSearchFallbackService({
      productStatusTabs: tabs,
      readLocalApiProductPage,
      getProductRowShopScopeKey: (product) => product.shopId || 'shop-1',
      getProductRowCacheKey: (product) => product.productId || '',
    });

    const rows = await readLocalProductMirrorRowsForShops([{ id: 'shop-1' }], {
      statusLabel: '全部商品',
      maxPages: 2,
    });

    expect(readLocalApiProductPage).toHaveBeenCalledWith(
      { id: 'shop-1' },
      { label: '全部商品', visibility: 'ALL' },
      expect.objectContaining({ pageSize: 1000, page: 1 })
    );
    expect(readLocalApiProductPage).toHaveBeenCalledWith(
      { id: 'shop-1' },
      { label: '全部商品', visibility: 'ALL' },
      expect.objectContaining({ pageSize: 1000, page: 2 })
    );
    expect(rows.map((item) => item.productId)).toEqual(['ALL-1', 'ALL-2']);
  });

  it('aggregates status counts from local-api cache and records retry when pages are missing', async () => {
    const retry = vi.fn(async () => undefined);
    configureProductSearchFallbackService({
      productStatusTabs: tabs,
      readLocalApiProductPage: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], counts: { ALL: 10, ARCHIVED: 8, IN_SALE: 2 } })
        .mockResolvedValueOnce(null),
      recordLocalMirrorRetryTask: retry,
      mapProductCacheCountsToStatusLabels: (counts = {}) => ({
        全部商品: counts.ALL || 0,
        已下架: counts.ARCHIVED || 0,
        出售中: counts.IN_SALE || 0,
      }),
      createEmptyProductStatusCounts: () => ({ 全部商品: 0, 出售中: 0, 已下架: 0 }),
      hasProductStatusCountValues: (counts) => Object.values(counts || {}).some((value) => Number(value) > 0),
    });

    const counts = await readLocalProductMirrorStatusCountsForShops([{ id: 'shop-1' }]);
    const missingRows = await readLocalProductMirrorRowsForShops([{ id: 'shop-1' }], { statusLabel: '全部商品' });

    expect(counts).toEqual({ 全部商品: 10, 出售中: 2, 已下架: 8 });
    expect(missingRows).toEqual([]);
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'local-api-cache', entityType: 'productMirror' })
    );
  });
});
