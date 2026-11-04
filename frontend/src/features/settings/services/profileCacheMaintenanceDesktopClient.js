export async function requestProfileCacheMaintenanceRestart() {
  const request = globalThis.window?.wangzaiDesktop
    ?.requestProfileCacheMaintenance;
  if (typeof request !== 'function') {
    const error = new Error('当前环境没有桌面端普通清缓存维护入口。');
    error.code = 'PROFILE_CACHE_MAINTENANCE_DESKTOP_BRIDGE_UNAVAILABLE';
    throw error;
  }
  const result = await request();
  if (!result?.ok || result?.scheduled !== true) {
    const error = new Error(
      String(result?.error || '无法重启到普通清缓存维护模式。'),
    );
    error.code = String(
      result?.code || 'PROFILE_CACHE_MAINTENANCE_RESTART_REJECTED',
    );
    error.payload = result || null;
    throw error;
  }
  return result;
}
