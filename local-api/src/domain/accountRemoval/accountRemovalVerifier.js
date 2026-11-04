import {
  observeAccountRemovalSqliteResource,
  observeCrossBorderPreferenceResource,
  observeOzonShopPreferenceResource,
  observePurchasePluginContextResource,
  observePurchasePluginAccountContextResource,
} from './accountRemovalEvidence.js';
import {
  getAccountRemovalClientResourceIds,
  isAccountRemovalServerVerifiedClientResource,
} from './accountRemovalClientResources.js';
import { getAccountRemovalSqliteResourceById } from './accountRemovalSqliteCatalog.js';

export function createAccountRemovalVerifier({ db, runtimeCoordinator, shopStorageLifecycle = null } = {}) {
  if (!db) throw new Error('ACCOUNT_REMOVAL_DATABASE_REQUIRED');

  function verifyServer(owner, preview, { scopeToken = null } = {}) {
    const failures = [];
    const observations = [];
    const clientIds = new Set(getAccountRemovalClientResourceIds(owner.ownerType));
    for (const entry of preview.plannedResources) {
      if (clientIds.has(entry.id)) continue;
      if (['filesystem:shop-database-scope', 'filesystem:shop-aggregate-index-scope'].includes(entry.id)) {
        const current = {
          resourceId: entry.id,
          ...(shopStorageLifecycle?.observeResource?.({ owner, scopeToken, resourceId: entry.id }) || { state: 'absent' }),
        };
        observations.push(current);
        if (current.state !== 'absent') failures.push(entry.id);
        continue;
      }
      const descriptor = getAccountRemovalSqliteResourceById(owner.ownerType, entry.id);
      if (descriptor) {
        const current = { resourceId: entry.id, ...observeAccountRemovalSqliteResource(db, descriptor, owner.ownerId) };
        observations.push(current);
        if (current.state !== 'absent') failures.push(entry.id);
        continue;
      }
      if (entry.id === 'logical:profile-settings-ozon-shop-preferences') {
        const current = { resourceId: entry.id, ...observeOzonShopPreferenceResource(db, owner.ownerId) };
        observations.push(current);
        if (current.state !== 'absent') failures.push(entry.id);
        continue;
      }
      if (entry.id === 'logical:profile-settings-cross-border-preferences') {
        const current = { resourceId: entry.id, ...observeCrossBorderPreferenceResource(db, owner.ownerId) };
        observations.push(current);
        if (current.state !== 'absent') failures.push(entry.id);
        continue;
      }
      if (entry.id === 'logical:profile-settings-purchase-plugin-context') {
        const current = { resourceId: entry.id, ...observePurchasePluginContextResource(db, owner.ownerId) };
        observations.push(current);
        if (current.state !== 'absent') failures.push(entry.id);
      }
      if (entry.id === 'logical:profile-settings-purchase-account-context') {
        const current = { resourceId: entry.id, ...observePurchasePluginAccountContextResource(db, owner.ownerId) };
        observations.push(current);
        if (current.state !== 'absent') failures.push(entry.id);
      }
    }
    const runtime = runtimeCoordinator?.verify?.(owner) || { ok: true, failures: [] };
    if (!runtime.ok) failures.push(...runtime.failures.map((failure) => `runtime:${failure}`));
    return { ok: failures.length === 0, failures, observations, runtime };
  }

  function verifyClientProof(owner, operation, proof = {}) {
    const expectedIds = getAccountRemovalClientResourceIds(owner.ownerType).sort();
    if (proof.operationId !== operation.operationId || proof.nonce !== operation.clientCleanupNonce) {
      return { ok: false, failures: ['challenge-mismatch'] };
    }
    if (proof.previewFingerprint !== operation.previewFingerprint || !Array.isArray(proof.resourceObservations)) {
      return { ok: false, failures: ['preview-mismatch'] };
    }
    const observations = [...proof.resourceObservations].sort((left, right) => String(left?.resourceId).localeCompare(String(right?.resourceId)));
    if (
      observations.length !== expectedIds.length
      || observations.some((entry, index) => entry?.resourceId !== expectedIds[index] || entry?.state !== 'absent' || Object.keys(entry).some((key) => !['resourceId', 'state'].includes(key)))
    ) {
      return { ok: false, failures: ['resource-readback-mismatch'] };
    }
    const trustedReceipts = operation.payload?.trustedClientResourceReceipts || {};
    const missingTrustedReceipts = expectedIds.filter((resourceId) => (
      isAccountRemovalServerVerifiedClientResource(owner.ownerType, resourceId)
      && trustedReceipts[resourceId]?.verified !== true
    ));
    if (missingTrustedReceipts.length > 0) {
      return { ok: false, failures: ['trusted-resource-receipt-missing'] };
    }
    return { ok: true, failures: [], observations };
  }

  return { verifyClientProof, verifyServer };
}
