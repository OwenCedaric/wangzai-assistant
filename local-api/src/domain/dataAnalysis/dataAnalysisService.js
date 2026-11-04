import { createDataAnalysisRepository } from '../../db/repositories/dataAnalysisRepository.js';
import { createIntegrationProfileRepository } from '../../db/repositories/integrationProfileRepository.js';
import { createHotCacheService } from '../../cache/hotCacheService.js';
import { createDataAnalysisReadModel } from './dataAnalysisReadModel.js';

const DOMAIN = 'data-analysis';
const MARKET_ANALYSIS_TYPE = 'ozon-browser-market';
const MARKET_SOURCE_TYPE = 'ozon-browser-capture';
const OZON_BROWSER_SESSION_TYPE = 'ozon-browser-session';
const MARKET_SYNC_STALE_AFTER_MS = 10 * 60 * 1000;
const DASHBOARD_CACHE_CONTRACT = 'dashboard-v4-traffic-date-grain';
const DASHBOARD_SNAPSHOT_SOURCE_PREFIX = 'business-dashboard-v3-traffic-date-grain';

function normalizeText(value, fallback = '') {
  const text = value == null ? '' : String(value).trim();
  return text || fallback;
}

function toReadQuery(query = {}) {
  return {
    shopId: normalizeText(query.shopId || query.shop_id),
    shopIds: normalizeText(query.shopIds || query.shop_ids),
    analysisType: normalizeText(query.analysisType || query.analysis_type, 'all'),
    sourceType: normalizeText(query.sourceType || query.source_type, 'all'),
    sourceKey: normalizeText(query.sourceKey || query.source_key),
    search: normalizeText(query.search || query.keyword),
    startDate: normalizeText(query.startDate || query.dateFrom || query.start_date),
    endDate: normalizeText(query.endDate || query.dateTo || query.end_date),
    limit: query.limit,
    offset: query.offset,
    legacyGlobalOnly: query.legacyGlobalOnly === true
      || query.legacy_global_only === true
      || query.legacy_global_only === '1',
  };
}

function isMarketScope(input = {}) {
  return normalizeText(input.analysisType || input.analysis_type) === MARKET_ANALYSIS_TYPE
    || normalizeText(input.sourceType || input.source_type) === MARKET_SOURCE_TYPE;
}

function isStaleMarketSyncState(syncState, now = Date.now()) {
  if (normalizeText(syncState?.status) !== 'syncing') return false;
  const attemptedAt = Date.parse(normalizeText(syncState?.lastAttemptAt || syncState?.updatedAt));
  return !Number.isFinite(attemptedAt) || now - attemptedAt > MARKET_SYNC_STALE_AFTER_MS;
}

function marketSnapshotActualRowCount(snapshot = {}) {
  const marketData = snapshot?.payload?.marketData || snapshot?.marketData || snapshot || {};
  const sectionRows = Object.values(marketData.sections || {}).reduce(
    (total, section) => total + (Array.isArray(section?.records) ? section.records.length : 0),
    0,
  );
  const datasetRows = Array.isArray(marketData.datasetViews)
    ? marketData.datasetViews.reduce(
      (total, dataset) => total + (Array.isArray(dataset?.records) ? dataset.records.length : 0),
      0,
    )
    : 0;
  return Math.max(sectionRows, datasetRows);
}

function createLegacyMigrationError(reason) {
  const error = new Error(`DATA_ANALYSIS_MARKET_LEGACY_MIGRATION_INCOMPLETE: ${reason}`);
  error.code = 'DATA_ANALYSIS_MARKET_LEGACY_MIGRATION_INCOMPLETE';
  return error;
}

function validateLegacyMarketMigration(snapshot, legacySnapshot) {
  const marketData = snapshot?.payload?.marketData || {};
  const proof = marketData.legacyGlobalMigration;
  const requiredCoverage = Math.max(
    Number(legacySnapshot?.rowCount) || 0,
    marketSnapshotActualRowCount(legacySnapshot),
  );
  const incomingCoverage = marketSnapshotActualRowCount(snapshot);
  if (!proof || typeof proof !== 'object') {
    throw createLegacyMigrationError('缺少首次显式迁移凭证，已保留 legacy global 快照。');
  }
  if (normalizeText(proof.sourceKey) !== normalizeText(legacySnapshot.sourceKey)) {
    throw createLegacyMigrationError('迁移来源 profile 与 legacy global 快照不一致。');
  }
  if (Number(proof.sourceRowCount) !== Number(legacySnapshot.rowCount)) {
    throw createLegacyMigrationError('迁移来源行数已变化，必须重新读取 legacy global 快照后再合并。');
  }
  if (normalizeText(proof.sourceUpdatedAt) !== normalizeText(legacySnapshot.updatedAt)) {
    throw createLegacyMigrationError('迁移来源版本已变化，必须重新读取 legacy global 快照后再合并。');
  }
  if (incomingCoverage < requiredCoverage) {
    throw createLegacyMigrationError(`合并结果仅 ${incomingCoverage} 行，少于 legacy global 的 ${requiredCoverage} 行。`);
  }
  return { incomingCoverage, requiredCoverage };
}

function marketProfileId(input = {}) {
  return normalizeText(
    input.profileId
    || input.profile_id
    || input.sourceKey
    || input.source_key
    || input.payload?.marketData?.profileId,
  );
}

function resolveMarketShopScope(input = {}, integrationProfiles) {
  const declaredProfileIds = [
    input.profileId,
    input.profile_id,
    input.sourceKey,
    input.source_key,
    input.payload?.marketData?.profileId,
  ].map((value) => normalizeText(value)).filter(Boolean);
  if (new Set(declaredProfileIds).size > 1) {
    throw new Error('DATA_ANALYSIS_MARKET_PROFILE_SCOPE_MISMATCH');
  }
  const profileId = marketProfileId(input);
  if (!profileId) throw new Error('DATA_ANALYSIS_MARKET_PROFILE_REQUIRED');
  const profile = integrationProfiles?.getProfile?.(profileId);
  if (!profile || profile.integrationType !== OZON_BROWSER_SESSION_TYPE) {
    throw new Error('DATA_ANALYSIS_MARKET_PROFILE_NOT_FOUND');
  }
  const shopId = normalizeText(profile.shopId);
  if (!shopId) throw new Error('DATA_ANALYSIS_MARKET_SHOP_SCOPE_REQUIRED');
  const requestedShopId = normalizeText(input.shopId || input.shop_id);
  if (requestedShopId && requestedShopId !== shopId) {
    throw new Error('DATA_ANALYSIS_MARKET_SHOP_SCOPE_MISMATCH');
  }
  return { profileId, shopId };
}

function toSnapshotRows(dashboard = {}) {
  const definitions = [
    {
      analysisType: 'overview',
      title: '经营总览',
      section: dashboard.overview,
      payload: { diagnostics: dashboard.diagnostics || [], modules: dashboard.modules || [] },
    },
    {
      analysisType: 'sales',
      title: '销售分析',
      section: dashboard.sales,
      payload: {
        trend: dashboard.sales?.trend || [],
        statusBreakdown: dashboard.sales?.statusBreakdown || [],
        productRanking: (dashboard.sales?.productRanking || []).slice(0, 30),
      },
    },
    {
      analysisType: 'products',
      title: '商品分析',
      section: dashboard.products,
      payload: {
        quality: dashboard.products?.quality || {},
        visibilityBreakdown: dashboard.products?.visibilityBreakdown || [],
        stockRiskRows: (dashboard.products?.stockRiskRows || []).slice(0, 50),
      },
    },
    {
      analysisType: 'traffic',
      title: '流量转化',
      section: dashboard.traffic,
      payload: {
        funnel: dashboard.traffic?.funnel || [],
        dailyTrend: dashboard.traffic?.dailyTrend || [],
      },
    },
    {
      analysisType: 'finance',
      title: '利润与费用分析',
      section: dashboard.finance,
      payload: {
        currencyCoverage: dashboard.finance?.currencyCoverage || {},
        operationBreakdown: dashboard.finance?.operationBreakdown || [],
        largestDeductions: (dashboard.finance?.largestDeductions || []).slice(0, 30),
      },
    },
    {
      analysisType: 'after-sales',
      title: '售后分析',
      section: dashboard.afterSales,
      payload: {
        statusBreakdown: dashboard.afterSales?.statusBreakdown || [],
        reasonCodeBreakdown: dashboard.afterSales?.reasonCodeBreakdown || [],
        dataQuality: dashboard.afterSales?.dataQuality || {},
      },
    },
    {
      analysisType: 'marketing',
      title: '促销分析',
      section: dashboard.marketing,
      payload: {
        activityRows: (dashboard.marketing?.activityRows || []).slice(0, 30),
        activityTypeBreakdown: dashboard.marketing?.activityTypeBreakdown || [],
      },
    },
  ];
  return definitions.map((definition) => ({
    shopId: dashboard.shopId || '',
    analysisType: definition.analysisType,
    sourceType: 'derived-sqlite',
    sourceKey: 'business-read-model-v1',
    title: definition.title,
    status: 'ready',
    timeRangeStart: dashboard.range?.startDate || null,
    timeRangeEnd: dashboard.range?.endDate || null,
    rowCount: Number(definition.section?.rowCount) || 0,
    summary: {
      metricCount: Array.isArray(definition.section?.metrics) ? definition.section.metrics.length : 0,
      generatedAt: dashboard.generatedAt,
    },
    metrics: { rows: definition.section?.metrics || [] },
    payload: definition.payload,
    sourceStatus: 'derived_from_confirmed_sources',
    sourceSyncedAt: dashboard.generatedAt,
  }));
}

function toDashboardSnapshot(dashboard = {}) {
  const startDate = dashboard.range?.startDate || null;
  const endDate = dashboard.range?.endDate || null;
  return {
    shopId: dashboard.shopId || '',
    analysisType: 'dashboard',
    sourceType: 'derived-sqlite',
    sourceKey: `${DASHBOARD_SNAPSHOT_SOURCE_PREFIX}:${startDate || 'open'}:${endDate || 'open'}`,
    title: '经营分析聚合快照',
    status: 'ready',
    timeRangeStart: startDate,
    timeRangeEnd: endDate,
    rowCount: 0,
    summary: {
      generatedAt: dashboard.generatedAt,
      sourceUpdatedAt: dashboard.sourceUpdatedAt || null,
      moduleCount: Array.isArray(dashboard.modules) ? dashboard.modules.length : 0,
    },
    metrics: {},
    payload: { dashboard },
    sourceStatus: 'derived_from_confirmed_sources',
    sourceSyncedAt: dashboard.sourceUpdatedAt || dashboard.generatedAt,
  };
}

function createReadCacheKey(readQuery = {}) {
  return [
    readQuery.shopId || 'all-shops',
    readQuery.shopIds || 'active-shops',
    readQuery.analysisType || 'all',
    readQuery.sourceType || 'all',
    readQuery.sourceKey || '',
    readQuery.search || '',
    readQuery.startDate || '',
    readQuery.endDate || '',
    Number(readQuery.limit) || 50,
    Number(readQuery.offset) || 0,
  ].join('|');
}

function createNotConnectedPayload() {
  return {
    ok: false,
    domain: DOMAIN,
    cache: {
      enabled: false,
      policy: 'local-first-sqlite',
      remoteSyncConnected: false,
    },
    error: {
      code: 'DATA_ANALYSIS_CACHE_NOT_CONNECTED',
      message: '数据分析 SQLite 缓存仓库未接入，页面不能假装读取成功。',
    },
  };
}

export function createDataAnalysisService({ db, sourceDb = db, hotCache } = {}) {
  const repository = db ? createDataAnalysisRepository(db) : null;
  const integrationProfiles = db ? createIntegrationProfileRepository(db) : null;
  const readModel = sourceDb ? createDataAnalysisReadModel(sourceDb) : null;
  const dashboardHotCache = hotCache || createHotCacheService({
    maxEntries: 120,
    ttlMs: 30_000,
    maxPayloadBytes: 2 * 1024 * 1024,
    maxBytes: 48 * 1024 * 1024,
  });

  function invalidateShop(shopId = '') {
    const normalizedShopId = normalizeText(shopId);
    const tags = ['scope:all-shops'];
    if (normalizedShopId) tags.push(`shop:${normalizedShopId}`);
    return dashboardHotCache.invalidate({ tags });
  }

  return {
    domain: DOMAIN,

    readCache(query = {}) {
      if (!repository) return createNotConnectedPayload();

      let scopedQuery = query;
      if (isMarketScope(query) && !(query.legacyGlobalOnly === true || query.legacy_global_only === true || query.legacy_global_only === '1')) {
        const requestedShopId = normalizeText(query.shopId || query.shop_id);
        const profileId = marketProfileId(query);
        if (!requestedShopId && profileId) {
          try {
            const scope = resolveMarketShopScope(query, integrationProfiles);
            scopedQuery = { ...query, shopId: scope.shopId, sourceKey: scope.profileId };
          } catch {
            // An unknown/unbound profile must never fall back to another shop
            // or to the legacy global row.
            scopedQuery = { ...query, shopId: '__market-scope-unresolved__' };
          }
        } else if (!requestedShopId) {
          scopedQuery = { ...query, shopId: '__market-scope-required__' };
        }
      }
      const readQuery = toReadQuery(scopedQuery);
      const cacheScopeId = readQuery.shopId || `all:${readQuery.shopIds || 'active'}`;
      const cacheKey = dashboardHotCache.buildKey({
        operation: DOMAIN,
        shopId: cacheScopeId,
        queryKey: createReadCacheKey(readQuery),
        contractVersion: DASHBOARD_CACHE_CONTRACT,
      });
      const memory = dashboardHotCache.get(cacheKey);
      if (memory) {
        return {
          ...memory,
          cache: { ...memory.cache, readTier: 'memory-l1', hot: true },
        };
      }
      const list = repository.listSnapshots(readQuery);
      const stats = repository.getStats(readQuery);
      let syncState = repository.getSyncState(readQuery);
      const marketOnlyRead = readQuery.analysisType === 'ozon-browser-market'
        || readQuery.sourceType === 'ozon-browser-capture';
      if (marketOnlyRead && isStaleMarketSyncState(syncState)) {
        syncState = repository.recordSyncState({
          shopId: readQuery.shopId,
          analysisType: MARKET_ANALYSIS_TYPE,
          status: 'failed',
          lastAttemptAt: syncState.lastAttemptAt,
          lastError: {
            code: 'OZON_MARKET_REFRESH_INTERRUPTED',
            message: '上次市场刷新未正常结束，已恢复为可重试状态。',
            failedRoutes: [],
          },
        });
      }
      const storedDashboardSnapshot = marketOnlyRead ? null : repository.getDashboardSnapshot(readQuery);
      const dashboardSnapshot = storedDashboardSnapshot?.sourceKey?.startsWith(`${DASHBOARD_SNAPSHOT_SOURCE_PREFIX}:`)
        ? storedDashboardSnapshot
        : null;
      // First read after an upgrade still has a safe compatibility path. The
      // continuous data-analysis policy immediately creates the durable L2
      // snapshot; subsequent page opens never rebuild on the request path.
      const dashboard = marketOnlyRead
        ? null
        : dashboardSnapshot?.payload?.dashboard || readModel.build(readQuery);
      if (!marketOnlyRead && !dashboardSnapshot && dashboard) {
        repository.upsertSnapshot(toDashboardSnapshot(dashboard));
      }

      const payload = {
        ok: true,
        domain: DOMAIN,
        source: 'sqlite',
        cache: {
          enabled: true,
          policy: 'local-first-sqlite',
          remoteSyncConnected: false,
          localAnalysisConnected: true,
          canServeStale: true,
          readTier: marketOnlyRead
            ? 'sqlite-market-snapshot-l2'
            : dashboardSnapshot
              ? 'sqlite-snapshot-l2'
              : 'sqlite-live-fallback',
          hot: false,
          note: '页面只读取本地快照；后台按店铺独立重建经营分析，不在页面请求中直连Ozon。',
        },
        query: readQuery,
        rows: list.rows,
        total: list.total,
        limit: list.limit,
        offset: list.offset,
        stats,
        syncState,
        dashboard,
        updatedAt:
          dashboard?.sourceUpdatedAt ||
          stats.latestUpdatedAt ||
          syncState.updatedAt ||
          dashboard?.generatedAt ||
          null,
      };
      if (!readQuery.shopId) {
        payload.cache.aggregate = true;
        payload.cache.aggregateMode = 'sqlite-active-shop-rows';
      }
      dashboardHotCache.set(cacheKey, payload, {
        tags: [
          `domain:${DOMAIN}`,
          readQuery.shopId ? `shop:${readQuery.shopId}` : 'scope:all-shops',
        ],
      });
      return payload;
    },

    startSync(payload = {}) {
      const shopId = normalizeText(payload.shopId || payload.shop_id);
      const analysisType = normalizeText(payload.analysisType || payload.analysis_type, 'all');
      const attemptedAt = new Date().toISOString();
      if (!repository || !readModel) return createNotConnectedPayload();

      repository.recordSyncState({
        shopId,
        analysisType,
        status: 'syncing',
        lastAttemptAt: attemptedAt,
        lastError: null,
      });

      try {
        const dashboard = readModel.build({
          ...payload,
          shopId,
          analysisType,
        });
        const snapshots = [
          toDashboardSnapshot(dashboard),
          ...toSnapshotRows(dashboard),
        ].map((snapshot) => repository.upsertSnapshot(snapshot));
        let aggregateSnapshotCount = 0;
        if (shopId) {
          const aggregateDashboard = readModel.build({
            ...payload,
            shopId: '',
            shopIds: payload.aggregateShopIds || payload.aggregate_shop_ids || '',
            analysisType,
          });
          const aggregateSnapshots = [
            toDashboardSnapshot(aggregateDashboard),
            ...toSnapshotRows(aggregateDashboard),
          ].map((snapshot) => repository.upsertSnapshot(snapshot));
          aggregateSnapshotCount = aggregateSnapshots.length;
        }
        invalidateShop(shopId);
        const completedAt = new Date().toISOString();
        const syncState = repository.recordSyncState({
          shopId,
          analysisType,
          status: 'success',
          lastSuccessAt: completedAt,
          lastAttemptAt: attemptedAt,
          lastError: null,
          changedCount: snapshots.length,
          unchangedCount: 0,
          deletedCount: 0,
        });
        return {
          ok: true,
          accepted: true,
          completed: true,
          domain: DOMAIN,
          mode: 'local-analysis-rebuild',
          readPath: '/api/cache/data-analysis',
          cache: {
            enabled: true,
            policy: 'local-first-sqlite',
            remoteSyncConnected: false,
            localAnalysisConnected: true,
          },
          snapshotCount: snapshots.length + aggregateSnapshotCount,
          aggregateSnapshotCount,
          syncState,
          dashboard,
        };
      } catch (error) {
        const failure = {
          code: 'DATA_ANALYSIS_REBUILD_FAILED',
          message: error instanceof Error ? error.message : String(error),
        };
        const syncState = repository.recordSyncState({
          shopId,
          analysisType,
          status: 'failed',
          lastAttemptAt: attemptedAt,
          lastError: failure,
        });
        return {
          ok: false,
          accepted: false,
          domain: DOMAIN,
          readPath: '/api/cache/data-analysis',
          cache: {
            enabled: true,
            policy: 'local-first-sqlite',
            remoteSyncConnected: false,
            localAnalysisConnected: true,
          },
          syncState,
          error: failure,
        };
      }
    },

    saveSnapshot(snapshot = {}) {
      if (!repository) return createNotConnectedPayload();
      let scopedSnapshot = snapshot;
      let legacyDeletedCount = 0;
      let marketSyncState = null;
      if (isMarketScope(snapshot)) {
        const scope = resolveMarketShopScope(snapshot, integrationProfiles);
        scopedSnapshot = {
          ...snapshot,
          shopId: scope.shopId,
          sourceKey: scope.profileId,
          payload: {
            ...(snapshot.payload || {}),
            marketData: {
              ...(snapshot.payload?.marketData || {}),
              profileId: scope.profileId,
              shopId: scope.shopId,
            },
          },
        };
      }
      let row;
      let transactionStarted = false;
      try {
        let legacyMigration = null;
        if (isMarketScope(scopedSnapshot)) {
          db.exec('BEGIN IMMEDIATE');
          transactionStarted = true;
          const exactBefore = repository.listSnapshots({
            shopId: scopedSnapshot.shopId,
            analysisType: MARKET_ANALYSIS_TYPE,
            sourceType: MARKET_SOURCE_TYPE,
            sourceKey: scopedSnapshot.sourceKey,
            limit: 1,
          }).rows[0] || null;
          const legacyBefore = repository.listSnapshots({
            analysisType: MARKET_ANALYSIS_TYPE,
            sourceType: MARKET_SOURCE_TYPE,
            sourceKey: scopedSnapshot.sourceKey,
            legacyGlobalOnly: true,
            limit: 1,
          }).rows[0] || null;
          if (!exactBefore && legacyBefore) {
            legacyMigration = validateLegacyMarketMigration(scopedSnapshot, legacyBefore);
          }
        }
        row = repository.upsertSnapshot(scopedSnapshot);
        if (isMarketScope(scopedSnapshot) && legacyMigration) {
          legacyDeletedCount = repository.deleteLegacyGlobalSnapshot(scopedSnapshot).deletedCount;
        }
        if (isMarketScope(scopedSnapshot)) {
          const marketData = scopedSnapshot.payload?.marketData || {};
          const completedAt = normalizeText(
            marketData.lastCompletedAt
            || scopedSnapshot.updatedAt
            || scopedSnapshot.updated_at,
            new Date().toISOString(),
          );
          marketSyncState = repository.recordSyncState({
            shopId: row.shopId,
            analysisType: MARKET_ANALYSIS_TYPE,
            status: 'success',
            lastSuccessAt: completedAt,
            lastAttemptAt: normalizeText(marketData.lastAttemptAt, completedAt),
            lastError: null,
            changedCount: 1,
            unchangedCount: 0,
            deletedCount: legacyDeletedCount,
          });
          db.exec('COMMIT');
          transactionStarted = false;
        }
      } catch (error) {
        if (transactionStarted) {
          try { db.exec('ROLLBACK'); } catch { /* preserve original persistence error */ }
        }
        throw error;
      }
      invalidateShop(row.shopId);
      return {
        ok: true,
        domain: DOMAIN,
        row,
        legacyDeletedCount,
        marketSyncState,
      };
    },

    deleteSnapshot(query = {}) {
      if (!repository) return createNotConnectedPayload();
      let scopedQuery = query;
      if (isMarketScope(query)) {
        const scope = resolveMarketShopScope(query, integrationProfiles);
        scopedQuery = { ...query, shopId: scope.shopId, sourceKey: scope.profileId };
      }
      const result = repository.deleteSnapshots(scopedQuery);
      invalidateShop(scopedQuery.shopId || scopedQuery.shop_id);
      return {
        ok: true,
        domain: DOMAIN,
        ...result,
      };
    },

    recordSyncState(input = {}) {
      if (!repository) return createNotConnectedPayload();
      let scopedInput = input;
      if (isMarketScope(input)) {
        const scope = resolveMarketShopScope(input, integrationProfiles);
        scopedInput = {
          ...input,
          shopId: scope.shopId,
          analysisType: MARKET_ANALYSIS_TYPE,
          profileId: scope.profileId,
        };
      }
      const syncState = repository.recordSyncState(scopedInput);
      invalidateShop(scopedInput.shopId || scopedInput.shop_id);
      return { ok: true, domain: DOMAIN, syncState };
    },

    countOwnerHotCache(shopId) {
      const normalizedShopId = normalizeText(shopId);
      return normalizedShopId ? dashboardHotCache.count({ tags: [`shop:${normalizedShopId}`] }) : 0;
    },

    invalidateOwnerHotCache(shopId) {
      return invalidateShop(shopId);
    },

    getHotCacheStatus() {
      return dashboardHotCache.getStatus();
    },
  };
}
