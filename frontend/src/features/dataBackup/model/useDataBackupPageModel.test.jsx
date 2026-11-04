import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllDataBackupPreviews: vi.fn(),
  getDataBackupHistory: vi.fn(),
  getDataBackupImportHistory: vi.fn(),
  getDataBackupOwnerHistory: vi.fn(),
  getDataBackupOwnerImportHistory: vi.fn(),
  exportDataBackup: vi.fn(),
  exportDataBackupBatch: vi.fn(),
}));

vi.mock('../services/dataBackupClient.js', () => ({
  getAllDataBackupPreviews: mocks.getAllDataBackupPreviews,
  getDataBackupHistory: mocks.getDataBackupHistory,
  getDataBackupImportHistory: mocks.getDataBackupImportHistory,
  getDataBackupOwnerHistory: mocks.getDataBackupOwnerHistory,
  getDataBackupOwnerImportHistory: mocks.getDataBackupOwnerImportHistory,
}));
vi.mock('../services/dataBackupDesktopClient.js', () => ({
  exportDataBackup: mocks.exportDataBackup,
  exportDataBackupBatch: mocks.exportDataBackupBatch,
}));

import { useDataBackupPageModel } from './useDataBackupPageModel.js';

afterEach(() => vi.clearAllMocks());

describe('useDataBackupPageModel', () => {
  it('maps a saved Ozon client id to the local shop id required by backup and historical import routes', async () => {
    mocks.getAllDataBackupPreviews.mockResolvedValue({
      owners: [{
        owner: { ownerType: 'ozon_shop', ownerId: 'ozon-shop-local-a' },
        ownerType: 'ozon_shop',
        ownerId: 'ozon-shop-local-a',
        ownerTypeLabel: 'Ozon 店铺',
        ownerKey: JSON.stringify(['ozon_shop', 'ozon-shop-local-a']),
        shopId: 'ozon-shop-local-a',
        displayName: '主店',
        domains: [],
        totalRecords: 0,
        dataFingerprint: 'fingerprint-local-a',
      }],
      shops: [{
        shopId: 'ozon-shop-local-a',
        shopExternalId: '4067587',
        displayName: '主店',
        domains: [],
        totalRecords: 0,
        dataFingerprint: 'fingerprint-local-a',
      }],
    });
    mocks.getDataBackupHistory.mockResolvedValue([]);
    mocks.getDataBackupImportHistory.mockResolvedValue([]);

    const { result } = renderHook(() => useDataBackupPageModel({
      shops: [{ id: '4067587', clientId: '4067587', alias: '主店' }],
      activeShopId: '4067587',
    }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.shopId).toBe('ozon-shop-local-a');
    expect(result.current.shopOptions).toEqual([expect.objectContaining({
      shopId: 'ozon-shop-local-a',
      shopExternalId: '4067587',
    })]);
  });

  it('keeps preview and export available when one history source fails', async () => {
    mocks.getAllDataBackupPreviews.mockResolvedValue({
      owners: [{
        owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' },
        ownerType: 'ozon_shop',
        ownerId: 'shop-a',
        ownerTypeLabel: 'Ozon 店铺',
        ownerKey: JSON.stringify(['ozon_shop', 'shop-a']),
        shopId: 'shop-a',
        displayName: '主店',
        domains: [{
          domain: 'shops',
          label: '店铺资料',
          recordCount: 1,
          logicalBytes: 128,
          requiredForRestore: true,
        }],
        totalRecords: 1,
        dataFingerprint: 'fingerprint-shop-a',
      }],
      shops: [{
        shopId: 'shop-a',
        displayName: '主店',
        domains: [{
          domain: 'shops',
          label: '店铺资料',
          recordCount: 1,
          logicalBytes: 128,
          requiredForRestore: true,
        }],
        totalRecords: 1,
        dataFingerprint: 'fingerprint-shop-a',
      }],
    });
    mocks.getDataBackupHistory.mockResolvedValue([{ id: 'backup-1' }]);
    mocks.getDataBackupImportHistory.mockRejectedValue(new Error('恢复历史不可用'));

    const { result } = renderHook(() => useDataBackupPageModel({
      shops: [{ id: 'shop-a', alias: '主店' }],
      activeShopId: 'shop-a',
    }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.selectedPreview?.shopId).toBe('shop-a');
    expect(result.current.history).toEqual([{ id: 'backup-1' }]);
    expect(result.current.canExport).toBe(true);
    expect(result.current.error).toBe('');
    expect(result.current.warning).toMatch(/记录暂时无法全部读取/u);
  });

  it('never reuses the previous shop fingerprint while a newly selected shop has no valid preview', async () => {
    mocks.getAllDataBackupPreviews
      .mockResolvedValueOnce({
        owners: [{
          owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' },
          ownerType: 'ozon_shop',
          ownerId: 'shop-a',
          ownerTypeLabel: 'Ozon 店铺',
          ownerKey: JSON.stringify(['ozon_shop', 'shop-a']),
          shopId: 'shop-a',
          displayName: '主店',
          domains: [],
          totalRecords: 0,
          dataFingerprint: 'fingerprint-shop-a',
        }],
        shops: [{
          shopId: 'shop-a',
          displayName: '主店',
          domains: [],
          totalRecords: 0,
          dataFingerprint: 'fingerprint-shop-a',
        }],
      })
      .mockRejectedValueOnce(new Error('副店预览不可用'));
    mocks.getDataBackupHistory.mockResolvedValue([]);
    mocks.getDataBackupImportHistory.mockResolvedValue([]);
    const shops = [{ id: 'shop-a', alias: '主店' }, { id: 'shop-b', alias: '副店' }];
    const { result } = renderHook(() => useDataBackupPageModel({ shops, activeShopId: 'shop-a' }));
    await waitFor(() => expect(result.current.selectedPreview?.shopId).toBe('shop-a'));

    act(() => result.current.selectBackupOwner(JSON.stringify(['ozon_shop', 'shop-b'])));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.selectedPreview).toBeNull();
    expect(result.current.canExport).toBe(false);
    act(() => result.current.requestExport());
    expect(mocks.exportDataBackup).not.toHaveBeenCalled();
    expect(result.current.exportMessage?.text).toMatch(/快照/u);
  });

  it('moves import and export scopes together when the application active shop changes', async () => {
    const previews = {
      owners: [
        {
          owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' },
          ownerType: 'ozon_shop', ownerId: 'shop-a', ownerTypeLabel: 'Ozon 店铺',
          ownerKey: JSON.stringify(['ozon_shop', 'shop-a']), shopId: 'shop-a', displayName: '主店',
          domains: [], totalRecords: 0, dataFingerprint: 'fingerprint-shop-a',
        },
        {
          owner: { ownerType: 'ozon_shop', ownerId: 'shop-b' },
          ownerType: 'ozon_shop', ownerId: 'shop-b', ownerTypeLabel: 'Ozon 店铺',
          ownerKey: JSON.stringify(['ozon_shop', 'shop-b']), shopId: 'shop-b', displayName: '副店',
          domains: [], totalRecords: 0, dataFingerprint: 'fingerprint-shop-b',
        },
      ],
      shops: [],
    };
    mocks.getAllDataBackupPreviews.mockResolvedValue(previews);
    mocks.getDataBackupHistory.mockResolvedValue([]);
    mocks.getDataBackupImportHistory.mockResolvedValue([]);
    const sourceShops = [{ id: 'shop-a', alias: '主店' }, { id: 'shop-b', alias: '副店' }];
    const { result, rerender } = renderHook(
      ({ activeShopId }) => useDataBackupPageModel({ shops: sourceShops, activeShopId }),
      { initialProps: { activeShopId: 'shop-a' } },
    );
    await waitFor(() => expect(result.current.selectedPreview?.shopId).toBe('shop-a'));

    rerender({ activeShopId: 'shop-b' });
    expect(result.current.shopId).toBe('shop-b');
    expect(result.current.backupOwnerKey).toBe(JSON.stringify(['ozon_shop', 'shop-b']));
    expect(result.current.canExport).toBe(false);
    await waitFor(() => expect(result.current.selectedPreview?.shopId).toBe('shop-b'));
  });
});
