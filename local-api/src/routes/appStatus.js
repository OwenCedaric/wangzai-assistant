import { getStorageUsage } from '../utils/storageUsage.js';

export function createAppStatusPayload({
  config,
  getDatabaseStatus,
  listAppliedMigrations,
  startedAt,
  migrationsApplied = [],
}) {
  const now = new Date();
  const started = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const databaseStatus = getDatabaseStatus();
  const appliedMigrations = listAppliedMigrations();

  return {
    ok: true,
    service: {
      name: 'wangzai-local-api',
      version: '0.1.0',
      status: 'running',
      pid: process.pid,
      nodeVersion: process.version,
      startedAt: started.toISOString(),
      uptimeSeconds: Math.max(0, Math.round((now.getTime() - started.getTime()) / 1000)),
    },
    server: {
      host: config.server.host,
      port: config.server.port,
      baseUrl: `http://${config.server.host}:${config.server.port}`,
      healthPath: '/health',
      statusPath: '/api/app/status',
    },
    sqlite: databaseStatus,
    storage: getStorageUsage(config),
    migrations: {
      ok: true,
      appliedCount: appliedMigrations.length,
      applied: appliedMigrations,
      appliedThisStart: migrationsApplied,
    },
    runtime: {
      businessModulesConnected: true,
      ozonConnected: true,
      realOzonWriteEnabled: config?.ozon?.enableRealWrite === true,
      realOzonWriteAllowlistRequired: false,
      note:
        config?.ozon?.enableRealWrite === true
          ? '真实 Ozon 读取已开放；写入按店铺授权、已登记执行器、preview、confirm、写后回读和 audit 执行，不再要求任何额外配置。'
          : '真实 Ozon 读取已开放，写入总开关未开启：需要启用 ozon.enableRealWrite 或 LOCAL_API_ENABLE_REAL_OZON_WRITE=1。',
    },
  };
}
