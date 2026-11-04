import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const localApiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const defaultConfigPath = resolve(localApiRoot, 'config', 'local-api.config.json');

function readJsonFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`local-api 配置文件不存在: ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
}

function resolveMaybeRelativePath(value) {
  if (!value) {
    return resolve(localApiRoot, 'data', 'wangzai-local-api.development.sqlite');
  }
  return isAbsolute(value) ? value : resolve(localApiRoot, value);
}

function resolveOptionalPath(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return isAbsolute(normalized) ? normalized : resolve(localApiRoot, normalized);
}

function readOptionalSecretFile(value) {
  const filePath = resolveOptionalPath(value);
  if (!filePath) return '';
  if (!existsSync(filePath)) {
    throw new Error(`local-api 密钥文件不存在: ${filePath}`);
  }
  return readFileSync(filePath, 'utf8').trim();
}

function parseAllowedOrigins(value, fallback) {
  if (!value) {
    return fallback;
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseStringList(value, fallback = []) {
  const source = value === undefined || value === null || value === '' ? fallback : value;
  const values = Array.isArray(source) ? source : String(source).split(',');
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}


function parsePortList(value, fallback) {
  if (!value) {
    return fallback;
  }
  return value
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item));
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return Boolean(fallback);
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function loadConfig(configPath = process.env.LOCAL_API_CONFIG_PATH || defaultConfigPath) {
  const fileConfig = readJsonFile(configPath);
  const server = fileConfig.server || {};
  const database = fileConfig.database || {};
  const security = fileConfig.security || {};
  const storage = fileConfig.storage || {};
  const ozon = fileConfig.ozon || {};
  const imageAssets = fileConfig.imageAssets || {};
  const imageProvenance = fileConfig.imageProvenance || {};
  const databasePath = resolveMaybeRelativePath(process.env.LOCAL_API_DB_PATH || database.path);
  const shopDatabaseRoot = resolveOptionalPath(
    process.env.LOCAL_API_SHOP_DB_ROOT || database.shopRoot,
  ) || resolve(dirname(databasePath), 'shop-databases');
  const aggregateIndexPath = resolveOptionalPath(
    process.env.LOCAL_API_AGGREGATE_INDEX_PATH || database.aggregateIndexPath,
  ) || resolve(dirname(databasePath), 'shop-aggregate-index.sqlite');
  const sameDatabasePath = process.platform === 'win32'
    ? aggregateIndexPath.toLowerCase() === databasePath.toLowerCase()
    : aggregateIndexPath === databasePath;
  if (sameDatabasePath) {
    throw new Error('全店聚合索引必须使用独立 SQLite 文件，不能覆盖业务数据库');
  }
  const shopDatabaseBackupRoot = resolveOptionalPath(
    process.env.LOCAL_API_SHOP_DB_BACKUP_ROOT || database.shopBackupRoot,
  ) || resolve(dirname(databasePath), '..', 'backups', 'shop-databases');

  const portValue = Number.parseInt(process.env.LOCAL_API_PORT || server.port || '3790', 10);
  const protectedComputeEnvironment = {
    signedPublicConfigPath: resolveOptionalPath(
      process.env.LOCAL_API_PROTECTED_COMPUTE_SIGNED_CONFIG_PATH,
    ),
    configurationPublicKeyPath: resolveOptionalPath(
      process.env.LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_PATH,
    ),
    configurationKeyId: String(
      process.env.LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_ID || '',
    ).trim(),
    configurationKeySha256: String(
      process.env.LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_SHA256 || '',
    ).trim().toLowerCase(),
    versionStatePath: resolveOptionalPath(
      process.env.LOCAL_API_PROTECTED_COMPUTE_VERSION_STATE_PATH,
    ),
  };
  const protectedComputeValues = Object.values(protectedComputeEnvironment);
  if (
    protectedComputeValues.some(Boolean)
    && protectedComputeValues.some((value) => !value)
  ) {
    throw new Error(
      '受保护计算配置必须同时提供 signed config、公钥、key id、公钥指纹和持久版本状态路径',
    );
  }
  if (
    protectedComputeEnvironment.configurationKeyId
    && !/^[A-Za-z0-9._:-]{1,128}$/u.test(protectedComputeEnvironment.configurationKeyId)
  ) {
    throw new Error('受保护计算 configuration key id 格式无效');
  }
  if (
    protectedComputeEnvironment.configurationKeySha256
    && !/^[a-f0-9]{64}$/u.test(protectedComputeEnvironment.configurationKeySha256)
  ) {
    throw new Error('受保护计算 configuration key SHA-256 指纹格式无效');
  }

  return {
    root: localApiRoot,
    configPath,
    server: {
      host: process.env.LOCAL_API_HOST || server.host || '127.0.0.1',
      port: Number.isFinite(portValue) ? portValue : 3790,
    },
    database: {
      path: databasePath,
      sharedPath: databasePath,
      shopRoot: shopDatabaseRoot,
      aggregateIndexPath,
      shopBackupRoot: shopDatabaseBackupRoot,
      enableWal: database.enableWal !== false,
      busyTimeoutMs: Number.parseInt(database.busyTimeoutMs || '5000', 10),
    },
    security: {
      allowOrigins: parseAllowedOrigins(process.env.LOCAL_API_ALLOWED_ORIGINS, security.allowOrigins || []),
      allowLoopbackVitePorts: parsePortList(
        process.env.LOCAL_API_ALLOWED_VITE_PORTS,
        security.allowLoopbackVitePorts || [5173, 5188, 5191],
      ),
      logSecrets: security.logSecrets === true,
      authToken: String(process.env.LOCAL_API_AUTH_TOKEN || security.authToken || '').trim(),
      // Main-process-only capability for the built-in purchase browser.  It is
      // intentionally environment-only and never accepted from a config file.
      purchaseBrowserToken: String(process.env.LOCAL_API_PURCHASE_BROWSER_TOKEN || '').trim(),
      ozonPushSinkSecret: readOptionalSecretFile(
        process.env.LOCAL_API_OZON_PUSH_SINK_SECRET_FILE
          || process.env.LOCAL_API_SECRET_FILE,
      ),
    },
    storage: {
      profitLedgerDirectShopIds: parseStringList(process.env.LOCAL_API_PROFIT_LEDGER_DIRECT_SHOP_IDS, storage.profitLedgerDirectShopIds || []),
      warningBytes: Number.parseInt(
        process.env.LOCAL_API_STORAGE_WARNING_BYTES || storage.warningBytes || `${64 * 1024 * 1024}`,
        10,
      ),
      orderReadCanaryShopIds: parseStringList(
        process.env.LOCAL_API_ORDER_READ_CANARY_SHOP_IDS,
        storage.orderReadCanaryShopIds || [],
      ),
      orderReadAllReadyShops: parseBooleanFlag(
        process.env.LOCAL_API_ORDER_READ_ALL_READY_SHOPS,
        storage.orderReadAllReadyShops === true,
      ),
      orderDirectWriteAllShops: parseBooleanFlag(
        process.env.LOCAL_API_ORDER_DIRECT_WRITE_ALL_SHOPS,
        storage.orderDirectWriteAllShops === true,
      ),
      operationalDirectWriteAllShops: parseBooleanFlag(
        process.env.LOCAL_API_OPERATIONAL_DIRECT_WRITE_ALL_SHOPS,
        storage.operationalDirectWriteAllShops === true,
      ),
      productReadCanaryShopIds: parseStringList(
        process.env.LOCAL_API_PRODUCT_READ_CANARY_SHOP_IDS,
        storage.productReadCanaryShopIds || [],
      ),
      productDirectWriteShopIds: parseStringList(
        process.env.LOCAL_API_PRODUCT_DIRECT_WRITE_SHOP_IDS,
        storage.productDirectWriteShopIds || [],
      ),
      productDirectWriteAllShops: parseBooleanFlag(
        process.env.LOCAL_API_PRODUCT_DIRECT_WRITE_ALL_SHOPS,
        storage.productDirectWriteAllShops === true,
      ),
    },
    ozon: {
      enableRealWrite: parseBooleanFlag(process.env.LOCAL_API_ENABLE_REAL_OZON_WRITE, ozon.enableRealWrite === true),
    },
    sync: {
      defaultStatus: fileConfig.sync?.defaultStatus || 'idle',
      // Desktop data pages are local-read-only. Keep the scheduler running by
      // default so bound shops refresh in the background rather than forcing a
      // foreground page read to become the first Ozon request. An operator can
      // still explicitly disable it with config or LOCAL_API_CONTINUOUS_SYNC=false.
      continuousEnabled: parseBooleanFlag(
        process.env.LOCAL_API_CONTINUOUS_SYNC,
        fileConfig.sync?.continuousEnabled !== false,
      ),
      continuousIntervalMs: Number.parseInt(process.env.LOCAL_API_CONTINUOUS_SYNC_INTERVAL_MS || fileConfig.sync?.continuousIntervalMs || '300000', 10),
    },
    imageAssets: {
      publicBaseUrl: String(
        process.env.LOCAL_API_PUBLIC_ASSET_BASE_URL || imageAssets.publicBaseUrl || '',
      ).trim().replace(/\/$/u, ''),
      signingSecret: String(
        process.env.LOCAL_API_PUBLIC_ASSET_SIGNING_SECRET || '',
      ).trim(),
      previewUrlTtlSeconds: Number.parseInt(process.env.ALIYUN_OSS_PREVIEW_URL_TTL_SECONDS || imageAssets.previewUrlTtlSeconds || '900', 10),
      ozonUrlTtlSeconds: Number.parseInt(process.env.ALIYUN_OSS_OZON_URL_TTL_SECONDS || imageAssets.ozonUrlTtlSeconds || '86400', 10),
      temporaryRetentionSeconds: Number.parseInt(process.env.PRODUCT_IMAGE_TEMPORARY_RETENTION_SECONDS || imageAssets.temporaryRetentionSeconds || `${7 * 24 * 60 * 60}`, 10),
      lifecycle: {
        enabled: parseBooleanFlag(process.env.PRODUCT_IMAGE_LIFECYCLE_ENABLED, imageAssets.lifecycle?.enabled !== false),
        startupDelayMs: Number.parseInt(process.env.PRODUCT_IMAGE_LIFECYCLE_STARTUP_DELAY_MS || imageAssets.lifecycle?.startupDelayMs || '60000', 10),
        intervalMs: Number.parseInt(process.env.PRODUCT_IMAGE_LIFECYCLE_INTERVAL_MS || imageAssets.lifecycle?.intervalMs || '900000', 10),
        batchSize: Number.parseInt(process.env.PRODUCT_IMAGE_LIFECYCLE_BATCH_SIZE || imageAssets.lifecycle?.batchSize || '100', 10),
        retryDelaySeconds: Number.parseInt(process.env.PRODUCT_IMAGE_DELETE_RETRY_DELAY_SECONDS || imageAssets.lifecycle?.retryDelaySeconds || '300', 10),
      },
      storageGbMonthCny: Number(process.env.PRODUCT_IMAGE_STORAGE_GB_MONTH_CNY || imageAssets.storageGbMonthCny || 0.12),
      egressGbCny: Number(process.env.PRODUCT_IMAGE_EGRESS_GB_CNY || imageAssets.egressGbCny || 0.5),
      requestsPerTenThousandCny: Number(process.env.PRODUCT_IMAGE_REQUESTS_PER_10000_CNY || imageAssets.requestsPerTenThousandCny || 0.01),
      monthlyBudgetCny: Number(process.env.PRODUCT_IMAGE_MONTHLY_BUDGET_CNY || imageAssets.monthlyBudgetCny || 100),
      upload: {
        maxConcurrent: Number.parseInt(process.env.PRODUCT_IMAGE_MAX_CONCURRENT || imageAssets.upload?.maxConcurrent || '4', 10),
        maxConcurrentPerOwner: Number.parseInt(process.env.PRODUCT_IMAGE_MAX_CONCURRENT_PER_OWNER || imageAssets.upload?.maxConcurrentPerOwner || '2', 10),
        maxQueue: Number.parseInt(process.env.PRODUCT_IMAGE_MAX_QUEUE || imageAssets.upload?.maxQueue || '200', 10),
        maxDailyUploads: Number.parseInt(process.env.PRODUCT_IMAGE_MAX_DAILY_UPLOADS || imageAssets.upload?.maxDailyUploads || '2000', 10),
        maxDailyBytes: Number.parseInt(process.env.PRODUCT_IMAGE_MAX_DAILY_BYTES || imageAssets.upload?.maxDailyBytes || `${2 * 1024 * 1024 * 1024}`, 10),
        maxRetainedBytes: Number.parseInt(process.env.PRODUCT_IMAGE_MAX_RETAINED_BYTES || imageAssets.upload?.maxRetainedBytes || `${20 * 1024 * 1024 * 1024}`, 10),
        maxAttempts: Number.parseInt(process.env.PRODUCT_IMAGE_MAX_UPLOAD_ATTEMPTS || imageAssets.upload?.maxAttempts || '3', 10),
        retryBaseMs: Number.parseInt(process.env.PRODUCT_IMAGE_RETRY_BASE_MS || imageAssets.upload?.retryBaseMs || '250', 10),
      },
    },
    imageProvenance: {
      // Evidence generation is fail-closed for Ozon uploads: only the derived
      // watermarked asset may be promoted to the permanent Ozon image path.
      enabled: parseBooleanFlag(
        process.env.IMAGE_PROVENANCE_SHADOW_ENABLED,
        imageProvenance.enabled !== false,
      ),
      mode: 'upload-enforced',
      evidenceRoot: resolveOptionalPath(
        process.env.IMAGE_PROVENANCE_EVIDENCE_ROOT || imageProvenance.evidenceRoot,
      ) || resolve(dirname(databasePath), 'image-provenance'),
      algorithmVersion: String(
        process.env.IMAGE_PROVENANCE_ALGORITHM_VERSION
        || imageProvenance.algorithmVersion
        || '1.1.0-upload',
      ).trim(),
      strength: Number.parseInt(
        process.env.IMAGE_PROVENANCE_DCT_STRENGTH || imageProvenance.strength || '20',
        10,
      ),
      maxConcurrency: Number.parseInt(
        process.env.IMAGE_PROVENANCE_MAX_CONCURRENT || imageProvenance.maxConcurrency || '1',
        10,
      ),
      maxAttempts: Number.parseInt(
        process.env.IMAGE_PROVENANCE_MAX_ATTEMPTS || imageProvenance.maxAttempts || '3',
        10,
      ),
      sourceWaitMs: Number.parseInt(
        process.env.IMAGE_PROVENANCE_SOURCE_WAIT_MS || imageProvenance.sourceWaitMs || '150000',
        10,
      ),
      workerTimeoutMs: Number.parseInt(
        process.env.IMAGE_PROVENANCE_WORKER_TIMEOUT_MS || imageProvenance.workerTimeoutMs || '120000',
        10,
      ),
      protectionWaitMs: Number.parseInt(
        process.env.IMAGE_PROVENANCE_PROTECTION_WAIT_MS || imageProvenance.protectionWaitMs || '180000',
        10,
      ),
    },
    protectedCompute: {
      // Signed-public configuration still needs a pinned Ed25519 fingerprint.
      // These values stay environment-only so profile JSON cannot replace the
      // protected server URL or its configuration trust root.
      ...protectedComputeEnvironment,
      // The default runtime has no approved persistent signed-result store.
      offlineEnabled: false,
    },
    runtime: {
      appId: String(process.env.LOCAL_API_APP_ID || '').trim(),
      profileId: String(process.env.LOCAL_API_PROFILE_ID || '').trim(),
      dataRootFingerprint: String(process.env.LOCAL_API_DATA_ROOT_FINGERPRINT || '').trim(),
      protocolVersion: String(process.env.LOCAL_API_PROTOCOL_VERSION || '').trim(),
      logDirectory: String(process.env.LOCAL_API_LOG_DIRECTORY || '').trim(),
    },
  };
}
