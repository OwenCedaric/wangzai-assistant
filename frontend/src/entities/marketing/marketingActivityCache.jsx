import { readMarketingActivitySnapshotCache, saveMarketingActivityViewState } from "../../services/marketingActivityClient";
import { settleOwnerWriteDrain } from "../../services/ownerWriteDrain.js";
import { safeWarn } from "../../services/safeLog";
import {
  getOzonGenerationAwareShopSourceKey,
  isOzonShopGenerationFenced,
  normalizeOzonShopGenerationScope,
  serializeOzonShopGenerationScope,
} from "../../shared/ozon/ozonShopGeneration.js";
import { emptyMarketingSummary, MARKETING_ACTIVITY_CACHE_ACTIVITY_FIELDS } from "./marketingCacheRules.jsx";
import { firstMarketingValue } from "./marketingValueRules.jsx";

export const MARKETING_ACTIVITY_CACHE_PRODUCT_FIELDS = [
  'id',
  'name',
  'offerId',
  'ozonSku',
  'sku',
  'price',
  'sourceActivityPrice',
  'activityPrice',
  'stock',
  'status',
  'statusTone',
  'review',
  'reviewTone',
];

export function parseMarketingActivityDateMs(value) {
  if (!value) return null;
  const time = Date.parse(String(value));
  return Number.isNaN(time) ? null : time;
}

export function getMarketingActivityDateRange(activity = {}) {
  return {
    dateStart: firstMarketingValue(
      activity.dateStart,
      activity.date_start,
      activity.startAt,
      activity.start_at,
      activity.raw?.date_start,
      activity.raw?.dateStart,
      activity.raw?.start_at,
      activity.raw?.startAt
    ),
    dateEnd: firstMarketingValue(
      activity.dateEnd,
      activity.date_end,
      activity.endAt,
      activity.end_at,
      activity.raw?.date_end,
      activity.raw?.dateEnd,
      activity.raw?.end_at,
      activity.raw?.endAt
    ),
  };
}

export function isMarketingActivityOnline(activity = {}, nowMs = Date.now()) {
  const { dateStart, dateEnd } = getMarketingActivityDateRange(activity);
  const startMs = parseMarketingActivityDateMs(dateStart);
  const endMs = parseMarketingActivityDateMs(dateEnd);
  if (endMs !== null && endMs < nowMs) return false;
  if (startMs !== null && startMs > nowMs) return false;
  return true;
}

export function filterOnlineMarketingActivities(activities = [], nowMs = Date.now()) {
  return activities.filter((activity) => isMarketingActivityOnline(activity, nowMs));
}

export function buildFastMarketingSummary(activities = []) {
  const onlineActivities = filterOnlineMarketingActivities(activities);
  return {
    activityTotal: onlineActivities.length,
    joinedActivityTotal: onlineActivities.filter((activity) => Number(activity.count) > 0).length,
    joinedProductTotal: null,
    issueProductTotal: null,
  };
}

export function getMarketingActivityCacheKey(shop = {}) {
  return getOzonGenerationAwareShopSourceKey(shop);
}

/** Memory only. Persistent marketing state belongs to local-api SQLite. */
export let marketingActivityRuntimeCacheStore = {};

export function rememberMarketingActivityCacheSnapshot(shop, normalized) {
  if (!shop || !normalized) return;
  if (isMarketingActivityOwnerFenced(shop)) return false;
  marketingActivityRuntimeCacheStore = {
    ...marketingActivityRuntimeCacheStore,
    [getMarketingActivityCacheKey(shop)]: normalized,
  };
  return true;
}

export function pickMarketingCacheFields(source = {}, fields = []) {
  return fields.reduce((row, field) => {
    const value = source?.[field];
    if (value === undefined || value === null) return row;
    if (typeof value === 'object') return row;
    row[field] = value;
    return row;
  }, {});
}

export function normalizeMarketingCacheText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

export function normalizeMarketingCacheSourceType(value, fallback = '') {
  const text = normalizeMarketingCacheText(value).toLowerCase();
  if (!text) return fallback;
  const compact = text.replace(/[\s_-]+/gu, '');
  return compact === 'seller' || compact === 'selleractions' || compact === 'selleraction' || /商家|自主/u.test(text)
    ? 'seller'
    : 'official';
}

/**
 * Ozon can return an official activity and a seller-created activity with the
 * same numeric id.  The source type is therefore part of the activity
 * identity everywhere outside of presentation-only labels.
 */
export function normalizeMarketingActivitySourceType(value, fallback = 'official') {
  return normalizeMarketingCacheSourceType(value, fallback);
}

export function getMarketingActivityIdentity(activityOrId = {}, sourceType) {
  const isActivity = activityOrId && typeof activityOrId === 'object';
  return {
    id: normalizeMarketingCacheText(isActivity ? activityOrId.id : activityOrId),
    sourceType: normalizeMarketingCacheSourceType(isActivity ? activityOrId.sourceType : sourceType, 'official'),
  };
}

export function getMarketingActivityIdentityKey(activityOrId = {}, sourceType) {
  const identity = getMarketingActivityIdentity(activityOrId, sourceType);
  return `${identity.id || 'activity'}::${identity.sourceType}`;
}

export function isSameMarketingActivity(left, right) {
  const leftIdentity = getMarketingActivityIdentity(left);
  const rightIdentity = getMarketingActivityIdentity(right);
  return Boolean(leftIdentity.id && rightIdentity.id) &&
    leftIdentity.id === rightIdentity.id &&
    leftIdentity.sourceType === rightIdentity.sourceType;
}

/**
 * An id-only restore is permitted only when it resolves to exactly one row.
 * Never guess between the two Ozon activity sources.
 */
export function findMarketingActivityByIdentity(rows = [], activityOrId = {}, sourceType) {
  const requestedId = normalizeMarketingCacheText(
    activityOrId && typeof activityOrId === 'object' ? activityOrId.id : activityOrId
  );
  if (!requestedId) return null;
  const requestedSource = activityOrId && typeof activityOrId === 'object' ? activityOrId.sourceType : sourceType;
  const hasRequestedSource = requestedSource !== undefined && requestedSource !== null && requestedSource !== '';
  const candidates = rows.filter((row) => normalizeMarketingCacheText(row?.id) === requestedId);
  if (!hasRequestedSource) return candidates.length === 1 ? candidates[0] : null;
  const normalizedSource = normalizeMarketingCacheSourceType(requestedSource, 'official');
  return candidates.find((row) => normalizeMarketingCacheSourceType(row?.sourceType, 'official') === normalizedSource) ?? null;
}

/**
 * Restores a persisted activity identity without guessing between an official
 * and a seller activity that share the same id.  With no persisted identity we
 * only auto-resolve a single available row; a multi-row first read must wait
 * for the SQLite view-state pair or an explicit user selection.
 */
export function resolveMarketingActivitySelection(rows = [], selection = {}) {
  const selectedActivityId = normalizeMarketingCacheText(selection?.selectedActivityId ?? selection?.id);
  const selectedSourceType = selection?.selectedSourceType ?? selection?.sourceType;
  if (selectedActivityId) {
    return findMarketingActivityByIdentity(rows, {
      id: selectedActivityId,
      sourceType: selectedSourceType,
    });
  }
  return rows.length === 1 ? rows[0] : null;
}

export function normalizeMarketingCacheNonNegativeInteger(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

export function normalizeMarketingCacheProductStatus(value) {
  const text = normalizeMarketingCacheText(value);
  if (['joined', 'participating', 'active', '已参加'].includes(text)) return '已添加';
  if (['available', 'candidate', '候选'].includes(text)) return '可添加';
  return text || '已添加';
}

export function normalizeMarketingCacheActivity(activity = {}) {
  const row = pickMarketingCacheFields(activity, MARKETING_ACTIVITY_CACHE_ACTIVITY_FIELDS);
  const id = normalizeMarketingCacheText(row.id);
  if (!id) return null;
  const sourceType = normalizeMarketingCacheSourceType(row.sourceType, 'official');
  const title = normalizeMarketingCacheText(row.title) || normalizeMarketingCacheText(row.originalTitle) || `活动 ${id}`;
  const normalized = {
    ...row,
    id,
    title,
    originalTitle: normalizeMarketingCacheText(row.originalTitle) || title,
    source: normalizeMarketingCacheText(row.source) || (sourceType === 'seller' ? '商家自主' : '平台活动'),
    sourceTone: normalizeMarketingCacheText(row.sourceTone),
    count: normalizeMarketingCacheNonNegativeInteger(row.count),
    description: normalizeMarketingCacheText(row.description),
    available: normalizeMarketingCacheNonNegativeInteger(row.available),
    hasAvailableCount:
      row.hasAvailableCount === undefined
        ? Object.hasOwn(activity, 'available')
        : Boolean(row.hasAvailableCount),
    estimate: normalizeMarketingCacheText(row.estimate),
    dateStart: normalizeMarketingCacheText(row.dateStart),
    dateEnd: normalizeMarketingCacheText(row.dateEnd),
    sourceType,
  };
  // local-api derives this from the stored dates; a legacy boolean is never a
  // second canonical fact and must not make the post-import digest diverge.
  normalized.isOnline = isMarketingActivityOnline(normalized);
  return normalized;
}

export function normalizeMarketingCacheProduct(product = {}) {
  const row = pickMarketingCacheFields(product, MARKETING_ACTIVITY_CACHE_PRODUCT_FIELDS);
  const id = normalizeMarketingCacheText(row.id);
  if (!id) return null;
  const status = normalizeMarketingCacheProductStatus(row.status);
  const review = normalizeMarketingCacheText(row.review) || (status === '已添加' ? '已确认' : '可处理');
  return {
    ...row,
    id,
    name: normalizeMarketingCacheText(row.name),
    offerId: normalizeMarketingCacheText(row.offerId),
    ozonSku: normalizeMarketingCacheText(row.ozonSku),
    sku: normalizeMarketingCacheText(row.sku),
    price: normalizeMarketingCacheText(row.price),
    sourceActivityPrice: normalizeMarketingCacheText(row.sourceActivityPrice),
    activityPrice: normalizeMarketingCacheText(row.activityPrice),
    stock: normalizeMarketingCacheText(row.stock),
    status,
    statusTone: normalizeMarketingCacheText(row.statusTone) || (status === '已添加' ? 'success' : 'warning'),
    review,
    reviewTone:
      normalizeMarketingCacheText(row.reviewTone) ||
      (/缺|不足|错误|失败|invalid|error/iu.test(review) ? 'error' : status === '已添加' ? 'success' : 'warning'),
  };
}

export function normalizeMarketingCacheSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const selectedProductIds = Array.isArray(snapshot.selectedProductIds)
    ? snapshot.selectedProductIds.map(normalizeMarketingCacheText).filter(Boolean)
    : [];
  // A duplicated persisted product id is ambiguous selection state, not a
  // harmless formatting issue. Reject it before any cache/view-state write so
  // a legacy or corrupted snapshot cannot silently become a different DTO.
  if (new Set(selectedProductIds).size !== selectedProductIds.length) return null;
  const allActivityRows = Array.isArray(snapshot.activityRows)
    ? snapshot.activityRows.map(normalizeMarketingCacheActivity).filter(Boolean)
    : [];
  const activityRows = filterOnlineMarketingActivities(allActivityRows);
  const allProducts = Array.isArray(snapshot.productPool)
    ? snapshot.productPool.map(normalizeMarketingCacheProduct).filter(Boolean)
    : [];
  const requestedActivityId = normalizeMarketingCacheText(snapshot.selectedActivityId);
  const requestedSourceType = snapshot.selectedSourceType
    ? normalizeMarketingCacheSourceType(snapshot.selectedSourceType, 'official')
    : '';
  const selectedCandidates = activityRows.filter((activity) => String(activity.id) === requestedActivityId);
  const selectedActivity = resolveMarketingActivitySelection(activityRows, {
    selectedActivityId: requestedActivityId,
    selectedSourceType: requestedSourceType,
  });
  const selectedActivityId = selectedActivity?.id || '';
  const selectedSourceType = selectedActivity?.sourceType || '';
  const canRestoreProductPool =
    Boolean(selectedActivityId) &&
    (!requestedActivityId ||
      (selectedActivityId === requestedActivityId &&
        (requestedSourceType
          ? selectedActivity?.sourceType === requestedSourceType
          : selectedCandidates.length === 1)));
  const productPool = selectedActivityId && canRestoreProductPool ? allProducts : [];
  if (activityRows.length === 0 && productPool.length === 0) return null;
  const productScope = ['joined', 'available', 'all'].includes(snapshot.productScope)
    ? snapshot.productScope
    : 'joined';
  const summarySource = snapshot.marketingSummary && typeof snapshot.marketingSummary === 'object'
    ? snapshot.marketingSummary
    : {};
  const defaultSummary = {
    activityTotal: allActivityRows.length,
    joinedActivityTotal: allActivityRows.filter((activity) => activity.count > 0).length,
    joinedProductTotal: allProducts.filter((product) => product.status === '已添加').length,
    issueProductTotal: allProducts.filter(
      (product) => product.reviewTone === 'error' || /缺|不足|错误|失败|invalid|error/iu.test(product.review)
    ).length,
  };
  return {
    activityRows,
    productPool,
    marketingSummary: {
      activityTotal: normalizeMarketingCacheNonNegativeInteger(summarySource.activityTotal, defaultSummary.activityTotal),
      joinedActivityTotal: normalizeMarketingCacheNonNegativeInteger(
        summarySource.joinedActivityTotal,
        defaultSummary.joinedActivityTotal
      ),
      joinedProductTotal: normalizeMarketingCacheNonNegativeInteger(
        summarySource.joinedProductTotal,
        defaultSummary.joinedProductTotal
      ),
      issueProductTotal: normalizeMarketingCacheNonNegativeInteger(
        summarySource.issueProductTotal,
        defaultSummary.issueProductTotal
      ),
    },
    selectedActivityId,
    selectedSourceType,
    productScope,
    selectedProductIds,
    cachedAt: normalizeMarketingCacheText(snapshot.cachedAt),
  };
}

export function getMarketingActivityCache(shop) {
  return normalizeMarketingCacheSnapshot(marketingActivityRuntimeCacheStore[getMarketingActivityCacheKey(shop)]);
}

/** Normal page reads never fall back to browser or local JSON. */
export async function getMarketingActivityLocalCache(shop, options = {}) {
  const shopId = String(shop?.id || '').trim();
  if (!shopId) return null;
  if (isMarketingActivityOwnerFenced(shop)) return null;
  const result = await readMarketingActivitySnapshotCache(
    { shopId, includeProductPool: false },
    { timeoutMs: options.timeoutMs || 2500, signal: options.signal }
  );
  if (isMarketingActivityOwnerFenced(shop)) return null;
  if (result?.found !== true) return null;
  const normalized = normalizeMarketingCacheSnapshot(result?.snapshot || result);
  if (normalized) rememberMarketingActivityCacheSnapshot(shop, normalized);
  return normalized;
}

export let marketingActivityViewStateWriteQueue = Promise.resolve();

export let marketingActivityLastWrite = null;

export const marketingActivityViewStateFencedOwnerScopes = new Map();

export function getMarketingActivityOwnerFences() {
  return [...marketingActivityViewStateFencedOwnerScopes.values()];
}

export function isMarketingActivityOwnerFenced(shopOrScope = {}) {
  return isOzonShopGenerationFenced(shopOrScope, getMarketingActivityOwnerFences());
}

export function assertMarketingActivityOwnerWritable(shopOrScope) {
  if (!isMarketingActivityOwnerFenced(shopOrScope)) return;
  const error = new Error('ACCOUNT_REMOVAL_OWNER_QUIESCED');
  error.code = 'ACCOUNT_REMOVAL_OWNER_QUIESCED';
  throw error;
}

export async function fenceAndDrainMarketingActivityViewStateWrites(shopOrScope) {
  const scope = normalizeOzonShopGenerationScope(shopOrScope);
  if (!scope.ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  marketingActivityViewStateFencedOwnerScopes.set(serializeOzonShopGenerationScope(scope), scope);
  const drain = await settleOwnerWriteDrain([marketingActivityViewStateWriteQueue, marketingActivityLastWrite]);
  return { ownerId: scope.ownerId, shopIncarnation: scope.shopIncarnation, credentialRevision: scope.credentialRevision, fenced: true, ...drain };
}

export function getMarketingActivityViewStateFenceStatus(shopOrScope) {
  const scope = normalizeOzonShopGenerationScope(shopOrScope);
  return { ownerId: scope.ownerId, fenced: isMarketingActivityOwnerFenced(scope) };
}

export function releaseMarketingActivityOwnerFence(shopOrScope) {
  return marketingActivityViewStateFencedOwnerScopes.delete(serializeOzonShopGenerationScope(normalizeOzonShopGenerationScope(shopOrScope)));
}

export function toMarketingActivityViewState(snapshot = {}) {
  const selectedActivityId = normalizeMarketingCacheText(snapshot.selectedActivityId);
  const selectedSourceType = normalizeMarketingCacheText(snapshot.selectedSourceType);
  const hasCompleteSelection = Boolean(selectedActivityId && selectedSourceType);
  return {
    selectedActivityId: hasCompleteSelection ? selectedActivityId : '',
    selectedSourceType: hasCompleteSelection ? normalizeMarketingCacheSourceType(selectedSourceType, 'official') : '',
    productScope: snapshot.productScope || 'joined',
    selectedProductIds: Array.isArray(snapshot.selectedProductIds) ? snapshot.selectedProductIds : [],
    marketingSummary: {
      ...emptyMarketingSummary,
      ...(snapshot.marketingSummary || {}),
    },
    cachedAt: snapshot.cachedAt || '',
  };
}

export function queueMarketingActivityViewStateWrite(shop, snapshot) {
  const shopId = String(shop?.id || '').trim();
  if (!shopId) return Promise.resolve(null);
  assertMarketingActivityOwnerWritable(shop);
  const viewState = toMarketingActivityViewState(snapshot);
  const pendingWrite = marketingActivityViewStateWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const result = await saveMarketingActivityViewState({ shopId, viewState });
      if (result?.ok === false) {
        const error = new Error(result?.error?.message || '营销活动 SQLite 视图状态保存失败。');
        error.payload = result;
        throw error;
      }
      return result;
    });
  marketingActivityViewStateWriteQueue = pendingWrite.catch(() => undefined);
  marketingActivityLastWrite = pendingWrite;
  return pendingWrite;
}

export async function flushMarketingActivityViewStateWritesForTest() {
  return marketingActivityViewStateWriteQueue;
}

export function saveMarketingActivityCache(shop, snapshot) {
  if (!shop) return Promise.resolve(null);
  const shopId = String(shop?.id || '').trim();
  if (shopId) assertMarketingActivityOwnerWritable(shop);
  const normalized = normalizeMarketingCacheSnapshot({
    ...snapshot,
    cachedAt: snapshot?.cachedAt || new Date().toISOString(),
  });
  if (!normalized) return Promise.resolve(null);
  rememberMarketingActivityCacheSnapshot(shop, normalized);
  return queueMarketingActivityViewStateWrite(shop, normalized).catch((error) => {
    safeWarn('营销活动 SQLite 视图状态保存失败', error);
    return null;
  });
}

export function mergeMarketingActivityCache(shop, partialSnapshot) {
  const current = getMarketingActivityCache(shop) || {};
  return saveMarketingActivityCache(shop, {
    ...current,
    ...partialSnapshot,
  });
}
