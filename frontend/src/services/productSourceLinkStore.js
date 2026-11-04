import { settleOwnerWriteDrain } from './ownerWriteDrain.js';
import { readLocalDataFile, writeLocalDataFile } from '../entities/product/productLocalData.jsx';
import { mergeLocalRecordMaps } from '../entities/product/productLocalMirror.jsx';
import { normalizeProductSourceRecord } from '../entities/order/orderSourceRecordRules.jsx';
import { LOCAL_PRODUCT_SOURCE_FILE_KEY } from '../shared/config/appConfigCore.jsx';
import {
  importLegacyProductSourceLinkRecords,
  readProductSourceLinksFromLocalApi,
  saveProductSourceLinksToLocalApi,
} from './productModuleClient.js';
import { retryTransientLocalApiWrite } from './localApiTransientWriteRetry.js';

function isPlainRecordMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

let activeProductSourceLinkMigration = null;
const productSourceLinkFencedShopIds = new Set();
const productSourceLinkTasks = new Set();

function trackProductSourceTask(work, { globalSnapshot = false } = {}) {
  const task = { excludedOwnerIds: new Set(productSourceLinkFencedShopIds), globalSnapshot, promise: null };
  productSourceLinkTasks.add(task);
  task.promise = Promise.resolve()
    .then(() => work(task))
    .then((result) => {
      // Direct page callers replace a whole map, so an old partial snapshot must
      // not replace a newly rebound owner's current state after fence release.
      if (globalSnapshot && [...task.excludedOwnerIds].some((id) => !productSourceLinkFencedShopIds.has(id))) {
        throw Object.assign(new Error('ACCOUNT_REMOVAL_STALE_HYDRATION'), { code: 'ACCOUNT_REMOVAL_STALE_HYDRATION' });
      }
      return result;
    })
    .finally(() => productSourceLinkTasks.delete(task));
  return task.promise;
}

function eligibleProductSources(records, task, shops, legacy = false) {
  return Object.fromEntries(
    Object.entries(isPlainRecordMap(records)).filter(([key]) => {
      const rawScope = String(key).split(':')[0].trim();
      const identity = splitScopedProductKey(key, shops, { allowDirectScope: !legacy });
      if (task.excludedOwnerIds.has(rawScope) || task.excludedOwnerIds.has(identity?.shopId)) return false;
      // Unattributed legacy bytes stay on disk; do not republish them while a
      // deleted owner's identity cannot be ruled out.
      return !legacy || task.excludedOwnerIds.size === 0 || Boolean(identity);
    })
  );
}

function publishProductSources(legacy, canonical, task, shops) {
  return mergeLocalRecordMaps(
    eligibleProductSources(legacy, task, shops, true),
    eligibleProductSources(canonical, task, shops)
  );
}

function normalizeProductSourceOwnerId(value) {
  return String(value ?? '').trim();
}

function assertProductSourceOwnerWritable(shopId, task) {
  const ownerId = normalizeProductSourceOwnerId(shopId);
  if (!productSourceLinkFencedShopIds.has(ownerId) && !task?.excludedOwnerIds.has(ownerId)) return;
  const error = new Error('ACCOUNT_REMOVAL_OWNER_QUIESCED');
  error.code = 'ACCOUNT_REMOVAL_OWNER_QUIESCED';
  throw error;
}

export async function fenceAndDrainProductSourceLinkMigration(shopId) {
  const ownerId = normalizeProductSourceOwnerId(shopId);
  if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  productSourceLinkFencedShopIds.add(ownerId);
  const pending = [...productSourceLinkTasks];
  pending.forEach((task) => task.excludedOwnerIds.add(ownerId));
  const drain = await settleOwnerWriteDrain([activeProductSourceLinkMigration, ...pending.map((task) => task.promise)]);
  return { ownerId, fenced: true, ...drain };
}

export function releaseProductSourceLinkOwnerFence(shopId) {
  return productSourceLinkFencedShopIds.delete(normalizeProductSourceOwnerId(shopId));
}

function getRecordUpdatedAt(record = {}) {
  const normalized = normalizeProductSourceRecord(record);
  const timestamps = [record.updatedAt, normalized.updatedAt, ...normalized.links.map((link) => link.savedAt)]
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : 0;
}

function resolveActualShopId(legacyScope, shops = [], { allowDirectScope = false } = {}) {
  const scope = String(legacyScope || '').trim();
  if (!scope || ['default', 'all', '*'].includes(scope.toLowerCase())) return '';
  const candidates = Array.isArray(shops) ? shops : [];
  const matches = candidates.filter((shop) =>
    [shop.id, shop.clientId, shop.client_id, shop.shopId, shop.shop_id, shop.alias, shop.shopAlias, shop.sellerName]
      .map((value) => String(value ?? '').trim())
      .includes(scope)
  );
  if (matches.length === 1) return String(matches[0].id || '').trim();
  // Migration input may contain a historical client id or display alias.
  // Without one unambiguous configured shop we must not manufacture a new
  // SQLite scope. Normal interactive saves opt in to direct canonical IDs.
  return allowDirectScope ? scope : '';
}

function splitScopedProductKey(key = '', shops = [], options = {}) {
  const text = String(key || '').trim();
  const delimiter = text.indexOf(':');
  if (delimiter <= 0 || delimiter >= text.length - 1) return null;
  const shopId = resolveActualShopId(text.slice(0, delimiter), shops, options);
  const productKey = text.slice(delimiter + 1).trim();
  return shopId && productKey ? { shopId, productKey, canonicalKey: `${shopId}:${productKey}` } : null;
}

function toComparableProductSourceRecord(key, record = {}) {
  // `key` here is already a canonical key emitted by the scoped mapping above.
  const identity = splitScopedProductKey(key, [], { allowDirectScope: true });
  if (!identity) return null;
  const normalized = normalizeProductSourceRecord(record);
  return {
    shopId: identity.shopId,
    productKey: identity.productKey,
    links: normalized.links.map((link, index) => ({
      slotIndex: Number(link.slotIndex ?? link.slot_index ?? index) || 0,
      isPrimary: normalized.primaryIndex === index,
      link: link.link,
      productId: link.productId,
      platform: link.platform,
      title: link.title,
      imageUrl: link.imageUrl,
      previewImageUrl: link.previewImageUrl,
      originalImageUrl: link.originalImageUrl,
      priceValue: link.priceValue ?? null,
      qty: link.qty,
    })),
    primaryIndex: normalized.primaryIndex,
  };
}

function recordsMatch(key, left = {}, right = {}) {
  return (
    JSON.stringify(toComparableProductSourceRecord(key, left)) ===
    JSON.stringify(toComparableProductSourceRecord(key, right))
  );
}

function toProductSourcePayload(key, record, product = {}, shops = [], options = {}) {
  const identity = splitScopedProductKey(key, shops, options);
  if (!identity) return null;
  const normalized = normalizeProductSourceRecord(record);
  if (!normalized.links.length) return null;
  return {
    shopId: identity.shopId,
    productKey: identity.productKey,
    productId: product.productId ?? product.product_id ?? '',
    offerId: product.offerId ?? product.offer_id ?? identity.productKey,
    sku: product.ozonSku ?? product.sku ?? '',
    record: normalized,
    links: normalized.links,
    primaryIndex: normalized.primaryIndex,
  };
}

async function writeLegacyFallback(records = {}, task) {
  if (task.excludedOwnerIds.size) return;
  await writeLocalDataFile(LOCAL_PRODUCT_SOURCE_FILE_KEY, records);
}

export function saveProductSourceLinkRecord({ key, record, product = {}, timeoutMs = 3000 } = {}) {
  return trackProductSourceTask(async (task) => {
    // Interactive edits already receive a canonical shop ID from the selected
    // product. They are not legacy migration input and retain the established
    // direct write path.
    const payload = toProductSourcePayload(key, record, product, [], { allowDirectScope: true });
    if (!payload) throw new Error('PRODUCT_SOURCE_LINK_IDENTITY_REQUIRED');
    assertProductSourceOwnerWritable(payload.shopId, task);
    return retryTransientLocalApiWrite(async () => {
      assertProductSourceOwnerWritable(payload.shopId, task);
      const result = await saveProductSourceLinksToLocalApi(payload, { timeoutMs });
      if (!result?.ok) throw new Error('PRODUCT_SOURCE_LINK_SAVE_FAILED');
      return result;
    });
  });
}

/**
 * Migrate product links through one typed bulk route when there is more than
 * one logical record. Every canonical page is read to completion before the
 * old file/browser bytes can be retired.
 */
async function hydrateProductSourceLinks(browserLinks, shops, task) {
  let canonicalFailure = null;
  const [fileLinks, initialCanonical] = await Promise.all([
    readLocalDataFile(LOCAL_PRODUCT_SOURCE_FILE_KEY).catch(() => ({})),
    readProductSourceLinksFromLocalApi().catch((error) => {
      canonicalFailure = error;
      return null;
    }),
  ]);
  if (canonicalFailure && task.excludedOwnerIds.size && task.globalSnapshot) throw canonicalFailure;
  const browserLinkMap = isPlainRecordMap(browserLinks);
  const legacyLinks = eligibleProductSources(
    mergeLocalRecordMaps(browserLinkMap, isPlainRecordMap(fileLinks)),
    task,
    shops,
    true
  );
  let currentCanonical = isPlainRecordMap(initialCanonical);
  const sourceEntries = Object.entries(legacyLinks);
  if (!sourceEntries.length) return publishProductSources({}, currentCanonical, task, shops);
  if (initialCanonical === null) {
    await writeLegacyFallback(legacyLinks, task).catch(() => undefined);
    return publishProductSources(legacyLinks, currentCanonical, task, shops);
  }

  const unresolved = [];
  const pending = [];
  sourceEntries.forEach(([legacyKey, record]) => {
    const identity = splitScopedProductKey(legacyKey, shops);
    const payload = toProductSourcePayload(legacyKey, record, {}, shops);
    if (!identity || !payload) {
      unresolved.push(legacyKey);
      return;
    }
    if (task.excludedOwnerIds.has(identity.shopId)) return;
    const canonicalRecord = currentCanonical[identity.canonicalKey];
    if (canonicalRecord && getRecordUpdatedAt(canonicalRecord) >= getRecordUpdatedAt(record)) return;
    pending.push({ legacyKey, record, payload });
  });

  if (unresolved.length) {
    await writeLegacyFallback(legacyLinks, task).catch(() => undefined);
    return publishProductSources(legacyLinks, currentCanonical, task, shops);
  }

  try {
    if (pending.length === 1) {
      const result = await saveProductSourceLinksToLocalApi(pending[0].payload, { timeoutMs: 30000 });
      if (!result?.ok) throw new Error('PRODUCT_SOURCE_LINK_SAVE_FAILED');
    } else if (pending.length > 1) {
      const result = await importLegacyProductSourceLinkRecords(
        pending.map(({ payload }) => payload),
        { timeoutMs: 60000 }
      );
      if (!result?.ok || Number(result.importedCount) !== pending.length) {
        throw new Error('PRODUCT_SOURCE_LINK_BULK_IMPORT_INCOMPLETE');
      }
    }
    currentCanonical = isPlainRecordMap(await readProductSourceLinksFromLocalApi());
  } catch (error) {
    if (task.excludedOwnerIds.size && task.globalSnapshot) throw error;
    await writeLegacyFallback(legacyLinks, task).catch(() => undefined);
    return publishProductSources(legacyLinks, currentCanonical, task, shops);
  }

  // Do not use a short non-cryptographic digest as a cleanup gate.  Each
  // migrated scoped record must round-trip through the normalized canonical
  // representation exactly before legacy storage can be retired.
  const readbackComplete = sourceEntries.every(([legacyKey, record]) => {
    const identity = splitScopedProductKey(legacyKey, shops);
    if (!identity) return false;
    return recordsMatch(identity.canonicalKey, currentCanonical[identity.canonicalKey], record);
  });
  if (!readbackComplete) {
    await writeLegacyFallback(legacyLinks, task).catch(() => undefined);
    return publishProductSources(legacyLinks, currentCanonical, task, shops);
  }

  try {
    await writeLegacyFallback({}, task);
  } catch {
    // Browser cleanup (if any) is still safe here because the old file was
    // never removed when its clear write failed.
    return publishProductSources(legacyLinks, currentCanonical, task, shops);
  }
  return publishProductSources(legacyLinks, currentCanonical, task, shops);
}

export function hydrateProductSourceLinksFromLocalFile(browserLinks = {}, shops = []) {
  return trackProductSourceTask((task) => hydrateProductSourceLinks(browserLinks, shops, task), {
    globalSnapshot: true,
  });
}

/** Shares one startup migration so the App and profit module cannot race to migrate the same local file. */
export function migrateLegacyProductSourceLinksAtStartup(shops = []) {
  if (!activeProductSourceLinkMigration) {
    // Startup/profit callers consume this as merge-only inputs; keep other
    // owners' data instead of turning the exclusion into a global empty input.
    activeProductSourceLinkMigration = trackProductSourceTask((task) =>
      hydrateProductSourceLinks({}, shops, task)
    ).finally(() => {
      activeProductSourceLinkMigration = null;
    });
  }
  return activeProductSourceLinkMigration;
}
