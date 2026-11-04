import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  getProfileSetting: vi.fn(),
  saveProfileSetting: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', () => ({
  getProfileSetting: apiMocks.getProfileSetting,
  saveProfileSetting: apiMocks.saveProfileSetting,
}));

import {
  SMART_TOOL_IMAGE_HISTORY_NAMESPACE,
  SMART_TOOL_IMAGE_HISTORY_RETENTION_MS,
  filterSmartToolImageHistory,
  loadSmartToolImageGenerationHistory,
  normalizeSmartToolImageHistoryMap,
  saveSmartToolImageGenerationHistory,
} from './smartToolImageHistoryService.js';

const TOOL_ID = 'ozon-product-image-generation';
const NOW_MS = Date.parse('2026-07-20T12:00:00.000Z');

function historyEntry(overrides = {}) {
  return {
    id: 'history-1',
    accountId: 'account-a',
    shopId: 'shop-a',
    productKey: 'offer-a',
    sku: 'sku-a',
    createdAt: new Date(NOW_MS - 60_000).toISOString(),
    items: [{ sourceIndex: 0, assetId: 'asset-a', imageUrl: 'data:image/png;base64,aW1hZ2U=' }],
    ...overrides,
  };
}

describe('smartToolImageHistoryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.saveProfileSetting.mockImplementation(async (namespace, value) => ({
      setting: { namespace, value },
    }));
  });

  it('keeps recent asset previews and removes entries older than three days', () => {
    const normalized = normalizeSmartToolImageHistoryMap({
      [TOOL_ID]: [
        historyEntry(),
        historyEntry({
          id: 'history-expired',
          createdAt: new Date(NOW_MS - SMART_TOOL_IMAGE_HISTORY_RETENTION_MS - 1).toISOString(),
        }),
      ],
    }, { nowMs: NOW_MS });

    expect(normalized[TOOL_ID]).toHaveLength(1);
    expect(normalized[TOOL_ID][0]).toMatchObject({
      id: 'history-1',
      accountId: 'account-a',
      shopId: 'shop-a',
      productKey: 'offer-a',
    });
    expect(normalized[TOOL_ID][0].items[0].imageUrl).toBe('/api/product-images/preview/asset-a');
  });

  it('returns history only for the same account, shop, product and SKU', () => {
    const entries = [
      historyEntry(),
      historyEntry({ id: 'other-shop', shopId: 'shop-b' }),
      historyEntry({ id: 'other-product', productKey: 'offer-b' }),
      historyEntry({ id: 'other-sku', sku: 'sku-b' }),
    ];

    expect(filterSmartToolImageHistory(entries, {
      accountId: 'account-a',
      shopId: 'shop-a',
      productKey: 'offer-a',
      sku: 'sku-a',
    }, { nowMs: NOW_MS }).map((entry) => entry.id)).toEqual(['history-1']);
  });

  it('merges the stored value before saving so a refresh cannot clear previous history', async () => {
    apiMocks.getProfileSetting.mockResolvedValue({
      setting: {
        value: {
          [TOOL_ID]: [historyEntry({ id: 'stored-history' })],
        },
      },
    });

    const saved = await saveSmartToolImageGenerationHistory({
      [TOOL_ID]: [historyEntry({ id: 'new-history', createdAt: new Date(NOW_MS).toISOString() })],
    }, { nowMs: NOW_MS });

    expect(saved[TOOL_ID].map((entry) => entry.id)).toEqual(['new-history', 'stored-history']);
    expect(apiMocks.saveProfileSetting).toHaveBeenCalledWith(
      SMART_TOOL_IMAGE_HISTORY_NAMESPACE,
      expect.objectContaining({ [TOOL_ID]: expect.any(Array) }),
      expect.any(Object)
    );
  });

  it('physically writes back the cleaned three-day window when history is loaded', async () => {
    apiMocks.getProfileSetting.mockResolvedValue({
      setting: {
        value: {
          [TOOL_ID]: [
            historyEntry(),
            historyEntry({
              id: 'expired-history',
              createdAt: new Date(NOW_MS - SMART_TOOL_IMAGE_HISTORY_RETENTION_MS - 1).toISOString(),
            }),
          ],
        },
      },
    });

    const loaded = await loadSmartToolImageGenerationHistory({ nowMs: NOW_MS });

    expect(loaded[TOOL_ID].map((entry) => entry.id)).toEqual(['history-1']);
    expect(apiMocks.saveProfileSetting).toHaveBeenCalledWith(
      SMART_TOOL_IMAGE_HISTORY_NAMESPACE,
      expect.objectContaining({
        [TOOL_ID]: [expect.objectContaining({ id: 'history-1' })],
      }),
      expect.any(Object)
    );
  });
});
