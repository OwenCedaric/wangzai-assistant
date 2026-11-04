import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const localData = vi.hoisted(() => ({
  getOzonLocalUniqueValues: vi.fn((values) => values),
}));

const retiredMarketingFile = vi.hoisted(() => ({
  clearRetiredMarketingActivityCacheFile: vi.fn(),
  readRetiredMarketingActivityCacheFile: vi.fn(),
}));

const marketingClient = vi.hoisted(() => ({
  importLegacyMarketingActivitySnapshot: vi.fn(),
  readMarketingActivitySnapshotCache: vi.fn(),
  saveMarketingActivityViewState: vi.fn(),
}));

vi.mock('../product/productLocalData.jsx', () => localData);
vi.mock('../../services/localDataFileClient', async (importOriginal) => ({
  ...(await importOriginal()),
  ...retiredMarketingFile,
}));
vi.mock('../../services/marketingActivityClient', () => marketingClient);

import {
  flushMarketingActivityViewStateWritesForTest,
  findMarketingActivityByIdentity,
  getMarketingActivitySnapshotDigest,
  getMarketingActivitySnapshotSemanticDto,
  getMarketingProductPoolCacheKey,
  getMarketingProductPoolSnapshotResult,
  migrateLegacyMarketingActivityCacheStore,
  normalizeMarketingCacheSnapshot,
  resolveMarketingActivitySelection,
  saveMarketingActivityCache,
} from './orderShopScope.jsx';
import { resolveMarketingSelectedActivity } from '../../features/marketing/model/useMarketingActivityListState.jsx';
import { resolveMarketingReadActivity } from '../../features/marketing/model/useMarketingProductPoolState.jsx';

function createLegacySnapshot(overrides = {}) {
  return {
    activityRows: [{ id: 'activity-1' }],
    productPool: [{ id: 'product-1' }],
    selectedActivityId: 'activity-1',
    selectedSourceType: 'official',
    productScope: 'joined',
    selectedProductIds: ['product-1'],
    cachedAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  };
}

function createRetiredFile(data = {}, revision = 'a'.repeat(64), exists = Object.keys(data).length > 0) {
  return { data, revision, exists };
}

function canonicalSnapshotFor(snapshot) {
  const semantic = getMarketingActivitySnapshotSemanticDto(snapshot);
  if (!semantic) throw new Error('fixture must be a valid legacy snapshot');
  return {
    ...semantic,
    activityRows: semantic.activityRows.map((row) => ({ ...row, activityId: row.id })),
    productPool: semantic.productPool.map((row) => ({ ...row, productId: row.id })),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  localData.getOzonLocalUniqueValues.mockImplementation((values) => values);
  retiredMarketingFile.readRetiredMarketingActivityCacheFile.mockResolvedValue(createRetiredFile());
  retiredMarketingFile.clearRetiredMarketingActivityCacheFile.mockResolvedValue(true);
  marketingClient.importLegacyMarketingActivitySnapshot.mockResolvedValue({ ok: true });
  marketingClient.saveMarketingActivityViewState.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('marketing cache SQLite legacy migration', () => {
  it('projects sparse legacy facts to the exact public SQLite DTO, including defaults and derived values', () => {
    const semantic = getMarketingActivitySnapshotSemanticDto(
      createLegacySnapshot({
        activityRows: [{ id: 'activity-1', dateEnd: ' 2000-01-01T00:00:00.000Z ' }],
        productPool: [{ id: 'product-1', offerId: 'offer-1' }],
      })
    );

    expect(semantic).toMatchObject({
      activityRows: [
        {
          id: 'activity-1',
          title: '活动 activity-1',
          originalTitle: '活动 activity-1',
          source: '平台活动',
          sourceType: 'official',
          dateEnd: '2000-01-01T00:00:00.000Z',
          isOnline: false,
        },
      ],
      productPool: [
        {
          id: 'product-1',
          name: 'product-1',
          offerId: 'offer-1',
          sku: 'offer-1',
          status: '已添加',
          statusTone: 'success',
          review: '已确认',
          reviewTone: 'success',
        },
      ],
      selectedActivityId: 'activity-1',
      selectedSourceType: 'official',
      productScope: 'joined',
    });
  });

  it('treats duplicate selected product ids as invalid before any import attempt', async () => {
    const invalid = createLegacySnapshot({ selectedProductIds: ['product-1', 'product-1'] });
    expect(getMarketingActivitySnapshotSemanticDto(invalid)).toBeNull();
    retiredMarketingFile.readRetiredMarketingActivityCacheFile.mockResolvedValue(
      createRetiredFile({ 'shop-1': invalid }, 'a'.repeat(64), true)
    );

    const result = await migrateLegacyMarketingActivityCacheStore({ shops: [{ id: 'shop-1' }] });

    expect(result).toMatchObject({ ok: false, reason: 'legacy-source-unreadable-or-invalid' });
    expect(marketingClient.importLegacyMarketingActivitySnapshot).not.toHaveBeenCalled();
  });

  it('keeps official and seller activities with the same id as separate identities through selection and cache keys', () => {
    const official = { id: 'same-id', sourceType: 'official', title: '平台活动' };
    const seller = { id: 'same-id', sourceType: 'seller', title: '商家活动' };
    const rows = [official, seller];
    const sellerSnapshot = {
      activityRows: rows,
      productPool: [{ id: 'seller-product', status: '已添加' }],
      selectedActivityId: 'same-id',
      selectedSourceType: 'seller',
      productScope: 'joined',
    };

    expect(findMarketingActivityByIdentity(rows, { id: 'same-id', sourceType: 'seller' })).toBe(seller);
    expect(resolveMarketingActivitySelection(rows, sellerSnapshot)).toBe(seller);
    expect(resolveMarketingSelectedActivity(rows, 'same-id', 'seller')).toBe(seller);
    expect(resolveMarketingReadActivity(rows, sellerSnapshot)).toBe(seller);
    expect(resolveMarketingActivitySelection(rows, {})).toBeNull();
    expect(getMarketingProductPoolCacheKey({ id: 'shop-1' }, official, 'joined')).not.toBe(
      getMarketingProductPoolCacheKey({ id: 'shop-1' }, seller, 'joined')
    );
    expect(getMarketingProductPoolSnapshotResult(sellerSnapshot, seller, 'joined')?.products).toEqual([
      expect.objectContaining({ id: 'seller-product' }),
    ]);
    expect(getMarketingProductPoolSnapshotResult(sellerSnapshot, official, 'joined')).toBeNull();
  });

  it('does not silently choose the first activity from a multi-row SQLite snapshot without a complete identity pair', () => {
    const normalized = normalizeMarketingCacheSnapshot({
      activityRows: [
        { id: 'same-id', sourceType: 'official' },
        { id: 'same-id', sourceType: 'seller' },
      ],
      productPool: [{ id: 'should-not-attach' }],
      selectedActivityId: 'same-id',
      productScope: 'joined',
    });

    expect(normalized).toMatchObject({
      selectedActivityId: '',
      selectedSourceType: '',
      productPool: [],
    });
  });

  it('imports the retired file only after canonical-first miss and clears it after independent readback', async () => {
    const legacy = createLegacySnapshot({ productPool: [{ id: 'product-1', offerId: 'offer-1' }] });
    const fileRevision = 'f'.repeat(64);
    retiredMarketingFile.readRetiredMarketingActivityCacheFile.mockResolvedValue(
      createRetiredFile({ 'shop-1': legacy }, fileRevision, true)
    );
    marketingClient.readMarketingActivitySnapshotCache
      .mockResolvedValueOnce({ ok: true, found: false, snapshot: null })
      .mockResolvedValueOnce({ ok: true, found: true, snapshot: canonicalSnapshotFor(legacy) });

    const result = await migrateLegacyMarketingActivityCacheStore({ shops: [{ id: 'shop-1', clientId: 'client-1' }] });

    expect(marketingClient.importLegacyMarketingActivitySnapshot).toHaveBeenCalledWith(
      {
        entries: [
          {
            legacyScope: 'marketing-activity-cache',
            shopId: 'shop-1',
            snapshot: legacy,
          },
        ],
      },
      { timeoutMs: 12_000 }
    );
    expect(marketingClient.readMarketingActivitySnapshotCache).toHaveBeenCalledTimes(2);
    expect(retiredMarketingFile.clearRetiredMarketingActivityCacheFile).toHaveBeenCalledWith(
      'marketing-activity-cache',
      fileRevision
    );
    expect(result).toMatchObject({ ok: true, migratedShopIds: ['shop-1'], browserCleared: false, fileCleared: true });
  });

  it('uses the fixed file migration route revision only after SQLite readback succeeds', async () => {
    const legacy = createLegacySnapshot();
    const fileRevision = 'b'.repeat(64);
    retiredMarketingFile.readRetiredMarketingActivityCacheFile.mockResolvedValue(
      createRetiredFile({ 'shop-1': legacy }, fileRevision, true)
    );
    marketingClient.readMarketingActivitySnapshotCache.mockResolvedValue({
      ok: true,
      found: true,
      snapshot: canonicalSnapshotFor(legacy),
    });

    const result = await migrateLegacyMarketingActivityCacheStore({ shops: [{ id: 'shop-1' }] });

    expect(marketingClient.importLegacyMarketingActivitySnapshot).not.toHaveBeenCalled();
    expect(retiredMarketingFile.clearRetiredMarketingActivityCacheFile).toHaveBeenCalledWith(
      'marketing-activity-cache',
      fileRevision
    );
    expect(result).toMatchObject({ ok: true, migratedShopIds: ['shop-1'], fileCleared: true });
  });

  it('keeps the whole file source when conditional removal observes a newer A→B revision', async () => {
    const legacy = createLegacySnapshot();
    retiredMarketingFile.readRetiredMarketingActivityCacheFile.mockResolvedValue(
      createRetiredFile({ 'shop-1': legacy }, 'c'.repeat(64), true)
    );
    const conflict = new Error('changed');
    conflict.code = 'LEGACY_SOURCE_CHANGED';
    retiredMarketingFile.clearRetiredMarketingActivityCacheFile.mockRejectedValue(conflict);
    marketingClient.readMarketingActivitySnapshotCache.mockResolvedValue({
      ok: true,
      found: true,
      snapshot: canonicalSnapshotFor(legacy),
    });

    const result = await migrateLegacyMarketingActivityCacheStore({ shops: [{ id: 'shop-1' }] });

    expect(result).toMatchObject({ ok: false, fileCleared: false, cleanupConflicts: ['file'] });
  });

  it('retries a retained file source on the next startup when SQLite already contains the verified snapshot', async () => {
    const legacy = createLegacySnapshot();
    const revision = 'e'.repeat(64);
    retiredMarketingFile.readRetiredMarketingActivityCacheFile.mockResolvedValue(
      createRetiredFile({ 'shop-1': legacy }, revision, true)
    );
    marketingClient.readMarketingActivitySnapshotCache.mockResolvedValue({
      ok: true,
      found: true,
      snapshot: canonicalSnapshotFor(legacy),
    });
    const conflict = new Error('changed');
    conflict.code = 'LEGACY_SOURCE_CHANGED';
    retiredMarketingFile.clearRetiredMarketingActivityCacheFile.mockRejectedValueOnce(conflict).mockResolvedValueOnce(true);

    const first = await migrateLegacyMarketingActivityCacheStore({ shops: [{ id: 'shop-1' }] });
    const second = await migrateLegacyMarketingActivityCacheStore({ shops: [{ id: 'shop-1' }] });

    expect(first).toMatchObject({ ok: false, cleanupConflicts: ['file'] });
    expect(second).toMatchObject({ ok: true, migratedShopIds: ['shop-1'], fileCleared: true });
    expect(marketingClient.importLegacyMarketingActivitySnapshot).not.toHaveBeenCalled();
    expect(retiredMarketingFile.clearRetiredMarketingActivityCacheFile).toHaveBeenCalledTimes(2);
  });

  it('does not partially rewrite a source with an unresolved shop; it preserves all entries', async () => {
    const shopOne = createLegacySnapshot();
    const unresolved = createLegacySnapshot({ activityRows: [{ id: 'activity-1', title: 'unmapped' }] });
    retiredMarketingFile.readRetiredMarketingActivityCacheFile.mockResolvedValue(
      createRetiredFile({ 'shop-1': shopOne, 'unmapped-shop': unresolved }, 'd'.repeat(64), true)
    );
    marketingClient.readMarketingActivitySnapshotCache.mockResolvedValue({
      ok: true,
      found: true,
      snapshot: canonicalSnapshotFor(shopOne),
    });

    const result = await migrateLegacyMarketingActivityCacheStore({ shops: [{ id: 'shop-1' }] });

    expect(result).toMatchObject({ ok: false, migratedShopIds: ['shop-1'], fileUnresolvedKeys: ['unmapped-shop'] });
    expect(retiredMarketingFile.clearRetiredMarketingActivityCacheFile).not.toHaveBeenCalled();
  });

  it('retains every source when a file read fails or a legacy source type is unknown', async () => {
    retiredMarketingFile.readRetiredMarketingActivityCacheFile.mockRejectedValue(new Error('legacy-json-read-failed'));

    await expect(migrateLegacyMarketingActivityCacheStore({ shops: [{ id: 'shop-1' }] })).resolves.toMatchObject({
      ok: false,
      reason: 'legacy-source-unreadable-or-invalid',
    });
    expect(marketingClient.readMarketingActivitySnapshotCache).not.toHaveBeenCalled();

    retiredMarketingFile.readRetiredMarketingActivityCacheFile.mockResolvedValue(
      createRetiredFile({
        'shop-1': createLegacySnapshot({ activityRows: [{ id: 'activity-1', sourceType: 'made-up-source' }] }),
      }, '1'.repeat(64), true)
    );
    const result = await migrateLegacyMarketingActivityCacheStore({ shops: [{ id: 'shop-1' }] });

    expect(result).toMatchObject({ ok: false, reason: 'legacy-source-unreadable-or-invalid' });
    expect(marketingClient.importLegacyMarketingActivitySnapshot).not.toHaveBeenCalled();
  });

  it('queues only complete marketing view state through SQLite and never legacy JSON', async () => {
    saveMarketingActivityCache(
      { id: 'view-state-shop' },
      createLegacySnapshot({
        activityRows: [{ id: 'activity-1', sourceType: 'seller' }],
        selectedSourceType: 'seller',
      })
    );
    await flushMarketingActivityViewStateWritesForTest();

    expect(marketingClient.saveMarketingActivityViewState).toHaveBeenCalledWith({
      shopId: 'view-state-shop',
      viewState: expect.objectContaining({
        selectedActivityId: 'activity-1',
        selectedSourceType: 'seller',
        productScope: 'joined',
      }),
    });
    expect(retiredMarketingFile.clearRetiredMarketingActivityCacheFile).not.toHaveBeenCalled();
  });

  it('strips read-model-only summary metadata before saving the SQLite view state', async () => {
    saveMarketingActivityCache(
      { id: 'view-state-shop' },
      createLegacySnapshot({
        marketingSummary: {
          activityTotal: 3,
          joinedActivityTotal: 1,
          joinedProductTotal: 1387,
          issueProductTotal: 0,
          cachedProductRows: 1934,
          cachedActivityProductTotal: 1934,
          updatedAt: '2026-08-05T00:00:00.000Z',
          source: 'sqlite',
          poolsByActivity: new Map(),
        },
      })
    );
    await flushMarketingActivityViewStateWritesForTest();

    expect(marketingClient.saveMarketingActivityViewState).toHaveBeenLastCalledWith({
      shopId: 'view-state-shop',
      viewState: {
        selectedActivityId: 'activity-1',
        selectedSourceType: 'official',
        productScope: 'joined',
        selectedProductIds: ['product-1'],
        marketingSummary: {
          activityTotal: 3,
          joinedActivityTotal: 1,
          joinedProductTotal: 1387,
          issueProductTotal: 0,
        },
        cachedAt: '2026-07-13T00:00:00.000Z',
      },
    });
  });
});
