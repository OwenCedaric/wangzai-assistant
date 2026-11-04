import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const DEFAULT_WARNING_BYTES = 64 * 1024 * 1024;

// /api/app/status is opened from the status panel and by the maintenance tool.
// Walking the whole data directory is synchronous IO, so keep a short cache
// instead of re-scanning on every call.
const STORAGE_USAGE_CACHE_TTL_MS = 10_000;
const storageUsageCache = new Map();

function getFileSize(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return 0;
  }

  const stat = statSync(filePath);
  return stat.isFile() ? stat.size : 0;
}

function walkDirectorySize(directoryPath) {
  if (!directoryPath || !existsSync(directoryPath)) {
    return { bytes: 0, files: 0 };
  }

  let bytes = 0;
  let files = 0;
  const stack = [directoryPath];

  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      bytes += getFileSize(entryPath);
      files += 1;
    }
  }

  return { bytes, files };
}

function createWarning(label, bytes, warningBytes) {
  if (bytes <= warningBytes) {
    return null;
  }
  return {
    level: 'warning',
    label,
    bytes,
    limitBytes: warningBytes,
    message: `${label} 已超过体积预警线，继续接业务前需要拆分缓存或清理历史数据。`,
  };
}

export function getStorageUsage(config) {
  const cacheKey = String(config?.database?.path || '');
  const cached = cacheKey ? storageUsageCache.get(cacheKey) : null;
  if (cached && Date.now() - cached.at < STORAGE_USAGE_CACHE_TTL_MS) {
    return cached.value;
  }
  const value = computeStorageUsage(config);
  if (cacheKey) storageUsageCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function computeStorageUsage(config) {
  const databasePath = config.database.path;
  const databaseDirectory = dirname(databasePath);
  const warningBytes = Number.isFinite(config.storage?.warningBytes)
    ? config.storage.warningBytes
    : DEFAULT_WARNING_BYTES;
  const databaseBytes = getFileSize(databasePath);
  const walBytes = getFileSize(`${databasePath}-wal`);
  const shmBytes = getFileSize(`${databasePath}-shm`);
  const dataDirectory = walkDirectorySize(databaseDirectory);
  const warnings = [
    createWarning('SQLite 主库', databaseBytes, warningBytes),
    createWarning('SQLite WAL', walBytes, warningBytes),
    createWarning('local-api data 目录', dataDirectory.bytes, warningBytes),
  ].filter(Boolean);

  return {
    ok: warnings.length === 0,
    warningBytes,
    database: {
      path: databasePath,
      fileName: basename(databasePath),
      bytes: databaseBytes,
      walBytes,
      shmBytes,
    },
    dataDirectory: {
      path: databaseDirectory,
      bytes: dataDirectory.bytes,
      files: dataDirectory.files,
    },
    warnings,
  };
}
