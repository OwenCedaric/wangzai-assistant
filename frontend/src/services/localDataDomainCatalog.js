export const LOCAL_DATA_DOMAIN_CATALOG_VERSION = 'local-data-domain-catalog-v1';

export const LOCAL_DATA_SHARED_ENTITY_RULES = Object.freeze({
  shop: {
    ownerDomainId: 'shops',
    keyFields: ['clientId', 'shopId'],
    description: 'One shop binding is reused by every page through clientId first, shopId second.',
  },
  product: {
    ownerDomainId: 'products',
    keyFields: ['clientId', 'offerId', 'sku', 'productId'],
    description: 'One Ozon product record is reused by product list, sales orders, purchase orders, after-sales, and profit.',
  },
  productImage: {
    ownerDomainId: 'productImages',
    keyFields: ['url'],
    description: 'Images are stored once by original URL. Pages keep only image URL references.',
  },
  salesOrder: {
    ownerDomainId: 'salesOrders',
    keyFields: ['clientId', 'postingNumber', 'orderNumber'],
    description: 'One sales order is reused by order management, purchase management, after-sales, and profit.',
  },
  orderProduct: {
    ownerDomainId: 'orderProducts',
    keyFields: ['clientId', 'postingNumber', 'offerId', 'sku', 'rowIndex'],
    description: 'Order item rows link orders and products without copying full product payloads.',
  },
  purchaseOrder: {
    ownerDomainId: 'purchase',
    keyFields: ['clientId', 'postingNumber', 'purchaseOrderNumber', 'busOrderId'],
    description: 'Purchase and fulfillment data belongs to purchase management and is referenced by profit.',
  },
  crossBorderBusOrder: {
    ownerDomainId: 'crossBorderBus',
    keyFields: ['clientId', 'busOrderId', 'postingNumber', 'purchaseOrderNumber'],
    description: 'Cross-border bus records are stored once and reused by purchase management and profit.',
  },
  afterSalesCase: {
    ownerDomainId: 'afterSales',
    keyFields: ['clientId', 'returnId', 'afterSalesId', 'postingNumber'],
    description: 'One after-sales case is reused by after-sales pages and profit loss calculation.',
  },
  financeTransaction: {
    ownerDomainId: 'finance',
    keyFields: ['clientId', 'postingNumber', 'transactionId', 'operationId'],
    description: 'Finance transactions are raw Ozon financial facts reused by profit and after-sales evidence.',
  },
  profitLedger: {
    ownerDomainId: 'profit',
    keyFields: ['clientId', 'postingNumber'],
    description: 'Profit ledger rows are calculated records that reference orders, products, purchase, after-sales, and finance.',
  },
  retryTask: {
    ownerDomainId: 'retry',
    keyFields: ['source', 'entityType', 'entityKey'],
    description: 'Each failed read is retried by one isolated entity key without blocking the whole page.',
  },
});

export const LOCAL_DATA_DOMAIN_CATALOG = Object.freeze([
  {
    id: 'index',
    label: 'Index and manifest',
    directory: '分类缓存/00-索引',
    ownsEntityTypes: ['domainCatalog', 'entityReuseMap'],
    legacySources: [],
  },
  {
    id: 'shops',
    label: 'Shop settings',
    directory: '分类缓存/01-店铺设置',
    ownsEntityTypes: ['shop'],
    legacySources: ['settings/browser-local-storage.json'],
  },
  {
    id: 'systemSettings',
    label: 'System settings',
    directory: '分类缓存/02-系统设置',
    ownsEntityTypes: [
      'feeSettings',
      'browserSettings',
      'uiSettings',
      'watermarkSettings',
      'promptLibrary',
      'purchasePluginContext',
    ],
    legacySources: ['settings/browser-local-storage.json'],
  },
  {
    id: 'products',
    label: 'Product master data',
    directory: '分类缓存/03-商品信息',
    ownsEntityTypes: ['product'],
    legacySources: ['商品资料/ozon-local-data-layer.json', '商品资料/product-material-profiles.json'],
  },
  {
    id: 'productImages',
    label: 'Product image URL index',
    directory: '分类缓存/04-商品图片',
    ownsEntityTypes: ['productImage'],
    legacySources: ['商品资料/ozon-local-data-layer.json'],
  },
  {
    id: 'salesOrders',
    label: 'Sales orders',
    directory: '分类缓存/05-销售订单',
    ownsEntityTypes: ['salesOrder'],
    legacySources: ['商品资料/ozon-local-data-layer.json', '分类缓存/05-销售订单/sales-source-links.json'],
  },
  {
    id: 'orderProducts',
    label: 'Order product links',
    directory: '分类缓存/06-订单商品',
    ownsEntityTypes: ['orderProduct'],
    legacySources: ['商品资料/ozon-local-data-layer.json'],
  },
  {
    id: 'purchase',
    label: 'Purchase management',
    directory: '分类缓存/07-拍单采购',
    ownsEntityTypes: ['purchaseOrder', 'purchaseSource', 'purchaseOverride'],
    legacySources: [
      '商品资料/product-source-links.json',
      '分类缓存/07-拍单采购/purchase-source-links.json',
      '分类缓存/07-拍单采购/purchase-source-plugin-context.json',
      '商品资料/purchase-order-local-overrides.json',
      'settings/browser-local-storage.json',
    ],
  },
  {
    id: 'crossBorderBus',
    label: 'Cross-border bus',
    directory: '分类缓存/08-跨境巴士',
    ownsEntityTypes: ['crossBorderBusOrder', 'crossBorderBusSettings'],
    legacySources: ['商品资料/cross-border-bus-order-records.json'],
  },
  {
    id: 'afterSales',
    label: 'After-sales orders',
    directory: '分类缓存/09-售后订单',
    ownsEntityTypes: ['afterSalesCase', 'refundCase', 'afterSalesEvidence'],
    legacySources: ['商品资料/ozon-local-data-layer.json'],
  },
  {
    id: 'profit',
    label: 'Profit ledger',
    directory: '分类缓存/10-利润核算',
    ownsEntityTypes: ['profitLedger', 'profitSnapshot', 'manualProfitOverride'],
    legacySources: ['商品资料/ozon-local-data-layer.json'],
  },
  {
    id: 'finance',
    label: 'Finance transactions',
    directory: '分类缓存/11-财务流水',
    ownsEntityTypes: ['financeTransaction', 'refundTransaction', 'feeTransaction'],
    legacySources: ['商品资料/ozon-local-data-layer.json'],
  },
  {
    id: 'marketing',
    label: 'Marketing activity cache',
    directory: '分类缓存/12-营销活动',
    ownsEntityTypes: ['marketingActivity'],
    legacySources: ['settings/browser-local-storage.json'],
  },
  {
    id: 'browserMirror',
    label: 'Browser storage mirror',
    directory: '分类缓存/13-浏览器镜像',
    ownsEntityTypes: ['browserLocalStorageSnapshot'],
    legacySources: ['settings/browser-local-storage.json'],
  },
  {
    id: 'retry',
    label: 'Failure and retry queue',
    directory: '分类缓存/14-失败重试',
    ownsEntityTypes: ['retryTask', 'failureRecord', 'readDiagnostic'],
    legacySources: [
      '商品资料/ozon-local-data-layer.json',
      '分类缓存/14-失败重试/local-mirror-read-log.json',
      '分类缓存/14-失败重试/local-mirror-retry-queue.json',
    ],
  },
  {
    id: 'shared',
    label: 'Shared entity links',
    directory: '分类缓存/15-共享实体',
    ownsEntityTypes: ['entityLink', 'searchIndex', 'referenceIndex'],
    legacySources: ['商品资料/ozon-local-data-layer.json'],
  },
  {
    id: 'rules',
    label: 'Rules and formula index',
    directory: '分类缓存/16-规则函数索引',
    ownsEntityTypes: ['formulaRule', 'businessRule', 'functionMap'],
    legacySources: ['需求文档', 'frontend/src/services'],
  },
]);

const DOMAIN_BY_ID = new Map(LOCAL_DATA_DOMAIN_CATALOG.map((domain) => [domain.id, domain]));
const ENTITY_OWNER_BY_TYPE = new Map(
  Object.entries(LOCAL_DATA_SHARED_ENTITY_RULES).map(([entityType, rule]) => [entityType, rule.ownerDomainId])
);

function compactKeyParts(parts) {
  return parts
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(':');
}

const ENTITY_KEY_BUILDERS = Object.freeze({
  shop: ({ clientId, shopId }) => compactKeyParts(['shop', clientId ? `client-${clientId}` : '', shopId ? `id-${shopId}` : '']),
  product: ({ clientId, offerId, sku, productId }) =>
    compactKeyParts(['product', clientId ? `client-${clientId}` : '', offerId || sku || productId]),
  productImage: ({ url }) => compactKeyParts(['image-url', url]),
  salesOrder: ({ clientId, postingNumber, orderNumber }) =>
    compactKeyParts(['sales-order', clientId ? `client-${clientId}` : '', postingNumber || orderNumber]),
  orderProduct: ({ clientId, postingNumber, offerId, sku, rowIndex = 0 }) =>
    compactKeyParts(['order-product', clientId ? `client-${clientId}` : '', postingNumber, offerId || sku, rowIndex]),
  purchaseOrder: ({ clientId, postingNumber, purchaseOrderNumber, busOrderId }) =>
    compactKeyParts(['purchase-order', clientId ? `client-${clientId}` : '', postingNumber, purchaseOrderNumber || busOrderId]),
  crossBorderBusOrder: ({ clientId, busOrderId, postingNumber, purchaseOrderNumber }) =>
    compactKeyParts(['bus-order', clientId ? `client-${clientId}` : '', busOrderId || purchaseOrderNumber || postingNumber]),
  afterSalesCase: ({ clientId, returnId, afterSalesId, postingNumber }) =>
    compactKeyParts(['after-sales', clientId ? `client-${clientId}` : '', returnId || afterSalesId || postingNumber]),
  financeTransaction: ({ clientId, postingNumber, transactionId, operationId }) =>
    compactKeyParts(['finance', clientId ? `client-${clientId}` : '', transactionId || operationId || postingNumber]),
  profitLedger: ({ clientId, postingNumber }) =>
    compactKeyParts(['profit-ledger', clientId ? `client-${clientId}` : '', postingNumber]),
  retryTask: ({ source, entityType, entityKey }) => compactKeyParts(['retry', source, entityType, entityKey]),
});

export function getLocalDataDomainCatalog() {
  return LOCAL_DATA_DOMAIN_CATALOG.map((domain) => ({ ...domain, ownsEntityTypes: [...domain.ownsEntityTypes] }));
}

export function findLocalDataDomain(domainId) {
  return DOMAIN_BY_ID.get(domainId) || null;
}

export function getLocalDataDomainDirectory(domainId) {
  return findLocalDataDomain(domainId)?.directory || '';
}

export function getDomainsByEntityType(entityType) {
  return LOCAL_DATA_DOMAIN_CATALOG.filter((domain) => domain.ownsEntityTypes.includes(entityType));
}

export function getReusableEntityOwner(entityType) {
  const ownerDomainId = ENTITY_OWNER_BY_TYPE.get(entityType);
  return ownerDomainId ? findLocalDataDomain(ownerDomainId) : null;
}

export function buildReusableEntityKey(entityType, parts = {}) {
  const builder = ENTITY_KEY_BUILDERS[entityType];
  if (!builder) return compactKeyParts([entityType, parts.id || parts.key]);
  return builder(parts);
}
