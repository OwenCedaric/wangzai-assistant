import fs from 'node:fs';
import path from 'node:path';

function assertDescendant(root, candidate, code) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..') {
    throw new Error(code);
  }
  return resolvedCandidate;
}

function databaseFamily(databasePath) {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
}

function moveFamily(sourcePath, targetPath) {
  const moved = [];
  for (const [source, target] of databaseFamily(sourcePath).map((source, index) => [source, databaseFamily(targetPath)[index]])) {
    if (!fs.existsSync(source)) continue;
    fs.renameSync(source, target);
    moved.push([source, target]);
  }
  return moved;
}

function restoreFamily(moved) {
  for (const [source, target] of [...moved].reverse()) {
    if (fs.existsSync(target)) fs.renameSync(target, source);
  }
}

/**
 * Owns the only active-database switch path. The caller must provide a descriptor returned by
 * local-api staging and keep it in the desktop main process, never accept a renderer path.
 */
export async function activateRecoveryDatabase({
  descriptor,
  activeDatabasePath,
  stopServices,
  startServices,
  prepareActivatedServices = async () => undefined,
  prepareRollbackServices = async () => undefined,
  now = () => new Date(),
} = {}) {
  if (typeof stopServices !== 'function' || typeof startServices !== 'function') {
    throw new Error('RECOVERY_ACTIVATION_SERVICE_CALLBACKS_REQUIRED');
  }
  if (
    typeof prepareActivatedServices !== 'function' ||
    typeof prepareRollbackServices !== 'function'
  ) {
    throw new Error('RECOVERY_ACTIVATION_PREPARE_CALLBACKS_INVALID');
  }
  const activePath = path.resolve(String(activeDatabasePath || ''));
  if (!activePath || activePath === path.parse(activePath).root) {
    throw new Error('RECOVERY_ACTIVATION_DATABASE_PATH_REQUIRED');
  }
  const restoreId = String(descriptor?.restoreId || '').trim();
  const stagingPath = String(descriptor?.stagingDatabasePath || '').trim();
  if (!restoreId || !stagingPath) throw new Error('RECOVERY_ACTIVATION_DESCRIPTOR_INVALID');
  const restoreRoot = path.join(path.dirname(activePath), 'restore-staging');
  const validatedStagingPath = assertDescendant(restoreRoot, stagingPath, 'RECOVERY_ACTIVATION_STAGING_PATH_INVALID');
  if (path.basename(validatedStagingPath) !== 'restore.sqlite' || !fs.existsSync(validatedStagingPath)) {
    throw new Error('RECOVERY_ACTIVATION_STAGING_PATH_INVALID');
  }
  if (fs.existsSync(`${validatedStagingPath}-wal`) || fs.existsSync(`${validatedStagingPath}-shm`)) {
    throw new Error('RECOVERY_ACTIVATION_STAGING_NOT_CHECKPOINTED');
  }

  const suffix = `${now().toISOString().replace(/[:.]/gu, '-')}-${restoreId}`;
  const rollbackDirectory = path.join(path.dirname(activePath), 'restore-rollback', suffix);
  const failedDirectory = path.join(path.dirname(activePath), 'restore-failed', suffix);
  fs.mkdirSync(rollbackDirectory, { recursive: true });
  let previous = [];
  let switched = false;
  try {
    await stopServices();
    previous = moveFamily(activePath, path.join(rollbackDirectory, path.basename(activePath)));
    moveFamily(validatedStagingPath, activePath);
    switched = true;
    await prepareActivatedServices();
    await startServices();
    return {
      ok: true,
      mode: 'activated',
      restoreId,
      rollbackDirectory,
    };
  } catch (error) {
    if (switched) {
      fs.mkdirSync(failedDirectory, { recursive: true });
      moveFamily(activePath, path.join(failedDirectory, path.basename(activePath)));
    }
    restoreFamily(previous);
    try {
      await stopServices();
      await prepareRollbackServices();
      await startServices();
    } catch {
      // Preserve both the old rollback and failed restore files for manual diagnosis.
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`RECOVERY_ACTIVATION_FAILED:${message}`);
  }
}
