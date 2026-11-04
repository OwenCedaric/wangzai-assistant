import path from 'node:path';
import process from 'node:process';
import {
  applyReboundShopDataRecovery,
  previewReboundShopDataRecovery,
  REBOUND_SHOP_RECOVERY_CONFIRMATION,
  ReboundShopDataRecoveryError,
} from '../src/maintenance/reboundShopDataRecovery.js';

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      result.apply = true;
      continue;
    }
    if (!argument.startsWith('--')) continue;
    const separator = argument.indexOf('=');
    if (separator > 2) {
      result[argument.slice(2, separator)] = argument.slice(separator + 1);
      continue;
    }
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) {
      result[name] = value;
      index += 1;
    } else {
      result[name] = true;
    }
  }
  return result;
}

function defaultDataRoot() {
  if (process.env.WANGZAI_DESKTOP_DATA_DIR) {
    return path.resolve(process.env.WANGZAI_DESKTOP_DATA_DIR);
  }
  const appData = String(process.env.APPDATA || '').trim();
  if (!appData) return '';
  return path.join(appData, 'wangzai-desktop');
}

function buildOptions(args) {
  const dataRootValue = String(args['data-root'] || defaultDataRoot()).trim();
  if (!dataRootValue) throw new ReboundShopDataRecoveryError('REBOUND_RECOVERY_DATA_ROOT_REQUIRED');
  for (const [argument, code] of [
    ['target', 'REBOUND_RECOVERY_TARGET_OVERRIDE_PROHIBITED'],
    ['profile-lock', 'REBOUND_RECOVERY_PROFILE_LOCK_OVERRIDE_PROHIBITED'],
    ['backup-directory', 'REBOUND_RECOVERY_BACKUP_DIRECTORY_OVERRIDE_PROHIBITED'],
    ['snapshot-root', 'REBOUND_RECOVERY_SNAPSHOT_ROOT_OVERRIDE_PROHIBITED'],
  ]) {
    if (args[argument]) throw new ReboundShopDataRecoveryError(code);
  }
  const dataRoot = path.resolve(dataRootValue);
  return {
    dataRoot,
    sourcePath: args.source,
    targetPath: path.join(dataRoot, 'local-api-data', 'wangzai-local-api.sqlite'),
    profileLockPath: path.join(dataRoot, 'runtime', 'profile.lock'),
    backupDirectory: path.join(dataRoot, 'backups', 'rebound-shop-data-recovery'),
    snapshotRoot: path.join(dataRoot, 'restore-staging'),
    oldShopId: args['old-shop'],
    newShopId: args['new-shop'],
    clientId: args['client-id'],
  };
}

function safeResult(result) {
  if (result?.mode === 'preview') return result;
  return {
    ok: Boolean(result?.ok),
    mode: result?.mode || 'apply',
    alreadyApplied: Boolean(result?.alreadyApplied),
    previewFingerprint: result?.previewFingerprint || '',
    backup: result?.backup || null,
    counts: result?.counts || {},
  };
}

const args = parseArguments(process.argv.slice(2));

try {
  const options = buildOptions(args);
  const result = args.apply
    ? applyReboundShopDataRecovery({
        ...options,
        confirmation: args.confirmation,
      })
    : previewReboundShopDataRecovery(options);
  process.stdout.write(`${JSON.stringify(safeResult(result), null, 2)}\n`);
} catch (error) {
  const code = error instanceof ReboundShopDataRecoveryError
    ? error.code
    : 'REBOUND_RECOVERY_CLI_FAILED';
  process.stderr.write(`${JSON.stringify({
    ok: false,
    mode: args.apply ? 'apply' : 'preview',
    code,
    confirmationHint: args.apply ? REBOUND_SHOP_RECOVERY_CONFIRMATION : undefined,
  }, null, 2)}\n`);
  process.exitCode = 1;
}
