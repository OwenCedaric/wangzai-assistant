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

vi.mock('./productModuleClient.js', () => ({
  readProductSourceLinksFromLocalApi: mocks.readCanonical,
  saveProductSourceLinksToLocalApi: mocks.saveCanonical,
  importLegacyProductSourceLinkRecords: mocks.importCanonical,
}));

import {
  hydrateProductSourceLinksFromLocalFile,
  migrateLegacyProductSourceLinksAtStartup,
  saveProductSourceLinkRecord,
  fenceAndDrainProductSourceLinkMigration,
  releaseProductSourceLinkOwnerFence,
} from './productSourceLinkStore';

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

const shops = [{ id: 'shop-1', clientId: 'client-1' }];

function canonicalFor(records) {
  return Object.fromEntries(Object.entries(records).map(([key, value]) => [key, value]));
}

describe('productSourceLinkStore', () => {
  afterEach(() => {
    releaseProductSourceLinkOwnerFence('shop-1');
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it('drains a directly-started hydration before allowing owner-fence release', async () => {
    let releaseRead;
    mocks.readFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        })
    );
    mocks.readCanonical.mockResolvedValueOnce({}).mockResolvedValue({ 'shop-1:offer-1': record });
    mocks.saveCanonical.mockResolvedValue({ ok: true });
    mocks.writeFile.mockResolvedValue(undefined);
    const hydration = hydrateProductSourceLinksFromLocalFile({}, shops);
    let drained = false;
    const drain = fenceAndDrainProductSourceLinkMigration('shop-1').then((result) => {
      drained = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const drainedBeforeRead = drained;
    if (drained) releaseProductSourceLinkOwnerFence('shop-1');
    releaseRead({ 'client-1:offer-1': record });
    await Promise.allSettled([hydration, drain]);
    releaseProductSourceLinkOwnerFence('shop-1');
    expect(drainedBeforeRead).toBe(false);
    expect(mocks.saveCanonical).not.toHaveBeenCalled();
  });

  it('keeps another owner readable and migratable while a pending deletion fence remains', async () => {
    await fenceAndDrainProductSourceLinkMigration('shop-1');
    const allShops = [...shops, { id: 'shop-2', clientId: 'client-2' }];
    mocks.readFile.mockResolvedValue({ 'client-1:offer-1': record, 'client-2:offer-2': record });
    mocks.readCanonical
      .mockResolvedValueOnce({})
      .mockResolvedValue({ 'shop-1:offer-1': record, 'shop-2:offer-2': record });
    mocks.saveCanonical.mockResolvedValue({ ok: true });
    const result = await hydrateProductSourceLinksFromLocalFile({}, allShops);
    expect(result['shop-1:offer-1']).toBeUndefined();
    expect(result['client-1:offer-1']).toBeUndefined();
    expect(result['shop-2:offer-2']).toBeDefined();
    expect(mocks.saveCanonical).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ shopId: 'shop-2' }), {
      timeoutMs: 30000,
    });
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('does not replace current page state with an old partial global result after release', async () => {
    await fenceAndDrainProductSourceLinkMigration('shop-1');
    let releaseRead;
    mocks.readFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        })
    );
    mocks.readCanonical.mockResolvedValue({ 'shop-1:old': record, 'shop-2:keep': record });
    const current = { 'shop-1:new-generation': { ...record, marker: 'new-generation' }, 'shop-2:keep': record };
    let pageState = current;
    let failure;
    const publication = hydrateProductSourceLinksFromLocalFile({}, [...shops, { id: 'shop-2' }])
      .then((result) => {
        pageState = result;
      })
      .catch((error) => {
        failure = error;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseProductSourceLinkOwnerFence('shop-1');
    releaseRead({});
    await publication;
    expect(failure).toMatchObject({ code: 'ACCOUNT_REMOVAL_STALE_HYDRATION' });
    expect(pageState).toBe(current);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('retains other-owner startup/profit inputs across release without falling into an empty catch fallback', async () => {
    await fenceAndDrainProductSourceLinkMigration('shop-1');
    let releaseRead;
    mocks.readFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        })
    );
    mocks.readCanonical.mockResolvedValue({ 'shop-1:old': record, 'shop-2:keep': record });
    const failureFallback = vi.fn(() => ({}));
    const migration = migrateLegacyProductSourceLinksAtStartup([...shops, { id: 'shop-2' }]).catch(failureFallback);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseProductSourceLinkOwnerFence('shop-1');
    releaseRead({});
    const result = await migration;
    expect(failureFallback).not.toHaveBeenCalled();
    expect(result['shop-1:old']).toBeUndefined();
    expect(result['shop-2:keep']).toBeDefined();
  });

  it('preserves a read failure during a fence instead of publishing an empty global map', async () => {
    await fenceAndDrainProductSourceLinkMigration('shop-1');
    const error = new Error('synthetic canonical unavailable');
    mocks.readFile.mockResolvedValue({});
    mocks.readCanonical.mockRejectedValue(error);
    await expect(hydrateProductSourceLinksFromLocalFile({}, shops)).rejects.toBe(error);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('keeps the existing filtered legacy B fallback for startup/profit consumers when canonical read fails', async () => {
    await fenceAndDrainProductSourceLinkMigration('shop-1');
    mocks.readFile.mockResolvedValue({ 'client-1:old': record, 'client-2:keep': record });
    mocks.readCanonical.mockRejectedValue(new Error('synthetic canonical unavailable'));
    const fallback = vi.fn(() => ({}));
    const result = await migrateLegacyProductSourceLinksAtStartup([
      ...shops,
      { id: 'shop-2', clientId: 'client-2' },
    ]).catch(fallback);
    expect(fallback).not.toHaveBeenCalled();
    expect(result['client-1:old']).toBeUndefined();
    expect(result['client-2:keep']).toBeDefined();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('drains a pending interactive write and prevents a later retry from writing the removed owner', async () => {
    let rejectWrite;
    mocks.saveCanonical
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectWrite = reject;
          })
      )
      .mockResolvedValue({ ok: true });
    const writing = saveProductSourceLinkRecord({ key: 'shop-1:offer-1', record });
    const rejected = expect(writing).rejects.toMatchObject({ code: 'ACCOUNT_REMOVAL_OWNER_QUIESCED' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let drained = false;
    const drain = fenceAndDrainProductSourceLinkMigration('shop-1').then((result) => {
      drained = true;
      return result;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    rejectWrite(new Error('database is locked'));
    await Promise.all([drain, rejected]);
    expect(mocks.saveCanonical).toHaveBeenCalledTimes(1);
    releaseProductSourceLinkOwnerFence('shop-1');
    await expect(saveProductSourceLinkRecord({ key: 'shop-1:new-generation', record })).resolves.toEqual({ ok: true });
  });

  it('uses SQLite as the only write path and retries a transient lock without touching the retired file', async () => {
    mocks.saveCanonical.mockResolvedValue({ ok: true });
    await saveProductSourceLinkRecord({
      key: 'shop-1:offer-1',
      record,
      product: { productId: '101', offerId: 'offer-1', sku: 'sku-1' },
    });
    expect(mocks.saveCanonical).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'shop-1', productKey: 'offer-1' }),
      { timeoutMs: 3000 }
    );
    expect(mocks.writeFile).not.toHaveBeenCalled();

    mocks.saveCanonical.mockReset();
    mocks.saveCanonical.mockRejectedValueOnce(new Error('database is locked')).mockResolvedValueOnce({ ok: true });
    await expect(saveProductSourceLinkRecord({ key: 'shop-1:offer-1', record })).resolves.toEqual({ ok: true });
    expect(mocks.saveCanonical).toHaveBeenCalledTimes(2);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('keeps a single record on the established normal write route and clears only the local file after exact readback', async () => {
    const browserLinks = { 'client-1:offer-1': record };
    mocks.readFile.mockResolvedValue({});
    mocks.readCanonical.mockResolvedValueOnce({}).mockResolvedValueOnce(canonicalFor({ 'shop-1:offer-1': record }));
    mocks.saveCanonical.mockResolvedValue({ ok: true });
    mocks.writeFile.mockResolvedValue(undefined);

    await hydrateProductSourceLinksFromLocalFile(browserLinks, shops);

    expect(mocks.saveCanonical).toHaveBeenCalledTimes(1);
    expect(mocks.saveCanonical).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'shop-1', productKey: 'offer-1' }),
      { timeoutMs: 30000 }
    );
    expect(mocks.importCanonical).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenLastCalledWith('product-source-links', {});
  });

  it('uses one typed bulk import for multiple source records and requires all canonical records to match', async () => {
    const browserLinks = {
      'shop-1:offer-1': record,
      'shop-1:offer-2': {
        ...record,
        links: [{ ...record.links[0], link: 'https://detail.1688.com/offer/2.html', productId: '2' }],
      },
    };
    mocks.readFile.mockResolvedValue({});
    mocks.readCanonical.mockResolvedValueOnce({}).mockResolvedValueOnce(canonicalFor(browserLinks));
    mocks.importCanonical.mockResolvedValue({ ok: true, importedCount: 2 });
    mocks.writeFile.mockResolvedValue(undefined);

    await hydrateProductSourceLinksFromLocalFile(browserLinks, shops);

    expect(mocks.saveCanonical).not.toHaveBeenCalled();
    expect(mocks.importCanonical).toHaveBeenCalledTimes(1);
    expect(mocks.importCanonical).toHaveBeenCalledWith(expect.any(Array), { timeoutMs: 60000 });
    expect(mocks.writeFile).toHaveBeenLastCalledWith('product-source-links', {});
  });

  it('retains the entire local-file source when scope mapping or canonical readback cannot be trusted', async () => {
    const browserLinks = { 'default:offer-1': record, 'shop-1:offer-2': record };
    mocks.readFile.mockResolvedValue(browserLinks);
    mocks.readCanonical.mockResolvedValue({});
    mocks.writeFile.mockResolvedValue(undefined);
    await migrateLegacyProductSourceLinksAtStartup(shops);
    expect(mocks.saveCanonical).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenLastCalledWith('product-source-links', browserLinks);

    const resolved = { 'shop-1:offer-1': record };
    mocks.readFile.mockResolvedValue({});
    mocks.readCanonical.mockReset();
    mocks.readCanonical.mockResolvedValueOnce({}).mockResolvedValueOnce({
      'shop-1:offer-1': { ...record, links: [{ ...record.links[0], link: 'https://changed.test' }] },
    });
    mocks.saveCanonical.mockResolvedValue({ ok: true });
    await hydrateProductSourceLinksFromLocalFile(resolved, shops);
    expect(mocks.writeFile).toHaveBeenLastCalledWith('product-source-links', resolved);
  });

  it('clears the local file fallback only after exact canonical readback', async () => {
    const source = { 'client-1:offer-1': record };
    mocks.readFile.mockResolvedValue(source);
    mocks.readCanonical.mockResolvedValueOnce({}).mockResolvedValueOnce({ 'shop-1:offer-1': record });
    mocks.saveCanonical.mockResolvedValue({ ok: true });

    await hydrateProductSourceLinksFromLocalFile(source, shops);

    expect(mocks.writeFile).toHaveBeenCalledWith('product-source-links', {});
  });
});
