import { randomUUID } from 'node:crypto';
import { archiveCompletedPurchaseHistoryForAccount } from '../../db/repositories/purchaseCompletionHistoryRepository.js';
import {
  captureCrossBorderPreferencePreservation,
  captureOzonShopPreferencePreservation,
  capturePurchasePluginContextPreservation,
  capturePurchasePluginAccountContextPreservation,
  capturePreservedSqliteRows,
  observeCrossBorderPreferenceResource,
  observeOzonShopPreferenceResource,
  observePurchasePluginContextResource,
  observePurchasePluginAccountContextResource,
  readCrossBorderPreferences,
  readOzonShopPreferences,
  readPurchasePluginContext,
  removeOzonShopPreferenceOwner,
  removePurchasePluginContextOwner,
  removePurchasePluginAccountContextOwner,
  removeCrossBorderPreferenceOwner,
} from './accountRemovalEvidence.js';
import {
  ACCOUNT_REMOVAL_ERROR_CODES,
  AccountRemovalContractError,
  failAccountRemovalContract,
} from './accountRemovalErrors.js';
import {
  assertAccountRemovalSqliteCatalog,
  getAccountRemovalSqliteResources,
  quoteAccountRemovalIdentifier,
} from './accountRemovalSqliteCatalog.js';

function readPragmaNumber(row, key) {
  const value = row?.[key] ?? Object.values(row || {})[0];
  return Number(value);
}

const DELETE_LOCK_WAIT_MS = 2_000;

function isSqliteBusyError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return code.includes('SQLITE_BUSY')
    || code.includes('SQLITE_LOCKED')
    || message.includes('database is locked')
    || message.includes('database is busy');
}

function normalizeSqliteExecutionError(error, step) {
  if (error instanceof AccountRemovalContractError) {
    if (!error.step) error.step = step;
    return error;
  }
  const contractCode = String(error?.message || '').match(/^ACCOUNT_REMOVAL_[A-Z0-9_]+$/u)?.[0];
  if (contractCode) {
    const normalized = new AccountRemovalContractError(contractCode);
    normalized.cause = error;
    normalized.step = step;
    return normalized;
  }
  const code = isSqliteBusyError(error)
    ? ACCOUNT_REMOVAL_ERROR_CODES.DATABASE_BUSY
    : ACCOUNT_REMOVAL_ERROR_CODES.SQLITE_EXECUTION_FAILED;
  const normalized = new AccountRemovalContractError(code);
  normalized.cause = error;
  normalized.step = step;
  normalized.sqliteCode = typeof error?.code === 'string' ? error.code : null;
  return normalized;
}

export function createAccountRemovalSqliteExecutor({ db, now = () => new Date().toISOString() } = {}) {
  if (!db) throw new Error('ACCOUNT_REMOVAL_DATABASE_REQUIRED');
  assertAccountRemovalSqliteCatalog();

  function capturePreservation(owner) {
    const descriptors = getAccountRemovalSqliteResources(owner.ownerType);
    return {
      sqlite: capturePreservedSqliteRows(db, descriptors, owner.ownerId),
      ...(owner.ownerType === 'ozon_shop'
        ? {
            shopPreferences: captureOzonShopPreferencePreservation(db, owner.ownerId),
            purchasePluginContext: capturePurchasePluginContextPreservation(db, owner.ownerId),
          }
        : {}),
      ...(owner.ownerType === 'cross_border_bus'
        ? { crossBorderPreferences: captureCrossBorderPreferencePreservation(db, owner.ownerId) }
        : {}),
      ...(owner.ownerType === 'purchase_account'
        ? { purchaseAccountPluginContext: capturePurchasePluginAccountContextPreservation(db, owner.ownerId) }
        : {}),
    };
  }

  function deleteExactOwnerRows(descriptor, ownerId) {
    const table = quoteAccountRemovalIdentifier(descriptor.table);
    const ownerField = quoteAccountRemovalIdentifier(descriptor.ownerField);
    const result = db.prepare(`DELETE FROM ${table} WHERE ${ownerField} = ?`).run(ownerId);
    return Number(result.changes || 0);
  }

  function assertTargetRowsDeleted(descriptors, ownerId) {
    for (const descriptor of descriptors) {
      const table = quoteAccountRemovalIdentifier(descriptor.table);
      const ownerField = quoteAccountRemovalIdentifier(descriptor.ownerField);
      const count = Number(db.prepare(`
        SELECT COUNT(*) AS count FROM ${table} WHERE ${ownerField} = ?
      `).get(ownerId)?.count || 0);
      if (count !== 0) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.SERVER_VERIFY_FAILED);
    }
    const foreignKeyFailures = db.prepare('PRAGMA foreign_key_check;').all();
    if (foreignKeyFailures.length > 0) {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.SQLITE_EXECUTION_FAILED);
    }
  }

  function applyShopPreferenceRemoval(ownerId) {
    const row = readOzonShopPreferences(db);
    if (!row) return { referencesRemoved: 0, updated: false };
    const before = observeOzonShopPreferenceResource(db, ownerId);
    const nextValue = removeOzonShopPreferenceOwner(row.value, ownerId);
    if (before.state === 'absent') return { referencesRemoved: 0, updated: false };
    db.prepare(`
      UPDATE profile_settings
      SET value_json = ?, updated_at = ?
      WHERE namespace = 'ozon-shop-preferences'
    `).run(JSON.stringify(nextValue), now());
    return { referencesRemoved: Number(before.count || 0), updated: true };
  }

  function applyCrossBorderPreferenceRemoval(ownerId) {
    const row = readCrossBorderPreferences(db);
    if (!row) return { referencesRemoved: 0, updated: false };
    const before = observeCrossBorderPreferenceResource(db, ownerId);
    if (before.state === 'absent') return { referencesRemoved: 0, updated: false };
    const nextValue = removeCrossBorderPreferenceOwner(row.value, ownerId);
    db.prepare(`
      UPDATE profile_settings
      SET value_json = ?, updated_at = ?
      WHERE namespace = 'cross-border-preferences'
    `).run(JSON.stringify(nextValue), now());
    return { referencesRemoved: Number(before.count || 0), updated: true };
  }

  function applyPurchasePluginContextRemoval(ownerId) {
    const row = readPurchasePluginContext(db);
    if (!row) return { referencesRemoved: 0, updated: false };
    const before = observePurchasePluginContextResource(db, ownerId);
    if (before.state === 'absent') return { referencesRemoved: 0, updated: false };
    const nextValue = removePurchasePluginContextOwner(row.value, ownerId);
    db.prepare(`
      UPDATE profile_settings
      SET value_json = ?, updated_at = ?
      WHERE namespace = 'purchase-plugin-context'
    `).run(JSON.stringify(nextValue), now());
    return { referencesRemoved: Number(before.count || 0), updated: true };
  }

  function applyPurchasePluginAccountContextRemoval(ownerId) {
    const row = readPurchasePluginContext(db);
    if (!row) return { referencesRemoved: 0, updated: false };
    const before = observePurchasePluginAccountContextResource(db, ownerId);
    if (before.state === 'absent') return { referencesRemoved: 0, updated: false };
    const nextValue = removePurchasePluginAccountContextOwner(row.value, ownerId);
    db.prepare(`
      UPDATE profile_settings
      SET value_json = ?, updated_at = ?
      WHERE namespace = 'purchase-plugin-context'
    `).run(JSON.stringify(nextValue), now());
    return { referencesRemoved: Number(before.count || 0), updated: true };
  }

  function checkpointPhysicalStorage() {
    const secureDelete = readPragmaNumber(db.prepare('PRAGMA secure_delete;').get(), 'secure_delete');
    if (secureDelete !== 1) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.PHYSICAL_ERASURE_INCOMPLETE);
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get() || {};
    const busy = Number(checkpoint.busy ?? 0);
    const log = Number(checkpoint.log ?? -1);
    const checkpointed = Number(checkpoint.checkpointed ?? -1);
    if (busy !== 0) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.PHYSICAL_ERASURE_INCOMPLETE);
    return { secureDelete: true, checkpoint: { busy, log, checkpointed } };
  }

  function completePhysicalErasure(deletionExecution) {
    if (
      !deletionExecution
      || typeof deletionExecution !== 'object'
      || Array.isArray(deletionExecution)
      || !deletionExecution.deletedRows
      || typeof deletionExecution.deletedRows !== 'object'
      || Array.isArray(deletionExecution.deletedRows)
      || deletionExecution.preservationVerified !== true
    ) {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OPERATION_STATE_INVALID);
    }
    return {
      ...deletionExecution,
      physicalStorage: checkpointPhysicalStorage(),
    };
  }

  function readShopIdentityForTombstone(owner, options = {}) {
    if (owner.ownerType !== 'ozon_shop') return null;
    const row = db.prepare(`
      SELECT id, profile_id, client_id, external_identity_hash, shop_incarnation,
             credential_revision
      FROM shops WHERE id = ?
    `).get(owner.ownerId);
    if (!row) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OPERATION_STATE_INVALID);
    const expected = options.identityLifecycle || {};
    if (
      (expected.profileId && expected.profileId !== row.profile_id)
      || (expected.shopIncarnation && expected.shopIncarnation !== row.shop_incarnation)
      || (options.ownerIncarnation && options.ownerIncarnation !== row.shop_incarnation)
      || (expected.credentialRevision
        && Number(expected.credentialRevision) !== Number(row.credential_revision))
    ) {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OPERATION_STATE_INVALID);
    }
    return {
      profileId: row.profile_id,
      formerShopId: row.id,
      clientId: row.client_id || null,
      externalIdentityHash: row.external_identity_hash || null,
      formerShopIncarnation: row.shop_incarnation,
      finalCredentialRevision: Number(row.credential_revision),
    };
  }

  function insertShopIdentityTombstone(identity, operationId) {
    if (!identity || !operationId) return null;
    const timestamp = now();
    const tombstoneId = `shop_tombstone_${randomUUID()}`;
    db.prepare(`
      INSERT INTO shop_identity_tombstones (
        tombstone_id, profile_id, former_shop_id, external_identity_hash,
        former_shop_incarnation, final_credential_revision,
        deletion_operation_id, deletion_reason, metadata_json,
        deleted_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'permanent_delete', ?, ?, ?)
      ON CONFLICT(deletion_operation_id) DO NOTHING
    `).run(
      tombstoneId,
      identity.profileId,
      identity.formerShopId,
      identity.externalIdentityHash,
      identity.formerShopIncarnation,
      identity.finalCredentialRevision,
      operationId,
      JSON.stringify({
        source: 'account-removal-orchestrator',
        canonicalFactsDeleted: true,
        sharedCatalogPreserved: true,
      }),
      timestamp,
      timestamp,
    );
    return db.prepare(`
      SELECT tombstone_id, deletion_operation_id, deleted_at
      FROM shop_identity_tombstones WHERE deletion_operation_id = ?
    `).get(operationId) || null;
  }

  function execute(owner, { persistDeletionExecution, operationId, ownerIncarnation, identityLifecycle } = {}) {
    const descriptors = getAccountRemovalSqliteResources(owner.ownerType);
    db.exec('PRAGMA secure_delete = ON;');
    const deletedRows = {};
    let profileSettings = { referencesRemoved: 0, updated: false };
    let purchasePluginContext = { referencesRemoved: 0, updated: false };
    const previousBusyTimeout = readPragmaNumber(
      db.prepare('PRAGMA busy_timeout;').get(),
      'timeout',
    );
    let transactionStarted = false;
    let step = 'begin-immediate';
    try {
      db.exec(`PRAGMA busy_timeout = ${DELETE_LOCK_WAIT_MS};`);
      db.exec('BEGIN IMMEDIATE;');
      transactionStarted = true;
      step = 'read-owner-identity';
      const shopIdentity = readShopIdentityForTombstone(owner, {
        ownerIncarnation,
        identityLifecycle,
      });
      // The before/after preservation snapshots are taken under the same
      // BEGIN IMMEDIATE lock. This closes the production race where another
      // writer changed unrelated rows between an unlocked snapshot and the
      // delete transaction.
      step = 'capture-preservation-before';
      const before = capturePreservation(owner);
      if (owner.ownerType === 'purchase_account') {
        step = 'archive-purchase-history';
        archiveCompletedPurchaseHistoryForAccount(db, owner.ownerId, { now });
        step = 'remove-purchase-plugin-account-context';
        purchasePluginContext = applyPurchasePluginAccountContextRemoval(owner.ownerId);
      }
      if (owner.ownerType === 'ozon_shop') {
        step = 'remove-shop-preferences';
        profileSettings = applyShopPreferenceRemoval(owner.ownerId);
        step = 'remove-purchase-plugin-shop-context';
        purchasePluginContext = applyPurchasePluginContextRemoval(owner.ownerId);
      }
      if (owner.ownerType === 'cross_border_bus') {
        step = 'remove-cross-border-preferences';
        profileSettings = applyCrossBorderPreferenceRemoval(owner.ownerId);
      }
      for (const descriptor of descriptors) {
        step = `delete:${descriptor.table}`;
        deletedRows[descriptor.resourceId] = deleteExactOwnerRows(descriptor, owner.ownerId);
      }
      if (owner.ownerType === 'ozon_shop') {
        deletedRows['registry:shop-credentials'] = deletedRows['registry:shops'] || 0;
        deletedRows['logical:profile-settings-ozon-shop-preferences'] = profileSettings.referencesRemoved;
        deletedRows['logical:profile-settings-purchase-plugin-context'] = purchasePluginContext.referencesRemoved;
      }
      if (owner.ownerType === 'cross_border_bus') {
        deletedRows['logical:profile-settings-cross-border-preferences'] = profileSettings.referencesRemoved;
      }
      if (owner.ownerType === 'purchase_account') {
        deletedRows['logical:profile-settings-purchase-account-context'] = purchasePluginContext.referencesRemoved;
      }
      step = 'capture-preservation-after';
      const after = capturePreservation(owner);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.PRESERVATION_MISMATCH);
      }
      step = 'verify-target-scope';
      assertTargetRowsDeleted(descriptors, owner.ownerId);
      step = 'insert-identity-tombstone';
      const identityTombstone = insertShopIdentityTombstone(shopIdentity, operationId);
      const deletionExecution = {
        deletedRows,
        totalDeletedRows: Object.entries(deletedRows)
          .filter(([resourceId]) => resourceId !== 'registry:shop-credentials')
          .reduce((total, [, count]) => total + Number(count || 0), 0),
        preservationVerified: true,
        verificationMode: 'locked-preservation-snapshot-and-target-readback',
        physicalStorage: null,
        ...(identityTombstone ? {
          identityTombstone: {
            tombstoneId: identityTombstone.tombstone_id,
            deletionOperationId: identityTombstone.deletion_operation_id,
            deletedAt: identityTombstone.deleted_at,
          },
        } : {}),
        ...(shopIdentity ? {
          removedOwnerGeneration: {
            ownerId: shopIdentity.formerShopId,
            clientId: shopIdentity.clientId,
            profileId: shopIdentity.profileId,
            shopIncarnation: shopIdentity.formerShopIncarnation,
            credentialRevision: shopIdentity.finalCredentialRevision,
          },
        } : {}),
      };
      if (persistDeletionExecution !== undefined) {
        if (typeof persistDeletionExecution !== 'function') {
          failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OPERATION_STATE_INVALID);
        }
        step = 'persist-deletion-execution';
        persistDeletionExecution(deletionExecution);
      }
      step = 'commit';
      db.exec('COMMIT;');
      transactionStarted = false;
      step = 'physical-erasure';
      return completePhysicalErasure(deletionExecution);
    } catch (error) {
      if (transactionStarted) {
        try { db.exec('ROLLBACK;'); } catch { /* transaction already ended */ }
      }
      throw normalizeSqliteExecutionError(error, step);
    } finally {
      if (Number.isFinite(previousBusyTimeout) && previousBusyTimeout >= 0) {
        try { db.exec(`PRAGMA busy_timeout = ${Math.trunc(previousBusyTimeout)};`); } catch { /* keep primary result */ }
      }
    }
  }

  return { capturePreservation, completePhysicalErasure, execute };
}
