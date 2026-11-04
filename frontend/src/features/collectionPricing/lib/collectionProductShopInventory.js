function cleanText(value, maximum = 180) {
  return String(value ?? '').replace(/\p{Cc}/gu, '').trim().slice(0, maximum);
}

function normalizeStock(value) {
  if (value === null || value === undefined || String(value).trim() === '') return '';
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? String(number) : '';
}

export function normalizeCollectionShopInventory(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    warehouseId: cleanText(source.warehouseId),
    stock: normalizeStock(source.stock),
  };
}

export function normalizeCollectionSkuInventoryByShop(value = {}, legacy = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = Object.fromEntries(Object.entries(source).flatMap(([shopId, inventory]) => {
    const normalizedShopId = cleanText(shopId);
    if (!normalizedShopId) return [];
    const row = normalizeCollectionShopInventory(inventory);
    if (!row.stock && !row.warehouseId) return [];
    return [[normalizedShopId, row]];
  }));
  const legacyShopId = cleanText(legacy.shopId);
  const legacyInventory = normalizeCollectionShopInventory(legacy);
  if (legacyShopId && !normalized[legacyShopId] && (legacyInventory.stock || legacyInventory.warehouseId)) {
    normalized[legacyShopId] = legacyInventory;
  }
  return normalized;
}

export function getCollectionSkuShopInventory(sku = {}, shopId = '') {
  const normalizedShopId = cleanText(shopId);
  const inventoryByShopId = normalizeCollectionSkuInventoryByShop(sku.inventoryByShopId);
  if (normalizedShopId && inventoryByShopId[normalizedShopId]) {
    return inventoryByShopId[normalizedShopId];
  }
  return { warehouseId: '', stock: '' };
}

export function setCollectionSkuShopInventories(sku = {}, inventoryByShopId = {}) {
  return normalizeCollectionSkuInventoryByShop({
    ...normalizeCollectionSkuInventoryByShop(sku.inventoryByShopId),
    ...(inventoryByShopId && typeof inventoryByShopId === 'object' ? inventoryByShopId : {}),
  });
}

export function sharedCollectionSkuShopInventory(skus = [], shopId = '') {
  const enabled = (Array.isArray(skus) ? skus : []).filter((sku) => sku?.enabled !== false);
  const rows = enabled.map((sku) => getCollectionSkuShopInventory(sku, shopId));
  const stocks = [...new Set(rows.map((row) => row.stock).filter((value) => value !== ''))];
  const warehouseIds = [...new Set(rows.map((row) => row.warehouseId).filter(Boolean))];
  return {
    stock: stocks.length === 1 ? stocks[0] : '',
    warehouseId: warehouseIds.length === 1 ? warehouseIds[0] : '',
  };
}
