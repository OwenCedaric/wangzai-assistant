import { settleOwnerWriteDrain } from './ownerWriteDrain.js';
import { readLocalDataFile, writeLocalDataFile } from '../entities/product/productLocalData.jsx';
import { mergeLocalRecordMaps } from '../entities/product/productLocalMirror.jsx';
import { retryTransientLocalApiWrite } from './localApiTransientWriteRetry.js';
import {
  importLegacyPurchaseOverrides,
  removePurchaseOverride as removePurchaseOverrideFromLocalApi,
  savePurchaseOverride as savePurchaseOverrideToLocalApi,
  toPurchaseOverridePayload,
} from './purchaseOrderOverrideClient';
import { LOCAL_PURCHASE_ORDER_OVERRIDES_FILE_KEY } from '../shared/config/appConfigCore.jsx';
import { hashRequestText, stableRequestPayload } from '../shared/ozon/ozonRuntime.jsx';
import {
  PURCHASE_ORDER_OVERRIDE_MIGRATION_CONCURRENCY,
  getPurchaseOverrideUpdatedAtTimestamp,
  getScopedPurchaseOverrideKey,
  hasMappablePurchaseOrderOverride,
  mapWithBoundedConcurrency,
  normalizePurchaseOverrideOwnerId,
  purchaseOrderOverrideReadbackMatches,
  purchaseOverrideBelongsToShop,
  readPurchaseOrderOverrideReadbackFromLocalApi,
} from "./purchaseOrderOverrideRules.js";
export {
  createPurchaseOrderLocalOverrideUpsert,
  findPurchaseOrderLocalOverride,
  getCanonicalPurchaseOrderOverrideKey,
  mapPurchaseOverrideRows,
  normalizePurchaseOrderLocalOverrides,
  removePurchaseSourceRecordsFromLocalOverride,
  sanitizePurchaseOrderLocalOverrideForMerge,
  selectPurchaseOrderLocalOverridesForOrder,
} from "./purchaseOrderOverrideRules.js";
import {
  createPurchaseOrderLocalOverrideUpsert,
  normalizePurchaseOrderLocalOverrides,
} from "./purchaseOrderOverrideRules.js";
export {
  PURCHASE_EMPTY_ORDER_NO_VALUES,
  PURCHASE_EMPTY_PLATFORM_VALUES,
  PURCHASE_EMPTY_PRICE_VALUES,
  annotatePurchaseOrder,
  applyPurchaseManualFallbacks,
  countPurchaseOrderModule,
  deriveLegacyPurchaseOrderStatusByOzon,
  derivePurchaseOrderStatus,
  formatPurchaseOrderPaymentTime,
  getManualPurchasePriceDisplay,
  getPurchaseOrderActionState,
  getPurchaseOrderKeys,
  getPurchaseOrderOzonBaseStatus,
  getPurchaseOrderPaymentDateKey,
  getPurchaseOrderPaymentTimeMs,
  getPurchaseOrderPaymentTimeRaw,
  getPurchaseOrderStatusReason,
  hasConfirmedCrossBorderOrder,
  hasConfirmedPurchasePlacement,
  hasPurchaseOrderConflict,
  hasValidPurchaseOrderNumber,
  isConfirmedPurchasePlatformStatus,
  isFilledPurchaseOrderNoValue,
  isFilledPurchasePlatformValue,
  isFilledPurchasePriceValue,
  isFilledPurchaseTextValue,
  isPurchaseOrderBeforeShopBinding,
  isPurchaseOrderModuleMatch,
  isPurchaseOrderPreparedWithoutCrossBorder,
  isPurchaseOrderRefundPending,
  isPurchaseOrderStageMatch,
  normalizeOzonSalesRowToPurchaseOrder,
  parsePurchaseOrderDateMs,
  purchaseOrderStatusTones,
} from "./purchaseOrderStatus.js";

export let purchaseOrderLocalOverridesMemory = null;

export const purchaseOrderOverrideLocalApiHashes = new Map();

export let purchaseOrderOverrideLocalApiWriteQueue = Promise.resolve();
let activePurchaseOrderOverrideMigration = null;
const purchaseOrderOverrideReads = new Set();
const purchaseOrderOverrideFencedShopIds = new Set();

export async function fenceAndDrainPurchaseOrderOverrideWrites(shopId) {
  const ownerId = normalizePurchaseOverrideOwnerId(shopId);
  if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  purchaseOrderOverrideFencedShopIds.add(ownerId);
  const pendingReads = [...purchaseOrderOverrideReads];
  pendingReads.forEach(task => task.excludedOwnerIds.add(ownerId));
  const drain = await settleOwnerWriteDrain([
    purchaseOrderOverrideLocalApiWriteQueue,
    ...pendingReads.map(task => task.promise),
  ]);
  return { ownerId, fenced: true, ...drain };
}

export function releasePurchaseOrderOverrideOwnerFence(shopId) {
  return purchaseOrderOverrideFencedShopIds.delete(normalizePurchaseOverrideOwnerId(shopId));
}

export function countPurchaseOrderOverrideMemoryForShop(shopId) {
  const ownerId = normalizePurchaseOverrideOwnerId(shopId);
  if (!ownerId || !purchaseOrderLocalOverridesMemory) return 0;
  return Object.values(purchaseOrderLocalOverridesMemory).filter((override) => (
    purchaseOverrideBelongsToShop(override, ownerId)
  )).length;
}

export function removePurchaseOrderOverrideMemoryForShop(shopId) {
  const ownerId = normalizePurchaseOverrideOwnerId(shopId);
  if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  const current = purchaseOrderLocalOverridesMemory && typeof purchaseOrderLocalOverridesMemory === 'object'
    ? purchaseOrderLocalOverridesMemory
    : {};
  const removedKeys = [];
  purchaseOrderLocalOverridesMemory = Object.fromEntries(Object.entries(current).filter(([key, override]) => {
    const matches = purchaseOverrideBelongsToShop(override, ownerId);
    if (matches) removedKeys.push(key);
    return !matches;
  }));
  removedKeys.forEach((key) => purchaseOrderOverrideLocalApiHashes.delete(key));
  return { ownerId, removedCount: removedKeys.length };
}

export function readPurchaseOrderLocalOverrides() {
  if (purchaseOrderLocalOverridesMemory && typeof purchaseOrderLocalOverridesMemory === 'object') {
    return purchaseOrderLocalOverridesMemory;
  }
  return {};
}

export function writePurchaseOrderLocalOverrideUpsert(
  overrides = {},
  order = {},
  shop = null,
  update = {},
  options = {},
) {
  const plan = createPurchaseOrderLocalOverrideUpsert(overrides, order, shop, update);
  if (!plan) return null;
  purchaseOrderLocalOverridesMemory = plan.overrides;
  const persistence = persistPurchaseOrderLocalOverrideUpsert(plan, options);
  void Promise.resolve(persistence).then((result) => {
    if (result?.failedKeys?.length) return;
    if (typeof globalThis.dispatchEvent !== 'function' || typeof globalThis.CustomEvent !== 'function') return;
    globalThis.dispatchEvent(new CustomEvent('wangzai:purchase-order-overrides-updated', {
      detail: { shopId: plan.shopId, orderKey: plan.canonicalKey },
    }));
  }).catch(() => undefined);
  return { ...plan, persistence };
}

export async function readPurchaseOrderOverridesFromLocalApi() {
  return trackPurchaseOverrideRead(async task => {
    const readback = await readPurchaseOrderOverrideReadbackFromLocalApi();
    return eligiblePurchaseOverrideRead(readback.byOrderKey, task);
  });
}

function trackPurchaseOverrideRead(reader) {
  const task = { excludedOwnerIds: new Set(purchaseOrderOverrideFencedShopIds), promise: null };
  purchaseOrderOverrideReads.add(task);
  task.promise = Promise.resolve().then(() => reader(task)).finally(() => purchaseOrderOverrideReads.delete(task));
  return task.promise;
}

function eligiblePurchaseOverrideRead(overrides, task) {
  return Object.fromEntries(Object.entries(overrides || {}).filter(([, value]) => {
    const ownerId = normalizePurchaseOverrideOwnerId(value?.shopId ?? value?.shop_id);
    return !task.excludedOwnerIds.has(ownerId) && !purchaseOrderOverrideFencedShopIds.has(ownerId);
  }));
}

export function savePurchaseOrderOverridesToLocalApi(overrides = {}) {
  const safeOverrides = normalizePurchaseOrderLocalOverrides(overrides);
  const allEntries = Object.entries(safeOverrides)
    .map(([orderKey, value]) => ({ orderKey: String(orderKey || '').trim(), value }))
    .filter(({ orderKey, value }) => orderKey && value && typeof value === 'object' && !Array.isArray(value));
  const fencedEntries = allEntries.filter(({ value }) => (
    purchaseOrderOverrideFencedShopIds.has(normalizePurchaseOverrideOwnerId(value.shopId ?? value.shop_id))
  ));
  const entries = allEntries.filter(({ value }) => (
    !purchaseOrderOverrideFencedShopIds.has(normalizePurchaseOverrideOwnerId(value.shopId ?? value.shop_id))
  ));
  purchaseOrderOverrideLocalApiWriteQueue = purchaseOrderOverrideLocalApiWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const outcomes = await mapWithBoundedConcurrency(
        entries,
        PURCHASE_ORDER_OVERRIDE_MIGRATION_CONCURRENCY,
        async ({ orderKey, value }) => {
          const hash = hashRequestText(JSON.stringify(stableRequestPayload(value)));
          if (purchaseOrderOverrideLocalApiHashes.get(orderKey) === hash) {
            return { orderKey, skipped: true };
          }
          try {
            const result = await retryTransientLocalApiWrite(() =>
              savePurchaseOverrideToLocalApi({ ...value, orderKey }, value)
            );
            if (result?.ok === false) throw new Error('PURCHASE_OVERRIDE_SQLITE_SAVE_FAILED');
            purchaseOrderOverrideLocalApiHashes.set(orderKey, hash);
            return { orderKey, saved: true, result };
          } catch (error) {
            return { orderKey, saved: false, error };
          }
        },
      );
      return {
        savedKeys: outcomes.filter((item) => item.saved).map((item) => item.orderKey),
        skippedKeys: outcomes.filter((item) => item.skipped).map((item) => item.orderKey),
        failedKeys: [
          ...outcomes.filter((item) => item.saved === false).map((item) => item.orderKey),
          ...fencedEntries.map((item) => item.orderKey),
        ],
      };
    });
  return purchaseOrderOverrideLocalApiWriteQueue;
}

function persistPurchaseOrderLocalOverrideUpsert(plan) {
  const transportOverride = plan.override;
  const savePromise = savePurchaseOrderOverridesToLocalApi({
    [plan.canonicalKey]: transportOverride,
  });
  purchaseOrderOverrideLocalApiWriteQueue = savePromise.then(async (saveResult) => {
    if (saveResult.failedKeys.includes(plan.canonicalKey)) {
      return {
        ...saveResult,
        deletedAliasKeys: [],
        failedAliasKeys: [],
        clearFieldsCleaned: false,
      };
    }

    const deletedAliasKeys = [];
    const failedAliasKeys = [];
    for (const alias of plan.aliasDeletions) {
      try {
        const result = await retryTransientLocalApiWrite(() =>
          removePurchaseOverrideFromLocalApi({
            shopId: alias.shopId,
            orderKey: alias.orderKey,
          })
        );
        if (result?.ok === false || Number(result?.deleted) < 1) {
          throw new Error('PURCHASE_OVERRIDE_ALIAS_DELETE_FAILED');
        }
        deletedAliasKeys.push(alias.orderKey);
        purchaseOrderOverrideLocalApiHashes.delete(alias.storageKey);
        purchaseOrderOverrideLocalApiHashes.delete(alias.orderKey);
      } catch {
        failedAliasKeys.push(alias.orderKey);
      }
    }
    let clearFieldsCleaned = plan.clearFields.length === 0;
    let clearFieldsCleanupFailed = false;
    if (!failedAliasKeys.length && plan.clearFields.length) {
      try {
        const cleanupOverride = { ...plan.override };
        delete cleanupOverride.clearFields;
        const result = await retryTransientLocalApiWrite(() =>
          savePurchaseOverrideToLocalApi(
            { ...cleanupOverride, orderKey: plan.canonicalKey },
            cleanupOverride,
          )
        );
        if (result?.ok === false) throw new Error('PURCHASE_OVERRIDE_CLEAR_TOMBSTONE_CLEANUP_FAILED');
        purchaseOrderOverrideLocalApiHashes.set(
          plan.canonicalKey,
          hashRequestText(JSON.stringify(stableRequestPayload(cleanupOverride))),
        );
        clearFieldsCleaned = true;
      } catch {
        clearFieldsCleanupFailed = true;
      }
    }
    const result = {
      ...saveResult,
      deletedAliasKeys,
      failedAliasKeys,
      clearFieldsCleaned,
      clearFieldsCleanupFailed,
      failedKeys: [
        ...saveResult.failedKeys,
        ...failedAliasKeys,
        ...(clearFieldsCleanupFailed ? [plan.canonicalKey] : []),
      ],
    };
    return result;
  });
  return purchaseOrderOverrideLocalApiWriteQueue;
}

export function savePurchaseOrderLocalOverrides(overrides = {}, options = {}) {
  const normalizedOverrides = Object.fromEntries(Object.entries(normalizePurchaseOrderLocalOverrides(overrides)).filter(([, override]) => (
    !purchaseOrderOverrideFencedShopIds.has(normalizePurchaseOverrideOwnerId(override?.shopId ?? override?.shop_id))
  )));
  purchaseOrderLocalOverridesMemory = normalizedOverrides;
  if (options.persistLocalApi === false) {
    if (options.persistFile === true) {
      writeLocalDataFile(LOCAL_PURCHASE_ORDER_OVERRIDES_FILE_KEY, normalizedOverrides).catch(() => undefined);
    }
    return Promise.resolve({ savedKeys: [], skippedKeys: [], failedKeys: [] });
  }
  return savePurchaseOrderOverridesToLocalApi(normalizedOverrides);
}
export function writePurchaseOrderLocalOverrides(overrides = {}) {
  savePurchaseOrderLocalOverrides(overrides);
}

async function hydratePurchaseOrderLocalOverridesFromLocalFileInternal(task) {
  const [fileOverrides, initialReadback] = await Promise.all([
    readLocalDataFile(LOCAL_PURCHASE_ORDER_OVERRIDES_FILE_KEY).catch(error => { if (task.excludedOwnerIds.size) throw error; return {}; }),
    readPurchaseOrderOverrideReadbackFromLocalApi().catch(error => { if (task.excludedOwnerIds.size) throw error; return null; }),
  ]);
  const mergedFileOverrides = mergeLocalRecordMaps({}, fileOverrides);
  const sqliteOverrides = initialReadback?.byOrderKey || {};
  const mergedOverrides = mergeLocalRecordMaps(mergedFileOverrides, sqliteOverrides);
  const normalizedOverrides = normalizePurchaseOrderLocalOverrides(mergedOverrides);
  const preserved = Object.fromEntries(Object.entries(purchaseOrderLocalOverridesMemory || {}).filter(([, value]) => (
    task.excludedOwnerIds.has(normalizePurchaseOverrideOwnerId(value?.shopId ?? value?.shop_id))
  )));
  purchaseOrderLocalOverridesMemory = { ...eligiblePurchaseOverrideRead(normalizedOverrides, task), ...preserved };
  const currentResult = () => eligiblePurchaseOverrideRead(normalizedOverrides, task);
  const preserveLegacyFile = async () => {
    if (!task.excludedOwnerIds.size) await writeLocalDataFile(LOCAL_PURCHASE_ORDER_OVERRIDES_FILE_KEY, mergedFileOverrides).catch(() => undefined);
  };
  const legacyKeys = Object.keys(mergedFileOverrides);
  if (!legacyKeys.length) return currentResult();
  if (!initialReadback) {
    await preserveLegacyFile();
    return currentResult();
  }

  const migrationEntries = [];
  for (const orderKey of legacyKeys) {
    const legacyOverride = mergedFileOverrides[orderKey];
    if (task.excludedOwnerIds.has(normalizePurchaseOverrideOwnerId(legacyOverride?.shopId ?? legacyOverride?.shop_id))) continue;
    if (
      !hasMappablePurchaseOrderOverride(orderKey, legacyOverride)
      || purchaseOrderOverrideFencedShopIds.has(normalizePurchaseOverrideOwnerId(legacyOverride?.shopId ?? legacyOverride?.shop_id))
    ) {
      await preserveLegacyFile();
      return currentResult();
    }
    const scopedKey = getScopedPurchaseOverrideKey(orderKey, legacyOverride);
    const canonicalOverride = initialReadback.byScopedIdentity[scopedKey];
    if (
      !canonicalOverride ||
      getPurchaseOverrideUpdatedAtTimestamp(canonicalOverride) < getPurchaseOverrideUpdatedAtTimestamp(legacyOverride)
    ) {
      const payload = {
        ...toPurchaseOverridePayload({ ...legacyOverride, orderKey }, { ...legacyOverride, orderKey }),
        updatedAt: legacyOverride.updatedAt ?? legacyOverride.updated_at ?? '',
      };
      migrationEntries.push({ orderKey, legacyOverride, payload });
    }
  }

  try {
    if (migrationEntries.length === 1) {
      const { orderKey, legacyOverride } = migrationEntries[0];
      // Keep the original one-record route so the established fault injection
      // still targets the normal write path.
      const result = await savePurchaseOverrideToLocalApi({ ...legacyOverride, orderKey }, legacyOverride);
      if (result?.ok === false) throw new Error('PURCHASE_OVERRIDE_SQLITE_SAVE_FAILED');
    } else if (migrationEntries.length > 1) {
      const result = await importLegacyPurchaseOverrides(
        migrationEntries.map(({ payload }) => payload),
        { timeoutMs: 60000 },
      );
      if (!result?.ok || Number(result.importedCount) !== migrationEntries.length) {
        throw new Error('PURCHASE_OVERRIDE_BULK_IMPORT_INCOMPLETE');
      }
    }
  } catch (error) {
    if (task.excludedOwnerIds.size) throw error;
    await preserveLegacyFile();
    return currentResult();
  }

  let canonicalReadback;
  try {
    canonicalReadback = await readPurchaseOrderOverrideReadbackFromLocalApi();
  } catch (error) {
    if (task.excludedOwnerIds.size) throw error;
    await preserveLegacyFile();
    return currentResult();
  }
  // Exact normalized scoped equality is the cleanup gate. Do not rely on a
  // short digest collision-prone summary when deleting the only legacy copy.
  const readbackComplete = legacyKeys.every((orderKey) => {
    const legacyOverride = mergedFileOverrides[orderKey];
    const scopedKey = getScopedPurchaseOverrideKey(orderKey, legacyOverride);
    const canonicalOverride = canonicalReadback.byScopedIdentity[scopedKey];
    return purchaseOrderOverrideReadbackMatches(orderKey, legacyOverride, canonicalOverride);
  });
  if (!readbackComplete) {
    await preserveLegacyFile();
    return currentResult();
  }
  try {
    if (!task.excludedOwnerIds.size) await writeLocalDataFile(LOCAL_PURCHASE_ORDER_OVERRIDES_FILE_KEY, {});
  } catch {
    return currentResult();
  }
  return currentResult();
}

export function hydratePurchaseOrderLocalOverridesFromLocalFile() {
  if (!activePurchaseOrderOverrideMigration) {
    activePurchaseOrderOverrideMigration = trackPurchaseOverrideRead(hydratePurchaseOrderLocalOverridesFromLocalFileInternal).finally(() => {
      activePurchaseOrderOverrideMigration = null;
    });
  }
  return activePurchaseOrderOverrideMigration;
}

export function migrateLegacyPurchaseOrderOverridesAtStartup() {
  return hydratePurchaseOrderLocalOverridesFromLocalFile();
}
