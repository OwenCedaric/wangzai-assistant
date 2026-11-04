import { randomUUID } from 'node:crypto';
import { createRecoveryExporter } from './recoveryExporter.js';
import { createRecoveryGeneration, openRecoveryGeneration } from './recoveryGeneration.js';
import {
  createRecoveryProfileCore,
  listRecoveryProfileOwners,
  removeRecoveryProfileOwner,
} from './recoveryProfileCore.js';
import { deriveRecoveryOwnerRef, deriveRecoveryScopeKey } from './recoveryRemoteClient.js';
import { createRecoveryStorageAdapter } from './recoveryStorageAdapter.js';

function normalizeShopId(value) {
  const shopId = String(value || '').trim();
  if (!shopId) throw new Error('RECOVERY_BACKUP_SHOP_ID_REQUIRED');
  return shopId;
}

function isoTimestamp(value) {
  const timestamp = value instanceof Date ? value.toISOString() : String(value || '').trim();
  if (Number.isNaN(Date.parse(timestamp))) throw new Error('RECOVERY_BACKUP_TIMESTAMP_INVALID');
  return timestamp;
}

function normalizeRemovalOwner(owner = {}) {
  const ownerType = String(owner?.ownerType || '').trim();
  const ownerId = String(owner?.ownerId || '').trim();
  if (!ownerType || !ownerId) throw new Error('RECOVERY_OWNER_PURGE_OWNER_INVALID');
  return { ownerType, ownerId };
}

function ownerRefsForProfile({ candidate, keyset, recoveryAad }) {
  return listRecoveryProfileOwners({
    candidate,
    encryptionKey: keyset.chunkEncryptionKey,
    aad: recoveryAad,
  }).map((owner) => deriveRecoveryOwnerRef({ dedupeKey: keyset.dedupeKey, ...owner })).sort();
}

function remoteGenerationId(generation = {}) {
  const value = String(generation.generation_id || '').trim();
  if (!value) throw new Error('RECOVERY_OWNER_PURGE_GENERATION_INVALID');
  return value;
}

function remoteScopeKey(generation = {}) {
  const value = String(generation.scope_key || '').trim();
  if (!value) throw new Error('RECOVERY_OWNER_PURGE_GENERATION_INVALID');
  return value;
}

/**
 * The only upload path: local candidates -> encrypted opaque generation -> remote commit.
 * The passphrase is needed only at first enrollment; later scheduled runs reuse the local
 * encrypted keyset plus its stored portable envelope and never persist a passphrase.
 */
export function createRecoveryBackupOrchestrator({
  db,
  storageAdapter,
  keysetStore,
  decryptShopSecret,
  hasPendingAccountRemoval = () => false,
  now = () => new Date(),
  createGenerationId = randomUUID,
} = {}) {
  if (!db) throw new Error('createRecoveryBackupOrchestrator requires db.');
  storageAdapter ||= createRecoveryStorageAdapter({ db });
  if (!keysetStore?.readState || !keysetStore?.initialize) {
    throw new Error('createRecoveryBackupOrchestrator requires keysetStore.');
  }
  if (typeof decryptShopSecret !== 'function') {
    throw new Error('createRecoveryBackupOrchestrator requires decryptShopSecret.');
  }
  if (typeof hasPendingAccountRemoval !== 'function') {
    throw new Error('createRecoveryBackupOrchestrator requires hasPendingAccountRemoval to be a function.');
  }

  let accountRemovalFenced = false;
  let activeUploads = 0;

  function pendingAccountRemoval() {
    try {
      return hasPendingAccountRemoval() === true;
    } catch {
      throw new Error('RECOVERY_BACKUP_ACCOUNT_REMOVAL_STATE_UNAVAILABLE');
    }
  }

  function getAccountRemovalStatus() {
    return {
      fenced: accountRemovalFenced || pendingAccountRemoval(),
      active: activeUploads,
    };
  }

  function assertAccountRemovalAdmission() {
    if (getAccountRemovalStatus().fenced) {
      throw new Error('RECOVERY_BACKUP_ACCOUNT_REMOVAL_QUIESCED');
    }
  }

  async function quiesceAccountRemoval(_owner, { timeoutMs = 30_000 } = {}) {
    accountRemovalFenced = true;
    const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 30_000);
    for (;;) {
      const status = getAccountRemovalStatus();
      if (status.active === 0) return { ok: true, ...status };
      if (Date.now() >= deadline) throw new Error('RECOVERY_BACKUP_ACCOUNT_REMOVAL_DRAIN_TIMEOUT');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function releaseAccountRemovalFence() {
    const released = accountRemovalFenced;
    accountRemovalFenced = false;
    return { ok: true, released, ...getAccountRemovalStatus() };
  }

  function buildSnapshotContext({ snapshotDb, state, shopIds } = {}) {
    const { keyset, envelope, recoveryAad } = state;
    const selectedShopIds = Array.isArray(shopIds)
      ? shopIds.map(normalizeShopId)
      : snapshotDb.prepare(`
        SELECT id FROM shops
        WHERE status != 'inactive'
        ORDER BY id
      `).all().map((shop) => normalizeShopId(shop.id));
    if (!selectedShopIds.length) throw new Error('RECOVERY_BACKUP_NO_ACTIVE_SHOPS');

    // One physical SQLite snapshot feeds profile-core and every selected shop
    // candidate. No exporter below can observe the active WAL handle.
    const profileCandidate = createRecoveryProfileCore({
      db: snapshotDb,
      decryptShopSecret,
    }).buildCandidate({
      encryptionKey: keyset.chunkEncryptionKey,
      dedupeKey: keyset.dedupeKey,
      aad: recoveryAad,
    });
    return {
      envelope,
      keyset,
      ownerRefs: ownerRefsForProfile({ candidate: profileCandidate, keyset, recoveryAad }),
      profileCandidate,
      recoveryAad,
      selectedShopIds,
      snapshotDb,
    };
  }

  function buildSnapshotPublication(context, shopId) {
    const { envelope, keyset, ownerRefs, profileCandidate, recoveryAad, snapshotDb } = context;
    const shopCandidate = createRecoveryExporter({ db: snapshotDb, resolveDomainDatabase: storageAdapter.resolveDatabase }).buildShopCandidate({
      shopId,
      encryptionKey: keyset.chunkEncryptionKey,
      dedupeKey: keyset.dedupeKey,
      aad: recoveryAad,
    });
    const transport = createRecoveryGeneration({
      profileCandidate,
      shopCandidate,
      keyEnvelope: envelope,
      encryptionKey: keyset.chunkEncryptionKey,
      dedupeKey: keyset.dedupeKey,
      aad: recoveryAad,
      generationId: createGenerationId(),
      createdAt: isoTimestamp(now()),
    });
    return {
      shopId,
      scopeKey: deriveRecoveryScopeKey({ dedupeKey: keyset.dedupeKey, shopId }),
      ownerRefs,
      transport,
    };
  }

  async function publishSnapshotPublication({ publication, remoteClient, snapshotEvidence }) {
    const committed = await remoteClient.uploadGeneration({
      scopeKey: publication.scopeKey,
      ownerRefs: publication.ownerRefs,
      transport: publication.transport,
    });
    return {
      ok: true,
      shopId: publication.shopId,
      scopeKey: publication.scopeKey,
      logicalCipherBytes: publication.transport.logicalCipherBytes,
      remoteGenerationId: committed?.generation_id || null,
      snapshot: snapshotEvidence,
    };
  }

  async function uploadShop({ shopId: shopIdInput, passphrase, remoteClient } = {}) {
    const shopId = normalizeShopId(shopIdInput);
    if (!remoteClient?.uploadGeneration) throw new Error('RECOVERY_REMOTE_CLIENT_REQUIRED');
    assertAccountRemovalAdmission();
    activeUploads += 1;
    try {
      const state = keysetStore.readState() || keysetStore.initialize({ passphrase });
      const built = storageAdapter.withSnapshot({ shopIds: [shopId] }, (snapshotDb, snapshotEvidence) => {
        const context = buildSnapshotContext({ snapshotDb, state, shopIds: [shopId] });
        return {
          publication: buildSnapshotPublication(context, shopId),
          snapshotEvidence,
        };
      });
      const result = await publishSnapshotPublication({
        publication: built.publication,
        remoteClient,
        snapshotEvidence: built.snapshotEvidence,
      });
      return result;
    } finally {
      activeUploads = Math.max(0, activeUploads - 1);
    }
  }

  async function uploadAllShops({ passphrase, remoteClient } = {}) {
    if (!remoteClient?.uploadGeneration) throw new Error('RECOVERY_REMOTE_CLIENT_REQUIRED');
    assertAccountRemovalAdmission();
    activeUploads += 1;
    let snapshot = null;
    try {
      const state = keysetStore.readState() || keysetStore.initialize({ passphrase });
      snapshot = storageAdapter.createSnapshot();
      const context = buildSnapshotContext({ snapshotDb: snapshot.db, state });
      const results = [];
      // Build, upload, and release one shop transport at a time. The immutable
      // snapshot handle may remain open during network I/O without retaining an
      // active transaction on the live profile database.
      for (const shopId of context.selectedShopIds) {
        const publication = buildSnapshotPublication(context, shopId);
        results.push(await publishSnapshotPublication({
          publication,
          remoteClient,
          snapshotEvidence: snapshot.evidence,
        }));
      }
      return { ok: true, shops: results, snapshot: snapshot.evidence };
    } finally {
      if (snapshot) snapshot.dispose();
      activeUploads = Math.max(0, activeUploads - 1);
    }
  }

  async function purgeAccountOwner({ owner: ownerInput, ownerIncarnation, remoteClient } = {}) {
    const owner = normalizeRemovalOwner(ownerInput);
    const incarnation = String(ownerIncarnation || '').trim();
    if (!incarnation) throw new Error('RECOVERY_OWNER_PURGE_INCARNATION_REQUIRED');
    for (const method of [
      'downloadGeneration',
      'getOwnerPurgeStatus',
      'listGenerations',
      'purgeOwner',
      'uploadGeneration',
    ]) {
      if (typeof remoteClient?.[method] !== 'function') throw new Error('RECOVERY_OWNER_PURGE_REMOTE_REQUIRED');
    }
    const firstList = await remoteClient.listGenerations();
    const state = keysetStore.readState();
    if (!state) {
      if (firstList.length) throw new Error('RECOVERY_OWNER_PURGE_KEYSET_REQUIRED');
      return {
        ok: true,
        verified: true,
        ownerType: owner.ownerType,
        remoteGenerationCount: 0,
        rewrittenGenerationCount: 0,
        deletedGenerationCount: 0,
        tombstoneCount: 0,
      };
    }
    const { keyset, envelope, recoveryAad } = state;
    const targetRefs = new Set([
      deriveRecoveryOwnerRef({
        dedupeKey: keyset.dedupeKey,
        ...owner,
        ownerIncarnation: incarnation,
      }),
    ]);
    let rewrittenGenerationCount = 0;
    let rewritePass = 0;
    for (;;) {
      rewritePass += 1;
      try {
        const generations = rewritePass === 1 ? firstList : await remoteClient.listGenerations();
        for (const generation of generations) {
          const generationId = remoteGenerationId(generation);
          const scopeKey = remoteScopeKey(generation);
          const transport = await remoteClient.downloadGeneration({ generationId });
          const opened = openRecoveryGeneration({
            transport,
            encryptionKey: keyset.chunkEncryptionKey,
            aad: recoveryAad,
          });
          const rewritten = removeRecoveryProfileOwner({
            candidate: opened.profileCandidate,
            owner,
            encryptionKey: keyset.chunkEncryptionKey,
            dedupeKey: keyset.dedupeKey,
            aad: recoveryAad,
          });
          for (const removedOwner of rewritten.removedOwners) {
            targetRefs.add(deriveRecoveryOwnerRef({ dedupeKey: keyset.dedupeKey, ...removedOwner }));
          }
          if (owner.ownerType === 'ozon_shop' && String(opened.shopCandidate?.shopId || '').trim() === owner.ownerId) {
            continue;
          }
          const replacement = createRecoveryGeneration({
            profileCandidate: rewritten.candidate,
            shopCandidate: opened.shopCandidate,
            keyEnvelope: envelope,
            encryptionKey: keyset.chunkEncryptionKey,
            dedupeKey: keyset.dedupeKey,
            aad: recoveryAad,
            generationId: createGenerationId(),
            createdAt: isoTimestamp(now()),
          });
          const ownerRefs = ownerRefsForProfile({
            candidate: rewritten.candidate,
            keyset,
            recoveryAad,
          });
          await remoteClient.uploadGeneration({ scopeKey, ownerRefs, transport: replacement });
          rewrittenGenerationCount += 1;
        }
        break;
      } catch (error) {
        if (!String(error?.message || error).includes('RECOVERY_REMOTE_COMMIT_CONFLICT') || rewritePass >= 3) throw error;
      }
    }

    let deletedGenerationCount = 0;
    for (const ownerRef of [...targetRefs].sort()) {
      let purgeAttempt = 0;
      for (;;) {
        purgeAttempt += 1;
        const expectedGenerationIds = (await remoteClient.listGenerations()).map(remoteGenerationId).sort();
        try {
          const purged = await remoteClient.purgeOwner({ ownerRef, expectedGenerationIds });
          deletedGenerationCount += purged.deletedGenerationIds.length;
          break;
        } catch (error) {
          if (!String(error?.message || error).includes('RECOVERY_REMOTE_OWNER_PURGE_CONFLICT') || purgeAttempt >= 3) throw error;
        }
      }
    }

    const finalGenerations = await remoteClient.listGenerations();
    for (const generation of finalGenerations) {
      const generationRefs = Array.isArray(generation.owner_refs) ? generation.owner_refs : [];
      if (generationRefs.some((ownerRef) => targetRefs.has(ownerRef))) {
        throw new Error('RECOVERY_OWNER_PURGE_READBACK_FAILED');
      }
      const transport = await remoteClient.downloadGeneration({ generationId: remoteGenerationId(generation) });
      const opened = openRecoveryGeneration({
        transport,
        encryptionKey: keyset.chunkEncryptionKey,
        aad: recoveryAad,
      });
      const remainingOwners = listRecoveryProfileOwners({
        candidate: opened.profileCandidate,
        encryptionKey: keyset.chunkEncryptionKey,
        aad: recoveryAad,
      });
      if (
        remainingOwners.some((entry) => entry.ownerType === owner.ownerType && entry.ownerId === owner.ownerId)
        || (owner.ownerType === 'ozon_shop' && String(opened.shopCandidate?.shopId || '').trim() === owner.ownerId)
      ) {
        throw new Error('RECOVERY_OWNER_PURGE_READBACK_FAILED');
      }
    }
    for (const ownerRef of targetRefs) {
      const status = await remoteClient.getOwnerPurgeStatus({ ownerRef });
      if (status.tombstoned !== true) throw new Error('RECOVERY_OWNER_PURGE_READBACK_FAILED');
    }
    return {
      ok: true,
      verified: true,
      ownerType: owner.ownerType,
      remoteGenerationCount: finalGenerations.length,
      rewrittenGenerationCount,
      deletedGenerationCount,
      tombstoneCount: targetRefs.size,
    };
  }

  return {
    getAccountRemovalStatus,
    quiesceAccountRemoval,
    releaseAccountRemovalFence,
    purgeAccountOwner,
    uploadShop,
    uploadAllShops,
  };
}
