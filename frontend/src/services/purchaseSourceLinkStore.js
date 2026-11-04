import { settleOwnerWriteDrain } from './ownerWriteDrain.js';
import { readLocalDataFile, writeLocalDataFile } from '../entities/product/productLocalData.jsx';
import { mergeLocalRecordMaps } from '../entities/product/productLocalMirror.jsx';
import { normalizeProductSourceRecord } from '../entities/order/orderSourceRecordRules.jsx';
import { readEveryCursorPage } from './legacyCursorReadback.js';
import { createLegacyScopedMigrationCoordinator } from './legacyScopedMigrationCoordinator.js';
import { LOCAL_PURCHASE_SOURCE_FILE_KEY } from '../shared/config/appConfigCore.jsx';
import {
  importLegacyPurchaseSources,
  readPurchaseSourceLinks,
  savePurchaseSourcesForOrder,
} from './purchaseSourceLinkClient.js';
import { retryTransientLocalApiWrite } from './localApiTransientWriteRetry.js';

const purchaseSourceLinkMigrationCoordinator = createLegacyScopedMigrationCoordinator();
const purchaseSourceLinkFencedShopIds = new Set();
const purchaseSourceLinkTasks = new Set();

function trackPurchaseSourceTask(work, { globalSnapshot = false } = {}) {
  const task = { excludedOwnerIds: new Set(purchaseSourceLinkFencedShopIds), promise: null };
  purchaseSourceLinkTasks.add(task);
  task.promise = Promise.resolve()
    .then(() => work(task))
    .then((result) => {
      if (globalSnapshot && [...task.excludedOwnerIds].some((id) => !purchaseSourceLinkFencedShopIds.has(id))) {
        throw Object.assign(new Error('ACCOUNT_REMOVAL_STALE_HYDRATION'), { code: 'ACCOUNT_REMOVAL_STALE_HYDRATION' });
      }
      return result;
    })
    .finally(() => purchaseSourceLinkTasks.delete(task));
  return task.promise;
}

function eligiblePurchaseSources(records, task, shops = [], legacy = false) {
  return Object.fromEntries(
    Object.entries(asRecordMap(records)).filter(([key]) => {
      const rawScope = String(key).split(':')[0].trim();
      const identity = legacy ? splitLegacyScopedOrderKey(key, shops) : { shopId: rawScope };
      if (task.excludedOwnerIds.has(rawScope) || task.excludedOwnerIds.has(identity?.shopId)) return false;
      return !legacy || task.excludedOwnerIds.size === 0 || Boolean(identity);
    })
  );
}

function publishPurchaseSources(canonical, legacy, task, shops) {
  return {
    canonicalLinks: eligiblePurchaseSources(canonical, task),
    unresolvedLegacyLinks: eligiblePurchaseSources(legacy, task, shops, true),
  };
}

function normalizePurchaseSourceOwnerId(value) {
  return String(value ?? '').trim();
}

function assertPurchaseSourceOwnerWritable(shopId, task) {
  const ownerId = normalizePurchaseSourceOwnerId(shopId);
  if (!purchaseSourceLinkFencedShopIds.has(ownerId) && !task?.excludedOwnerIds.has(ownerId)) return;
  const error = new Error('ACCOUNT_REMOVAL_OWNER_QUIESCED');
  error.code = 'ACCOUNT_REMOVAL_OWNER_QUIESCED';
  throw error;
}

export async function fenceAndDrainPurchaseSourceLinkMigration(shopId) {
  const ownerId = normalizePurchaseSourceOwnerId(shopId);
  if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  purchaseSourceLinkFencedShopIds.add(ownerId);
  const pending = [...purchaseSourceLinkTasks];
  pending.forEach((task) => task.excludedOwnerIds.add(ownerId));
  const drain = await settleOwnerWriteDrain([
    purchaseSourceLinkMigrationCoordinator.drain(),
    ...pending.map((task) => task.promise),
  ]);
  return { ownerId, fenced: true, ...drain };
}

export function releasePurchaseSourceLinkOwnerFence(shopId) {
  return purchaseSourceLinkFencedShopIds.delete(normalizePurchaseSourceOwnerId(shopId));
}

function asRecordMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function recordTimestamp(record = {}) {
  const normalized = normalizeProductSourceRecord(record);
  const values = [record.updatedAt, normalized.updatedAt, ...normalized.links.map((link) => link.savedAt)]
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : 0;
}

function toComparableRecord(record = {}) {
  const normalized = normalizeProductSourceRecord(record);
  return {
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
      priceValue: link.priceValue ?? link.price ?? null,
      qty: link.qty,
    })),
    primaryIndex: normalized.primaryIndex,
  };
}

function recordsMatch(left = {}, right = {}) {
  return JSON.stringify(toComparableRecord(left)) === JSON.stringify(toComparableRecord(right));
}

function mapPurchaseSourceRows(rows = []) {
  const grouped = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const shopId = String(row.shopId ?? row.shop_id ?? '').trim();
    const orderKey = String(row.orderKey ?? row.order_key ?? '').trim();
    if (!shopId || !orderKey) return;
    const key = `${shopId}:${orderKey}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  });
  return Array.from(grouped.entries()).reduce((records, [key, rowsForOrder]) => {
    const sorted = [...rowsForOrder].sort(
      (left, right) =>
        (Number(left.slotIndex ?? left.slot_index) || 0) - (Number(right.slotIndex ?? right.slot_index) || 0)
    );
    records[key] = {
      links: sorted.map((row) => ({
        slotIndex: Number(row.slotIndex ?? row.slot_index) || 0,
        link: row.url ?? row.link ?? '',
        productId: row.sourceProductId ?? row.source_product_id ?? row.productId ?? '',
        platform: row.platform ?? '',
        title: row.title ?? '',
        imageUrl:
          row.imageUrl ??
          row.image_url ??
          row.previewImageUrl ??
          row.preview_image_url ??
          row.originalImageUrl ??
          row.original_image_url ??
          '',
        previewImageUrl: row.previewImageUrl ?? row.preview_image_url ?? '',
        originalImageUrl: row.originalImageUrl ?? row.original_image_url ?? '',
        priceValue: row.priceValue ?? row.price_value,
        price: row.priceValue ?? row.price_value ?? '',
        qty: row.qty ?? '',
        savedAt: row.updatedAt ?? row.updated_at ?? row.createdAt ?? '',
      })),
      primaryIndex: Math.max(
        0,
        sorted.findIndex((row) => row.isPrimary || row.is_primary)
      ),
      updatedAt: sorted.reduce((latest, row) => {
        const next = row.updatedAt ?? row.updated_at ?? row.createdAt ?? '';
        return Date.parse(next) > Date.parse(latest) ? next : latest;
      }, ''),
    };
    return records;
  }, {});
}

function resolveActualShopId(legacyScope, shops = []) {
  const scope = String(legacyScope || '').trim();
  if (!scope) return '';
  const matches = (Array.isArray(shops) ? shops : []).filter((shop) =>
    [shop.id, shop.clientId, shop.client_id, shop.shopId, shop.shop_id, shop.alias, shop.shopAlias, shop.sellerName]
      .map((value) => String(value ?? '').trim())
      .includes(scope)
  );
  return matches.length === 1 ? String(matches[0].id || '').trim() : '';
}

function splitLegacyScopedOrderKey(key = '', shops = []) {
  const text = String(key || '').trim();
  const delimiter = text.indexOf(':');
  if (delimiter <= 0 || delimiter >= text.length - 1) return null;
  const shopId = resolveActualShopId(text.slice(0, delimiter), shops);
  const orderKey = text.slice(delimiter + 1).trim();
  return shopId && orderKey ? { shopId, orderKey, canonicalKey: `${shopId}:${orderKey}` } : null;
}

function toLegacyImportRecord(identity, record) {
  const normalized = normalizeProductSourceRecord(record);
  if (!normalized.links.length) return null;
  return {
    shopId: identity.shopId,
    orderKey: identity.orderKey,
    primaryIndex: normalized.primaryIndex,
    links: normalized.links.map((link, index) => ({
      ...link,
      slotIndex: Number(link.slotIndex ?? link.slot_index ?? index) || 0,
    })),
  };
}

async function writeLegacyFallback(records = {}, task) {
  if (task.excludedOwnerIds.size) return;
  await writeLocalDataFile(LOCAL_PURCHASE_SOURCE_FILE_KEY, records);
}

async function readPurchaseSources(task) {
  const readback = await readEveryCursorPage((pageQuery) => readPurchaseSourceLinks(pageQuery), { pageSize: 1000 });
  if (!readback.complete) {
    if (readback.error && task.excludedOwnerIds.size) throw readback.error;
    const error = new Error(readback.reason || 'PURCHASE_SOURCE_CURSOR_READBACK_INCOMPLETE');
    error.code = 'PURCHASE_SOURCE_CURSOR_READBACK_INCOMPLETE';
    error.readback = readback;
    throw error;
  }
  return eligiblePurchaseSources(mapPurchaseSourceRows(readback.rows), task);
}

export function readPurchaseSourceLinksFromLocalApi() {
  return trackPurchaseSourceTask((task) => readPurchaseSources(task));
}

export function savePurchaseSourceLinkRecord({
  order = {},
  record = {},
  shopId = '',
  productKey = '',
  timeoutMs = 3000,
} = {}) {
  return trackPurchaseSourceTask(async (task) => {
    const resolvedShopId = String(shopId || order.shopId || order.shop_id || '').trim();
    const orderKey = String(
      order.orderKey ||
        order.recordKey ||
        order.record_key ||
        order.id ||
        order.postingNumber ||
        order.posting_number ||
        order.ozonOrderId ||
        ''
    ).trim();
    if (!resolvedShopId || !orderKey) throw new Error('PURCHASE_SOURCE_LINK_IDENTITY_REQUIRED');
    assertPurchaseSourceOwnerWritable(resolvedShopId, task);
    const normalized = normalizeProductSourceRecord(record);
    return retryTransientLocalApiWrite(async () => {
      assertPurchaseSourceOwnerWritable(resolvedShopId, task);
      const result = await savePurchaseSourcesForOrder(order, normalized.links, {
        shopId: resolvedShopId,
        productKey,
        primaryIndex: normalized.primaryIndex,
        timeoutMs,
      });
      if (!result?.ok) throw new Error('PURCHASE_SOURCE_LINK_SAVE_FAILED');
      return result;
    });
  });
}

async function hydratePurchaseSourceLinks(browserLinks, shops, task) {
  let canonicalFailure = null;
  const [fileLinks, initialCanonical] = await Promise.all([
    readLocalDataFile(LOCAL_PURCHASE_SOURCE_FILE_KEY).catch(() => ({})),
    readPurchaseSources(task).catch((error) => {
      canonicalFailure = error;
      return null;
    }),
  ]);
  if (canonicalFailure && task.excludedOwnerIds.size) throw canonicalFailure;
  const browserLinkMap = asRecordMap(browserLinks);
  const legacyLinks = eligiblePurchaseSources(
    mergeLocalRecordMaps(browserLinkMap, asRecordMap(fileLinks)),
    task,
    shops,
    true
  );
  let currentCanonical = asRecordMap(initialCanonical);
  const sourceEntries = Object.entries(legacyLinks);
  if (!sourceEntries.length) return publishPurchaseSources(currentCanonical, {}, task, shops);
  if (initialCanonical === null) {
    await writeLegacyFallback(legacyLinks, task).catch(() => undefined);
    return publishPurchaseSources(currentCanonical, legacyLinks, task, shops);
  }

  const pending = [];
  for (const [legacyKey, record] of sourceEntries) {
    const identity = splitLegacyScopedOrderKey(legacyKey, shops);
    const payload = identity && toLegacyImportRecord(identity, record);
    if (identity && task.excludedOwnerIds.has(identity.shopId)) continue;
    if (!identity || !payload) {
      await writeLegacyFallback(legacyLinks, task).catch(() => undefined);
      return publishPurchaseSources(currentCanonical, legacyLinks, task, shops);
    }
    const canonicalRecord = currentCanonical[identity.canonicalKey];
    if (canonicalRecord && recordTimestamp(canonicalRecord) >= recordTimestamp(record)) continue;
    pending.push({ legacyKey, identity, record, payload });
  }

  try {
    if (pending.length === 1) {
      const { identity, payload } = pending[0];
      const result = await savePurchaseSourcesForOrder(
        { shopId: identity.shopId, orderKey: identity.orderKey },
        payload.links,
        { shopId: identity.shopId, primaryIndex: payload.primaryIndex, timeoutMs: 30000 }
      );
      if (!result?.ok) throw new Error('PURCHASE_SOURCE_LINK_SAVE_FAILED');
    } else if (pending.length > 1) {
      const result = await importLegacyPurchaseSources(
        pending.map(({ payload }) => payload),
        { timeoutMs: 60000 }
      );
      if (!result?.ok || Number(result.importedCount) !== pending.length) {
        throw new Error('PURCHASE_SOURCE_LINK_BULK_IMPORT_INCOMPLETE');
      }
    }
    currentCanonical = await readPurchaseSources(task);
  } catch (error) {
    if (task.excludedOwnerIds.size) throw error;
    await writeLegacyFallback(legacyLinks, task).catch(() => undefined);
    return publishPurchaseSources(currentCanonical, legacyLinks, task, shops);
  }

  // Every source record is compared exactly after a complete cursor readback;
  // a 32-bit digest is not sufficient evidence to retire legacy bytes.
  const readbackComplete = sourceEntries.every(([legacyKey, record]) => {
    const identity = splitLegacyScopedOrderKey(legacyKey, shops);
    if (!identity) return false;
    return recordsMatch(currentCanonical[identity.canonicalKey], record);
  });
  if (!readbackComplete) {
    await writeLegacyFallback(legacyLinks, task).catch(() => undefined);
    return publishPurchaseSources(currentCanonical, legacyLinks, task, shops);
  }

  try {
    await writeLegacyFallback({}, task);
  } catch {
    return publishPurchaseSources(currentCanonical, legacyLinks, task, shops);
  }
  return publishPurchaseSources(currentCanonical, {}, task, shops);
}

export function hydratePurchaseSourceLinksFromLocalFile(browserLinks = {}, shops = []) {
  return trackPurchaseSourceTask((task) => hydratePurchaseSourceLinks(browserLinks, shops, task), {
    globalSnapshot: true,
  });
}

export function migrateLegacyPurchaseSourceLinksAtStartup(shops = []) {
  return trackPurchaseSourceTask(
    (task) => purchaseSourceLinkMigrationCoordinator.run(shops, () => hydratePurchaseSourceLinks({}, shops, task)),
    { globalSnapshot: true }
  );
}
