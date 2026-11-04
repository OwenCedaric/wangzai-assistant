import { productStatusTabs } from './productStatusRules.jsx';

const PRODUCT_MATERIAL_SOURCE_ALIASES = new Map([
  ['cross-border-bus', 'cross-border'],
  ['cross-border', 'cross-border'],
  ['supplier-confirmed', 'supplier'],
  ['supplier', 'supplier'],
  ['ozon-initial-read', 'ozon-initial'],
  ['ozon-initial', 'ozon-initial'],
  ['missing', 'missing'],
]);
const PRODUCT_WAREHOUSE_FILTERS = new Set(['returned', 'default', 'missing', 'multi']);
const PRODUCT_STOCK_FILTERS = new Set(['zero', 'positive', 'missing', 'multi']);
const PRODUCT_SOURCE_STATUSES = new Set(['saved', 'missing', 'pdd', '1688', 'taobao']);
const PRODUCT_STATUSES = new Set(productStatusTabs.map((tab) => tab.label).filter((label) => label !== '全部商品'));

function normalizeAllowedValues(value, allowed) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((item) => String(item ?? '').trim())
    .filter((item, index, values) => item && item !== 'all' && allowed.has(item) && values.indexOf(item) === index)
    .sort((left, right) => left.localeCompare(right));
}

function normalizeMaterialSources(value) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((item) => PRODUCT_MATERIAL_SOURCE_ALIASES.get(String(item ?? '').trim()) || '')
    .filter((item, index, values) => item && values.indexOf(item) === index)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * The product list has one typed filter contract from Model to SQLite.  Values
 * outside the UI vocabulary are discarded here and rejected again by local-api;
 * renderer code never builds SQL fragments.
 */
export function normalizeProductListQueryFilters(filters = {}) {
  return {
    materialSources: normalizeMaterialSources(filters.materialSources),
    warehouseFilters: normalizeAllowedValues(filters.warehouseFilters, PRODUCT_WAREHOUSE_FILTERS),
    defaultWarehouseId: String(filters.defaultWarehouseId || '').trim(),
    stockFilters: normalizeAllowedValues(filters.stockFilters, PRODUCT_STOCK_FILTERS),
    productStatuses: normalizeAllowedValues(filters.productStatuses, PRODUCT_STATUSES),
    sourceStatuses: normalizeAllowedValues(filters.sourceStatuses, PRODUCT_SOURCE_STATUSES),
  };
}

export function createProductListQueryFilters({
  selectedMaterialSourceFilters = [],
  selectedWarehouseFilters = [],
  productDefaultWarehouseId = '',
  selectedStockFilters = [],
  selectedProductStatusFilters = [],
  selectedSourceStatusFilters = [],
} = {}) {
  return normalizeProductListQueryFilters({
    materialSources: selectedMaterialSourceFilters,
    warehouseFilters: selectedWarehouseFilters,
    defaultWarehouseId: productDefaultWarehouseId,
    stockFilters: selectedStockFilters,
    productStatuses: selectedProductStatusFilters,
    sourceStatuses: selectedSourceStatusFilters,
  });
}

export function getProductListQueryFilterSignature(filters = {}) {
  const normalized = normalizeProductListQueryFilters(filters);
  return JSON.stringify([
    normalized.materialSources,
    normalized.warehouseFilters,
    normalized.defaultWarehouseId,
    normalized.stockFilters,
    normalized.productStatuses,
    normalized.sourceStatuses,
  ]);
}

export function hasProductListQueryFilters(filters = {}) {
  const normalized = normalizeProductListQueryFilters(filters);
  return Boolean(
    normalized.materialSources.length ||
      normalized.warehouseFilters.length ||
      normalized.stockFilters.length ||
      normalized.productStatuses.length ||
      normalized.sourceStatuses.length
  );
}
