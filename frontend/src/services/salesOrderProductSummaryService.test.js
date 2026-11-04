import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyProfitProductMaterialFallbackToOrder,
  applyProfitProductSummaryMaterialToRows,
} from '../entities/profit/profitProductMaterialFallbackRules.js';
import { applyOzonLocalProductEntitiesToRows } from '../entities/product/productLocalMirror.jsx';
import { readSalesOrderProductSummaryEntities, toOrderProductSummaryEntity } from './salesOrderProductSummaryService';

describe('salesOrderProductSummaryService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
  });

  it('reads current-page order product summaries from local-api product_summary only', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          rows: [
            {
              shopId: 'ozon-shop-1',
              productKey: 'product:101',
              productId: '101',
              offerId: 'offer-101',
              name: 'SQLite 商品标题',
              primaryImageUrl: 'https://img.example/main.jpg',
              images: ['https://img.example/main.jpg'],
              currencyCode: 'CNY',
              commissionPercent: 12,
              acquiringFeeValue: 0.54,
              weightKg: 0.2,
              widthCm: 10,
              heightCm: 20,
              depthCm: 30,
              materialProfile: {
                source: 'cross-border-bus',
                weight: '0.3',
                width: '11',
                height: '21',
                length: '31',
              },
              sourceRecord: {
                primaryIndex: 0,
                links: [{ link: 'https://yangkeduo.com/goods.html?goods_id=101', platform: 'PDD', productId: '101' }],
              },
              sourceLinks: [
                { link: 'https://yangkeduo.com/goods.html?goods_id=101', platform: 'PDD', productId: '101' },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await readSalesOrderProductSummaryEntities(
      [
        {
          id: 'order-1',
          shopId: 'ozon-shop-1',
          products: [{ offerId: 'offer-101', name: '未返回' }],
        },
      ],
      [{ id: 'ozon-shop-1', clientId: '4616153', shopAlias: 'Ozon 1店' }],
      { getRecordKey: (order) => order.id }
    );

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/products/summary');
    expect(url.searchParams.get('shopId')).toBe('ozon-shop-1');
    expect(url.searchParams.get('offerIds')).toBe('offer-101');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('/api/' + 'ozon/request');
    expect(result.entityMap.get('order-1:0')).toMatchObject({
      name: 'SQLite 商品标题',
      mainImage: 'https://img.example/main.jpg',
      commissionPercent: 12,
      acquiringFeeValue: 0.54,
      currencyCode: 'CNY',
      weightKg: 0.2,
      widthCm: 10,
      heightCm: 20,
      depthCm: 30,
      materialProfile: { source: 'cross-border-bus', weight: '0.3' },
      sourceRecord: { links: [{ platform: 'PDD', productId: '101' }] },
      source: 'local-api-products-summary',
    });
    expect(result.matchedOrderKeys.has('order-1')).toBe(true);
  });

  it('hydrates one missing shop product once and reuses the returned image for duplicate orders', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input);
      if (url.pathname === '/api/products/summary/hydrate') {
        return new Response(
          JSON.stringify({
            ok: true,
            rows: [{
              shopId: 'ozon-shop-2',
              productId: '5359748272',
              offerId: 'SKU-202608060418-11-01',
              sku: '5359748272',
              name: '电磁商品',
              primaryImageUrl: 'https://cdn.example/5359748272.jpg',
              images: ['https://cdn.example/5359748272.jpg'],
              currencyCode: 'CNY',
              commissionPercent: 12,
              commissionPercents: { fbs: 17, rfbs: 12 },
              weightKg: 0.18,
              widthCm: 10,
              heightCm: 10,
              depthCm: 10,
            }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ ok: true, rows: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await readSalesOrderProductSummaryEntities(
      [
        {
          id: '61683787-0268-1',
          shopId: 'ozon-shop-2',
          amountValue: 88,
          currencyCode: 'CNY',
          fulfillment: 'FBS',
          products: [{ offerId: 'SKU-202608060418-11-01', skuId: '5359748272', priceValue: 88, qty: 1 }],
        },
        {
          id: '0120367693-0177-1',
          shopId: 'ozon-shop-2',
          amountValue: 88,
          currencyCode: 'CNY',
          fulfillment: 'FBS',
          products: [{ offerId: 'SKU-202608060418-11-01', skuId: '5359748272', priceValue: 88, qty: 1 }],
        },
      ],
      [{ id: 'ozon-shop-2' }],
      {
        getRecordKey: (order) => order.id,
        hydrateMissing: true,
        requireImages: true,
      }
    );

    const hydrateCalls = fetchMock.mock.calls.filter(([input]) => new URL(input).pathname === '/api/products/summary/hydrate');
    expect(hydrateCalls).toHaveLength(1);
    const body = JSON.parse(hydrateCalls[0][1].body);
    expect(body).toMatchObject({
      shopId: 'ozon-shop-2',
      requireImages: true,
      refs: [{ offerId: 'SKU-202608060418-11-01', sku: '5359748272' }],
    });
    expect(result.entityMap.get('61683787-0268-1:0')?.mainImage).toBe('https://cdn.example/5359748272.jpg');
    expect(result.entityMap.get('0120367693-0177-1:0')?.mainImage).toBe('https://cdn.example/5359748272.jpg');

    const commissionRows = applyOzonLocalProductEntitiesToRows(
      [
        {
          id: '61683787-0268-1',
          amountValue: 88,
          currencyCode: 'CNY',
          fulfillment: 'FBS',
          products: [{ offerId: 'SKU-202608060418-11-01', skuId: '5359748272', priceValue: 88, qty: 1 }],
        },
        {
          id: '0120367693-0177-1',
          amountValue: 88,
          currencyCode: 'CNY',
          fulfillment: 'FBS',
          products: [{ offerId: 'SKU-202608060418-11-01', skuId: '5359748272', priceValue: 88, qty: 1 }],
        },
      ],
      result.entityMap,
      (order) => order.id,
      { commissionRateMode: 'rFBS' }
    );
    const hydratedRows = applyProfitProductSummaryMaterialToRows(
      commissionRows,
      result.entityMap,
      (order) => order.id
    ).map(applyProfitProductMaterialFallbackToOrder);
    hydratedRows.forEach((row) => {
      expect(row).toMatchObject({ commissionPercent: '12%', commissionAmount: '¥10.56' });
      expect(row.products[0]).toMatchObject({
        image: 'https://cdn.example/5359748272.jpg',
        commissionPercent: 12,
        commissionAmountValue: 10.56,
        materialProfile: {
          weight: '0.18',
          length: '10',
          width: '10',
          height: '10',
        },
      });
    });
  });

  it('never uses one shop product summary as another shop fallback', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input);
      const shopId = url.searchParams.get('shopId');
      return new Response(
        JSON.stringify({
          ok: true,
          rows: shopId === 'shop-a'
            ? [{ shopId: 'shop-a', offerId: 'shared-offer', name: 'A店商品' }]
            : [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const result = await readSalesOrderProductSummaryEntities(
      [
        { id: 'order-a', shopId: 'shop-a', products: [{ offerId: 'shared-offer' }] },
        { id: 'order-b', shopId: 'shop-b', products: [{ offerId: 'shared-offer' }] },
      ],
      [{ id: 'shop-a' }, { id: 'shop-b' }],
      { getRecordKey: (order) => order.id }
    );

    expect(result.entityMap.get('order-a:0')?.name).toBe('A店商品');
    expect(result.entityMap.has('order-b:0')).toBe(false);
  });

  it('keeps product summary as a compact order entity without copying large summary tables', () => {
    const entity = toOrderProductSummaryEntity({
      productId: '101',
      offerId: 'offer-101',
      name: '商品',
      primaryImageUrl: 'https://img.example/main.jpg',
      images: ['https://img.example/main.jpg', 'https://img.example/2.jpg'],
      commissionPercent: 10,
      acquiringFeeValue: 0.51,
      currencyCode: 'CNY',
      sourceLinks: [{ link: 'https://1688.com/item/101', platform: '1688', productId: '101' }],
      materialProfile: { source: 'cross-border-bus', weight: '0.2', length: '20', width: '10', height: '8' },
    });

    expect(entity).toMatchObject({
      productId: '101',
      offerId: 'offer-101',
      mainImage: 'https://img.example/main.jpg',
      productMainImages: ['https://img.example/main.jpg', 'https://img.example/2.jpg'],
      commissionPercent: 10,
      acquiringUnitValue: 0.51,
      currencyCode: 'CNY',
      sourceRecord: { links: [{ platform: '1688', productId: '101' }] },
      materialProfile: { source: 'cross-border-bus', weight: '0.2' },
      source: 'local-api-products-summary',
    });
    expect(entity).not.toHaveProperty('attributes_json');
    expect(entity).not.toHaveProperty('images_json');
    expect(entity).not.toHaveProperty('price_json');
  });

  it('does not use SKU keyword fallback unless explicitly enabled', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const result = await readSalesOrderProductSummaryEntities(
      [
        {
          id: 'order-sku-only',
          shopId: 'ozon-shop-1',
          products: [{ sku: 'sku-only-1' }],
        },
      ],
      [{ id: 'ozon-shop-1' }],
      { getRecordKey: (order) => order.id }
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.entityMap.size).toBe(0);
    expect(result.missingLookupKeys.has('order-sku-only:0')).toBe(true);
  });

  it('uses SKU keyword fallback for profit-only product summary support when enabled', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          rows: [
            {
              shopId: 'ozon-shop-1',
              productId: 'p-1',
              offerId: 'offer-1',
              sku: 'sku-only-1',
              name: 'SKU 命中商品',
              weightKg: 0.2,
              widthCm: 10,
              heightCm: 20,
              depthCm: 30,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await readSalesOrderProductSummaryEntities(
      [
        {
          id: 'order-sku-only',
          shopId: 'ozon-shop-1',
          products: [{ sku: 'sku-only-1' }],
        },
      ],
      [{ id: 'ozon-shop-1' }],
      { getRecordKey: (order) => order.id, enableSkuFallback: true }
    );

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/products/summary');
    expect(url.searchParams.get('keyword')).toBe('sku-only-1');
    expect(result.entityMap.get('order-sku-only:0')).toMatchObject({
      name: 'SKU 命中商品',
      sku: 'sku-only-1',
      weightKg: 0.2,
      depthCm: 30,
    });
  });

  it('keeps SKU fallback matching exact to avoid cross-product material pollution', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          rows: [
            { shopId: 'ozon-shop-1', productId: 'p-wrong', offerId: 'wrong-offer', sku: 'wrong-sku', name: '不应命中' },
            {
              shopId: 'ozon-shop-1',
              productId: 'p-right',
              offerId: 'right-offer',
              sku: 'sku-only-1',
              name: '精确命中',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await readSalesOrderProductSummaryEntities(
      [
        {
          id: 'order-sku-only',
          shopId: 'ozon-shop-1',
          products: [{ sku: 'sku-only-1' }],
        },
      ],
      [{ id: 'ozon-shop-1' }],
      { getRecordKey: (order) => order.id, enableSkuFallback: true }
    );

    expect(result.entityMap.get('order-sku-only:0')).toMatchObject({
      productId: 'p-right',
      name: '精确命中',
    });
  });

  it('uses the immutable Ozon SKU when a historical order offer id has changed', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const emptyResponse = () =>
      new Response(JSON.stringify({ ok: true, rows: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            rows: [
              {
                shopId: 'ozon-shop-1',
                productId: '3652092323',
                offerId: 'dfrrgkkr342',
                sku: '3559566970',
                name: '当前商品',
                primaryImageUrl: 'https://img.example/3559566970.jpg',
                images: ['https://img.example/3559566970.jpg'],
                commissionPercent: 19,
                commissionPercents: { fbo: 22, fbs: 17, rfbs: 19, fbp: 16 },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const result = await readSalesOrderProductSummaryEntities(
      [
        {
          id: '0128350988-0186-1',
          shopId: 'ozon-shop-1',
          products: [
            {
              offerId: 'dea2630_ob_ZTAog',
              sku: 'dea2630_ob_ZTAog',
              skuId: '3559566970',
              productId: '3559566970',
            },
          ],
        },
      ],
      [{ id: 'ozon-shop-1' }],
      { getRecordKey: (order) => order.id, enableSkuFallback: true }
    );

    const fallbackUrl = new URL(fetchMock.mock.calls[2][0]);
    expect(fallbackUrl.searchParams.get('keyword')).toBe('3559566970');
    expect(result.entityMap.get('0128350988-0186-1:0')).toMatchObject({
      productId: '3652092323',
      offerId: 'dfrrgkkr342',
      sku: '3559566970',
      mainImage: 'https://img.example/3559566970.jpg',
      commissionPercent: 19,
    });
    expect(result.missingLookupKeys.size).toBe(0);

    const [hydratedOrder] = applyOzonLocalProductEntitiesToRows(
      [
        {
          id: '0128350988-0186-1',
          amountValue: 262,
          currencyCode: 'CNY',
          fulfillment: 'FBS',
          products: [
            {
              offerId: 'dea2630_ob_ZTAog',
              sku: 'dea2630_ob_ZTAog',
              skuId: '3559566970',
              productId: '3559566970',
              priceValue: 262,
              qty: 1,
              image: '',
            },
          ],
        },
      ],
      result.entityMap,
      (order) => order.id
    );
    expect(hydratedOrder.products[0]).toMatchObject({
      offerId: 'dea2630_ob_ZTAog',
      image: 'https://img.example/3559566970.jpg',
      commissionPercent: 17,
      commissionAmountValue: 44.54,
    });
    expect(hydratedOrder).toMatchObject({
      commissionPercent: '17%',
      commissionAmount: '¥44.54',
    });
  });

});
