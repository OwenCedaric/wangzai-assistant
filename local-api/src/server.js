import { createApp } from './app/createApp.js'; import { createProtectedComputeRuntimeFromConfig } from './domain/protectedCompute/protectedComputeRuntime.js';
import { loadConfig } from './config/loadConfig.js';
import { getDatabaseStatus, initializeDatabase, listAppliedMigrations } from './db/database.js';
import { createShopDatabaseManager } from './db/shopDatabaseManager.js'; import { createShopAggregateIndex } from './db/shopAggregateIndex.js'; import { createShopDatabaseLifecycle } from './db/shopDatabaseLifecycle.js';
import './config/loadLocalEnvironment.js';
import { createAliyunOssProductImageStorageFromEnvironment } from './domain/productImages/aliyunOssProductImageStorage.js';
import { createShopLicenseGrantRegistry } from './domain/licensing/shopLicenseGrantRegistry.js';
import { createOzonClient } from './ozon/ozonClient.js';

const startedAt = new Date();
const config = loadConfig();
const productImageObjectStorage = createAliyunOssProductImageStorageFromEnvironment();
const shopLicenseGrantRegistry = createShopLicenseGrantRegistry({
  enforce: process.env.LOCAL_API_SHOP_LICENSE_ENFORCE === '1',
});
const ozonClient = createOzonClient({
  authorizeClientId: (clientId) => shopLicenseGrantRegistry.assertActive(clientId),
});
const { db, migrationsApplied, status: databaseStatus } = initializeDatabase(config);
const shopDatabaseManager = createShopDatabaseManager({ root: config.database.shopRoot,
  profileId: config.runtime.profileId || 'default',
  enableWal: config.database.enableWal,
  busyTimeoutMs: config.database.busyTimeoutMs,
});
const shopAggregateIndex = createShopAggregateIndex({ databasePath: config.database.aggregateIndexPath, profileId: config.runtime.profileId || 'default', busyTimeoutMs: config.database.busyTimeoutMs }); const shopDatabaseLifecycle = createShopDatabaseLifecycle({ shopDatabaseManager, shopAggregateIndex, backupRoot: config.database.shopBackupRoot }); let shutdownRequested = false;

function shutdown(signal) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  console.log(`${signal} received, closing local-api...`);
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
}

const server = createApp({
  db,
  config,
  getDatabaseStatus: () => getDatabaseStatus(db, config),
  listAppliedMigrations: () => listAppliedMigrations(db),
  startedAt,
  migrationsApplied, sharedCatalogBootstrap: { enabled: true }, protectedComputeRuntime: createProtectedComputeRuntimeFromConfig(config.protectedCompute),
  automaticMaintenanceEnabled: process.env.LOCAL_API_AUTO_MAINTENANCE !== '0',
  productImageObjectStorage,
  shopLicenseGrantRegistry,
  ozonClient,
  shopDatabaseManager,
  shopAggregateIndex,
  shopDatabaseLifecycle,
  requestShutdown: () => shutdown("desktop shutdown request"),
});

function closeDatabase() {
  shopDatabaseManager.closeAll();
  shopAggregateIndex.close();
  try {
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
  } catch {
    // 退出时 checkpoint 失败不阻塞 close；下次 SQLite 打开仍会恢复 WAL。
  }
  db.close();
}

server.on('error', async (error) => {
  if (error?.code === 'EADDRINUSE') {
    const baseUrl = `http://${config.server.host}:${config.server.port}`;
    console.error(
      JSON.stringify(
        {
          ok: false,
          code: 'LOCAL_API_PORT_IN_USE',
          message: `local-api 端口已被占用：${baseUrl}`,
          hint: '如果这是已启动的 local-api，请直接复用；否则先结束占用 3790 的进程，或设置 LOCAL_API_PORT 使用其他端口。',
          check: `${baseUrl}/health`,
        },
        null,
        2,
      ),
    );
  } else {
    console.error(error);
  }
  closeDatabase();
  process.exit(1);
});

server.listen(config.server.port, config.server.host, () => {
  console.log(
    JSON.stringify(
      {
        ok: true,
        service: 'wangzai-local-api',
        url: `http://${config.server.host}:${config.server.port}`,
        health: `http://${config.server.host}:${config.server.port}/health`,
        status: `http://${config.server.host}:${config.server.port}/api/app/status`,
        sqlite: {
          path: config.database.path,
          journalMode: databaseStatus.journalMode,
          userVersion: databaseStatus.userVersion,
        },
      },
      null,
      2,
    ),
  );
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
