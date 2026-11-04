import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestProfileCacheMaintenanceRestart } from './profileCacheMaintenanceDesktopClient.js';

afterEach(() => {
  delete globalThis.window.wangzaiDesktop;
});

describe('profileCacheMaintenanceDesktopClient', () => {
  it('uses only the dedicated desktop bridge and accepts a scheduled restart', async () => {
    const requestProfileCacheMaintenance = vi.fn(async () => ({
      ok: true,
      scheduled: true,
    }));
    globalThis.window.wangzaiDesktop = { requestProfileCacheMaintenance };
    await expect(requestProfileCacheMaintenanceRestart()).resolves.toEqual({
      ok: true,
      scheduled: true,
    });
    expect(requestProfileCacheMaintenance).toHaveBeenCalledTimes(1);
    expect(requestProfileCacheMaintenance).toHaveBeenCalledWith();
  });

  it('fails closed when the desktop bridge is unavailable', async () => {
    await expect(requestProfileCacheMaintenanceRestart()).rejects.toMatchObject({
      code: 'PROFILE_CACHE_MAINTENANCE_DESKTOP_BRIDGE_UNAVAILABLE',
    });
  });

  it('preserves a desktop fence code such as pending account deletion', async () => {
    globalThis.window.wangzaiDesktop = {
      requestProfileCacheMaintenance: vi.fn(async () => ({
        ok: false,
        code: 'ACCOUNT_REMOVAL_PENDING',
        error: '存在尚未完成的账号永久删除。',
      })),
    };
    await expect(requestProfileCacheMaintenanceRestart()).rejects.toMatchObject({
      code: 'ACCOUNT_REMOVAL_PENDING',
      message: '存在尚未完成的账号永久删除。',
    });
  });
});
