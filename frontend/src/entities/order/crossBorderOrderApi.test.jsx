import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readCrossBorderEndpoint: vi.fn(),
  readCrossBorderRecords: vi.fn(),
  saveCrossBorderRecords: vi.fn(),
  previewCrossBorderWriteOperation: vi.fn(),
  confirmCrossBorderWriteOperation: vi.fn(),
}));

vi.mock('../../services/crossBorderOrderRecordClient', () => ({
  readCrossBorderRecords: mocks.readCrossBorderRecords,
  saveCrossBorderRecords: mocks.saveCrossBorderRecords,
}));

vi.mock('../../services/crossBorderReadClient', () => ({
  readCrossBorderEndpoint: mocks.readCrossBorderEndpoint,
}));

vi.mock('../../services/crossBorderWriteClient', () => ({
  previewCrossBorderWriteOperation: mocks.previewCrossBorderWriteOperation,
  confirmCrossBorderWriteOperation: mocks.confirmCrossBorderWriteOperation,
}));

vi.mock('../../services/externalInterfaceRegistry', () => ({
  assertExternalInterfaceAllowed: vi.fn(),
}));

import {
  requestCrossBorderOrderSearch,
  requestProtectedCrossBorderOrderOperation,
} from './crossBorderOrderApi.jsx';

describe('requestCrossBorderOrderSearch local-first behavior', () => {
  beforeEach(() => {
    mocks.readCrossBorderEndpoint.mockReset();
    mocks.readCrossBorderRecords.mockReset();
    mocks.saveCrossBorderRecords.mockReset();
    mocks.previewCrossBorderWriteOperation.mockReset();
    mocks.confirmCrossBorderWriteOperation.mockReset();
  });

  it('gives the protected write preview and confirm enough time for a real forecast', async () => {
    mocks.previewCrossBorderWriteOperation.mockResolvedValue({ ok: true, previewId: 'preview-1' });
    mocks.confirmCrossBorderWriteOperation.mockResolvedValue({
      ok: true,
      data: { orderId: 'bus-order-1' },
    });

    await expect(
      requestProtectedCrossBorderOrderOperation(
        'createOrder',
        { accountId: 'cross-border-account' },
        { order_number: 'posting-forecast-1' },
        { confirmed: true, shopId: 'shop-1', shopClientId: 'client-1' }
      )
    ).resolves.toEqual({ orderId: 'bus-order-1' });

    expect(mocks.previewCrossBorderWriteOperation).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'createOrder', shopId: 'shop-1' }),
      { timeoutMs: 30_000 }
    );
    expect(mocks.confirmCrossBorderWriteOperation).toHaveBeenCalledWith(
      expect.objectContaining({ previewId: 'preview-1', confirm: true }),
      { timeoutMs: 120_000 }
    );
  });

  it('returns a normalized local match before requiring sectionId', async () => {
    mocks.readCrossBorderRecords.mockResolvedValue({
      rows: [
        {
          shopId: 'shop-internal-1',
          shopClientId: 'shop-client-1',
          orderId: '49531424',
          orderNumber: '06477778-0475-1',
          packageWeight: 0.156,
        },
      ],
      total: 1,
    });

    const result = await requestCrossBorderOrderSearch(
      {},
      { order_number: [' 06477778-0475-1 ', 'ignored'], section_code: '' },
      { shopId: 'shop-internal-1', shopClientId: 'shop-client-1' }
    );

    expect(result).toMatchObject({
      source: 'local-order-records',
      total: 1,
      items: [
        {
          order_id: '49531424',
          order_number: '06477778-0475-1',
          _localRecord: true,
        },
      ],
    });
    expect(mocks.readCrossBorderEndpoint).not.toHaveBeenCalled();
  });

  it('requires sectionId after the normalized local lookup misses', async () => {
    mocks.readCrossBorderRecords.mockResolvedValue({ rows: [], total: 0 });
    await expect(
      requestCrossBorderOrderSearch(
        {},
        { order_number: [' 06477778-0475-1 '] },
        { shopId: 'shop-internal-1', shopClientId: 'shop-client-1' },
      )
    ).rejects.toThrow('缺少跨境巴士仓库或平台设置');

    expect(mocks.readCrossBorderRecords).toHaveBeenCalled();
    expect(mocks.readCrossBorderEndpoint).not.toHaveBeenCalled();
  });

  it('isolates identical posting numbers by internal shopId', async () => {
    mocks.readCrossBorderRecords.mockResolvedValue({
      rows: [
        {
          shopId: 'ozon-shop-a',
          shopClientId: 'client-a',
          orderId: 'bus-order-a',
          orderNumber: '06477778-0475-1',
        },
        {
          shopId: 'ozon-shop-b',
          shopClientId: 'client-b',
          orderId: 'bus-order-b',
          orderNumber: '06477778-0475-1',
        },
      ],
      total: 2,
    });

    const result = await requestCrossBorderOrderSearch(
      {},
      { order_number: '06477778-0475-1' },
      { shopId: 'ozon-shop-a', shopClientId: 'client-a' }
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].order_id).toBe('bus-order-a');
    expect(mocks.readCrossBorderRecords).toHaveBeenCalledWith({
      shopId: 'ozon-shop-a',
      page: 1,
      pageSize: 1000,
    });
    expect(mocks.readCrossBorderEndpoint).not.toHaveBeenCalled();
  });

  it('does not trust a different shopId when only the legacy clientId argument is available', async () => {
    mocks.readCrossBorderRecords.mockResolvedValue({
      rows: [{ shopId: 'ozon-shop-b', orderId: 'bus-order-b', orderNumber: '06477778-0475-1' }],
      total: 1,
    });

    await expect(
      requestCrossBorderOrderSearch({}, { order_number: '06477778-0475-1' }, 'client-a')
    ).rejects.toThrow('缺少跨境巴士仓库或平台设置');

    expect(mocks.readCrossBorderEndpoint).not.toHaveBeenCalled();
  });

  it('rejects an old internal shop after rebinding the same clientId', async () => {
    mocks.readCrossBorderRecords.mockResolvedValue({
      rows: [
        {
          shopId: 'ozon-shop-old',
          shopClientId: 'client-rebound',
          orderId: 'bus-order-old',
          orderNumber: '06477778-0475-1',
        },
      ],
      total: 1,
    });

    await expect(
      requestCrossBorderOrderSearch({}, { order_number: '06477778-0475-1' }, 'client-rebound')
    ).rejects.toThrow('缺少跨境巴士仓库或平台设置');

    expect(mocks.readCrossBorderEndpoint).not.toHaveBeenCalled();
  });

  it('keeps the verified owner scope when a local miss falls back to remote and caches the result', async () => {
    mocks.readCrossBorderRecords
      .mockResolvedValueOnce({ rows: [], total: 0 })
      .mockResolvedValueOnce({ rows: [], total: 0 });
    mocks.readCrossBorderEndpoint.mockResolvedValue({
      data: {
        list: [{ id: 'bus-order-remote', order_number: '06477778-0475-1' }],
        total: 1,
      },
    });
    mocks.saveCrossBorderRecords.mockResolvedValue({ ok: true });
    const result = await requestCrossBorderOrderSearch(
      { accountId: 'cross-border-account', sectionId: 'section-a' },
      { order_number: '06477778-0475-1' },
      { shopId: 'ozon-shop-current', shopClientId: 'client-current' }
    );

    expect(result.items).toEqual([
      expect.objectContaining({ id: 'bus-order-remote', order_number: '06477778-0475-1' }),
    ]);
    expect(mocks.readCrossBorderEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'cross-border-account',
        shopId: 'ozon-shop-current',
      }),
      expect.any(Object),
    );
    await vi.waitFor(() => {
      expect(mocks.saveCrossBorderRecords).toHaveBeenCalledWith(
        result.items,
        expect.objectContaining({
          shopId: 'ozon-shop-current',
          shopClientId: 'client-current',
        })
      );
    });
  });
});
