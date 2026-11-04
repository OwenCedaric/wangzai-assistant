import { getDataDomain } from "../data/dataDomainRegistry.js";
import { normalizeProfileSettingValue } from "../db/repositories/profileSettingsRepository.js";
import { removeCrossBorderPreferenceOwner, removeOzonShopPreferenceOwner } from "../domain/accountRemoval/accountRemovalEvidence.js";
import { buildRecoveryRecordKey } from "./recoveryExporter.js";
import { buildEncryptedDomain, openProfileDomain } from "./recoveryProfileCrypto.js";
import {
  assertRecoveryProfileCoreCandidateShape,
  RECOVERY_OWNER_DOMAIN_TYPES,
  RECOVERY_OWNER_PROFILE_DOMAINS,
} from "./recoveryProfileDomains.js";

export function normalizeRemovalOwner(owner = {}) {
  const ownerType = String(owner?.ownerType || '').trim();
  const ownerId = String(owner?.ownerId || '').trim();
  if (!Object.values(RECOVERY_OWNER_DOMAIN_TYPES).includes(ownerType) || !ownerId) {
    throw new Error('RECOVERY_PROFILE_OWNER_INVALID');
  }
  return { ownerType, ownerId };
}

export function profileOwnerFromRecord(domain, record = {}) {
  const ownerType = RECOVERY_OWNER_DOMAIN_TYPES[domain];
  if (!ownerType) return null;
  const value = record?.value || {};
  const ownerId = String(value.id || '').trim();
  const ownerIncarnation = String(value.created_at || '').trim();
  if (!ownerId || !ownerIncarnation) throw new Error('RECOVERY_PROFILE_OWNER_RECORD_INVALID');
  return { ownerType, ownerId, ownerIncarnation };
}

export function hasOzonPreferenceOwner(value = {}, ownerId) {
  const shops = Array.isArray(value.shops) ? value.shops : [];
  const defaults = value.defaultWarehouseIds && typeof value.defaultWarehouseIds === 'object' && !Array.isArray(value.defaultWarehouseIds)
    ? value.defaultWarehouseIds
    : {};
  return shops.some((shop) => String(shop?.id || '').trim() === ownerId)
    || Object.prototype.hasOwnProperty.call(defaults, ownerId)
    || String(value.activeShopId || '').trim() === ownerId;
}

export function hasCrossBorderPreferenceOwner(value = {}, ownerId) {
  return [value.crossBorderAccountId, value.accountId]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .includes(ownerId);
}

export function buildOwnerProfileSettingSlice(record, owner) {
  const row = record?.value || {};
  const namespace = String(row.namespace || '').trim();
  const source = row.value && typeof row.value === 'object' && !Array.isArray(row.value)
    ? row.value
    : {};
  let value = null;
  if (owner.ownerType === 'ozon_shop' && namespace === 'ozon-shop-preferences') {
    if (!hasOzonPreferenceOwner(source, owner.ownerId)) return null;
    const shops = (Array.isArray(source.shops) ? source.shops : [])
      .filter((shop) => String(shop?.id || '').trim() === owner.ownerId);
    const defaults = source.defaultWarehouseIds
      && typeof source.defaultWarehouseIds === 'object'
      && !Array.isArray(source.defaultWarehouseIds)
      && Object.prototype.hasOwnProperty.call(source.defaultWarehouseIds, owner.ownerId)
      ? { [owner.ownerId]: source.defaultWarehouseIds[owner.ownerId] }
      : {};
    value = {
      ...(source.version !== undefined ? { version: source.version } : {}),
      shops,
      ...(String(source.activeShopId || '').trim() === owner.ownerId
        ? { activeShopId: owner.ownerId }
        : {}),
      defaultWarehouseIds: defaults,
    };
  } else if (
    owner.ownerType === 'ozon_shop'
    && namespace === 'purchase-plugin-context'
    && String(source?.context?.shopId || '').trim() === owner.ownerId
  ) {
    value = source;
  } else if (
    owner.ownerType === 'cross_border_bus'
    && namespace === 'cross-border-preferences'
    && hasCrossBorderPreferenceOwner(source, owner.ownerId)
  ) {
    value = {
      ...(source.version !== undefined ? { version: source.version } : {}),
      ...(String(source.crossBorderAccountId || '').trim() === owner.ownerId
        ? { crossBorderAccountId: owner.ownerId }
        : {}),
      ...(String(source.accountId || '').trim() === owner.ownerId
        ? { accountId: owner.ownerId }
        : {}),
    };
  }
  if (!value) return null;
  const nextRow = { ...row, value };
  return {
    key: buildRecoveryRecordKey(getDataDomain('profile-settings'), nextRow),
    value: nextRow,
  };
}

export function isOwnerScopedProfileSettingRecord(record, owner) {
  const row = record?.value || {};
  if (
    buildRecoveryRecordKey(getDataDomain('profile-settings'), row) !== record?.key
    || Object.keys(row).some((key) => !['namespace', 'value', 'created_at', 'updated_at'].includes(key))
  ) return false;
  const value = row.value && typeof row.value === 'object' && !Array.isArray(row.value)
    ? row.value
    : {};
  if (owner.ownerType === 'ozon_shop' && row.namespace === 'ozon-shop-preferences') {
    const allowed = new Set(['version', 'shops', 'activeShopId', 'defaultWarehouseIds']);
    if (Object.keys(value).some((key) => !allowed.has(key))) return false;
    const shops = Array.isArray(value.shops) ? value.shops : [];
    const defaults = value.defaultWarehouseIds
      && typeof value.defaultWarehouseIds === 'object'
      && !Array.isArray(value.defaultWarehouseIds)
      ? value.defaultWarehouseIds
      : {};
    const activeShopId = String(value.activeShopId || '').trim();
    return shops.every((shop) => String(shop?.id || '').trim() === owner.ownerId)
      && Object.keys(defaults).every((shopId) => shopId === owner.ownerId)
      && (!activeShopId || activeShopId === owner.ownerId)
      && (shops.length > 0 || Object.keys(defaults).length > 0 || activeShopId === owner.ownerId);
  }
  if (owner.ownerType === 'ozon_shop' && row.namespace === 'purchase-plugin-context') {
    try {
      const normalized = normalizeProfileSettingValue(row.namespace, value);
      return String(normalized.context?.shopId || '').trim() === owner.ownerId;
    } catch {
      return false;
    }
  }
  if (owner.ownerType === 'cross_border_bus' && row.namespace === 'cross-border-preferences') {
    const allowed = new Set(['version', 'crossBorderAccountId', 'accountId']);
    if (Object.keys(value).some((key) => !allowed.has(key))) return false;
    const references = [value.crossBorderAccountId, value.accountId]
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
    return references.length > 0 && references.every((ownerId) => ownerId === owner.ownerId);
  }
  return false;
}

export function removeOwnerFromProfileSettingRecord(record, owner) {
  const row = record?.value || {};
  const namespace = String(row.namespace || '').trim();
  let nextValue = row.value;
  if (
    owner.ownerType === 'ozon_shop'
    && namespace === 'ozon-shop-preferences'
    && hasOzonPreferenceOwner(row.value, owner.ownerId)
  ) {
    nextValue = removeOzonShopPreferenceOwner(row.value, owner.ownerId);
  } else if (
    owner.ownerType === 'cross_border_bus'
    && namespace === 'cross-border-preferences'
    && hasCrossBorderPreferenceOwner(row.value, owner.ownerId)
  ) {
    nextValue = removeCrossBorderPreferenceOwner(row.value, owner.ownerId);
  } else {
    return { changed: false, record };
  }
  const nextRow = { ...row, value: nextValue };
  return {
    changed: true,
    record: {
      key: buildRecoveryRecordKey(getDataDomain('profile-settings'), nextRow),
      value: nextRow,
    },
  };
}

export function isOwnerScopedPurchaseBrowserRecord(domain, record, owner) {
  const value = record?.value || {};
  if (domain === 'purchase-completion-history') {
    return owner.ownerType === 'ozon_shop' && String(value.shop_id || '') === owner.ownerId;
  }
  if (!['purchase-browser-tasks', 'purchase-browser-receipts'].includes(domain)) return false;
  if (owner.ownerType === 'purchase_account') return String(value.owner_id || '') === owner.ownerId;
  if (owner.ownerType === 'ozon_shop') return String(value.shop_id || '') === owner.ownerId;
  return false;
}

export function isOwnerScopedProfileRecord(domain, record, owner) {
  const value = record?.value || {};
  if (RECOVERY_OWNER_DOMAIN_TYPES[domain] === owner.ownerType) {
    return String(value.id || '').trim() === owner.ownerId;
  }
  if (domain === 'shop-credentials') {
    return owner.ownerType === 'ozon_shop'
      && String(value.shop_id || '').trim() === owner.ownerId;
  }
  if (domain === 'integration-credentials') {
    return owner.ownerType === 'integration_profile'
      && String(value.profile_id || '').trim() === owner.ownerId;
  }
  if (domain === 'follow-seller-login-preferences') {
    return owner.ownerType === 'integration_profile'
      && String(value.profile_id || '').trim() === owner.ownerId;
  }
  if ([
    'purchase-browser-tasks',
    'purchase-browser-receipts',
    'purchase-completion-history',
  ].includes(domain)) {
    return isOwnerScopedPurchaseBrowserRecord(domain, record, owner);
  }
  if (domain === 'profile-settings') {
    return isOwnerScopedProfileSettingRecord(record, owner);
  }
  return false;
}

export function assertOwnerScopedCandidateOwner(candidate, ownerInput) {
  const owner = normalizeRemovalOwner(ownerInput || candidate?.ownerScope);
  if (
    candidate?.ownerScope?.ownerType !== owner.ownerType
    || candidate?.ownerScope?.ownerId !== owner.ownerId
  ) {
    throw new Error('RECOVERY_PROFILE_OWNER_SCOPE_MISMATCH');
  }
  return owner;
}

/**
 * Opens and validates an owner-scoped profile-core candidate without exposing
 * any plaintext secret in its public summary. The candidate deliberately uses
 * the existing profile-core format and encrypted chunks; unrelated domains are
 * represented by authenticated empty chunks so the normal importer remains the
 * single restore path.
 */
export function assertOwnerScopedRecoveryProfileCandidate({
  candidate,
  owner: ownerInput,
  encryptionKey,
  aad = '',
} = {}) {
  if (!candidate?.ok || candidate.format !== 'wangzai-recovery-profile-core') {
    throw new Error('RESTORE_PROFILE_CANDIDATE_INVALID');
  }
  assertRecoveryProfileCoreCandidateShape(candidate);
  const owner = assertOwnerScopedCandidateOwner(candidate, ownerInput);
  const allowedDomains = new Set(RECOVERY_OWNER_PROFILE_DOMAINS[owner.ownerType] || []);
  const domains = [];
  for (const manifest of candidate.domains) {
    const policy = getDataDomain(manifest.domain);
    const chunk = openProfileDomain(candidate, manifest.domain, encryptionKey, aad);
    if (
      chunk.header.domain !== policy.domain
      || Number(chunk.header.domainSchemaVersion) !== Number(policy.schemaVersion ?? 1)
      || Number(manifest.schemaVersion ?? chunk.header.domainSchemaVersion)
        !== Number(policy.schemaVersion ?? 1)
      || chunk.recordsRootHash !== manifest.recordsRootHash
      || chunk.records.length !== Number(manifest.recordCount)
    ) {
      throw new Error(`RECOVERY_PROFILE_OWNER_DOMAIN_INTEGRITY_MISMATCH:${policy.domain}`);
    }
    if (!allowedDomains.has(policy.domain) && chunk.records.length) {
      throw new Error(`RECOVERY_PROFILE_OWNER_DOMAIN_NOT_ALLOWED:${policy.domain}`);
    }
    const invalidOwnerRecord = chunk.records.find(
      (record) => !isOwnerScopedProfileRecord(policy.domain, record, owner),
    );
    if (invalidOwnerRecord) {
      throw new Error(
        `RECOVERY_PROFILE_OWNER_RECORD_SCOPE_MISMATCH:${policy.domain}:${invalidOwnerRecord?.value?.namespace || 'record'}`,
      );
    }
    domains.push({
      domain: policy.domain,
      schemaVersion: Number(policy.schemaVersion ?? 1),
      recordCount: chunk.records.length,
      recordsRootHash: chunk.recordsRootHash,
      cipherBytes: Number(manifest.cipherBytes) || 0,
    });
  }
  const identityDomain = Object.entries(RECOVERY_OWNER_DOMAIN_TYPES)
    .find(([, ownerType]) => ownerType === owner.ownerType)?.[0];
  const identity = domains.find((domain) => domain.domain === identityDomain);
  if (!identity || identity.recordCount !== 1) {
    throw new Error('RECOVERY_PROFILE_OWNER_IDENTITY_REQUIRED');
  }
  return { ok: true, owner, domains };
}

/**
 * Internal restore helper. It first performs the complete owner-scope and
 * authenticated-chunk validation above, then returns the decoded records to a
 * staging/merge service. Callers must never expose this result to Renderer or
 * persist its plaintext secret fields.
 */
export function openOwnerScopedRecoveryProfileCandidate({
  candidate,
  owner,
  encryptionKey,
  aad = '',
} = {}) {
  const verified = assertOwnerScopedRecoveryProfileCandidate({
    candidate,
    owner,
    encryptionKey,
    aad,
  });
  const domains = new Map();
  for (const manifest of candidate.domains) {
    const decoded = openProfileDomain(candidate, manifest.domain, encryptionKey, aad);
    domains.set(manifest.domain, {
      domain: manifest.domain,
      schemaVersion: Number(decoded.header.domainSchemaVersion),
      recordsRootHash: decoded.recordsRootHash,
      records: decoded.records,
    });
  }
  return { ok: true, owner: verified.owner, domains };
}

/** Returns only opaque-owner inputs discovered by decrypting the authenticated profile chunks. */
export function listRecoveryProfileOwners({ candidate, encryptionKey, aad = '' } = {}) {
  if (!candidate?.ok || candidate.format !== 'wangzai-recovery-profile-core') {
    throw new Error('RESTORE_PROFILE_CANDIDATE_INVALID');
  }
  assertRecoveryProfileCoreCandidateShape(candidate);
  const owners = [];
  for (const domain of Object.keys(RECOVERY_OWNER_DOMAIN_TYPES)) {
    if (!candidate.domains.some((entry) => entry.domain === domain)) continue;
    const chunk = openProfileDomain(candidate, domain, encryptionKey, aad);
    for (const record of chunk.records) owners.push(profileOwnerFromRecord(domain, record));
  }
  const unique = new Map(owners.map((owner) => [
    `${owner.ownerType}\0${owner.ownerId}\0${owner.ownerIncarnation}`,
    owner,
  ]));
  return [...unique.values()].sort((left, right) =>
    `${left.ownerType}\0${left.ownerId}\0${left.ownerIncarnation}`
      .localeCompare(`${right.ownerType}\0${right.ownerId}\0${right.ownerIncarnation}`));
}

/**
 * Re-encrypts only the authenticated profile chunks after removing one exact
 * business owner. Other records, domain versions, timestamps and shop chunks
 * are preserved byte-for-byte whenever their logical records do not change.
 */
export function removeRecoveryProfileOwner({
  candidate,
  owner: ownerInput,
  encryptionKey,
  dedupeKey,
  aad = '',
} = {}) {
  if (!candidate?.ok || candidate.format !== 'wangzai-recovery-profile-core') {
    throw new Error('RESTORE_PROFILE_CANDIDATE_INVALID');
  }
  assertRecoveryProfileCoreCandidateShape(candidate);
  const owner = normalizeRemovalOwner(ownerInput);
  const encoded = [];
  const removedOwners = [];
  let changed = false;
  for (const manifest of candidate.domains) {
    const domain = manifest.domain;
    const chunk = openProfileDomain(candidate, domain, encryptionKey, aad);
    let records = chunk.records;
    if (RECOVERY_OWNER_DOMAIN_TYPES[domain] === owner.ownerType) {
      const retained = [];
      for (const record of records) {
        const recordOwner = profileOwnerFromRecord(domain, record);
        if (recordOwner.ownerId === owner.ownerId) {
          removedOwners.push(recordOwner);
          changed = true;
        } else {
          retained.push(record);
        }
      }
      records = retained;
    } else if (
      ['integration-credentials', 'follow-seller-login-preferences'].includes(domain)
      && owner.ownerType === 'integration_profile'
    ) {
      const retained = records.filter((record) => !isOwnerScopedProfileRecord(domain, record, owner));
      if (retained.length !== records.length) changed = true;
      records = retained;
    } else if ([
      'purchase-browser-tasks',
      'purchase-browser-receipts',
      'purchase-completion-history',
    ].includes(domain)) {
      const retained = records.filter((record) => !isOwnerScopedPurchaseBrowserRecord(domain, record, owner));
      if (retained.length !== records.length) changed = true;
      records = retained;
    } else if (domain === 'profile-settings') {
      records = records.map((record) => {
        const result = removeOwnerFromProfileSettingRecord(record, owner);
        if (result.changed) changed = true;
        return result.record;
      });
    }
    encoded.push(buildEncryptedDomain({
      policy: getDataDomain(domain),
      partitionKey: chunk.header.partitionKey,
      records,
      encryptionKey,
      dedupeKey,
      aad,
    }));
  }
  const chunks = encoded.map((entry) => entry.encrypted);
  return {
    changed,
    removedOwners,
    candidate: {
      ...candidate,
      domains: encoded.map((entry) => entry.manifest),
      chunks,
      totalCipherBytes: chunks.reduce((total, chunk) => total + chunk.cipherBytes, 0),
    },
  };
}

export function readProfileSettingForOwnerMerge(db, namespace) {
  const row = db.prepare(`
    SELECT namespace, value_json, created_at, updated_at
    FROM profile_settings WHERE namespace = ?
  `).get(namespace);
  if (!row) return null;
  try {
    return {
      ...row,
      value: normalizeProfileSettingValue(namespace, JSON.parse(row.value_json)),
    };
  } catch {
    throw new Error('RESTORE_PROFILE_OWNER_SETTING_TARGET_INVALID');
  }
}

export function isBlankProfileMergeValue(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

export function preserveProfileSettingValues(current, incoming) {
  if (
    current && typeof current === 'object' && !Array.isArray(current)
    && incoming && typeof incoming === 'object' && !Array.isArray(incoming)
  ) {
    const merged = { ...incoming };
    for (const [key, currentValue] of Object.entries(current)) {
      const incomingValue = incoming[key];
      merged[key] = preserveProfileSettingValues(currentValue, incomingValue);
    }
    return merged;
  }
  return isBlankProfileMergeValue(current) ? incoming : current;
}

export function mergeOwnerScopedProfileSetting(db, row, owner, { strategy = 'overwrite' } = {}) {
  if (!isOwnerScopedProfileSettingRecord({
    key: buildRecoveryRecordKey(getDataDomain('profile-settings'), row),
    value: row,
  }, owner)) {
    throw new Error('RESTORE_PROFILE_OWNER_SETTING_SCOPE_MISMATCH');
  }
  const existing = readProfileSettingForOwnerMerge(db, row.namespace);
  const current = existing?.value || {};
  const incoming = normalizeProfileSettingValue(row.namespace, row.value);
  let value;
  if (owner.ownerType === 'ozon_shop' && row.namespace === 'ozon-shop-preferences') {
    const currentShops = Array.isArray(current.shops) ? current.shops : [];
    const retainedShops = currentShops
      .filter((shop) => String(shop?.id || '').trim() !== owner.ownerId);
    const incomingShops = Array.isArray(incoming.shops) ? incoming.shops : [];
    const currentOwnerShop = currentShops.find(
      (shop) => String(shop?.id || '').trim() === owner.ownerId,
    ) || null;
    const mergedIncomingShops = strategy === 'preserve' && currentOwnerShop
      ? incomingShops.map((shop) => ({
          ...shop,
          ...Object.fromEntries(Object.entries(currentOwnerShop).filter(([, value]) => (
            value !== null && value !== undefined && String(value).trim() !== ''
          ))),
          id: owner.ownerId,
        }))
      : incomingShops;
    const defaults = current.defaultWarehouseIds
      && typeof current.defaultWarehouseIds === 'object'
      && !Array.isArray(current.defaultWarehouseIds)
      ? { ...current.defaultWarehouseIds }
      : {};
    if (
      Object.prototype.hasOwnProperty.call(incoming.defaultWarehouseIds || {}, owner.ownerId)
      && (
        strategy !== 'preserve'
        || !Object.prototype.hasOwnProperty.call(defaults, owner.ownerId)
        || defaults[owner.ownerId] === null
        || defaults[owner.ownerId] === undefined
        || String(defaults[owner.ownerId]).trim() === ''
      )
    ) {
      defaults[owner.ownerId] = incoming.defaultWarehouseIds[owner.ownerId];
    }
    value = {
      ...current,
      ...(current.version === undefined && incoming.version !== undefined
        ? { version: incoming.version }
        : {}),
      shops: [...retainedShops, ...mergedIncomingShops],
      defaultWarehouseIds: defaults,
      ...(String(incoming.activeShopId || '').trim() === owner.ownerId
        && (strategy !== 'preserve' || !String(current.activeShopId || '').trim())
        ? { activeShopId: owner.ownerId }
        : {}),
    };
  } else if (owner.ownerType === 'ozon_shop' && row.namespace === 'purchase-plugin-context') {
    const currentOwnerId = String(current?.context?.shopId || '').trim();
    if (currentOwnerId && currentOwnerId !== owner.ownerId) {
      if (strategy === 'preserve') {
        return {
          value: normalizeProfileSettingValue(row.namespace, current),
          createdAt: existing?.created_at || row.created_at,
          updatedAt: existing?.updated_at || row.updated_at,
        };
      }
      throw new Error('RESTORE_PROFILE_OWNER_SETTING_CONFLICT');
    }
    value = strategy === 'preserve'
      ? preserveProfileSettingValues(current, incoming)
      : incoming;
  } else if (
    owner.ownerType === 'cross_border_bus'
    && row.namespace === 'cross-border-preferences'
  ) {
    value = { ...current };
    for (const field of ['crossBorderAccountId', 'accountId']) {
      if (String(incoming[field] || '').trim() !== owner.ownerId) continue;
      const currentOwnerId = String(current[field] || '').trim();
      if (currentOwnerId && currentOwnerId !== owner.ownerId) {
        throw new Error('RESTORE_PROFILE_OWNER_SETTING_CONFLICT');
      }
      value[field] = owner.ownerId;
    }
    if (value.version === undefined && incoming.version !== undefined) value.version = incoming.version;
  } else {
    throw new Error('RESTORE_PROFILE_OWNER_SETTING_SCOPE_MISMATCH');
  }
  return {
    value: normalizeProfileSettingValue(row.namespace, value),
    createdAt: existing?.created_at || row.created_at,
    updatedAt: row.updated_at,
  };
}

export function remapOwnerScopedProfileSettingRow(row, sourceOwner, targetOwner) {
  if (
    sourceOwner?.ownerType !== 'ozon_shop'
    || targetOwner?.ownerType !== 'ozon_shop'
    || sourceOwner.ownerId === targetOwner.ownerId
  ) return row;
  const value = normalizeProfileSettingValue(row.namespace, row.value);
  if (row.namespace === 'ozon-shop-preferences') {
    const defaults = value.defaultWarehouseIds
      && typeof value.defaultWarehouseIds === 'object'
      && !Array.isArray(value.defaultWarehouseIds)
      ? { ...value.defaultWarehouseIds }
      : {};
    if (Object.hasOwn(defaults, sourceOwner.ownerId)) {
      defaults[targetOwner.ownerId] = defaults[sourceOwner.ownerId];
      delete defaults[sourceOwner.ownerId];
    }
    return {
      ...row,
      value: {
        ...value,
        shops: (Array.isArray(value.shops) ? value.shops : []).map((shop) => (
          String(shop?.id || '').trim() === sourceOwner.ownerId
            ? { ...shop, id: targetOwner.ownerId }
            : shop
        )),
        defaultWarehouseIds: defaults,
        ...(String(value.activeShopId || '').trim() === sourceOwner.ownerId
          ? { activeShopId: targetOwner.ownerId }
          : {}),
      },
    };
  }
  if (
    row.namespace === 'purchase-plugin-context'
    && String(value?.context?.shopId || '').trim() === sourceOwner.ownerId
  ) {
    return {
      ...row,
      value: { ...value, context: { ...value.context, shopId: targetOwner.ownerId } },
    };
  }
  return row;
}

/**
 * Read-only planner for a single authenticated owner-scoped profile setting.
 * Portable import uses the exact same remap/merge implementation as commit so
 * its preflight fingerprint can bind the canonical target owner slice.
 */
export function planOwnerScopedRecoveryProfileSettingMerge({
  db,
  row: sourceRow,
  sourceOwner: sourceOwnerInput,
  targetOwner: targetOwnerInput,
  strategy = 'preserve',
} = {}) {
  if (!db) throw new Error('RESTORE_PROFILE_SETTING_PLAN_DATABASE_REQUIRED');
  if (!['preserve', 'overwrite'].includes(strategy)) {
    throw new Error('RESTORE_PROFILE_MERGE_STRATEGY_INVALID');
  }
  const sourceOwner = normalizeRemovalOwner(sourceOwnerInput);
  const targetOwner = normalizeRemovalOwner(targetOwnerInput);
  if (sourceOwner.ownerType !== targetOwner.ownerType) {
    throw new Error('RESTORE_PROFILE_OWNER_SCOPE_MISMATCH');
  }
  const row = remapOwnerScopedProfileSettingRow(sourceRow, sourceOwner, targetOwner);
  let value;
  try {
    value = normalizeProfileSettingValue(row.namespace, row.value);
  } catch {
    throw new Error('RESTORE_PROFILE_SETTING_INVALID');
  }
  const merged = mergeOwnerScopedProfileSetting(db, { ...row, value }, targetOwner, { strategy });
  return Object.freeze({
    namespace: row.namespace,
    value: merged.value,
    createdAt: merged.createdAt,
    updatedAt: merged.updatedAt,
  });
}
