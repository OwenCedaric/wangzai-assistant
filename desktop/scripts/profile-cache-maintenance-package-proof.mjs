import { extractFile, listPackage } from '@electron/asar';

function normalizeAsarEntry(entry) {
  return `/${String(entry || '').replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')}`;
}

export function createAsarPackageReader(asarPath) {
  const archiveEntryByNormalizedPath = new Map();
  for (const rawEntry of listPackage(asarPath)) {
    const archiveEntry = String(rawEntry).replace(/^[\\/]+|[\\/]+$/gu, '');
    archiveEntryByNormalizedPath.set(normalizeAsarEntry(archiveEntry), archiveEntry);
  }
  const entries = new Set(archiveEntryByNormalizedPath.keys());
  return Object.freeze({
    asarPath,
    entries,
    readBuffer(entry) {
      const normalized = normalizeAsarEntry(entry);
      const archiveEntry = archiveEntryByNormalizedPath.get(normalized);
      if (!archiveEntry) {
        const error = new Error(`${normalized} was not found in ${asarPath}`);
        error.code = 'ASAR_PACKAGE_ENTRY_MISSING';
        throw error;
      }
      return extractFile(asarPath, archiveEntry);
    },
    readText(entry) {
      return this.readBuffer(entry).toString('utf8');
    },
  });
}

export const PROFILE_CACHE_MAINTENANCE_ASAR_ENTRIES = Object.freeze([
  '/src/main.js',
  '/src/preload.cjs',
  '/src/runtime/desktopIpc.js',
  '/src/runtime/profileCacheMaintenanceMode.js',
  '/src/runtime/profileCacheMaintenanceLauncher.js',
]);

const PROFILE_CACHE_MAINTENANCE_WIRING_REQUIREMENTS = Object.freeze([
  Object.freeze({
    entry: '/src/runtime/profileCacheMaintenanceLauncher.js',
    label: '专用启动 flag',
    patterns: Object.freeze([
      /PROFILE_CACHE_MAINTENANCE_ARGUMENT/u,
      /["']--profile-cache-maintenance["']/u,
      /isProfileCacheMaintenanceRequested/u,
    ]),
  }),
  Object.freeze({
    entry: '/src/runtime/profileCacheMaintenanceMode.js',
    label: '服务启动前维护模式',
    patterns: Object.freeze([
      /PROFILE_CACHE_MAINTENANCE_MODE_VERSION/u,
      /runProfileCacheMaintenanceMode/u,
      /continueStartup:\s*false/u,
    ]),
  }),
  Object.freeze({
    entry: '/src/main.js',
    label: 'main 启动 flag 与重启接线',
    patterns: Object.freeze([
      /isProfileCacheMaintenanceRequested\s*\(\s*process\.argv\s*\)/u,
      /runProfileCacheMaintenanceMode\s*\(/u,
      /requestProfileCacheMaintenance\s*:\s*requestProfileCacheMaintenanceRestart/u,
    ]),
  }),
  Object.freeze({
    entry: '/src/preload.cjs',
    label: 'preload 普通清缓存 IPC',
    patterns: Object.freeze([
      /requestProfileCacheMaintenance\s*:/u,
      /ipcRenderer\.invoke\s*\(\s*["']desktop:profile-cache-maintenance["']/u,
    ]),
  }),
  Object.freeze({
    entry: '/src/runtime/desktopIpc.js',
    label: 'desktopIpc 普通清缓存 handler',
    patterns: Object.freeze([
      /createProfileCacheMaintenanceIpcHandler/u,
      /ipcMain\.handle\s*\(\s*["']desktop:profile-cache-maintenance["']/u,
      /requestProfileCacheMaintenance/u,
    ]),
  }),
]);

export function verifyProfileCacheMaintenanceAsarWiring(reader) {
  const findings = [];
  for (const requirement of PROFILE_CACHE_MAINTENANCE_WIRING_REQUIREMENTS) {
    if (!reader.entries.has(requirement.entry)) {
      findings.push(Object.freeze({
        code: 'PROFILE_CACHE_MAINTENANCE_ASAR_ENTRY_MISSING',
        entry: requirement.entry,
        evidence: requirement.label,
      }));
      continue;
    }
    let source;
    try {
      source = reader.readText(requirement.entry);
    } catch (error) {
      findings.push(Object.freeze({
        code: 'PROFILE_CACHE_MAINTENANCE_ASAR_ENTRY_READ_FAILED',
        entry: requirement.entry,
        evidence: String(error?.message || error),
      }));
      continue;
    }
    for (const pattern of requirement.patterns) {
      if (pattern.test(source)) continue;
      findings.push(Object.freeze({
        code: 'PROFILE_CACHE_MAINTENANCE_ASAR_WIRING_MISSING',
        entry: requirement.entry,
        evidence: `${requirement.label}:${pattern.source}`,
      }));
    }
  }
  return Object.freeze({
    ok: findings.length === 0,
    checkedEntries: PROFILE_CACHE_MAINTENANCE_ASAR_ENTRIES.length,
    findings: Object.freeze(findings),
  });
}
