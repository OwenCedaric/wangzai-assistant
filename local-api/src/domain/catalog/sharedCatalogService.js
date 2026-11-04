import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSharedCatalogRepository,
  normalizeSharedCatalogIdentity,
} from '../../db/repositories/sharedCatalogRepository.js';
import { createStableHash } from '../../utils/stableHash.js';

const DEFAULT_CONTRACT_VERSION = 'ozon-description-category-v1';
const DEFAULT_MAPPER_VERSION = 'shared-catalog-mapper-v1';

function optionalText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function getTreeItems(treeData) {
  if (Array.isArray(treeData)) return treeData;
  if (Array.isArray(treeData?.items)) return treeData.items;
  if (Array.isArray(treeData?.result)) return treeData.result;
  if (Array.isArray(treeData?.result?.items)) return treeData.result.items;
  return [];
}

function getChildren(node = {}) {
  if (Array.isArray(node.children)) return node.children;
  if (Array.isArray(node.items)) return node.items;
  if (Array.isArray(node.childs)) return node.childs;
  return [];
}

function normalizeCategoryId(node = {}) {
  return optionalText(
    node.description_category_id ?? node.descriptionCategoryId ?? node.category_id ?? node.categoryId,
  );
}

function normalizeTypeId(node = {}) {
  return optionalText(node.type_id ?? node.typeId ?? node.description_type_id);
}

function getCategoryName(node = {}) {
  return optionalText(node.category_name ?? node.categoryName ?? node.title ?? node.name);
}

function getTypeName(node = {}) {
  return optionalText(node.type_name ?? node.typeName ?? node.title ?? node.name ?? node.category_name);
}

export function flattenSharedCategoryTree(treeData) {
  const categories = [];
  const types = [];

  const walk = (nodes, context = {}) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const categoryId = normalizeCategoryId(node);
      const typeId = normalizeTypeId(node);
      const categoryContext = categoryId || context.categoryId || null;
      const level = Math.max(0, Number.isFinite(Number(node.level))
        ? Math.trunc(Number(node.level))
        : Number(context.level) || 0);

      if (categoryId && getCategoryName(node)) {
        categories.push({
          categoryId,
          parentCategoryId: context.categoryId || null,
          name: getCategoryName(node),
          level,
          isDisabled: Boolean(node.disabled ?? node.is_disabled ?? node.isDisabled),
        });
      }

      if (typeId && categoryContext && getTypeName(node)) {
        types.push({
          categoryId: categoryContext,
          typeId,
          name: getTypeName(node),
          isDisabled: Boolean(node.disabled ?? node.is_disabled ?? node.isDisabled),
        });
      }

      walk(getChildren(node), {
        categoryId: categoryContext,
        level: level + 1,
      });
    }
  };

  walk(getTreeItems(treeData));
  return { categories, types };
}

function normalizeAttribute(item = {}, context = {}) {
  const flag = (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const normalized = String(value ?? '').trim().toLowerCase();
    return Boolean(normalized) && !['0', 'false', 'no', 'off', 'null', 'undefined'].includes(normalized);
  };
  return {
    categoryId: context.categoryId ?? item.category_id ?? item.categoryId,
    typeId: context.typeId ?? item.type_id ?? item.typeId,
    attributeId: item.attribute_id ?? item.attributeId ?? item.id,
    name: item.name ?? item.title,
    description: item.description ?? null,
    groupName: item.group_name ?? item.groupName ?? item.group?.name ?? null,
    valueType: item.type ?? item.value_type ?? item.valueType ?? null,
    isRequired: flag(item.is_required ?? item.isRequired),
    isCollection: flag(item.is_collection ?? item.isCollection),
    isDictionary: flag(item.is_dictionary ?? item.isDictionary ?? item.dictionary_id),
    dictionaryId: item.dictionary_id ?? item.dictionaryId ?? null,
    complexId: Number(item.complex_id ?? item.complexId ?? item.attribute_complex_id ?? item.attributeComplexId) || 0,
    groupId: item.group_id ?? item.groupId ?? item.group?.id ?? null,
    maxValueCount: Math.max(0, Number(item.max_value_count ?? item.maxValueCount ?? item.max_values_count ?? item.maxValuesCount) || 0),
    isAspect: flag(item.is_aspect ?? item.isAspect),
    categoryDependent: flag(item.category_dependent ?? item.categoryDependent),
    unit: item.unit ?? item.measurement_unit ?? item.measurementUnit ?? null,
  };
}

function normalizeAttributeValue(item = {}, context = {}) {
  return {
    categoryId: context.categoryId ?? item.category_id ?? item.categoryId,
    typeId: context.typeId ?? item.type_id ?? item.typeId,
    attributeId: context.attributeId ?? item.attribute_id ?? item.attributeId,
    valueId: item.value_id ?? item.valueId ?? item.id ?? item.attribute_value_id ?? item.value,
    valueText: item.value ?? item.value_text ?? item.valueText ?? item.name ?? item.title,
    info: item.info ?? item.description ?? null,
  };
}

function createCatalogServiceError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'SharedCatalogServiceError';
  error.code = code;
  Object.assign(error, details);
  return error;
}

function defaultSeedPath() {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, '../../../assets/ozonCategoryTree.zh.json');
}

function getSeedPath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.WANGZAI_OZON_CATEGORY_TREE_PATH,
    defaultSeedPath(),
  ].filter(Boolean);
  const selected = candidates.find((candidate) => existsSync(candidate));
  if (!selected) {
    throw createCatalogServiceError(
      'SHARED_CATALOG_SEED_NOT_FOUND',
      'Packaged shared catalog seed was not found.',
      { candidates: candidates.map((candidate) => basename(candidate)) },
    );
  }
  return selected;
}

function newCounters() {
  return { inserted: 0, deduplicated: 0, replaced: 0, quarantined: 0 };
}

function recordOutcome(counters, result) {
  if (Object.hasOwn(counters, result.outcome)) counters[result.outcome] += 1;
}

function normalizeIdentity(input = {}, fallbackLocale = 'DEFAULT') {
  return normalizeSharedCatalogIdentity({
    platform: input.platform || 'ozon',
    marketplace: input.marketplace || 'ozon',
    locale: input.locale || fallbackLocale,
    contractVersion: input.contractVersion ?? input.contract_version ?? DEFAULT_CONTRACT_VERSION,
    mapperVersion: input.mapperVersion ?? input.mapper_version ?? DEFAULT_MAPPER_VERSION,
  });
}

export function createSharedCatalogService(db, options = {}) {
  const repository = options.repository || createSharedCatalogRepository(db);

  function importEntities(input = {}) {
    if (!repository.isAvailable()) {
      throw createCatalogServiceError(
        'SHARED_CATALOG_MIGRATION_REQUIRED',
        'Migration 059 is required before shared catalog imports can run.',
      );
    }

    const identity = normalizeIdentity(input.identity || input, input.locale);
    const sourceKind = input.sourceKind || 'remote';
    const conflictPolicy = input.conflictPolicy || (sourceKind === 'remote' ? 'replace' : 'quarantine');
    const catalog = repository.ensureCatalog({
      ...identity,
      sourceKind,
      sourceSummary: input.sourceSummary || {},
    });
    const run = repository.beginImport({
      catalogId: catalog.catalogId,
      sourceKind,
      sourceShopId: input.sourceShopId,
      sourceRef: input.sourceRef,
      sourceRefHash: input.sourceRefHash,
      payload: input.payload,
      payloadHash: input.payloadHash,
    });
    const counters = newCounters();
    const appliedHashes = [];
    const ownsTransaction = !db.isTransaction;

    if (ownsTransaction) db.exec('BEGIN IMMEDIATE;');
    try {
      const provenance = {
        importId: run.importId,
        sourceKind,
        sourceShopId: input.sourceShopId,
        sourceRefHash: run.sourceRefHash,
        observedAt: input.observedAt,
      };
      const groups = [
        ['category', input.entities?.categories || [], repository.upsertCategory],
        ['type', input.entities?.types || [], repository.upsertType],
        ['attribute', input.entities?.attributes || [], repository.upsertAttribute],
        ['value', input.entities?.values || [], repository.upsertAttributeValue],
      ];

      for (const [entityKind, entities, writer] of groups) {
        for (const entity of entities) {
          try {
            const result = writer.call(repository, catalog.catalogId, entity, provenance, { conflictPolicy });
            recordOutcome(counters, result);
            appliedHashes.push(result.entity?.contentHash || result.contentHash);
          } catch (error) {
            if (sourceKind !== 'legacy_migration' || error?.code !== 'SHARED_CATALOG_FIELD_REQUIRED') throw error;
            repository.quarantineInvalidEntity({
              catalogId: catalog.catalogId,
              entityKind,
              payload: entity,
              stableKey: `invalid:${entityKind}:${createStableHash(entity, { length: 32 })}`,
              sourceKind,
              sourceShopId: input.sourceShopId,
              sourceRefHash: run.sourceRefHash,
              importId: run.importId,
              detectedAt: input.observedAt,
            });
            counters.quarantined += 1;
          }
        }
      }

      const contentHash = createStableHash({
        previousContentHash: catalog.contentHash,
        importPayloadHash: run.payloadHash,
        appliedHashes: appliedHashes.filter(Boolean).sort(),
      }, { length: 64 });
      repository.finishImport(run.importId, counters);
      const updatedCatalog = repository.markCatalogImported(catalog.catalogId, {
        sourceKind,
        mapperVersion: identity.mapperVersion,
        contentHash,
        snapshotId: run.importId,
        sourceSummary: input.sourceSummary || {},
        observedAt: input.observedAt,
      });
      if (ownsTransaction) db.exec('COMMIT;');
      return {
        ok: true,
        catalog: updatedCatalog,
        importId: run.importId,
        sourceRefHash: run.sourceRefHash,
        status: counters.quarantined > 0 ? 'completed_with_conflicts' : 'completed',
        counters,
      };
    } catch (error) {
      if (ownsTransaction && db.isTransaction) db.exec('ROLLBACK;');
      if (!db.isTransaction) repository.failImport(run.importId, error);
      throw error;
    }
  }

  function importCategoryTree(input = {}) {
    const treeData = input.treeData ?? input.payload ?? input.data;
    const entities = flattenSharedCategoryTree(treeData);
    return importEntities({
      ...input,
      payload: treeData,
      entities,
      sourceSummary: {
        endpointKey: input.endpointKey || null,
        entityKinds: ['category', 'type'],
        ...(input.sourceSummary || {}),
      },
    });
  }

  function importAttributes(input = {}) {
    const items = Array.isArray(input.attributes)
      ? input.attributes
      : getTreeItems(input.payload ?? input.data);
    const context = {
      categoryId: input.categoryId ?? input.category_id,
      typeId: input.typeId ?? input.type_id,
    };
    return importEntities({
      ...input,
      payload: input.payload ?? items,
      entities: { attributes: items.map((item) => normalizeAttribute(item, context)) },
      sourceSummary: {
        endpointKey: input.endpointKey || null,
        entityKinds: ['attribute'],
        ...(input.sourceSummary || {}),
      },
    });
  }

  function importAttributeValues(input = {}) {
    const items = Array.isArray(input.values)
      ? input.values
      : getTreeItems(input.payload ?? input.data);
    const context = {
      categoryId: input.categoryId ?? input.category_id,
      typeId: input.typeId ?? input.type_id,
      attributeId: input.attributeId ?? input.attribute_id,
    };
    return importEntities({
      ...input,
      payload: input.payload ?? items,
      entities: { values: items.map((item) => normalizeAttributeValue(item, context)) },
      sourceSummary: {
        endpointKey: input.endpointKey || null,
        entityKinds: ['value'],
        ...(input.sourceSummary || {}),
      },
    });
  }

  function seedFromPackagedJson(input = {}) {
    const filePath = getSeedPath(input.filePath);
    let seed;
    try {
      seed = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
    } catch (error) {
      throw createCatalogServiceError(
        'SHARED_CATALOG_SEED_INVALID',
        'Packaged shared catalog seed is not valid JSON.',
        { cause: error, seedAssetName: basename(filePath) },
      );
    }
    return importCategoryTree({
      ...input,
      locale: input.locale || seed.language || 'DEFAULT',
      contractVersion: input.contractVersion || DEFAULT_CONTRACT_VERSION,
      sourceKind: 'packaged_seed',
      conflictPolicy: 'quarantine',
      treeData: seed,
      sourceRef: `packaged-seed:${basename(filePath)}:${seed.fetchedAt || 'undated'}`,
      sourceSummary: {
        seedAssetName: basename(filePath),
        declaredSource: optionalText(seed.source),
        declaredFetchedAt: optionalText(seed.fetchedAt),
        declaredNodeCount: Number(seed.nodeCount) || null,
      },
    });
  }

  function migrateLegacyShopCatalogs(input = {}) {
    if (!repository.isAvailable()) {
      throw createCatalogServiceError('SHARED_CATALOG_MIGRATION_REQUIRED', 'Migration 059 is required.');
    }
    const legacyTable = db.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'catalog_cache_key_registry'
    `).get();
    if (!legacyTable) return { ok: true, migratedCacheKeys: 0, imports: [] };

    const keys = db.prepare(`
      SELECT * FROM catalog_cache_key_registry
      WHERE scope = 'shop' AND shop_id IS NOT NULL
      ORDER BY shop_id, cache_key
    `).all();
    const imports = [];
    let skippedCacheKeys = 0;

    for (const key of keys) {
      const identity = normalizeIdentity({
        ...input,
        locale: key.locale || input.locale || 'DEFAULT',
        contractVersion: input.contractVersion || `legacy-${key.payload_version || 'catalog-cache-v1'}`,
      });
      const entities = { categories: [], types: [], attributes: [], values: [] };

      for (const row of db.prepare(`
        SELECT * FROM catalog_category_nodes WHERE cache_key = ?
        ORDER BY level, node_id
      `).all(key.cache_key)) {
        entities.categories.push({
          categoryId: row.category_id,
          parentCategoryId: row.parent_category_id,
          name: row.title,
          level: row.level,
          isDisabled: Boolean(row.is_disabled),
        });
        if (row.type_id) {
          entities.types.push({
            categoryId: row.category_id,
            typeId: row.type_id,
            name: row.title,
            isDisabled: Boolean(row.is_disabled),
          });
        }
      }

      for (const row of db.prepare(`
        SELECT * FROM catalog_attributes WHERE cache_key = ? ORDER BY attribute_id
      `).all(key.cache_key)) {
        entities.attributes.push(normalizeAttribute(row, {
          categoryId: row.category_id || key.category_id,
          typeId: row.type_id || key.type_id,
        }));
      }

      for (const row of db.prepare(`
        SELECT * FROM catalog_attribute_values
        WHERE cache_key = ? ORDER BY attribute_id, value_id
      `).all(key.cache_key)) {
        entities.values.push(normalizeAttributeValue(row, {
          categoryId: row.category_id || key.category_id,
          typeId: row.type_id || key.type_id,
          attributeId: row.attribute_id || key.attribute_id,
        }));
      }

      if (!Object.values(entities).some((items) => items.length > 0)) continue;
      const sourceRef = `legacy-cache-key:${key.cache_key}`;
      const existingCatalog = repository.getCatalog(identity);
      const sourceRefHash = createStableHash(sourceRef, { length: 64 });
      const payloadHash = createStableHash(entities, { length: 64 });
      const alreadyImported = existingCatalog
        ? repository.listImportRuns({ catalogId: existingCatalog.catalogId, limit: 10_000 })
          .some((run) => (
            run.source_kind === 'legacy_migration'
            && ['completed', 'completed_with_conflicts'].includes(run.status)
            && run.source_ref_hash === sourceRefHash
            && run.payload_hash === payloadHash
          ))
        : false;
      if (alreadyImported) {
        skippedCacheKeys += 1;
        continue;
      }
      imports.push(importEntities({
        identity,
        sourceKind: 'legacy_migration',
        conflictPolicy: 'quarantine',
        sourceShopId: key.shop_id,
        sourceRef,
        payload: entities,
        entities,
        sourceSummary: {
          migratedFrom: 'catalog_cache_key_registry',
          legacyCatalogType: key.catalog_type,
          legacyPayloadVersion: key.payload_version,
        },
      }));
    }

    return {
      ok: true,
      migratedCacheKeys: imports.length,
      skippedCacheKeys,
      imports,
      counters: imports.reduce((total, item) => {
        for (const key of Object.keys(total)) total[key] += item.counters[key] || 0;
        return total;
      }, newCounters()),
    };
  }

  function resolvePath(input = {}) {
    const catalog = repository.getCatalog(input.catalogId || normalizeIdentity(input));
    if (!catalog) return null;
    const categories = repository.listCategories(catalog.catalogId, { limit: 10_000 });
    const categoryById = new Map(categories.map((item) => [item.categoryId, item]));
    let categoryId = optionalText(input.categoryId ?? input.descriptionCategoryId);
    let type = null;
    const typeId = optionalText(input.typeId);
    if (typeId) {
      type = repository.listTypes(catalog.catalogId, { limit: 10_000 })
        .find((item) => item.typeId === typeId) || null;
      categoryId = type?.categoryId || categoryId;
    }
    const names = [];
    const visited = new Set();
    while (categoryId && !visited.has(categoryId)) {
      visited.add(categoryId);
      const category = categoryById.get(categoryId);
      if (!category) break;
      names.unshift(category.name);
      categoryId = category.parentCategoryId;
    }
    if (type?.name && names.at(-1) !== type.name) names.push(type.name);
    if (names.length === 0) return null;
    return {
      catalogId: catalog.catalogId,
      path: names,
      pathText: names.join(' > '),
      source: 'sqlite-shared-catalog',
    };
  }

  return {
    isAvailable: repository.isAvailable,
    getDefaultSeedPath: defaultSeedPath,
    ensureCatalog(input = {}) {
      return repository.ensureCatalog(input);
    },
    listCatalogs: repository.listCatalogs,
    listCategories: repository.listCategories,
    listTypes: repository.listTypes,
    listAttributes: repository.listAttributes,
    listAttributeValues: repository.listAttributeValues,
    listQuarantine: repository.listQuarantine,
    listImportRuns: repository.listImportRuns,
    listEntitySources: repository.listEntitySources,
    importCategoryTree,
    importAttributes,
    importAttributeValues,
    seedFromPackagedJson,
    migrateLegacyShopCatalogs,
    resolvePath,
  };
}
