import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getCatalogCategoryTreeCache,
  getSharedCatalogCategoryTree,
  getSharedCatalogs,
  resolveSharedCatalogCategoryPath,
} from '../api/localApiClient';

describe('localApiClient catalog cache wrappers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
  });

  it('reads the typed profile-shared category tree from local-api SQLite', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        ok: true,
        source: 'sqlite-shared-catalog',
        catalog: {
          catalogId: 'catalog-1',
          platform: 'ozon',
          marketplace: 'ozon',
          locale: 'ZH_HANS',
          contractVersion: 'ozon-description-category-v1',
        },
        categoryCount: 0,
        typeCount: 0,
        nodes: [],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const result = await getCatalogCategoryTreeCache({
      locale: 'ZH_HANS',
      limit: 10,
    });

    expect(result).toMatchObject({
      ok: true,
      source: 'sqlite-shared-catalog',
      count: 0,
      categoryCount: 0,
      typeCount: 0,
      nodes: [],
      catalog: { catalogId: 'catalog-1', locale: 'ZH_HANS' },
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('http://127.0.0.1:3790/api/catalog/shared/tree?');
    expect(url).toContain('platform=ozon');
    expect(url).toContain('marketplace=ozon');
    expect(url).toContain('locale=ZH_HANS');
    expect(url).toContain('limit=10');
    expect(url).not.toContain('shopId=');
    expect(url).not.toContain('/ozon-api');
    expect(url).not.toContain('ozonCategoryTree.zh.json');
    expect(options.method).toBe('GET');
  });

  it('keeps the legacy tree wrapper on the same shared SQLite DTO', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, nodes: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await getCatalogCategoryTreeCache({ shopId: 'must-not-be-forwarded' });

    expect(fetchMock.mock.calls[0][0]).toContain('/api/catalog/shared/tree?');
    expect(fetchMock.mock.calls[0][0]).not.toContain('shopId=');
    expect(typeof getSharedCatalogCategoryTree).toBe('function');
  });

  it('normalizes catalog version and category-path DTOs', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        catalogs: [{
          catalogId: 'catalog-1',
          platform: 'ozon',
          marketplace: 'ozon',
          locale: 'ZH_HANS',
          contractVersion: 'v1',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        catalog: { catalogId: 'catalog-1', locale: 'ZH_HANS' },
        path: ['根类目', '商品类型'],
        pathText: '根类目 > 商品类型',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const versions = await getSharedCatalogs({ locale: 'ZH_HANS' });
    const resolved = await resolveSharedCatalogCategoryPath(
      { typeId: '30' },
      { locale: 'ZH_HANS' }
    );

    expect(versions).toMatchObject({
      ok: true,
      source: 'sqlite-shared-catalog',
      count: 1,
      catalogs: [{ catalogId: 'catalog-1', locale: 'ZH_HANS' }],
    });
    expect(resolved).toEqual({
      ok: true,
      source: 'sqlite-shared-catalog',
      catalog: expect.objectContaining({ catalogId: 'catalog-1', locale: 'ZH_HANS' }),
      path: ['根类目', '商品类型'],
      pathText: '根类目 > 商品类型',
    });
    expect(fetchMock.mock.calls[0][0]).toContain('/api/catalog/shared/catalogs?');
    expect(fetchMock.mock.calls[1][0]).toContain('/api/catalog/shared/path?');
    expect(fetchMock.mock.calls[1][0]).toContain('typeId=30');
  });
});
