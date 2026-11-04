import { readSalesOrderProductSummaryEntities } from './salesOrderProductSummaryService';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function uniqueValues(values = []) {
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
}

function normalizeSourceRecord(row = {}) {
  const record = row.sourceRecord && typeof row.sourceRecord === 'object' ? row.sourceRecord : {};
  const recordLinks = Array.isArray(record.links) ? record.links.filter(Boolean) : [];
  const sourceLinks = Array.isArray(row.sourceLinks) ? row.sourceLinks.filter(Boolean) : [];
  const links = recordLinks.length ? recordLinks : sourceLinks;
  return links.length
    ? {
        links,
        primaryIndex: Math.max(0, Number(record.primaryIndex) || 0),
        updatedAt: row.updatedAt || row.summaryUpdatedAt || '',
      }
    : null;
}

function getShopKeysForSummaryRow(row = {}, shops = []) {
  const rowShopId = normalizeText(row.shopId || row.shop_id);
  const matchedShop = (Array.isArray(shops) ? shops : []).find((shop) =>
    uniqueValues([shop.id, shop.shopId, shop.shop_id]).includes(rowShopId)
  );
  return uniqueValues([
    rowShopId,
    matchedShop?.id,
    matchedShop?.shopId,
    matchedShop?.clientId,
    matchedShop?.client_id,
    matchedShop?.shopAlias,
    matchedShop?.alias,
    matchedShop?.sellerName,
    matchedShop?.name,
    'default',
  ]);
}

function getProductKeysForSummaryRow(row = {}) {
  return uniqueValues([row.offerId, row.offer_id, row.sku, row.productId, row.product_id]);
}

export function buildProfitProductSummarySourceLinks(summaryRows = [], shops = []) {
  const map = {};
  (Array.isArray(summaryRows) ? summaryRows : []).forEach((row) => {
    const sourceRecord = normalizeSourceRecord(row);
    if (!sourceRecord) return;
    const productKeys = getProductKeysForSummaryRow(row);
    const shopKeys = getShopKeysForSummaryRow(row, shops);
    productKeys.forEach((productKey) => {
      if (!map[productKey]) map[productKey] = sourceRecord;
      shopKeys.forEach((shopKey) => {
        const key = `${shopKey}:${productKey}`;
        if (!map[key]) map[key] = sourceRecord;
      });
    });
  });
  return map;
}

export async function readProfitProductSummarySupport(rows = [], shops = [], options = {}) {
  const summary = await readSalesOrderProductSummaryEntities(rows, shops, {
    ...options,
    enableSkuFallback: true,
  });
  return {
    ...summary,
    productSourceLinks: buildProfitProductSummarySourceLinks(summary.fetchedRows, shops),
  };
}
