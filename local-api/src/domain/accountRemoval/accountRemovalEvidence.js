import { createHash } from 'node:crypto';
import { quoteAccountRemovalIdentifier } from './accountRemovalSqliteCatalog.js';

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (value instanceof Uint8Array) return JSON.stringify({ $bytes: Buffer.from(value).toString('base64') });
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

export function createAccountRemovalEvidenceHash(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function hashCanonicalRows(rows) {
  const hash = createHash('sha256');
  let count = 0;
  hash.update('[', 'utf8');
  for (const row of rows) {
    if (count > 0) hash.update(',', 'utf8');
    hash.update(canonicalJson(row), 'utf8');
    count += 1;
  }
  hash.update(']', 'utf8');
  return { count, hash: hash.digest('hex') };
}

function streamAccountRemovalRows(db, descriptor, predicate, ownerId) {
  const table = quoteAccountRemovalIdentifier(descriptor.table);
  const ownerField = quoteAccountRemovalIdentifier(descriptor.ownerField);
  const evidenceProjection = Array.isArray(descriptor.evidenceFields) && descriptor.evidenceFields.length
    ? descriptor.evidenceFields.map(quoteAccountRemovalIdentifier).join(', ')
    : '*';
  const rows = db.prepare(`
    SELECT ${evidenceProjection}
    FROM ${table}
    WHERE ${ownerField} ${predicate}
    ORDER BY rowid
  `).iterate(ownerId);
  return hashCanonicalRows(rows);
}

export function readAccountRemovalTargetRows(db, descriptor, ownerId) {
  const table = quoteAccountRemovalIdentifier(descriptor.table);
  const ownerField = quoteAccountRemovalIdentifier(descriptor.ownerField);
  const evidenceProjection = Array.isArray(descriptor.evidenceFields) && descriptor.evidenceFields.length
    ? descriptor.evidenceFields.map(quoteAccountRemovalIdentifier).join(', ')
    : '*';
  return db.prepare(`SELECT ${evidenceProjection} FROM ${table} WHERE ${ownerField} = ?`).all(ownerId);
}

function summarizeAccountRemovalRowIds(db, descriptor, predicate, ownerId) {
  const table = quoteAccountRemovalIdentifier(descriptor.table);
  const ownerField = quoteAccountRemovalIdentifier(descriptor.ownerField);
  const row = db.prepare(`
    SELECT COUNT(*) AS evidence_count,
           MIN(rowid) AS minimum_rowid,
           MAX(rowid) AS maximum_rowid
    FROM ${table}
    WHERE ${ownerField} ${predicate}
  `).get(ownerId);
  return {
    count: Number(row?.evidence_count) || 0,
    evidence: row || {},
  };
}

export function observeAccountRemovalSqliteResource(db, descriptor, ownerId) {
  if (descriptor.evidenceMode === 'rowid-summary') {
    const summary = summarizeAccountRemovalRowIds(db, descriptor, '= ?', ownerId);
    if (summary.count === 0) return { state: 'absent' };
    return {
      state: 'observed',
      count: summary.count,
      hash: createAccountRemovalEvidenceHash(summary.evidence),
    };
  }
  const evidence = streamAccountRemovalRows(db, descriptor, '= ?', ownerId);
  if (evidence.count === 0) return { state: 'absent' };
  return {
    state: 'observed',
    count: evidence.count,
    hash: evidence.hash,
  };
}

export function capturePreservedSqliteRows(db, descriptors, ownerId) {
  const byTable = new Map();
  for (const descriptor of descriptors) {
    if (byTable.has(descriptor.table)) continue;
    const table = quoteAccountRemovalIdentifier(descriptor.table);
    const ownerField = quoteAccountRemovalIdentifier(descriptor.ownerField);
    if (descriptor.evidenceMode === 'rowid-summary') {
      const summary = summarizeAccountRemovalRowIds(db, descriptor, 'IS NULL OR ' + ownerField + ' <> ?', ownerId);
      byTable.set(descriptor.table, {
        count: summary.count,
        hash: createAccountRemovalEvidenceHash(summary.evidence),
      });
      continue;
    }
    const evidence = streamAccountRemovalRows(
      db,
      descriptor,
      `IS NULL OR ${ownerField} <> ?`,
      ownerId,
    );
    byTable.set(descriptor.table, {
      count: evidence.count,
      hash: evidence.hash,
    });
  }
  return Object.fromEntries([...byTable.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function safePreferenceValue(rawValue) {
  try {
    const value = JSON.parse(rawValue || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    throw new Error('ACCOUNT_REMOVAL_PROFILE_SETTING_INVALID');
  }
}

function readProfileSetting(db, namespace) {
  const row = db.prepare(`
    SELECT namespace, value_json, created_at, updated_at
    FROM profile_settings
    WHERE namespace = ?
  `).get(namespace);
  return row ? { ...row, value: safePreferenceValue(row.value_json) } : null;
}

export function readOzonShopPreferences(db) {
  return readProfileSetting(db, 'ozon-shop-preferences');
}

export function readCrossBorderPreferences(db) {
  return readProfileSetting(db, 'cross-border-preferences');
}

export function readPurchasePluginContext(db) {
  return readProfileSetting(db, 'purchase-plugin-context');
}

export function observePurchasePluginContextResource(db, ownerId) {
  const row = readPurchasePluginContext(db);
  if (!row || String(row.value?.context?.shopId ?? '').trim() !== ownerId) return { state: 'absent' };
  return {
    state: 'observed',
    count: 1,
    hash: createAccountRemovalEvidenceHash({ ownerId, context: row.value.context }),
  };
}

export function observePurchasePluginAccountContextResource(db, ownerId) {
  const row = readPurchasePluginContext(db);
  if (!row || String(row.value?.context?.purchaseAccountId ?? '').trim() !== ownerId) return { state: 'absent' };
  return {
    state: 'observed',
    count: 1,
    hash: createAccountRemovalEvidenceHash({ ownerId, context: row.value.context }),
  };
}

export function removePurchasePluginContextOwner(value, ownerId) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value))
    : {};
  if (String(source?.context?.shopId ?? '').trim() !== ownerId) return source;
  return { ...source, context: {}, updatedAt: new Date(0).toISOString() };
}

export function removePurchasePluginAccountContextOwner(value, ownerId) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value))
    : {};
  if (String(source?.context?.purchaseAccountId ?? '').trim() !== ownerId) return source;
  return { ...source, context: {}, updatedAt: new Date(0).toISOString() };
}

export function capturePurchasePluginContextPreservation(db, ownerId) {
  const row = readPurchasePluginContext(db);
  if (!row) return { exists: false, hash: createAccountRemovalEvidenceHash(null) };
  return {
    exists: true,
    hash: createAccountRemovalEvidenceHash({
      namespace: row.namespace,
      createdAt: row.created_at,
      value: removePurchasePluginContextOwner(row.value, ownerId),
    }),
  };
}

export function capturePurchasePluginAccountContextPreservation(db, ownerId) {
  const row = readPurchasePluginContext(db);
  if (!row) return { exists: false, hash: createAccountRemovalEvidenceHash(null) };
  return {
    exists: true,
    hash: createAccountRemovalEvidenceHash({
      namespace: row.namespace,
      createdAt: row.created_at,
      value: removePurchasePluginAccountContextOwner(row.value, ownerId),
    }),
  };
}

function ownShopReferences(value, ownerId) {
  const shops = Array.isArray(value?.shops) ? value.shops : [];
  const shopCount = shops.filter((shop) => String(shop?.id ?? '') === ownerId).length;
  const defaults = value?.defaultWarehouseIds && typeof value.defaultWarehouseIds === 'object' && !Array.isArray(value.defaultWarehouseIds)
    ? value.defaultWarehouseIds
    : {};
  const defaultCount = Object.prototype.hasOwnProperty.call(defaults, ownerId) ? 1 : 0;
  const activeCount = String(value?.activeShopId ?? '') === ownerId ? 1 : 0;
  return { shopCount, defaultCount, activeCount };
}

export function observeOzonShopPreferenceResource(db, ownerId) {
  const row = readOzonShopPreferences(db);
  if (!row) return { state: 'absent' };
  const references = ownShopReferences(row.value, ownerId);
  const count = references.shopCount + references.defaultCount + references.activeCount;
  if (!count) return { state: 'absent' };
  return {
    state: 'observed',
    count,
    hash: createAccountRemovalEvidenceHash({ references, ownerSlice: {
      shops: (Array.isArray(row.value.shops) ? row.value.shops : []).filter((shop) => String(shop?.id ?? '') === ownerId),
      defaultWarehouseId: row.value.defaultWarehouseIds?.[ownerId] ?? null,
      active: String(row.value.activeShopId ?? '') === ownerId,
    } }),
  };
}

export function removeOzonShopPreferenceOwner(value, ownerId) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value))
    : {};
  const shops = (Array.isArray(source.shops) ? source.shops : [])
    .filter((shop) => String(shop?.id ?? '') !== ownerId);
  const defaultWarehouseIds = source.defaultWarehouseIds && typeof source.defaultWarehouseIds === 'object' && !Array.isArray(source.defaultWarehouseIds)
    ? { ...source.defaultWarehouseIds }
    : {};
  delete defaultWarehouseIds[ownerId];
  const activeShopId = String(source.activeShopId ?? '') === ownerId
    ? String(shops[0]?.id ?? '')
    : String(source.activeShopId ?? '');
  return { ...source, shops, activeShopId, defaultWarehouseIds };
}

export function captureOzonShopPreferencePreservation(db, ownerId) {
  const row = readOzonShopPreferences(db);
  if (!row) return { exists: false, hash: createAccountRemovalEvidenceHash(null) };
  const preservedValue = removeOzonShopPreferenceOwner(row.value, ownerId);
  return {
    exists: true,
    hash: createAccountRemovalEvidenceHash({
      namespace: row.namespace,
      createdAt: row.created_at,
      value: preservedValue,
    }),
  };
}

const CROSS_BORDER_ACCOUNT_PREFERENCE_FIELDS = Object.freeze([
  'crossBorderAccountId',
  'accountId',
  'id',
  'accountAlias',
  'accountSaved',
  'accountSavedAt',
  'apiSaved',
  'apiSavedAt',
  'connectionStatus',
  'connectionMessage',
  'lastConnectedAt',
]);

function crossBorderPreferenceOwner(value = {}) {
  const ids = [...new Set([
    String(value?.crossBorderAccountId ?? '').trim(),
    String(value?.accountId ?? '').trim(),
  ].filter(Boolean))];
  if (ids.length > 1) throw new Error('ACCOUNT_REMOVAL_CROSS_OWNER_SCOPE');
  return ids[0] || '';
}

export function observeCrossBorderPreferenceResource(db, ownerId) {
  const row = readCrossBorderPreferences(db);
  if (!row || crossBorderPreferenceOwner(row.value) !== ownerId) return { state: 'absent' };
  return {
    state: 'observed',
    count: 1,
    hash: createAccountRemovalEvidenceHash({
      ownerId,
      fields: Object.fromEntries(
        CROSS_BORDER_ACCOUNT_PREFERENCE_FIELDS
          .filter((field) => Object.prototype.hasOwnProperty.call(row.value, field))
          .map((field) => [field, row.value[field]]),
      ),
    }),
  };
}

export function removeCrossBorderPreferenceOwner(value, ownerId) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value))
    : {};
  if (crossBorderPreferenceOwner(source) !== ownerId) return source;
  for (const field of CROSS_BORDER_ACCOUNT_PREFERENCE_FIELDS) delete source[field];
  return source;
}

export function captureCrossBorderPreferencePreservation(db, ownerId) {
  const row = readCrossBorderPreferences(db);
  if (!row) return { exists: false, hash: createAccountRemovalEvidenceHash(null) };
  return {
    exists: true,
    hash: createAccountRemovalEvidenceHash({
      namespace: row.namespace,
      createdAt: row.created_at,
      value: removeCrossBorderPreferenceOwner(row.value, ownerId),
    }),
  };
}
