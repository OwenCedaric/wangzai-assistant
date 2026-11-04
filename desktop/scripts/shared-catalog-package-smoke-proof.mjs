import { createHash } from 'node:crypto';

export const PACKAGED_SHARED_CATALOG_EXPECTATION = Object.freeze({
  catalogId: 'shared_catalog_fa225727030b1ce084043b0f5bea58c2',
  platform: 'ozon',
  marketplace: 'ozon',
  locale: 'ZH_HANS',
  contractVersion: 'ozon-description-category-v1',
  mapperVersion: 'shared-catalog-mapper-v1',
  sourceKind: 'packaged_seed',
  seedAssetName: 'ozonCategoryTree.zh.json',
  declaredNodeCount: 7_988,
  categoryCount: 566,
  typeCount: 7_422,
  nodeCount: 7_988,
  contentHash: '5d2073c1816dcba9881501a42845f7f8c133580a05a65c092e838425e709446b',
  importPayloadHash: 'c575757e7f160634577ce7108100b8616be722cf44167ea6d349cea969c034f5',
  nodeSetHash: 'd30017f0e4a71eb17555bdf040313337e50ae5a778c8d32e6e424abefe3fc1a8',
  quarantineCount: 0,
});

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function fail(phase, message, details = {}) {
  throw new Error(
    `${phase}打包离线共享类目 SQLite 验收失败：${message}；${JSON.stringify(details)}`,
  );
}

function parseSourceSummary(value, phase) {
  try {
    const parsed = JSON.parse(value || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not-object');
    return parsed;
  } catch (error) {
    fail(phase, 'source_summary_json 不是有效对象', { value, cause: error?.message });
  }
}

function computeNodeSetHash(categories, types) {
  const hash = createHash('sha256');
  for (const [kind, rows] of [['category', categories], ['type', types]]) {
    for (const row of rows) {
      hash.update(kind);
      hash.update('\0');
      hash.update(JSON.stringify(row));
      hash.update('\n');
    }
  }
  return hash.digest('hex');
}

function retentionShape(proof) {
  return {
    catalogId: proof.catalogId,
    platform: proof.platform,
    marketplace: proof.marketplace,
    locale: proof.locale,
    contractVersion: proof.contractVersion,
    mapperVersion: proof.mapperVersion,
    sourceKind: proof.sourceKind,
    contentHash: proof.contentHash,
    activeSnapshotId: proof.activeSnapshotId,
    sourceSummary: proof.sourceSummary,
    lastSeededAt: proof.lastSeededAt,
    lastSyncedAt: proof.lastSyncedAt,
    createdAt: proof.createdAt,
    updatedAt: proof.updatedAt,
    categoryCount: proof.categoryCount,
    typeCount: proof.typeCount,
    nodeCount: proof.nodeCount,
    attributeCount: proof.attributeCount,
    attributeValueCount: proof.attributeValueCount,
    nodeSetHash: proof.nodeSetHash,
    quarantineCount: proof.quarantineCount,
    entitySourceCount: proof.entitySourceCount,
    shopOwnedEntitySourceCount: proof.shopOwnedEntitySourceCount,
    packagedSeedImportCount: proof.packagedSeedImportCount,
    packagedSeedImport: proof.packagedSeedImport,
  };
}

/**
 * Read and validate the catalog materialized by local-api from SQLite only.
 * This module deliberately never reads/imports the source JSON asset.
 */
export function verifyPackagedSharedCatalog(database, { phase = 'unknown-phase' } = {}) {
  const expected = PACKAGED_SHARED_CATALOG_EXPECTATION;
  const catalogs = database.prepare(`
    SELECT
      catalog_id AS catalogId,
      platform,
      marketplace,
      locale,
      contract_version AS contractVersion,
      mapper_version AS mapperVersion,
      source_kind AS sourceKind,
      content_hash AS contentHash,
      active_snapshot_id AS activeSnapshotId,
      source_summary_json AS sourceSummaryJson,
      last_seeded_at AS lastSeededAt,
      last_synced_at AS lastSyncedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM shared_catalog_versions
    WHERE platform = ? AND marketplace = ? AND locale = ? AND contract_version = ?
  `).all(expected.platform, expected.marketplace, expected.locale, expected.contractVersion);
  if (catalogs.length !== 1) {
    fail(phase, '目标 catalog 必须且只能有一份', { count: catalogs.length });
  }
  const catalog = catalogs[0];
  const sourceSummary = parseSourceSummary(catalog.sourceSummaryJson, phase);
  const categories = database.prepare(`
    SELECT
      category_id AS categoryId,
      parent_category_id AS parentCategoryId,
      name,
      level,
      is_disabled AS isDisabled,
      content_hash AS contentHash,
      payload_json AS payloadJson
    FROM shared_catalog_categories
    WHERE catalog_id = ?
    ORDER BY category_id
  `).all(catalog.catalogId);
  const types = database.prepare(`
    SELECT
      category_id AS categoryId,
      type_id AS typeId,
      name,
      is_disabled AS isDisabled,
      content_hash AS contentHash,
      payload_json AS payloadJson
    FROM shared_catalog_types
    WHERE catalog_id = ?
    ORDER BY category_id, type_id
  `).all(catalog.catalogId);
  const countRow = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM shared_catalog_attributes WHERE catalog_id = ?) AS attributeCount,
      (SELECT COUNT(*) FROM shared_catalog_attribute_values WHERE catalog_id = ?) AS attributeValueCount,
      (SELECT COUNT(*) FROM shared_catalog_quarantine) AS quarantineCount,
      (SELECT COUNT(*) FROM shared_catalog_entity_sources WHERE catalog_id = ?) AS entitySourceCount,
      (SELECT COUNT(*) FROM shared_catalog_entity_sources
        WHERE catalog_id = ? AND source_shop_id IS NOT NULL) AS shopOwnedEntitySourceCount
  `).get(catalog.catalogId, catalog.catalogId, catalog.catalogId, catalog.catalogId);
  const packagedSeedImports = database.prepare(`
    SELECT
      import_id AS importId,
      source_kind AS sourceKind,
      source_shop_id AS sourceShopId,
      contract_version AS contractVersion,
      mapper_version AS mapperVersion,
      payload_hash AS payloadHash,
      status,
      inserted_count AS insertedCount,
      deduplicated_count AS deduplicatedCount,
      replaced_count AS replacedCount,
      quarantined_count AS quarantinedCount,
      started_at AS startedAt,
      completed_at AS completedAt
    FROM shared_catalog_import_runs
    WHERE catalog_id = ? AND source_kind = 'packaged_seed'
    ORDER BY started_at, import_id
  `).all(catalog.catalogId);
  const packagedSeedImport = packagedSeedImports[0] || null;
  const proof = {
    ...catalog,
    sourceSummary,
    categoryCount: categories.length,
    typeCount: types.length,
    nodeCount: categories.length + types.length,
    attributeCount: Number(countRow?.attributeCount || 0),
    attributeValueCount: Number(countRow?.attributeValueCount || 0),
    nodeSetHash: computeNodeSetHash(categories, types),
    quarantineCount: Number(countRow?.quarantineCount || 0),
    entitySourceCount: Number(countRow?.entitySourceCount || 0),
    shopOwnedEntitySourceCount: Number(countRow?.shopOwnedEntitySourceCount || 0),
    packagedSeedImportCount: packagedSeedImports.length,
    packagedSeedImport,
  };

  const expectedFields = {
    catalogId: expected.catalogId,
    platform: expected.platform,
    marketplace: expected.marketplace,
    locale: expected.locale,
    contractVersion: expected.contractVersion,
    mapperVersion: expected.mapperVersion,
    sourceKind: expected.sourceKind,
    contentHash: expected.contentHash,
    categoryCount: expected.categoryCount,
    typeCount: expected.typeCount,
    nodeCount: expected.nodeCount,
    nodeSetHash: expected.nodeSetHash,
    quarantineCount: expected.quarantineCount,
  };
  const actualFields = Object.fromEntries(
    Object.keys(expectedFields).map((key) => [key, proof[key]]),
  );
  if (JSON.stringify(actualFields) !== JSON.stringify(expectedFields)) {
    fail(phase, '身份、版本、节点数量或哈希不符合内置 seed 合同', {
      expected: expectedFields,
      actual: actualFields,
    });
  }
  if (
    sourceSummary.seedAssetName !== expected.seedAssetName
    || Number(sourceSummary.declaredNodeCount) !== expected.declaredNodeCount
    || JSON.stringify(sourceSummary.entityKinds) !== JSON.stringify(['category', 'type'])
  ) {
    fail(phase, '落库的 seed 来源摘要不符合合同', { sourceSummary });
  }
  if (
    proof.attributeCount !== 0
    || proof.attributeValueCount !== 0
    || proof.entitySourceCount !== expected.nodeCount
    || proof.shopOwnedEntitySourceCount !== 0
    || proof.packagedSeedImportCount !== 1
    || !proof.activeSnapshotId
    || !proof.lastSeededAt
  ) {
    fail(phase, '落库数量、来源或 snapshot 不完整', { proof: retentionShape(proof) });
  }
  const expectedImport = {
    sourceKind: expected.sourceKind,
    sourceShopId: null,
    contractVersion: expected.contractVersion,
    mapperVersion: expected.mapperVersion,
    payloadHash: expected.importPayloadHash,
    status: 'completed',
    insertedCount: expected.nodeCount,
    deduplicatedCount: 0,
    replacedCount: 0,
    quarantinedCount: 0,
  };
  const actualImport = packagedSeedImport
    ? Object.fromEntries(Object.keys(expectedImport).map((key) => [key, packagedSeedImport[key]]))
    : null;
  if (JSON.stringify(actualImport) !== JSON.stringify(expectedImport)) {
    fail(phase, 'packaged_seed 导入记录不完整', { expectedImport, actualImport });
  }

  const retained = retentionShape(proof);
  return {
    ...retained,
    retainedFingerprint: sha256(JSON.stringify(retained)),
  };
}

export function assertPackagedSharedCatalogUnchanged(baseline, actual, { phase = 'unknown-phase' } = {}) {
  if (!baseline?.retainedFingerprint || !actual?.retainedFingerprint) {
    fail(phase, '缺少可比较的共享类目基线指纹');
  }
  if (
    baseline.retainedFingerprint !== actual.retainedFingerprint
    || JSON.stringify(baseline) !== JSON.stringify(actual)
  ) {
    fail(phase, '共享类目在店铺无关操作后发生变化', {
      baseline,
      actual,
    });
  }
  return actual;
}
