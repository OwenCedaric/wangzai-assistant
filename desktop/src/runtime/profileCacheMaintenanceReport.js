import fs from 'node:fs';
import path from 'node:path';

export function safeProfileMaintenanceTimestamp(now = new Date()) {
  return now.toISOString().replaceAll(':', '-');
}

export function writeProfileMaintenanceJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function finalizeSuccessfulProfileCacheMaintenance({
  dataRoot,
  backupRoot,
  report,
  canonicalBackup,
  now = new Date(),
}) {
  const root = path.resolve(String(dataRoot || ''));
  const reportDirectory = path.resolve(root, 'maintenance-reports');
  if (!reportDirectory.startsWith(`${root}${path.sep}`)) {
    throw new Error('普通清缓存报告目录必须位于 desktop dataRoot 内');
  }
  const reportPath = path.join(
    reportDirectory,
    `profile-cache-clear-${safeProfileMaintenanceTimestamp(now)}.json`,
  );
  writeProfileMaintenanceJson(reportPath, report);
  try {
    fs.rmSync(backupRoot, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(reportPath, { force: true });
    throw error;
  }
  const completedReport = {
    ...report,
    backupRoot: null,
    canonicalBackup: {
      ...canonicalBackup,
      databaseDestination: null,
      sidecarDestinations: [],
      removed: true,
    },
    protectionBackupRemoved: true,
  };
  try {
    writeProfileMaintenanceJson(reportPath, completedReport);
  } catch {
    // The protected-data readback and backup removal are already complete.
    // A compact report refresh failure must never recreate the full backup.
  }
  return { completedReport, reportPath };
}
