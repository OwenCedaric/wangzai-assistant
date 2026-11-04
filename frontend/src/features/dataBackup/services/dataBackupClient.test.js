import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestLocalApi = vi.hoisted(() => vi.fn());

vi.mock('../../../api/localApiClient.js', () => ({ requestLocalApi }));

import {
  getAllDataBackupPreviews,
  getDataBackupHistory,
  getDataBackupImportHistory,
} from './dataBackupClient.js';

describe('dataBackupClient', () => {
  beforeEach(() => requestLocalApi.mockReset());

  it('reads the canonical all-owner preview and encoded shop history routes', async () => {
    requestLocalApi
      .mockResolvedValueOnce({
        ok: true,
        shops: [{
          shopId: '店铺/a',
          displayName: '主店',
          domains: [{ domain: 'manual-facts', label: '人工资料', recordCount: 3, logicalBytes: 512 }],
          totalRecords: 3,
          dataFingerprint: 'fingerprint-a',
        }],
      })
      .mockResolvedValueOnce({
        ok: true,
        backups: [{
          backupId: 'backup-a',
          verified: true,
          completedAt: '2026-07-17T08:00:00.000Z',
          suggestedFileName: '旺崽数据备份-a1b2c3d4e5f6.wzb',
          path: 'C:/must-not-reach-the-view',
        }],
      });

    await expect(getAllDataBackupPreviews()).resolves.toMatchObject({
      shops: [{
        shopId: '店铺/a',
        totalRecords: 3,
        dataFingerprint: 'fingerprint-a',
        domains: [{ domain: 'manual-facts', label: '其他用户数据' }],
      }],
    });
    const history = await getDataBackupHistory('店铺/a');
    expect(history).toEqual([expect.objectContaining({
      id: 'backup-a',
      verified: true,
      fileName: '旺崽数据备份-a1b2c3d4e5f6.wzb',
    })]);
    expect(history[0]).not.toHaveProperty('path');
    expect(requestLocalApi.mock.calls.map(([path]) => path)).toEqual([
      '/api/app/data-backup-preview',
      '/api/app/data-backup-history?shopId=%E5%BA%97%E9%93%BA%2Fa',
    ]);
    expect(requestLocalApi.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });

  it('fails closed when the local service does not return an explicit success', async () => {
    requestLocalApi.mockResolvedValue({ ok: false, error: { code: 'NO_PREVIEW', message: '预览不可用' } });
    await expect(getAllDataBackupPreviews()).rejects.toMatchObject({
      code: 'NO_PREVIEW',
      message: '预览不可用',
    });
  });

  it('normalizes software restore history as a visible backup-import operation', async () => {
    requestLocalApi.mockResolvedValue({
      ok: true,
      imports: [{
        importId: 'restore-a',
        status: 'completed',
        verified: true,
        completedAt: '2026-07-28T08:00:00.000Z',
        totalRecords: 7,
      }],
    });
    await expect(getDataBackupImportHistory('shop-a')).resolves.toEqual([
      expect.objectContaining({
        id: 'restore-a',
        operationType: 'backup-import',
        verified: true,
        totalRecords: 7,
      }),
    ]);
    expect(requestLocalApi.mock.calls[0][0]).toBe('/api/app/data-backup-import-history?shopId=shop-a');
  });
});
