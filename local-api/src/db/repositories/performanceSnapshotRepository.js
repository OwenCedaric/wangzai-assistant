import { createHash, randomUUID } from 'node:crypto';

const PERFORMANCE_CACHE_DOMAIN = 'performance-overview';
const DEPTH_PRIORITY = Object.freeze({
  full: 60,
  products: 50,
  dashboard: 40,
  realtime: 30,
  fast: 20,
  detail: 10,
  catalog: 5,
});

const PRESERVED_METRIC_KEYS = Object.freeze([
  'impressions',
  'clicks',
  'spent',
  'orders',
  'revenue',
  'ctr',
  'cpc',
  'acos',
  'roas',
  'bonusSpent',
  'prepaymentSpent',
]);

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeDateRange(payload = {}) {
  const values = payload?.values && typeof payload.values === 'object' ? payload.values : payload;
  return {
    dateFrom: normalizeText(values?.dateFrom || values?.fromDate || values?.from),
    dateTo: normalizeText(values?.dateTo || values?.toDate || values?.to),
  };
}

function resolveScope(payload = {}) {
  const values = payload?.values && typeof payload.values === 'object' ? payload.values : payload;
  const { dateFrom, dateTo } = normalizeDateRange(values);
  return {
    accountId: normalizeText(values?.accountId || values?.performanceAccountId),
    shopId: normalizeText(values?.shopId || values?.shop_id),
    dateFrom,
    dateTo,
    readDepth: normalizeText(values?.readDepth || values?.readMode || values?.mode || 'full').toLowerCase(),
    campaignId: normalizeText(values?.campaignId || values?.campaign_id),
    includeCampaignObjects: values?.includeCampaignObjects === true,
    includeBidInsights: values?.includeBidInsights === true,
  };
}

function scopePrefix(scope) {
  return [scope.accountId, scope.dateFrom, scope.dateTo].map(encodeURIComponent).join('|');
}

function cacheKey(scope) {
  const depth = scope.readDepth || 'full';
  const detailVariant = depth === 'detail'
    ? `|${encodeURIComponent(scope.campaignId || 'all')}|${scope.includeCampaignObjects ? 'objects' : 'no-objects'}|${scope.includeBidInsights ? 'bids' : 'no-bids'}`
    : '';
  return `${scopePrefix(scope)}|${encodeURIComponent(depth)}${detailVariant}`;
}

function endpointKey(scope) {
  return `performance-overview:${scope.readDepth || 'full'}`;
}

function hashPayload(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseSnapshot(row) {
  if (!row?.payload_json) return null;
  try {
    const payload = JSON.parse(row.payload_json);
    if (!payload?.ok) return null;
    return {
      payload,
      readDepth: normalizeText(payload.readDepth || row.endpoint_key?.split(':').at(-1)).toLowerCase(),
      updatedAt: normalizeText(row.updated_at),
      capturedAt: normalizeText(payload.finishedAt || payload.freshness?.capturedAt || row.updated_at),
    };
  } catch {
    return null;
  }
}

function mergeDetailRead(previous = {}, incoming = {}) {
  return {
    ...previous,
    ...incoming,
    products: previous.products === true || incoming.products === true,
    objects: previous.objects === true || incoming.objects === true,
    bidInsights: previous.bidInsights === true || incoming.bidInsights === true,
    finishedAt: normalizeText(incoming.finishedAt) || normalizeText(previous.finishedAt),
  };
}

function isMissingValue(value) {
  return value === null || value === undefined || (typeof value === 'string' && !value.trim());
}

function getRowIdentity(row = {}, fallback = '') {
  const objectId = normalizeText(row.objectId || row.object_id);
  if (objectId) return `object:${objectId}`;
  const sku = normalizeText(row.sku || row.ozonSku || row.ozon_sku);
  if (sku) return `sku:${sku}`;
  const productId = normalizeText(row.productId || row.product_id);
  if (productId) return `product:${productId}`;
  const offerId = normalizeText(row.offerId || row.offer_id);
  if (offerId) return `offer:${offerId}`;
  const id = normalizeText(row.id);
  return id ? `id:${id}` : normalizeText(fallback);
}

function mergeReturnedRow(previous = null, incoming = {}) {
  if (!previous) return incoming;
  const merged = {
    ...previous,
    ...incoming,
    bidAvailability: {
      ...(previous.bidAvailability || {}),
      ...(incoming.bidAvailability || {}),
    },
  };
  for (const key of PRESERVED_METRIC_KEYS) {
    if (isMissingValue(incoming[key]) && !isMissingValue(previous[key])) merged[key] = previous[key];
  }
  return merged;
}

function mergeAuthoritativeRows(previousRows = [], incomingRows = []) {
  const previousByIdentity = new Map();
  for (const [index, row] of (Array.isArray(previousRows) ? previousRows : []).entries()) {
    const identity = getRowIdentity(row, `previous:${index}`);
    if (identity) previousByIdentity.set(identity, row);
  }
  return (Array.isArray(incomingRows) ? incomingRows : []).map((row, index) => {
    const identity = getRowIdentity(row, `incoming:${index}`);
    return mergeReturnedRow(previousByIdentity.get(identity), row);
  });
}

function mergeCampaignSnapshot(previous = null, incoming = {}) {
  if (!previous) return { ...incoming };
  const incomingRead = incoming.detailRead || {};
  const products = incomingRead.products === true
    ? mergeAuthoritativeRows(previous.products, incoming.products)
    : incoming.products?.length
      ? incoming.products
      : previous.products || [];
  const objects = incomingRead.objects === true
    ? mergeAuthoritativeRows(previous.objects, incoming.objects)
    : incoming.objects?.length
      ? incoming.objects
      : previous.objects || [];
  const previousStatistics = previous.statistics || {};
  const incomingStatistics = incoming.statistics || {};
  const statistics = { ...previousStatistics, ...incomingStatistics };
  for (const key of PRESERVED_METRIC_KEYS) {
    if (isMissingValue(incomingStatistics[key]) && !isMissingValue(previousStatistics[key])) {
      statistics[key] = previousStatistics[key];
    }
  }
  return {
    ...previous,
    ...incoming,
    products,
    objects,
    productCount: incomingRead.products === true ? products.length : products.length || incoming.productCount || 0,
    objectCount: objects.length,
    statistics,
    detailRead: mergeDetailRead(previous.detailRead, incoming.detailRead),
    detailAvailability: {
      ...(previous.detailAvailability || {}),
      ...(incoming.detailAvailability || {}),
    },
  };
}

function mergeInstantOpenSnapshots(candidates = []) {
  if (!candidates.length) return null;
  const latest = candidates[0];
  const broadCandidate = candidates.find((candidate) =>
    ['full', 'ai', 'products', 'dashboard', 'realtime'].includes(candidate.readDepth),
  ) || latest;
  const campaignById = new Map();
  const mergedDataSets = {};
  // A detail read is scoped to one campaign. Keep the last whole-account
  // campaignProducts dataset from a `products` read instead of replacing its
  // count/rows with the selected campaign's single row.
  const detailDataSetKeys = new Set(['campaignObjects', 'campaignBidInsights']);
  for (const candidate of [...candidates].reverse()) {
    for (const campaign of candidate.payload.campaigns || []) {
      const id = normalizeText(campaign?.id);
      if (!id) continue;
      campaignById.set(id, mergeCampaignSnapshot(campaignById.get(id), campaign));
    }
    for (const [key, dataSet] of Object.entries(candidate.payload.dataSets || {})) {
      if (candidate.readDepth === 'detail' && !detailDataSetKeys.has(key)) continue;
      const current = mergedDataSets[key];
      if (dataSet?.status === 'skipped' && current) continue;
      mergedDataSets[key] = dataSet;
    }
  }
  const campaigns = [...campaignById.values()];
  const hasReturnedProductCatalog = normalizeText(mergedDataSets.campaignProducts?.status).toLowerCase() === 'success';
  const returnedProductCount = hasReturnedProductCatalog
    ? new Set(
        campaigns.flatMap((campaign, campaignIndex) =>
          (campaign.products || []).map((product, productIndex) =>
            getRowIdentity(product, `campaign:${campaignIndex}:product:${productIndex}`),
          ),
        ).filter(Boolean),
      ).size
    : null;
  return {
    ...broadCandidate,
    payload: {
      ...broadCandidate.payload,
      summary: {
        ...(broadCandidate.payload.summary || {}),
        ...(returnedProductCount === null ? {} : { productCount: returnedProductCount }),
      },
      campaigns,
      products: campaigns.flatMap((campaign) => campaign.products || []),
      objects: campaigns.flatMap((campaign) => campaign.objects || []),
      dataSets: mergedDataSets,
      dataCatalog: Object.values(mergedDataSets).map(({ rows, ...entry }) => entry),
    },
  };
}

export function createPerformanceSnapshotRepository(db) {
  if (!db) throw new Error('createPerformanceSnapshotRepository requires db.');

  const readStatement = db.prepare(`
    SELECT endpoint_key, updated_at, payload_json
    FROM ozon_response_cache
    WHERE domain = ? AND shop_id = ? AND cache_key LIKE ? ESCAPE '\\'
      AND status IN ('confirmed', 'partial') AND is_stale = 0
    ORDER BY updated_at DESC
  `);
  const writeStatement = db.prepare(`
    INSERT INTO ozon_response_cache (
      id, domain, shop_id, endpoint_key, cache_key, payload_hash, response_hash,
      status, is_stale, expires_at, last_seen_at, updated_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(domain, shop_id, cache_key) DO UPDATE SET
      endpoint_key = excluded.endpoint_key,
      payload_hash = excluded.payload_hash,
      response_hash = excluded.response_hash,
      status = excluded.status,
      is_stale = 0,
      stale_reason = NULL,
      expires_at = excluded.expires_at,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at,
      payload_json = excluded.payload_json
  `);

  function readBestSnapshot(payload = {}) {
    const scope = resolveScope(payload);
    if (!scope.accountId || !scope.shopId || !scope.dateFrom || !scope.dateTo) return null;
    const escapedPrefix = scopePrefix(scope).replace(/[\\%_]/gu, (value) => `\\${value}`);
    const candidates = readStatement
      .all(PERFORMANCE_CACHE_DOMAIN, scope.shopId, `${escapedPrefix}|%`)
      .map(parseSnapshot)
      .filter(Boolean)
      .sort((left, right) => {
        const freshness = Date.parse(right.capturedAt || 0) - Date.parse(left.capturedAt || 0);
        return freshness || (DEPTH_PRIORITY[right.readDepth] || 0) - (DEPTH_PRIORITY[left.readDepth] || 0);
      });
    return mergeInstantOpenSnapshots(candidates);
  }

  function saveSnapshot(requestPayload = {}, overview = {}) {
    const scope = resolveScope(requestPayload);
    if (!overview?.ok || !scope.accountId || !scope.shopId || !scope.dateFrom || !scope.dateTo) return null;
    scope.readDepth = normalizeText(overview.readDepth || scope.readDepth || 'full').toLowerCase();
    const serialized = JSON.stringify(overview);
    const digest = hashPayload(serialized);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const status = Array.isArray(overview.readIssues) && overview.readIssues.length ? 'partial' : 'confirmed';
    writeStatement.run(
      `performance-snapshot-${randomUUID()}`,
      PERFORMANCE_CACHE_DOMAIN,
      scope.shopId,
      endpointKey(scope),
      cacheKey(scope),
      digest,
      digest,
      status,
      expiresAt,
      now,
      now,
      serialized,
    );
    return { ok: true, updatedAt: now, readDepth: scope.readDepth };
  }

  return Object.freeze({ readBestSnapshot, saveSnapshot });
}
