import { ACCOUNT_OWNERSHIP_CATALOG } from '../domain/accountRemoval/accountOwnershipCatalog.js';
import { DATA_DOMAIN_REGISTRY } from './dataDomainRegistry.js';

export const DATA_RESOURCE_REGISTRY_VERSION = 'data-resource-registry-v1';

const REQUIRED_STRING_FIELDS = Object.freeze([
  'id',
  'domain',
  'scopeType',
  'dataClass',
  'source',
  'backup',
  'retentionPolicy',
  'cachePolicy',
  'syncPolicy',
  'ordinaryCacheClearDisposition',
  'spaceReleaseDisposition',
  'accountRemovalDisposition',
  'domainRebuildDisposition',
  'rebuildStrategy',
  'provenancePolicy',
  'physicalResourceType',
  'storageKind',
]);

const SAFE_MEMORY_CACHE = /(?:cache|hot-cache|cursor|inflight|in-flight|dedupe-hash|snapshot-memory)/iu;
const SECRET_OR_CANONICAL_MEMORY = /(?:access-token|auth-token|credential|license-session|secret|settings|context|capture|override)/iu;

function freezeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.freeze({ ...value });
}

function getSourcePolicy(catalogEntry) {
  return DATA_DOMAIN_REGISTRY.find((policy) => policy.domain === catalogEntry.sourceRegistryDomain) || null;
}

function inferDataClass(catalogEntry, sourcePolicy) {
  if (sourcePolicy) return sourcePolicy.dataClass;
  if (catalogEntry.ownerType === 'unknown') return 'unknown-protected';
  if (catalogEntry.storageKind === 'secret-vault') return 'secret';
  if (catalogEntry.storageKind === 'backup-remote') return 'encrypted-backup';
  if (catalogEntry.storageKind === 'runtime') return 'runtime';
  if (
    catalogEntry.storageKind === 'memory'
    && SAFE_MEMORY_CACHE.test(`${catalogEntry.id} ${catalogEntry.resource}`)
    && !SECRET_OR_CANONICAL_MEMORY.test(`${catalogEntry.id} ${catalogEntry.resource}`)
  ) {
    return 'cache';
  }
  if (catalogEntry.storageKind === 'memory') return 'runtime';
  if (catalogEntry.storageKind.startsWith('browser-')) return 'account-artifact';
  if (catalogEntry.storageKind === 'filesystem') return 'physical-artifact';
  return 'fact';
}

function inferSource(catalogEntry, sourcePolicy) {
  if (sourcePolicy) return sourcePolicy.source;
  if (catalogEntry.ownerType === 'unknown') return 'unclassified-protected';
  if (catalogEntry.storageKind === 'backup-remote') return 'encrypted-recovery';
  if (catalogEntry.storageKind === 'filesystem' || catalogEntry.storageKind.startsWith('browser-')) {
    return catalogEntry.ownerType === 'system' ? 'system' : 'user-session';
  }
  return 'system';
}

function ordinaryCacheClearDisposition(catalogEntry, sourcePolicy, dataClass) {
  if (sourcePolicy?.ordinaryCacheClear === 'delete') return 'delete';
  if (catalogEntry.storageKind === 'memory' && dataClass === 'cache') return 'delete';
  return 'preserve';
}

function inferRebuildStrategy(catalogEntry, sourcePolicy, dataClass) {
  if (sourcePolicy) return sourcePolicy.rebuildStrategy;
  if (dataClass === 'cache') return 'recreate-from-canonical-sqlite-or-next-typed-read';
  if (dataClass === 'runtime') return 'recreate-empty-runtime-state-after-owner-fence';
  if (catalogEntry.ownerType === 'unknown') return 'none-until-authoritative-owner-contract-exists';
  if (catalogEntry.storageKind.startsWith('browser-')) return 'recreate-empty-account-partition-after-explicit-rebind';
  return 'none';
}

function createProvenancePolicy(catalogEntry, sourcePolicy) {
  if (sourcePolicy?.provenancePolicy) return sourcePolicy.provenancePolicy;
  const evidence = catalogEntry.sourceEvidence || {};
  return [evidence.sourceFile, evidence.sourceSymbol, evidence.ownerBasis]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' :: ') || 'registered-source-evidence-required';
}

function accountRemovalDisposition(catalogEntry) {
  if (catalogEntry.ownerType === 'unknown') return 'prohibited-unknown-owner-protect';
  if (catalogEntry.removable !== true) return 'preserve';
  return `owner-scoped:${catalogEntry.ownerType}:${catalogEntry.deletePrimitive}`;
}

function createResourceEntry(catalogEntry) {
  const sourcePolicy = getSourcePolicy(catalogEntry);
  const dataClass = inferDataClass(catalogEntry, sourcePolicy);
  const ordinaryClear = ordinaryCacheClearDisposition(catalogEntry, sourcePolicy, dataClass);
  const rebuildStrategy = inferRebuildStrategy(catalogEntry, sourcePolicy, dataClass);
  const rebuildable = sourcePolicy?.rebuildable === true || ['cache', 'runtime'].includes(dataClass);
  const owner = Object.freeze({
    type: catalogEntry.ownerType,
    field: catalogEntry.ownerField,
    scope: catalogEntry.scopeType,
  });
  const sourceEvidence = freezeObject(catalogEntry.sourceEvidence);
  const verifyQuery = freezeObject(catalogEntry.verifyQuery);

  return Object.freeze({
    id: catalogEntry.id,
    domain: sourcePolicy?.domain || `resource:${catalogEntry.id}`,
    resource: catalogEntry.resource,
    scopeType: catalogEntry.scopeType,
    dataClass,
    source: inferSource(catalogEntry, sourcePolicy),
    owner,
    backup: sourcePolicy?.backup || catalogEntry.backupRule,
    retentionPolicy: sourcePolicy?.retentionPolicy || catalogEntry.preserveRule,
    cachePolicy: sourcePolicy?.cachePolicy || (
      ordinaryClear === 'delete'
        ? 'disposable-memory-projection; ordinary cache clear allowed'
        : 'preserve during ordinary cache clear'
    ),
    syncPolicy: sourcePolicy?.syncPolicy || (
      ['cache', 'runtime'].includes(dataClass)
        ? 'never-authoritative; recreate only from typed canonical owner'
        : 'no-sync-without-an-explicit-typed-owner-contract'
    ),
    ordinaryCacheClearDisposition: ordinaryClear,
    spaceReleaseDisposition: sourcePolicy?.spaceReleaseDisposition || (
      ordinaryClear === 'delete' ? 'explicit-space-release-allowed' : 'preserve'
    ),
    accountRemovalDisposition: accountRemovalDisposition(catalogEntry),
    domainRebuildDisposition: sourcePolicy?.domainRebuildDisposition || (
      rebuildable ? 'preview-confirm-rebuild-and-readback' : 'not-rebuildable'
    ),
    rebuildStrategy,
    provenancePolicy: createProvenancePolicy(catalogEntry, sourcePolicy),
    physicalResourceType: sourcePolicy?.physicalResourceType || catalogEntry.storageKind,
    storageKind: catalogEntry.storageKind,
    rebuildable,
    removable: catalogEntry.removable === true,
    availability: catalogEntry.availability,
    coverageAudit: catalogEntry.coverageAudit === true,
    protectionMode: catalogEntry.ownerType === 'unknown' ? 'fail-closed' : 'typed-owner',
    deletePrimitive: catalogEntry.deletePrimitive,
    verifyQuery,
    sourceEvidence,
    sourceRegistryDomain: catalogEntry.sourceRegistryDomain || null,
  });
}

export const DATA_RESOURCE_REGISTRY = Object.freeze(
  ACCOUNT_OWNERSHIP_CATALOG.map(createResourceEntry),
);

const BY_ID = new Map(DATA_RESOURCE_REGISTRY.map((entry) => [entry.id, entry]));

export function getDataResource(id) {
  const entry = BY_ID.get(String(id || '').trim());
  if (!entry) throw new Error('DATA_RESOURCE_UNREGISTERED');
  return entry;
}

export function listDataResources({ ownerType, scopeType, dataClass, storageKind } = {}) {
  return DATA_RESOURCE_REGISTRY.filter((entry) => (
    (!ownerType || entry.owner.type === ownerType)
    && (!scopeType || entry.scopeType === scopeType)
    && (!dataClass || entry.dataClass === dataClass)
    && (!storageKind || entry.physicalResourceType === storageKind)
  ));
}

export function getOrdinaryCacheClearResourceIds() {
  return DATA_RESOURCE_REGISTRY
    .filter((entry) => entry.ordinaryCacheClearDisposition === 'delete')
    .map((entry) => entry.id)
    .sort();
}

export function getAccountRemovalResourceIds(ownerType) {
  return DATA_RESOURCE_REGISTRY
    .filter((entry) => (
      entry.owner.type === ownerType
      && entry.availability === 'current'
      && entry.removable === true
    ))
    .map((entry) => entry.id)
    .sort();
}

export function assertAccountRemovalAllowlistReconciled(ownerType, resourceIds = []) {
  const expected = getAccountRemovalResourceIds(ownerType);
  const actual = [...new Set(resourceIds.map((id) => String(id || '').trim()).filter(Boolean))].sort();
  if (actual.some((id) => !BY_ID.has(id))) throw new Error('DATA_RESOURCE_DELETE_ALLOWLIST_UNKNOWN');
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new Error('DATA_RESOURCE_DELETE_ALLOWLIST_DRIFT');
  }
  return Object.freeze({ ok: true, ownerType, resourceIds: Object.freeze(actual) });
}

export function validateDataResourceRegistry(entries = DATA_RESOURCE_REGISTRY) {
  const ids = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('DATA_RESOURCE_ENTRY_INVALID');
    }
    for (const field of REQUIRED_STRING_FIELDS) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) {
        throw new Error(`DATA_RESOURCE_FIELD_REQUIRED:${entry.id || 'unknown'}:${field}`);
      }
    }
    if (ids.has(entry.id)) throw new Error('DATA_RESOURCE_DUPLICATE');
    if (!entry.owner || typeof entry.owner !== 'object' || !entry.owner.type || !entry.owner.field) {
      throw new Error(`DATA_RESOURCE_OWNER_REQUIRED:${entry.id}`);
    }
    if (entry.owner.type === 'unknown') {
      if (entry.removable || entry.ordinaryCacheClearDisposition !== 'preserve') {
        throw new Error(`DATA_RESOURCE_UNKNOWN_MUST_PROTECT:${entry.id}`);
      }
      if (entry.accountRemovalDisposition !== 'prohibited-unknown-owner-protect') {
        throw new Error(`DATA_RESOURCE_UNKNOWN_DELETE_POLICY_INVALID:${entry.id}`);
      }
    }
    if (entry.ordinaryCacheClearDisposition === 'delete') {
      if (entry.dataClass !== 'cache' || entry.backup !== 'excluded' || entry.rebuildable !== true) {
        throw new Error(`DATA_RESOURCE_CACHE_CLEAR_UNSAFE:${entry.id}`);
      }
    }
    ids.add(entry.id);
  }

  const catalogIds = ACCOUNT_OWNERSHIP_CATALOG.map((entry) => entry.id).sort();
  const registryIds = [...ids].sort();
  if (
    catalogIds.length !== registryIds.length
    || catalogIds.some((id, index) => id !== registryIds[index])
  ) {
    throw new Error('DATA_RESOURCE_OWNERSHIP_CATALOG_DRIFT');
  }
  for (const policy of DATA_DOMAIN_REGISTRY) {
    const resource = entries.find((entry) => entry.sourceRegistryDomain === policy.domain);
    if (!resource) throw new Error(`DATA_RESOURCE_SQLITE_DOMAIN_MISSING:${policy.domain}`);
    // The ownership catalog may refine a system table to a row-level shop
    // selector (for example nullable shop_id technical rows).  Data class and
    // backup semantics must remain identical; the more precise owner scope is
    // deliberately retained on the unified resource entry.
    if (resource.dataClass !== policy.dataClass || resource.backup !== policy.backup) {
      throw new Error(`DATA_RESOURCE_SQLITE_DOMAIN_DRIFT:${policy.domain}`);
    }
  }
  return Object.freeze({
    ok: true,
    version: DATA_RESOURCE_REGISTRY_VERSION,
    resources: entries.length,
    sqliteDomains: DATA_DOMAIN_REGISTRY.length,
    unknownProtected: entries.filter((entry) => entry.owner.type === 'unknown').length,
    audited: entries.filter((entry) => entry.coverageAudit).length,
  });
}

export const DATA_RESOURCE_REGISTRY_VALIDATION = validateDataResourceRegistry();
