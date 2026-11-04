import { openRecoveryGeneration } from './recoveryGeneration.js';
import { openRecoveryKeyEnvelope } from './recoveryKeyEnvelope.js';
import { createRecoveryImporter } from './recoveryImporter.js';
import {
  assertRecoveryProfileCoreCandidateShape,
  createRecoveryProfileCoreImporter,
} from './recoveryProfileCore.js';

function normalizeGenerationIds(value) {
  const source = Array.isArray(value) ? value : [value];
  const ids = source.map((item) => String(item || '').trim()).filter(Boolean);
  if (!ids.length) throw new Error('RECOVERY_GENERATION_ID_REQUIRED');
  if (new Set(ids).size !== ids.length) throw new Error('RECOVERY_GENERATION_ID_DUPLICATE');
  return ids;
}

function profileCoreSignature(candidate) {
  assertRecoveryProfileCoreCandidateShape(candidate);
  const signature = candidate.domains
    .map((domain) => `${domain.domain}:${domain.recordsRootHash}`)
    .sort();
  return signature.join('|');
}

function assertSameKeyset(left, right) {
  if (
    !left
    || !right
    || !Buffer.from(left.chunkEncryptionKey).equals(Buffer.from(right.chunkEncryptionKey))
    || !Buffer.from(left.dedupeKey).equals(Buffer.from(right.dedupeKey))
  ) {
    throw new Error('RESTORE_GENERATION_KEYSET_MISMATCH');
  }
}

/**
 * Stages a remote generation into a caller-provided fresh database. It never switches the
 * active profile/database; that switch remains a separate verified desktop lifecycle step.
 */
export function createRecoveryRestoreOrchestrator({
  keysetStore,
  encryptShopSecret,
  targetProfileId = 'default',
} = {}) {
  if (!keysetStore?.saveState) throw new Error('createRecoveryRestoreOrchestrator requires keysetStore.');
  if (typeof encryptShopSecret !== 'function') {
    throw new Error('createRecoveryRestoreOrchestrator requires encryptShopSecret.');
  }

  async function stageRemoteGeneration({ remoteClient, generationId, passphrase, stagingDb } = {}) {
    return stageRemoteGenerations({
      remoteClient,
      generationIds: [generationId],
      passphrase,
      stagingDb,
    });
  }

  async function stageRemoteGenerations({ remoteClient, generationIds, passphrase, stagingDb } = {}) {
    if (!remoteClient?.downloadGeneration) throw new Error('RECOVERY_REMOTE_CLIENT_REQUIRED');
    if (!stagingDb) throw new Error('RECOVERY_STAGING_DB_REQUIRED');
    const requestedIds = normalizeGenerationIds(generationIds);
    let canonicalKeyset = null;
    let canonicalEnvelope = null;
    let canonicalAad = null;
    let canonicalProfileSignature = null;
    let profile = null;
    const shops = [];
    const openedGenerations = [];
    const importedShopIds = new Set();
    for (const requestedGenerationId of requestedIds) {
      const transport = await remoteClient.downloadGeneration({ generationId: requestedGenerationId });
      const recoveryAad = String(transport?.keyEnvelope?.aad || '').trim();
      const keyset = openRecoveryKeyEnvelope({
        envelope: transport?.keyEnvelope,
        passphrase,
        aad: recoveryAad,
      });
      const opened = openRecoveryGeneration({
        transport,
        encryptionKey: keyset.chunkEncryptionKey,
        aad: recoveryAad,
      });
      const signature = profileCoreSignature(opened.profileCandidate);
      if (!canonicalKeyset) {
        canonicalKeyset = keyset;
        canonicalEnvelope = transport.keyEnvelope;
        canonicalAad = recoveryAad;
        canonicalProfileSignature = signature;
        profile = createRecoveryProfileCoreImporter({
          db: stagingDb,
          encryptShopSecret,
        }).importCandidate({
          candidate: opened.profileCandidate,
          encryptionKey: keyset.chunkEncryptionKey,
          aad: recoveryAad,
          targetProfileId,
        });
      } else {
        if (recoveryAad !== canonicalAad) throw new Error('RESTORE_GENERATION_AAD_MISMATCH');
        assertSameKeyset(canonicalKeyset, keyset);
        if (signature !== canonicalProfileSignature) throw new Error('RESTORE_PROFILE_CORE_MISMATCH');
      }
      const shopId = String(opened.shopCandidate?.shopId || '').trim();
      if (!shopId || importedShopIds.has(shopId)) throw new Error('RESTORE_SHOP_GENERATION_DUPLICATE');
      const shop = createRecoveryImporter({ db: stagingDb }).importShopCandidate({
        candidate: opened.shopCandidate,
        encryptionKey: keyset.chunkEncryptionKey,
        aad: recoveryAad,
        expectedShopId: shopId,
      });
      importedShopIds.add(shopId);
      shops.push(shop);
      openedGenerations.push({ requestedGenerationId, generationId: opened.generationId, shopId });
    }
    // Persist local encrypted key material only after every staging validation succeeds.
    keysetStore.saveState({ keyset: canonicalKeyset, envelope: canonicalEnvelope });
    return {
      ok: true,
      mode: 'staging-only',
      generationId: openedGenerations[0].generationId,
      generationIds: openedGenerations.map((item) => item.generationId),
      requestedGenerationIds: openedGenerations.map((item) => item.requestedGenerationId),
      profile,
      shop: shops[0],
      shops,
    };
  }

  return { stageRemoteGeneration, stageRemoteGenerations };
}
