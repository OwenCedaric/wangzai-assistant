import { readPublishedProfitSnapshots } from '../../db/repositories/profitLedgerSnapshotRepository.js';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function tableExists(db, tableName) {
  return Boolean(
    db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName)?.found
  );
}

function normalizeList(value) {
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source.flatMap((item) => normalizeText(item).split(',')).map(normalizeText).filter(Boolean))];
}

function normalizedIdentity(value) {
  return normalizeText(value).replace(/\s+/gu, '').toLocaleLowerCase();
}

function postingBaseIdentity(value) {
  const identity = normalizedIdentity(value);
  const match = identity.match(/^(\d{6,}-\d{3,})-\d+$/u);
  return match?.[1] || '';
}

function rowShopIds(row = {}) {
  const order = row?.orderSnapshot && typeof row.orderSnapshot === 'object' ? row.orderSnapshot : {};
  return [...new Set([
    row.shopId,
    row.shopClientId,
    order.shopId,
    order.shopClientId,
  ].map(normalizeText).filter(Boolean))];
}

function effectiveRowShopIds(row = {}) {
  const direct = rowShopIds(row);
  if (direct.length) return direct;
  return [normalizeText(row.__snapshot?.sourceKey)].filter(Boolean);
}

function rowOrderIdentities(row = {}) {
  const order = row?.orderSnapshot && typeof row.orderSnapshot === 'object' ? row.orderSnapshot : {};
  return [...new Set([
    row.ledgerKey,
    row.orderKey,
    order.id,
    order.posting,
    order.salesOrder,
    order.softwareOrderId,
    order.recordKey,
    order.profitRecordKey,
  ].map(normalizedIdentity).filter(Boolean))];
}

function rowProductIdentities(row = {}) {
  const order = row?.orderSnapshot && typeof row.orderSnapshot === 'object' ? row.orderSnapshot : {};
  const products = Array.isArray(order.products) ? order.products : [];
  return [...new Set([
    order.sku,
    order.skuId,
    order.offerId,
    ...products.flatMap((product) => [
      product?.sku,
      product?.skuId,
      product?.offerId,
      product?.productId,
    ]),
  ].map(normalizedIdentity).filter(Boolean))];
}

function rowDate(row = {}) {
  const order = row?.orderSnapshot && typeof row.orderSnapshot === 'object' ? row.orderSnapshot : {};
  return normalizeText(order.paymentTime || order.paymentDate || row.updatedAt || row.sourceUpdatedAt);
}

function rowDedupeKey(row = {}, fallback = '') {
  const owner = normalizeText(row.shopId || row.orderSnapshot?.shopId || row.shopClientId || row.orderSnapshot?.shopClientId);
  return `${owner}|${normalizedIdentity(row.ledgerKey || row.orderKey) || fallback}`;
}

function readLedgerRows(db) {
  if (!tableExists(db, 'profit_ledger_snapshots')) return [];
  const snapshots = readPublishedProfitSnapshots(db);
  const rowsByKey = new Map();
  snapshots.forEach((record) => {
    const snapshot = record.snapshot;
    const source = {
      sourceKey: normalizeText(snapshot?.sourceKey || record.source_key),
      snapshotKey: normalizeText(record.snapshot_key),
      updatedAt: normalizeText(record.updated_at || snapshot?.updatedAt || snapshot?.fetchedAt || record.fetched_at),
    };
    (Array.isArray(snapshot?.rows) ? snapshot.rows : []).forEach((row, index) => {
      if (!row || typeof row !== 'object') return;
      const key = rowDedupeKey(row, `${source.snapshotKey}:${index}`);
      if (rowsByKey.has(key)) return;
      rowsByKey.set(key, { ...row, __snapshot: source });
    });
  });
  return [...rowsByKey.values()];
}

function isRowInShopScope(row = {}, allowedShopIds = []) {
  if (!allowedShopIds.length) return true;
  const allowed = new Set(allowedShopIds.map(normalizedIdentity));
  const directIdentities = rowShopIds(row).map(normalizedIdentity);
  if (directIdentities.length) return directIdentities.some((id) => allowed.has(id));
  const identities = effectiveRowShopIds(row).map(normalizedIdentity);
  if (identities.some((id) => allowed.has(id))) return true;
  const snapshotText = normalizedIdentity(row.__snapshot?.snapshotKey);
  return [...allowed].some((id) => id && snapshotText.includes(id));
}

function readProductRecord(db, productIds = [], allowedShopIds = []) {
  if (!productIds.length || !tableExists(db, 'ozon_products')) return null;
  const ids = [...new Set(productIds.map(normalizedIdentity).filter(Boolean))];
  const shopIds = [...new Set(allowedShopIds.map(normalizeText).filter(Boolean))];
  const productPlaceholders = ids.map(() => '?').join(', ');
  const shopClause = shopIds.length ? ` AND shop_id IN (${shopIds.map(() => '?').join(', ')})` : '';
  const rows = db
    .prepare(`
      SELECT
        shop_id, product_id, offer_id, sku, name, visibility, status_label,
        category_id, category_name, type_id, price_value, currency_code,
        stock_value, updated_at, detail_synced_at, prices_synced_at, stocks_synced_at
      FROM ozon_products
      WHERE (
        LOWER(COALESCE(CAST(product_id AS TEXT), '')) IN (${productPlaceholders})
        OR LOWER(COALESCE(CAST(offer_id AS TEXT), '')) IN (${productPlaceholders})
        OR LOWER(COALESCE(CAST(sku AS TEXT), '')) IN (${productPlaceholders})
      )${shopClause}
      ORDER BY COALESCE(detail_synced_at, prices_synced_at, stocks_synced_at, updated_at) DESC
      LIMIT 1
    `)
    .all(...ids, ...ids, ...ids, ...shopIds);
  return rows[0] || null;
}

export function createProfitOrderReviewReadModel(db) {
  if (!db) throw new Error('createProfitOrderReviewReadModel requires a DatabaseSync instance.');

  return {
    read(query = {}) {
      const orderNumber = normalizeText(
        query.orderNumber ?? query.order_number ?? query.postingNumber ?? query.posting_number
      );
      if (!orderNumber) {
        return {
          ok: false,
          error: { code: 'PROFIT_REVIEW_ORDER_NUMBER_REQUIRED', message: '请输入订单号。' },
        };
      }
      const allowedShopIds = normalizeList(query.shopIds ?? query.shop_ids ?? query.shopId ?? query.shop_id);
      const scopedRows = readLedgerRows(db).filter((row) => isRowInShopScope(row, allowedShopIds));
      const wanted = normalizedIdentity(orderNumber);
      const wantedBase = postingBaseIdentity(orderNumber);
      const exactMatches = scopedRows.filter((row) => rowOrderIdentities(row).includes(wanted));
      const baseMatches = exactMatches.length || !wantedBase
        ? []
        : scopedRows.filter((row) => rowOrderIdentities(row).some((identity) => (
            identity === wantedBase || postingBaseIdentity(identity) === wantedBase
          )));
      const matches = exactMatches.length ? exactMatches : baseMatches;
      if (!matches.length) {
        return {
          ok: true,
          found: false,
          orderNumber,
          searchedRows: scopedRows.length,
          message: scopedRows.length
            ? '利润账本中没有找到这个订单号。请先在利润核算页刷新一次订单和财务数据。'
            : '本机还没有利润账本数据。请先在利润核算页完成一次数据刷新。',
        };
      }
      const selected = [...matches].sort((left, right) => (
        rowDate(right).localeCompare(rowDate(left))
        || normalizeText(right.__snapshot?.updatedAt).localeCompare(normalizeText(left.__snapshot?.updatedAt))
      ))[0];
      const selectedShopIds = effectiveRowShopIds(selected).map(normalizedIdentity);
      const productIds = rowProductIdentities(selected);
      const relatedLedgerRows = scopedRows
        .filter((row) => {
          const rowShops = effectiveRowShopIds(row).map(normalizedIdentity);
          const sameShop = !selectedShopIds.length || rowShops.some((id) => selectedShopIds.includes(id));
          return sameShop && rowProductIdentities(row).some((id) => productIds.includes(id));
        })
        .sort((left, right) => rowDate(right).localeCompare(rowDate(left)))
        .slice(0, 200);
      const product = readProductRecord(db, productIds, allowedShopIds);
      const cleanRow = ({ __snapshot, ...row }) => row;
      return {
        ok: true,
        found: true,
        orderNumber,
        matchType: exactMatches.length ? 'exact' : 'posting-base',
        matchCount: matches.length,
        ledgerRow: cleanRow(selected),
        relatedLedgerRows: relatedLedgerRows.map(cleanRow),
        product,
        source: {
          type: 'profit-ledger-sqlite',
          snapshotUpdatedAt: selected.__snapshot?.updatedAt || '',
          relatedOrderCount: relatedLedgerRows.length,
        },
      };
    },
  };
}
