import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readCanonical: vi.fn(),
  saveCanonical: vi.fn(),
  importCanonical: vi.fn(),
}));

vi.mock('../entities/product/productLocalData.jsx', () => ({
  readLocalDataFile: mocks.readFile,
  writeLocalDataFile: mocks.writeFile,
}));

vi.mock('./salesSourceLinkClient.js', () => ({
  readSalesSourceLinks: mocks.readCanonical,
  saveSalesSourcesForOrder: mocks.saveCanonical,
  importLegacySalesSources: mocks.importCanonical,
}));

import {
  hydrateSalesSourceLinksFromLocalFile,
  migrateLegacySalesSourceLinksAtStartup,
  fenceAndDrainSalesSourceLinkMigration,
  releaseSalesSourceLinkOwnerFence,
} from './salesSourceLinkStore';

const record = {
  links: [
    {
      link: 'https://mobile.yangkeduo.com/goods.html?goods_id=1',
      productId: '1',
      platform: 'PDD',
      previewImageUrl: 'https://img.test/preview.jpg',
      originalImageUrl: 'https://img.test/original.jpg',
    },
  ],
  primaryIndex: 0,
  updatedAt: '2026-07-12T00:00:00.000Z',
};

function page(rows, total = rows.length, hasMore = false, nextCursor = '') {
  return { ok: true, rows, total, hasMore, nextCursor };
}

function row(shopId, orderKey, sourceRecord = record) {
  const item = sourceRecord.links[0];
  return {
    shopId,
    orderKey,
    slotIndex: 0,
    isPrimary: true,
    link: item.link,
    sourceProductId: item.productId,
    platform: item.platform,
    previewImageUrl: item.previewImageUrl,
    originalImageUrl: item.originalImageUrl,
    updatedAt: sourceRecord.updatedAt,
  };
}

describe('salesSourceLinkStore', () => {
  afterEach(() => {
    releaseSalesSourceLinkOwnerFence('shop-1');
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it('keeps a newly queued migration excluded from an owner even after that fence is released', async () => {
    await fenceAndDrainSalesSourceLinkMigration('shop-1');
    let releaseRead;
    mocks.readFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        })
    );
    mocks.readCanonical.mockResolvedValueOnce(page([])).mockResolvedValue(page([row('shop-1', 'posting-1')]));
    mocks.saveCanonical.mockResolvedValue({ ok: true });
    mocks.writeFile.mockResolvedValue(undefined);
    const migration = migrateLegacySalesSourceLinksAtStartup([{ id: 'shop-1', clientId: 'client-1' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseSalesSourceLinkOwnerFence('shop-1');
    releaseRead({ 'client-1:posting-1': record });
    await Promise.allSettled([migration]);
    expect(mocks.saveCanonical).not.toHaveBeenCalled();
    expect(mocks.importCanonical).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('continues another owner migration without reviving or clearing the fenced owner legacy records', async () => {
    await fenceAndDrainSalesSourceLinkMigration('shop-1');
    const allShops = [
      { id: 'shop-1', clientId: 'client-1' },
      { id: 'shop-2', clientId: 'client-2' },
    ];
    mocks.readFile.mockResolvedValue({ 'client-1:posting-1': record, 'client-2:posting-2': record });
    mocks.readCanonical
      .mockResolvedValueOnce(page([]))
      .mockResolvedValue(page([row('shop-1', 'posting-1'), row('shop-2', 'posting-2')]));
    mocks.saveCanonical.mockResolvedValue({ ok: true });
    const result = await migrateLegacySalesSourceLinksAtStartup(allShops);
    expect(result.canonicalLinks['shop-1:posting-1']).toBeUndefined();
    expect(result.canonicalLinks['shop-2:posting-2']).toBeDefined();
    expect(result.unresolvedLegacyLinks['client-1:posting-1']).toBeUndefined();
    expect(mocks.saveCanonical).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ shopId: 'shop-2' }), {
      timeoutMs: 30000,
    });
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('does not let an old global startup result replace a newly rebound owner after release', async () => {
    await fenceAndDrainSalesSourceLinkMigration('shop-1');
    let releaseRead;
    mocks.readFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        })
    );
    mocks.readCanonical.mockResolvedValue(page([row('shop-1', 'old'), row('shop-2', 'keep')]));
    const current = { 'shop-1:new': record, 'shop-2:keep': record };
    let pageState = current;
    let failure;
    const publication = migrateLegacySalesSourceLinksAtStartup([{ id: 'shop-1' }, { id: 'shop-2' }])
      .then(({ canonicalLinks, unresolvedLegacyLinks }) => {
        pageState = { ...unresolvedLegacyLinks, ...canonicalLinks };
      })
      .catch((error) => {
        failure = error;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseSalesSourceLinkOwnerFence('shop-1');
    releaseRead({});
    await publication;
    expect(failure).toMatchObject({ code: 'ACCOUNT_REMOVAL_STALE_HYDRATION' });
    expect(pageState).toBe(current);
  });

  it('preserves a canonical read failure rather than returning empty state during a fence', async () => {
    await fenceAndDrainSalesSourceLinkMigration('shop-1');
    const error = new Error('synthetic canonical unavailable');
    mocks.readFile.mockResolvedValue({});
    mocks.readCanonical.mockRejectedValue(error);
    await expect(hydrateSalesSourceLinksFromLocalFile()).rejects.toBe(error);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('maps a historical client-id scope to one shop and clears the local file only after full canonical cursor readback', async () => {
    const browserLinks = { 'client-1:posting-1': record };
    mocks.readFile.mockResolvedValue({});
    mocks.readCanonical.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([row('shop-1', 'posting-1')]));
    mocks.saveCanonical.mockResolvedValue({ ok: true });
    mocks.writeFile.mockResolvedValue(undefined);

    const hydrated = await hydrateSalesSourceLinksFromLocalFile(browserLinks, [{ id: 'shop-1', clientId: 'client-1' }]);
    expect(hydrated.unresolvedLegacyLinks).toEqual({});
    expect(mocks.saveCanonical).toHaveBeenCalledTimes(1);
    expect(mocks.importCanonical).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenLastCalledWith('sales-source-links', {});
  });

  it('uses the exact typed bulk client for multiple records and never falls back to concurrent normal writes', async () => {
    const browserLinks = {
      'client-1:posting-1': record,
      'client-1:posting-2': {
        ...record,
        links: [{ ...record.links[0], link: 'https://mobile.yangkeduo.com/goods.html?goods_id=2', productId: '2' }],
      },
    };
    mocks.readFile.mockResolvedValue({});
    mocks.readCanonical
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(
        page([row('shop-1', 'posting-1'), row('shop-1', 'posting-2', browserLinks['client-1:posting-2'])])
      );
    mocks.importCanonical.mockResolvedValue({ ok: true, importedCount: 2 });
    mocks.writeFile.mockResolvedValue(undefined);

    await hydrateSalesSourceLinksFromLocalFile(browserLinks, [{ id: 'shop-1', clientId: 'client-1' }]);
    expect(mocks.saveCanonical).not.toHaveBeenCalled();
    expect(mocks.importCanonical).toHaveBeenCalledWith(expect.any(Array), { timeoutMs: 60000 });
    expect(mocks.readCanonical.mock.calls.every(([query]) => query.cursorMode === 'legacy-migration')).toBe(true);
  });

  it('retains the full local-file source on bad scope, incomplete pages, or changed canonical link values', async () => {
    const badScope = { 'posting-1': record };
    mocks.readFile.mockResolvedValue(badScope);
    mocks.readCanonical.mockResolvedValue(page([]));
    mocks.writeFile.mockResolvedValue(undefined);
    const bad = await hydrateSalesSourceLinksFromLocalFile({}, [{ id: 'shop-1', clientId: 'client-1' }]);
    expect(bad.unresolvedLegacyLinks).toEqual(badScope);
    expect(mocks.writeFile).toHaveBeenLastCalledWith('sales-source-links', badScope);

    const browserLinks = { 'client-1:posting-1': record };
    mocks.readFile.mockResolvedValue(browserLinks);
    mocks.readCanonical.mockReset();
    mocks.readCanonical.mockResolvedValue({ rows: [], total: 1, hasMore: false, nextCursor: '' });
    await migrateLegacySalesSourceLinksAtStartup([{ id: 'shop-1', clientId: 'client-1' }]);
    expect(mocks.writeFile).toHaveBeenLastCalledWith('sales-source-links', browserLinks);
  });

  it('clears the local file fallback after exact cursor-complete readback', async () => {
    const source = { 'client-1:posting-1': record };
    mocks.readFile.mockResolvedValue(source);
    mocks.readCanonical.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([row('shop-1', 'posting-1')]));
    mocks.saveCanonical.mockResolvedValue({ ok: true });

    await hydrateSalesSourceLinksFromLocalFile(source, [{ id: 'shop-1', clientId: 'client-1' }]);

    expect(mocks.writeFile).toHaveBeenCalledWith('sales-source-links', {});
  });
});
