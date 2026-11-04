import { buildCatalogCacheKey, normalizeCatalogCacheKeyInput } from '../../cache/catalog/catalogCacheKeys.js';
import { createStableHash } from '../../utils/stableHash.js';

function nowIso() {
  return new Date().toISOString();
}

function toPublicKey(row) {
  return {
    cacheKey: row.cache_key,
    namespace: row.namespace,
    scope: row.scope,
    shopId: row.shop_id || null,
    catalogType: row.catalog_type,
    locale: row.locale,
    categoryId: row.category_id || null,
    typeId: row.type_id || null,
    attributeId: row.attribute_id || null,
    queryHash: row.query_hash || null,
    payloadVersion: row.payload_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicNode(row) {
  return {
    cacheKey: row.cache_key,
    nodeId: row.node_id,
    shopId: row.shop_id || null,
    categoryId: row.category_id,
    parentCategoryId: row.parent_category_id || null,
    typeId: row.type_id || null,
    title: row.title,
    level: row.level,
    isDisabled: Boolean(row.is_disabled),
    remoteHash: row.remote_hash || null,
    lastSeenAt: row.last_seen_at || null,
    missingFromRemoteAt: row.missing_from_remote_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicSyncState(row) {
  return {
    cacheKey: row.cache_key,
    shopId: row.shop_id || null,
    catalogType: row.catalog_type,
    status: row.status,
    lastSuccessAt: row.last_success_at || null,
    lastAttemptAt: row.last_attempt_at || null,
    lastError: row.last_error || null,
    remoteHash: row.remote_hash || null,
    snapshotVersion: row.snapshot_version || null,
    changedCount: row.changed_count,
    unchangedCount: row.unchanged_count,
    staleCount: row.stale_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicAttribute(row) {
  return {
    cacheKey: row.cache_key,
    attributeId: row.attribute_id,
    shopId: row.shop_id || null,
    categoryId: row.category_id || null,
    typeId: row.type_id || null,
    name: row.name,
    description: row.description || null,
    groupName: row.group_name || null,
    valueType: row.value_type || null,
    isRequired: Boolean(row.is_required),
    isCollection: Boolean(row.is_collection),
    isDictionary: Boolean(row.is_dictionary),
    remoteHash: row.remote_hash || null,
    lastSeenAt: row.last_seen_at || null,
    missingFromRemoteAt: row.missing_from_remote_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicAttributeValue(row) {
  return {
    cacheKey: row.cache_key,
    attributeId: row.attribute_id,
    valueId: row.value_id,
    shopId: row.shop_id || null,
    categoryId: row.category_id || null,
    typeId: row.type_id || null,
    valueText: row.value_text,
    info: row.info || null,
    remoteHash: row.remote_hash || null,
    lastSeenAt: row.last_seen_at || null,
    missingFromRemoteAt: row.missing_from_remote_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeNodeInput(node = {}) {
  const categoryId = String(node.categoryId ?? node.category_id ?? '').trim();
  const title = String(node.title ?? node.name ?? '').trim();

  if (!categoryId) {
    throw new Error('类目节点缺少 categoryId。');
  }
  if (!title) {
    throw new Error('类目节点缺少 title。');
  }

  return {
    nodeId: String(node.nodeId ?? node.node_id ?? categoryId).trim(),
    categoryId,
    parentCategoryId: node.parentCategoryId ?? node.parent_category_id ?? null,
    typeId: node.typeId ?? node.type_id ?? null,
    title,
    level: Number.isFinite(Number(node.level)) ? Number(node.level) : 0,
    isDisabled: node.isDisabled || node.is_disabled ? 1 : 0,
    remoteHash: node.remoteHash ?? node.remote_hash ?? createStableHash(node, { length: 32 }),
  };
}

function normalizeAttributeInput(attribute = {}) {
  const attributeId = String(attribute.attributeId ?? attribute.attribute_id ?? attribute.id ?? '').trim();
  const name = String(attribute.name ?? attribute.title ?? '').trim();

  if (!attributeId) {
    throw new Error('类目属性缺少 attributeId。');
  }
  if (!name) {
    throw new Error('类目属性缺少 name。');
  }

  return {
    attributeId,
    categoryId: attribute.categoryId ?? attribute.category_id ?? null,
    typeId: attribute.typeId ?? attribute.type_id ?? null,
    name,
    description: attribute.description ?? null,
    groupName: attribute.groupName ?? attribute.group_name ?? attribute.group?.name ?? null,
    valueType: attribute.valueType ?? attribute.value_type ?? attribute.type ?? null,
    isRequired: attribute.isRequired || attribute.is_required ? 1 : 0,
    isCollection: attribute.isCollection || attribute.is_collection ? 1 : 0,
    isDictionary: attribute.isDictionary || attribute.is_dictionary || attribute.dictionary_id ? 1 : 0,
    remoteHash: attribute.remoteHash ?? attribute.remote_hash ?? createStableHash(attribute, { length: 32 }),
  };
}

function normalizeAttributeValueInput(value = {}) {
  const attributeId = String(value.attributeId ?? value.attribute_id ?? '').trim();
  const valueId = String(value.valueId ?? value.value_id ?? value.id ?? value.attribute_value_id ?? value.value ?? '').trim();
  const valueText = String(value.valueText ?? value.value_text ?? value.value ?? value.name ?? value.title ?? '').trim();

  if (!attributeId) {
    throw new Error('类目属性值缺少 attributeId。');
  }
  if (!valueId) {
    throw new Error('类目属性值缺少 valueId。');
  }
  if (!valueText) {
    throw new Error('类目属性值缺少 valueText。');
  }

  return {
    attributeId,
    valueId,
    categoryId: value.categoryId ?? value.category_id ?? null,
    typeId: value.typeId ?? value.type_id ?? null,
    valueText,
    info: value.info ?? value.description ?? null,
    remoteHash: value.remoteHash ?? value.remote_hash ?? createStableHash(value, { length: 32 }),
  };
}

export function createCatalogCacheRepository(db) {
  return {
    upsertCacheKey(input = {}) {
      const normalized = normalizeCatalogCacheKeyInput(input);
      const cacheKey = buildCatalogCacheKey(normalized);
      const timestamp = nowIso();

      db.prepare(`
        INSERT INTO catalog_cache_key_registry (
          cache_key, namespace, scope, shop_id, catalog_type, locale,
          category_id, type_id, attribute_id, query_hash, payload_version,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          namespace = excluded.namespace,
          scope = excluded.scope,
          shop_id = excluded.shop_id,
          catalog_type = excluded.catalog_type,
          locale = excluded.locale,
          category_id = excluded.category_id,
          type_id = excluded.type_id,
          attribute_id = excluded.attribute_id,
          query_hash = excluded.query_hash,
          payload_version = excluded.payload_version,
          updated_at = excluded.updated_at
      `).run(
        cacheKey,
        normalized.namespace,
        normalized.scope,
        normalized.shopId,
        normalized.catalogType,
        normalized.locale,
        normalized.categoryId,
        normalized.typeId,
        normalized.attributeId,
        normalized.queryHash === 'none' ? null : normalized.queryHash,
        normalized.payloadVersion,
        timestamp,
        timestamp,
      );

      db.prepare(`
        INSERT INTO catalog_cache_sync_state (
          cache_key, shop_id, catalog_type, status, snapshot_version, created_at, updated_at
        )
        VALUES (?, ?, ?, 'idle', ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          shop_id = excluded.shop_id,
          catalog_type = excluded.catalog_type,
          updated_at = excluded.updated_at
      `).run(cacheKey, normalized.shopId, normalized.catalogType, normalized.payloadVersion, timestamp, timestamp);

      return this.getCacheKey(cacheKey);
    },

    getCacheKey(cacheKey) {
      const row = db
        .prepare('SELECT * FROM catalog_cache_key_registry WHERE cache_key = ?')
        .get(cacheKey);
      return row ? toPublicKey(row) : null;
    },

    listCacheKeys(filters = {}) {
      const rows = db
        .prepare(`
          SELECT * FROM catalog_cache_key_registry
          WHERE (? IS NULL OR catalog_type = ?)
            AND (? IS NULL OR shop_id = ?)
          ORDER BY updated_at DESC, cache_key ASC
          LIMIT ?
        `)
        .all(
          filters.catalogType || null,
          filters.catalogType || null,
          filters.shopId || null,
          filters.shopId || null,
          Math.min(Number(filters.limit) || 100, 500),
        );
      return rows.map(toPublicKey);
    },

    listSyncState(filters = {}) {
      const rows = db
        .prepare(`
          SELECT * FROM catalog_cache_sync_state
          WHERE (? IS NULL OR catalog_type = ?)
            AND (? IS NULL OR shop_id = ?)
          ORDER BY updated_at DESC, cache_key ASC
          LIMIT ?
        `)
        .all(
          filters.catalogType || null,
          filters.catalogType || null,
          filters.shopId || null,
          filters.shopId || null,
          Math.min(Number(filters.limit) || 100, 500),
        );
      return rows.map(toPublicSyncState);
    },

    updateSyncState(cacheKey, patch = {}) {
      const key = this.getCacheKey(cacheKey);
      if (!key) {
        throw new Error(`类目缓存 key 不存在：${cacheKey}`);
      }

      const timestamp = nowIso();
      const existing = db.prepare('SELECT * FROM catalog_cache_sync_state WHERE cache_key = ?').get(cacheKey);

      db.prepare(`
        INSERT INTO catalog_cache_sync_state (
          cache_key, shop_id, catalog_type, status, last_success_at, last_attempt_at,
          last_error, remote_hash, snapshot_version, changed_count, unchanged_count,
          stale_count, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          status = excluded.status,
          last_success_at = excluded.last_success_at,
          last_attempt_at = excluded.last_attempt_at,
          last_error = excluded.last_error,
          remote_hash = excluded.remote_hash,
          snapshot_version = excluded.snapshot_version,
          changed_count = excluded.changed_count,
          unchanged_count = excluded.unchanged_count,
          stale_count = excluded.stale_count,
          updated_at = excluded.updated_at
      `).run(
        cacheKey,
        key.shopId,
        key.catalogType,
        patch.status ?? existing?.status ?? 'idle',
        patch.lastSuccessAt ?? patch.last_success_at ?? existing?.last_success_at ?? null,
        patch.lastAttemptAt ?? patch.last_attempt_at ?? existing?.last_attempt_at ?? timestamp,
        patch.lastError ?? patch.last_error ?? null,
        patch.remoteHash ?? patch.remote_hash ?? existing?.remote_hash ?? null,
        patch.snapshotVersion ?? patch.snapshot_version ?? existing?.snapshot_version ?? key.payloadVersion,
        Number.isFinite(Number(patch.changedCount ?? patch.changed_count)) ? Number(patch.changedCount ?? patch.changed_count) : existing?.changed_count ?? 0,
        Number.isFinite(Number(patch.unchangedCount ?? patch.unchanged_count)) ? Number(patch.unchangedCount ?? patch.unchanged_count) : existing?.unchanged_count ?? 0,
        Number.isFinite(Number(patch.staleCount ?? patch.stale_count)) ? Number(patch.staleCount ?? patch.stale_count) : existing?.stale_count ?? 0,
        existing?.created_at || timestamp,
        timestamp,
      );

      const row = db.prepare('SELECT * FROM catalog_cache_sync_state WHERE cache_key = ?').get(cacheKey);
      return toPublicSyncState(row);
    },

    upsertCategoryNode(cacheKey, node = {}) {
      const key = this.getCacheKey(cacheKey);
      if (!key) {
        throw new Error(`类目缓存 key 不存在：${cacheKey}`);
      }

      const normalized = normalizeNodeInput(node);
      const timestamp = nowIso();

      db.prepare(`
        INSERT INTO catalog_category_nodes (
          cache_key, node_id, shop_id, category_id, parent_category_id,
          type_id, title, level, is_disabled, remote_hash, last_seen_at,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key, node_id) DO UPDATE SET
          shop_id = excluded.shop_id,
          category_id = excluded.category_id,
          parent_category_id = excluded.parent_category_id,
          type_id = excluded.type_id,
          title = excluded.title,
          level = excluded.level,
          is_disabled = excluded.is_disabled,
          remote_hash = excluded.remote_hash,
          last_seen_at = excluded.last_seen_at,
          missing_from_remote_at = NULL,
          updated_at = excluded.updated_at
      `).run(
        cacheKey,
        normalized.nodeId,
        key.shopId,
        normalized.categoryId,
        normalized.parentCategoryId,
        normalized.typeId,
        normalized.title,
        normalized.level,
        normalized.isDisabled,
        normalized.remoteHash,
        timestamp,
        timestamp,
        timestamp,
      );

      return this.getCategoryNode(cacheKey, normalized.nodeId);
    },

    getCategoryNode(cacheKey, nodeId) {
      const row = db
        .prepare('SELECT * FROM catalog_category_nodes WHERE cache_key = ? AND node_id = ?')
        .get(cacheKey, nodeId);
      return row ? toPublicNode(row) : null;
    },

    listCategoryNodes(filters = {}) {
      const rows = db
        .prepare(`
          SELECT * FROM catalog_category_nodes
          WHERE (? IS NULL OR cache_key = ?)
            AND (? IS NULL OR parent_category_id = ?)
            AND (? IS NULL OR shop_id = ?)
          ORDER BY level ASC, title ASC, category_id ASC
          LIMIT ?
        `)
        .all(
          filters.cacheKey || null,
          filters.cacheKey || null,
          filters.parentCategoryId || null,
          filters.parentCategoryId || null,
          filters.shopId || null,
          filters.shopId || null,
          Math.min(Number(filters.limit) || 200, 1000),
        );
      return rows.map(toPublicNode);
    },

    upsertAttribute(cacheKey, attribute = {}) {
      const key = this.getCacheKey(cacheKey);
      if (!key) {
        throw new Error(`类目缓存 key 不存在：${cacheKey}`);
      }

      const normalized = normalizeAttributeInput(attribute);
      const timestamp = nowIso();

      db.prepare(`
        INSERT INTO catalog_attributes (
          cache_key, attribute_id, shop_id, category_id, type_id, name, description,
          group_name, value_type, is_required, is_collection, is_dictionary,
          remote_hash, last_seen_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key, attribute_id) DO UPDATE SET
          shop_id = excluded.shop_id,
          category_id = excluded.category_id,
          type_id = excluded.type_id,
          name = excluded.name,
          description = excluded.description,
          group_name = excluded.group_name,
          value_type = excluded.value_type,
          is_required = excluded.is_required,
          is_collection = excluded.is_collection,
          is_dictionary = excluded.is_dictionary,
          remote_hash = excluded.remote_hash,
          last_seen_at = excluded.last_seen_at,
          missing_from_remote_at = NULL,
          updated_at = excluded.updated_at
      `).run(
        cacheKey,
        normalized.attributeId,
        key.shopId,
        normalized.categoryId ?? key.categoryId,
        normalized.typeId ?? key.typeId,
        normalized.name,
        normalized.description,
        normalized.groupName,
        normalized.valueType,
        normalized.isRequired,
        normalized.isCollection,
        normalized.isDictionary,
        normalized.remoteHash,
        timestamp,
        timestamp,
        timestamp,
      );

      const row = db
        .prepare('SELECT * FROM catalog_attributes WHERE cache_key = ? AND attribute_id = ?')
        .get(cacheKey, normalized.attributeId);
      return toPublicAttribute(row);
    },

    listAttributes(filters = {}) {
      const rows = db
        .prepare(`
          SELECT * FROM catalog_attributes
          WHERE (? IS NULL OR cache_key = ?)
            AND (? IS NULL OR category_id = ?)
            AND (? IS NULL OR type_id = ?)
          ORDER BY name ASC, attribute_id ASC
          LIMIT ?
        `)
        .all(
          filters.cacheKey || null,
          filters.cacheKey || null,
          filters.categoryId || null,
          filters.categoryId || null,
          filters.typeId || null,
          filters.typeId || null,
          Math.min(Number(filters.limit) || 500, 1000),
        );
      return rows.map(toPublicAttribute);
    },

    upsertAttributeValue(cacheKey, value = {}) {
      const key = this.getCacheKey(cacheKey);
      if (!key) {
        throw new Error(`类目缓存 key 不存在：${cacheKey}`);
      }

      const normalized = normalizeAttributeValueInput(value);
      const timestamp = nowIso();

      db.prepare(`
        INSERT INTO catalog_attribute_values (
          cache_key, attribute_id, value_id, shop_id, category_id, type_id,
          value_text, info, remote_hash, last_seen_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key, attribute_id, value_id) DO UPDATE SET
          shop_id = excluded.shop_id,
          category_id = excluded.category_id,
          type_id = excluded.type_id,
          value_text = excluded.value_text,
          info = excluded.info,
          remote_hash = excluded.remote_hash,
          last_seen_at = excluded.last_seen_at,
          missing_from_remote_at = NULL,
          updated_at = excluded.updated_at
      `).run(
        cacheKey,
        normalized.attributeId,
        normalized.valueId,
        key.shopId,
        normalized.categoryId ?? key.categoryId,
        normalized.typeId ?? key.typeId,
        normalized.valueText,
        normalized.info,
        normalized.remoteHash,
        timestamp,
        timestamp,
        timestamp,
      );

      const row = db
        .prepare('SELECT * FROM catalog_attribute_values WHERE cache_key = ? AND attribute_id = ? AND value_id = ?')
        .get(cacheKey, normalized.attributeId, normalized.valueId);
      return toPublicAttributeValue(row);
    },

    listAttributeValues(filters = {}) {
      const rows = db
        .prepare(`
          SELECT * FROM catalog_attribute_values
          WHERE (? IS NULL OR cache_key = ?)
            AND (? IS NULL OR attribute_id = ?)
          ORDER BY value_text ASC, value_id ASC
          LIMIT ?
        `)
        .all(
          filters.cacheKey || null,
          filters.cacheKey || null,
          filters.attributeId || null,
          filters.attributeId || null,
          Math.min(Number(filters.limit) || 500, 1000),
        );
      return rows.map(toPublicAttributeValue);
    },
  };
}
