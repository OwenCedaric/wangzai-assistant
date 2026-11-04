import { describe, expect, it } from 'vitest';
import {
  createEmptyOzonLocalDataStore,
  mergeOzonProductSnapshotIntoLocalStore,
  mergeOzonSnapshotIntoLocalStore,
  normalizeOzonLocalDataStore,
  readOzonProductEntitiesFromLocalStore,
  readOzonProductRowsFromLocalStore,
  readOzonProductSnapshotFromLocalStore,
  readOzonSnapshotFromLocalStore,
  searchOzonProductEntitiesFromLocalStore,
} from './ozonLocalDataLayer.js';

describe('ozonLocalDataLayer products', () => {
  it('keeps product image payloads out of entity fields so local mirrors stay lightweight', () => {
    const store = createEmptyOzonLocalDataStore();
    store.products['shop-a:offer-1'] = {
      key: 'shop-a:offer-1',
      shopKey: 'shop-a',
      offerId: 'offer-1',
      fields: {
        name: 'Old Product',
        image: 'data:image/png;base64,large-old-payload',
        images: ['data:image/png;base64,large-old-array-payload'],
        image_url: 'data:image/png;base64,legacy-url-payload',
      },
      fieldMeta: {
        image: { source: 'legacy-cache' },
        images: { source: 'legacy-cache' },
        image_url: { source: 'legacy-cache' },
        name: { source: 'legacy-cache' },
      },
      imageUrls: [],
      skuImageUrls: [],
      mainImageUrls: [],
      firstSeenAt: '2026-06-23T00:00:00.000Z',
      updatedAt: '2026-06-23T00:00:00.000Z',
      lastSeenAt: '2026-06-23T00:00:00.000Z',
    };

    const updated = mergeOzonProductSnapshotIntoLocalStore(
      store,
      'ozon-products:shop-a:all',
      {
        rows: [
          {
            offerId: 'offer-1',
            name: 'Fresh Product',
            image: 'https://cdn.example/fresh.jpg',
            images: ['data:image/png;base64,new-large-payload', 'https://cdn.example/fresh.jpg'],
          },
        ],
      },
      { shopKey: 'shop-a', now: '2026-06-23T00:01:00.000Z' }
    ).store;

    const product = updated.products['shop-a:offer-1'];
    expect(product.fields).toMatchObject({ name: 'Fresh Product' });
    expect(product.fields.image).toBeUndefined();
    expect(product.fields.images).toBeUndefined();
    expect(product.fields.image_url).toBeUndefined();
    expect(product.fieldMeta.image).toBeUndefined();
    expect(product.fieldMeta.images).toBeUndefined();
    expect(product.fieldMeta.image_url).toBeUndefined();
    expect(Object.keys(updated.images)).toEqual(['https://cdn.example/fresh.jpg']);
    expect(readOzonProductSnapshotFromLocalStore(updated, 'ozon-products:shop-a:all').rows[0]).toMatchObject({
      image: 'https://cdn.example/fresh.jpg',
      images: ['https://cdn.example/fresh.jpg'],
    });
  });

  it('does not persist base64 image payloads from order or product raw fields', () => {
    const { store } = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-sales-orders:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:posting-1',
            shopClientId: 'shop-a',
            raw: {
              image: 'data:image/png;base64,order-raw-payload',
            },
            products: [
              {
                offerId: 'offer-1',
                image: 'data:image/png;base64,top-level-payload',
                images: ['data:image/png;base64,array-payload', 'https://cdn.example/a.jpg'],
                raw: {
                  image: 'data:image/png;base64,product-raw-payload',
                  pictures: ['data:image/png;base64,raw-array-payload'],
                },
              },
            ],
          },
        ],
      },
      { now: '2026-06-23T00:00:00.000Z' }
    );

    const serialized = JSON.stringify(store);
    expect(serialized).not.toContain('data:image');
    expect(serialized).not.toContain('base64');
    expect(Object.keys(store.images)).toEqual(['https://cdn.example/a.jpg']);
  });

  it('stores product list snapshots as reusable product and image entities', () => {
    const { store, stats } = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-products:shop-a:all:20:1',
      {
        rows: [
          {
            productId: '1001',
            offerId: 'offer-1',
            name: 'Product A',
            status: '出售中',
            image: 'https://cdn.example/product-a.jpg',
            images: ['https://cdn.example/product-a.jpg'],
            raw: { large: 'not-saved' },
          },
          {
            productId: '1002',
            offerId: 'offer-2',
            name: 'Product B',
            status: '待销售',
            image: 'https://cdn.example/product-a.jpg',
          },
        ],
        total: 8,
        page: 1,
        pageSize: 20,
        statusCounts: { 全部商品: 8 },
      },
      { shopKey: 'shop-a', now: '2026-06-23T01:00:00.000Z' }
    );

    expect(stats).toMatchObject({ rows: 2, products: 2, images: 1 });
    expect(Object.values(store.products)[0].fields.raw).toBeUndefined();

    const snapshot = readOzonProductSnapshotFromLocalStore(store, 'ozon-products:shop-a:all:20:1');
    expect(snapshot).toMatchObject({
      total: 8,
      page: 1,
      pageSize: 20,
      statusCounts: { 全部商品: 8 },
    });
    expect(snapshot.rows).toHaveLength(2);
    expect(snapshot.rows[0]).toMatchObject({
      productId: '1001',
      offerId: 'offer-1',
      image: 'https://cdn.example/product-a.jpg',
      images: ['https://cdn.example/product-a.jpg'],
    });
  });

  it('prunes stale product page snapshots after writing a full snapshot without deleting product entities', () => {
    const pageSnapshot = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-products:shop-a:ALL:20:1',
      {
        rows: [
          { productId: '1001', offerId: 'offer-1', shopClientId: 'shop-a', name: 'Product A' },
          { productId: '1002', offerId: 'offer-2', shopClientId: 'shop-a', name: 'Product B' },
        ],
        total: 3,
      },
      { shopKey: 'shop-a', now: '2026-06-23T01:00:00.000Z' }
    );

    const otherStatusSnapshot = mergeOzonProductSnapshotIntoLocalStore(
      pageSnapshot.store,
      'ozon-products:shop-a:ARCHIVED:20:1',
      {
        rows: [{ productId: 'archived-1', offerId: 'archived-1', shopClientId: 'shop-a', name: 'Archived Product' }],
        total: 1,
      },
      { shopKey: 'shop-a', now: '2026-06-23T01:01:00.000Z' }
    );

    const fullSnapshot = mergeOzonProductSnapshotIntoLocalStore(
      otherStatusSnapshot.store,
      'ozon-products:shop-a:ALL:full',
      {
        rows: [
          { productId: '1001', offerId: 'offer-1', shopClientId: 'shop-a', name: 'Product A' },
          { productId: '1002', offerId: 'offer-2', shopClientId: 'shop-a', name: 'Product B' },
          { productId: '1003', offerId: 'offer-3', shopClientId: 'shop-a', name: 'Product C' },
        ],
        total: 3,
      },
      { shopKey: 'shop-a', now: '2026-06-23T01:02:00.000Z' }
    );

    expect(readOzonProductSnapshotFromLocalStore(fullSnapshot.store, 'ozon-products:shop-a:ALL:20:1')).toBeNull();
    expect(
      readOzonProductSnapshotFromLocalStore(fullSnapshot.store, 'ozon-products:shop-a:ALL:full').rows
    ).toHaveLength(3);
    expect(
      readOzonProductSnapshotFromLocalStore(fullSnapshot.store, 'ozon-products:shop-a:ARCHIVED:20:1').rows
    ).toHaveLength(1);
    expect(fullSnapshot.store.products['shop-a:offer-1']).toBeDefined();
    expect(fullSnapshot.store.products['shop-a:offer-2']).toBeDefined();
    expect(fullSnapshot.store.products['shop-a:offer-3']).toBeDefined();
    expect(fullSnapshot.store.products['shop-a:archived-1']).toBeDefined();
    expect(fullSnapshot.stats.prunedPageSnapshots).toBe(1);
  });

  it('normalizes legacy stores by pruning product page snapshots superseded by full snapshots', () => {
    const store = createEmptyOzonLocalDataStore();
    store.products = {
      'shop-a:offer-1': { key: 'shop-a:offer-1', fields: { offerId: 'offer-1', name: 'Product A' } },
      'shop-a:offer-2': { key: 'shop-a:offer-2', fields: { offerId: 'offer-2', name: 'Product B' } },
      'shop-a:archived-1': { key: 'shop-a:archived-1', fields: { offerId: 'archived-1', name: 'Archived Product' } },
    };
    store.snapshots = {
      'ozon-products:shop-a:ALL:20:1': {
        key: 'ozon-products:shop-a:ALL:20:1',
        type: 'products',
        productKeys: ['shop-a:offer-1'],
        updatedAt: '2026-06-23T01:00:00.000Z',
      },
      'ozon-products:shop-a:ALL:full': {
        key: 'ozon-products:shop-a:ALL:full',
        type: 'products',
        productKeys: ['shop-a:offer-1', 'shop-a:offer-2'],
        updatedAt: '2026-06-23T01:02:00.000Z',
      },
      'ozon-products:shop-a:ARCHIVED:20:1': {
        key: 'ozon-products:shop-a:ARCHIVED:20:1',
        type: 'products',
        productKeys: ['shop-a:archived-1'],
        updatedAt: '2026-06-23T01:01:00.000Z',
      },
    };

    const normalized = normalizeOzonLocalDataStore(store);

    expect(normalized.snapshots['ozon-products:shop-a:ALL:20:1']).toBeUndefined();
    expect(normalized.snapshots['ozon-products:shop-a:ALL:full']).toBeDefined();
    expect(normalized.snapshots['ozon-products:shop-a:ARCHIVED:20:1']).toBeDefined();
    expect(normalized.products['shop-a:offer-1']).toBeDefined();
    expect(normalized.products['shop-a:offer-2']).toBeDefined();
    expect(normalized.products['shop-a:archived-1']).toBeDefined();
  });

  it('updates product snapshots without duplicating unchanged products', () => {
    const initial = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-products:shop-a:all:20:1',
      {
        rows: [
          {
            productId: '1001',
            offerId: 'offer-1',
            status: '出售中',
            priceValue: 10,
            image: 'https://cdn.example/product-a.jpg',
          },
        ],
      },
      { shopKey: 'shop-a', now: '2026-06-23T01:00:00.000Z' }
    );

    const updated = mergeOzonProductSnapshotIntoLocalStore(
      initial.store,
      'ozon-products:shop-a:all:20:1',
      {
        rows: [
          {
            productId: '1001',
            offerId: 'offer-1',
            status: '待销售',
            priceValue: 12,
            image: 'https://cdn.example/product-a.jpg',
          },
        ],
      },
      { shopKey: 'shop-a', now: '2026-06-23T01:05:00.000Z' }
    );

    expect(Object.keys(updated.store.products)).toHaveLength(1);
    expect(Object.keys(updated.store.images)).toHaveLength(1);
    expect(readOzonProductSnapshotFromLocalStore(updated.store, 'ozon-products:shop-a:all:20:1').rows[0]).toMatchObject(
      {
        status: '待销售',
        priceValue: 12,
      }
    );
  });

  it('keeps product snapshot display fields isolated from later shared entity updates', () => {
    const initial = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-products:shop-a:TO_SUPPLY:20:1',
      {
        rows: [
          {
            productId: '1001',
            offerId: 'offer-1',
            status: '待销售',
            price: '¥17.00',
            priceValue: 17,
            commissionPercent: 12,
            commissionAmount: '¥2.04',
            commissionAmountValue: 2.04,
          },
        ],
      },
      { shopKey: 'shop-a', now: '2026-06-23T01:00:00.000Z' }
    );

    const updated = mergeOzonProductSnapshotIntoLocalStore(
      initial.store,
      'ozon-product-supplements:shop-a',
      {
        rows: [
          {
            productId: '1001',
            offerId: 'offer-1',
            status: '出售中',
            price: '¥19.00',
            priceValue: 19,
            commissionAmount: '¥0.00',
            commissionAmountValue: 0,
          },
        ],
      },
      { shopKey: 'shop-a', now: '2026-06-23T01:05:00.000Z' }
    );

    expect(updated.store.products['shop-a:offer-1'].fields).toMatchObject({
      status: '出售中',
      priceValue: 19,
      commissionAmountValue: 0,
    });
    expect(
      readOzonProductSnapshotFromLocalStore(updated.store, 'ozon-products:shop-a:TO_SUPPLY:20:1').rows[0]
    ).toMatchObject({
      status: '待销售',
      price: '¥17.00',
      priceValue: 17,
      commissionAmount: '¥2.04',
      commissionAmountValue: 2.04,
    });
  });

  it('keeps previous good product fields when a later read returns empty or pending values', () => {
    const initial = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-products:shop-a:all:20:1',
      {
        rows: [
          {
            productId: '1001',
            offerId: 'offer-1',
            name: 'Product A',
            commissionPercent: 12,
            image: 'https://cdn.example/product-a.jpg',
          },
        ],
      },
      { shopKey: 'shop-a', now: '2026-06-23T01:00:00.000Z' }
    );

    const updated = mergeOzonProductSnapshotIntoLocalStore(
      initial.store,
      'ozon-products:shop-a:all:20:1',
      {
        rows: [
          {
            productId: '1001',
            offerId: 'offer-1',
            name: '未返回',
            commissionPercent: '待确认',
            image: '',
            images: [],
          },
        ],
      },
      { shopKey: 'shop-a', now: '2026-06-23T01:05:00.000Z' }
    );

    const snapshot = readOzonProductSnapshotFromLocalStore(updated.store, 'ozon-products:shop-a:all:20:1');
    expect(snapshot.rows[0]).toMatchObject({
      name: 'Product A',
      commissionPercent: 12,
      image: 'https://cdn.example/product-a.jpg',
    });
    expect(updated.store.products['shop-a:offer-1'].fieldMeta.name).toMatchObject({
      status: 'cached',
      lastMissingReason: '未返回',
    });
    expect(updated.store.products['shop-a:offer-1'].fieldMeta.commissionPercent).toMatchObject({
      status: 'cached',
      lastMissingReason: '待确认',
    });
  });

  it('merges product daily commission rates without overwriting older rate dates', () => {
    const initial = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-product-supplements:shop-a',
      {
        rows: [
          {
            offerId: 'offer-1',
            commissionPercent: 12,
            commissionRateDate: '2026-06-25',
            commissionPercentDailyRates: {
              '2026-06-25': { rate: 12, mode: 'rFBS', source: 'ozon:/v5/product/info/prices' },
            },
          },
        ],
      },
      { shopKey: 'shop-a', now: '2026-06-25T01:00:00.000Z' }
    );

    const updated = mergeOzonProductSnapshotIntoLocalStore(
      initial.store,
      'ozon-product-supplements:shop-a',
      {
        rows: [
          {
            offerId: 'offer-1',
            commissionPercent: 15,
            commissionRateDate: '2026-07-01',
            commissionPercentDailyRates: {
              '2026-07-01': { rate: 15, mode: 'rFBS', source: 'ozon:/v5/product/info/prices' },
            },
          },
        ],
      },
      { shopKey: 'shop-a', now: '2026-07-01T01:00:00.000Z' }
    );

    const entity = updated.store.products['shop-a:offer-1'];
    expect(entity.fields.commissionPercentDailyRates).toMatchObject({
      '2026-06-25': { rate: 12 },
      '2026-07-01': { rate: 15 },
    });
    expect(entity.fields.commissionRateDate).toBe('2026-07-01');
  });

  it('keeps saved product images when a later order snapshot has no image fields', () => {
    const withImages = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-product-supplements:shop-a',
      {
        rows: [
          {
            offerId: 'offer-1',
            sku: 'sku-1',
            image: 'https://cdn.example/product-a.jpg',
            mainImages: ['https://cdn.example/product-a-main.jpg'],
          },
        ],
      },
      { shopKey: 'shop-a', now: '2026-06-23T01:00:00.000Z' }
    );

    const refreshedOrder = mergeOzonSnapshotIntoLocalStore(
      withImages.store,
      'ozon-sales-orders:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:posting-1',
            shopClientId: 'shop-a',
            posting: 'posting-1',
            products: [{ offerId: 'offer-1', sku: 'sku-1', name: 'Product A' }],
          },
        ],
      },
      { now: '2026-06-23T01:05:00.000Z' }
    );

    const snapshot = readOzonSnapshotFromLocalStore(refreshedOrder.store, 'ozon-sales-orders:shop-a');
    expect(snapshot.rows[0].products[0]).toMatchObject({
      offerId: 'offer-1',
      image: 'https://cdn.example/product-a.jpg',
    });
    expect(snapshot.rows[0].products[0].mainImages).toContain('https://cdn.example/product-a-main.jpg');

    const entities = readOzonProductEntitiesFromLocalStore(
      refreshedOrder.store,
      [{ offerId: 'offer-1', sku: 'sku-1' }],
      { shopKeys: ['shop-a'] }
    );
    expect(entities[0].image).toBe('https://cdn.example/product-a.jpg');
  });

  it('hydrates order products with saved product commission when order rows return missing commission', () => {
    const withProductCommission = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-product-supplements:shop-a',
      {
        rows: [
          {
            offerId: 'offer-1',
            sku: 'sku-1',
            price: '¥30.00',
            priceValue: 30,
            commissionPercent: 12,
            commissionPercentText: '12%',
          },
        ],
      },
      { shopKey: 'shop-a', now: '2026-06-23T01:00:00.000Z' }
    );

    const refreshedOrder = mergeOzonSnapshotIntoLocalStore(
      withProductCommission.store,
      'ozon-sales-orders:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:posting-1',
            shopClientId: 'shop-a',
            posting: 'posting-1',
            products: [
              {
                offerId: 'offer-1',
                sku: 'sku-1',
                price: '¥27.00',
                priceValue: 27,
                commissionPercent: null,
                commissionPercentText: '未返回',
              },
            ],
          },
        ],
      },
      { now: '2026-06-23T01:05:00.000Z' }
    );

    const snapshot = readOzonSnapshotFromLocalStore(refreshedOrder.store, 'ozon-sales-orders:shop-a');
    expect(snapshot.rows[0].products[0]).toMatchObject({
      offerId: 'offer-1',
      price: '¥27.00',
      priceValue: 27,
      commissionPercent: 12,
      commissionPercentText: '12%',
    });
  });

  it('keeps the previous product snapshot when refresh fails before rows return', () => {
    const initial = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-products:shop-a:all:20:1',
      {
        rows: [{ productId: '1001', offerId: 'offer-1', image: 'https://cdn.example/product-a.jpg' }],
      },
      { shopKey: 'shop-a', now: '2026-06-23T01:00:00.000Z' }
    );

    const failed = mergeOzonProductSnapshotIntoLocalStore(
      initial.store,
      'ozon-products:shop-a:all:20:1',
      {
        rows: [],
        errors: [{ label: '商品列表', error: new Error('HTTP 429') }],
      },
      { shopKey: 'shop-a', now: '2026-06-23T01:05:00.000Z' }
    );

    const snapshot = readOzonProductSnapshotFromLocalStore(failed.store, 'ozon-products:shop-a:all:20:1');
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.errors).toEqual([{ label: '商品列表', message: 'HTTP 429' }]);
  });

  it('keeps product snapshot rows when an empty failed refresh returns', () => {
    const initial = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-products:shop-a:all',
      {
        rows: [{ productId: 'product-1', offerId: 'offer-1', sku: 'sku-1', name: 'Cached Product' }],
      },
      { shopKey: 'shop-a', now: '2026-06-23T03:00:00.000Z' }
    );

    const failed = mergeOzonProductSnapshotIntoLocalStore(
      initial.store,
      'ozon-products:shop-a:all',
      {
        rows: [],
        errors: [{ label: 'Products', message: 'HTTP 500' }],
      },
      { shopKey: 'shop-a', now: '2026-06-23T03:01:00.000Z' }
    );

    const snapshot = readOzonProductSnapshotFromLocalStore(failed.store, 'ozon-products:shop-a:all');

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].offerId).toBe('offer-1');
    expect(snapshot.changeSummary).toMatchObject({ skippedEmpty: 1, failed: 1 });
  });

  it('marks missing product snapshot rows as not seen instead of deleting product entities', () => {
    const initial = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-products:shop-a:all',
      {
        rows: [
          { productId: 'product-1', offerId: 'offer-1', name: 'Cached Product 1' },
          { productId: 'product-2', offerId: 'offer-2', name: 'Cached Product 2' },
        ],
      },
      { shopKey: 'shop-a', now: '2026-06-23T04:00:00.000Z' }
    );

    const refreshed = mergeOzonProductSnapshotIntoLocalStore(
      initial.store,
      'ozon-products:shop-a:all',
      {
        rows: [{ productId: 'product-2', offerId: 'offer-2', name: 'Cached Product 2' }],
      },
      { shopKey: 'shop-a', now: '2026-06-23T04:01:00.000Z' }
    );

    expect(readOzonProductSnapshotFromLocalStore(refreshed.store, 'ozon-products:shop-a:all').rows).toHaveLength(1);
    expect(refreshed.store.products['shop-a:offer-1']).toMatchObject({
      notSeenInLastRefresh: true,
      needsVerify: true,
      lastNotSeenAt: '2026-06-23T04:01:00.000Z',
      lastNotSeenSnapshotKey: 'ozon-products:shop-a:all',
    });
    expect(refreshed.store.products['shop-a:offer-2'].notSeenInLastRefresh).toBeUndefined();
  });

  it('keeps product snapshot references consistent after entity pruning', () => {
    const rows = Array.from({ length: 5005 }, (_, index) => ({
      productId: `product-${index}`,
      offerId: `offer-${index}`,
      shopClientId: 'shop-a',
      name: `Product ${index}`,
    }));

    const merged = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'products:shop-a:wide-range',
      { rows },
      { now: '2026-06-01T00:00:00.000Z' }
    );

    const snapshot = merged.store.snapshots['products:shop-a:wide-range'];
    expect(Object.keys(merged.store.products)).toHaveLength(5000);
    expect(snapshot.productKeys).toHaveLength(5000);
    expect(snapshot.productKeys.every((key) => Boolean(merged.store.products[key]))).toBe(true);
    expect(readOzonProductSnapshotFromLocalStore(merged.store, 'products:shop-a:wide-range').rows).toHaveLength(5000);
  });

  it('reads reusable product entities by order product identity and shop candidates', () => {
    const { store } = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-products:shop-a:client-a:all:20:1',
      {
        rows: [
          {
            productId: '1001',
            offerId: 'offer-1',
            sku: 'sku-1',
            image: 'https://cdn.example/product-a.jpg',
            mainImages: ['https://cdn.example/product-a-main.jpg'],
            commissionPercent: 12,
          },
        ],
      },
      { shopKey: 'shop-a:client-a', now: '2026-06-23T02:00:00.000Z' }
    );

    const entities = readOzonProductEntitiesFromLocalStore(store, [{ offerId: 'offer-1', raw: { sku: 'sku-1' } }], {
      shopKeys: ['client-a', 'shop-a:client-a'],
    });

    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({
      offerId: 'offer-1',
      productId: '1001',
      image: 'https://cdn.example/product-a.jpg',
      commissionPercent: 12,
      localShopKey: 'shop-a:client-a',
    });
    expect(entities[0].mainImages).toContain('https://cdn.example/product-a-main.jpg');
  });

  it('reads product entities by product id when the stored key was created from offer id', () => {
    const { store } = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-products:shop-a:all:20:1',
      {
        rows: [{ productId: '1001', offerId: 'offer-1', image: 'https://cdn.example/product-a.jpg' }],
      },
      { shopKey: 'shop-a', now: '2026-06-23T02:00:00.000Z' }
    );

    const entities = readOzonProductEntitiesFromLocalStore(store, [{ productId: '1001' }], { shopKeys: ['shop-a'] });

    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({
      offerId: 'offer-1',
      productId: '1001',
      image: 'https://cdn.example/product-a.jpg',
    });
  });

  it('does not read product entities from a different shop with the same offer id', () => {
    const { store } = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-products:shop-a:all:20:1',
      {
        rows: [{ productId: '1001', offerId: 'offer-1', image: 'https://cdn.example/product-a.jpg' }],
      },
      { shopKey: 'shop-a', now: '2026-06-23T02:00:00.000Z' }
    );

    const entities = readOzonProductEntitiesFromLocalStore(store, [{ offerId: 'offer-1', shopClientId: 'shop-b' }], {
      shopKeys: ['shop-b'],
    });

    expect(entities).toEqual([]);
  });

  it('reads all-shop product rows without merging the same offer id across shops', () => {
    const firstShop = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-products:shop-a:all:20:1',
      {
        rows: [
          {
            productId: '1001',
            offerId: 'same-offer',
            shop: 'Shop A',
            status: '出售中',
            priceValue: 10,
            image: 'https://cdn.example/shop-a.jpg',
          },
        ],
      },
      { shopKey: 'shop-a', now: '2026-06-23T02:00:00.000Z' }
    );
    const secondShop = mergeOzonProductSnapshotIntoLocalStore(
      firstShop.store,
      'ozon-products:shop-b:all:20:1',
      {
        rows: [
          {
            productId: '2001',
            offerId: 'same-offer',
            shop: 'Shop B',
            status: '待销售',
            priceValue: 20,
            image: 'https://cdn.example/shop-b.jpg',
          },
        ],
      },
      { shopKey: 'shop-b', now: '2026-06-23T02:05:00.000Z' }
    );

    const rows = readOzonProductRowsFromLocalStore(secondShop.store, { shopKeys: ['shop-a', 'shop-b'] });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.localShopKey).sort()).toEqual(['shop-a', 'shop-b']);
    expect(rows.find((row) => row.localShopKey === 'shop-a')).toMatchObject({
      offerId: 'same-offer',
      productId: '1001',
      priceValue: 10,
      image: 'https://cdn.example/shop-a.jpg',
    });
    expect(rows.find((row) => row.localShopKey === 'shop-b')).toMatchObject({
      offerId: 'same-offer',
      productId: '2001',
      priceValue: 20,
      image: 'https://cdn.example/shop-b.jpg',
    });
  });

  it('searches reusable local product entities by partial offer id within the selected shop', () => {
    const { store } = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-sales-orders:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:posting-1',
            shopClientId: 'shop-a',
            products: [
              {
                offerId: 'mz-26050910-195318',
                productId: '4240695405',
                name: 'Brow stamp',
                image: 'https://cdn.example/brow.jpg',
              },
            ],
          },
          {
            recordKey: 'shop-b:posting-2',
            shopClientId: 'shop-b',
            products: [
              {
                offerId: 'mz-26050910-195318',
                productId: 'other-product',
                name: 'Other shop product',
              },
            ],
          },
        ],
      },
      { now: '2026-06-24T00:00:00.000Z' }
    );

    const matches = searchOzonProductEntitiesFromLocalStore(store, '26050910', { shopKeys: ['shop-a'] });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      offerId: 'mz-26050910-195318',
      productId: '4240695405',
      localShopKey: 'shop-a',
      image: 'https://cdn.example/brow.jpg',
    });
  });

  it('reads legacy product snapshot keys that used a secret-like segment without requiring the secret again', () => {
    const oldSecretLikeSegment = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const { store } = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      `ozon-platform-status-v5:shop-a:client-a:${oldSecretLikeSegment}:ALL:20:1`,
      {
        rows: [
          {
            shopClientId: 'client-a',
            offerId: 'offer-legacy',
            productId: 'product-legacy',
            name: 'Legacy product',
          },
        ],
      },
      { shopKey: 'client-a', now: '2026-06-24T00:00:00.000Z' }
    );

    const snapshot = readOzonProductSnapshotFromLocalStore(store, 'ozon-platform-status-v5:shop-a:client-a:ALL:20:1');

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].offerId).toBe('offer-legacy');
    expect(snapshot).toMatchObject({
      localSnapshotKey: `ozon-platform-status-v5:shop-a:client-a:${oldSecretLikeSegment}:ALL:20:1`,
      legacyCompatibleRead: true,
    });
  });
});
