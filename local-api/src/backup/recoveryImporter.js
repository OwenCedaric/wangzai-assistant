import {
  compareDataDomainRestoreOrder,
  getDataDomain,
  getDataDomainPrimaryKeyForSchemaVersion,
} from '../data/dataDomainRegistry.js';
import { decryptRecoveryChunk } from './recoveryChunkCodec.js';
import { buildRecoveryRecordKey } from './recoveryExporter.js';

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizeShopId(value) {
  const shopId = String(value || '').trim();
  if (!shopId) throw new Error('RESTORE_SHOP_ID_REQUIRED');
  return shopId;
}

function tableColumns(db, tableName) {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map((row) => row.name);
  if (!columns.length) throw new Error(`RESTORE_TABLE_NOT_FOUND:${tableName}`);
  return new Set(columns);
}

function assertStagingShopExists(db, shopId) {
  const present = db.prepare('SELECT 1 AS present FROM shops WHERE id = ?').get(shopId)?.present;
  if (!present) throw new Error('RESTORE_PROFILE_CORE_REQUIRED');
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function safeJsonObject(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstText(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

const MARKETING_SOURCE_TYPE_ALIASES = new Map([
  ['official', 'official'],
  ['officialaction', 'official'],
  ['officialactions', 'official'],
  ['action', 'official'],
  ['actions', 'official'],
  ['platform', 'official'],
  ['platformaction', 'official'],
  ['platformactions', 'official'],
  ['平台', 'official'],
  ['平台活动', 'official'],
  ['官方', 'official'],
  ['官方活动', 'official'],
  ['seller', 'seller'],
  ['selleraction', 'seller'],
  ['selleractions', 'seller'],
  ['商家', 'seller'],
  ['商家活动', 'seller'],
  ['商家自主', 'seller'],
  ['自主', 'seller'],
  ['自主活动', 'seller'],
]);

function normalizeMarketingSourceType(value, {
  allowEmpty = false,
  errorCode = 'RESTORE_MARKETING_SOURCE_TYPE_INVALID',
} = {}) {
  if ((value === undefined || value === null) && allowEmpty) return '';
  if (typeof value !== 'string') throw new Error(errorCode);
  const source = value.trim().toLowerCase().replace(/[\s_-]+/gu, '');
  if (!source && allowEmpty) return '';
  const normalized = MARKETING_SOURCE_TYPE_ALIASES.get(source);
  if (!normalized) throw new Error(errorCode);
  return normalized;
}

function normalizeMarketingSelectedSourceType(value) {
  return normalizeMarketingSourceType(value, {
    allowEmpty: true,
    errorCode: 'RESTORE_MARKETING_SELECTED_SOURCE_TYPE_INVALID',
  });
}

function normalizeMarketingSummaryInitialized(value) {
  if (value === 0 || value === 1) return value;
  throw new Error('RESTORE_MARKETING_VIEW_STATE_SUMMARY_INITIALIZED_INVALID');
}

function upgradeMarketingRecordValue({ policy, value, schemaVersion, columns }) {
  const upgraded = { ...value };
  if (policy.domain === 'marketing-view-state') {
    // A view selection can intentionally be blank, but a supplied nonblank
    // value is still part of the official/seller composite identity and must
    // never be guessed during recovery.
    upgraded.selected_source_type = normalizeMarketingSelectedSourceType(upgraded.selected_source_type);
    if (columns.has('summary_initialized')) {
      // V1 lacked counters and V2 lacked their provenance bit. Both historical
      // shapes may carry SQLite's old zero defaults, so neither may be trusted.
      // Only V3 explicitly records that a summary was written as a fact.
      if (schemaVersion < 3) upgraded.summary_initialized = 0;
      else if (!Object.hasOwn(upgraded, 'summary_initialized')) {
        throw new Error('RESTORE_MARKETING_VIEW_STATE_SUMMARY_INITIALIZED_REQUIRED');
      } else {
        upgraded.summary_initialized = normalizeMarketingSummaryInitialized(upgraded.summary_initialized);
      }
    }
    return upgraded;
  }
  if (policy.domain !== 'marketing-activities' && policy.domain !== 'marketing-activity-products') return upgraded;

  // V1 keys did not contain source_type. The original physical tables already had the
  // column, but only an absent field may use the historical official default.
  // A supplied empty/unknown enum is a corrupt record, not an official action.
  if (schemaVersion === 1 && !Object.hasOwn(upgraded, 'source_type')) upgraded.source_type = 'official';
  else upgraded.source_type = normalizeMarketingSourceType(upgraded.source_type);

  const raw = safeJsonObject(upgraded.raw_json);
  if (policy.domain === 'marketing-activities') {
    if (columns.has('source_tone') && !normalizeText(upgraded.source_tone)) {
      upgraded.source_tone = firstText(raw.source_tone, raw.sourceTone);
    }
    if (columns.has('date_start') && !normalizeText(upgraded.date_start)) {
      upgraded.date_start = firstText(
        raw.date_start,
        raw.dateStart,
        raw.start_at,
        raw.startAt,
        raw.start_date,
        raw.startDate,
      );
    }
    if (columns.has('date_end') && !normalizeText(upgraded.date_end)) {
      upgraded.date_end = firstText(
        raw.date_end,
        raw.dateEnd,
        raw.end_at,
        raw.endAt,
        raw.end_date,
        raw.endDate,
      );
    }
  }
  if (policy.domain === 'marketing-activity-products' && columns.has('ozon_sku') && !normalizeText(upgraded.ozon_sku)) {
    upgraded.ozon_sku = firstText(raw.ozon_sku, raw.ozonSku, raw.sku, upgraded.sku);
  }
  return upgraded;
}

function validateRecord({ policy, record, expectedShopId, columns, primaryKey }) {
  const value = record?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`RESTORE_RECORD_INVALID:${policy.domain}`);
  if (String(value.shop_id || '').trim() !== expectedShopId) throw new Error(`RESTORE_SHOP_SCOPE_MISMATCH:${policy.domain}`);
  if (buildRecoveryRecordKey(policy, value, { primaryKey }) !== record.key) throw new Error(`RESTORE_RECORD_KEY_MISMATCH:${policy.domain}`);
  const unknownColumns = Object.keys(value).filter((column) => !columns.has(column));
  if (unknownColumns.length) throw new Error(`RESTORE_UNKNOWN_COLUMN:${policy.domain}:${unknownColumns[0]}`);
}

function insertRecord(db, tableName, value) {
  const columns = Object.keys(value);
  if (!columns.length) throw new Error(`RESTORE_RECORD_EMPTY:${tableName}`);
  db.prepare(`
    INSERT INTO ${quoteIdentifier(tableName)} (${columns.map(quoteIdentifier).join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
  `).run(...columns.map((column) => value[column]));
}

function isBlankMergeValue(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function mergeValueEquals(left, right) {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return String(left) === String(right);
}

function logicalRecord(db, policy, value) {
  const key = policy.primaryKey;
  if (!key.every((column) => Object.hasOwn(value, column))) {
    throw new Error(`RESTORE_MERGE_PRIMARY_KEY_MISSING:${policy.domain}`);
  }
  return db.prepare(`
    SELECT * FROM ${quoteIdentifier(policy.canonicalTable)}
    WHERE ${key.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ')}
  `).get(...key.map((column) => value[column])) || null;
}

function mergeRecordValue(existing, incoming, strategy, primaryKey) {
  const next = { ...existing };
  let changedFields = 0;
  let conflictFields = 0;
  let preservedFields = 0;
  for (const [column, incomingValue] of Object.entries(incoming)) {
    if (primaryKey.includes(column)) continue;
    const currentValue = existing[column];
    if (mergeValueEquals(currentValue, incomingValue)) continue;
    if (strategy === 'overwrite') {
      next[column] = incomingValue;
      changedFields += 1;
      if (!isBlankMergeValue(currentValue)) conflictFields += 1;
      continue;
    }
    if (isBlankMergeValue(currentValue) && !isBlankMergeValue(incomingValue)) {
      next[column] = incomingValue;
      changedFields += 1;
      continue;
    }
    if (!isBlankMergeValue(currentValue) || !isBlankMergeValue(incomingValue)) {
      conflictFields += 1;
      preservedFields += 1;
    }
  }
  return { next, changedFields, conflictFields, preservedFields };
}

function updateRecord(db, tableName, value, incomingColumns, primaryKey) {
  const mutableColumns = incomingColumns.filter((column) => !primaryKey.includes(column));
  if (!mutableColumns.length) return;
  db.prepare(`
    UPDATE ${quoteIdentifier(tableName)}
    SET ${mutableColumns.map((column) => `${quoteIdentifier(column)} = ?`).join(', ')}
    WHERE ${primaryKey.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ')}
  `).run(
    ...mutableColumns.map((column) => value[column]),
    ...primaryKey.map((column) => value[column]),
  );
}

function assertMergeReadback(db, policy, expected, incomingColumns) {
  const readback = logicalRecord(db, policy, expected);
  if (!readback) throw new Error(`RESTORE_MERGE_READBACK_MISSING:${policy.domain}`);
  for (const column of incomingColumns) {
    if (!mergeValueEquals(readback[column], expected[column])) {
      throw new Error(`RESTORE_MERGE_READBACK_MISMATCH:${policy.domain}:${column}`);
    }
  }
}

/**
 * Staging-only importer. The caller supplies a newly migrated SQLite database and must perform
 * any profile switch outside this service after counts, hashes and application migrations pass.
 */
export function createRecoveryImporter({ db, resolveDomainDatabase = () => db } = {}) {
  if (!db) throw new Error('createRecoveryImporter requires db.');

  function processShopCandidate({
    candidate,
    encryptionKey,
    aad = '',
    expectedShopId,
    targetShopId,
    strategy = 'strict-insert',
    apply = true,
    manageTransaction = true,
  } = {}) {
    const shopId = normalizeShopId(expectedShopId || candidate?.shopId);
    const mappedShopId = normalizeShopId(targetShopId || shopId);
    if (!['strict-insert', 'preserve', 'overwrite'].includes(strategy)) {
      throw new Error('RESTORE_MERGE_STRATEGY_INVALID');
    }
    if (!candidate?.ok || !Array.isArray(candidate.domains) || !Array.isArray(candidate.chunks)) {
      throw new Error('RESTORE_CANDIDATE_INVALID');
    }
    if (String(candidate.shopId || '').trim() !== shopId) throw new Error('RESTORE_CANDIDATE_SCOPE_MISMATCH');
    assertStagingShopExists(db, mappedShopId);
    const chunksById = new Map(candidate.chunks.map((chunk) => [chunk.chunkId, chunk]));
    const imported = [];
    if (apply && manageTransaction) db.exec('BEGIN IMMEDIATE');
    try {
      const orderedManifests = candidate.domains
        .map((domainManifest) => ({ domainManifest, policy: getDataDomain(domainManifest.domain) }))
        .sort((left, right) => compareDataDomainRestoreOrder(left.policy, right.policy));
      for (const { domainManifest, policy } of orderedManifests) {
        if (
          policy.scopeType !== 'shop'
          || policy.backup === 'excluded'
          || policy.recoveryChannel === 'profile-core'
        ) throw new Error(`RESTORE_DOMAIN_NOT_ALLOWED:${policy.domain}`);
        const encrypted = chunksById.get(domainManifest.chunkId);
        if (!encrypted) throw new Error(`RESTORE_CHUNK_MISSING:${policy.domain}`);
        const decoded = decryptRecoveryChunk({ encrypted, encryptionKey, aad });
        if (decoded.header.domain !== policy.domain || decoded.recordsRootHash !== domainManifest.recordsRootHash) {
          throw new Error(`RESTORE_DOMAIN_INTEGRITY_MISMATCH:${policy.domain}`);
        }
        const domainDb = resolveDomainDatabase({ db, shopId: mappedShopId, policy });
        const columns = tableColumns(domainDb, policy.canonicalTable);
        const primaryKey = getDataDomainPrimaryKeyForSchemaVersion(policy, decoded.header.domainSchemaVersion);
        const domainSummary = {
          domain: policy.domain,
          table: policy.canonicalTable,
          recordCount: decoded.records.length,
          inserted: 0,
          updated: 0,
          unchanged: 0,
          conflicts: 0,
          preservedFields: 0,
        };
        for (const record of decoded.records) {
          validateRecord({ policy, record, expectedShopId: shopId, columns, primaryKey });
          const sourceValue = upgradeMarketingRecordValue({
            policy,
            value: record.value,
            schemaVersion: decoded.header.domainSchemaVersion,
            columns,
          });
          const value = { ...sourceValue, shop_id: mappedShopId };
          if (strategy === 'strict-insert') {
            if (apply) insertRecord(domainDb, policy.canonicalTable, value);
            domainSummary.inserted += 1;
            continue;
          }
          const existing = logicalRecord(domainDb, policy, value);
          if (!existing) {
            if (apply) {
              insertRecord(domainDb, policy.canonicalTable, value);
              assertMergeReadback(domainDb, policy, value, Object.keys(value));
            }
            domainSummary.inserted += 1;
            continue;
          }
          const merged = mergeRecordValue(existing, value, strategy, policy.primaryKey);
          domainSummary.conflicts += merged.conflictFields > 0 ? 1 : 0;
          domainSummary.preservedFields += merged.preservedFields;
          if (!merged.changedFields) {
            domainSummary.unchanged += 1;
            continue;
          }
          if (apply) {
            updateRecord(domainDb, policy.canonicalTable, merged.next, Object.keys(value), policy.primaryKey);
            assertMergeReadback(domainDb, policy, merged.next, Object.keys(value));
          }
          domainSummary.updated += 1;
        }
        imported.push(domainSummary);
      }
      if (apply && manageTransaction) db.exec('COMMIT');
    } catch (error) {
      if (apply && manageTransaction) {
        try { db.exec('ROLLBACK'); } catch { /* transaction may not have started */ }
      }
      throw error;
    }
    return {
      ok: true,
      mode: apply ? 'staging-only' : 'read-only-plan',
      shopId,
      targetShopId: mappedShopId,
      strategy,
      domains: imported,
    };
  }

  function importShopCandidate(input = {}) {
    return processShopCandidate({ ...input, apply: true });
  }

  function planShopCandidate(input = {}) {
    return processShopCandidate({ ...input, apply: false, manageTransaction: false });
  }

  return { importShopCandidate, planShopCandidate };
}
