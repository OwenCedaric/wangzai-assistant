import { settleOwnerWriteDrain } from './ownerWriteDrain.js';
import { readLocalDataFile, writeLocalDataFile } from '../entities/product/productLocalData.jsx';
import { mergeLocalRecordMaps } from '../entities/product/productLocalMirror.jsx';
import { normalizeProductSourceRecord } from '../entities/order/orderSourceRecordRules.jsx';
import { readEveryCursorPage } from './legacyCursorReadback.js';
import { createLegacyScopedMigrationCoordinator } from './legacyScopedMigrationCoordinator.js';
import { LOCAL_SALES_SOURCE_FILE_KEY } from '../shared/config/appConfigCore.jsx';
import { importLegacySalesSources, readSalesSourceLinks, saveSalesSourcesForOrder } from './salesSourceLinkClient.js';

const salesSourceLinkMigrationCoordinator = createLegacyScopedMigrationCoordinator();
const salesSourceLinkFencedShopIds = new Set();
const salesSourceLinkTasks = new Set();

function trackSalesSourceTask(work, { globalSnapshot = false } = {}) {
  const task = { excludedOwnerIds: new Set(salesSourceLinkFencedShopIds), promise: null };
  salesSourceLinkTasks.add(task);
  task.promise = Promise.resolve()
    .then(() => work(task))
    .then((result) => {
      if (globalSnapshot && [...task.excludedOwnerIds].some((id) => !salesSourceLinkFencedShopIds.has(id))) {
        throw Object.assign(new Error('ACCOUNT_REMOVAL_STALE_HYDRATION'), { code: 'ACCOUNT_REMOVAL_STALE_HYDRATION' });
      }
      return result;
    })
    .finally(() => salesSourceLinkTasks.delete(task));
  return task.promise;
}

function eligibleSalesSources(records, task, shops = [], legacy = false) {
  return Object.fromEntries(
    Object.entries(asRecordMap(records)).filter(([key]) => {
      const rawScope = String(key).split(':')[0].trim();
      const identity = legacy ? splitLegacyScopedOrderKey(key, shops) : { shopId: rawScope };
      if (task.excludedOwnerIds.has(rawScope) || task.excludedOwnerIds.has(identity?.shopId)) return false;
      return !legacy || task.excludedOwnerIds.size === 0 || Boolean(identity);
    })
  );
}

function publishSalesSources(canonical, legacy, task, shops) {
  return {
    canonicalLinks: eligibleSalesSources(canonical, task),
    unresolvedLegacyLinks: eligibleSalesSources(legacy, task, shops, true),
  };
}

function normalizeSalesSourceOwnerId(value) {
  return String(value ?? '').trim();
}

export async function fenceAndDrainSalesSourceLinkMigration(shopId) {
  const ownerId = normalizeSalesSourceOwnerId(shopId);
  if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  salesSourceLinkFencedShopIds.add(ownerId);
  const pending = [...salesSourceLinkTasks];
  pending.forEach((task) => task.excludedOwnerIds.add(ownerId));
  const drain = await settleOwnerWriteDrain([
    salesSourceLinkMigrationCoordinator.drain(),
    ...pending.map((task) => task.promise),
  ]);
  return { ownerId, fenced: true, ...drain };
}

export function releaseSalesSourceLinkOwnerFence(shopId) {
  return salesSourceLinkFencedShopIds.delete(String(shopId || '').trim());
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

function mapSalesSourceRows(rows = []) {
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
        link: row.link ?? row.url ?? '',
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
        savedAt: row.updatedAt ?? row.updated_at ?? '',
      })),
      primaryIndex: Math.max(
        0,
        sorted.findIndex((row) => row.isPrimary || row.is_primary)
      ),
      updatedAt: sorted.reduce((latest, row) => {
        const next = row.updatedAt ?? row.updated_at ?? '';
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
  await writeLocalDataFile(LOCAL_SALES_SOURCE_FILE_KEY, records);
}

async function readSalesSources(task) {
  const readback = await readEveryCursorPage((pageQuery) => readSalesSourceLinks(pageQuery), { pageSize: 1000 });
  if (!readback.complete) {
    if (readback.error && task.excludedOwnerIds.size) throw readback.error;
    const error = new Error(readback.reason || 'SALES_SOURCE_CURSOR_READBACK_INCOMPLETE');
    error.code = 'SALES_SOURCE_CURSOR_READBACK_INCOMPLETE';
    error.readback = readback;
    throw error;
  }
  return eligibleSalesSources(mapSalesSourceRows(readback.rows), task);
}

export function readSalesSourceLinksFromLocalApi() {
  return trackSalesSourceTask((task) => readSalesSources(task));
}

async function hydrateSalesSourceLinks(browserLinks, shops, task) {
  let canonicalFailure = null;
  const [fileLinks, initialCanonical] = await Promise.all([
    readLocalDataFile(LOCAL_SALES_SOURCE_FILE_KEY).catch(() => ({})),
    readSalesSources(task).catch((error) => {
      canonicalFailure = error;
      return null;
    }),
  ]);
  if (canonicalFailure && task.excludedOwnerIds.size) throw canonicalFailure;
  const browserLinkMap = asRecordMap(browserLinks);
  const legacyLinks = eligibleSalesSources(
    mergeLocalRecordMaps(browserLinkMap, asRecordMap(fileLinks)),
    task,
    shops,
    true
  );
  let currentCanonical = asRecordMap(initialCanonical);
  const sourceEntries = Object.entries(legacyLinks);
  if (!sourceEntries.length) return publishSalesSources(currentCanonical, {}, task, shops);
  if (initialCanonical === null) {
    await writeLegacyFallback(legacyLinks, task).catch(() => undefined);
    return publishSalesSources(currentCanonical, legacyLinks, task, shops);
  }

  const pending = [];
  for (const [legacyKey, record] of sourceEntries) {
    const identity = splitLegacyScopedOrderKey(legacyKey, shops);
    const payload = identity && toLegacyImportRecord(identity, record);
    if (identity && task.excludedOwnerIds.has(identity.shopId)) continue;
    if (!identity || !payload) {
      await writeLegacyFallback(legacyLinks, task).catch(() => undefined);
      return publishSalesSources(currentCanonical, legacyLinks, task, shops);
    }
    const canonicalRecord = currentCanonical[identity.canonicalKey];
    if (canonicalRecord && recordTimestamp(canonicalRecord) >= recordTimestamp(record)) continue;
    pending.push({ legacyKey, identity, record, payload });
  }

  try {
    if (pending.length === 1) {
      const { identity, payload } = pending[0];
      const result = await saveSalesSourcesForOrder(
        {
          shopId: identity.shopId,
          orderKey: identity.orderKey,
          record: payload,
        },
        { timeoutMs: 30000 }
      );
      if (!result?.ok) throw new Error('SALES_SOURCE_LINK_SAVE_FAILED');
    } else if (pending.length > 1) {
      const result = await importLegacySalesSources(
        pending.map(({ payload }) => payload),
        { timeoutMs: 60000 }
      );
      if (!result?.ok || Number(result.importedCount) !== pending.length) {
        throw new Error('SALES_SOURCE_LINK_BULK_IMPORT_INCOMPLETE');
      }
    }
    currentCanonical = await readSalesSources(task);
  } catch (error) {
    if (task.excludedOwnerIds.size) throw error;
    await writeLegacyFallback(legacyLinks, task).catch(() => undefined);
    return publishSalesSources(currentCanonical, legacyLinks, task, shops);
  }

  // Compare every normalized source record directly. A short digest alone
  // cannot be used to decide that it is safe to delete the legacy source.
  const readbackComplete = sourceEntries.every(([legacyKey, record]) => {
    const identity = splitLegacyScopedOrderKey(legacyKey, shops);
    if (!identity) return false;
    return recordsMatch(currentCanonical[identity.canonicalKey], record);
  });
  if (!readbackComplete) {
    await writeLegacyFallback(legacyLinks, task).catch(() => undefined);
    return publishSalesSources(currentCanonical, legacyLinks, task, shops);
  }

  try {
    await writeLegacyFallback({}, task);
  } catch {
    return publishSalesSources(currentCanonical, legacyLinks, task, shops);
  }
  return publishSalesSources(currentCanonical, {}, task, shops);
}

export function hydrateSalesSourceLinksFromLocalFile(browserLinks = {}, shops = []) {
  return trackSalesSourceTask((task) => hydrateSalesSourceLinks(browserLinks, shops, task), { globalSnapshot: true });
}

export function migrateLegacySalesSourceLinksAtStartup(shops = []) {
  return trackSalesSourceTask(
    (task) => salesSourceLinkMigrationCoordinator.run(shops, () => hydrateSalesSourceLinks({}, shops, task)),
    { globalSnapshot: true }
  );
}
