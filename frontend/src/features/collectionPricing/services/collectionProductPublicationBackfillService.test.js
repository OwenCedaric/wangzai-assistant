import { describe, expect, it, vi } from 'vitest';

import {
  backfillCollectionProductPublications,
  collectCollectionProductPublicationCandidates,
} from './collectionProductPublicationBackfillService.js';

function savedDraft(shopId, offerIds, extra = {}) {
  return {
    shopId,
    updatedAt: '2026-08-09T12:00:00.000Z',
    skus: offerIds.map((offerId) => ({ offerId, enabled: true })),
    ...extra,
  };
}

describe('collection product publication backfill', () => {
  it('queries each shop in batches and marks only a shop with every saved SKU offer', async () => {
    const product = {
      id: '1688:one',
      ozonListingDrafts: {
        'shop-a': savedDraft('shop-a', ['WZ-1', 'WZ-2']),
        'shop-b': savedDraft('shop-b', ['WZ-1', 'WZ-2']),
      },
    };
    const readProducts = vi.fn(async ({ shopId }) => ({
      ok: true,
      rows: shopId === 'shop-a'
        ? [{ offerId: 'WZ-1' }, { offerId: 'WZ-2' }]
        : [{ offerId: 'WZ-1' }],
    }));

    const result = await backfillCollectionProductPublications(
      [product],
      [{ id: 'shop-a', name: '店铺 A' }, { id: 'shop-b', name: '店铺 B' }],
      { readProducts, now: () => '2026-08-10T16:00:00.000Z' },
    );

    expect(readProducts).toHaveBeenCalledTimes(2);
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].ozonPublication.shops).toEqual([
      expect.objectContaining({ shopId: 'shop-a', shopLabel: '店铺 A', uploaded: true, readBackVerified: true, matchedSkuCount: 2, expectedSkuCount: 2 }),
      expect.objectContaining({ shopId: 'shop-b', shopLabel: '店铺 B', uploaded: false, partiallyUploaded: true, matchedSkuCount: 1, expectedSkuCount: 2 }),
    ]);
  });

  it('does not infer an upload from the automatically normalized unsaved draft', () => {
    expect(collectCollectionProductPublicationCandidates([{
      id: '1688:unsaved',
      ozonListingDraft: { shopId: 'shop-a', updatedAt: '', skus: [{ offerId: 'WZ-123' }] },
    }], [{ id: 'shop-a' }])).toEqual([]);
  });

  it('keeps an already verified shop and does not query it again', async () => {
    const readProducts = vi.fn(async () => ({ ok: true, rows: [] }));
    const result = await backfillCollectionProductPublications([{
      id: '1688:verified',
      ozonListingDrafts: { 'shop-a': savedDraft('shop-a', ['WZ-1']) },
      ozonPublication: {
        status: 'completed',
        shops: [{ shopId: 'shop-a', uploaded: true, readBackVerified: true }],
      },
    }], [{ id: 'shop-a' }], { readProducts });

    expect(readProducts).not.toHaveBeenCalled();
    expect(result).toEqual({ patches: [], queryCount: 0 });
  });

  it('does not mark a shop when any cache chunk fails', async () => {
    const offers = Array.from({ length: 201 }, (_, index) => `WZ-${index + 1}`);
    const readProducts = vi.fn()
      .mockResolvedValueOnce({ ok: true, rows: offers.slice(0, 200).map((offerId) => ({ offerId })) })
      .mockRejectedValueOnce(new Error('cache unavailable'));
    const result = await backfillCollectionProductPublications([{
      id: '1688:large',
      ozonListingDrafts: { 'shop-a': savedDraft('shop-a', offers) },
    }], [{ id: 'shop-a' }], { readProducts });

    expect(readProducts).toHaveBeenCalledTimes(2);
    expect(result.patches).toEqual([]);
  });

  it('supports a legacy multi-shop draft without mixing shop results', async () => {
    const readProducts = vi.fn(async ({ shopId }) => ({
      ok: true,
      rows: shopId === 'shop-b' ? [{ offerId: 'WZ-88' }] : [],
    }));
    const result = await backfillCollectionProductPublications([{
      id: '1688:legacy',
      ozonListingDraft: savedDraft('shop-a', ['WZ-88'], { uploadShopIds: ['shop-a', 'shop-b'] }),
    }], [{ id: 'shop-a' }, { id: 'shop-b', alias: '二店' }], { readProducts });

    expect(result.patches[0].ozonPublication.shops).toEqual([
      expect.objectContaining({ shopId: 'shop-b', shopLabel: '二店', uploaded: true }),
    ]);
  });

  it('matches the exact historical SPB offer alias and reports a partial SKU upload', async () => {
    const product = {
      id: '1688:907805856885',
      sourceProductId: '907805856885',
      ozonListingDrafts: {
        'shop-a': savedDraft('shop-a', ['WZ-5934148230629', 'WZ-5934148230667'], {
          uploadShopIds: ['shop-a'],
          skus: [
            { sourceSkuId: '5934148230629', offerId: 'WZ-5934148230629', enabled: true },
            { sourceSkuId: '5934148230667', offerId: 'WZ-5934148230667', enabled: true },
          ],
        }),
      },
    };
    const readProducts = vi.fn(async () => ({
      ok: true,
      rows: [{ offerId: 'SPB-907805856885-5934148230629' }],
    }));
    const result = await backfillCollectionProductPublications(
      [product],
      [{ id: 'shop-a', name: '老店' }],
      { readProducts },
    );

    expect(result.patches[0].ozonPublication.shops[0]).toMatchObject({
      shopId: 'shop-a',
      uploaded: false,
      partiallyUploaded: true,
      readBackVerified: true,
      matchedSkuCount: 1,
      expectedSkuCount: 2,
      status: 'partial',
    });
  });

  it('does not treat the catalog/master shop as an upload target', () => {
    const candidates = collectCollectionProductPublicationCandidates([{
      id: '1688:target-scope',
      ozonListingDrafts: {
        'shop-master': savedDraft('shop-master', ['WZ-1'], { uploadShopIds: ['shop-target'] }),
      },
      ozonListingDraft: savedDraft('shop-master', ['WZ-1'], { uploadShopIds: ['shop-target'] }),
    }], [{ id: 'shop-master' }, { id: 'shop-target' }]);

    expect(candidates.map((candidate) => candidate.shopId)).toEqual(['shop-target']);
  });

  it('uses the persisted upload target while the global shop list is still loading', () => {
    const candidates = collectCollectionProductPublicationCandidates([{
      id: '1688:loading-shops',
      ozonListingDraft: savedDraft('shop-master', ['WZ-1'], { uploadShopIds: ['shop-target'] }),
    }], []);

    expect(candidates).toEqual([
      expect.objectContaining({ productId: '1688:loading-shops', shopId: 'shop-target', shopLabel: 'shop-target' }),
    ]);
  });
});
