let readLocalApiProductPageAdapter = async () => null;
let recordLocalMirrorRetryTaskAdapter = async () => undefined;
let productStatusTabsAdapter = [{ label: '全部商品', visibility: 'ALL' }];
let mapProductCacheCountsToStatusLabelsAdapter = (counts) => counts || null;
let createEmptyProductStatusCountsAdapter = () => ({ '全部商品': 0 });
let hasProductStatusCountValuesAdapter = (counts) =>
  Boolean(counts && typeof counts === 'object' && Object.values(counts).some((value) => Number(value) > 0));
let getProductRowShopScopeKeyAdapter = (product = {}) =>
  String(product.shopId || product.shopClientId || product.localShopKey || product.shop || product.shopName || 'default');
let getProductRowCacheKeyAdapter = (product = {}) =>
  String(product.productId || product.offerId || product.sku || product.ozonSku || product.id || '');
let getShopEntityKeyAdapter = (shop = {}) => String(shop?.id || shop?.clientId || shop?.name || 'unknown');

const PRODUCT_MIRROR_FALLBACK_PAGE_SIZE = 1000;
const PRODUCT_MIRROR_FALLBACK_MAX_PAGES = 20;

export function configureProductSearchFallbackService({
  readLocalApiProductPage,
  recordLocalMirrorRetryTask,
  productStatusTabs,
  mapProductCacheCountsToStatusLabels,
  createEmptyProductStatusCounts,
  hasProductStatusCountValues,
  getProductRowShopScopeKey,
  getProductRowCacheKey,
  getShopEntityKey,
} = {}) {
  if (typeof readLocalApiProductPage === 'function') readLocalApiProductPageAdapter = readLocalApiProductPage;
  if (typeof recordLocalMirrorRetryTask === 'function') recordLocalMirrorRetryTaskAdapter = recordLocalMirrorRetryTask;
  if (Array.isArray(productStatusTabs) && productStatusTabs.length) productStatusTabsAdapter = productStatusTabs;
  if (typeof mapProductCacheCountsToStatusLabels === 'function') {
    mapProductCacheCountsToStatusLabelsAdapter = mapProductCacheCountsToStatusLabels;
  }
  if (typeof createEmptyProductStatusCounts === 'function') createEmptyProductStatusCountsAdapter = createEmptyProductStatusCounts;
  if (typeof hasProductStatusCountValues === 'function') hasProductStatusCountValuesAdapter = hasProductStatusCountValues;
  if (typeof getProductRowShopScopeKey === 'function') getProductRowShopScopeKeyAdapter = getProductRowShopScopeKey;
  if (typeof getProductRowCacheKey === 'function') getProductRowCacheKeyAdapter = getProductRowCacheKey;
  if (typeof getShopEntityKey === 'function') getShopEntityKeyAdapter = getShopEntityKey;
}

export function resetProductSearchFallbackServiceForTest() {
  readLocalApiProductPageAdapter = async () => null;
  recordLocalMirrorRetryTaskAdapter = async () => undefined;
  productStatusTabsAdapter = [{ label: '全部商品', visibility: 'ALL' }];
  mapProductCacheCountsToStatusLabelsAdapter = (counts) => counts || null;
  createEmptyProductStatusCountsAdapter = () => ({ '全部商品': 0 });
  hasProductStatusCountValuesAdapter = (counts) =>
    Boolean(counts && typeof counts === 'object' && Object.values(counts).some((value) => Number(value) > 0));
  getProductRowShopScopeKeyAdapter = (product = {}) =>
    String(product.shopId || product.shopClientId || product.localShopKey || product.shop || product.shopName || 'default');
  getProductRowCacheKeyAdapter = (product = {}) =>
    String(product.productId || product.offerId || product.sku || product.ozonSku || product.id || '');
  getShopEntityKeyAdapter = (shop = {}) => String(shop?.id || shop?.clientId || shop?.name || 'unknown');
}

export function getProductSearchIdentityKeys(product = {}) {
  const scopeKey = getProductRowShopScopeKeyAdapter(product);
  return [
    getProductRowCacheKeyAdapter(product),
    product.productId,
    product.offerId,
    product.sku,
    product.ozonSku,
    product.raw?.listItem?.product_id,
    product.raw?.listItem?.offer_id,
    product.raw?.entity?.localProductKey,
  ]
    .map((value) => String(value ?? '').trim())
    .filter((value, index, list) => value && value !== '未返回' && list.indexOf(value) === index)
    .map((value) => `${scopeKey}:${value}`);
}

export function replaceProductSearchResultRow(rows = [], product = {}) {
  const nextProduct = product ? { ...product, localSearchResult: product.localSearchResult ?? true } : product;
  const targetKeys = new Set(getProductSearchIdentityKeys(nextProduct));
  if (!targetKeys.size) return Array.isArray(rows) ? rows : [];
  let replaced = false;
  const nextRows = (Array.isArray(rows) ? rows : []).map((row) => {
    if (getProductSearchIdentityKeys(row).some((key) => targetKeys.has(key))) {
      replaced = true;
      return nextProduct;
    }
    return row;
  });
  return replaced ? nextRows : [nextProduct, ...nextRows];
}

export function mergeProductSearchMirrorRows(rows = [], mirrorRows = []) {
  const baseRows = Array.isArray(rows) ? rows : [];
  const seenKeys = new Set(baseRows.flatMap(getProductSearchIdentityKeys));
  const additions = [];
  for (const row of Array.isArray(mirrorRows) ? mirrorRows : []) {
    const keys = getProductSearchIdentityKeys(row);
    if (!keys.length || keys.some((key) => seenKeys.has(key))) continue;
    keys.forEach((key) => seenKeys.add(key));
    additions.push(row);
  }
  return additions.length ? [...additions, ...baseRows] : baseRows;
}

async function readLocalProductMirrorPages(shop, tab, options = {}) {
  const pageSize = Math.max(1, Math.min(Number(options.pageSize) || PRODUCT_MIRROR_FALLBACK_PAGE_SIZE, 1000));
  const maxPages = Math.max(1, Math.min(Number(options.maxPages) || PRODUCT_MIRROR_FALLBACK_MAX_PAGES, 50));
  const baseOptions = {
    pageSize,
    keyword: options.keyword,
    sort: options.sort || 'stable',
    timeoutMs: options.timeoutMs || 3500,
    observe: options.observe,
  };
  const firstPage = await readLocalApiProductPageAdapter(shop, tab, {
    ...baseOptions,
    page: 1,
  });
  if (!firstPage || typeof firstPage !== 'object') return null;
  const rows = Array.isArray(firstPage?.rows) ? [...firstPage.rows] : [];
  const total = Number(firstPage?.total) || rows.length;
  const totalPages = total > rows.length ? Math.min(Math.ceil(total / pageSize), maxPages) : 1;
  let missingPage = false;
  if (totalPages > 1) {
    const restPages = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, index) =>
        readLocalApiProductPageAdapter(shop, tab, {
          ...baseOptions,
          page: index + 2,
        }).catch(() => null)
      )
    );
    restPages.forEach((page) => {
      if (Array.isArray(page?.rows)) {
        rows.push(...page.rows);
        return;
      }
      missingPage = true;
    });
  }
  const expectedTotalPages = total > 0 ? Math.ceil(total / pageSize) : 1;
  const incomplete = missingPage || totalPages < expectedTotalPages || rows.length < total;
  return {
    ...firstPage,
    rows,
    total,
    pageSize,
    page: 1,
    incomplete,
  };
}

export async function readLocalProductMirrorRowsForShops(shops = [], options = {}) {
  const scopedShops = (Array.isArray(shops) ? shops : [shops]).filter(Boolean);
  if (!scopedShops.length) return [];
  const targetTabs = options.includeAllVisibilities
    ? productStatusTabsAdapter
    : [productStatusTabsAdapter.find((tab) => tab.label === options.statusLabel) ?? productStatusTabsAdapter[0]];
  const pages = await Promise.all(
    scopedShops.flatMap((shop) =>
      targetTabs.map((tab) =>
        readLocalProductMirrorPages(shop, tab, {
          pageSize: options.pageSize || PRODUCT_MIRROR_FALLBACK_PAGE_SIZE,
          maxPages: options.maxPages || PRODUCT_MIRROR_FALLBACK_MAX_PAGES,
          keyword: options.keyword,
          sort: options.sort || 'stable',
          timeoutMs: options.timeoutMs || 3500,
          observe: options.observe,
        }).catch(() => null)
      )
    )
  );
  const hasMissingPage = !pages.some(Boolean) || pages.some((page) => !page || page.incomplete);
  if (hasMissingPage) {
    recordLocalMirrorRetryTaskAdapter({
      domain: '03_products',
      source: 'local-api-cache',
      entityType: 'productMirror',
      entityKey: scopedShops.map(getShopEntityKeyAdapter).join('|'),
      fileKey: options.fileKey || 'ozon-local-data-layer',
      reason: '商品列表 local-api SQLite 缓存分页缺失或未返回可用结果',
    }).catch(() => undefined);
  }
  return mergeProductSearchMirrorRows([], pages.flatMap((page) => (Array.isArray(page?.rows) ? page.rows : [])));
}

export async function readLocalProductMirrorStatusCountsForShops(shops = [], options = {}) {
  const scopedShops = (Array.isArray(shops) ? shops : [shops]).filter(Boolean);
  if (!scopedShops.length) return null;
  const localApiPages = await Promise.all(
    scopedShops
      .filter((shop) => shop?.id)
      .map((shop) =>
        readLocalApiProductPageAdapter(shop, productStatusTabsAdapter[0], {
          pageSize: 1,
          page: 1,
          timeoutMs: 3500,
          observe: options.observe,
        }).catch(() => null)
      )
  );
  const counts = createEmptyProductStatusCountsAdapter();
  let hasCounts = false;
  localApiPages.forEach((page) => {
    const shopCounts = mapProductCacheCountsToStatusLabelsAdapter(page?.counts);
    if (!hasProductStatusCountValuesAdapter(shopCounts)) return;
    hasCounts = true;
    productStatusTabsAdapter.forEach((tab) => {
      counts[tab.label] += Number(shopCounts[tab.label]) || 0;
    });
  });
  if (!hasCounts) return null;
  return counts;
}

export async function readLocalProductSearchMirrorRows(shops = [], keyword = '') {
  const query = String(keyword || '').trim();
  if (!query) return [];
  const scopedShops = (Array.isArray(shops) ? shops : [shops]).filter(Boolean);
  if (!scopedShops.length) return [];
  return readLocalProductMirrorRowsForShops(scopedShops, {
    includeAllVisibilities: true,
    keyword: query,
    timeoutMs: 3500,
    observe: false,
  });
}
