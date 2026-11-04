import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  preflightSoftwareBackupImport: vi.fn(),
  commitSoftwareBackupImport: vi.fn(),
}));

vi.mock('../services/dataBackupDesktopClient.js', () => mocks);

import { useSoftwareBackupRestore } from './useSoftwareBackupRestore.js';

afterEach(() => vi.clearAllMocks());

describe('useSoftwareBackupRestore', () => {
  it('keeps an unsafe multi-database restore blocked and never calls commit', async () => {
    mocks.preflightSoftwareBackupImport.mockResolvedValue({
      sessionId: 'unsafe-session', previewFingerprint: 'unsafe-preview',
      restoreSafety: { writeAllowed: false, errorCode: 'DATA_BACKUP_IMPORT_SAFE_RESTORE_REQUIRED' },
    });
    const { result } = renderHook(() => useSoftwareBackupRestore());
    await act(async () => result.current.runPreflight());
    expect(result.current.status).toBe('blocked');
    expect(result.current.canCommit).toBe(false);
    expect(result.current.message.text).toContain('尚未写入数据');
    await act(async () => result.current.runCommit());
    expect(mocks.commitSoftwareBackupImport).not.toHaveBeenCalled();
  });
  it('preflights, invalidates stale mappings, and commits only a verified restore', async () => {
    mocks.preflightSoftwareBackupImport.mockResolvedValue({
      canceled: false,
      sessionId: 'session-a',
      importId: 'import-a',
      previewFingerprint: 'fingerprint-a',
      summary: { totalRecords: 3 },
    });
    mocks.commitSoftwareBackupImport.mockResolvedValue({
      importId: 'import-a',
      verified: true,
      summary: { totalRecords: 3 },
    });
    const onCompleted = vi.fn();
    const shops = [
      { shopId: 'shop-a', displayName: '主店' },
      { shopId: 'shop-b', displayName: '副店' },
    ];
    const { result } = renderHook(() => useSoftwareBackupRestore({
      shopOptions: shops,
      defaultShopId: 'shop-a',
      onCompleted,
    }));

    expect(result.current.canPreflight).toBe(true);
    await act(async () => result.current.runPreflight());
    expect(mocks.preflightSoftwareBackupImport).toHaveBeenCalledWith({
      targetShopId: 'shop-a',
      conflictMode: 'preserve',
    });
    expect(result.current.canCommit).toBe(true);

    act(() => result.current.selectTargetShop('shop-b'));
    expect(result.current.preview).toBeNull();
    expect(result.current.canCommit).toBe(false);

    await act(async () => result.current.runPreflight());
    await act(async () => result.current.runCommit());
    expect(mocks.commitSoftwareBackupImport).toHaveBeenCalledWith({
      sessionId: 'session-a',
      importId: 'import-a',
      previewFingerprint: 'fingerprint-a',
      targetShopId: 'shop-b',
      conflictMode: 'preserve',
    });
    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
    expect(result.current.status).toBe('completed');
  });

  it('does not claim completion when the bridge cancels or omits verified readback', async () => {
    mocks.preflightSoftwareBackupImport
      .mockResolvedValueOnce({ canceled: true })
      .mockResolvedValueOnce({
        canceled: false,
        sessionId: 'session-a',
        importId: 'import-a',
        previewFingerprint: 'fingerprint-a',
      });
    mocks.commitSoftwareBackupImport.mockResolvedValue({ importId: 'import-a', verified: false });
    const { result } = renderHook(() => useSoftwareBackupRestore({
      shopOptions: [{ shopId: 'shop-a', displayName: '主店' }],
      defaultShopId: 'shop-a',
    }));
    await act(async () => result.current.runPreflight());
    expect(result.current.preview).toBeNull();
    expect(result.current.message?.text).toMatch(/已取消/u);

    await act(async () => result.current.runPreflight());
    await act(async () => result.current.runCommit());
    expect(result.current.status).toBe('error');
    expect(result.current.message?.text).toMatch(/未通过数据回读/u);
  });

  it('allows a non-Ozon backup to be selected without a rebound Ozon shop', async () => {
    mocks.preflightSoftwareBackupImport.mockResolvedValue({
      canceled: false,
      sessionId: 'session-account',
      importId: 'import-account',
      previewFingerprint: 'fingerprint-account',
      sourceOwner: {
        ownerType: 'purchase_account',
        ownerId: 'purchase-a',
        displayName: '1688 主账号',
      },
      targetOwner: {
        ownerType: 'purchase_account',
        ownerId: 'purchase-a',
        displayName: '1688 主账号',
      },
    });
    mocks.commitSoftwareBackupImport.mockResolvedValue({
      importId: 'import-account',
      verified: true,
    });
    const { result } = renderHook(() => useSoftwareBackupRestore({ shopOptions: [] }));

    expect(result.current.canPreflight).toBe(true);

    await act(async () => result.current.runPreflight());
    expect(mocks.preflightSoftwareBackupImport).toHaveBeenCalledWith({
      targetShopId: '',
      conflictMode: 'preserve',
    });
    expect(result.current.canCommit).toBe(true);
    await act(async () => result.current.runCommit());

    expect(mocks.commitSoftwareBackupImport).toHaveBeenCalledWith({
      sessionId: 'session-account',
      importId: 'import-account',
      previewFingerprint: 'fingerprint-account',
      targetShopId: '',
      conflictMode: 'preserve',
    });
    expect(result.current.status).toBe('completed');
  });

  it('asks for a legacy password only after an old encrypted package is detected', async () => {
    const required = Object.assign(new Error('legacy password required'), {
      code: 'DATA_BACKUP_LEGACY_PASSPHRASE_REQUIRED',
    });
    mocks.preflightSoftwareBackupImport
      .mockRejectedValueOnce(required)
      .mockResolvedValueOnce({
        canceled: false,
        sessionId: 'legacy-session',
        importId: 'legacy-import',
        previewFingerprint: 'legacy-fingerprint',
      });
    const { result } = renderHook(() => useSoftwareBackupRestore({
      shopOptions: [{ shopId: 'shop-a', displayName: '主店' }],
      defaultShopId: 'shop-a',
    }));

    await act(async () => result.current.runPreflight());
    expect(result.current.legacyPassphraseRequired).toBe(true);
    expect(result.current.canPreflight).toBe(false);
    expect(result.current.message?.text).toMatch(/旧版加密备份/u);

    act(() => result.current.setLegacyPassphrase('legacy-backup-passphrase'));
    expect(result.current.canPreflight).toBe(true);
    await act(async () => result.current.runPreflight());
    expect(mocks.preflightSoftwareBackupImport).toHaveBeenLastCalledWith({
      targetShopId: 'shop-a',
      conflictMode: 'preserve',
      legacyPassphrase: 'legacy-backup-passphrase',
    });
    expect(result.current.legacyPassphraseRequired).toBe(false);
    expect(result.current.legacyPassphrase).toBe('');
    expect(result.current.canCommit).toBe(true);
  });
});
