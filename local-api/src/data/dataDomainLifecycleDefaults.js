export const DATA_DOMAIN_LIFECYCLE_FIELDS = Object.freeze([
  'ownerPolicy',
  'retentionPolicy',
  'cachePolicy',
  'syncPolicy',
  'accountRemovalDisposition',
  'spaceReleaseDisposition',
  'domainRebuildDisposition',
  'rebuildStrategy',
  'provenancePolicy',
  'physicalResourceType',
]);

function ownerPolicy(policy) {
  if (policy.scopeType === 'shop') return 'owner=shop_id; incarnation and credential revision fenced';
  if (policy.scopeType === 'profile') return 'owner=current-profile; explicit connector rows use their canonical id';
  return 'owner=system; never inferred as a shop-owned resource';
}

function retentionPolicy(policy) {
  if (policy.dataClass === 'runtime') return 'bounded technical retention; preserve until explicit runtime-retention command';
  if (policy.dataClass === 'cache') return 'retain until explicit cache/space/domain command; never infer owner deletion';
  if (policy.scopeType === 'shop') return 'retain canonical value while the owning shop incarnation exists';
  return 'retain for profile lifetime or an explicit owner-specific deletion command';
}

function cachePolicy(policy) {
  if (policy.dataClass !== 'cache') return `canonical-${policy.dataClass}; preserve during ordinary cache clear`;
  return policy.ordinaryCacheClear === 'delete'
    ? 'rebuildable technical cache; ordinary cache clear allowed by registry'
    : 'rebuildable cache; preserve during ordinary clear and remove only by explicit policy';
}

function syncPolicy(policy) {
  if (policy.source === 'ozon') return 'Ozon authoritative; fetch outside transaction, then map/prove/activate atomically';
  if (policy.source === 'user') return 'local user canonical; explicit validated write and readback';
  if (policy.source === 'derived') return 'derive only from canonical SQLite inputs with source hashes';
  if (policy.source === 'external') return 'external read through typed service with timestamp and provenance';
  return 'persistent local state machine; recover and reconcile after restart';
}

function accountRemovalDisposition(policy) {
  if (policy.scopeType === 'shop') return 'delete-with-shop';
  if (policy.domain === 'shops') return 'delete-only-the-confirmed-shop-row; preserve other profile rows';
  if (policy.domain?.endsWith('-accounts')) return 'delete-only-explicit-account-owner; preserve completed shop history';
  return 'preserve';
}

function rebuildStrategy(policy) {
  if (!policy.rebuildable) return 'none';
  if (policy.source === 'ozon') return 'rehydrate-from-ozon-with-contract-mapper-and-provenance-proof';
  if (policy.source === 'derived') return 'recompute-from-canonical-sqlite-inputs';
  if (policy.source === 'external') return 'refetch-through-typed-service-with-provenance';
  return 'recreate-through-owned-runtime-reconciliation';
}

/**
 * Older registry rows pre-date the full lifecycle contract.  Normalize them
 * here rather than leaving cache/deletion code to guess missing policy.  A row
 * may override any default with a stricter domain-specific declaration.
 */
export function applyDataDomainLifecycleDefaults(input = {}) {
  const policy = {
    schemaVersion: 1,
    containsPii: false,
    rebuildable: false,
    ordinaryCacheClear: 'preserve',
    ...input,
  };
  return {
    ownerPolicy: ownerPolicy(policy),
    retentionPolicy: retentionPolicy(policy),
    cachePolicy: cachePolicy(policy),
    syncPolicy: syncPolicy(policy),
    accountRemovalDisposition: accountRemovalDisposition(policy),
    spaceReleaseDisposition: policy.ordinaryCacheClear === 'delete'
      ? 'ordinary-cache-clear-or-explicit-space-release'
      : 'explicit-space-release/domain-rebuild/owner-delete-only',
    domainRebuildDisposition: policy.rebuildable
      ? 'preview-confirm-rebuild-then-canonical-readback'
      : 'not-rebuildable; restore or preserve canonical value',
    rebuildStrategy: rebuildStrategy(policy),
    provenancePolicy: 'source-owner-operation-contract-mapper-responseHash-run-snapshot-observedAt',
    physicalResourceType: 'sqlite-table',
    ...policy,
  };
}
