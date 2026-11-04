import {
  clearRetiredMarketingActivityCacheFile,
  readRetiredMarketingActivityCacheFile,
} from "../../services/localDataFileClient";
import {
  importLegacyMarketingActivitySnapshot,
  readMarketingActivitySnapshotCache,
} from "../../services/marketingActivityClient";
import { safeWarn } from "../../services/safeLog";
import { LOCAL_MARKETING_ACTIVITY_CACHE_FILE_KEY } from "../../shared/config/appConfigCore.jsx";
import {
  isMarketingActivityOnline,
  MARKETING_ACTIVITY_CACHE_PRODUCT_FIELDS,
  normalizeMarketingCacheSnapshot,
  rememberMarketingActivityCacheSnapshot,
  resolveMarketingActivitySelection,
} from "./marketingActivityCache.jsx";
import { emptyMarketingSummary, MARKETING_ACTIVITY_CACHE_ACTIVITY_FIELDS } from "./marketingCacheRules.jsx";

export const LEGACY_MARKETING_SNAPSHOT_FIELDS = new Set([
  'activityRows',
  'productPool',
  'marketingSummary',
  'selectedActivityId',
  'selectedSourceType',
  'productScope',
  'selectedProductIds',
  'cachedAt',
]);

export const LEGACY_MARKETING_ACTIVITY_FIELDS = new Set(MARKETING_ACTIVITY_CACHE_ACTIVITY_FIELDS);

export const LEGACY_MARKETING_PRODUCT_FIELDS = new Set(MARKETING_ACTIVITY_CACHE_PRODUCT_FIELDS);

export const LEGACY_MARKETING_SUMMARY_FIELDS = new Set(Object.keys(emptyMarketingSummary));

export function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasOnlyAllowedFields(value, allowedFields) {
  return isPlainRecord(value) && Object.keys(value).every((key) => allowedFields.has(key));
}

export function isLegacyText(value, { allowNumber = false } = {}) {
  return typeof value === 'string' || (allowNumber && typeof value === 'number' && Number.isFinite(value));
}

export function isLegacyNonNegativeInteger(value) {
  if (value === undefined || value === null || value === '') return true;
  const number = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0;
}

export function isLegacyIdentifier(value) {
  return isLegacyText(value, { allowNumber: true }) && String(value).trim() !== '' && String(value).trim() !== '0';
}

export function isStrictLegacyMarketingActivity(value) {
  if (!hasOnlyAllowedFields(value, LEGACY_MARKETING_ACTIVITY_FIELDS) || !isLegacyIdentifier(value.id)) return false;
  const textFields = ['title', 'originalTitle', 'source', 'sourceTone', 'description', 'estimate', 'dateStart', 'dateEnd', 'sourceType'];
  if (textFields.some((field) => value[field] !== undefined && !isLegacyText(value[field]))) return false;
  if (
    value.sourceType !== undefined &&
    value.sourceType !== '' &&
    !normalizeLegacyMarketingSourceType(value.sourceType, { allowDefault: false })
  ) {
    return false;
  }
  if (!isLegacyNonNegativeInteger(value.count) || !isLegacyNonNegativeInteger(value.available)) return false;
  return [value.hasAvailableCount, value.isOnline].every((field) => field === undefined || typeof field === 'boolean');
}

export function isStrictLegacyMarketingProduct(value) {
  if (!hasOnlyAllowedFields(value, LEGACY_MARKETING_PRODUCT_FIELDS) || !isLegacyIdentifier(value.id)) return false;
  const textFields = ['name', 'status', 'statusTone', 'review', 'reviewTone'];
  const numericTextFields = ['offerId', 'ozonSku', 'sku', 'price', 'sourceActivityPrice', 'activityPrice', 'stock'];
  return (
    textFields.every((field) => value[field] === undefined || isLegacyText(value[field])) &&
    numericTextFields.every((field) => value[field] === undefined || isLegacyText(value[field], { allowNumber: true })) &&
    (value.status === undefined || Boolean(normalizeLegacyMarketingProductStatus(value.status, { allowDefault: false })))
  );
}

export function isStrictLegacyMarketingSnapshot(value) {
  if (!hasOnlyAllowedFields(value, LEGACY_MARKETING_SNAPSHOT_FIELDS)) return false;
  if (!Array.isArray(value.activityRows) || !Array.isArray(value.productPool) || value.activityRows.length === 0) return false;
  if (value.activityRows.length > 2000 || value.productPool.length > 10000) return false;
  if (!value.activityRows.every(isStrictLegacyMarketingActivity) || !value.productPool.every(isStrictLegacyMarketingProduct)) {
    return false;
  }
  if (value.marketingSummary !== undefined) {
    if (!hasOnlyAllowedFields(value.marketingSummary, LEGACY_MARKETING_SUMMARY_FIELDS)) return false;
    if (!Object.values(value.marketingSummary).every(isLegacyNonNegativeInteger)) return false;
  }
  if (value.selectedActivityId !== undefined && !isLegacyIdentifier(value.selectedActivityId)) return false;
  if (value.selectedSourceType !== undefined && !isLegacyText(value.selectedSourceType)) return false;
  if (value.productScope !== undefined && !['joined', 'available', 'all'].includes(value.productScope)) return false;
  if (value.selectedProductIds !== undefined) {
    if (!Array.isArray(value.selectedProductIds) || value.selectedProductIds.length > 10000) return false;
    if (!value.selectedProductIds.every(isLegacyIdentifier)) return false;
    const normalizedSelectedProductIds = value.selectedProductIds.map((item) => String(item).trim());
    if (new Set(normalizedSelectedProductIds).size !== normalizedSelectedProductIds.length) return false;
  }
  if (value.cachedAt !== undefined && !isLegacyText(value.cachedAt)) return false;
  return Boolean(getMarketingActivitySnapshotSemanticDto(value));
}

export function readStrictLegacyMarketingStore(value) {
  if (value === undefined || value === null) return { state: 'empty', entries: {} };
  if (!isPlainRecord(value)) return { state: 'invalid', entries: {} };
  const entries = {};
  for (const [shopKey, snapshot] of Object.entries(value)) {
    if (!String(shopKey || '').trim() || !isStrictLegacyMarketingSnapshot(snapshot)) {
      return { state: 'invalid', entries: {} };
    }
    entries[String(shopKey)] = snapshot;
  }
  return { state: Object.keys(entries).length ? 'ready' : 'empty', entries };
}

export async function readLegacyMarketingFileStore() {
  try {
    const legacy = await readRetiredMarketingActivityCacheFile(LOCAL_MARKETING_ACTIVITY_CACHE_FILE_KEY);
    const rawValue = legacy.data;
    return {
      ...readStrictLegacyMarketingStore(rawValue),
      revision: legacy.revision,
      exists: legacy.exists,
      rawDigest: stableMarketingSnapshotRawDigest(rawValue),
    };
  } catch {
    return { state: 'unreadable', entries: {}, revision: '', exists: false, rawDigest: '' };
  }
}

export function stableMarketingValue(value) {
  if (Array.isArray(value)) return value.map(stableMarketingValue);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableMarketingValue(value[key])])
  );
}

export function stableMarketingSnapshotRawDigest(snapshot) {
  return JSON.stringify(stableMarketingValue(snapshot));
}

export const LEGACY_MARKETING_SOURCE_TYPE_ALIASES = new Map([
  ['official', 'official'],
  ['officialaction', 'official'],
  ['officialactions', 'official'],
  ['action', 'official'],
  ['actions', 'official'],
  ['platform', 'official'],
  ['platformaction', 'official'],
  ['platformactions', 'official'],
  ['平台活动', 'official'],
  ['平台', 'official'],
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

export const LEGACY_MARKETING_PRODUCT_STATUS_ALIASES = new Map([
  ['joined', '已添加'],
  ['participating', '已添加'],
  ['active', '已添加'],
  ['已参加', '已添加'],
  ['已添加', '已添加'],
  ['available', '可添加'],
  ['candidate', '可添加'],
  ['候选', '可添加'],
  ['可添加', '可添加'],
]);

export function normalizeLegacyMarketingSourceType(value, { allowDefault = true } = {}) {
  if (value === undefined || value === null || value === '') return allowDefault ? 'official' : '';
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  const compact = normalized.replace(/[\s_-]+/gu, '');
  return LEGACY_MARKETING_SOURCE_TYPE_ALIASES.get(normalized) || LEGACY_MARKETING_SOURCE_TYPE_ALIASES.get(compact) || '';
}

export function normalizeLegacyMarketingProductStatus(value, { allowDefault = true } = {}) {
  if (value === undefined || value === null || value === '') return allowDefault ? '已添加' : '';
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  return LEGACY_MARKETING_PRODUCT_STATUS_ALIASES.get(normalized) || LEGACY_MARKETING_PRODUCT_STATUS_ALIASES.get(value.trim()) || '';
}

export function toMarketingSemanticText(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

export function toMarketingSemanticNonNegativeInteger(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

export function toMarketingSemanticPublicIdentifier(productId, ...values) {
  const safeProductId = toMarketingSemanticText(productId).trim();
  for (const value of values) {
    const text = toMarketingSemanticText(value).trim();
    if (text && text !== '0' && text !== '未返回' && text !== safeProductId) return text;
  }
  return '';
}

export function toMarketingSemanticPublicText(value) {
  const text = toMarketingSemanticText(value).trim();
  return text && text !== '未返回' ? text : '';
}

export function getMarketingSemanticActivity(row = {}) {
  const id = toMarketingSemanticText(row.id ?? row.activityId).trim();
  if (!id || id === '0') return null;
  const sourceType = normalizeLegacyMarketingSourceType(row.sourceType);
  if (!sourceType) return null;
  const title = toMarketingSemanticText(row.title) || toMarketingSemanticText(row.originalTitle) || `活动 ${id}`;
  const originalTitle = toMarketingSemanticText(row.originalTitle) || title;
  // local-api's public DTO obtains typed dates through firstFilled(), which
  // normalizes surrounding whitespace before deriving isOnline.
  const dateStart = toMarketingSemanticText(row.dateStart).trim();
  const dateEnd = toMarketingSemanticText(row.dateEnd).trim();
  const hasAvailableCount = Object.hasOwn(row, 'hasAvailableCount')
    ? Boolean(row.hasAvailableCount)
    : Object.hasOwn(row, 'available');
  return {
    id,
    title,
    originalTitle,
    source: toMarketingSemanticText(row.source) || (sourceType === 'seller' ? '商家自主' : '平台活动'),
    sourceTone: toMarketingSemanticText(row.sourceTone),
    count: toMarketingSemanticNonNegativeInteger(row.count),
    description: toMarketingSemanticText(row.description),
    available: toMarketingSemanticNonNegativeInteger(row.available),
    hasAvailableCount,
    estimate: toMarketingSemanticText(row.estimate),
    dateStart,
    dateEnd,
    // local-api deliberately derives this from typed dates; it is not a
    // mutable legacy fact, therefore the readback proof derives it as well.
    isOnline: isMarketingActivityOnline({ dateStart, dateEnd }),
    sourceType,
  };
}

export function getMarketingSemanticProduct(row = {}) {
  const id = toMarketingSemanticText(row.id ?? row.productId).trim();
  if (!id || id === '0') return null;
  const status = normalizeLegacyMarketingProductStatus(row.status);
  if (!status) return null;
  const defaultTone = status === '已添加' ? 'success' : 'warning';
  const offerId = toMarketingSemanticPublicIdentifier(id, row.offerId);
  const ozonSku = Object.hasOwn(row, 'productId')
    ? toMarketingSemanticPublicIdentifier(id, row.ozonSku)
    : toMarketingSemanticPublicIdentifier(id, row.ozonSku, row.sku);
  const rawSku = toMarketingSemanticPublicIdentifier(id, row.sku);
  return {
    id,
    name: toMarketingSemanticText(row.name) || id,
    offerId,
    ozonSku,
    sku: rawSku || offerId || ozonSku || '',
    price: toMarketingSemanticPublicText(row.price),
    sourceActivityPrice: toMarketingSemanticText(row.sourceActivityPrice),
    activityPrice: toMarketingSemanticText(row.activityPrice),
    stock: toMarketingSemanticPublicText(row.stock),
    status,
    statusTone: toMarketingSemanticText(row.statusTone) || defaultTone,
    review: toMarketingSemanticText(row.review) || (status === '已添加' ? '已确认' : '可处理'),
    reviewTone: toMarketingSemanticText(row.reviewTone) || defaultTone,
  };
}

export function sortMarketingSemanticRows(rows = [], getKey = () => '') {
  return [...rows].sort((left, right) => getKey(left).localeCompare(getKey(right), 'en'));
}

/**
 * Creates the precise, persisted DTO used for the POST -> independent GET
 * proof.  It mirrors the local-api's defaults and derived fields rather than
 * ignoring them, so an old valid sparse snapshot can retire safely while a
 * true fact mismatch still retains its old source.
 */
export function getMarketingActivitySnapshotSemanticDto(snapshot) {
  if (!isPlainRecord(snapshot) || !Array.isArray(snapshot.activityRows) || !Array.isArray(snapshot.productPool)) {
    return null;
  }
  const activityRows = snapshot.activityRows.map(getMarketingSemanticActivity).filter(Boolean);
  const productPool = snapshot.productPool.map(getMarketingSemanticProduct).filter(Boolean);
  if (!activityRows.length || activityRows.length !== snapshot.activityRows.length || productPool.length !== snapshot.productPool.length) {
    return null;
  }

  const activityKeys = new Set();
  for (const activity of activityRows) {
    const key = `${activity.id}::${activity.sourceType}`;
    if (activityKeys.has(key)) return null;
    activityKeys.add(key);
  }
  const productIds = new Set();
  for (const product of productPool) {
    if (productIds.has(product.id)) return null;
    productIds.add(product.id);
  }

  const requestedActivityId = toMarketingSemanticText(snapshot.selectedActivityId).trim();
  const requestedSourceType = snapshot.selectedSourceType === undefined || snapshot.selectedSourceType === null || snapshot.selectedSourceType === ''
    ? ''
    : normalizeLegacyMarketingSourceType(snapshot.selectedSourceType, { allowDefault: false });
  if (snapshot.selectedSourceType !== undefined && snapshot.selectedSourceType !== null && snapshot.selectedSourceType !== '' && !requestedSourceType) {
    return null;
  }
  const selectedActivity = resolveMarketingActivitySelection(activityRows, {
    selectedActivityId: requestedActivityId,
    selectedSourceType: requestedSourceType,
  });
  // A sparse legacy snapshot may omit selection only when exactly one activity
  // exists.  Multiple activities must carry the complete persisted identity;
  // choosing array[0] would cross-wire official/seller id collisions.
  if (!selectedActivity) return null;

  const selectedProductIds = Array.isArray(snapshot.selectedProductIds)
    ? snapshot.selectedProductIds.map((value) => toMarketingSemanticText(value).trim()).filter(Boolean)
    : [];
  if (new Set(selectedProductIds).size !== selectedProductIds.length) return null;
  const summaryInput = isPlainRecord(snapshot.marketingSummary) ? snapshot.marketingSummary : {};
  const fallbackSummary = {
    activityTotal: activityRows.length,
    joinedActivityTotal: activityRows.filter((activity) => activity.count > 0).length,
    joinedProductTotal: productPool.filter((product) => product.status === '已添加').length,
    issueProductTotal: productPool.filter(
      (product) => product.reviewTone === 'error' || /缺|不足|错误|失败|invalid|error/iu.test(product.review)
    ).length,
  };

  return {
    activityRows: sortMarketingSemanticRows(activityRows, (row) => `${row.id}::${row.sourceType}`),
    productPool: sortMarketingSemanticRows(productPool, (row) => row.id),
    marketingSummary: {
      activityTotal: toMarketingSemanticNonNegativeInteger(summaryInput.activityTotal, fallbackSummary.activityTotal),
      joinedActivityTotal: toMarketingSemanticNonNegativeInteger(
        summaryInput.joinedActivityTotal,
        fallbackSummary.joinedActivityTotal
      ),
      joinedProductTotal: toMarketingSemanticNonNegativeInteger(
        summaryInput.joinedProductTotal,
        fallbackSummary.joinedProductTotal
      ),
      issueProductTotal: toMarketingSemanticNonNegativeInteger(
        summaryInput.issueProductTotal,
        fallbackSummary.issueProductTotal
      ),
    },
    selectedActivityId: selectedActivity.id,
    selectedSourceType: selectedActivity.sourceType,
    productScope: ['joined', 'available', 'all'].includes(snapshot.productScope) ? snapshot.productScope : 'joined',
    selectedProductIds,
    cachedAt: toMarketingSemanticText(snapshot.cachedAt),
  };
}

/** A stable deep semantic digest used for the POST -> independent GET migration proof. */
export function getMarketingActivitySnapshotDigest(snapshot) {
  const semantic = getMarketingActivitySnapshotSemanticDto(snapshot);
  return semantic ? JSON.stringify(stableMarketingValue(semantic)) : '';
}

export function getShopLegacyCacheAliases(shop, shops) {
  const aliases = [shop?.id, shop?.shopId, shop?.clientId].map((value) => String(value || '').trim()).filter(Boolean);
  if (shops.length === 1) aliases.push('default-shop');
  return new Set(aliases);
}

export function assignLegacyMarketingStoreEntries(source, shops) {
  const assignments = new Map();
  const unresolvedKeys = new Set();
  const conflictingShopIds = new Set();
  if (source.state !== 'ready') return { assignments, unresolvedKeys, conflictingShopIds };
  for (const [legacyKey, snapshot] of Object.entries(source.entries)) {
    const matchingShops = shops.filter((shop) => getShopLegacyCacheAliases(shop, shops).has(legacyKey));
    if (matchingShops.length !== 1) {
      unresolvedKeys.add(legacyKey);
      continue;
    }
    const shopId = String(matchingShops[0]?.id || '').trim();
    if (!shopId) {
      unresolvedKeys.add(legacyKey);
      continue;
    }
    const current = assignments.get(shopId);
    if (!current) {
      assignments.set(shopId, { shop: matchingShops[0], snapshot, keys: [legacyKey] });
      continue;
    }
    if (stableMarketingSnapshotRawDigest(current.snapshot) !== stableMarketingSnapshotRawDigest(snapshot)) {
      conflictingShopIds.add(shopId);
      continue;
    }
    current.keys.push(legacyKey);
  }
  return { assignments, unresolvedKeys, conflictingShopIds };
}

export async function readCanonicalMarketingSnapshotForMigration(shopId) {
  const current = await readMarketingActivitySnapshotCache({ shopId }, { timeoutMs: 3500 });
  if (!current || current.ok !== true || typeof current.found !== 'boolean') {
    return { ok: false, reason: 'sqlite-canonical-read-failed' };
  }
  if (!current.found) return { ok: true, found: false, snapshot: null, digest: '' };
  const digest = getMarketingActivitySnapshotDigest(current.snapshot);
  if (!digest) return { ok: false, reason: 'sqlite-canonical-snapshot-invalid' };
  return { ok: true, found: true, snapshot: current.snapshot, digest };
}

/**
 * Canonical-first migration for one or more already-mapped shops.  All missing
 * canonical snapshots are posted in one local-api transaction; every candidate
 * then performs a new GET and full semantic digest comparison before either
 * legacy source is allowed to be retired.
 */
export async function verifyOrImportLegacyMarketingSnapshots(candidates = []) {
  const results = new Map();
  const importCandidates = [];

  for (const candidate of candidates) {
    const expectedDigest = getMarketingActivitySnapshotDigest(candidate.snapshot);
    if (!expectedDigest) {
      results.set(candidate.shopId, { ok: false, reason: 'legacy-snapshot-normalization-failed' });
      continue;
    }
    try {
      const canonical = await readCanonicalMarketingSnapshotForMigration(candidate.shopId);
      if (!canonical.ok) {
        results.set(candidate.shopId, canonical);
      } else if (canonical.found) {
        if (canonical.digest !== expectedDigest) {
          results.set(candidate.shopId, { ok: false, reason: 'sqlite-canonical-digest-mismatch' });
        } else {
          const normalized = normalizeMarketingCacheSnapshot(canonical.snapshot);
          if (normalized) rememberMarketingActivityCacheSnapshot(candidate.shop, normalized);
          results.set(candidate.shopId, { ok: true, snapshot: normalized, reusedCanonical: true });
        }
      } else {
        importCandidates.push({ ...candidate, expectedDigest });
      }
    } catch (error) {
      results.set(candidate.shopId, { ok: false, reason: 'sqlite-canonical-read-failed', error });
    }
  }

  if (importCandidates.length) {
    try {
      const imported = await importLegacyMarketingActivitySnapshot(
        {
          entries: importCandidates.map((candidate) => ({
            legacyScope: LOCAL_MARKETING_ACTIVITY_CACHE_FILE_KEY,
            shopId: candidate.shopId,
            snapshot: candidate.snapshot,
          })),
        },
        { timeoutMs: 12_000 }
      );
      if (!imported?.ok) {
        importCandidates.forEach((candidate) => {
          results.set(candidate.shopId, { ok: false, reason: 'sqlite-import-failed' });
        });
      } else {
        for (const candidate of importCandidates) {
          try {
            // Do not trust the POST response. This second, independent GET is
            // the proof that permits cleanup of browser/JSON input.
            const canonical = await readCanonicalMarketingSnapshotForMigration(candidate.shopId);
            if (!canonical.ok || !canonical.found || canonical.digest !== candidate.expectedDigest) {
              results.set(candidate.shopId, { ok: false, reason: 'sqlite-readback-digest-mismatch' });
              continue;
            }
            const normalized = normalizeMarketingCacheSnapshot(canonical.snapshot);
            if (normalized) rememberMarketingActivityCacheSnapshot(candidate.shop, normalized);
            results.set(candidate.shopId, { ok: true, snapshot: normalized, reusedCanonical: false });
          } catch (error) {
            results.set(candidate.shopId, { ok: false, reason: 'sqlite-readback-failed', error });
          }
        }
      }
    } catch (error) {
      importCandidates.forEach((candidate) => {
        results.set(candidate.shopId, { ok: false, reason: 'sqlite-import-failed', error });
      });
    }
  }
  return results;
}

/**
 * The retired aggregate is all-or-nothing.  We never rewrite it to remove a
 * subset: if one shop is ambiguous, mismatched or unverified, preserving the
 * full old source is the only no-loss result.  This also lets the desktop
 * protocol expose a small, auditable compare-and-delete operation rather than
 * a generic legacy-file write endpoint.
 */
export function canRetireLegacyMarketingSource(source, assignments, migratedShopIdSet) {
  if (source.state === 'empty') return false;
  if (source.state !== 'ready' || !Object.keys(source.entries).length) return false;
  if (assignments.unresolvedKeys.size || assignments.conflictingShopIds.size) return false;
  let assignedEntryCount = 0;
  let allAssignmentsVerified = true;
  assignments.assignments.forEach((assignment, shopId) => {
    assignedEntryCount += assignment.keys.length;
    if (!migratedShopIdSet.has(shopId)) allAssignmentsVerified = false;
  });
  return allAssignmentsVerified && assignedEntryCount === Object.keys(source.entries).length;
}

export async function clearVerifiedLegacyMarketingFileSource(source) {
  if (source.state !== 'ready' || !source.exists || !/^[a-f0-9]{64}$/u.test(source.revision || '')) {
    return { cleared: false, conflict: false };
  }
  try {
    await clearRetiredMarketingActivityCacheFile(LOCAL_MARKETING_ACTIVITY_CACHE_FILE_KEY, source.revision);
    return { cleared: true, conflict: false };
  } catch (error) {
    if (error?.code === 'LEGACY_SOURCE_CHANGED') return { cleared: false, conflict: true };
    throw error;
  }
}

/**
 * One-time bridge only. It reads the retired local JSON after shop hydration,
 * imports into SQLite, performs an independent SQLite GET digest check, then
 * retires each proven legacy entry while preserving unmapped or unverified
 * entries in the same aggregate source.
 */
export async function migrateLegacyMarketingActivityCacheStore({ shops = [] } = {}) {
  const hydratedShops = (Array.isArray(shops) ? shops : []).filter((shop) => String(shop?.id || '').trim());
  if (!hydratedShops.length) return { ok: false, reason: 'shops-not-hydrated', migratedShopIds: [] };

  const fileSource = await readLegacyMarketingFileStore();
  if (fileSource.state === 'invalid' || fileSource.state === 'unreadable') {
    return { ok: false, reason: 'legacy-source-unreadable-or-invalid', migratedShopIds: [] };
  }

  const fileAssignments = assignLegacyMarketingStoreEntries(fileSource, hydratedShops);
  const migratedShopIds = [];
  const retainedShopIds = new Set([...fileAssignments.conflictingShopIds]);
  const candidates = [];

  for (const shop of hydratedShops) {
    const shopId = String(shop.id);
    const fileEntry = fileAssignments.assignments.get(shopId);
    if (!fileEntry) continue;
    if (fileAssignments.conflictingShopIds.has(shopId)) {
      retainedShopIds.add(shopId);
      continue;
    }
    candidates.push({ shopId, shop, snapshot: fileEntry.snapshot });
  }

  const verificationResults = await verifyOrImportLegacyMarketingSnapshots(candidates);
  for (const candidate of candidates) {
    const verification = verificationResults.get(candidate.shopId);
    if (verification?.ok) {
      migratedShopIds.push(candidate.shopId);
    } else {
      retainedShopIds.add(candidate.shopId);
      if (verification?.error) safeWarn('营销活动旧缓存迁 SQLite 失败，已保留旧副本', verification.error);
    }
  }

  const migratedShopIdSet = new Set(migratedShopIds);
  let browserCleared = false;
  let fileCleared = false;
  let browserRemovedKeys = [];
  let fileRemovedKeys = [];
  const cleanupFailed = [];
  const cleanupConflicts = [];
  const canRetireFile = canRetireLegacyMarketingSource(fileSource, fileAssignments, migratedShopIdSet);
  if (canRetireFile) {
    try {
      const cleanup = await clearVerifiedLegacyMarketingFileSource(fileSource);
      fileCleared = cleanup.cleared;
      fileRemovedKeys = fileCleared ? Object.keys(fileSource.entries) : [];
      if (cleanup.conflict) {
        cleanupConflicts.push('file');
        safeWarn('营销活动旧 JSON 缓存清理冲突，已保留旧副本', { source: 'file' });
      }
      else if (!fileCleared) cleanupFailed.push('file');
    } catch (error) {
      cleanupFailed.push('file');
      safeWarn('营销活动旧 JSON 清理失败，已保留旧副本', error);
    }
  }
  return {
    ok:
      retainedShopIds.size === 0 &&
      fileAssignments.unresolvedKeys.size === 0 &&
      cleanupFailed.length === 0 &&
      cleanupConflicts.length === 0,
    migratedShopIds,
    retainedShopIds: [...retainedShopIds],
    browserCleared,
    fileCleared,
    browserRemovedKeys,
    fileRemovedKeys,
    browserUnresolvedKeys: [],
    fileUnresolvedKeys: [...fileAssignments.unresolvedKeys],
    cleanupFailed,
    cleanupConflicts,
  };
}
