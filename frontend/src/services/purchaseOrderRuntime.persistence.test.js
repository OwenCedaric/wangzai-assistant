import { beforeEach, describe, expect, it, vi } from 'vitest';

const localDataFileClient = vi.hoisted(() => ({
  readLocalDataFile: vi.fn(),
  writeLocalDataFile: vi.fn(),
}));

const purchaseOverrideClient = vi.hoisted(() => ({
  readPurchaseOverrides: vi.fn(),
  removePurchaseOverride: vi.fn(),
  savePurchaseOverride: vi.fn(),
  importLegacyPurchaseOverrides: vi.fn(),
  toPurchaseOverridePayload: vi.fn((order = {}, patch = {}) => ({
    ...patch,
    shopId: patch.shopId || order.shopId || '',
    orderKey: patch.orderKey || order.orderKey || '',
    updatedAt: patch.updatedAt || order.updatedAt || '',
  })),
}));

vi.mock('../entities/product/productLocalData.jsx', () => ({
  readLocalDataFile: localDataFileClient.readLocalDataFile,
  writeLocalDataFile: localDataFileClient.writeLocalDataFile,
}));

vi.mock('./purchaseOrderOverrideClient', () => purchaseOverrideClient);

import {
  applyPurchaseManualFallbacks,
  findPurchaseOrderLocalOverride,
  hydratePurchaseOrderLocalOverridesFromLocalFile,
  mapPurchaseOverrideRows,
  migrateLegacyPurchaseOrderOverridesAtStartup,
  purchaseOrderOverrideLocalApiHashes,
  readPurchaseOrderOverridesFromLocalApi,
  sanitizePurchaseOrderLocalOverrideForMerge,
  savePurchaseOrderLocalOverrides,
  writePurchaseOrderLocalOverrideUpsert,
} from './purchaseOrderRuntime';

function page(rows, total = rows.length, hasMore = false, nextCursor = '') {
  return { ok: true, rows, total, hasMore, nextCursor };
}

function override(orderKey, fields = {}) {
  return {
    shopId: 'shop-1',
    orderKey,
    manualBuyerPlatform: 'PDD',
    updatedAt: '2026-07-12T00:00:00.000Z',
    ...fields,
  };
}

describe('purchase order override SQLite primary persistence', () => {
  beforeEach(() => {
    purchaseOrderOverrideLocalApiHashes.clear();
    Object.values(localDataFileClient).forEach((mock) => mock.mockReset());
    Object.values(purchaseOverrideClient).forEach((mock) => mock.mockReset());
    localDataFileClient.writeLocalDataFile.mockResolvedValue({});
    purchaseOverrideClient.savePurchaseOverride.mockResolvedValue({ ok: true });
    purchaseOverrideClient.removePurchaseOverride.mockResolvedValue({ ok: true, deleted: 1 });
    purchaseOverrideClient.importLegacyPurchaseOverrides.mockResolvedValue({ ok: true, importedCount: 2 });
    purchaseOverrideClient.toPurchaseOverridePayload.mockImplementation((order = {}, patch = {}) => ({
      ...patch,
      shopId: patch.shopId || order.shopId || '',
      orderKey: patch.orderKey || order.orderKey || '',
      updatedAt: patch.updatedAt || order.updatedAt || '',
    }));
  });

  it('writes normal changes to SQLite without recreating the legacy JSON duplicate', async () => {
    const result = await savePurchaseOrderLocalOverrides({ 'posting-1': override('posting-1') });
    expect(result).toMatchObject({ savedKeys: ['posting-1'], failedKeys: [] });
    expect(purchaseOverrideClient.savePurchaseOverride).toHaveBeenCalledTimes(1);
    expect(localDataFileClient.writeLocalDataFile).not.toHaveBeenCalled();
  });
  it('returns failed canonical keys and does not silently recreate a JSON authority on save failure', async () => {
    purchaseOverrideClient.savePurchaseOverride.mockResolvedValue({ ok: false });
    const result = await savePurchaseOrderLocalOverrides({ 'posting-1': override('posting-1') });
    expect(result.failedKeys).toEqual(['posting-1']);
    expect(result.savedKeys).toEqual([]);
    expect(localDataFileClient.writeLocalDataFile).not.toHaveBeenCalled();
  });

  it('keeps the original posting identity when collision-safe memory keys separate two shops', async () => {
    const mapped = mapPurchaseOverrideRows([
      override('same-posting', { shopId: 'shop-1' }),
      override('same-posting', { shopId: 'shop-2' }),
    ]);

    const result = await savePurchaseOrderLocalOverrides(mapped);

    expect(result.savedKeys.sort()).toEqual(['shop-1:same-posting', 'shop-2:same-posting']);
    expect(purchaseOverrideClient.savePurchaseOverride).toHaveBeenCalledTimes(2);
    expect(
      purchaseOverrideClient.savePurchaseOverride.mock.calls
        .map(([, patch]) => ({ shopId: patch.shopId, orderKey: patch.orderKey }))
        .sort((left, right) => left.shopId.localeCompare(right.shopId))
    ).toEqual([
      { shopId: 'shop-1', orderKey: 'same-posting' },
      { shopId: 'shop-2', orderKey: 'same-posting' },
    ]);
  });

  it('creates a canonical owner-scoped override and resolves it after a simulated SQLite readback', async () => {
    const shop = { id: 'shop-1', clientId: 'client-1' };
    const order = {
      id: 'posting-1',
      posting: 'posting-1',
      recordKey: 'client-1:posting-1',
      shopId: 'shop-1',
      shopClientId: 'client-1',
    };

    const result = writePurchaseOrderLocalOverrideUpsert({}, order, shop, {
      manualBuyerPlatform: 'PDD',
      manualPurchaseOrderNo: 'purchase-1',
    });

    expect(result).toMatchObject({
      canonicalKey: 'client-1:posting-1',
      shopId: 'shop-1',
      override: {
        shopId: 'shop-1',
        orderKey: 'client-1:posting-1',
        postingNumber: 'client-1:posting-1',
      },
    });
    await expect(result.persistence).resolves.toMatchObject({ failedKeys: [] });
    expect(purchaseOverrideClient.savePurchaseOverride).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'shop-1', orderKey: 'client-1:posting-1' }),
      expect.objectContaining({ shopId: 'shop-1', orderKey: 'client-1:posting-1' })
    );
    expect(purchaseOverrideClient.removePurchaseOverride).not.toHaveBeenCalled();

    const readback = mapPurchaseOverrideRows([result.override]);
    expect(findPurchaseOrderLocalOverride(readback, order, shop)).toMatchObject({
      manualBuyerPlatform: 'PDD',
      manualPurchaseOrderNo: 'purchase-1',
    });
  });

  it('hydrates the real scoped order identity and restores purchase plus bus fields', async () => {
    const row = {
      shopId: 'ozon-shop-example-01',
      orderKey: '4616153:0123640791-0163-1',
      postingNumber: '4616153:0123640791-0163-1',
      purchasePlatform: 'PDD',
      purchaseOrderNumber: '260624-284667440772967',
      sourceCostCny: 2.9,
      manualStatus: '已付款，待发货',
      readStatus: '已读取材积',
      packageWeight: '0.07 kg',
      packageSize: '11.8 cm x 9.5 cm x 3.1 cm',
      volumeItems: [{ length: 11.8, width: 9.5, height: 3.1, grossWeight: 0.07 }],
    };
    const shop = { id: row.shopId, clientId: '4616153' };
    const order = {
      id: '0123640791-0163-1',
      recordKey: '4616153:0123640791-0163-1',
      shopId: row.shopId,
      shopClientId: '4616153',
      buyerPlatform: '待拍单',
      purchaseOrderNo: '',
      purchasePrice: '待确认',
    };
    localDataFileClient.readLocalDataFile.mockResolvedValue({});
    purchaseOverrideClient.readPurchaseOverrides.mockResolvedValue(page([row]));

    const hydrated = await hydratePurchaseOrderLocalOverridesFromLocalFile();
    const restored = findPurchaseOrderLocalOverride(hydrated, order, shop);
    const merged = applyPurchaseManualFallbacks({
      ...order,
      ...sanitizePurchaseOrderLocalOverrideForMerge(restored),
    });

    expect(merged).toMatchObject({
      buyerPlatform: 'PDD',
      purchaseOrderNo: '260624-284667440772967',
      purchasePriceValue: 2.9,
      manualPurchaseOrderStatus: '已付款，待发货',
      readStatus: '已读取材积',
      packageWeight: '0.07 kg',
      packageSize: '11.8 cm x 9.5 cm x 3.1 cm',
    });
    expect(merged.volumeItems).toHaveLength(1);
  });

  it('merges a full legacy alias before canonical save and deletes only that exact owner alias afterwards', async () => {
    const shop = { id: 'shop-1', clientId: 'client-1' };
    const order = {
      id: 'posting-1',
      posting: 'posting-1',
      recordKey: 'client-1:posting-1',
      shopId: 'shop-1',
      shopClientId: 'client-1',
    };
    const legacyFull = override('posting-1', {
      manualPurchaseOrderNo: 'purchase-legacy',
      packageOrderId: 'bus-1',
      packageWeight: '0.156 kg',
      volumeItems: [{ length: 16.1, width: 11.5, height: 4.1 }],
    });

    const result = writePurchaseOrderLocalOverrideUpsert(
      { 'posting-1': legacyFull },
      order,
      shop,
      { manualBuyerPlatform: '天猫' }
    );

    expect(result.overrides).not.toHaveProperty('posting-1');
    expect(result.overrides['client-1:posting-1']).toMatchObject({
      shopId: 'shop-1',
      orderKey: 'client-1:posting-1',
      manualBuyerPlatform: '天猫',
      manualPurchaseOrderNo: 'purchase-legacy',
      packageOrderId: 'bus-1',
      packageWeight: '0.156 kg',
      volumeItems: [{ length: 16.1, width: 11.5, height: 4.1 }],
    });
    await expect(result.persistence).resolves.toMatchObject({
      failedKeys: [],
      deletedAliasKeys: ['posting-1'],
    });
    expect(purchaseOverrideClient.removePurchaseOverride).toHaveBeenCalledWith({
      shopId: 'shop-1',
      orderKey: 'posting-1',
    });
    expect(
      purchaseOverrideClient.savePurchaseOverride.mock.invocationCallOrder[0]
    ).toBeLessThan(purchaseOverrideClient.removePurchaseOverride.mock.invocationCallOrder[0]);
  });

  it('persists a clear tombstone, deletes the exact legacy alias, then removes the tombstone', async () => {
    const shop = { id: 'shop-1', clientId: 'client-1' };
    const order = {
      id: 'posting-1',
      posting: 'posting-1',
      recordKey: 'client-1:posting-1',
      shopId: 'shop-1',
      shopClientId: 'client-1',
    };
    const legacyFull = override('posting-1', {
      manualBuyerPlatform: '1688',
      manualPurchaseOrderNo: 'purchase-old',
      manualPurchasePrice: '28.5',
      packageOrderId: 'bus-must-remain',
      manualProfitLogisticsFeeCny: 4.2,
    });

    const result = writePurchaseOrderLocalOverrideUpsert(
      { 'posting-1': legacyFull },
      order,
      shop,
      (existing) => ({
        ...existing,
        clearFields: ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny'],
        forcePurchaseStatus: '待拍单',
      })
    );

    expect(result.override.clearFields).toEqual([
      'purchasePlatform',
      'purchaseOrderNumber',
      'sourceCostCny',
    ]);
    expect(result.override).not.toHaveProperty('manualBuyerPlatform');
    expect(result.override).not.toHaveProperty('manualPurchaseOrderNo');
    expect(result.override).not.toHaveProperty('manualPurchasePrice');
    expect(result.override).toMatchObject({
      packageOrderId: 'bus-must-remain',
      manualProfitLogisticsFeeCny: 4.2,
      forcePurchaseStatus: '待拍单',
    });
    await expect(result.persistence).resolves.toMatchObject({
      failedKeys: [],
      deletedAliasKeys: ['posting-1'],
      clearFieldsCleaned: true,
    });
    expect(purchaseOverrideClient.savePurchaseOverride).toHaveBeenCalledTimes(2);
    expect(purchaseOverrideClient.savePurchaseOverride.mock.calls[0][1].clearFields).toEqual([
      'purchasePlatform',
      'purchaseOrderNumber',
      'sourceCostCny',
    ]);
    expect(purchaseOverrideClient.savePurchaseOverride.mock.calls[1][1]).not.toHaveProperty('clearFields');
    expect(purchaseOverrideClient.savePurchaseOverride.mock.invocationCallOrder[0]).toBeLessThan(
      purchaseOverrideClient.removePurchaseOverride.mock.invocationCallOrder[0]
    );
    expect(purchaseOverrideClient.removePurchaseOverride.mock.invocationCallOrder[0]).toBeLessThan(
      purchaseOverrideClient.savePurchaseOverride.mock.invocationCallOrder[1]
    );
  });

  it('keeps the clear tombstone in canonical state when exact alias deletion is not confirmed', async () => {
    purchaseOverrideClient.removePurchaseOverride.mockResolvedValue({ ok: true, deleted: 0 });
    const shop = { id: 'shop-1', clientId: 'client-1' };
    const order = {
      id: 'posting-1',
      posting: 'posting-1',
      recordKey: 'client-1:posting-1',
      shopId: 'shop-1',
      shopClientId: 'client-1',
    };
    const result = writePurchaseOrderLocalOverrideUpsert(
      { 'posting-1': override('posting-1', { manualPurchaseOrderNo: 'purchase-old' }) },
      order,
      shop,
      (existing) => ({ ...existing, clearFields: ['purchaseOrderNumber'] })
    );

    await expect(result.persistence).resolves.toMatchObject({
      failedAliasKeys: ['posting-1'],
      clearFieldsCleaned: false,
    });
    expect(purchaseOverrideClient.savePurchaseOverride).toHaveBeenCalledTimes(1);
    expect(localDataFileClient.writeLocalDataFile).not.toHaveBeenCalled();
  });

  it('fails closed without a verified internal shop identity and makes no persistence call', () => {
    const result = writePurchaseOrderLocalOverrideUpsert(
      {},
      { id: 'posting-1', posting: 'posting-1', shopClientId: 'client-1' },
      { id: 'shop-1', clientId: 'client-1' },
      { manualBuyerPlatform: 'PDD' }
    );

    expect(result).toBeNull();
    expect(purchaseOverrideClient.savePurchaseOverride).not.toHaveBeenCalled();
    expect(purchaseOverrideClient.removePurchaseOverride).not.toHaveBeenCalled();
  });

  it('uses the original single-record route, then requires cursor-complete scoped readback before cleanup', async () => {
    const source = { 'posting-1': override('posting-1') };
    localDataFileClient.readLocalDataFile.mockResolvedValue(source);
    purchaseOverrideClient.readPurchaseOverrides
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([override('posting-1')]));

    await hydratePurchaseOrderLocalOverridesFromLocalFile();

    expect(purchaseOverrideClient.savePurchaseOverride).toHaveBeenCalledTimes(1);
    expect(purchaseOverrideClient.importLegacyPurchaseOverrides).not.toHaveBeenCalled();
    expect(localDataFileClient.writeLocalDataFile).toHaveBeenLastCalledWith('purchase-order-local-overrides', {});
  });

  it('imports multiple scoped records through one bulk endpoint and preserves their updatedAt values for readback', async () => {
    const source = {
      'posting-1': override('posting-1'),
      'posting-2': override('posting-2', { manualPurchaseOrderNo: 'p-2', updatedAt: '2026-07-12T00:00:01.000Z' }),
    };
    localDataFileClient.readLocalDataFile.mockResolvedValue(source);
    purchaseOverrideClient.readPurchaseOverrides
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([source['posting-1'], source['posting-2']]));

    await hydratePurchaseOrderLocalOverridesFromLocalFile();

    expect(purchaseOverrideClient.savePurchaseOverride).not.toHaveBeenCalled();
    expect(purchaseOverrideClient.importLegacyPurchaseOverrides).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ shopId: 'shop-1', orderKey: 'posting-1' })]),
      { timeoutMs: 60000 },
    );
    expect(purchaseOverrideClient.readPurchaseOverrides.mock.calls.every(([query]) => query.cursorMode === 'legacy-migration')).toBe(true);
    expect(localDataFileClient.writeLocalDataFile).toHaveBeenLastCalledWith('purchase-order-local-overrides', {});
  });

  it('keeps a clear tombstone intact through multi-record fallback bulk replay and readback', async () => {
    const source = {
      'client-1:posting-clear': override('client-1:posting-clear', {
        clearFields: ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny'],
        forcePurchaseStatus: '待拍单',
      }),
      'client-1:posting-other': override('client-1:posting-other', {
        manualProfitLogisticsFeeCny: 2.5,
      }),
    };
    localDataFileClient.readLocalDataFile.mockResolvedValue(source);
    purchaseOverrideClient.readPurchaseOverrides
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page(Object.values(source)));

    await hydratePurchaseOrderLocalOverridesFromLocalFile();

    expect(purchaseOverrideClient.importLegacyPurchaseOverrides).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          orderKey: 'client-1:posting-clear',
          clearFields: ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny'],
        }),
      ]),
      { timeoutMs: 60000 },
    );
    expect(localDataFileClient.writeLocalDataFile).toHaveBeenLastCalledWith('purchase-order-local-overrides', {});
  });

  it('retains all local-file source bytes when a scope is missing or a cursor page is incomplete', async () => {
    const unscoped = { 'posting-1': { manualBuyerPlatform: 'PDD' } };
    localDataFileClient.readLocalDataFile.mockResolvedValue(unscoped);
    purchaseOverrideClient.readPurchaseOverrides.mockResolvedValue(page([]));
    await migrateLegacyPurchaseOrderOverridesAtStartup();
    expect(purchaseOverrideClient.savePurchaseOverride).not.toHaveBeenCalled();
    expect(localDataFileClient.writeLocalDataFile).toHaveBeenLastCalledWith('purchase-order-local-overrides', unscoped);

    const source = { 'posting-1': override('posting-1') };
    localDataFileClient.readLocalDataFile.mockResolvedValue(source);
    purchaseOverrideClient.readPurchaseOverrides.mockReset();
    purchaseOverrideClient.readPurchaseOverrides.mockResolvedValue({ rows: [], total: 1, hasMore: false, nextCursor: '' });
    await migrateLegacyPurchaseOrderOverridesAtStartup();
    expect(localDataFileClient.writeLocalDataFile).toHaveBeenLastCalledWith('purchase-order-local-overrides', source);
  });

  it('clears the override file fallback after exact cursor-complete readback', async () => {
    const source = { 'posting-1': override('posting-1') };
    localDataFileClient.readLocalDataFile.mockResolvedValue(source);
    purchaseOverrideClient.readPurchaseOverrides
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([source['posting-1']]));
    await hydratePurchaseOrderLocalOverridesFromLocalFile();

    expect(localDataFileClient.writeLocalDataFile).toHaveBeenCalledWith('purchase-order-local-overrides', {});
  });

  it('reads every cursor-reported page and rejects an incomplete total instead of silently truncating', async () => {
    purchaseOverrideClient.readPurchaseOverrides.mockImplementation(async ({ cursor }) => {
      if (!cursor) return page([override('posting-1')], 2, true, 'cursor-1');
      return page([override('posting-2')], 2, false, '');
    });
    const overrides = await readPurchaseOrderOverridesFromLocalApi();
    expect(Object.keys(overrides)).toHaveLength(2);
    expect(purchaseOverrideClient.readPurchaseOverrides).toHaveBeenCalledTimes(2);

    purchaseOverrideClient.readPurchaseOverrides.mockReset();
    purchaseOverrideClient.readPurchaseOverrides.mockResolvedValue({ rows: [], total: 2, hasMore: false, nextCursor: '' });
    await expect(readPurchaseOrderOverridesFromLocalApi()).rejects.toMatchObject({ code: 'PURCHASE_OVERRIDE_CURSOR_READBACK_INCOMPLETE' });
  });
});
