import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmProductWrite,
  previewProductArchive,
  previewProductInfoSave,
  previewProductPriceUpdate,
  previewProductStockUpdate,
  previewProductUnarchive,
  readProductMaterialProfilesFromLocalApi,
  readProductSourceLinksFromLocalApi,
  readProductSummary,
  readProductSupport,
  saveProductImageHealthToLocalApi,
  saveProductMaterialProfileToLocalApi,
  saveProductSourceLinksToLocalApi,
  submitProductPriceWrite,
} from './productModuleClient';

describe('productModuleClient support storage adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
  });

  it('reads support data from local-api product support route', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, materialProfiles: [], sourceLinks: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await readProductSupport({ shopId: 'shop-1', productId: '101' });

    expect(fetchMock.mock.calls[0][0]).toContain('/api/products/support?shopId=shop-1&productId=101');
    expect(fetchMock.mock.calls[0][0]).not.toContain('/api/' + 'ozon/request');
  });

  it('reads every paged material profile and preserves the highest-ranked profile for one product', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      shopId: 'shop-1',
      offerId: `offer-${index}`,
      source: 'ozon-initial-read',
      sourceRank: 100,
      weightKg: 0.1,
      widthCm: 10,
      heightCm: 5,
      depthCm: 20,
      updatedAt: '2026-07-11T00:00:00.000Z',
    }));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, rows: firstPage, total: 1001, hasMore: true, nextCursor: 'material-cursor-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            rows: [
              {
                shopId: 'shop-1',
                offerId: 'offer-0',
                source: 'supplier-confirmed',
                sourceRank: 300,
                weightKg: 0.2,
                widthCm: 12,
                heightCm: 6,
                depthCm: 25,
                updatedAt: '2026-07-12T00:00:00.000Z',
              },
            ],
            total: 1001,
            hasMore: false,
            nextCursor: '',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const profiles = await readProductMaterialProfilesFromLocalApi();

    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/products/material');
    expect(fetchMock.mock.calls[0][0]).toContain('cursorMode=legacy-migration');
    expect(fetchMock.mock.calls[1][0]).toContain('cursor=material-cursor-1');
    expect(Object.keys(profiles)).toHaveLength(1000);
    expect(profiles['shop-1:offer-0']).toMatchObject({ source: 'supplier-confirmed', weight: '0.2', length: '25' });
  });

  it('reads every paged product source-link record with its explicit shop/product identity', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      shopId: 'shop-1',
      productKey: `offer-${index}`,
      slotIndex: 0,
      isPrimary: true,
      link: `https://detail.1688.com/offer/${index}.html`,
      sourceProductId: String(index),
      previewImageUrl: index === 0 ? 'https://img.test/preview-0.jpg' : '',
      originalImageUrl: index === 0 ? 'https://img.test/original-0.jpg' : '',
      updatedAt: '2026-07-12T00:00:00.000Z',
    }));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: true,
          rows: firstPage,
          total: 501,
          hasMore: true,
          nextCursor: 'product-source-cursor-1',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            rows: [
              {
                shopId: 'shop-1',
                productKey: 'offer-500',
                slotIndex: 0,
                isPrimary: true,
                link: 'https://detail.1688.com/offer/500.html',
                sourceProductId: '500',
                updatedAt: '2026-07-12T00:00:00.000Z',
              },
            ],
            total: 501,
            hasMore: false,
            nextCursor: '',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const records = await readProductSourceLinksFromLocalApi();

    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/products/source-links');
    expect(fetchMock.mock.calls[0][0]).toContain('cursorMode=legacy-migration');
    expect(fetchMock.mock.calls[1][0]).toContain('cursor=product-source-cursor-1');
    expect(Object.keys(records)).toHaveLength(501);
    expect(records['shop-1:offer-500']).toMatchObject({ primaryIndex: 0 });
    expect(records['shop-1:offer-0'].links[0]).toMatchObject({
      previewImageUrl: 'https://img.test/preview-0.jpg',
      originalImageUrl: 'https://img.test/original-0.jpg',
    });
  });

  it('indexes one product source record by its stable Ozon product, offer, and SKU identities', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        ok: true,
        rows: [{
          shopId: 'shop-1',
          productKey: 'product:4507629805',
          ozonProductId: '4507629805',
          offerId: 'mz-26050910-195318',
          sku: '4240695405',
          slotIndex: 0,
          isPrimary: true,
          link: 'https://detail.1688.com/offer/eyebrow.html',
          updatedAt: '2026-07-17T05:30:00.000Z',
        }],
        total: 1,
        hasMore: false,
        nextCursor: '',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const records = await readProductSourceLinksFromLocalApi();

    expect(records['shop-1:product:4507629805'].links[0].link).toContain('eyebrow.html');
    expect(records['shop-1:4507629805']).toBe(records['shop-1:product:4507629805']);
    expect(records['shop-1:mz-26050910-195318']).toBe(records['shop-1:product:4507629805']);
    expect(records['shop-1:4240695405']).toBe(records['shop-1:product:4507629805']);
  });

  it('keeps the newest source record when historical product keys share an Ozon identity', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        ok: true,
        rows: [
          {
            shopId: 'shop-1',
            productKey: 'product:9001',
            ozonProductId: '9001',
            offerId: 'offer-shared',
            sku: 'sku-shared',
            slotIndex: 0,
            link: 'https://old.example/source',
            updatedAt: '2026-07-16T00:00:00.000Z',
          },
          {
            shopId: 'shop-1',
            productKey: 'offer-shared',
            ozonProductId: '9001',
            offerId: 'offer-shared',
            sku: 'sku-shared',
            slotIndex: 0,
            link: 'https://new.example/source',
            updatedAt: '2026-07-17T00:00:00.000Z',
          },
        ],
        total: 2,
        hasMore: false,
        nextCursor: '',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const records = await readProductSourceLinksFromLocalApi();

    expect(records['shop-1:product:9001'].links[0].link).toBe('https://new.example/source');
    expect(records['shop-1:offer-shared'].links[0].link).toBe('https://new.example/source');
    expect(records['shop-1:sku-shared'].links[0].link).toBe('https://new.example/source');
  });

  it('reads reusable product summary from local-api read service instead of duplicating a big frontend cache', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, summaryKind: 'read_service', rows: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await readProductSummary({ shopId: 'shop-1', scope: 'software_all', page: 1, pageSize: 20 });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/products/summary');
    expect(url.searchParams.get('scope')).toBe('software_all');
    expect(url.searchParams.get('pageSize')).toBe('20');
    expect(fetchMock.mock.calls[0][0]).not.toContain('/api/' + 'ozon/request');
  });

  it('saves material profile to SQLite through local-api only', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, profile: { source: 'supplier-confirmed' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await saveProductMaterialProfileToLocalApi({ shopId: 'shop-1', offerId: 'offer-1', source: 'supplier-confirmed' });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/products/material');
    expect(url).not.toContain('api-seller.ozon.ru');
    expect(JSON.parse(options.body)).toMatchObject({ shopId: 'shop-1', offerId: 'offer-1' });
  });

  it('saves source links and image health without Ozon direct calls', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, links: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, imageHealth: { status: 'broken' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    await saveProductSourceLinksToLocalApi({
      shopId: 'shop-1',
      offerId: 'offer-1',
      record: { links: [{ link: 'https://pdd.example/1' }] },
    });
    await saveProductImageHealthToLocalApi({
      shopId: 'shop-1',
      offerId: 'offer-1',
      imageUrl: 'https://img.example/a.jpg',
      status: 'broken',
    });

    expect(fetchMock.mock.calls[0][0]).toContain('/api/products/source-links');
    expect(fetchMock.mock.calls[1][0]).toContain('/api/products/image-health');
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes('api-seller.ozon.ru'))).toBe(true);
  });

  it('previews product write actions through local-api write guard only', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, previewId: 'preview-1', requiresConfirmation: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    await previewProductInfoSave({
      shopId: 'shop-1',
      payload: { product_id: '101', name: 'new name' },
      idempotencyKey: 'info-1',
    });
    await previewProductPriceUpdate({
      shopId: 'shop-1',
      payload: { product_id: '101', price: '88' },
      idempotencyKey: 'price-1',
    });
    await previewProductStockUpdate({
      shopId: 'shop-1',
      payload: { product_id: '101', stock: 3 },
      idempotencyKey: 'stock-1',
    });
    await previewProductArchive({ shopId: 'shop-1', payload: { product_id: '101' }, idempotencyKey: 'archive-1' });
    await previewProductUnarchive({ shopId: 'shop-1', payload: { product_id: '101' }, idempotencyKey: 'unarchive-1' });

    const calls = fetchMock.mock.calls.map(([url, options]) => ({ url: String(url), body: JSON.parse(options.body) }));
    expect(calls.every((call) => call.url.includes('/api/write/products/preview'))).toBe(true);
    expect(calls.every((call) => !call.url.includes('api-seller.ozon.ru'))).toBe(true);
    expect(calls.map((call) => call.body.action)).toEqual([
      'product.updateInfo',
      'product.updatePrice',
      'product.updateStock',
      'product.archive',
      'product.unarchive',
    ]);
    expect(calls[0].body).toMatchObject({
      shopId: 'shop-1',
      endpointKey: 'products.import',
      idempotencyKey: 'info-1',
    });
  });

  it('confirms product write through local-api and keeps frontend away from Ozon direct calls', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: { code: 'WRITE_EXECUTION_NOT_CONNECTED' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await confirmProductWrite({
      shopId: 'shop-1',
      action: 'product.updateInfo',
      previewId: 'preview-1',
      confirm: true,
      realWrite: true,
      dryRun: false,
      payload: { product_id: '101' },
      idempotencyKey: 'confirm-1',
    });

    const [url, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(url).toContain('/api/write/products/confirm');
    expect(url).not.toContain('api-seller.ozon.ru');
    expect(body).toMatchObject({
      shopId: 'shop-1',
      action: 'product.updateInfo',
      previewId: 'preview-1',
      confirm: true,
      realWrite: true,
      dryRun: false,
      idempotencyKey: 'confirm-1',
    });
  });

  it('runs the typed price client as preview then confirmed submit with synchronous readback', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, previewId: 'preview-price-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        writeConnected: true,
        writeStatus: 'readback_merged',
        readBack: { status: 'merged', rows: 1 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const result = await submitProductPriceWrite({
      shopId: 'shop-1',
      payload: { prices: [{ product_id: 101, price: '88' }] },
      before: { product_id: 101, price: '80' },
      idempotencyKey: 'price-write-1',
    }, { humanConfirmed: true, realWrite: true, dryRun: false });

    expect(result.readBack.status).toBe('merged');
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/api/write/products/preview',
      '/api/write/products/confirm',
    ]);
    const confirmBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(confirmBody).toMatchObject({
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      previewId: 'preview-price-1',
      confirm: true,
      waitForResult: true,
      fastAck: false,
      asyncWrite: false,
    });
  });
});
