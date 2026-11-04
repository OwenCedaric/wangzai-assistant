import { getProductSourceRecordFromLinks, getSourceRecordSlots } from '../order/orderSourceLinks.jsx';
import { toFiniteNumber } from './productAttributes.jsx';

export const PRODUCT_ADVANCED_FILTER_DEFAULTS = {
  materialSource: [],
  warehouse: [],
  stock: [],
  productStatus: [],
  sourceStatus: [],
};

export function createProductAdvancedFilterDefaults() {
  return Object.fromEntries(Object.keys(PRODUCT_ADVANCED_FILTER_DEFAULTS).map((key) => [key, []]));
}

export function normalizeProductAdvancedFilterValues(value) {
  const values = Array.isArray(value) ? value : value && value !== 'all' ? [value] : [];
  return values
    .map((item) => String(item ?? '').trim())
    .filter((item, index, list) => item && item !== 'all' && list.indexOf(item) === index);
}

export function isProductAdvancedFilterDefault(filters = PRODUCT_ADVANCED_FILTER_DEFAULTS) {
  return Object.keys(PRODUCT_ADVANCED_FILTER_DEFAULTS).every(
    (key) => normalizeProductAdvancedFilterValues(filters[key]).length === 0
  );
}

export function getProductSourceRecordForShop(product = {}, shop = {}, sourceLinks = {}) {
  return getProductSourceRecordFromLinks(sourceLinks, product, shop);
}

export function getProductSourceRecordText(record = {}) {
  return getSourceRecordSlots(record)
    .map((entry) => [entry?.platform, entry?.link, entry?.productId].filter(Boolean).join(' '))
    .join(' ')
    .toLowerCase();
}

export function hasProductSavedSource(record = {}) {
  return getSourceRecordSlots(record).some((entry) => String(entry?.link || '').trim());
}

export function productMatchesSourceFilter(record = {}, filterValue = 'all') {
  if (filterValue === 'all') return true;
  const hasSaved = hasProductSavedSource(record);
  if (filterValue === 'saved') return hasSaved;
  if (filterValue === 'missing') return !hasSaved;
  const text = getProductSourceRecordText(record);
  if (filterValue === 'pdd') return /拼多多|pinduoduo|yangkeduo|pdd/i.test(text);
  if (filterValue === '1688') return /1688/i.test(text);
  if (filterValue === 'taobao') return /淘宝|天猫|taobao|tmall/i.test(text);
  return true;
}

export function getProductWarehouseIds(product = {}) {
  const values = [...(Array.isArray(product?.warehouseIds) ? product.warehouseIds : []), product?.warehouseId];
  return values
    .map((value) => String(value ?? '').trim())
    .filter((value, index, list) => value && value !== '未返回' && list.indexOf(value) === index);
}

export function productMatchesWarehouseFilter(product = {}, filterValue = 'all', defaultWarehouseId = '') {
  if (filterValue === 'all') return true;
  const warehouseIds = getProductWarehouseIds(product);
  const hasWarehouse = warehouseIds.length > 0;
  const safeDefaultWarehouseId = String(defaultWarehouseId || '').trim();
  if (filterValue === 'returned') return hasWarehouse;
  if (filterValue === 'missing') return !hasWarehouse;
  if (filterValue === 'multi') return warehouseIds.length > 1;
  if (filterValue === 'default') {
    return Boolean(safeDefaultWarehouseId) && (!hasWarehouse || warehouseIds.includes(safeDefaultWarehouseId));
  }
  return true;
}

export function productMatchesStockFilter(product = {}, filterValue = 'all', options = {}) {
  if (filterValue === 'all') return true;
  const stock = toFiniteNumber(product?.stock);
  const keepPendingStockRow =
    options.includePendingStock === true &&
    product?.liveHydrated === false &&
    ['zero', 'positive', 'missing'].includes(filterValue);
  if (keepPendingStockRow) return true;
  if (filterValue === 'zero') return stock === 0;
  if (filterValue === 'positive') return stock !== null && stock > 0;
  if (filterValue === 'missing') return stock === null;
  if (filterValue === 'multi') return getProductWarehouseIds(product).length > 1;
  return true;
}
