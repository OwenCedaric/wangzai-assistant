import { randomUUID } from 'node:crypto';
import { createStableHash, stableStringify } from '../../utils/stableHash.js';

const SOURCE_KINDS = new Set(['remote', 'packaged_seed', 'legacy_migration', 'test']);
const CONFLICT_POLICIES = new Set(['quarantine', 'replace']);
const SENSITIVE_SUMMARY_KEY = /(?:api[_-]?key|client[_-]?id|cookie|password|token|secret|credential|authorization)/iu;

const ENTITY_SPECS = Object.freeze({
  category: Object.freeze({
    table: 'shared_catalog_categories',
    idColumns: Object.freeze(['category_id']),
    fields: Object.freeze([
      'category_id',
      'parent_category_id',
      'name',
      'level',
      'is_disabled',
    ]),
  }),
  type: Object.freeze({
    table: 'shared_catalog_types',
    idColumns: Object.freeze(['category_id', 'type_id']),
    fields: Object.freeze(['category_id', 'type_id', 'name', 'is_disabled']),
  }),
  attribute: Object.freeze({
    table: 'shared_catalog_attributes',
    idColumns: Object.freeze(['category_id', 'type_id', 'attribute_id']),
    fields: Object.freeze([
      'category_id',
      'type_id',
      'attribute_id',
      'name',
      'description',
      'group_name',
      'value_type',
      'is_required',
      'is_collection',
      'is_dictionary',
    ]),
  }),
  value: Object.freeze({
    table: 'shared_catalog_attribute_values',
    idColumns: Object.freeze(['category_id', 'type_id', 'attribute_id', 'value_id']),
    fields: Object.freeze([
      'category_id',
      'type_id',
      'attribute_id',
      'value_id',
      'value_text',
      'info',
    ]),
  }),
});

function nowIso() {
  return new Date().toISOString();
}

function requiredText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) {
    const error = new Error(`Shared catalog ${field} is required.`);
    error.code = 'SHARED_CATALOG_FIELD_REQUIRED';
    error.field = field;
    throw error;
  }
  return text;
}

function optionalText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeFlag(value) {
  return value === true || value === 1 || value === '1' ? 1 : 0;
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function parseEntityPayload(row) {
  try {
    const payload = JSON.parse(row?.payload_json || '{}');
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  } catch {
    return {};
  }
}

function normalizeSourceKind(value) {
  const sourceKind = String(value || 'remote').trim().toLowerCase();
  if (!SOURCE_KINDS.has(sourceKind)) {
    const error = new Error(`Unsupported shared catalog source kind: ${sourceKind}`);
    error.code = 'SHARED_CATALOG_SOURCE_KIND_INVALID';
    throw error;
  }
  return sourceKind;
}

function normalizeConflictPolicy(value) {
  const policy = String(value || 'quarantine').trim().toLowerCase();
  if (!CONFLICT_POLICIES.has(policy)) {
    const error = new Error(`Unsupported shared catalog conflict policy: ${policy}`);
    error.code = 'SHARED_CATALOG_CONFLICT_POLICY_INVALID';
    throw error;
  }
  return policy;
}

function serializeSourceSummary(value) {
  const summary = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const visit = (item) => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    const output = {};
    for (const [key, nested] of Object.entries(item)) {
      if (SENSITIVE_SUMMARY_KEY.test(key)) {
        const error = new Error(`Sensitive key is forbidden in shared catalog source summary: ${key}`);
        error.code = 'SHARED_CATALOG_SOURCE_SUMMARY_SENSITIVE';
        throw error;
      }
      output[key] = visit(nested);
    }
    return output;
  };
  return stableStringify(visit(summary));
}

export function normalizeSharedCatalogIdentity(input = {}) {
  return {
    platform: (requiredText(input.platform || 'ozon', 'platform')).toLowerCase(),
    marketplace: (requiredText(input.marketplace || 'ozon', 'marketplace')).toLowerCase(),
    locale: (requiredText(input.locale || 'DEFAULT', 'locale')).toUpperCase(),
    contractVersion: requiredText(
      input.contractVersion ?? input.contract_version ?? 'ozon-description-category-v1',
      'contractVersion',
    ),
    mapperVersion: requiredText(
      input.mapperVersion ?? input.mapper_version ?? 'shared-catalog-mapper-v1',
      'mapperVersion',
    ),
  };
}

export function buildSharedCatalogId(input = {}) {
  const identity = normalizeSharedCatalogIdentity(input);
  return `shared_catalog_${createStableHash({
    platform: identity.platform,
    marketplace: identity.marketplace,
    locale: identity.locale,
    contractVersion: identity.contractVersion,
  }, { length: 32 })}`;
}

function normalizeEntity(entityKind, input = {}) {
  switch (entityKind) {
    case 'category':
      return {
        category_id: requiredText(input.categoryId ?? input.category_id, 'categoryId'),
        parent_category_id: optionalText(input.parentCategoryId ?? input.parent_category_id),
        name: requiredText(input.name ?? input.title, 'category.name'),
        level: Math.max(0, Number.isFinite(Number(input.level)) ? Math.trunc(Number(input.level)) : 0),
        is_disabled: normalizeFlag(input.isDisabled ?? input.is_disabled),
      };
    case 'type':
      return {
        category_id: requiredText(input.categoryId ?? input.category_id, 'categoryId'),
        type_id: requiredText(input.typeId ?? input.type_id, 'typeId'),
        name: requiredText(input.name ?? input.title, 'type.name'),
        is_disabled: normalizeFlag(input.isDisabled ?? input.is_disabled),
      };
    case 'attribute':
      return {
        category_id: requiredText(input.categoryId ?? input.category_id, 'categoryId'),
        type_id: requiredText(input.typeId ?? input.type_id, 'typeId'),
        attribute_id: requiredText(input.attributeId ?? input.attribute_id ?? input.id, 'attributeId'),
        name: requiredText(input.name ?? input.title, 'attribute.name'),
        description: optionalText(input.description),
        group_name: optionalText(input.groupName ?? input.group_name ?? input.group?.name),
        value_type: optionalText(input.valueType ?? input.value_type ?? input.type),
        is_required: normalizeFlag(input.isRequired ?? input.is_required),
        is_collection: normalizeFlag(input.isCollection ?? input.is_collection),
        is_dictionary: normalizeFlag(input.isDictionary ?? input.is_dictionary ?? input.dictionary_id),
        dictionary_id: optionalText(input.dictionaryId ?? input.dictionary_id),
        complex_id: normalizeNonNegativeInteger(input.complexId ?? input.complex_id ?? input.attributeComplexId ?? input.attribute_complex_id),
        group_id: optionalText(input.groupId ?? input.group_id ?? input.group?.id),
        max_value_count: normalizeNonNegativeInteger(input.maxValueCount ?? input.max_value_count ?? input.maxValuesCount ?? input.max_values_count),
        is_aspect: normalizeFlag(input.isAspect ?? input.is_aspect),
        category_dependent: normalizeFlag(input.categoryDependent ?? input.category_dependent),
        unit: optionalText(input.unit ?? input.measurement_unit ?? input.measurementUnit),
      };
    case 'value':
      return {
        category_id: requiredText(input.categoryId ?? input.category_id, 'categoryId'),
        type_id: requiredText(input.typeId ?? input.type_id, 'typeId'),
        attribute_id: requiredText(input.attributeId ?? input.attribute_id, 'attributeId'),
        value_id: requiredText(
          input.valueId ?? input.value_id ?? input.id ?? input.attribute_value_id ?? input.value,
          'valueId',
        ),
        value_text: requiredText(
          input.valueText ?? input.value_text ?? input.value ?? input.name ?? input.title,
          'valueText',
        ),
        info: optionalText(input.info ?? input.description),
      };
    default: {
      const error = new Error(`Unsupported shared catalog entity kind: ${entityKind}`);
      error.code = 'SHARED_CATALOG_ENTITY_KIND_INVALID';
      throw error;
    }
  }
}

function stableEntityKey(entityKind, normalized) {
  const spec = ENTITY_SPECS[entityKind];
  return stableStringify(spec.idColumns.map((column) => normalized[column]));
}

function toPublicCatalog(row) {
  if (!row) return null;
  return {
    catalogId: row.catalog_id,
    platform: row.platform,
    marketplace: row.marketplace,
    locale: row.locale,
    contractVersion: row.contract_version,
    mapperVersion: row.mapper_version,
    sourceKind: row.source_kind,
    contentHash: row.content_hash || null,
    activeSnapshotId: row.active_snapshot_id || null,
    sourceSummary: JSON.parse(row.source_summary_json || '{}'),
    lastSeededAt: row.last_seeded_at || null,
    lastSyncedAt: row.last_synced_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicEntity(entityKind, row) {
  if (!row) return null;
  const base = {
    catalogId: row.catalog_id,
    contentHash: row.content_hash,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
  if (entityKind === 'category') {
    return {
      ...base,
      categoryId: row.category_id,
      parentCategoryId: row.parent_category_id || null,
      name: row.name,
      level: row.level,
      isDisabled: Boolean(row.is_disabled),
    };
  }
  if (entityKind === 'type') {
    return {
      ...base,
      categoryId: row.category_id,
      typeId: row.type_id,
      name: row.name,
      isDisabled: Boolean(row.is_disabled),
    };
  }
  if (entityKind === 'attribute') {
    const payload = parseEntityPayload(row);
    return {
      ...base,
      categoryId: row.category_id,
      typeId: row.type_id,
      attributeId: row.attribute_id,
      name: row.name,
      description: row.description || null,
      groupName: row.group_name || null,
      valueType: row.value_type || null,
      isRequired: Boolean(row.is_required),
      isCollection: Boolean(row.is_collection),
      isDictionary: Boolean(row.is_dictionary),
      dictionaryId: payload.dictionary_id || null,
      complexId: normalizeNonNegativeInteger(payload.complex_id),
      groupId: payload.group_id || null,
      maxValueCount: normalizeNonNegativeInteger(payload.max_value_count),
      isAspect: Boolean(payload.is_aspect),
      categoryDependent: Boolean(payload.category_dependent),
      unit: payload.unit || null,
    };
  }
  return {
    ...base,
    categoryId: row.category_id,
    typeId: row.type_id,
    attributeId: row.attribute_id,
    valueId: row.value_id,
    valueText: row.value_text,
    info: row.info || null,
  };
}

export function createSharedCatalogRepository(db) {
  function isAvailable() {
    return Boolean(db.prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = 'shared_catalog_versions'
    `).get());
  }

  function getCatalogById(catalogId) {
    return toPublicCatalog(db.prepare(
      'SELECT * FROM shared_catalog_versions WHERE catalog_id = ?',
    ).get(catalogId));
  }

  function getExistingEntity(entityKind, catalogId, normalized) {
    const spec = ENTITY_SPECS[entityKind];
    const predicates = ['catalog_id = ?', ...spec.idColumns.map((column) => `${column} = ?`)];
    return db.prepare(`SELECT * FROM ${spec.table} WHERE ${predicates.join(' AND ')}`).get(
      catalogId,
      ...spec.idColumns.map((column) => normalized[column]),
    );
  }

  function recordEntitySource({
    catalogId,
    entityKind,
    stableKey,
    contentHash,
    sourceKind,
    sourceShopId,
    sourceRefHash,
    importId,
    observedAt,
  }) {
    db.prepare(`
      INSERT INTO shared_catalog_entity_sources (
        catalog_id, entity_kind, stable_key, content_hash, source_kind,
        source_shop_id, source_ref_hash, import_id, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(catalog_id, entity_kind, stable_key, content_hash, source_ref_hash)
      DO UPDATE SET
        source_kind = excluded.source_kind,
        source_shop_id = excluded.source_shop_id,
        import_id = excluded.import_id,
        observed_at = excluded.observed_at
    `).run(
      catalogId,
      entityKind,
      stableKey,
      contentHash,
      sourceKind,
      sourceShopId,
      sourceRefHash,
      importId,
      observedAt,
    );
  }

  function quarantineConflict({
    catalogId,
    entityKind,
    stableKey,
    existing,
    incomingHash,
    incomingPayloadJson,
    sourceKind,
    sourceShopId,
    sourceRefHash,
    importId,
    detectedAt,
    reason = 'stable_key_content_conflict',
  }) {
    const quarantineId = `shared_catalog_quarantine_${createStableHash({
      catalogId,
      entityKind,
      stableKey,
      incomingHash,
      sourceRefHash,
    }, { length: 32 })}`;
    db.prepare(`
      INSERT INTO shared_catalog_quarantine (
        quarantine_id, catalog_id, entity_kind, stable_key, reason,
        existing_content_hash, incoming_content_hash, existing_payload_json,
        incoming_payload_json, source_kind, source_shop_id, source_ref_hash,
        import_id, resolution_status, detected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(catalog_id, entity_kind, stable_key, incoming_content_hash, source_ref_hash)
      DO UPDATE SET import_id = excluded.import_id, detected_at = excluded.detected_at
    `).run(
      quarantineId,
      catalogId,
      entityKind,
      stableKey,
      reason,
      existing?.content_hash || null,
      incomingHash,
      existing?.payload_json || null,
      incomingPayloadJson,
      sourceKind,
      sourceShopId,
      sourceRefHash,
      importId,
      detectedAt,
    );
    return quarantineId;
  }

  function upsertEntity(entityKind, catalogId, entity, provenance = {}, options = {}) {
    const spec = ENTITY_SPECS[entityKind];
    if (!spec) normalizeEntity(entityKind, entity);
    const normalized = normalizeEntity(entityKind, entity);
    const stableKey = stableEntityKey(entityKind, normalized);
    const contentHash = createStableHash(normalized, { length: 64 });
    const payloadJson = stableStringify(normalized);
    const existing = getExistingEntity(entityKind, catalogId, normalized);
    const timestamp = provenance.observedAt || nowIso();
    const sourceKind = normalizeSourceKind(provenance.sourceKind);
    const sourceShopId = optionalText(provenance.sourceShopId);
    const sourceRefHash = requiredText(provenance.sourceRefHash, 'sourceRefHash');
    const importId = requiredText(provenance.importId, 'importId');
    const conflictPolicy = normalizeConflictPolicy(options.conflictPolicy);

    if (!existing) {
      const columns = ['catalog_id', ...spec.fields, 'content_hash', 'payload_json', 'first_seen_at', 'last_seen_at'];
      db.prepare(`
        INSERT INTO ${spec.table} (${columns.join(', ')})
        VALUES (${columns.map(() => '?').join(', ')})
      `).run(
        catalogId,
        ...spec.fields.map((field) => normalized[field]),
        contentHash,
        payloadJson,
        timestamp,
        timestamp,
      );
      recordEntitySource({
        catalogId,
        entityKind,
        stableKey,
        contentHash,
        sourceKind,
        sourceShopId,
        sourceRefHash,
        importId,
        observedAt: timestamp,
      });
      return {
        outcome: 'inserted',
        stableKey,
        contentHash,
        entity: toPublicEntity(entityKind, getExistingEntity(entityKind, catalogId, normalized)),
      };
    }

    if (existing.content_hash === contentHash) {
      const predicates = ['catalog_id = ?', ...spec.idColumns.map((column) => `${column} = ?`)];
      db.prepare(`UPDATE ${spec.table} SET last_seen_at = ? WHERE ${predicates.join(' AND ')}`).run(
        timestamp,
        catalogId,
        ...spec.idColumns.map((column) => normalized[column]),
      );
      recordEntitySource({
        catalogId,
        entityKind,
        stableKey,
        contentHash,
        sourceKind,
        sourceShopId,
        sourceRefHash,
        importId,
        observedAt: timestamp,
      });
      return {
        outcome: 'deduplicated',
        stableKey,
        contentHash,
        entity: toPublicEntity(entityKind, getExistingEntity(entityKind, catalogId, normalized)),
      };
    }

    if (conflictPolicy === 'replace') {
      const assignments = [
        ...spec.fields.map((field) => `${field} = ?`),
        'content_hash = ?',
        'payload_json = ?',
        'last_seen_at = ?',
      ];
      const predicates = ['catalog_id = ?', ...spec.idColumns.map((column) => `${column} = ?`)];
      db.prepare(`UPDATE ${spec.table} SET ${assignments.join(', ')} WHERE ${predicates.join(' AND ')}`).run(
        ...spec.fields.map((field) => normalized[field]),
        contentHash,
        payloadJson,
        timestamp,
        catalogId,
        ...spec.idColumns.map((column) => normalized[column]),
      );
      recordEntitySource({
        catalogId,
        entityKind,
        stableKey,
        contentHash,
        sourceKind,
        sourceShopId,
        sourceRefHash,
        importId,
        observedAt: timestamp,
      });
      return {
        outcome: 'replaced',
        stableKey,
        contentHash,
        previousContentHash: existing.content_hash,
        entity: toPublicEntity(entityKind, getExistingEntity(entityKind, catalogId, normalized)),
      };
    }

    const quarantineId = quarantineConflict({
      catalogId,
      entityKind,
      stableKey,
      existing,
      incomingHash: contentHash,
      incomingPayloadJson: payloadJson,
      sourceKind,
      sourceShopId,
      sourceRefHash,
      importId,
      detectedAt: timestamp,
    });
    recordEntitySource({
      catalogId,
      entityKind,
      stableKey,
      contentHash,
      sourceKind,
      sourceShopId,
      sourceRefHash,
      importId,
      observedAt: timestamp,
    });
    return {
      outcome: 'quarantined',
      stableKey,
      contentHash,
      previousContentHash: existing.content_hash,
      quarantineId,
      entity: toPublicEntity(entityKind, existing),
    };
  }

  return {
    isAvailable,

    ensureCatalog(input = {}) {
      const identity = normalizeSharedCatalogIdentity(input);
      const catalogId = buildSharedCatalogId(identity);
      const sourceKind = normalizeSourceKind(input.sourceKind);
      const timestamp = nowIso();
      const sourceSummary = serializeSourceSummary(input.sourceSummary);
      db.prepare(`
        INSERT INTO shared_catalog_versions (
          catalog_id, platform, marketplace, locale, contract_version,
          mapper_version, source_kind, source_summary_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform, marketplace, locale, contract_version) DO UPDATE SET
          mapper_version = excluded.mapper_version,
          source_kind = CASE
            WHEN shared_catalog_versions.source_kind = 'remote' THEN shared_catalog_versions.source_kind
            ELSE excluded.source_kind
          END,
          source_summary_json = excluded.source_summary_json,
          updated_at = excluded.updated_at
      `).run(
        catalogId,
        identity.platform,
        identity.marketplace,
        identity.locale,
        identity.contractVersion,
        identity.mapperVersion,
        sourceKind,
        sourceSummary,
        timestamp,
        timestamp,
      );
      return this.getCatalog(identity);
    },

    getCatalog(input = {}) {
      if (typeof input === 'string') return getCatalogById(input);
      const identity = normalizeSharedCatalogIdentity(input);
      return toPublicCatalog(db.prepare(`
        SELECT * FROM shared_catalog_versions
        WHERE platform = ? AND marketplace = ? AND locale = ? AND contract_version = ?
      `).get(identity.platform, identity.marketplace, identity.locale, identity.contractVersion));
    },

    listCatalogs(filters = {}) {
      const platform = optionalText(filters.platform)?.toLowerCase() || null;
      const marketplace = optionalText(filters.marketplace)?.toLowerCase() || null;
      const locale = optionalText(filters.locale)?.toUpperCase() || null;
      return db.prepare(`
        SELECT * FROM shared_catalog_versions
        WHERE (? IS NULL OR platform = ?)
          AND (? IS NULL OR marketplace = ?)
          AND (? IS NULL OR locale = ?)
        ORDER BY platform, marketplace, locale, contract_version
        LIMIT ?
      `).all(
        platform,
        platform,
        marketplace,
        marketplace,
        locale,
        locale,
        Math.min(Math.max(Number(filters.limit) || 100, 1), 1000),
      ).map(toPublicCatalog);
    },

    beginImport(input = {}) {
      const catalog = getCatalogById(requiredText(input.catalogId, 'catalogId'));
      if (!catalog) {
        const error = new Error(`Shared catalog not found: ${input.catalogId}`);
        error.code = 'SHARED_CATALOG_NOT_FOUND';
        throw error;
      }
      const sourceKind = normalizeSourceKind(input.sourceKind);
      const timestamp = input.startedAt || nowIso();
      const sourceRefHash = createStableHash(
        input.sourceRefHash || input.sourceRef || [sourceKind, input.sourceShopId || '', catalog.catalogId],
        { length: 64 },
      );
      const importId = optionalText(input.importId) || `shared_catalog_import_${randomUUID()}`;
      const payloadHash = createStableHash(input.payloadHash || input.payload || '', { length: 64 });
      db.prepare(`
        INSERT INTO shared_catalog_import_runs (
          import_id, catalog_id, source_kind, source_shop_id, source_ref_hash,
          contract_version, mapper_version, payload_hash, status, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
      `).run(
        importId,
        catalog.catalogId,
        sourceKind,
        optionalText(input.sourceShopId),
        sourceRefHash,
        catalog.contractVersion,
        catalog.mapperVersion,
        payloadHash,
        timestamp,
      );
      return {
        importId,
        catalogId: catalog.catalogId,
        sourceKind,
        sourceShopId: optionalText(input.sourceShopId),
        sourceRefHash,
        payloadHash,
        startedAt: timestamp,
      };
    },

    finishImport(importId, counters = {}) {
      const timestamp = counters.completedAt || nowIso();
      const quarantinedCount = Math.max(0, Number(counters.quarantined || counters.quarantinedCount) || 0);
      const status = quarantinedCount > 0 ? 'completed_with_conflicts' : 'completed';
      db.prepare(`
        UPDATE shared_catalog_import_runs SET
          status = ?, inserted_count = ?, deduplicated_count = ?,
          replaced_count = ?, quarantined_count = ?, completed_at = ?
        WHERE import_id = ? AND status = 'running'
      `).run(
        status,
        Math.max(0, Number(counters.inserted || counters.insertedCount) || 0),
        Math.max(0, Number(counters.deduplicated || counters.deduplicatedCount) || 0),
        Math.max(0, Number(counters.replaced || counters.replacedCount) || 0),
        quarantinedCount,
        timestamp,
        requiredText(importId, 'importId'),
      );
      return db.prepare('SELECT * FROM shared_catalog_import_runs WHERE import_id = ?').get(importId);
    },

    failImport(importId, error) {
      db.prepare(`
        UPDATE shared_catalog_import_runs SET
          status = 'failed', error_json = ?, completed_at = ?
        WHERE import_id = ? AND status = 'running'
      `).run(stableStringify({
        code: error?.code || 'SHARED_CATALOG_IMPORT_FAILED',
        message: error instanceof Error ? error.message : String(error),
      }), nowIso(), requiredText(importId, 'importId'));
    },

    markCatalogImported(catalogId, input = {}) {
      const sourceKind = normalizeSourceKind(input.sourceKind);
      const timestamp = input.observedAt || nowIso();
      db.prepare(`
        UPDATE shared_catalog_versions SET
          mapper_version = ?, source_kind = ?, content_hash = ?, active_snapshot_id = ?,
          source_summary_json = ?,
          last_seeded_at = CASE WHEN ? = 'packaged_seed' THEN ? ELSE last_seeded_at END,
          last_synced_at = CASE WHEN ? = 'remote' THEN ? ELSE last_synced_at END,
          updated_at = ?
        WHERE catalog_id = ?
      `).run(
        requiredText(input.mapperVersion || 'shared-catalog-mapper-v1', 'mapperVersion'),
        sourceKind,
        requiredText(input.contentHash, 'contentHash'),
        requiredText(input.snapshotId, 'snapshotId'),
        serializeSourceSummary(input.sourceSummary),
        sourceKind,
        timestamp,
        sourceKind,
        timestamp,
        timestamp,
        requiredText(catalogId, 'catalogId'),
      );
      return getCatalogById(catalogId);
    },

    upsertCategory(catalogId, entity, provenance, options) {
      return upsertEntity('category', catalogId, entity, provenance, options);
    },
    upsertType(catalogId, entity, provenance, options) {
      return upsertEntity('type', catalogId, entity, provenance, options);
    },
    upsertAttribute(catalogId, entity, provenance, options) {
      return upsertEntity('attribute', catalogId, entity, provenance, options);
    },
    upsertAttributeValue(catalogId, entity, provenance, options) {
      return upsertEntity('value', catalogId, entity, provenance, options);
    },

    quarantineInvalidEntity(input = {}) {
      const catalogId = requiredText(input.catalogId, 'catalogId');
      const entityKind = ENTITY_SPECS[input.entityKind] ? input.entityKind : 'category';
      const payloadJson = stableStringify(input.payload ?? null);
      const incomingHash = createStableHash(payloadJson, { length: 64 });
      return quarantineConflict({
        catalogId,
        entityKind,
        stableKey: requiredText(input.stableKey || `invalid:${incomingHash}`, 'stableKey'),
        existing: null,
        incomingHash,
        incomingPayloadJson: payloadJson,
        sourceKind: normalizeSourceKind(input.sourceKind),
        sourceShopId: optionalText(input.sourceShopId),
        sourceRefHash: requiredText(input.sourceRefHash, 'sourceRefHash'),
        importId: requiredText(input.importId, 'importId'),
        detectedAt: input.detectedAt || nowIso(),
        reason: 'invalid_legacy_row',
      });
    },

    listCategories(catalogId, filters = {}) {
      return db.prepare(`
        SELECT * FROM shared_catalog_categories
        WHERE catalog_id = ? AND (? IS NULL OR parent_category_id = ?)
        ORDER BY level, name, category_id LIMIT ?
      `).all(
        requiredText(catalogId, 'catalogId'),
        optionalText(filters.parentCategoryId),
        optionalText(filters.parentCategoryId),
        Math.min(Math.max(Number(filters.limit) || 500, 1), 10_000),
      ).map((row) => toPublicEntity('category', row));
    },

    listTypes(catalogId, filters = {}) {
      const categoryId = optionalText(filters.categoryId);
      return db.prepare(`
        SELECT * FROM shared_catalog_types
        WHERE catalog_id = ? AND (? IS NULL OR category_id = ?)
        ORDER BY name, category_id, type_id LIMIT ?
      `).all(
        requiredText(catalogId, 'catalogId'),
        categoryId,
        categoryId,
        Math.min(Math.max(Number(filters.limit) || 500, 1), 10_000),
      ).map((row) => toPublicEntity('type', row));
    },

    listAttributes(catalogId, filters = {}) {
      const categoryId = optionalText(filters.categoryId);
      const typeId = optionalText(filters.typeId);
      return db.prepare(`
        SELECT * FROM shared_catalog_attributes
        WHERE catalog_id = ?
          AND (? IS NULL OR category_id = ?)
          AND (? IS NULL OR type_id = ?)
        ORDER BY name, attribute_id LIMIT ?
      `).all(
        requiredText(catalogId, 'catalogId'),
        categoryId,
        categoryId,
        typeId,
        typeId,
        Math.min(Math.max(Number(filters.limit) || 500, 1), 10_000),
      ).map((row) => toPublicEntity('attribute', row));
    },

    listAttributeValues(catalogId, filters = {}) {
      const attributeId = optionalText(filters.attributeId);
      return db.prepare(`
        SELECT * FROM shared_catalog_attribute_values
        WHERE catalog_id = ? AND (? IS NULL OR attribute_id = ?)
        ORDER BY value_text, value_id LIMIT ?
      `).all(
        requiredText(catalogId, 'catalogId'),
        attributeId,
        attributeId,
        Math.min(Math.max(Number(filters.limit) || 500, 1), 10_000),
      ).map((row) => toPublicEntity('value', row));
    },

    listQuarantine(filters = {}) {
      const catalogId = optionalText(filters.catalogId);
      const status = optionalText(filters.resolutionStatus);
      return db.prepare(`
        SELECT * FROM shared_catalog_quarantine
        WHERE (? IS NULL OR catalog_id = ?)
          AND (? IS NULL OR resolution_status = ?)
        ORDER BY detected_at, quarantine_id LIMIT ?
      `).all(
        catalogId,
        catalogId,
        status,
        status,
        Math.min(Math.max(Number(filters.limit) || 500, 1), 10_000),
      );
    },

    listImportRuns(filters = {}) {
      const catalogId = optionalText(filters.catalogId);
      return db.prepare(`
        SELECT * FROM shared_catalog_import_runs
        WHERE (? IS NULL OR catalog_id = ?)
        ORDER BY started_at, import_id LIMIT ?
      `).all(
        catalogId,
        catalogId,
        Math.min(Math.max(Number(filters.limit) || 500, 1), 10_000),
      );
    },

    listEntitySources(filters = {}) {
      const catalogId = optionalText(filters.catalogId);
      const entityKind = optionalText(filters.entityKind);
      return db.prepare(`
        SELECT * FROM shared_catalog_entity_sources
        WHERE (? IS NULL OR catalog_id = ?)
          AND (? IS NULL OR entity_kind = ?)
        ORDER BY observed_at, stable_key LIMIT ?
      `).all(
        catalogId,
        catalogId,
        entityKind,
        entityKind,
        Math.min(Math.max(Number(filters.limit) || 1000, 1), 20_000),
      );
    },
  };
}
