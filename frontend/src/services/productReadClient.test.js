import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDomainCache: vi.fn(),
  getSyncJob: vi.fn(),
  readLocalOzonWarehouseList: vi.fn(),
  requestLocalApi: vi.fn(),
  startDomainSync: vi.fn(),
}));

vi.mock('../api/localApiClient.js', () => mocks);

import {
  filterProductScopedAttributeDefinitions,
  preloadProductAttributeOptions,
  readProductAttributeOptions,
  readProductAttributeSchema,
  readProductEditorContext,
  readProductWarehouseOptions,
} from './productReadClient.js';

describe('productReadClient editor attribute scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps only definitions for the current product category and type', () => {
    const rows = filterProductScopedAttributeDefinitions([
      { attributeId: '1', categoryId: '10', typeId: '20', name: '当前字段' },
      { attributeId: '2', categoryId: '10', typeId: '99', name: '其他类型字段' },
      { attributeId: '3', categoryId: '88', typeId: '20', name: '其他类目字段' },
      { attributeId: '4', name: '没有类目范围的字段' },
    ], { categoryId: '10', typeId: '20' });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: '1', name: '当前字段' });
  });

  it('syncs missing definitions and returns filled plus unfilled fields for the current product only', async () => {
    let synced = false;
    mocks.getDomainCache.mockResolvedValue({
      rows: [{
        shopId: 'shop-1',
        productId: 'product-1',
        offerId: 'offer-1',
        descriptionCategoryId: '10',
        typeId: '20',
        attributes: [{ id: 1, values: [{ value: '已填写' }] }],
      }],
    });
    mocks.requestLocalApi.mockImplementation(async () => ({
      items: synced ? [
        { attributeId: '1', categoryId: '10', typeId: '20', name: '已填写字段' },
        { attributeId: '2', categoryId: '10', typeId: '20', name: '可填写空字段' },
        { attributeId: '3', categoryId: '99', typeId: '88', name: '其他商品字段' },
      ] : [],
    }));
    mocks.startDomainSync.mockImplementation(async () => {
      synced = true;
      return { job: { jobId: 'catalog-job-1', status: 'queued' } };
    });
    mocks.getSyncJob.mockResolvedValue({ job: { jobId: 'catalog-job-1', status: 'success' } });

    const context = await readProductEditorContext({
      shopId: 'shop-1',
      productId: 'product-1',
      descriptionCategoryId: '10',
      typeId: '20',
    });

    expect(mocks.startDomainSync).toHaveBeenCalledWith('catalog', {
      shopId: 'shop-1',
      categoryId: '10',
      typeId: '20',
      locale: 'DEFAULT',
      attributesOnly: true,
    }, expect.any(Object));
    expect(context.attributeDefinitions.map((item) => item.id)).toEqual(['1', '2']);
    expect(context.attributeDefinitionSource).toBe('ozon-scoped-sync');
    expect(context.attributeScope).toEqual({ shopId: 'shop-1', categoryId: '10', typeId: '20' });
  });

  it('refreshes an empty scoped schema and returns its source and warning state', async () => {
    let synced = false;
    mocks.requestLocalApi.mockImplementation(async () => ({
      items: synced ? [
        { attributeId: '100', categoryId: '10', typeId: '20', name: '材质', isRequired: true },
        { attributeId: '101', categoryId: '10', typeId: '20', name: '颜色', isDictionary: true, complexId: 7, isAspect: true, maxValueCount: 2 },
      ] : [],
    }));
    mocks.startDomainSync.mockImplementation(async () => {
      synced = true;
      return { job: { jobId: 'catalog-schema-job', status: 'queued' } };
    });
    mocks.getSyncJob.mockResolvedValue({ job: { jobId: 'catalog-schema-job', status: 'success' } });

    const schema = await readProductAttributeSchema({
      shopId: 'shop-1', categoryId: '10', typeId: '20',
    });

    expect(schema.definitions.map((item) => item.id)).toEqual(['100', '101']);
    expect(schema.definitions[1]).toMatchObject({ complexId: 7, isAspect: true, maxValueCount: 2 });
    expect(schema.source).toBe('ozon-scoped-sync');
    expect(schema.warning).toBe('');
    expect(mocks.startDomainSync).toHaveBeenCalledWith('catalog', expect.objectContaining({
      shopId: 'shop-1', categoryId: '10', typeId: '20', attributesOnly: true,
    }), expect.any(Object));
  });

  it('reads a cached schema with one DEFAULT catalog request and never starts a remote sync', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      items: [{ attributeId: '100', categoryId: '10', typeId: '20', name: 'Бренд' }],
    });

    const schema = await readProductAttributeSchema({
      shopId: 'shop-1', categoryId: '10', typeId: '20',
    });

    expect(schema.definitions).toHaveLength(1);
    expect(schema.source).toBe('sqlite-scoped-catalog');
    expect(mocks.requestLocalApi).toHaveBeenCalledTimes(1);
    expect(mocks.requestLocalApi.mock.calls[0][0]).toContain('locale=DEFAULT');
    expect(mocks.startDomainSync).not.toHaveBeenCalled();
  });

  it('keeps the sync failure visible instead of claiming that the category has no fields', async () => {
    mocks.requestLocalApi.mockResolvedValue({ items: [] });
    mocks.startDomainSync.mockResolvedValue({ job: { jobId: 'catalog-schema-failed', status: 'queued' } });
    mocks.getSyncJob.mockResolvedValue({
      job: { jobId: 'catalog-schema-failed', status: 'failed', error: { message: 'Ozon API 暂时不可用' } },
    });

    const schema = await readProductAttributeSchema({
      shopId: 'shop-1', categoryId: '10', typeId: '20',
    });

    expect(schema.definitions).toEqual([]);
    expect(schema.source).toBe('empty');
    expect(schema.warning).toContain('Ozon API 暂时不可用');
  });

  it('reads dictionary options through the shared catalog route and keeps the current scope', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      items: [
        { attributeId: '8229', categoryId: '10', typeId: '20', valueId: '1', valueText: '毛绒玩具' },
        { attributeId: '8229', categoryId: '99', typeId: '88', valueId: '2', valueText: '其他类目值' },
        { attributeId: '7173', categoryId: '10', typeId: '20', valueId: '3', valueText: '毛绒公仔' },
      ],
    });

    const options = await readProductAttributeOptions({
      shopId: 'shop-1',
      categoryId: '10',
      typeId: '20',
      attributeId: '8229',
    }, { refresh: false });

    expect(options).toEqual([{ id: '1', value: '毛绒玩具', label: '毛绒玩具', info: '' }]);
    expect(mocks.requestLocalApi).toHaveBeenCalledWith(
      expect.stringContaining('/api/catalog/shared/values'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses the complete-list limit for an empty dictionary query', async () => {
    mocks.requestLocalApi.mockResolvedValue({ items: [] });
    mocks.startDomainSync.mockResolvedValue({ job: { jobId: 'catalog-values-job-1', status: 'queued' } });
    mocks.getSyncJob.mockResolvedValue({ job: { jobId: 'catalog-values-job-1', status: 'success' } });

    await readProductAttributeOptions({
      shopId: 'shop-1',
      categoryId: '10',
      typeId: '20',
      attributeId: '8198',
    }, { limit: 1000 });

    expect(mocks.startDomainSync).toHaveBeenCalledWith('catalog', expect.objectContaining({
      attributeId: '8198',
      attributeValuesOnly: true,
      limit: 200,
    }), expect.any(Object));
  });

  it('uses typed text to search Ozon dictionary values even when local options exist', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      items: [{ attributeId: '4389', categoryId: '10', typeId: '20', valueId: '1', valueText: 'Китай' }],
    });
    mocks.startDomainSync.mockResolvedValue({ job: { jobId: 'catalog-search-job-1', status: 'queued' } });
    mocks.getSyncJob.mockResolvedValue({ job: { jobId: 'catalog-search-job-1', status: 'success' } });

    await readProductAttributeOptions({
      shopId: 'shop-1',
      categoryId: '10',
      typeId: '20',
      attributeId: '4389',
      search: '巴西',
    });

    expect(mocks.startDomainSync).toHaveBeenCalledWith('catalog', expect.objectContaining({
      attributeId: '4389',
      query: '巴西',
      attributeValuesOnly: true,
      limit: 200,
    }), expect.any(Object));
  });

  it('preloads every dictionary field without waiting for a manual dropdown click', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      items: [{ attributeId: '8229', categoryId: '10', typeId: '20', valueId: '1', valueText: '毛绒玩具' }],
    });

    await expect(preloadProductAttributeOptions({ shopId: 'shop-1', categoryId: '10', typeId: '20' }, [
      { id: '8229', isDictionary: true },
      { id: '4180', isDictionary: false },
    ], { refresh: false })).resolves.toEqual({
      8229: [{ id: '1', value: '毛绒玩具', label: '毛绒玩具', info: '' }],
    });
  });

  it('reads and normalizes the exact shop warehouse list from the local Ozon adapter', async () => {
    mocks.readLocalOzonWarehouseList.mockResolvedValue({
      warehouses: [
        { warehouse_id: 101, name: '莫斯科仓', is_default: true },
        { warehouse_id: 102, name: '归档仓', is_archived: true },
      ],
    });

    await expect(readProductWarehouseOptions('shop-1')).resolves.toEqual([
      expect.objectContaining({ rawId: '101', name: '莫斯科仓', status: '可选择' }),
    ]);
    expect(mocks.readLocalOzonWarehouseList).toHaveBeenCalledWith('shop-1', {});
  });

  it('forces an Ozon warehouse sync only when the caller explicitly refreshes', async () => {
    mocks.readLocalOzonWarehouseList.mockResolvedValue({ result: [{ warehouse_id: 201, name: '新仓库' }] });

    await readProductWarehouseOptions('shop-2', { refresh: true });

    expect(mocks.readLocalOzonWarehouseList).toHaveBeenCalledWith('shop-2', { refresh: true });
  });
});
