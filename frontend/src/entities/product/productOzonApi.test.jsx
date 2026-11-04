import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestOzonReadOnly } from '../../shared/ozon/ozonRuntime.jsx';
import {
  getDeliveryMethodStatusLabel,
  getOzonDeliveryMethodDisplayName,
  getWarehouseStatusLabel,
  requestOzonWarehouseConfigSnapshot,
  requestOzonWarehouseProductsSnapshot,
} from './productOzonApi.jsx';

vi.mock('../../shared/ozon/ozonRuntime.jsx', () => ({
  isOzonAbortReadError: vi.fn(() => false),
  isOzonRetryableReadError: vi.fn(() => false),
  requestOzonReadOnly: vi.fn(),
}));

describe('productOzonApi warehouse config snapshot', () => {
  beforeEach(() => {
    requestOzonReadOnly.mockReset();
  });

  it('formats Ozon logistics labels for Chinese page display', () => {
    expect(getDeliveryMethodStatusLabel('ACTIVE')).toBe('启用');
    expect(getDeliveryMethodStatusLabel('DISABLED')).toBe('停用');
    expect(getWarehouseStatusLabel('blocked')).toBe('阻断');
    expect(getWarehouseStatusLabel('disabled')).toBe('停用');
    expect(getOzonDeliveryMethodDisplayName('标准-超级轻小件-路空联运到配送点 PUDO')).toBe(
      '标准-超级轻小件-路空联运到配送点'
    );
    expect(getOzonDeliveryMethodDisplayName('标准-超级轻小件-路空联运到配送点 Courier')).toBe(
      '标准-超级轻小件-路空联运到配送点 快递'
    );
  });

  it('keeps blocked or disabled Ozon warehouses when the warehouse page asks for raw returned rows', async () => {
    requestOzonReadOnly.mockImplementation((endpoint, _shop, body, requestOptions) => {
      expect(requestOptions).toMatchObject({ maxRetries: 0, timeoutMs: 3000 });
      if (endpoint === '/v2/warehouse/list') {
        expect(body.forceRefresh).toBe(true);
        expect(body.backgroundRefresh).toBe(true);
        return Promise.resolve({
          warehouses: [
            { warehouse_id: 1020005014175280, name: '一号', status: 'blocked' },
            { warehouse_id: 1020005014308600, name: '陆空联运', status: 'disabled' },
          ],
        });
      }
      if (endpoint === '/v2/delivery-method/list') {
        expect(body.forceRefresh).toBe(true);
        expect(body.backgroundRefresh).toBe(true);
        return Promise.resolve({
          delivery_methods: [
            { id: 35877421, warehouse_id: 1020005014175280, name: '标准配送 PUDO', status: 'ACTIVE' },
            { id: 28498649, warehouse_id: 1020005014308600, name: '陆空联运 Courier', status: 'DISABLED' },
          ],
        });
      }
      return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
    });

    const snapshot = await requestOzonWarehouseConfigSnapshot(
      { id: 'ozon-shop-1' },
      { includeInactive: true, forceRefresh: true, backgroundRefresh: true }
    );

    expect(snapshot.warehouses).toHaveLength(2);
    expect(snapshot.deliveryMethods).toHaveLength(2);
    expect(snapshot.allWarehouseCount).toBe(2);
    expect(snapshot.inactiveWarehouseCount).toBe(2);
    expect(snapshot.allDeliveryMethodCount).toBe(2);
    expect(snapshot.inactiveDeliveryMethodCount).toBe(1);
    expect(snapshot.warehouses.map((warehouse) => warehouse.status)).toEqual(['blocked', 'disabled']);
  });

  it('keeps the default usable-only behavior for write-oriented consumers', async () => {
    requestOzonReadOnly.mockImplementation((endpoint) => {
      if (endpoint === '/v2/warehouse/list') {
        return Promise.resolve({
          warehouses: [
            { warehouse_id: 1, name: 'Blocked WH', status: 'blocked' },
            { warehouse_id: 2, name: 'Active WH', status: 'active' },
          ],
        });
      }
      if (endpoint === '/v2/delivery-method/list') {
        return Promise.resolve({
          delivery_methods: [
            { id: 11, warehouse_id: 1, name: 'Blocked WH Method', status: 'ACTIVE' },
            { id: 12, warehouse_id: 2, name: 'Active WH Method', status: 'ACTIVE' },
          ],
        });
      }
      return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
    });

    const snapshot = await requestOzonWarehouseConfigSnapshot({ id: 'ozon-shop-1' });

    expect(snapshot.warehouses.map((warehouse) => warehouse.name)).toEqual(['Active WH']);
    expect(snapshot.deliveryMethods.map((method) => method.name)).toEqual(['Active WH Method']);
    expect(snapshot.allWarehouseCount).toBe(2);
    expect(snapshot.inactiveWarehouseCount).toBe(1);
  });

  it('waits for the exact selected shop fresh logistics cache before returning', async () => {
    requestOzonReadOnly.mockImplementation((endpoint, shop, body, requestOptions) => {
      expect(shop.id).toBe('ozon-shop-2');
      expect(body.forceRefresh).toBe(true);
      expect(body.backgroundRefresh).toBeUndefined();
      expect(requestOptions).toMatchObject({
        maxRetries: 0,
        timeoutMs: 25_000,
        logisticsSyncTimeoutMs: 20_000,
        logisticsSyncPollIntervalMs: 250,
      });
      if (endpoint === '/v2/warehouse/list') {
        return Promise.resolve({
          warehouses: [{ warehouse_id: 1020005007227510, name: '二店仓库', status: 'created' }],
        });
      }
      if (endpoint === '/v2/delivery-method/list') {
        return Promise.resolve({
          delivery_methods: Array.from({ length: 18 }, (_, index) => ({
            id: index + 1,
            warehouse_id: 1020005007227510,
            name: `配送方式 ${index + 1}`,
            status: 'ACTIVE',
          })),
        });
      }
      return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
    });

    const snapshot = await requestOzonWarehouseConfigSnapshot(
      { id: 'ozon-shop-2' },
      { includeInactive: true, forceRefresh: true }
    );

    expect(snapshot.warehouses).toHaveLength(1);
    expect(snapshot.deliveryMethods).toHaveLength(18);
    expect(snapshot.deliveryMethods.every((method) => method.warehouseId === '1020005007227510')).toBe(true);
  });

  it('keeps concurrent bound-shop logistics reads isolated by exact shop', async () => {
    requestOzonReadOnly.mockImplementation((endpoint, shop) => {
      const suffix = shop.id === 'ozon-shop-a' ? 'A' : 'B';
      if (endpoint === '/v2/warehouse/list') {
        return Promise.resolve({
          warehouses: [{ warehouse_id: `warehouse-${suffix}`, name: `${suffix} 仓`, status: 'created' }],
        });
      }
      if (endpoint === '/v2/delivery-method/list') {
        return Promise.resolve({
          delivery_methods: [
            { id: `method-${suffix}`, warehouse_id: `warehouse-${suffix}`, name: `${suffix} 配送`, status: 'ACTIVE' },
          ],
        });
      }
      return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
    });

    const [shopA, shopB] = await Promise.all([
      requestOzonWarehouseConfigSnapshot({ id: 'ozon-shop-a' }, { includeInactive: true, forceRefresh: true }),
      requestOzonWarehouseConfigSnapshot({ id: 'ozon-shop-b' }, { includeInactive: true, forceRefresh: true }),
    ]);

    expect(shopA.warehouses[0].rawId).toBe('warehouse-A');
    expect(shopA.deliveryMethods[0].warehouseId).toBe('warehouse-A');
    expect(shopB.warehouses[0].rawId).toBe('warehouse-B');
    expect(shopB.deliveryMethods[0].warehouseId).toBe('warehouse-B');
    expect(requestOzonReadOnly.mock.calls.filter(([, shop]) => shop.id === 'ozon-shop-a')).toHaveLength(2);
    expect(requestOzonReadOnly.mock.calls.filter(([, shop]) => shop.id === 'ozon-shop-b')).toHaveLength(2);
  });

  it('does not repeat background warehouse reads after the fast local timeout', async () => {
    requestOzonReadOnly.mockRejectedValue(new Error('local cache busy'));

    await expect(
      requestOzonWarehouseConfigSnapshot({ id: 'ozon-shop-1' }, { backgroundRefresh: true })
    ).rejects.toThrow(/仓库读取失败/u);

    expect(requestOzonReadOnly).toHaveBeenCalledTimes(2);
    expect(requestOzonReadOnly.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      '/v2/warehouse/list',
      '/v2/delivery-method/list',
    ]);
    expect(requestOzonReadOnly.mock.calls.every((call) => call[3].timeoutMs === 3000)).toBe(true);
    expect(requestOzonReadOnly.mock.calls.every((call) => call[3].maxRetries === 0)).toBe(true);
  });
});

describe('productOzonApi warehouse product snapshot', () => {
  beforeEach(() => {
    requestOzonReadOnly.mockReset();
  });

  it('walks every Ozon product-list page instead of keeping only the first 100 rows', async () => {
    requestOzonReadOnly.mockImplementation((endpoint, _shop, body, requestOptions) => {
      if (endpoint === '/v3/product/list') {
        expect(body.limit).toBe(5000);
        expect(body.projection).toBe('warehouse-picker');
        expect(requestOptions).toMatchObject({ maxRetries: 0, timeoutMs: 3000 });
        if (!body.last_id) {
          return Promise.resolve({
            result: {
              total: 3,
              last_id: 'offset:2',
              items: [
                {
                  product_id: 101,
                  offer_id: 'offer-101',
                  sku: 'sku-101',
                  name: '列表商品 101',
                  primary_image: 'https://img.test/101-list.jpg',
                  images: ['https://img.test/101-list.jpg'],
                },
                { product_id: 102, offer_id: 'offer-102', sku: 'sku-102', name: '列表商品 102' },
              ],
            },
          });
        }
        expect(body.last_id).toBe('offset:2');
        return Promise.resolve({
          result: {
            total: 3,
            last_id: '',
            items: [
              {
                product_id: 103,
                offer_id: 'offer-103',
                sku: 'sku-103',
                name: '列表商品 103',
                primary_image: 'https://img.test/103-list.jpg',
                images: ['https://img.test/103-list.jpg'],
              },
            ],
          },
        });
      }

      if (endpoint === '/v3/product/info/list') {
        return Promise.resolve({
          items: body.product_id.map((productId) => ({
            id: productId,
            offer_id: `offer-${productId}`,
            sku: `sku-${productId}`,
            name: `详情商品 ${productId}`,
          })),
        });
      }

      if (endpoint === '/v4/product/info/stocks') {
        return Promise.resolve({
          items: body.filter.product_id.map((productId) => ({
            product_id: productId,
            offer_id: `offer-${productId}`,
            stocks: [{ warehouse_id: `warehouse-${productId}`, present: 1 }],
          })),
        });
      }

      if (endpoint === '/v2/product/pictures/info') {
        expect(body.product_id).toEqual([101, 102, 103]);
        return Promise.resolve({
          items: [{ product_id: 102, offer_id: 'offer-102', primary_image: 'https://img.test/102-picture.jpg' }],
        });
      }

      return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
    });

    const snapshot = await requestOzonWarehouseProductsSnapshot({ id: 'ozon-shop-1' });

    expect(snapshot.total).toBe(3);
    expect(snapshot.rows.map((row) => row.productId)).toEqual(['101', '102', '103']);
    expect(snapshot.rows.map((row) => row.image)).toEqual([
      'https://img.test/101-list.jpg',
      'https://img.test/102-picture.jpg',
      'https://img.test/103-list.jpg',
    ]);
    expect(requestOzonReadOnly.mock.calls.filter(([endpoint]) => endpoint === '/v3/product/list')).toHaveLength(2);
  });

  it('can return warehouse product rows from the local product-list cache without slow detail hydration', async () => {
    requestOzonReadOnly.mockImplementation((endpoint, _shop, body, requestOptions) => {
      if (endpoint === '/v3/product/list') {
        expect(body.projection).toBe('warehouse-picker');
        expect(requestOptions).toMatchObject({ maxRetries: 0, timeoutMs: 3000 });
        return Promise.resolve({
          result: {
            total: 1,
            last_id: '',
            items: [
              {
                product_id: 201,
                offer_id: 'offer-201',
                sku: 'sku-201',
                name: '缓存商品 201',
                primary_image: 'https://img.test/201-list.jpg',
                images: ['https://img.test/201-list.jpg'],
                warehouse_stocks: [{ warehouseId: 1020005020379050, presentQuantity: 3 }],
              },
            ],
          },
        });
      }
      return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
    });

    const snapshot = await requestOzonWarehouseProductsSnapshot({ id: 'ozon-shop-1' }, { hydrate: false });

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]).toMatchObject({
      productId: '201',
      image: 'https://img.test/201-list.jpg',
      warehouseStatus: '1020005020379050',
    });
    expect(requestOzonReadOnly.mock.calls.map(([endpoint]) => endpoint)).toEqual(['/v3/product/list']);
  });

  it('submits one background refresh and keeps the warehouse picker on compact SQLite rows', async () => {
    requestOzonReadOnly.mockResolvedValue({ result: { total: 0, last_id: '', items: [] } });

    await requestOzonWarehouseProductsSnapshot({ id: 'ozon-shop-1' }, { hydrate: false, forceRefresh: true });

    expect(requestOzonReadOnly).toHaveBeenCalledOnce();
    expect(requestOzonReadOnly.mock.calls[0][2]).toMatchObject({
      projection: 'warehouse-picker',
      forceRefresh: true,
      autoSync: true,
    });
    expect(requestOzonReadOnly.mock.calls[0][3]).toMatchObject({ maxRetries: 0, timeoutMs: 3000 });
  });
});
