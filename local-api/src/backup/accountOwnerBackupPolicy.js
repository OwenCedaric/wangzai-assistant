import { DATA_DOMAIN_REGISTRY } from '../data/dataDomainRegistry.js';
import { ACCOUNT_OWNERSHIP_CATALOG } from '../domain/accountRemoval/accountOwnershipCatalog.js';
import {
  getAccountRemovalSqliteResources,
  quoteAccountRemovalIdentifier,
} from '../domain/accountRemoval/accountRemovalSqliteCatalog.js';

const LOGICAL_BACKUP_DOMAIN_BY_RESOURCE = Object.freeze({
  'logical:purchase-browser-receipts-shop-links': 'purchase-browser-receipts',
  'logical:purchase-browser-tasks-shop-links': 'purchase-browser-tasks',
  'logical:profile-settings-ozon-shop-preferences': 'profile-settings',
  'logical:profile-settings-purchase-plugin-context': 'profile-settings',
  'logical:profile-settings-purchase-account-context': 'profile-settings',
  'logical:profile-settings-cross-border-preferences': 'profile-settings',
});

// Migration 089 made the single follow-seller front-login preference a child
// of one integration profile. Account removal already deletes it through the
// foreign key, so it has no separate deletion-catalog entry; portable backup
// still needs an exact owner descriptor to count and verify that required row.
const BACKUP_ONLY_OWNER_DEPENDENCIES = Object.freeze({
  integration_profile: Object.freeze([Object.freeze({
    resourceId: 'registry:follow-seller-login-preferences',
    domain: 'follow-seller-login-preferences',
    verifyQuery: Object.freeze({
      type: 'sqlite-count',
      table: 'follow_seller_login_preferences',
      ownerField: 'profile_id',
    }),
  })]),
});

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function normalizeDataBackupOwner(owner = {}) {
  const ownerType = String(owner?.ownerType || '').trim();
  const ownerId = String(owner?.ownerId || '').trim();
  if (!ownerType || !ownerId) fail('DATA_BACKUP_OWNER_REQUIRED');
  return Object.freeze({ ownerType, ownerId });
}

/**
 * The deletion allowlist tells us which rows belong to an owner; the data
 * registry is the only authority for whether those rows are user data that
 * must be backed up. No owner type receives a hard-coded exemption.
 */
export function selectRequiredAccountOwnerBackupDescriptors(ownerType, {
  registry = DATA_DOMAIN_REGISTRY,
  catalog = ACCOUNT_OWNERSHIP_CATALOG,
} = {}) {
  const policies = new Map(registry.map((policy) => [policy.domain, policy]));
  const descriptors = catalog
    .filter((entry) => (
      entry.ownerType === ownerType
      && entry.removable === true
      && entry.availability === 'current'
      && entry.backupRule === 'required'
    ))
    .map((entry) => {
      const domain = entry.id.startsWith('registry:')
        ? entry.id.slice('registry:'.length)
        : LOGICAL_BACKUP_DOMAIN_BY_RESOURCE[entry.id];
      if (!domain) fail(`DATA_BACKUP_OWNER_LOGICAL_DOMAIN_UNMAPPED:${entry.id}`);
      const policy = policies.get(domain);
      if (!policy || policy.backup !== 'required') {
        fail(`DATA_BACKUP_OWNER_REGISTRY_DRIFT:${entry.id}`);
      }
      const verifyQuery = entry.verifyQuery || {};
      if (
        entry.id.startsWith('registry:')
        && policy.storageAdapter !== 'secret-vault'
        && verifyQuery.table !== policy.canonicalTable
      ) fail(`DATA_BACKUP_OWNER_REGISTRY_DRIFT:${entry.id}`);
      return { resourceId: entry.id, verifyQuery, policy };
    });
  const knownResources = new Set(descriptors.map((descriptor) => descriptor.resourceId));
  for (const dependency of BACKUP_ONLY_OWNER_DEPENDENCIES[ownerType] || []) {
    if (knownResources.has(dependency.resourceId)) continue;
    const policy = policies.get(dependency.domain);
    if (!policy || policy.backup !== 'required') {
      fail(`DATA_BACKUP_OWNER_REGISTRY_DRIFT:${dependency.resourceId}`);
    }
    descriptors.push({
      resourceId: dependency.resourceId,
      verifyQuery: dependency.verifyQuery,
      policy,
    });
  }
  return descriptors.sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${quoteAccountRemovalIdentifier(table)})`)
    .all()
    .map((column) => String(column.name || '')));
}

function sqliteOwnerCount(db, { resourceId, verifyQuery }, ownerId) {
  const table = String(verifyQuery?.table || '').trim();
  const ownerField = String(verifyQuery?.ownerField || '').trim();
  if (!table || !ownerField) fail(`DATA_BACKUP_OWNER_VERIFY_QUERY_INVALID:${resourceId}`);
  if (resourceId === 'registry:shop-credentials') {
    return Number(db.prepare(`
      SELECT COUNT(*) AS count FROM ${quoteAccountRemovalIdentifier(table)}
      WHERE ${quoteAccountRemovalIdentifier(ownerField)} = ?
        AND (
          COALESCE(NULLIF(client_id, ''), '') != ''
          OR COALESCE(NULLIF(api_key_encrypted, ''), '') != ''
        )
    `).get(ownerId)?.count) || 0;
  }
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM ${quoteAccountRemovalIdentifier(table)}
    WHERE ${quoteAccountRemovalIdentifier(ownerField)} = ?
  `).get(ownerId)?.count) || 0;
}

function readPath(value, path) {
  return String(path || '').split('.').reduce((current, key) => (
    current && typeof current === 'object' ? current[key] : undefined
  ), value);
}

function profileSettingPathMatches(value, path, ownerId) {
  if (path.endsWith('[].id')) {
    const rows = readPath(value, path.slice(0, -'[].id'.length));
    return Array.isArray(rows) && rows.some((row) => String(row?.id || '').trim() === ownerId);
  }
  if (path.endsWith('[ownerId]')) {
    const object = readPath(value, path.slice(0, -'[ownerId]'.length));
    return Boolean(object && typeof object === 'object'
      && Object.prototype.hasOwnProperty.call(object, ownerId));
  }
  return String(readPath(value, path) || '').trim() === ownerId;
}

function logicalOwnerCount(db, descriptor, ownerId) {
  const query = descriptor.verifyQuery || {};
  if (query.type === 'sqlite-count') return sqliteOwnerCount(db, descriptor, ownerId);
  if (query.type !== 'json-owner-reference-absence' || !String(query.namespace || '').trim()) {
    fail(`DATA_BACKUP_OWNER_VERIFY_QUERY_INVALID:${descriptor.resourceId}`);
  }
  const row = db.prepare(`SELECT value_json FROM profile_settings WHERE namespace = ?`)
    .get(String(query.namespace).trim());
  if (!row) return 0;
  let value;
  try { value = JSON.parse(row.value_json); } catch { fail('DATA_BACKUP_PROFILE_SETTING_JSON_INVALID'); }
  return (query.paths || []).some((path) => profileSettingPathMatches(value, path, ownerId)) ? 1 : 0;
}

export function inspectRequiredAccountOwnerBackupRows(db, ownerInput, options = {}) {
  if (!db) throw new Error('inspectRequiredAccountOwnerBackupRows requires db.');
  const owner = normalizeDataBackupOwner(ownerInput);
  const descriptors = selectRequiredAccountOwnerBackupDescriptors(owner.ownerType, options);
  const domainCounts = new Map();
  for (const descriptor of descriptors) {
    const sourceDb = owner.ownerType === 'ozon_shop' && !descriptor.resourceId.startsWith('logical:')
      ? options.resolveDomainDatabase?.({ db, shopId: owner.ownerId, policy: descriptor.policy }) || db
      : db;
    const count = descriptor.resourceId.startsWith('logical:')
      ? logicalOwnerCount(sourceDb, descriptor, owner.ownerId)
      : sqliteOwnerCount(sourceDb, descriptor, owner.ownerId);
    const current = domainCounts.get(descriptor.policy.domain) || {
      domain: descriptor.policy.domain,
      schemaVersion: Number(descriptor.policy.schemaVersion ?? 1),
      recordCount: 0,
      containsPii: descriptor.policy.containsPii === true,
    };
    current.recordCount += count;
    domainCounts.set(descriptor.policy.domain, current);
  }
  const domains = [...domainCounts.values()].sort((left, right) => left.domain.localeCompare(right.domain));
  const accountDescriptor = getAccountRemovalSqliteResources(owner.ownerType)
    .find((descriptor) => descriptor.accountRow === true);
  if (!accountDescriptor) fail('DATA_BACKUP_OWNER_ACCOUNT_RESOURCE_MISSING');
  const columns = tableColumns(db, accountDescriptor.table);
  const incarnationColumn = ['shop_incarnation', 'account_incarnation', 'created_at']
    .find((column) => columns.has(column));
  const projection = incarnationColumn
    ? quoteAccountRemovalIdentifier(incarnationColumn)
    : quoteAccountRemovalIdentifier(accountDescriptor.ownerField);
  const account = db.prepare(`
    SELECT ${projection} AS owner_incarnation
    FROM ${quoteAccountRemovalIdentifier(accountDescriptor.table)}
    WHERE ${quoteAccountRemovalIdentifier(accountDescriptor.ownerField)} = ?
  `).get(owner.ownerId);
  if (!account) fail('DATA_BACKUP_OWNER_NOT_FOUND');
  const ownerIncarnation = String(account.owner_incarnation || owner.ownerId).trim();
  if (!ownerIncarnation) fail('DATA_BACKUP_OWNER_INCARNATION_REQUIRED');
  return Object.freeze({
    owner,
    ownerIncarnation,
    domains: Object.freeze(domains.map(Object.freeze)),
    totalRecords: domains.reduce((total, domain) => total + domain.recordCount, 0),
  });
}
