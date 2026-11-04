import { randomUUID } from 'node:crypto';
import { createAccountRemovalOwnerRef } from '../db/repositories/accountRemovalOperationRepository.js';
import { createExternalOzonIdentityHash, normalizeProfileId } from '../db/repositories/shopIdentityRepository.js';
import { canonicalJson } from './recoveryChunkCodec.js';
import { openDataBackupPackage } from './dataBackupPackage.js';
import {
  getDataBackupDomainLabel,
  getDataBackupOwnerTypeLabel,
} from './dataBackupService.js';
import { createRecoveryImporter } from './recoveryImporter.js';
import { createRecoveryStorageAdapter } from './recoveryStorageAdapter.js';
import {
  createRecoveryProfileCoreImporter,
  openOwnerScopedRecoveryProfileCandidate,
  RECOVERY_OWNER_IDENTITY_DOMAINS,
} from './recoveryProfileCore.js';
import {
  assertCredentialSnapshotUnchanged,
  assertSourceIdentity,
  buildProfilePlan,
  combinedPlanDomains,
  countSummary,
  credentialSnapshot,
  fail,
  isSha256,
  normalizeStrategy,
  normalizeText,
  packageBytesFromInput,
  sha256,
  skippedSummary,
  wipeOpenedPackage,
} from "./dataBackupImportPlan.js";
import { assertGenericPlanApplied, assertProfileReadback } from "./dataBackupImportReadback.js";

export function createDataBackupImportService({
  db,
  storageAdapter,
  dataBackupService,
  profileId,
  encryptShopSecret,
  decryptShopSecret,
  stagingDirectory = '',
  invalidateProductCache = () => undefined,
  now = () => new Date(),
  createImportId = () => `data_backup_import_${randomUUID()}`,
} = {}) {
  if (!db) throw new Error('createDataBackupImportService requires db.');
  storageAdapter ||= createRecoveryStorageAdapter({ db });
  if (!dataBackupService?.previewShop) {
    throw new Error('createDataBackupImportService requires dataBackupService.');
  }
  if (typeof encryptShopSecret !== 'function' || typeof decryptShopSecret !== 'function') {
    throw new Error('createDataBackupImportService requires secret codecs.');
  }
  if (typeof invalidateProductCache !== 'function') {
    throw new Error('createDataBackupImportService requires invalidateProductCache function.');
  }
  const targetProfileId = normalizeProfileId(profileId);
  const shopImporter = createRecoveryImporter({ db, resolveDomainDatabase: storageAdapter.resolveDatabase });
  const profileImporter = createRecoveryProfileCoreImporter({ db, encryptShopSecret });

  function timestampNow() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) fail('DATA_BACKUP_IMPORT_CLOCK_INVALID');
    return date.toISOString();
  }

  function findTargetShop(externalIdentityHash, requestedShopId) {
    const rows = db.prepare(`
      SELECT id, name, alias, client_id, api_key_encrypted, status,
        profile_id, external_identity_hash, shop_incarnation,
        credential_revision, disabled_at
      FROM shops
      WHERE profile_id = ?
      ORDER BY id
    `).all(targetProfileId);
    // Only the current active binding can receive imported data.  A stale
    // inactive incarnation must not make a valid current match ambiguous.
    const activeRows = rows.filter((row) => row.status === 'active' && !row.disabled_at);
    const matches = activeRows.filter(
      (row) => createExternalOzonIdentityHash(row.client_id) === externalIdentityHash,
    );
    if (!matches.length) fail('DATA_BACKUP_IMPORT_TARGET_NOT_FOUND');
    if (matches.length !== 1) fail('DATA_BACKUP_IMPORT_TARGET_AMBIGUOUS');
    const target = matches[0];
    const computedTargetHash = createExternalOzonIdentityHash(target.client_id);
    if (target.external_identity_hash && target.external_identity_hash !== computedTargetHash) {
      fail('DATA_BACKUP_IMPORT_TARGET_IDENTITY_INCONSISTENT');
    }
    const requested = normalizeText(requestedShopId);
    if (requested && target.id !== requested) fail('DATA_BACKUP_IMPORT_TARGET_MISMATCH');
    if (
      target.status !== 'active'
      || target.disabled_at
      || !normalizeText(target.client_id)
      || !normalizeText(target.api_key_encrypted)
      || !normalizeText(target.shop_incarnation)
      || !Number.isSafeInteger(Number(target.credential_revision))
      || Number(target.credential_revision) < 1
    ) fail('DATA_BACKUP_IMPORT_TARGET_NOT_ACTIVE');
    let currentApiKey;
    try {
      currentApiKey = decryptShopSecret(target.api_key_encrypted);
    } catch {
      fail('DATA_BACKUP_IMPORT_TARGET_CREDENTIAL_INVALID');
    }
    if (!normalizeText(currentApiKey)) fail('DATA_BACKUP_IMPORT_TARGET_CREDENTIAL_INVALID');
    return target;
  }

  function targetPreview(target) {
    const preview = dataBackupService.previewShop(target.id)?.shops?.[0];
    if (!preview || !isSha256(preview.dataFingerprint)) fail('DATA_BACKUP_IMPORT_TARGET_PREVIEW_FAILED');
    return preview;
  }

  function normalizeRequestedTargetOwner(input, sourceOwner) {
    const raw = input?.targetOwner || input?.target_owner || null;
    if (!raw) return sourceOwner;
    const target = {
      ownerType: normalizeText(raw.ownerType || raw.owner_type),
      ownerId: normalizeText(raw.ownerId || raw.owner_id),
    };
    if (!target.ownerType || !target.ownerId) fail('DATA_BACKUP_IMPORT_TARGET_OWNER_REQUIRED');
    if (target.ownerType !== sourceOwner.ownerType || target.ownerId !== sourceOwner.ownerId) {
      fail('DATA_BACKUP_IMPORT_TARGET_OWNER_MISMATCH');
    }
    return target;
  }

  function ownerIdentitySummary(openedProfile, owner) {
    const identityDomain = RECOVERY_OWNER_IDENTITY_DOMAINS[owner.ownerType]?.[0];
    const record = identityDomain ? openedProfile.domains.get(identityDomain)?.records?.[0] : null;
    const row = record?.value || {};
    return {
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      ownerTypeLabel: getDataBackupOwnerTypeLabel(owner.ownerType),
      displayName: normalizeText(
        row.name || row.alias || row.api_alias || row.platform_name
          || row.client_id || row.login_account || owner.ownerId,
      ),
      ownerIncarnation: normalizeText(
        row.shop_incarnation || row.account_incarnation || row.created_at || owner.ownerId,
      ),
    };
  }

  function prepareGenericOwner(opened, openedProfile, input, strategy) {
    const targetOwner = normalizeRequestedTargetOwner(input, opened.owner);
    let currentPreview = null;
    try {
      currentPreview = dataBackupService.previewOwner(targetOwner)?.owner || null;
    } catch (error) {
      if (!String(error?.code || error?.message || '').includes('NOT_FOUND')) throw error;
    }
    const sourceOwner = ownerIdentitySummary(openedProfile, opened.owner);
    const domains = opened.domains.map((source) => ({
      domain: source.domain,
      label: getDataBackupDomainLabel(source.domain),
      schemaVersion: Number(source.schemaVersion) || 1,
      recordCount: Number(source.recordCount) || 0,
      inserted: currentPreview ? 0 : Number(source.recordCount) || 0,
      updated: currentPreview ? Number(source.recordCount) || 0 : 0,
      preserved: 0,
      unchanged: 0,
      conflicts: 0,
      skippedMissingDependency: 0,
    })).sort((left, right) => left.domain.localeCompare(right.domain));
    const skipped = skippedSummary(domains);
    const summary = countSummary(domains);
    const fingerprintShape = {
      version: 1,
      source: {
        backupId: opened.backupId,
        packageSha256: opened.packageSha256,
        dataFingerprint: opened.dataFingerprint,
        owner: opened.owner,
      },
      target: {
        profileId: targetProfileId,
        owner: targetOwner,
        exists: Boolean(currentPreview),
        dataFingerprint: currentPreview?.dataFingerprint || null,
      },
      strategy,
      domains,
    };
    return {
      kind: 'owner',
      opened,
      openedProfile,
      sourceOwner,
      targetOwner,
      currentPreview,
      strategy,
      domains,
      skipped,
      summary,
      preflightFingerprint: sha256(canonicalJson(fingerprintShape)),
    };
  }

  function prepare(input = {}) {
    const strategy = normalizeStrategy(input.strategy || input.conflictMode || input.conflict_mode);
    const bytes = packageBytesFromInput(input, { stagingDirectory });
    let opened;
    try {
      opened = openDataBackupPackage({ bytes, passphrase: input.passphrase });
      const expectedPackageSha256 = normalizeText(input.packageSha256 || input.package_sha256);
      if (expectedPackageSha256 && (
        !isSha256(expectedPackageSha256)
        || expectedPackageSha256 !== opened.packageSha256
      )) fail('DATA_BACKUP_IMPORT_PACKAGE_HASH_MISMATCH');
      const expectedPackageBytes = input.packageBytes ?? input.package_bytes;
      if (expectedPackageBytes !== undefined && expectedPackageBytes !== null && expectedPackageBytes !== '') {
        const byteCount = Number(expectedPackageBytes);
        if (!Number.isSafeInteger(byteCount) || byteCount <= 0 || byteCount !== opened.packageBytes) {
          fail('DATA_BACKUP_IMPORT_PACKAGE_SIZE_MISMATCH');
        }
      }
      const openedProfile = openOwnerScopedRecoveryProfileCandidate({
        candidate: opened.profileCandidate,
        owner: opened.owner,
        encryptionKey: opened.keyset.chunkEncryptionKey,
        aad: opened.aad,
      });
      if (opened.owner.ownerType !== 'ozon_shop') {
        return prepareGenericOwner(opened, openedProfile, input, strategy);
      }
      const source = assertSourceIdentity(opened, openedProfile);
      const requestedTargetShopId = normalizeText(input.targetShopId || input.target_shop_id);
      const target = findTargetShop(source.externalIdentityHash, requestedTargetShopId);
      const currentPreview = targetPreview(target);
      const genericPlan = shopImporter.planShopCandidate({
        candidate: opened.shopCandidate,
        encryptionKey: opened.keyset.chunkEncryptionKey,
        aad: opened.aad,
        expectedShopId: source.sourceShopId,
        targetShopId: target.id,
        strategy,
      });
      const profilePlan = buildProfilePlan(db, openedProfile, {
        sourceShopId: source.sourceShopId,
        targetShopId: target.id,
        strategy,
      });
      const domains = combinedPlanDomains(opened, genericPlan, profilePlan);
      const skipped = skippedSummary(domains);
      const summary = countSummary(domains);
      const fingerprintShape = {
        version: 1,
        source: {
          backupId: opened.backupId,
          packageSha256: opened.packageSha256,
          dataFingerprint: opened.dataFingerprint,
        },
        target: {
          profileId: target.profile_id,
          shopId: target.id,
          shopIncarnation: target.shop_incarnation,
          credentialRevision: Number(target.credential_revision),
          dataFingerprint: currentPreview.dataFingerprint,
        },
        strategy,
        domains,
        skipped,
      };
      return {
        kind: 'ozon-shop',
        opened,
        openedProfile,
        source,
        target,
        credentialSnapshot: credentialSnapshot(target),
        currentPreview,
        strategy,
        genericPlan,
        profilePlan,
        domains,
        skipped,
        summary,
        preflightFingerprint: sha256(canonicalJson(fingerprintShape)),
      };
    } catch (error) {
      wipeOpenedPackage(opened);
      throw error;
    }
  }

  function publicPreflight(prepared) {
    if (prepared.kind === 'owner') {
      return {
        ok: true,
        command: 'preflight',
        mode: 'read-only-owner-preflight',
        source: {
          backupId: prepared.opened.backupId,
          createdAt: prepared.opened.createdAt,
          packageSha256: prepared.opened.packageSha256,
          packageBytes: prepared.opened.packageBytes,
          dataFingerprint: prepared.opened.dataFingerprint,
          totalRecords: prepared.summary.total,
        },
        sourceOwner: prepared.sourceOwner,
        targetOwner: {
          ...prepared.targetOwner,
          ownerTypeLabel: getDataBackupOwnerTypeLabel(prepared.targetOwner.ownerType),
          displayName: prepared.currentPreview?.displayName || prepared.sourceOwner.displayName,
          exists: Boolean(prepared.currentPreview),
        },
        strategy: prepared.strategy,
        conflictMode: prepared.strategy,
        domains: prepared.domains,
        skipped: prepared.skipped,
        summary: prepared.summary,
        totalRecords: prepared.summary.total,
        packageVersion: prepared.opened.packageVersion || 1,
        createdAt: prepared.opened.createdAt,
        requiresConfirmation: true,
        targetDataFingerprint: prepared.currentPreview?.dataFingerprint || null,
        preflightFingerprint: prepared.preflightFingerprint,
        previewFingerprint: prepared.preflightFingerprint,
      };
    }
    return {
      ok: true,
      command: 'preflight',
      mode: 'read-only-preflight',
      source: {
        backupId: prepared.opened.backupId,
        createdAt: prepared.opened.createdAt,
        packageSha256: prepared.opened.packageSha256,
        packageBytes: prepared.opened.packageBytes,
        dataFingerprint: prepared.opened.dataFingerprint,
        totalRecords: prepared.domains.reduce((total, domain) => total + domain.recordCount, 0),
      },
      sourceShop: {
        shopId: prepared.source.sourceShopId,
        displayName: prepared.source.displayName,
      },
      target: {
        shopId: prepared.target.id,
        displayName: normalizeText(prepared.target.alias) || normalizeText(prepared.target.name) || prepared.target.id,
        shopIncarnation: prepared.target.shop_incarnation,
        credentialRevision: Number(prepared.target.credential_revision),
      },
      targetShop: {
        shopId: prepared.target.id,
        displayName: normalizeText(prepared.target.alias) || normalizeText(prepared.target.name) || prepared.target.id,
      },
      strategy: prepared.strategy,
      conflictMode: prepared.strategy,
      domains: prepared.domains,
      skipped: prepared.skipped,
      summary: prepared.summary,
      totalRecords: prepared.summary.total,
      packageVersion: prepared.opened.packageVersion || 1,
      createdAt: prepared.opened.createdAt,
      requiresConfirmation: true,
      targetDataFingerprint: prepared.currentPreview.dataFingerprint,
      restoreSafety: storageAdapter.getImportSafety({ shopId: prepared.target.id, domains: prepared.genericPlan.domains }),
      preflightFingerprint: prepared.preflightFingerprint,
      previewFingerprint: prepared.preflightFingerprint,
    };
  }

  function preflight(input = {}) {
    const prepared = prepare(input);
    try {
      return publicPreflight(prepared);
    } finally {
      wipeOpenedPackage(prepared.opened);
    }
  }

  function confirm(input = {}) {
    const suppliedFingerprint = normalizeText(
      input.preflightFingerprint
        || input.preflight_fingerprint
        || input.previewFingerprint
        || input.preview_fingerprint,
    );
    if (!isSha256(suppliedFingerprint)) fail('DATA_BACKUP_IMPORT_PREFLIGHT_REQUIRED');
    let prepared;
    let importSession;
    try {
      // Resolve and attach before BEGIN; then repeat preflight under that same
      // connection/transaction so authority readback observes uncommitted rows.
      const admission = prepare(input);
      try {
        importSession = storageAdapter.openImportSession({
          shopId: admission.kind === 'ozon-shop' ? admission.target.id : undefined,
          domains: admission.genericPlan?.domains,
        });
      } finally { wipeOpenedPackage(admission.opened); }
      db.exec('BEGIN IMMEDIATE');
      prepared = prepare(input);
      if (prepared.preflightFingerprint !== suppliedFingerprint) {
        fail('DATA_BACKUP_IMPORT_PREFLIGHT_STALE');
      }
      if (prepared.kind === 'owner') {
        const profileResult = profileImporter.importCandidate({
          candidate: prepared.opened.profileCandidate,
          encryptionKey: prepared.opened.keyset.chunkEncryptionKey,
          aad: prepared.opened.aad,
          manageTransaction: false,
          targetProfileId,
          preserveExistingShops: true,
          preserveShopCredentials: true,
          missingPurchaseAccount: 'error',
          mergeStrategy: prepared.strategy,
        });
        const resultPreview = dataBackupService.previewOwner(prepared.targetOwner)?.owner;
        if (!resultPreview || !isSha256(resultPreview.dataFingerprint)) {
          fail('DATA_BACKUP_IMPORT_TARGET_READBACK_FAILED');
        }
        const resultCounts = new Map(
          resultPreview.domains.map((domain) => [domain.domain, Number(domain.recordCount) || 0]),
        );
        if (prepared.domains.some((domain) => (
          (resultCounts.get(domain.domain) || 0) < Number(domain.recordCount || 0)
        ))) fail('DATA_BACKUP_IMPORT_TARGET_READBACK_FAILED');
        const importId = normalizeText(createImportId());
        if (!importId) fail('DATA_BACKUP_IMPORT_ID_INVALID');
        const completedAt = timestampNow();
        const status = prepared.skipped.total > 0 ? 'completed_with_skips' : 'completed';
        const ownerRef = createAccountRemovalOwnerRef(prepared.targetOwner);
        db.prepare(`
          INSERT INTO data_backup_owner_imports (
            import_id, source_backup_id, package_sha256, source_data_fingerprint,
            target_profile_id, owner_type, owner_ref, owner_incarnation, strategy,
            preflight_fingerprint, result_data_fingerprint, status,
            domain_summary_json, skipped_summary_json, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          importId,
          prepared.opened.backupId,
          prepared.opened.packageSha256,
          prepared.opened.dataFingerprint,
          targetProfileId,
          prepared.targetOwner.ownerType,
          ownerRef,
          resultPreview.ownerIncarnation || prepared.sourceOwner.ownerIncarnation,
          prepared.strategy,
          suppliedFingerprint,
          resultPreview.dataFingerprint,
          status,
          JSON.stringify(prepared.domains),
          JSON.stringify(prepared.skipped),
          completedAt,
          completedAt,
        );
        const recorded = db.prepare(`
          SELECT import_id, status, result_data_fingerprint
          FROM data_backup_owner_imports WHERE import_id = ?
        `).get(importId);
        if (
          recorded?.import_id !== importId
          || recorded.status !== status
          || recorded.result_data_fingerprint !== resultPreview.dataFingerprint
        ) fail('DATA_BACKUP_IMPORT_AUDIT_READBACK_FAILED');
        db.exec('COMMIT');
        return {
          ok: true,
          command: 'confirm',
          mode: 'transactional-owner-restore',
          importId,
          status,
          verified: true,
          restored: true,
          completedAt,
          strategy: prepared.strategy,
          conflictMode: prepared.strategy,
          targetOwner: {
            ...prepared.targetOwner,
            ownerTypeLabel: getDataBackupOwnerTypeLabel(prepared.targetOwner.ownerType),
            displayName: resultPreview.displayName || prepared.sourceOwner.displayName,
          },
          domains: prepared.domains,
          skipped: prepared.skipped,
          summary: prepared.summary,
          totalRecords: prepared.summary.total,
          requiresRefresh: true,
          profileResult,
          sourceDataFingerprint: prepared.opened.dataFingerprint,
          previousDataFingerprint: prepared.currentPreview?.dataFingerprint || null,
          resultDataFingerprint: resultPreview.dataFingerprint,
        };
      }
      const profileResult = profileImporter.importCandidate({
        candidate: prepared.opened.profileCandidate,
        encryptionKey: prepared.opened.keyset.chunkEncryptionKey,
        aad: prepared.opened.aad,
        manageTransaction: false,
        shopIdMap: { [prepared.source.sourceShopId]: prepared.target.id },
        targetProfileId,
        preserveExistingShops: true,
        preserveShopCredentials: true,
        missingPurchaseAccount: 'skip',
        mergeStrategy: prepared.strategy,
      });
      const genericResult = shopImporter.importShopCandidate({
        candidate: prepared.opened.shopCandidate,
        encryptionKey: prepared.opened.keyset.chunkEncryptionKey,
        aad: prepared.opened.aad,
        expectedShopId: prepared.source.sourceShopId,
        targetShopId: prepared.target.id,
        strategy: prepared.strategy,
        manageTransaction: false,
      });
      assertGenericPlanApplied(prepared.genericPlan, genericResult);
      importSession.markWritten(genericResult.domains);
      assertProfileReadback(db, prepared.profilePlan.expectedReadback, { decryptShopSecret });
      const targetAfter = db.prepare(`
        SELECT id, client_id, api_key_encrypted, status, profile_id,
          external_identity_hash, shop_incarnation, credential_revision, disabled_at
        FROM shops WHERE profile_id = ? AND id = ?
      `).get(targetProfileId, prepared.target.id);
      assertCredentialSnapshotUnchanged(prepared.credentialSnapshot, targetAfter);
      const resultPreview = targetPreview(prepared.target);
      const importId = normalizeText(createImportId());
      if (!importId) fail('DATA_BACKUP_IMPORT_ID_INVALID');
      const completedAt = timestampNow();
      const status = prepared.skipped.total > 0 ? 'completed_with_skips' : 'completed';
      db.prepare(`
        INSERT INTO data_backup_imports (
          import_id, source_backup_id, package_sha256, source_data_fingerprint,
          target_profile_id, shop_id, target_shop_incarnation, strategy,
          preflight_fingerprint, result_data_fingerprint, status,
          domain_summary_json, skipped_summary_json, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        importId,
        prepared.opened.backupId,
        prepared.opened.packageSha256,
        prepared.opened.dataFingerprint,
        targetProfileId,
        prepared.target.id,
        prepared.target.shop_incarnation,
        prepared.strategy,
        suppliedFingerprint,
        resultPreview.dataFingerprint,
        status,
        JSON.stringify(prepared.domains),
        JSON.stringify(prepared.skipped),
        completedAt,
        completedAt,
      );
      const recorded = db.prepare(`
        SELECT import_id, status, result_data_fingerprint
        FROM data_backup_imports WHERE import_id = ?
      `).get(importId);
      if (
        recorded?.import_id !== importId
        || recorded.status !== status
        || recorded.result_data_fingerprint !== resultPreview.dataFingerprint
      ) fail('DATA_BACKUP_IMPORT_AUDIT_READBACK_FAILED');
      db.exec('COMMIT');
      let cacheInvalidated = true;
      try {
        invalidateProductCache(prepared.target.id);
      } catch {
        // SQLite is already committed and verified.  A cache invalidation
        // failure must not turn a successful import into a false rollback;
        // requiresRefresh remains true so the caller can reload explicitly.
        cacheInvalidated = false;
      }
      return {
        ok: true,
        command: 'confirm',
        mode: 'transactional-merge',
        importId,
        status,
        verified: true,
        restored: true,
        completedAt,
        strategy: prepared.strategy,
        conflictMode: prepared.strategy,
        target: {
          shopId: prepared.target.id,
          displayName: normalizeText(prepared.target.alias) || normalizeText(prepared.target.name) || prepared.target.id,
          shopIncarnation: prepared.target.shop_incarnation,
          credentialRevision: Number(prepared.target.credential_revision),
        },
        targetShop: {
          shopId: prepared.target.id,
          displayName: normalizeText(prepared.target.alias) || normalizeText(prepared.target.name) || prepared.target.id,
        },
        domains: prepared.domains,
        skipped: prepared.skipped,
        summary: prepared.summary,
        totalRecords: prepared.summary.total,
        requiresRefresh: true,
        cacheInvalidated,
        profileResult: {
          skippedPurchaseTasks: Number(profileResult.skippedPurchaseTasks) || 0,
          skippedPurchaseReceipts: Number(profileResult.skippedPurchaseReceipts) || 0,
          preservedPurchaseTasks: Number(profileResult.preservedPurchaseTasks) || 0,
          preservedPurchaseReceipts: Number(profileResult.preservedPurchaseReceipts) || 0,
          preservedPurchaseCompletionHistory: Number(profileResult.preservedPurchaseCompletionHistory) || 0,
        },
        sourceDataFingerprint: prepared.opened.dataFingerprint,
        previousDataFingerprint: prepared.currentPreview.dataFingerprint,
        resultDataFingerprint: resultPreview.dataFingerprint,
      };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction may not have started */ }
      throw error;
    } finally {
      wipeOpenedPackage(prepared?.opened);
      importSession?.dispose();
    }
  }

  function history({ shopId: shopIdInput, limit = 20 } = {}) {
    const shopId = normalizeText(shopIdInput);
    if (!shopId) fail('DATA_BACKUP_IMPORT_TARGET_SHOP_REQUIRED');
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const imports = db.prepare(`
      SELECT import_id, source_backup_id, package_sha256,
        source_data_fingerprint, target_shop_incarnation, strategy,
        preflight_fingerprint, result_data_fingerprint, status,
        domain_summary_json, skipped_summary_json, created_at, completed_at
      FROM data_backup_imports
      WHERE target_profile_id = ? AND shop_id = ?
      ORDER BY completed_at DESC, import_id DESC
      LIMIT ?
    `).all(targetProfileId, shopId, safeLimit).map((row) => {
      let domains = [];
      let skipped = {};
      try { domains = JSON.parse(row.domain_summary_json || '[]'); } catch { /* fail visibly empty */ }
      try { skipped = JSON.parse(row.skipped_summary_json || '{}'); } catch { /* fail visibly empty */ }
      const safeDomains = Array.isArray(domains) ? domains : [];
      return {
        importId: row.import_id,
        sourceBackupId: row.source_backup_id,
        packageSha256: row.package_sha256,
        sourceDataFingerprint: row.source_data_fingerprint,
        targetShopIncarnation: row.target_shop_incarnation,
        strategy: row.strategy,
        conflictMode: row.strategy,
        previewFingerprint: row.preflight_fingerprint,
        resultDataFingerprint: row.result_data_fingerprint,
        status: row.status,
        verified: true,
        domains: safeDomains,
        totalRecords: safeDomains.reduce((total, domain) => total + (Number(domain.recordCount) || 0), 0),
        summary: countSummary(safeDomains),
        skipped: skipped && typeof skipped === 'object' && !Array.isArray(skipped) ? skipped : {},
        createdAt: row.created_at,
        completedAt: row.completed_at,
      };
    });
    return { ok: true, shopId, imports };
  }

  function ownerHistory({ owner: ownerInput, limit = 20 } = {}) {
    const owner = {
      ownerType: normalizeText(ownerInput?.ownerType || ownerInput?.owner_type),
      ownerId: normalizeText(ownerInput?.ownerId || ownerInput?.owner_id),
    };
    if (!owner.ownerType || !owner.ownerId) fail('DATA_BACKUP_IMPORT_TARGET_OWNER_REQUIRED');
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const ownerRef = createAccountRemovalOwnerRef(owner);
    const imports = db.prepare(`
      SELECT import_id, source_backup_id, package_sha256,
        source_data_fingerprint, owner_incarnation, strategy,
        preflight_fingerprint, result_data_fingerprint, status,
        domain_summary_json, skipped_summary_json, created_at, completed_at
      FROM data_backup_owner_imports
      WHERE target_profile_id = ? AND owner_type = ? AND owner_ref = ?
      ORDER BY completed_at DESC, import_id DESC
      LIMIT ?
    `).all(targetProfileId, owner.ownerType, ownerRef, safeLimit).map((row) => {
      let domains = [];
      let skipped = {};
      try { domains = JSON.parse(row.domain_summary_json || '[]'); } catch { /* public empty */ }
      try { skipped = JSON.parse(row.skipped_summary_json || '{}'); } catch { /* public empty */ }
      const safeDomains = Array.isArray(domains) ? domains : [];
      return {
        importId: row.import_id,
        sourceBackupId: row.source_backup_id,
        packageSha256: row.package_sha256,
        sourceDataFingerprint: row.source_data_fingerprint,
        ownerIncarnation: row.owner_incarnation,
        owner,
        strategy: row.strategy,
        conflictMode: row.strategy,
        previewFingerprint: row.preflight_fingerprint,
        resultDataFingerprint: row.result_data_fingerprint,
        status: row.status,
        verified: true,
        domains: safeDomains,
        totalRecords: safeDomains.reduce((total, domain) => total + (Number(domain.recordCount) || 0), 0),
        summary: countSummary(safeDomains),
        skipped: skipped && typeof skipped === 'object' && !Array.isArray(skipped) ? skipped : {},
        createdAt: row.created_at,
        completedAt: row.completed_at,
      };
    });
    return { ok: true, owner, imports };
  }

  return Object.freeze({ preflight, confirm, history, ownerHistory });
}
