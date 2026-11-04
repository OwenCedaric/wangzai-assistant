import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getProductSummary } from '../../../api/localApiClient.js';
import {
  readCollectionCategoryCommission,
  resolveCollectionCategoryCommission,
} from './collectionCategoryCommissionService.js';

vi.mock('../../../api/localApiClient.js', () => ({ getProductSummary: vi.fn() }));

beforeEach(() => {
  getProductSummary.mockReset();
});

describe('collectionCategoryCommissionService', () => {
  it('uses only exact category and type evidence and accepts one consistent rate', () => {
    const result = resolveCollectionCategoryCommission([
      { categoryId: '10', typeId: '20', commissionPercent: 17 },
      { categoryId: '10', typeId: '20', commissionPercent: '17' },
      { categoryId: '10', typeId: '21', commissionPercent: 19 },
      { categoryId: '11', typeId: '20', commissionPercent: 21 },
    ], { descriptionCategoryId: '10', typeId: '20' });
    expect(result).toMatchObject({ status: 'ready', percent: 17, evidenceCount: 2 });
  });

  it('fails closed when exact-category evidence contains different rates', () => {
    const result = resolveCollectionCategoryCommission([
      { categoryId: '10', typeId: '20', commissionPercent: 17 },
      { categoryId: '10', typeId: '20', commissionPercent: 19 },
    ], { descriptionCategoryId: '10', typeId: '20' });
    expect(result).toMatchObject({ status: 'conflict', percent: null, evidenceCount: 2 });
  });

  it('queries the SQLite product summary with an exact category/type scope', async () => {
    getProductSummary.mockResolvedValue({
      rows: [{ categoryId: '10', typeId: '20', commissionPercent: 17 }],
    });
    const result = await readCollectionCategoryCommission({
      shopId: 'shop-a', descriptionCategoryId: '10', typeId: '20',
    });
    expect(getProductSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: 'shop-a', descriptionCategoryId: '10', typeId: '20', pageSize: 1000,
      }),
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
    expect(result).toMatchObject({ status: 'ready', percent: 17 });
  });
});
