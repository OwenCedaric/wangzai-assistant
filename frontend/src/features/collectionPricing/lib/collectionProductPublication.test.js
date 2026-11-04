import { describe, expect, it } from 'vitest';

import {
  getCollectionProductPublicationSummary,
  mergeCollectionProductPublicationResult,
  normalizeCollectionProductPublication,
} from './collectionProductPublication.js';

describe('collection product publication state', () => {
  it('records only shops that passed the real Ozon readback as uploaded', () => {
    const publication = mergeCollectionProductPublicationResult(null, {
      status: 'partial',
      operationId: 'operation-1',
      shopResults: [
        { shopId: 'shop-a', shopLabel: '店铺 A', status: 'completed', completed: true },
        { shopId: 'shop-b', shopLabel: '店铺 B', status: 'pending_readback', completed: false },
      ],
    }, '2026-08-10T15:00:00.000Z');

    expect(publication.shops).toEqual([
      expect.objectContaining({ shopId: 'shop-a', uploaded: true, readBackVerified: true }),
      expect.objectContaining({ shopId: 'shop-b', uploaded: false, status: 'pending_readback' }),
    ]);
    expect(getCollectionProductPublicationSummary({ ozonPublication: publication }, [])).toEqual({
      state: 'uploaded',
      label: '已上传',
      shopLabels: ['店铺 A'],
      detail: '已通过 Ozon 回读：店铺 A',
    });
  });

  it('keeps a previously verified shop uploaded when a later update attempt fails', () => {
    const previous = normalizeCollectionProductPublication({
      status: 'completed',
      shops: [{ shopId: 'shop-a', shopLabel: '旧名称', completed: true }],
    });
    const publication = mergeCollectionProductPublicationResult(previous, {
      status: 'failed',
      shopResults: [{ shopId: 'shop-a', shopLabel: '店铺 A', status: 'failed', error: '更新失败' }],
    }, '2026-08-10T15:10:00.000Z');

    expect(publication.shops[0]).toMatchObject({
      shopId: 'shop-a',
      shopLabel: '店铺 A',
      uploaded: true,
      status: 'completed',
      lastAttemptStatus: 'failed',
      error: '更新失败',
    });
  });

  it('uses the current shop alias and reports untouched products as not uploaded', () => {
    expect(getCollectionProductPublicationSummary({}, [])).toMatchObject({ state: 'not-uploaded', label: '未上传' });
    expect(getCollectionProductPublicationSummary({
      ozonPublication: {
        status: 'completed',
        shops: [{ shopId: 'shop-a', shopLabel: '旧名称', completed: true }],
      },
    }, [{ id: 'shop-a', name: '当前店铺名' }])).toMatchObject({
      state: 'uploaded',
      shopLabels: ['当前店铺名'],
    });
  });

  it('shows a verified partial upload instead of incorrectly saying not uploaded', () => {
    const publication = mergeCollectionProductPublicationResult(null, {
      status: 'partial',
      shopResults: [{
        shopId: 'shop-a',
        shopLabel: '店铺 A',
        status: 'partial',
        completed: false,
        matchedSkuCount: 80,
        expectedSkuCount: 82,
      }],
    });

    expect(getCollectionProductPublicationSummary({ ozonPublication: publication }, [])).toEqual({
      state: 'partial',
      label: '部分上传',
      shopLabels: ['店铺 A'],
      detail: 'Ozon 已找到部分 SKU：店铺 A（80/82）',
    });
  });
});
