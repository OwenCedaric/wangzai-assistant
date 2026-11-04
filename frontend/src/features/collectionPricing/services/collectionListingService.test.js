import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  confirmProductWrite,
  previewProductWrite,
  releaseProductWritePreview,
} from '../../../services/productWriteClient.js';
import {
  COLLECTION_LISTING_CONFIRM_TIMEOUT_MS,
  COLLECTION_LISTING_PREVIEW_CHUNK_HARD_MAX_BYTES,
  canResumeCollectionListingReadBack,
  confirmCollectionListing,
  continueCollectionListingReadBack,
  previewCollectionListing,
} from './collectionListingService.js';

vi.mock('../../../services/productWriteClient.js', () => ({
  previewProductWrite: vi.fn(),
  confirmProductWrite: vi.fn(),
  releaseProductWritePreview: vi.fn(),
}));
const draft = {
  shopId: 'shop-1', offerId: 'SPB-123', title: 'Тестовый товар', description: '',
  descriptionCategoryId: '100', typeId: '200', price: '1000', oldPrice: '1600', minPrice: '700',
  currencyCode: 'CNY', vat: '0', weightG: '300', packageLengthCm: '20', packageWidthCm: '10', packageHeightCm: '8',
  imagesText: 'https://img.example/main.jpg', attributesJson: '[]', stock: '', warehouseId: '',
};

beforeEach(() => {
  previewProductWrite.mockReset();
  confirmProductWrite.mockReset();
  releaseProductWritePreview.mockReset().mockResolvedValue({ ok: true, released: true });
});

describe('collection listing service', () => {
  it('previews every write before confirmation and completes only after merged readback', async () => {
    previewProductWrite
      .mockResolvedValueOnce({ ok: true, previewId: 'info-preview' })
      .mockResolvedValueOnce({ ok: true, previewId: 'price-preview' });
    confirmProductWrite
      .mockResolvedValueOnce({ ok: true, writeConnected: true, writeStatus: 'readback_merged', readBack: { status: 'merged' } })
      .mockResolvedValueOnce({ ok: true, writeConnected: true, writeStatus: 'readback_merged', readBack: { status: 'merged' } });
    const preview = await previewCollectionListing(draft);
    expect(previewProductWrite).toHaveBeenCalledTimes(2);
    expect(confirmProductWrite).not.toHaveBeenCalled();
    const result = await confirmCollectionListing(preview);
    expect(result.completed).toBe(true);
    expect(result.results.every((item) => item.readBackStatus === 'merged')).toBe(true);
    expect(releaseProductWritePreview).toHaveBeenCalledTimes(1);
    expect(releaseProductWritePreview.mock.calls[0][0].previewIds).toEqual(['info-preview', 'price-preview']);
  });

  it('stops the chain when a preceding Ozon readback is still pending', async () => {
    previewProductWrite
      .mockResolvedValueOnce({ ok: true, previewId: 'info-preview' })
      .mockResolvedValueOnce({ ok: true, previewId: 'price-preview' });
    confirmProductWrite.mockResolvedValueOnce({
      ok: true,
      writeConnected: true,
      writeStatus: 'accepted',
      readBack: {
        status: 'pending',
        verification: {
          reason: 'product_sku_not_ready',
          missingOfferIds: ['SPB-123'],
        },
      },
    });
    const preview = await previewCollectionListing(draft);
    const result = await confirmCollectionListing(preview);
    expect(result.status).toBe('pending_readback');
    expect(result.stoppedAt).toBe('info');
    expect(result.message).toContain('仍有 1 个 SKU 尚未创建完成');
    expect(confirmProductWrite).toHaveBeenCalledTimes(1);
  });

  it('continues an accepted import by readback task id without confirming the product write again', async () => {
    previewProductWrite
      .mockResolvedValueOnce({ ok: true, previewId: 'info-preview-resume' })
      .mockResolvedValueOnce({ ok: true, previewId: 'price-preview-resume' });
    confirmProductWrite
      .mockResolvedValueOnce({
        ok: true,
        writeConnected: true,
        writeStatus: 'submitted_waiting_readback',
        schedulerResult: { jobId: 'write-job-resume' },
        readBack: { status: 'pending', importTask: { taskId: 7799 } },
      })
      .mockResolvedValueOnce({
        ok: true,
        writeConnected: true,
        writeStatus: 'readback_merged',
        readBack: { status: 'merged', importTask: { taskId: 7799 } },
      })
      .mockResolvedValueOnce({
        ok: true,
        writeConnected: true,
        writeStatus: 'readback_merged',
        readBack: { status: 'merged' },
      });

    const preview = await previewCollectionListing(draft);
    const pending = await confirmCollectionListing(preview);
    expect(canResumeCollectionListingReadBack(pending)).toBe(true);

    const completed = await continueCollectionListingReadBack(preview, pending);

    expect(completed.completed).toBe(true);
    expect(confirmProductWrite).toHaveBeenCalledTimes(3);
    expect(confirmProductWrite.mock.calls[1][0]).toMatchObject({
      previewId: 'info-preview-resume',
      resumeReadBackOnly: true,
      readBackTaskId: 7799,
      readBackJobId: 'write-job-resume',
    });
    expect(confirmProductWrite.mock.calls[2][0]).not.toHaveProperty('resumeReadBackOnly');
  });

  it('rechecks a non-terminal product mismatch by task id without importing the product again', async () => {
    previewProductWrite
      .mockResolvedValueOnce({ ok: true, previewId: 'info-preview-mismatch-resume' })
      .mockResolvedValueOnce({ ok: true, previewId: 'price-preview-mismatch-resume' });
    confirmProductWrite
      .mockResolvedValueOnce({
        ok: true,
        writeConnected: true,
        writeStatus: 'readback_mismatch',
        schedulerResult: { jobId: 'write-job-mismatch-resume' },
        readBack: {
          status: 'mismatch',
          verification: { terminal: false, mismatches: [{ offerId: 'SPB-123', fields: ['name'] }] },
          importTask: { taskId: 8801, failed: false },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        writeConnected: true,
        writeStatus: 'readback_merged',
        readBack: { status: 'merged', importTask: { taskId: 8801 } },
      })
      .mockResolvedValueOnce({
        ok: true,
        writeConnected: true,
        writeStatus: 'readback_merged',
        readBack: { status: 'merged' },
      });

    const preview = await previewCollectionListing(draft);
    const mismatched = await confirmCollectionListing(preview);
    expect(canResumeCollectionListingReadBack(mismatched)).toBe(true);

    const completed = await continueCollectionListingReadBack(preview, mismatched);

    expect(completed.completed).toBe(true);
    expect(confirmProductWrite).toHaveBeenCalledTimes(3);
    expect(confirmProductWrite.mock.calls[1][0]).toMatchObject({
      previewId: 'info-preview-mismatch-resume',
      resumeReadBackOnly: true,
      readBackTaskId: 8801,
      readBackJobId: 'write-job-mismatch-resume',
    });
  });

  it('does not offer readback resume after Ozon marks the import task terminal', () => {
    expect(canResumeCollectionListingReadBack({
      completed: false,
      results: [{
        kind: 'info',
        readBackStatus: 'failed',
        response: {
          readBack: {
            status: 'failed',
            verification: { terminal: true },
            importTask: { taskId: 7799, failed: true },
          },
        },
      }],
    })).toBe(false);
  });

  it('continues price readback without submitting the accepted price write again', async () => {
    previewProductWrite
      .mockResolvedValueOnce({ ok: true, previewId: 'info-preview-price-resume' })
      .mockResolvedValueOnce({ ok: true, previewId: 'price-preview-price-resume' });
    confirmProductWrite
      .mockResolvedValueOnce({
        ok: true,
        writeConnected: true,
        writeStatus: 'readback_merged',
        readBack: { status: 'merged' },
      })
      .mockResolvedValueOnce({
        ok: true,
        writeConnected: true,
        writeStatus: 'submitted_waiting_readback',
        schedulerResult: { jobId: 'price-write-job' },
        readBack: { status: 'pending', verification: { pending: true } },
      })
      .mockResolvedValueOnce({
        ok: true,
        writeConnected: true,
        writeStatus: 'readback_merged',
        readBack: { status: 'merged' },
      });

    const preview = await previewCollectionListing(draft);
    const pending = await confirmCollectionListing(preview);
    expect(canResumeCollectionListingReadBack(pending)).toBe(true);

    const completed = await continueCollectionListingReadBack(preview, pending);

    expect(completed.completed).toBe(true);
    expect(confirmProductWrite).toHaveBeenCalledTimes(3);
    expect(confirmProductWrite.mock.calls[2][0]).toMatchObject({
      previewId: 'price-preview-price-resume',
      resumeReadBackOnly: true,
      readBackJobId: 'price-write-job',
    });
    expect(confirmProductWrite.mock.calls[2][0].readBackTaskId).toBeUndefined();
  });

  it('shows generic SKU field evidence when Ozon returns a real mismatch', async () => {
    previewProductWrite
      .mockResolvedValueOnce({ ok: true, previewId: 'info-preview-mismatch' })
      .mockResolvedValueOnce({ ok: true, previewId: 'price-preview-mismatch' });
    confirmProductWrite.mockResolvedValueOnce({
      ok: true,
      writeConnected: true,
      writeStatus: 'readback_mismatch',
      readBack: {
        status: 'mismatch',
        verification: {
          checked: 49,
          mismatches: Array.from({ length: 20 }, (_, index) => ({
            offerId: `offer-${index + 1}`,
            fields: ['name', 'attributes'],
          })),
        },
      },
    });

    const preview = await previewCollectionListing(draft);
    const result = await confirmCollectionListing(preview);

    expect(result.status).toBe('pending_readback');
    expect(result.message).toContain('至少 20/49 个 SKU');
    expect(result.message).toContain('标题、属性');
    expect(confirmProductWrite).toHaveBeenCalledTimes(1);
  });

  it('sends cross-border CNY SKU prices unchanged while creating the Ozon preview', async () => {
    previewProductWrite
      .mockResolvedValueOnce({ ok: true, previewId: 'info-preview-cny' })
      .mockResolvedValueOnce({ ok: true, previewId: 'price-preview-cny' });
    const preview = await previewCollectionListing({
      ...draft,
      currencyCode: 'RUB',
      price: '', oldPrice: '', minPrice: '',
      skus: [{
        sourceSkuId: 'a', offerId: 'SPB-123', title: draft.title,
        priceCny: '100', oldPriceCny: '130', minPriceCny: '70', enabled: true,
      }],
    });

    expect(preview.draftSnapshot.skus[0].priceCny).toBe('100');
    expect(preview).not.toHaveProperty('pricingConversion');
    expect(preview.prices[0]).toMatchObject({ price: '100', old_price: '130', min_price: '70', currency_code: 'CNY' });
    expect(preview.products[0]).toMatchObject({ price: '100', old_price: '130', currency_code: 'CNY' });
    expect(previewProductWrite.mock.calls[1][0].after.prices[0]).toMatchObject({ price: '100', currency_code: 'CNY' });
    expect(previewProductWrite.mock.calls[1][0]).not.toHaveProperty('payload');
  });

  it('sends one compact preview copy and confirms with the stored preview instead of resending all SKU data', async () => {
    previewProductWrite
      .mockResolvedValueOnce({ ok: true, previewId: 'info-preview-compact' })
      .mockResolvedValueOnce({ ok: true, previewId: 'price-preview-compact' });
    confirmProductWrite.mockResolvedValue({
      ok: true, writeConnected: true, writeStatus: 'readback_merged', readBack: { status: 'merged' },
    });

    const preview = await previewCollectionListing(draft);
    expect(previewProductWrite.mock.calls[0][0]).not.toHaveProperty('payload');
    expect(previewProductWrite.mock.calls[0][0].after.items).toHaveLength(1);

    await confirmCollectionListing(preview);
    expect(confirmProductWrite.mock.calls[0][0]).not.toHaveProperty('payload');
    expect(confirmProductWrite.mock.calls[0][0]).not.toHaveProperty('after');
    expect(confirmProductWrite.mock.calls[0][0]).toMatchObject({
      previewId: 'info-preview-compact', confirm: true, waitForResult: true,
    });
    expect(confirmProductWrite.mock.calls[0][1]).toMatchObject({
      timeoutMs: COLLECTION_LISTING_CONFIRM_TIMEOUT_MS,
    });
  });

  it('splits a real 80-SKU preview by actual UTF-8 bytes and keeps every chunk below the hard bridge ceiling', async () => {
    previewProductWrite.mockImplementation(async (_command, _options) => ({
      ok: true,
      previewId: `preview-80-${previewProductWrite.mock.calls.length}`,
    }));
    const imagesText = Array.from({ length: 30 }, (_, index) => (
      `https://img.example/${index}/${'image-path-'.repeat(16)}.jpg`
    )).join('\n');
    const skus = Array.from({ length: 80 }, (_, index) => ({
      sourceSkuId: `source-${index + 1}`,
      offerId: `SPB-BULK-${String(index + 1).padStart(3, '0')}`,
      title: `${draft.title} ${index + 1}`,
      price: '1000', oldPrice: '1300', minPrice: '700', enabled: true,
    }));

    const preview = await previewCollectionListing({ ...draft, imagesText, skus });
    const infoEnvelopes = previewProductWrite.mock.calls
      .map(([command]) => command)
      .filter((command) => Array.isArray(command.after?.items));
    expect(infoEnvelopes.length).toBeGreaterThan(1);
    expect(infoEnvelopes.flatMap((command) => command.after.items)).toHaveLength(80);
    expect(preview.transport.chunkCount).toBe(previewProductWrite.mock.calls.length);
    for (const [command] of previewProductWrite.mock.calls) {
      const serializedBytes = new TextEncoder().encode(JSON.stringify(command)).byteLength;
      expect(command).not.toHaveProperty('payload');
      expect(serializedBytes).toBeLessThanOrEqual(COLLECTION_LISTING_PREVIEW_CHUNK_HARD_MAX_BYTES);
    }
  });

  it('never splits SKUs from the same Ozon card model across import requests', async () => {
    previewProductWrite.mockImplementation(async () => ({
      ok: true,
      previewId: `preview-card-group-${previewProductWrite.mock.calls.length}`,
    }));
    const skus = Array.from({ length: 80 }, (_, index) => ({
      sourceSkuId: `card-source-${index + 1}`,
      offerId: `CARD-${String(index + 1).padStart(3, '0')}`,
      title: `Карточка с общей моделью ${index + 1}`,
      price: '1000', oldPrice: '1300', minPrice: '700', enabled: true,
    }));

    const preview = await previewCollectionListing({
      ...draft,
      attributesJson: JSON.stringify([{
        id: 9048,
        values: [{ dictionary_value_id: 0, value: 'GB02' }],
      }]),
      skus,
    }, {
      previewChunkTargetBytes: 4_000,
      previewChunkHardMaxBytes: 1024 * 1024,
    });
    const infoSteps = preview.steps.filter((step) => step.kind === 'info');

    expect(infoSteps).toHaveLength(1);
    expect(infoSteps[0].command.after.items).toHaveLength(80);
    expect(infoSteps[0].byteLength).toBeGreaterThan(4_000);
    expect(infoSteps[0].byteLength).toBeLessThanOrEqual(1024 * 1024);
  });

  it('continues through every generic product, price and stock chunk after exact readback', async () => {
    previewProductWrite.mockImplementation(async () => ({
      ok: true,
      previewId: `preview-chain-${previewProductWrite.mock.calls.length}`,
    }));
    confirmProductWrite.mockResolvedValue({
      ok: true,
      writeConnected: true,
      writeStatus: 'readback_merged',
      readBack: { status: 'merged' },
    });
    const skus = Array.from({ length: 12 }, (_, index) => ({
      sourceSkuId: `future-source-${index + 1}`,
      offerId: `FUTURE-${String(index + 1).padStart(3, '0')}`,
      title: `Универсальный товар ${index + 1} ${'подробное название '.repeat(8)}`,
      price: '1000', oldPrice: '1300', minPrice: '700',
      stock: '20', warehouseId: '12345', enabled: true,
    }));

    const preview = await previewCollectionListing({ ...draft, skus }, {
      previewChunkTargetBytes: 4_000,
      previewChunkHardMaxBytes: 64 * 1024,
    });
    const result = await confirmCollectionListing(preview);

    expect(preview.steps.filter((step) => step.kind === 'info').length).toBeGreaterThan(1);
    expect(result.completed).toBe(true);
    expect(confirmProductWrite).toHaveBeenCalledTimes(preview.steps.length);
    expect(result.results.map((item) => item.kind)).toEqual(preview.steps.map((step) => step.kind));
    expect(result.results.every((item) => item.readBackStatus === 'merged')).toBe(true);
  });

  it('fails one oversized SKU clearly before transport instead of freezing or dropping the connection', async () => {
    await expect(previewCollectionListing(draft, {
      previewChunkTargetBytes: 300,
      previewChunkHardMaxBytes: 400,
    })).rejects.toMatchObject({ code: 'COLLECTION_LISTING_ITEM_TOO_LARGE' });
    expect(previewProductWrite).not.toHaveBeenCalled();
  });

  it('cancels between chunks and releases every partial server preview', async () => {
    const controller = new AbortController();
    previewProductWrite.mockImplementation(async (_command, requestOptions) => {
      if (requestOptions?.signal?.aborted) {
        const error = new Error('请求已取消');
        error.name = 'AbortError';
        throw error;
      }
      return { ok: true, previewId: `partial-${previewProductWrite.mock.calls.length}` };
    });
    const skus = Array.from({ length: 8 }, (_, index) => ({
      sourceSkuId: `source-${index}`,
      offerId: `SPB-CANCEL-${index}`,
      title: `${draft.title} ${'长标题'.repeat(40)} ${index}`,
      price: '1000', oldPrice: '1300', minPrice: '700', enabled: true,
    }));

    await expect(previewCollectionListing({ ...draft, skus }, {
      signal: controller.signal,
      previewChunkTargetBytes: 2_000,
      previewChunkHardMaxBytes: 64 * 1024,
      onProgress(progress) {
        if (progress.phase === 'previewing' && progress.current === 2) controller.abort();
      },
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(previewProductWrite).toHaveBeenCalledTimes(2);
    expect(releaseProductWritePreview).toHaveBeenCalledTimes(1);
    expect(releaseProductWritePreview.mock.calls[0][0].previewIds).toEqual(['partial-1']);
  });
});
