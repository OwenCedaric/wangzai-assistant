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

vi.mock('./purchaseSourceLinkClient.js', () => ({
  readPurchaseSourceLinks: mocks.readCanonical,
  savePurchaseSourcesForOrder: mocks.saveCanonical,
  importLegacyPurchaseSources: mocks.importCanonical,
}));

import {
  hydratePurchaseSourceLinksFromLocalFile,
  migrateLegacyPurchaseSourceLinksAtStartup,
  savePurchaseSourceLinkRecord,
  readPurchaseSourceLinksFromLocalApi,
  fenceAndDrainPurchaseSourceLinkMigration,
  releasePurchaseSourceLinkOwnerFence,
} from './purchaseSourceLinkStore';

const record = {
  links: [
    {
      link: 'https://detail.1688.com/offer/1.html',
      productId: '1',
      platform: '1688',
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

describe('purchaseSourceLinkStore', () => {
  afterEach(() => {
    releasePurchaseSourceLinkOwnerFence('shop-1');
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it('drains the public canonical read so its old owner rows cannot return after release', async () => {
    let releaseRead;
    mocks.readCanonical.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        })
    );
    const reading = readPurchaseSourceLinksFromLocalApi();
    let drained = false;
    const drain = fenceAndDrainPurchaseSourceLinkMigration('shop-1').then((result) => {
      drained = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const drainedBeforeRead = drained;
    if (drained) releasePurchaseSourceLinkOwnerFence('shop-1');
    releaseRead(page([row('shop-1', 'posting-1')]));
    const [readResult] = await Promise.allSettled([reading, drain]);
    releasePurchaseSourceLinkOwnerFence('shop-1');
    expect(drainedBeforeRead).toBe(false);
    expect(readResult.status === 'fulfilled' ? readResult.value['shop-1:posting-1'] : undefined).toBeUndefined();
  });

  it('keeps other-owner migration available while excluding the pending owner and preserving its legacy file', async () => {
    await fenceAndDrainPurchaseSourceLinkMigration('shop-1');
    const allShops = [
      { id: 'shop-1', clientId: 'client-1' },
      { id: 'shop-2', clientId: 'client-2' },
    ];
    mocks.readFile.mockResolvedValue({ 'client-1:posting-1': record, 'client-2:posting-2': record });
    mocks.readCanonical
      .mockResolvedValueOnce(page([]))
      .mockResolvedValue(page([row('shop-1', 'posting-1'), row('shop-2', 'posting-2')]));
    mocks.saveCanonical.mockResolvedValue({ ok: true });
    const result = await migrateLegacyPurchaseSourceLinksAtStartup(allShops);
    expect(result.canonicalLinks['shop-1:posting-1']).toBeUndefined();
    expect(result.canonicalLinks['shop-2:posting-2']).toBeDefined();
    expect(result.unresolvedLegacyLinks['client-1:posting-1']).toBeUndefined();
    expect(mocks.saveCanonical).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ shopId: 'shop-2' }),
      expect.any(Array),
      expect.objectContaining({ shopId: 'shop-2' })
    );
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('leaves current replaced-page state intact when an excluded startup snapshot crosses release', async () => {
    await fenceAndDrainPurchaseSourceLinkMigration('shop-1');
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
    const publication = migrateLegacyPurchaseSourceLinksAtStartup([{ id: 'shop-1' }, { id: 'shop-2' }])
      .then(({ canonicalLinks, unresolvedLegacyLinks }) => {
        pageState = { ...unresolvedLegacyLinks, ...canonicalLinks };
      })
      .catch((error) => {
        failure = error;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releasePurchaseSourceLinkOwnerFence('shop-1');
    releaseRead({});
    await publication;
    expect(failure).toMatchObject({ code: 'ACCOUNT_REMOVAL_STALE_HYDRATION' });
    expect(pageState).toBe(current);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('preserves the underlying read error in an excluded hydration', async () => {
    await fenceAndDrainPurchaseSourceLinkMigration('shop-1');
    const error = new Error('synthetic canonical unavailable');
    mocks.readFile.mockResolvedValue({});
    mocks.readCanonical.mockRejectedValue(error);
    await expect(hydratePurchaseSourceLinksFromLocalFile()).rejects.toBe(error);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('tracks a pending interactive save through retries while another owner stays writable', async () => {
    let rejectWrite;
    mocks.saveCanonical
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectWrite = reject;
          })
      )
      .mockResolvedValue({ ok: true });
    const writing = savePurchaseSourceLinkRecord({ shopId: 'shop-1', order: { id: 'posting-1' }, record });
    const rejected = expect(writing).rejects.toMatchObject({ code: 'ACCOUNT_REMOVAL_OWNER_QUIESCED' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const drain = fenceAndDrainPurchaseSourceLinkMigration('shop-1');
    rejectWrite(new Error('database is locked'));
    await Promise.all([drain, rejected]);
    expect(mocks.saveCanonical).toHaveBeenCalledTimes(1);
    await expect(
      savePurchaseSourceLinkRecord({ shopId: 'shop-2', order: { id: 'posting-2' }, record })
    ).resolves.toEqual({ ok: true });
  });

  it('writes normal changes through the single order-scoped route before touching a fallback file', async () => {
    mocks.saveCanonical.mockResolvedValue({ ok: true });
    await savePurchaseSourceLinkRecord({ order: { id: 'posting-1' }, shopId: 'shop-1', productKey: 'offer-1', record });
    expect(mocks.saveCanonical).toHaveBeenCalledWith(
      { id: 'posting-1' },
      expect.any(Array),
      expect.objectContaining({ shopId: 'shop-1', primaryIndex: 0 })
    );
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('uses recordKey before the shorter display id and retries transient canonical write failures', async () => {
    mocks.saveCanonical.mockRejectedValueOnce(new Error('database is locked')).mockResolvedValueOnce({ ok: true });

    await expect(
      savePurchaseSourceLinkRecord({
        order: { id: 'posting-1', recordKey: 'client-1:posting-1' },
        shopId: 'shop-1',
        productKey: 'offer-1',
        record,
      })
    ).resolves.toEqual({ ok: true });

    expect(mocks.saveCanonical).toHaveBeenCalledWith(
      { id: 'posting-1', recordKey: 'client-1:posting-1' },
      expect.any(Array),
      expect.objectContaining({ shopId: 'shop-1' })
    );
    expect(mocks.saveCanonical).toHaveBeenCalledTimes(2);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
  it('reports a rejected canonical write without hiding it in a legacy JSON fallback', async () => {
    mocks.saveCanonical.mockResolvedValue({ ok: false });
    await expect(
      savePurchaseSourceLinkRecord({ order: { id: 'posting-1' }, shopId: 'shop-1', record })
    ).rejects.toThrow('PURCHASE_SOURCE_LINK_SAVE_FAILED');
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('maps a client scope once, uses the existing single route, and clears the local file only after cursor-complete readback', async () => {
    const browserLinks = { 'client-1:posting-1': record };
    mocks.readFile.mockResolvedValue({});
    mocks.readCanonical.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([row('shop-1', 'posting-1')]));
    mocks.saveCanonical.mockResolvedValue({ ok: true });
    mocks.writeFile.mockResolvedValue(undefined);

    const hydrated = await hydratePurchaseSourceLinksFromLocalFile(browserLinks, [
      { id: 'shop-1', clientId: 'client-1' },
    ]);
    expect(hydrated.unresolvedLegacyLinks).toEqual({});
    expect(mocks.saveCanonical).toHaveBeenCalledTimes(1);
    expect(mocks.importCanonical).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenLastCalledWith('purchase-source-links', {});
  });

  it('uses one bulk route for multiple logical records and requests cursor-mode readback', async () => {
    const browserLinks = {
      'client-1:posting-1': record,
      'client-1:posting-2': {
        ...record,
        links: [{ ...record.links[0], link: 'https://detail.1688.com/offer/2.html', productId: '2' }],
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

    await hydratePurchaseSourceLinksFromLocalFile(browserLinks, [{ id: 'shop-1', clientId: 'client-1' }]);
    expect(mocks.saveCanonical).not.toHaveBeenCalled();
    expect(mocks.importCanonical).toHaveBeenCalledWith(expect.any(Array), { timeoutMs: 60000 });
    expect(mocks.readCanonical.mock.calls.every(([query]) => query.cursorMode === 'legacy-migration')).toBe(true);
  });

  it('retains the full source if scope is unmappable or any cursor page is incomplete', async () => {
    const unmappable = { 'posting-1': record };
    mocks.readFile.mockResolvedValue(unmappable);
    mocks.readCanonical.mockResolvedValue(page([]));
    mocks.writeFile.mockResolvedValue(undefined);
    const result = await hydratePurchaseSourceLinksFromLocalFile({}, [{ id: 'shop-1', clientId: 'client-1' }]);
    expect(result.unresolvedLegacyLinks).toEqual(unmappable);
    expect(mocks.writeFile).toHaveBeenLastCalledWith('purchase-source-links', unmappable);

    const browserLinks = { 'client-1:posting-1': record };
    mocks.readFile.mockResolvedValue(browserLinks);
    mocks.readCanonical.mockReset();
    mocks.readCanonical.mockResolvedValue({ rows: [], total: 1, hasMore: false, nextCursor: '' });
    await migrateLegacyPurchaseSourceLinksAtStartup([{ id: 'shop-1', clientId: 'client-1' }]);
    expect(mocks.writeFile).toHaveBeenLastCalledWith('purchase-source-links', browserLinks);
  });

  it('clears the local file fallback after exact cursor-complete readback', async () => {
    const source = { 'client-1:posting-1': record };
    mocks.readFile.mockResolvedValue(source);
    mocks.readCanonical.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([row('shop-1', 'posting-1')]));
    mocks.saveCanonical.mockResolvedValue({ ok: true });

    await hydratePurchaseSourceLinksFromLocalFile(source, [{ id: 'shop-1', clientId: 'client-1' }]);

    expect(mocks.writeFile).toHaveBeenCalledWith('purchase-source-links', {});
  });
});
