import { randomBytes } from 'node:crypto';

function errorCode(error) {
  const code = String(error?.code || error?.message || 'DATA_BACKUP_REQUEST_FAILED');
  if (/^DATA_BACKUP_[A-Z0-9_]+$/u.test(code)) return code;
  if (['ENOSPC', 'EDQUOT'].includes(code)) return 'DATA_BACKUP_DISK_FULL';
  if (['EACCES', 'EPERM', 'EROFS'].includes(code)) return 'DATA_BACKUP_STORAGE_PERMISSION_DENIED';
  if (code === 'EIO') return 'DATA_BACKUP_STORAGE_IO_FAILED';
  return 'DATA_BACKUP_REQUEST_FAILED';
}

function createOneTimeCapability() {
  return randomBytes(32).toString('base64url');
}

function createStagingFileName(kind) {
  return `data-backup-${kind}-${randomBytes(32).toString('hex')}.wzb`;
}

function runCleanup(cleanup) {
  if (typeof cleanup !== 'function') return Promise.resolve();
  return Promise.resolve().then(() => cleanup()).catch(() => undefined);
}

function assertOneTimeCapability(value) {
  const capability = String(value || '');
  if (!/^[A-Za-z0-9_-]{43}$/u.test(capability)) {
    throw Object.assign(new Error('DATA_BACKUP_COMMIT_CAPABILITY_INVALID'), {
      code: 'DATA_BACKUP_COMMIT_CAPABILITY_INVALID',
    });
  }
  return capability;
}

function publicDomains(value) {
  if (!Array.isArray(value)) return [];
  return value.map((domain) => ({
    domain: String(domain?.domain || ''),
    // The renderer must never fall back to an internal English domain slug.
    // The Local API supplies the canonical Chinese label; an unknown future
    // domain is still presented with a safe Chinese catch-all.
    label: String(domain?.label || '其他用户数据'),
    schemaVersion: Number(domain?.schemaVersion) || 1,
    recordCount: Number(domain?.recordCount) || 0,
    logicalBytes: Number(domain?.logicalBytes) || 0,
    requiredForRestore: domain?.requiredForRestore === true,
  }));
}

function publicVerifiedSummary({ prepared, committed, saved }) {
  return {
    backupId: String(committed?.backupId || prepared?.backupId || ''),
    status: String(committed?.status || 'verified'),
    dataFingerprint: String(committed?.dataFingerprint || prepared?.dataFingerprint || ''),
    packageSha256: String(saved?.packageSha256 || ''),
    packageBytes: Number(saved?.packageBytes) || 0,
    domains: publicDomains(committed?.domains || prepared?.domains),
    totalRecords: Number(committed?.totalRecords ?? prepared?.totalRecords) || 0,
    logicalBytes: Number(committed?.logicalBytes ?? prepared?.logicalBytes) || 0,
    packageVersion: Number(committed?.packageVersion ?? prepared?.packageVersion) || 1,
    survivesAccountRemoval: committed?.survivesAccountRemoval === true,
    createdAt: String(committed?.createdAt || prepared?.createdAt || ''),
    verifiedAt: String(committed?.verifiedAt || ''),
    // Keep the user's chosen basename inside Main. Renderer only receives the
    // server-generated opaque suggestion, which cannot disclose a personal path name.
    fileName: String(committed?.suggestedFileName || prepared?.suggestedFileName || ''),
    canceled: false,
    verified: true,
  };
}

function publicCountSummary(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    ['total', 'incoming', 'added', 'updated', 'preserved', 'conflicts', 'skipped', 'failed']
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, Math.max(0, Number(source[key]) || 0)]),
  );
}

function publicShopMapping(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    shopId: String(value.shopId || value.id || ''),
    displayName: String(value.displayName || value.name || value.alias || ''),
  };
}

function publicOwnerMapping(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ownerType = String(value.ownerType || value.owner_type || '');
  const ownerId = String(value.ownerId || value.owner_id || '');
  if (!ownerType || !ownerId) return null;
  return {
    ownerType,
    ownerId,
    ownerTypeLabel: String(value.ownerTypeLabel || value.owner_type_label || '其他账号'),
    displayName: String(value.displayName || value.display_name || ownerId),
    exists: value.exists === true,
  };
}

function publicImportPreflight(data = {}, sessionId) {
  return {
    canceled: false,
    sessionId,
    previewFingerprint: String(data.previewFingerprint || data.preflightFingerprint || ''),
    packageVersion: Number(data.packageVersion || data.version) || 1,
    createdAt: String(data.createdAt || ''),
    sourceShop: publicShopMapping(data.sourceShop),
    targetShop: publicShopMapping(data.targetShop),
    sourceOwner: publicOwnerMapping(data.sourceOwner),
    targetOwner: publicOwnerMapping(data.targetOwner),
    domains: publicDomains(data.domains),
    totalRecords: Number(data.totalRecords) || 0,
    summary: publicCountSummary(data.summary),
    conflictMode: String(data.conflictMode || 'preserve'),
    requiresConfirmation: data.requiresConfirmation !== false,
    restoreSafety: data.restoreSafety ? {
      writeAllowed: data.restoreSafety.writeAllowed === true,
      atomicity: String(data.restoreSafety.atomicity || ''),
      errorCode: String(data.restoreSafety.errorCode || ''),
    } : null,
  };
}

function publicImportResult(data = {}) {
  return {
    importId: String(data.importId || data.restoreId || ''),
    status: String(data.status || (data.verified === true ? 'completed' : 'unknown')),
    verified: data.verified === true,
    restored: data.restored === true || data.verified === true,
    completedAt: String(data.completedAt || data.verifiedAt || ''),
    targetShop: publicShopMapping(data.targetShop),
    targetOwner: publicOwnerMapping(data.targetOwner),
    domains: publicDomains(data.domains),
    totalRecords: Number(data.totalRecords) || 0,
    summary: publicCountSummary(data.summary),
    requiresRefresh: data.requiresRefresh !== false,
  };
}

/** Keeps opaque package bytes in Main and returns only a verified public summary. */
export function createDataBackupIpcBridge({
  requestRecovery,
  requestDataBackupImport = async () => ({ ok: false, status: 501, error: 'DATA_BACKUP_IMPORT_UNAVAILABLE' }),
  saveVerifiedDataBackup,
  saveVerifiedDataBackupBatch = async () => ({ ok: false, verified: false }),
  selectVerifiedDataBackup = async () => ({ ok: true, canceled: true }),
  createCommitCapability = createOneTimeCapability,
  createImportSessionId = createOneTimeCapability,
  createExportStagingFileName = () => createStagingFileName('export'),
  removeStagedDataBackup = async () => undefined,
  now = () => Date.now(),
} = {}) {
  if (typeof requestRecovery !== 'function') throw new Error('DATA_BACKUP_REQUEST_HANDLER_REQUIRED');
  if (typeof requestDataBackupImport !== 'function') throw new Error('DATA_BACKUP_IMPORT_HANDLER_REQUIRED');
  if (typeof saveVerifiedDataBackup !== 'function') throw new Error('DATA_BACKUP_FILE_WRITER_REQUIRED');
  if (typeof saveVerifiedDataBackupBatch !== 'function') throw new Error('DATA_BACKUP_BATCH_WRITER_REQUIRED');
  if (typeof selectVerifiedDataBackup !== 'function') throw new Error('DATA_BACKUP_FILE_READER_REQUIRED');
  let queue = Promise.resolve();
  const importSessions = new Map();

  function deleteImportSession(sessionId) {
    const session = importSessions.get(sessionId);
    if (session?.expiryTimer) clearTimeout(session.expiryTimer);
    if (session) session.legacyPassphrase = '';
    importSessions.delete(sessionId);
    void runCleanup(session?.cleanup);
  }

  function takeImportSession(sessionId) {
    const session = importSessions.get(sessionId);
    if (!session) return null;
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    importSessions.delete(sessionId);
    return session;
  }

  function pruneImportSessions() {
    const cutoff = Number(now()) - 30 * 60 * 1000;
    for (const [sessionId, session] of importSessions.entries()) {
      if (session.createdAt < cutoff) deleteImportSession(sessionId);
    }
    while (importSessions.size > 5) deleteImportSession(importSessions.keys().next().value);
  }

  async function preflightImport(input) {
    const targetShopId = String(input?.targetShopId || input?.shopId || '').trim();
    const conflictMode = input?.conflictMode === 'overwrite' ? 'overwrite' : 'preserve';
    const legacyPassphrase = String(input?.passphrase || '').trim();
    const selected = await selectVerifiedDataBackup();
    if (selected?.canceled === true) {
      return { ok: true, status: 200, data: { canceled: true } };
    }
    if (
      (!selected?.stagingFileName && !selected?.contentB64u)
      || !selected?.packageSha256
      || !selected?.packageBytes
    ) {
      await runCleanup(selected?.cleanup);
      throw Object.assign(new Error('DATA_BACKUP_IMPORT_FILE_READ_INVALID'), {
        code: 'DATA_BACKUP_IMPORT_FILE_READ_INVALID',
      });
    }
    let response;
    try {
      response = await requestDataBackupImport({
        command: 'preflight',
        ...(targetShopId ? { targetShopId } : {}),
        ...(selected.stagingFileName
          ? { stagingFileName: selected.stagingFileName }
          : { contentB64u: selected.contentB64u }),
        packageSha256: selected.packageSha256,
        packageBytes: selected.packageBytes,
        conflictMode,
        ...(legacyPassphrase ? { passphrase: legacyPassphrase } : {}),
      });
    } catch (error) {
      await runCleanup(selected.cleanup);
      throw error;
    }
    if (!response?.ok || !response?.data?.previewFingerprint) {
      await runCleanup(selected.cleanup);
      return response;
    }
    pruneImportSessions();
    const sessionId = assertOneTimeCapability(createImportSessionId());
    const expiryTimer = setTimeout(() => deleteImportSession(sessionId), 30 * 60 * 1000);
    expiryTimer.unref?.();
    importSessions.set(sessionId, {
      createdAt: Number(now()),
      expiryTimer,
      targetShopId,
      targetOwner: publicOwnerMapping(response.data.targetOwner),
      stagingFileName: String(selected.stagingFileName || ''),
      contentB64u: selected.stagingFileName ? '' : selected.contentB64u,
      packageSha256: selected.packageSha256,
      packageBytes: selected.packageBytes,
      previewFingerprint: String(response.data.previewFingerprint),
      importId: String(response.data.importId || response.data.restoreId || ''),
      conflictMode,
      legacyPassphrase,
      cleanup: selected.cleanup,
    });
    pruneImportSessions();
    return {
      ok: true,
      status: 200,
      data: publicImportPreflight(response.data, sessionId),
    };
  }

  async function commitImport(input) {
    pruneImportSessions();
    const sessionId = assertOneTimeCapability(input?.sessionId);
    const session = importSessions.get(sessionId);
    if (!session) {
      return { ok: false, status: 404, error: 'DATA_BACKUP_IMPORT_SESSION_EXPIRED' };
    }
    const previewFingerprint = String(input?.previewFingerprint || '').trim();
    if (!previewFingerprint || previewFingerprint !== session.previewFingerprint) {
      return { ok: false, status: 409, error: 'DATA_BACKUP_IMPORT_PREVIEW_MISMATCH' };
    }
    // A confirmed session is one-shot even when the downstream request fails.
    // The user must preflight the current file and current target state again.
    const consumed = takeImportSession(sessionId);
    try {
      const response = await requestDataBackupImport({
        command: 'confirm',
        ...(consumed.targetShopId ? { targetShopId: consumed.targetShopId } : {}),
        ...(consumed.targetOwner ? { targetOwner: {
          ownerType: consumed.targetOwner.ownerType,
          ownerId: consumed.targetOwner.ownerId,
        } } : {}),
        ...(consumed.stagingFileName
          ? { stagingFileName: consumed.stagingFileName }
          : { contentB64u: consumed.contentB64u }),
        packageSha256: consumed.packageSha256,
        packageBytes: consumed.packageBytes,
        previewFingerprint,
        ...(consumed.importId ? { importId: consumed.importId } : {}),
        // A confirm must execute exactly the merge policy that was previewed.
        // Renderer input cannot upgrade a preserve preview into overwrite mode.
        conflictMode: consumed.conflictMode,
        ...(consumed.legacyPassphrase ? { passphrase: consumed.legacyPassphrase } : {}),
      });
      if (!response?.ok) return response;
      return { ok: true, status: 200, data: publicImportResult(response.data) };
    } finally {
      consumed.legacyPassphrase = '';
      await runCleanup(consumed.cleanup);
    }
  }

  async function execute(input = {}) {
    const command = String(input?.command || '').trim();
    if (command === 'preflight-import' || command === 'commit-import') {
      try {
        return command === 'preflight-import'
          ? await preflightImport(input)
          : await commitImport(input);
      } catch (error) {
        return { ok: false, status: 400, error: errorCode(error) };
      }
    }
    if (command !== 'export') {
      if (command === 'export-batch') return executeBatchExport(input);
      return { ok: false, status: 400, error: 'DATA_BACKUP_COMMAND_INVALID' };
    }
    let prepared = null;
    const commitCapability = assertOneTimeCapability(createCommitCapability());
    const exportStagingFileName = String(createExportStagingFileName() || '').trim();
    try {
      const response = await requestRecovery({
        command: 'prepare-user-data-export',
        owner: input.owner || (input.shopId
          ? { ownerType: 'ozon_shop', ownerId: input.shopId }
          : undefined),
        expectedDataFingerprint: input.expectedDataFingerprint,
        selectedDomains: Array.isArray(input.selectedDomains) ? input.selectedDomains : undefined,
        commitCapability,
        stagingFileName: exportStagingFileName,
      });
      if (!response?.ok || (!response?.data?.stagingFileName && !response?.data?.contentB64u)) {
        return response?.ok === false
          ? response
          : { ok: false, status: 500, error: 'DATA_BACKUP_PREPARE_INVALID' };
      }
      prepared = response.data;
      const saved = await saveVerifiedDataBackup({
        contentB64u: prepared.contentB64u,
        stagingFileName: prepared.stagingFileName,
        expectedSha256: prepared.packageSha256,
        expectedBytes: prepared.packageBytes,
        suggestedFileName: prepared.suggestedFileName,
      });
      if (saved.canceled) {
        await requestRecovery({
          command: 'fail-user-data-export',
          backupId: prepared.backupId,
          failureCode: 'DATA_BACKUP_EXPORT_CANCELED',
          commitCapability,
        }).catch(() => undefined);
        return { ok: true, status: 200, data: { ok: true, canceled: true, verified: false } };
      }
      if (saved?.ok !== true || saved?.verified !== true) {
        throw Object.assign(new Error('DATA_BACKUP_FILE_WRITE_NOT_VERIFIED'), {
          code: 'DATA_BACKUP_FILE_WRITE_NOT_VERIFIED',
        });
      }
      const committed = await requestRecovery({
        command: 'commit-user-data-export',
        backupId: prepared.backupId,
        packageSha256: saved.packageSha256,
        packageBytes: saved.packageBytes,
        commitCapability,
      });
      if (!committed?.ok || committed?.data?.verified !== true) {
        throw Object.assign(new Error(committed?.error || 'DATA_BACKUP_COMMIT_NOT_VERIFIED'), {
          code: 'DATA_BACKUP_COMMIT_NOT_VERIFIED',
        });
      }
      if (
        String(committed.data.backupId || prepared.backupId || '') !== String(prepared.backupId || '')
      ) {
        throw Object.assign(new Error('DATA_BACKUP_COMMIT_ID_MISMATCH'), {
          code: 'DATA_BACKUP_COMMIT_ID_MISMATCH',
        });
      }
      return {
        ok: true,
        status: 200,
        data: publicVerifiedSummary({ prepared, committed: committed.data, saved }),
      };
    } catch (error) {
      if (prepared?.backupId) {
        await requestRecovery({
          command: 'fail-user-data-export',
          backupId: prepared.backupId,
          failureCode: errorCode(error),
          commitCapability,
        }).catch(() => undefined);
      }
      return { ok: false, status: 500, error: errorCode(error) };
    } finally {
      if (prepared?.stagingFileName) {
        await removeStagedDataBackup({ stagingFileName: prepared.stagingFileName }).catch(() => undefined);
      }
    }
  }

  async function executeBatchExport(input = {}) {
    const items = Array.isArray(input?.items) ? input.items : [];
    if (items.length < 2 || items.length > 100) {
      return { ok: false, status: 400, error: 'DATA_BACKUP_BATCH_ITEMS_INVALID' };
    }
    const ownerKeys = items.map((item) => (
      `${String(item?.owner?.ownerType || '')}\0${String(item?.owner?.ownerId || '')}`
    ));
    if (ownerKeys.some((key) => key.startsWith('\0') || key.endsWith('\0'))
      || new Set(ownerKeys).size !== ownerKeys.length) {
      return { ok: false, status: 400, error: 'DATA_BACKUP_BATCH_OWNER_INVALID' };
    }
    const preparedItems = [];
    try {
      for (const item of items) {
        const commitCapability = assertOneTimeCapability(createCommitCapability());
        const response = await requestRecovery({
          command: 'prepare-user-data-export',
          owner: item.owner,
          expectedDataFingerprint: item.expectedDataFingerprint,
          selectedDomains: Array.isArray(item.selectedDomains) ? item.selectedDomains : undefined,
          commitCapability,
          stagingFileName: String(createExportStagingFileName() || '').trim(),
        });
        if (!response?.ok || !response?.data?.stagingFileName) {
          throw Object.assign(new Error(response?.error || 'DATA_BACKUP_PREPARE_INVALID'), {
            code: errorCode(response?.error || 'DATA_BACKUP_PREPARE_INVALID'),
          });
        }
        preparedItems.push({ prepared: response.data, commitCapability });
      }
      const saved = await saveVerifiedDataBackupBatch({
        items: preparedItems.map(({ prepared }) => ({
          stagingFileName: prepared.stagingFileName,
          expectedSha256: prepared.packageSha256,
          expectedBytes: prepared.packageBytes,
          suggestedFileName: prepared.suggestedFileName,
        })),
      });
      if (saved?.canceled) {
        await Promise.all(preparedItems.map(({ prepared, commitCapability }) => requestRecovery({
          command: 'fail-user-data-export',
          backupId: prepared.backupId,
          failureCode: 'DATA_BACKUP_EXPORT_CANCELED',
          commitCapability,
        }).catch(() => undefined)));
        return { ok: true, status: 200, data: { canceled: true, verified: false, backups: [] } };
      }
      if (saved?.verified !== true || saved.files?.length !== preparedItems.length) {
        throw Object.assign(new Error('DATA_BACKUP_BATCH_FILE_WRITE_NOT_VERIFIED'), {
          code: 'DATA_BACKUP_BATCH_FILE_WRITE_NOT_VERIFIED',
        });
      }
      const backups = [];
      for (let index = 0; index < preparedItems.length; index += 1) {
        const { prepared, commitCapability } = preparedItems[index];
        const savedFile = saved.files[index];
        const committed = await requestRecovery({
          command: 'commit-user-data-export',
          backupId: prepared.backupId,
          packageSha256: savedFile.packageSha256,
          packageBytes: savedFile.packageBytes,
          commitCapability,
        });
        if (!committed?.ok || committed?.data?.verified !== true) {
          throw Object.assign(new Error('DATA_BACKUP_COMMIT_NOT_VERIFIED'), {
            code: 'DATA_BACKUP_COMMIT_NOT_VERIFIED',
          });
        }
        backups.push(publicVerifiedSummary({ prepared, committed: committed.data, saved: savedFile }));
      }
      return {
        ok: true,
        status: 200,
        data: { canceled: false, verified: true, count: backups.length, backups },
      };
    } catch (error) {
      await Promise.all(preparedItems.map(({ prepared, commitCapability }) => requestRecovery({
        command: 'fail-user-data-export',
        backupId: prepared.backupId,
        failureCode: errorCode(error),
        commitCapability,
      }).catch(() => undefined)));
      return { ok: false, status: 500, error: errorCode(error) };
    } finally {
      await Promise.all(preparedItems.map(({ prepared }) => (
        prepared?.stagingFileName
          ? removeStagedDataBackup({ stagingFileName: prepared.stagingFileName }).catch(() => undefined)
          : undefined
      )));
    }
  }

  return function handleDataBackupCommand(input = {}) {
    const task = queue.then(() => execute(input));
    queue = task.catch(() => undefined);
    return task;
  };
}
