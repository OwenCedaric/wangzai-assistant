import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commitSoftwareBackupImport,
  exportDataBackup,
  preflightSoftwareBackupImport,
} from './dataBackupDesktopClient.js';

afterEach(() => {
  delete window.wangzaiDesktop;
});

describe('dataBackupDesktopClient', () => {
  it('sends only the exact export command and returns a path-free verified summary', async () => {
    const command = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: {
        backupId: 'backup-1',
        verified: true,
        completedAt: '2026-07-17T09:00:00.000Z',
        recordCount: 21,
        logicalBytes: 2048,
        fileName: 'C:/private/user-selected-path/wangzai-backup.wzb',
        path: 'C:/private/user-selected-path/wangzai-backup.wzb',
        package: 'must-not-reach-renderer-callers',
      },
    }));
    window.wangzaiDesktop = { dataBackup: { command } };

    const result = await exportDataBackup({
      shopId: 'shop-a',
      expectedDataFingerprint: 'fingerprint-a',
      selectedDomains: ['shops', 'shop-credentials'],
    });

    expect(command).toHaveBeenCalledWith({
      command: 'export',
      owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' },
      expectedDataFingerprint: 'fingerprint-a',
      selectedDomains: ['shops', 'shop-credentials'],
    });
    expect(result).toMatchObject({
      canceled: false,
      verified: true,
      totalRecords: 21,
      fileName: 'wangzai-backup.wzb',
    });
    expect(result).not.toHaveProperty('path');
    expect(result).not.toHaveProperty('package');
  });

  it('preserves a non-Ozon owner scope for account-removal exports', async () => {
    const command = vi.fn(async () => ({
      ok: true,
      data: { backupId: 'backup-purchase', verified: true },
    }));
    window.wangzaiDesktop = { dataBackup: { command } };
    await exportDataBackup({
      owner: { ownerType: 'purchase_account', ownerId: 'purchase-a' },
      expectedDataFingerprint: 'fingerprint-purchase-a',
    });
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      owner: { ownerType: 'purchase_account', ownerId: 'purchase-a' },
    }));
  });

  it('treats cancellation separately and refuses an unverified file', async () => {
    const command = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, data: { canceled: true } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { backupId: 'unverified' } });
    window.wangzaiDesktop = { dataBackup: { command } };
    const input = {
      shopId: 'shop-a',
      expectedDataFingerprint: 'fingerprint-a',
    };
    await expect(exportDataBackup(input)).resolves.toEqual({ canceled: true });
    await expect(exportDataBackup(input)).rejects.toMatchObject({ code: 'DATA_BACKUP_EXPORT_NOT_VERIFIED' });
  });

  it('fails closed when opened outside the dedicated desktop bridge', async () => {
    await expect(exportDataBackup({
      shopId: 'shop-a',
      expectedDataFingerprint: 'fingerprint-a',
    })).rejects.toMatchObject({ code: 'DATA_BACKUP_DESKTOP_BRIDGE_REQUIRED' });
  });

  it('preflights and commits an import through the exact desktop commands without exposing file data', async () => {
    const command = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        data: {
          sessionId: 'session-a',
          previewFingerprint: 'preview-a',
          sourceShop: { shopId: 'old-shop', displayName: '原店铺' },
          targetShop: { shopId: 'shop-a', displayName: '当前店铺' },
          domains: [
            { domain: 'product-dimension-facts', label: 'product-dimension-facts', recordCount: 3 },
            { domain: 'unknown-private-domain', label: 'unknown-private-domain', recordCount: 1 },
          ],
          totalRecords: 4,
          summary: {
            incoming: 4,
            added: 1,
            updated: 2,
            preserved: 1,
            conflicts: 1,
            skipped: 0,
            failed: 0,
          },
          path: 'C:/private/backup.wzb',
          contentB64u: 'must-not-reach-renderer-caller',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          verified: true,
          totalRecords: 4,
          summary: { updated: 3, skipped: 1 },
        },
      });
    window.wangzaiDesktop = { dataBackup: { command } };

    const preview = await preflightSoftwareBackupImport({
      targetShopId: 'shop-a',
    });
    expect(command).toHaveBeenNthCalledWith(1, {
      command: 'preflight-import',
      targetShopId: 'shop-a',
      conflictMode: 'preserve',
    });
    expect(preview).toMatchObject({
      canceled: false,
      sessionId: 'session-a',
      previewFingerprint: 'preview-a',
      summary: {
        totalRecords: 4,
        incomingRecords: 4,
        newRecords: 1,
        updateRecords: 2,
        preservedRecords: 1,
        conflictRecords: 1,
      },
      domains: [
        { label: '商品长宽高信息' },
        { label: '其他用户数据' },
      ],
    });
    expect(preview).not.toHaveProperty('path');
    expect(preview).not.toHaveProperty('contentB64u');

    const result = await commitSoftwareBackupImport({
      sessionId: preview.sessionId,
      previewFingerprint: preview.previewFingerprint,
      targetShopId: 'shop-a',
    });
    expect(command).toHaveBeenNthCalledWith(2, {
      command: 'commit-import',
      sessionId: 'session-a',
      previewFingerprint: 'preview-a',
      targetShopId: 'shop-a',
      conflictMode: 'preserve',
    });
    expect(result).toMatchObject({
      importId: '',
      verified: true,
      summary: { totalRecords: 4, updateRecords: 3, skippedRecords: 1 },
    });
  });

  it('handles import cancellation separately and requires a preflight receipt before commit', async () => {
    const command = vi.fn().mockResolvedValue({ ok: true, data: { canceled: true } });
    window.wangzaiDesktop = { dataBackup: { command } };
    await expect(preflightSoftwareBackupImport()).resolves.toEqual({ canceled: true });
    await expect(commitSoftwareBackupImport({ targetShopId: 'shop-a' })).rejects.toMatchObject({
      code: 'DATA_BACKUP_IMPORT_PREFLIGHT_REQUIRED',
    });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('forwards a legacy passphrase only during old-package preflight', async () => {
    const command = vi.fn().mockResolvedValue({ ok: true, data: { canceled: true } });
    window.wangzaiDesktop = { dataBackup: { command } };
    await preflightSoftwareBackupImport({
      targetShopId: 'shop-a',
      legacyPassphrase: 'legacy-backup-passphrase',
    });
    expect(command).toHaveBeenCalledWith({
      command: 'preflight-import',
      targetShopId: 'shop-a',
      conflictMode: 'preserve',
      passphrase: 'legacy-backup-passphrase',
    });
  });
});
