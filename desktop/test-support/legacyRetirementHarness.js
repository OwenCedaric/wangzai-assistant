import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LEGACY_RETIREMENT_MAX_PROFILE_REQUEST_BYTES = 1024 * 1024 - 8 * 1024;
// The retired generic local-data route is no longer a migration writer. Its
// replacement accepts at most 8 MiB of one-time browser/file input; that is a
// transport limit only, not the 30 MiB SQLite/cache budget of a real shop.
const LEGACY_RETIREMENT_MAX_MARKETING_LEGACY_IMPORT_BYTES = 8 * 1024 * 1024;
const LEGACY_RETIREMENT_MAX_SUPPORT_PAGE_SIZE = 500;
// Chromium localStorage is the legacy input boundary. Keep the generated raw
// JSON under 4 MiB (below its usual 5 MiB quota) while still crossing 16 full
// 500-row local-api cursor pages. The canonical reader follows the opaque
// cursor to completion and uses a separate fail-closed safety ceiling.
const LEGACY_RETIREMENT_MAX_BROWSER_LEGACY_BYTES = 4 * 1024 * 1024;
// The seed is written into Chromium localStorage after the renderer has created
// its own small runtime keys. Keep one deterministic 64 KiB headroom so an
// otherwise-valid JSON body does not fail before the migration can observe it.
const LEGACY_RETIREMENT_MAX_BROWSER_SEEDED_LEGACY_BYTES =
  LEGACY_RETIREMENT_MAX_BROWSER_LEGACY_BYTES - 64 * 1024;
const LEGACY_RETIREMENT_MAX_SUPPORT_ROW_COUNT = 8_000;
const LEGACY_RETIREMENT_MAX_SUPPORT_PAGE_COUNT =
  Math.ceil(
    LEGACY_RETIREMENT_MAX_SUPPORT_ROW_COUNT / LEGACY_RETIREMENT_MAX_SUPPORT_PAGE_SIZE,
  );
const LEGACY_RETIREMENT_CURSOR_READBACK_MAX_PAGES = 10_000;
// R8-02's published pressure fixture: eight independently mapped shops and
// exactly 5,245 persisted activity/product rows. It must remain a valid
// browser/file input and be large enough to catch accidental single-shop
// imports.
const LEGACY_RETIREMENT_MARKETING_MAX_PERSISTED_ROW_COUNT = 5_245;
function stableLegacyRetirementDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function toMaximumOzonPreferenceShop(shop = {}) {
  return {
    id: String(shop.id || ""),
    shopAlias: String(shop.shopAlias || ""),
    sellerName: String(shop.sellerName || ""),
    connectionStatus: "未测试",
    connectionMessage: "填写 Client ID 和 API Key 后可以测试连接",
    connectionDetail: "",
    lastTestAt: "",
    savedAt: "",
    purchaseManagementStartedAt: "",
    purchaseManagementResetAt: "",
    remark: "",
    status: String(shop.status || "inactive"),
  };
}

function toMaximumOzonPublicShopDigestValue(shop = {}) {
  return {
    id: String(shop.id || ""),
    name: String(shop.name || ""),
    alias: String(shop.alias || ""),
    status: String(shop.status || ""),
    hasClientId: shop.hasClientId === true,
    hasApiKey: shop.hasApiKey === true,
  };
}

function createMaximumOzonShopSettingsFixture() {
  const shops = [];
  const preferenceShops = [];
  const defaultWarehouseIds = {};
  let serializedPreferenceShopsBytes = 0;
  let serializedWarehouseBytes = 0;
  let activeShopId = "";
  const requestPrefix = '{"value":{"version":1,"shops":[';
  const activePrefix = '],"activeShopId":';
  const warehousePrefix = ',"defaultWarehouseIds":{';
  const requestSuffix = '},"updatedAt":""}}';

  for (let index = 1; index <= 20_000; index += 1) {
    const id = `legacy-retirement-max-ozon-shop-${String(index).padStart(5, "0")}`;
    const shop = {
      id,
      shopAlias: `最大量 Ozon 店铺 ${index}`,
      sellerName: `最大量卖家 ${index}`,
      clientId: `fixture-client-${String(index).padStart(5, "0")}`,
      apiKey: `fixture-api-key-${String(index).padStart(5, "0")}`,
      status: "inactive",
    };
    const preferenceShop = toMaximumOzonPreferenceShop(shop);
    const warehouseId = `fixture-warehouse-${String(index).padStart(5, "0")}`;
    const serializedPreferenceShop = JSON.stringify(preferenceShop);
    const serializedWarehousePair = `${JSON.stringify(id)}:${JSON.stringify(warehouseId)}`;
    const nextPreferenceShopsBytes =
      serializedPreferenceShopsBytes +
      (preferenceShops.length ? 1 : 0) +
      Buffer.byteLength(serializedPreferenceShop, "utf8");
    const nextWarehouseBytes =
      serializedWarehouseBytes +
      (preferenceShops.length ? 1 : 0) +
      Buffer.byteLength(serializedWarehousePair, "utf8");
    const nextRequestBytes =
      Buffer.byteLength(
        requestPrefix + activePrefix + JSON.stringify(id) + warehousePrefix + requestSuffix,
        "utf8",
      ) +
      nextPreferenceShopsBytes +
      nextWarehouseBytes;
    if (nextRequestBytes > LEGACY_RETIREMENT_MAX_PROFILE_REQUEST_BYTES) break;
    shops.push(shop);
    preferenceShops.push(preferenceShop);
    defaultWarehouseIds[id] = warehouseId;
    serializedPreferenceShopsBytes = nextPreferenceShopsBytes;
    serializedWarehouseBytes = nextWarehouseBytes;
    activeShopId = id;
  }

  if (!shops.length) throw new Error("最大量 Ozon 店铺夹具未生成任何有效店铺。");
  const preferences = {
    version: 1,
    shops: preferenceShops,
    activeShopId,
    defaultWarehouseIds,
    updatedAt: "",
  };
  const requestPayloadBytes = Buffer.byteLength(JSON.stringify({ value: preferences }), "utf8");
  if (requestPayloadBytes > LEGACY_RETIREMENT_MAX_PROFILE_REQUEST_BYTES) {
    throw new Error("最大量 Ozon 店铺夹具超过 profile settings 请求预算。");
  }
  const expectedPublicShops = shops
    .map((shop) => ({
      id: shop.id,
      name: shop.sellerName,
      alias: shop.shopAlias,
      status: shop.status,
      hasClientId: true,
      hasApiKey: true,
    }))
    .map(toMaximumOzonPublicShopDigestValue)
    .sort((left, right) => left.id.localeCompare(right.id));
  const expectedWarehouseEntries = Object.entries(defaultWarehouseIds).sort(([left], [right]) => left.localeCompare(right));
  return {
    legacyEntries: [
      { key: RETIRED_OZON_SHOP_BROWSER_KEY, value: shops },
    ],
    expectedShopId: activeShopId,
    expectedWarehouseId: defaultWarehouseIds[activeShopId],
    expectedShopCount: shops.length,
    expectedPreferenceShopDigest: stableLegacyRetirementDigest(
      [...preferenceShops].sort((left, right) => left.id.localeCompare(right.id)),
    ),
    expectedPublicShopDigest: stableLegacyRetirementDigest(expectedPublicShops),
    expectedWarehouseCount: expectedWarehouseEntries.length,
    expectedWarehouseDigest: stableLegacyRetirementDigest(expectedWarehouseEntries),
    maxExpectation: {
      kind: "ozon-shop-settings",
      requestPayloadBytes,
      requestBudgetBytes: LEGACY_RETIREMENT_MAX_PROFILE_REQUEST_BYTES,
    },
  };
}

function createMaximumPurchasePluginContextFixture() {
  const maximumText = (prefix, maxLength) => `${prefix}${'x'.repeat(maxLength)}`.slice(0, maxLength);
  const context = {
    shopName: maximumText('最大量店铺-', 120),
    shopId: maximumText('shop-', 120),
    shopClientId: maximumText('client-', 120),
    orderId: maximumText('order-', 160),
    orderKey: maximumText('order-key-', 260),
    productKey: maximumText('product-key-', 260),
    legacyProductKey: maximumText('legacy-product-', 160),
    offerId: maximumText('offer-', 160),
    sku: maximumText('sku-', 160),
    productIndex: 999_999,
    productName: maximumText('最大量采购商品-', 260),
    ozonOrderId: maximumText('ozon-order-', 160),
    salesAmount: `${'9'.repeat(77)}.00`,
    productImageUrl: `https://img.test/${'x'.repeat(2048 - 'https://img.test/'.length)}`,
    lockedAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:01.000Z',
  };
  const expectedContext = Object.fromEntries(Object.entries(context).sort(([left], [right]) => left.localeCompare(right)));
  const profileValue = { version: 1, context, updatedAt: context.updatedAt };
  const requestPayloadBytes = Buffer.byteLength(JSON.stringify({ value: profileValue }), 'utf8');
  if (requestPayloadBytes > LEGACY_RETIREMENT_MAX_PROFILE_REQUEST_BYTES) {
    throw new Error('最大量拍单插件上下文夹具超过 profile settings 请求预算。');
  }
  return {
    legacyEntries: [{ key: RETIRED_PURCHASE_PLUGIN_BROWSER_KEY, value: context }],
    expectedPurchasePluginContext: expectedContext,
    expectedPurchasePluginContextDigest: stableLegacyRetirementDigest(expectedContext),
    maxExpectation: {
      kind: 'purchase-source-plugin-context',
      requestPayloadBytes,
      requestBudgetBytes: LEGACY_RETIREMENT_MAX_PROFILE_REQUEST_BYTES,
    },
  };
}

function toMaximumMaterialProfileDigestValue(profile = {}) {
  const shopId = String(profile.shopId || "");
  const productId = String(profile.productId || "");
  const offerId = String(profile.offerId || "");
  const ozonSku = String(profile.ozonSku || "");
  return {
    key: productId ? `product:${productId}` : offerId ? `offer:${offerId}` : `sku:${ozonSku}`,
    shopId,
    productId,
    offerId,
    ozonSku,
    source: String(profile.source || ""),
    weight: String(profile.weight || ""),
    length: String(profile.length || ""),
    width: String(profile.width || ""),
    height: String(profile.height || ""),
    applyToProduct: profile.applyToProduct === true,
    isConfirmed: profile.isConfirmed === true,
  };
}

function createMaximumProductMaterialProfilesFixture() {
  const shopId = "legacy-retirement-max-material-shop";
  const profiles = {};
  const expectedProfiles = [];
  for (let index = 1; index <= LEGACY_RETIREMENT_MAX_SUPPORT_ROW_COUNT; index += 1) {
    const sequence = String(index).padStart(5, "0");
    const offerId = `legacy-retirement-max-material-offer-${sequence}`;
    const profile = {
      key: `${shopId}:${offerId}`,
      shopId,
      productId: `legacy-retirement-max-material-product-${sequence}`,
      offerId,
      ozonSku: `legacy-retirement-max-material-sku-${sequence}`,
      source: "supplier-confirmed",
      weight: "0.25",
      length: "20",
      width: "10",
      height: "8",
      applyToProduct: true,
      isConfirmed: true,
    };
    profiles[profile.key] = profile;
    expectedProfiles.push(toMaximumMaterialProfileDigestValue(profile));
  }
  const legacyProfileBytes = Buffer.byteLength(JSON.stringify(profiles), "utf8");
  if (legacyProfileBytes > LEGACY_RETIREMENT_MAX_BROWSER_LEGACY_BYTES) {
    throw new Error("最大量材积夹具超过浏览器 legacy JSON 安全预算。");
  }
  return {
    legacyEntries: [
      {
        key: RETIRED_OZON_SHOP_BROWSER_KEY,
        value: [{
          id: shopId,
          sellerName: "最大量材积迁移夹具店铺",
          shopAlias: "最大量材积迁移夹具",
          clientId: "fixture-max-material-client",
          apiKey: "test-api-key",
          status: "inactive",
        }],
      },
      { key: RETIRED_PRODUCT_MATERIAL_BROWSER_KEY, value: profiles },
    ],
    expectedMaterialProfileCount: expectedProfiles.length,
    expectedMaterialProfileDigest: stableLegacyRetirementDigest(expectedProfiles),
    expectedMaterialProfiles: [],
    maxExpectation: {
      kind: "product-material-profiles",
      pageSize: LEGACY_RETIREMENT_MAX_SUPPORT_PAGE_SIZE,
      pageCount: LEGACY_RETIREMENT_MAX_SUPPORT_PAGE_COUNT,
      legacyProfileBytes,
      legacyProfileBudgetBytes: LEGACY_RETIREMENT_MAX_BROWSER_LEGACY_BYTES,
    },
  };
}

const LEGACY_RETIREMENT_MARKETING_SNAPSHOT_COUNT = 8;

/**
 * Marketing legacy scopes are valid only after the renderer has a canonical
 * shop mapping.  These are test-only no-credential shop records: they prove
 * the migration does not use a dangerous single-shop fallback, while avoiding
 * fake Ozon credentials in the R8 fixture.  They are deliberately separate
 * from `legacyEntries`, because only the marketing browser key is under test
 * for retention/cleanup in this fixture.
 */
function createMarketingScopeBootstrapLegacyEntries(shopIds = []) {
  const uniqueShopIds = [...new Set((Array.isArray(shopIds) ? shopIds : [])
    .map((shopId) => String(shopId || '').trim())
    .filter(Boolean))];
  if (!uniqueShopIds.length) return [];
  return [
    {
      key: RETIRED_OZON_SHOP_BROWSER_KEY,
      value: uniqueShopIds.map((id, index) => ({
        id,
        sellerName: `营销迁移夹具店铺 ${index + 1}`,
        shopAlias: `营销夹具 ${index + 1}`,
        // An inactive mapping is sufficient for a local cache migration.  Do
        // not add Client ID/API Key: the R8 proof must not schedule Ozon work.
        status: 'inactive',
      })),
    },
  ];
}

function toMaximumMarketingActivityDigestValue(activity = {}) {
  return {
    id: String(activity.id || ''),
    title: String(activity.title || ''),
    originalTitle: String(activity.originalTitle || ''),
    source: String(activity.source || ''),
    sourceTone: String(activity.sourceTone || ''),
    count: Number(activity.count || 0),
    description: String(activity.description || ''),
    available: Number(activity.available || 0),
    hasAvailableCount: activity.hasAvailableCount === true,
    estimate: String(activity.estimate || ''),
    dateStart: String(activity.dateStart || ''),
    dateEnd: String(activity.dateEnd || ''),
    isOnline: activity.isOnline === true,
    sourceType: String(activity.sourceType || ''),
  };
}

function toMaximumMarketingProductDigestValue(product = {}) {
  return {
    id: String(product.id || ''),
    name: String(product.name || ''),
    offerId: String(product.offerId || ''),
    ozonSku: String(product.ozonSku || ''),
    sku: String(product.sku || ''),
    price: String(product.price || ''),
    sourceActivityPrice: String(product.sourceActivityPrice || ''),
    activityPrice: String(product.activityPrice || ''),
    // `toPublicMarketingActivityProduct` is a DTO boundary: stock remains a
    // display string (including the meaningful value "0"), not a number.
    stock: String(product.stock ?? ''),
    status: String(product.status || ''),
    statusTone: String(product.statusTone || ''),
    review: String(product.review || ''),
    reviewTone: String(product.reviewTone || ''),
  };
}

function toMaximumMarketingSnapshotDigestValue(shopId, snapshot = {}) {
  const summary = snapshot.marketingSummary || {};
  return {
    shopId: String(shopId || ''),
    activityRows: (Array.isArray(snapshot.activityRows) ? snapshot.activityRows : [])
      .map(toMaximumMarketingActivityDigestValue),
    productPool: (Array.isArray(snapshot.productPool) ? snapshot.productPool : [])
      .map(toMaximumMarketingProductDigestValue),
    marketingSummary: {
      activityTotal: Number(summary.activityTotal || 0),
      joinedActivityTotal: Number(summary.joinedActivityTotal || 0),
      joinedProductTotal: Number(summary.joinedProductTotal || 0),
      issueProductTotal: Number(summary.issueProductTotal || 0),
    },
    selectedActivityId: String(snapshot.selectedActivityId || ''),
    selectedSourceType: String(snapshot.selectedSourceType || ''),
    productScope: String(snapshot.productScope || ''),
    selectedProductIds: Array.isArray(snapshot.selectedProductIds)
      ? snapshot.selectedProductIds.map((id) => String(id || ''))
      : [],
    cachedAt: String(snapshot.cachedAt || ''),
  };
}

/**
 * Fills a valid legacy browser/local-data snapshot with recognized activity and
 * product fields. Eight independently mapped stores prove the SQLite import is
 * shop scoped; 5,245 rows stay within the browser seed and 8 MiB migration
 * request boundaries.
 */
function createMaximumMarketingActivityCacheFixture() {
  const snapshots = {};
  const snapshotShopIds = [];
  const expectedMarketingSelections = {};
  const expectedMarketingActivityVariants = {};
  for (let index = 1; index <= LEGACY_RETIREMENT_MARKETING_SNAPSHOT_COUNT; index += 1) {
    const sequence = String(index).padStart(2, '0');
    const activityId = `legacy-retirement-max-marketing-activity-${sequence}`;
    const shopId = `legacy-retirement-max-marketing-shop-${sequence}`;
    snapshotShopIds.push(shopId);
    expectedMarketingSelections[shopId] = { activityId, sourceType: 'official' };
    expectedMarketingActivityVariants[shopId] = {
      activityId,
      sourceTypes: ['official'],
    };
    snapshots[shopId] = {
      activityRows: [{
        id: activityId,
        title: `最大量营销活动 ${index}`,
        originalTitle: `最大量营销原始活动 ${index}`,
        source: 'Ozon',
        sourceTone: 'ozon',
        count: 1,
        description: '合法最大量营销活动夹具',
        available: 1,
        hasAvailableCount: true,
        estimate: '可参与',
        isOnline: true,
        sourceType: 'official',
      }],
      productPool: [],
      marketingSummary: {
        activityTotal: 1,
        joinedActivityTotal: 1,
        joinedProductTotal: 0,
        issueProductTotal: 0,
      },
      selectedActivityId: activityId,
      selectedSourceType: 'official',
      productScope: 'all',
      selectedProductIds: [],
      cachedAt: '2026-07-13T00:00:00.000Z',
    };
  }

  const maximumProductCount =
    LEGACY_RETIREMENT_MARKETING_MAX_PERSISTED_ROW_COUNT -
    LEGACY_RETIREMENT_MARKETING_SNAPSHOT_COUNT;
  if (!Number.isInteger(maximumProductCount) || maximumProductCount < 0) {
    throw new Error('最大量营销缓存夹具的活动/商品行数预算无效。');
  }
  let productCount = 0;
  for (let index = 1; index <= maximumProductCount; index += 1) {
    const shopSequence = String(((index - 1) % LEGACY_RETIREMENT_MARKETING_SNAPSHOT_COUNT) + 1).padStart(2, '0');
    const shopKey = `legacy-retirement-max-marketing-shop-${shopSequence}`;
    const sequence = String(index).padStart(5, '0');
    snapshots[shopKey].productPool.push({
      id: `legacy-retirement-max-marketing-product-${sequence}`,
      name: `最大量营销商品 ${index}`,
      offerId: `legacy-retirement-max-marketing-offer-${sequence}`,
      ozonSku: `legacy-retirement-max-marketing-sku-${sequence}`,
      sku: `max-marketing-sku-${sequence}`,
      price: '99.99',
      sourceActivityPrice: '89.99',
      activityPrice: '79.99',
      stock: 99,
      status: '已添加',
      statusTone: 'success',
      review: '正常',
      reviewTone: 'success',
    });
    productCount += 1;
  }
  Object.values(snapshots).forEach((snapshot) => {
    snapshot.marketingSummary.joinedProductTotal = snapshot.productPool.length;
  });
  const activityCount = Object.values(snapshots).reduce(
    (count, snapshot) => count + (Array.isArray(snapshot.activityRows) ? snapshot.activityRows.length : 0),
    0,
  );
  const totalPersistedRowCount = activityCount + productCount;
  const legacyBrowserInputBytes = Buffer.byteLength(JSON.stringify(snapshots), 'utf8');
  // This must match the actual frontend migration request, not merely the
  // browser/file aggregate before it is mapped to explicit shops.
  const legacyImportEntries = Object.entries(snapshots).map(([shopId, snapshot]) => ({
    legacyScope: LEGACY_RETIREMENT_MARKETING_CACHE_STORAGE_KEY,
    shopId,
    snapshot,
  }));
  const legacyImportBodyBytes = Buffer.byteLength(
    JSON.stringify({ entries: legacyImportEntries }),
    'utf8',
  );
  if (
    activityCount !== LEGACY_RETIREMENT_MARKETING_SNAPSHOT_COUNT ||
    productCount !== maximumProductCount ||
    totalPersistedRowCount !== LEGACY_RETIREMENT_MARKETING_MAX_PERSISTED_ROW_COUNT ||
    legacyImportBodyBytes > LEGACY_RETIREMENT_MAX_MARKETING_LEGACY_IMPORT_BYTES ||
    legacyBrowserInputBytes > LEGACY_RETIREMENT_MAX_BROWSER_SEEDED_LEGACY_BYTES
  ) {
    throw new Error('最大量营销缓存夹具未能填充到合法旧 JSON 输入预算内。');
  }
  const expectedSnapshots = Object.entries(snapshots)
    .map(([shopId, snapshot]) => toMaximumMarketingSnapshotDigestValue(shopId, snapshot))
    .sort((left, right) => left.shopId.localeCompare(right.shopId));
  const publicStockProbe = toMaximumMarketingProductDigestValue({ stock: 99 }).stock;
  if (publicStockProbe !== '99') {
    throw new Error('最大量营销缓存夹具必须按 public SQLite DTO 的字符串 stock 语义生成 digest。');
  }
  return {
    legacyEntries: [{ key: RETIRED_MARKETING_BROWSER_KEY, value: snapshots }],
    bootstrapLegacyEntries: createMarketingScopeBootstrapLegacyEntries(snapshotShopIds),
    recoveryShopIds: snapshotShopIds,
    expectedSnapshotKeys: [],
    expectedMarketingSelections,
    expectedMarketingActivityVariants,
    expectedMarketingSnapshotCount: expectedSnapshots.length,
    expectedMarketingActivityCount: activityCount,
    expectedMarketingProductCount: productCount,
    expectedMarketingTotalRowCount: totalPersistedRowCount,
    expectedMarketingSnapshotDigest: stableLegacyRetirementDigest(expectedSnapshots),
    maxExpectation: {
      kind: 'marketing-activity-cache',
      fixtureShopCount: snapshotShopIds.length,
      expectedMarketingActivityCount: activityCount,
      expectedMarketingProductCount: productCount,
      expectedMarketingTotalRowCount: totalPersistedRowCount,
      legacyBrowserInputBytes,
      legacyBrowserInputBudgetBytes: LEGACY_RETIREMENT_MAX_BROWSER_SEEDED_LEGACY_BYTES,
      legacyImportBodyBytes,
      legacyImportBodyBudgetBytes: LEGACY_RETIREMENT_MAX_MARKETING_LEGACY_IMPORT_BYTES,
    },
  };
}

function toMaximumProductSourceLinkDigestValue(link = {}) {
  return {
    shopId: String(link.shopId || ''),
    productKey: String(link.productKey || ''),
    slotIndex: Number(link.slotIndex || 0),
    isPrimary: link.isPrimary === true,
    platform: String(link.platform || ''),
    link: String(link.link || ''),
    productId: String(link.productId || ''),
    title: String(link.title || ''),
    imageUrl: String(link.imageUrl || ''),
    previewImageUrl: String(link.previewImageUrl || ''),
    originalImageUrl: String(link.originalImageUrl || ''),
    priceValue: link.priceValue === null || link.priceValue === undefined ? null : Number(link.priceValue),
    currencyCode: String(link.currencyCode || ''),
    qty: String(link.qty || ''),
  };
}

function createMaximumProductSourceLinksFixture() {
  const shopId = 'legacy-retirement-max-product-source-shop';
  const sourceRecords = {};
  const expectedSourceLinks = [];
  const recordCount = LEGACY_RETIREMENT_MAX_SUPPORT_ROW_COUNT / 2;
  for (let index = 1; index <= recordCount; index += 1) {
    const sequence = String(index).padStart(5, '0');
    const productKey = `legacy-retirement-max-product-source-offer-${sequence}`;
    const links = [
      {
        link: `https://detail.1688.com/offer/${sequence}.html`,
        productId: `legacy-retirement-max-product-source-a-${sequence}`,
        platform: '1688',
        title: `最大量商品来源 A ${index}`,
        imageUrl: `https://img.test/max-product-source-${sequence}-a.jpg`,
        previewImageUrl: `https://img.test/max-product-source-${sequence}-a-preview.jpg`,
        originalImageUrl: `https://img.test/max-product-source-${sequence}-a-original.jpg`,
        priceValue: 12.5,
        currencyCode: 'CNY',
        qty: '2',
      },
      {
        link: `https://item.taobao.com/item.htm?id=${sequence}`,
        productId: `legacy-retirement-max-product-source-b-${sequence}`,
        platform: '淘宝',
        title: `最大量商品来源 B ${index}`,
        imageUrl: `https://img.test/max-product-source-${sequence}-b.jpg`,
        previewImageUrl: `https://img.test/max-product-source-${sequence}-b-preview.jpg`,
        originalImageUrl: `https://img.test/max-product-source-${sequence}-b-original.jpg`,
        priceValue: 19.5,
        currencyCode: 'CNY',
        qty: '1',
      },
    ];
    sourceRecords[`${shopId}:${productKey}`] = {
      links,
      primaryIndex: 1,
      updatedAt: '2026-07-13T00:00:00.000Z',
    };
    links.forEach((link, slotIndex) => {
      expectedSourceLinks.push(toMaximumProductSourceLinkDigestValue({
        ...link,
        shopId,
        productKey,
        slotIndex,
        isPrimary: slotIndex === 1,
      }));
    });
  }
  const legacySourceLinkBytes = Buffer.byteLength(JSON.stringify(sourceRecords), 'utf8');
  if (legacySourceLinkBytes > LEGACY_RETIREMENT_MAX_BROWSER_LEGACY_BYTES) {
    throw new Error('最大量商品来源链接夹具超过浏览器 legacy JSON 安全预算。');
  }
  return {
    legacyEntries: [
      {
        key: RETIRED_OZON_SHOP_BROWSER_KEY,
        value: [{
          id: shopId,
          sellerName: '最大量商品来源迁移夹具店铺',
          shopAlias: '最大量商品来源迁移夹具',
          clientId: 'fixture-max-product-source-client',
          apiKey: 'test-api-key',
          status: 'inactive',
        }],
      },
      { key: RETIRED_PRODUCT_SOURCE_BROWSER_KEY, value: sourceRecords },
    ],
    expectedSourceLinks: [],
    expectedProductSourceLinkCount: expectedSourceLinks.length,
    expectedProductSourceLinkDigest: stableLegacyRetirementDigest(
      [...expectedSourceLinks].sort((left, right) =>
        `${left.shopId}:${left.productKey}:${left.slotIndex}`.localeCompare(
          `${right.shopId}:${right.productKey}:${right.slotIndex}`,
        ),
      ),
    ),
    maxExpectation: {
      kind: 'product-source-links',
      pageSize: LEGACY_RETIREMENT_MAX_SUPPORT_PAGE_SIZE,
      pageCount: LEGACY_RETIREMENT_MAX_SUPPORT_PAGE_COUNT,
      legacySourceLinkBytes,
      legacySourceLinkBudgetBytes: LEGACY_RETIREMENT_MAX_BROWSER_LEGACY_BYTES,
    },
  };
}

function toMaximumPurchaseSourceLinkDigestValue(link = {}) {
  return {
    shopId: String(link.shopId || ''),
    orderKey: String(link.orderKey || ''),
    slotIndex: Number(link.slotIndex || 0),
    isPrimary: link.isPrimary === true,
    platform: String(link.platform || ''),
    url: String(link.url || ''),
    sourceProductId: String(link.sourceProductId || ''),
    title: String(link.title || ''),
    imageUrl: String(link.imageUrl || ''),
    previewImageUrl: String(link.previewImageUrl || ''),
    originalImageUrl: String(link.originalImageUrl || ''),
    priceValue: link.priceValue === null || link.priceValue === undefined ? null : Number(link.priceValue),
    currencyCode: String(link.currencyCode || ''),
    qty: String(link.qty || ''),
  };
}

function createMaximumPurchaseSourceLinksFixture() {
  const shopId = 'lr-purchase-source-shop';
  const clientId = 'lrps-client';
  const sourceRecords = {};
  const expectedSourceLinks = [];
  const recordCount = LEGACY_RETIREMENT_MAX_SUPPORT_ROW_COUNT / 2;
  for (let index = 1; index <= recordCount; index += 1) {
    const sequence = String(index).padStart(5, '0');
    const orderKey = `lr-purchase-order-${sequence}`;
    const links = [
      {
        link: `https://a.test/p/${sequence}`,
        productId: `lr-purchase-source-a-${sequence}`,
        platform: '1688',
        title: `采购来源 A ${index}`,
        imageUrl: `https://i.test/p/${sequence}-a.jpg`,
        previewImageUrl: `https://i.test/p/${sequence}-a-p.jpg`,
        originalImageUrl: `https://i.test/p/${sequence}-a-o.jpg`,
        priceValue: 12.5,
        currencyCode: 'CNY',
        qty: '2',
      },
      {
        link: `https://t.test/p/${sequence}`,
        productId: `lr-purchase-source-b-${sequence}`,
        platform: '淘宝',
        title: `采购来源 B ${index}`,
        imageUrl: `https://i.test/p/${sequence}-b.jpg`,
        previewImageUrl: `https://i.test/p/${sequence}-b-p.jpg`,
        originalImageUrl: `https://i.test/p/${sequence}-b-o.jpg`,
        priceValue: 19.5,
        currencyCode: 'CNY',
        qty: '1',
      },
    ];
    sourceRecords[`${clientId}:${orderKey}`] = { links, primaryIndex: 1, updatedAt: '2026-07-13T00:00:00.000Z' };
    links.forEach((link, slotIndex) => {
      expectedSourceLinks.push(toMaximumPurchaseSourceLinkDigestValue({
        ...link,
        shopId,
        orderKey,
        slotIndex,
        isPrimary: slotIndex === 1,
        url: link.link,
        sourceProductId: link.productId,
      }));
    });
  }
  const legacySourceLinkBytes = Buffer.byteLength(JSON.stringify(sourceRecords), 'utf8');
  if (legacySourceLinkBytes > LEGACY_RETIREMENT_MAX_BROWSER_LEGACY_BYTES) {
    throw new Error('最大量采购来源链接夹具超过浏览器 legacy JSON 安全预算。');
  }
  return {
    legacyEntries: [
      { key: RETIRED_OZON_SHOP_BROWSER_KEY, value: [{ id: shopId, sellerName: '最大量采购来源店铺', shopAlias: '最大量采购来源', clientId, apiKey: 'test-api-key', status: 'inactive' }] },
      { key: RETIRED_PURCHASE_SOURCE_BROWSER_KEY, value: sourceRecords },
    ],
    expectedPurchaseSourceLinks: [],
    expectedPurchaseSourceLinkCount: expectedSourceLinks.length,
    expectedPurchaseSourceLinkDigest: stableLegacyRetirementDigest(
      [...expectedSourceLinks].sort((left, right) =>
        (left.shopId + ':' + left.orderKey + ':' + left.slotIndex).localeCompare(
          right.shopId + ':' + right.orderKey + ':' + right.slotIndex,
        ),
      ),
    ),
    maxExpectation: {
      kind: 'purchase-source-links',
      pageSize: 1000,
      // Unlike product support, this endpoint exposes `total`; eight full
      // pages are therefore a complete readback rather than an ambiguous cap.
      pageCount: 8,
      legacySourceLinkBytes,
      legacySourceLinkBudgetBytes: LEGACY_RETIREMENT_MAX_BROWSER_LEGACY_BYTES,
    },
  };
}

function createMaximumSalesSourceLinksFixture() {
  const shopId = 'lr-sales-source-shop';
  const clientId = 'lrss-client';
  const sourceRecords = {};
  const expectedSourceLinks = [];
  const recordCount = LEGACY_RETIREMENT_MAX_SUPPORT_ROW_COUNT / 2;
  for (let index = 1; index <= recordCount; index += 1) {
    const sequence = String(index).padStart(5, '0');
    const orderKey = `lr-sales-order-${sequence}`;
    const links = [
      { link: `https://a.test/s/${sequence}`, productId: `lr-sales-a-${sequence}`, platform: '1688', title: `销售来源 A ${index}`, imageUrl: `https://i.test/s/${sequence}-a.jpg`, previewImageUrl: `https://i.test/s/${sequence}-a-p.jpg`, originalImageUrl: `https://i.test/s/${sequence}-a-o.jpg`, priceValue: 12.5, currencyCode: 'CNY', qty: '2' },
      { link: `https://t.test/s/${sequence}`, productId: `lr-sales-b-${sequence}`, platform: '淘宝', title: `销售来源 B ${index}`, imageUrl: `https://i.test/s/${sequence}-b.jpg`, previewImageUrl: `https://i.test/s/${sequence}-b-p.jpg`, originalImageUrl: `https://i.test/s/${sequence}-b-o.jpg`, priceValue: 19.5, currencyCode: 'CNY', qty: '1' },
    ];
    sourceRecords[`${clientId}:${orderKey}`] = { links, primaryIndex: 1, updatedAt: '2026-07-13T00:00:00.000Z' };
    links.forEach((link, slotIndex) => {
      expectedSourceLinks.push(toMaximumPurchaseSourceLinkDigestValue({ ...link, shopId, orderKey, slotIndex, isPrimary: slotIndex === 1, url: link.link, sourceProductId: link.productId }));
    });
  }
  const legacySourceLinkBytes = Buffer.byteLength(JSON.stringify(sourceRecords), 'utf8');
  if (legacySourceLinkBytes > LEGACY_RETIREMENT_MAX_BROWSER_LEGACY_BYTES) throw new Error('最大量销售来源链接夹具超过浏览器 legacy JSON 安全预算。');
  return {
    legacyEntries: [
      { key: RETIRED_OZON_SHOP_BROWSER_KEY, value: [{ id: shopId, sellerName: '最大量销售来源店铺', shopAlias: '最大量销售来源', clientId, apiKey: 'test-api-key', status: 'inactive' }] },
      { key: RETIRED_SALES_SOURCE_BROWSER_KEY, value: sourceRecords },
    ],
    expectedSalesSourceLinks: [],
    expectedSalesSourceLinkCount: expectedSourceLinks.length,
    expectedSalesSourceLinkDigest: stableLegacyRetirementDigest([...expectedSourceLinks].sort((left, right) => (left.shopId + ':' + left.orderKey + ':' + left.slotIndex).localeCompare(right.shopId + ':' + right.orderKey + ':' + right.slotIndex))),
    maxExpectation: { kind: 'sales-source-links', pageSize: 1000, pageCount: 8, legacySourceLinkBytes, legacySourceLinkBudgetBytes: LEGACY_RETIREMENT_MAX_BROWSER_LEGACY_BYTES },
  };
}

function toMaximumPurchaseOrderOverrideDigestValue(override = {}) {
  return {
    shopId: String(override.shopId || ''),
    orderKey: String(override.orderKey || ''),
    manualBuyerPlatform: String(override.manualBuyerPlatform || ''),
    manualPurchaseOrderNo: String(override.manualPurchaseOrderNo || ''),
    manualPurchaseOrderUrl: String(override.manualPurchaseOrderUrl || ''),
    manualPurchasePriceValue: Number(override.manualPurchasePriceValue || 0),
    manualPurchasePrice: String(override.manualPurchasePrice || ''),
    manualPurchaseOrderStatus: String(override.manualPurchaseOrderStatus || ''),
    crossBorderOrderFound: override.crossBorderOrderFound === true,
    crossBorderStatus: String(override.crossBorderStatus || ''),
    crossBorderOrderCount: Number(override.crossBorderOrderCount || 0),
    packageOrderId: String(override.packageOrderId || ''),
    crossBorderOrderId: String(override.crossBorderOrderId || ''),
    crossBorderOrderNumber: String(override.crossBorderOrderNumber || ''),
    packageOrderIds: Array.isArray(override.packageOrderIds) ? override.packageOrderIds.map(String) : [],
    readStatus: String(override.readStatus || ''),
    packageWeight: String(override.packageWeight || ''),
    packageSize: String(override.packageSize || ''),
    volumeItems: Array.isArray(override.volumeItems) ? override.volumeItems : [],
    warehouse: String(override.warehouse || ''),
    logistics: String(override.logistics || ''),
    deliveryMethod: String(override.deliveryMethod || ''),
    deliveryMethodId: String(override.deliveryMethodId || ''),
    sheetOrderSn: String(override.sheetOrderSn || ''),
    sheetUrl: String(override.sheetUrl || ''),
    freightCostValue: Number(override.freightCostValue || 0),
    freightCost: String(override.freightCost || ''),
    guooFreight: String(override.guooFreight || ''),
    crossBorderUpdatedAt: String(override.crossBorderUpdatedAt || ''),
    materialSource: override.materialSource || null,
    note: String(override.note || ''),
  };
}

function createMaximumPurchaseOrderOverridesFixture() {
  const shopId = 'lr-purchase-override-shop';
  const overrides = {};
  const expectedOverrides = [];
  const orderKeys = [];
  let legacyOverrideBytes = 0;
  for (let index = 1; index <= 20_000; index += 1) {
    const sequence = String(index).padStart(5, '0');
    const orderKey = `lr-purchase-override-order-${sequence}`;
    const packageOrderId = `lr-purchase-package-${sequence}`;
    const override = {
      shopId,
      manualBuyerPlatform: index % 2 ? '1688' : '淘宝',
      manualPurchaseOrderNo: `purchase-order-${sequence}`,
      manualPurchaseOrderUrl: `https://detail.1688.com/offer/${sequence}.html`,
      manualPurchasePriceValue: 12.5,
      manualPurchasePrice: '12.50',
      manualPurchaseOrderStatus: '已拍单',
      crossBorderOrderFound: true,
      crossBorderStatus: '已创建预报',
      crossBorderOrderCount: 1,
      packageOrderId,
      crossBorderOrderId: `lr-cross-border-id-${sequence}`,
      crossBorderOrderNumber: `lr-cross-border-number-${sequence}`,
      packageOrderIds: [packageOrderId],
      readStatus: '已读取',
      packageWeight: '1.25',
      packageSize: '10x10x10',
      volumeItems: [{ name: '最大量采购覆盖商品', sku: `lr-purchase-override-sku-${sequence}`, qty: 1, price: '12.50' }],
      warehouse: 'fixture-warehouse',
      logistics: 'fixture-logistics',
      deliveryMethod: '标准物流',
      deliveryMethodId: 'fixture-standard',
      sheetOrderSn: `lr-sheet-${sequence}`,
      sheetUrl: `https://sheet.test/${sequence}`,
      freightCostValue: 2.5,
      freightCost: '2.50',
      guooFreight: '1.50',
      crossBorderUpdatedAt: '2026-07-13T00:00:00.000Z',
      materialSource: { source: 'manual', offerId: `lr-material-${sequence}` },
      note: `最大量采购覆盖备注 ${sequence}`,
      updatedAt: '2026-07-13T00:00:00.000Z',
    };
    overrides[orderKey] = override;
    expectedOverrides.push(toMaximumPurchaseOrderOverrideDigestValue({ ...override, orderKey }));
    orderKeys.push(orderKey);
    if (index % 50 !== 0) continue;
    legacyOverrideBytes = Buffer.byteLength(JSON.stringify(overrides), 'utf8');
    if (legacyOverrideBytes <= LEGACY_RETIREMENT_MAX_BROWSER_LEGACY_BYTES) continue;
    while (legacyOverrideBytes > LEGACY_RETIREMENT_MAX_BROWSER_LEGACY_BYTES && orderKeys.length) {
      delete overrides[orderKeys.pop()];
      expectedOverrides.pop();
      legacyOverrideBytes = Buffer.byteLength(JSON.stringify(overrides), 'utf8');
    }
    break;
  }
  legacyOverrideBytes = Buffer.byteLength(JSON.stringify(overrides), 'utf8');
  if (!orderKeys.length || legacyOverrideBytes > LEGACY_RETIREMENT_MAX_BROWSER_LEGACY_BYTES) {
    throw new Error('最大量采购订单覆盖夹具未能填充到浏览器 legacy JSON 安全预算内。');
  }
  return {
    legacyEntries: [{ key: RETIRED_PURCHASE_OVERRIDE_BROWSER_KEY, value: overrides }],
    expectedPurchaseOverrides: [],
    expectedPurchaseOverrideCount: expectedOverrides.length,
    expectedPurchaseOverrideDigest: stableLegacyRetirementDigest(
      [...expectedOverrides].sort((left, right) =>
        (left.shopId + ':' + left.orderKey).localeCompare(right.shopId + ':' + right.orderKey),
      ),
    ),
    maxExpectation: {
      kind: 'purchase-order-overrides',
      pageSize: 1000,
      pageCount: Math.ceil(expectedOverrides.length / 1000),
      legacyOverrideBytes,
      legacyOverrideBudgetBytes: LEGACY_RETIREMENT_MAX_BROWSER_LEGACY_BYTES,
    },
  };
}

// This key has been retired from production.  The R8 harness keeps the name
// only as an opaque preseed selector while dependent fixtures are converted
// to canonical SQLite shop setup.
const RETIRED_OZON_SHOP_BROWSER_KEY = ['wangzai', 'ozon', 'shops'].join('-');
const RETIRED_MARKETING_BROWSER_KEY = ['wangzai', 'marketing', 'activity', 'cache', 'v1'].join('-');
const RETIRED_PRODUCT_MATERIAL_BROWSER_KEY = ['wangzai', 'product', 'material', 'profiles', 'v1'].join('-');
const RETIRED_PRODUCT_SOURCE_BROWSER_KEY = ['wz', 'product', 'source', 'links'].join('-');
const RETIRED_PURCHASE_OVERRIDE_BROWSER_KEY = ['wz', 'purchase', 'order', 'local', 'overrides'].join('-');
const RETIRED_PURCHASE_SOURCE_BROWSER_KEY = ['wz', 'purchase', 'source', 'links'].join('-');
const RETIRED_PURCHASE_PLUGIN_BROWSER_KEY = ['wz', 'purchase', 'source', 'plugin', 'context'].join('-');
const RETIRED_SALES_SOURCE_BROWSER_KEY = ['wz', 'sales', 'source', 'links'].join('-');
const LEGACY_RETIREMENT_FIXTURES = Object.freeze({
  "ozon-shop-settings": Object.freeze({
    legacyEntries: [
      {
        key: RETIRED_OZON_SHOP_BROWSER_KEY,
        value: [{
          id: "legacy-retirement-ozon-shop",
          sellerName: "退役夹具店铺",
          shopAlias: "退役夹具",
          clientId: "fixture-client-id",
          apiKey: "test-api-key",
        }],
      },
    ],
    canonicalKind: "ozon-shop-settings",
    recoveryRetainedKeys: [
      RETIRED_OZON_SHOP_BROWSER_KEY,
    ],
    canonicalNamespace: "ozon-shop-preferences",
    expectedShopId: "legacy-retirement-ozon-shop",
    expectedWarehouseId: "fixture-warehouse",
  }),
  "marketing-activity-cache": Object.freeze({
    legacyEntries: [{
      key: RETIRED_MARKETING_BROWSER_KEY,
      value: {
        "fixture-shop-a": {
          // Same shop + same activity ID is intentionally represented twice.
          // `selectedSourceType` below must preserve the seller tuple instead
          // of collapsing official/seller records into one ambiguous activity.
          activityRows: [{
            id: "fixture-activity-a",
            title: "夹具官方活动 A",
            originalTitle: "夹具官方活动 A",
            source: "Ozon",
            sourceTone: "ozon",
            count: 0,
            description: "营销 SQLite 同活动 ID 官方夹具",
            available: 1,
            hasAvailableCount: true,
            estimate: "可参与",
            dateStart: "",
            dateEnd: "",
            isOnline: true,
            sourceType: "official",
          }, {
            id: "fixture-activity-a",
            title: "夹具商家活动 A",
            originalTitle: "夹具商家活动 A",
            source: "商家自主",
            sourceTone: "seller",
            count: 1,
            description: "营销 SQLite 同活动 ID 商家夹具",
            available: 1,
            hasAvailableCount: true,
            estimate: "可参与",
            dateStart: "",
            dateEnd: "",
            isOnline: true,
            sourceType: "seller",
          }],
          productPool: [{
            id: "fixture-product-a",
            name: "夹具商品 A",
            offerId: "fixture-offer-a",
            ozonSku: "fixture-sku-a",
            sku: "fixture-sku-a",
            price: "99.99",
            sourceActivityPrice: "89.99",
            activityPrice: "79.99",
            stock: 9,
            status: "已添加",
            statusTone: "success",
            review: "正常",
            reviewTone: "success",
          }],
          marketingSummary: {
            activityTotal: 2,
            joinedActivityTotal: 1,
            joinedProductTotal: 1,
            issueProductTotal: 0,
          },
          selectedActivityId: "fixture-activity-a",
          selectedSourceType: "seller",
          selectedProductIds: ["fixture-product-a"],
          productScope: "joined",
          cachedAt: "2026-07-13T00:00:00.000Z",
        },
        "fixture-shop-b": {
          activityRows: [{
            id: "fixture-activity-b",
            title: "夹具活动 B",
            originalTitle: "夹具活动 B",
            source: "Ozon",
            sourceTone: "ozon",
            count: 1,
            description: "营销 SQLite 迁移夹具 B",
            available: 2,
            hasAvailableCount: true,
            estimate: "可参与",
            dateStart: "",
            dateEnd: "",
            isOnline: true,
            sourceType: "seller",
          }],
          productPool: [{
            id: "fixture-product-b",
            name: "夹具商品 B",
            offerId: "fixture-offer-b",
            ozonSku: "fixture-sku-b",
            sku: "fixture-sku-b",
            price: "119.99",
            sourceActivityPrice: "109.99",
            activityPrice: "99.99",
            stock: 5,
            status: "可添加",
            statusTone: "warning",
            review: "可处理",
            reviewTone: "warning",
          }],
          marketingSummary: {
            activityTotal: 1,
            joinedActivityTotal: 1,
            joinedProductTotal: 0,
            issueProductTotal: 0,
          },
          selectedActivityId: "fixture-activity-b",
          selectedSourceType: "seller",
          selectedProductIds: ["fixture-product-b"],
          productScope: "available",
          cachedAt: "2026-07-13T00:00:00.000Z",
        },
      },
    }],
    bootstrapLegacyEntries: createMarketingScopeBootstrapLegacyEntries([
      "fixture-shop-a",
      "fixture-shop-b",
    ]),
    canonicalKind: "marketing-activity-cache",
    recoveryRetainedKeys: [RETIRED_MARKETING_BROWSER_KEY],
    expectedSnapshotKeys: ["fixture-shop-a", "fixture-shop-b"],
    expectedMarketingSelections: {
      "fixture-shop-a": { activityId: "fixture-activity-a", sourceType: "seller" },
      "fixture-shop-b": { activityId: "fixture-activity-b", sourceType: "seller" },
    },
    expectedMarketingActivityVariants: {
      "fixture-shop-a": {
        activityId: "fixture-activity-a",
        sourceTypes: ["official", "seller"],
      },
    },
    recoveryShopIds: ["fixture-shop-a", "fixture-shop-b"],
  }),
  "product-material-profiles": Object.freeze({
    legacyEntries: [
      {
        key: RETIRED_OZON_SHOP_BROWSER_KEY,
        value: [{
          id: "fixture-material-shop",
          sellerName: "材积迁移夹具店铺",
          shopAlias: "材积迁移夹具",
          clientId: "fixture-material-client-id",
          apiKey: "test-material-api-key",
        }],
      },
      {
        key: RETIRED_PRODUCT_MATERIAL_BROWSER_KEY,
        value: {
        "fixture-material-shop:fixture-offer-a": {
          key: "fixture-material-shop:fixture-offer-a",
          shopId: "fixture-material-shop",
          offerId: "fixture-offer-a",
          source: "supplier-confirmed",
          weight: "0.25",
          length: "20",
          width: "10",
          height: "8",
          applyToProduct: true,
          isConfirmed: true,
        },
        "fixture-material-shop:fixture-offer-b": {
          key: "fixture-material-shop:fixture-offer-b",
          shopId: "fixture-material-shop",
          offerId: "fixture-offer-b",
          source: "cross-border-bus",
          weight: "0.5",
          length: "30",
          width: "12",
          height: "9",
          applyToProduct: true,
          isConfirmed: true,
        },
      },
      },
    ],
    canonicalKind: "product-material-profiles",
    recoveryShopIds: ["fixture-material-shop"],
    recoveryRetainedKeys: [RETIRED_PRODUCT_MATERIAL_BROWSER_KEY],
    expectedMaterialProfiles: [
      { shopId: "fixture-material-shop", offerId: "fixture-offer-a", source: "supplier-confirmed", weight: "0.25", length: "20", width: "10", height: "8" },
      { shopId: "fixture-material-shop", offerId: "fixture-offer-b", source: "cross-border-bus", weight: "0.5", length: "30", width: "12", height: "9" },
    ],
  }),
  "product-source-links": Object.freeze({
    legacyEntries: [
      {
        key: RETIRED_OZON_SHOP_BROWSER_KEY,
        value: [{
          id: "fixture-source-shop",
          sellerName: "来源链接迁移夹具店铺",
          shopAlias: "来源链接夹具",
          clientId: "fixture-source-client-id",
          apiKey: "test-source-api-key",
        }],
      },
      {
        key: RETIRED_PRODUCT_SOURCE_BROWSER_KEY,
        value: {
          "fixture-source-shop:fixture-offer": {
            links: [
              {
                link: "https://detail.1688.com/offer/1001.html",
                productId: "1001",
                platform: "1688",
                title: "夹具货源一",
                previewImageUrl: "https://img.test/fixture-source-1-preview.jpg",
                originalImageUrl: "https://img.test/fixture-source-1-original.jpg",
                priceValue: 12.5,
                qty: "2",
              },
              {
                link: "https://item.taobao.com/item.htm?id=1002",
                productId: "1002",
                platform: "淘宝",
                title: "夹具货源二",
                previewImageUrl: "https://img.test/fixture-source-2-preview.jpg",
                originalImageUrl: "https://img.test/fixture-source-2-original.jpg",
                priceValue: 18.75,
                qty: "1",
              },
            ],
            primaryIndex: 1,
            updatedAt: "2026-07-13T00:00:00.000Z",
          },
        },
      },
    ],
    canonicalKind: "product-source-links",
    recoveryShopIds: ["fixture-source-shop"],
    recoveryRetainedKeys: [RETIRED_PRODUCT_SOURCE_BROWSER_KEY],
    expectedSourceLinks: [
      { shopId: "fixture-source-shop", productKey: "fixture-offer", slotIndex: 0, isPrimary: false, productId: "1001", link: "https://detail.1688.com/offer/1001.html" },
      { shopId: "fixture-source-shop", productKey: "fixture-offer", slotIndex: 1, isPrimary: true, productId: "1002", link: "https://item.taobao.com/item.htm?id=1002" },
    ],
  }),
  "purchase-order-overrides": Object.freeze({
    legacyEntries: [{
      key: RETIRED_PURCHASE_OVERRIDE_BROWSER_KEY,
      value: {
        "fixture-purchase-order-1": {
          shopId: "fixture-purchase-override-shop",
          manualBuyerPlatform: "1688",
          manualPurchaseOrderNo: "fixture-purchase-no-1",
          manualPurchaseOrderUrl: "https://detail.1688.com/offer/fixture-purchase-1.html",
          manualPurchasePriceValue: 12.5,
          manualPurchaseOrderStatus: "已拍单",
          packageOrderId: "fixture-package-order-1",
          crossBorderStatus: "已创建预报",
          updatedAt: "2026-07-13T00:00:00.000Z",
        },
      },
    }],
    canonicalKind: "purchase-order-overrides",
    recoveryShopIds: ["fixture-purchase-override-shop"],
    recoveryRetainedKeys: [RETIRED_PURCHASE_OVERRIDE_BROWSER_KEY],
    expectedPurchaseOverrides: [{
      shopId: "fixture-purchase-override-shop",
      orderKey: "fixture-purchase-order-1",
      manualBuyerPlatform: "1688",
      manualPurchaseOrderNo: "fixture-purchase-no-1",
      manualPurchaseOrderUrl: "https://detail.1688.com/offer/fixture-purchase-1.html",
      manualPurchasePriceValue: 12.5,
      manualPurchaseOrderStatus: "已拍单",
      packageOrderId: "fixture-package-order-1",
      crossBorderStatus: "已创建预报",
    }],
  }),
  "purchase-source-links": Object.freeze({
    legacyEntries: [
      {
        key: RETIRED_OZON_SHOP_BROWSER_KEY,
        value: [{
          id: "fixture-purchase-source-shop",
          sellerName: "采购来源迁移夹具店铺",
          shopAlias: "采购来源夹具",
          clientId: "fixture-purchase-source-client",
          apiKey: "test-purchase-source-api-key",
        }],
      },
      {
        key: RETIRED_PURCHASE_SOURCE_BROWSER_KEY,
        value: {
          "fixture-purchase-source-client:fixture-purchase-source-order": {
            links: [
              {
                link: "https://detail.1688.com/offer/2001.html",
                productId: "2001",
                platform: "1688",
                title: "采购来源夹具一",
                previewImageUrl: "https://img.test/fixture-purchase-source-1-preview.jpg",
                originalImageUrl: "https://img.test/fixture-purchase-source-1-original.jpg",
                priceValue: 12.5,
                qty: "2",
              },
              {
                link: "https://item.taobao.com/item.htm?id=2002",
                productId: "2002",
                platform: "淘宝",
                title: "采购来源夹具二",
                previewImageUrl: "https://img.test/fixture-purchase-source-2-preview.jpg",
                originalImageUrl: "https://img.test/fixture-purchase-source-2-original.jpg",
                priceValue: 18.75,
                qty: "1",
              },
            ],
            primaryIndex: 1,
            updatedAt: "2026-07-13T00:00:00.000Z",
          },
        },
      },
    ],
    canonicalKind: "purchase-source-links",
    recoveryShopIds: ["fixture-purchase-source-shop"],
    recoveryRetainedKeys: [RETIRED_PURCHASE_SOURCE_BROWSER_KEY],
    expectedPurchaseSourceLinks: [
      {
        shopId: "fixture-purchase-source-shop",
        orderKey: "fixture-purchase-source-order",
        slotIndex: 0,
        isPrimary: false,
        sourceProductId: "2001",
        url: "https://detail.1688.com/offer/2001.html",
        previewImageUrl: "https://img.test/fixture-purchase-source-1-preview.jpg",
        originalImageUrl: "https://img.test/fixture-purchase-source-1-original.jpg",
      },
      {
        shopId: "fixture-purchase-source-shop",
        orderKey: "fixture-purchase-source-order",
        slotIndex: 1,
        isPrimary: true,
        sourceProductId: "2002",
        url: "https://item.taobao.com/item.htm?id=2002",
        previewImageUrl: "https://img.test/fixture-purchase-source-2-preview.jpg",
        originalImageUrl: "https://img.test/fixture-purchase-source-2-original.jpg",
      },
    ],
  }),
  "purchase-source-plugin-context": Object.freeze({
    legacyEntries: [{
      key: RETIRED_PURCHASE_PLUGIN_BROWSER_KEY,
      value: {
        shopId: "fixture-plugin-shop",
        shopClientId: "fixture-plugin-client",
        orderKey: "fixture-plugin-order",
        offerId: "fixture-plugin-offer",
        sku: "fixture-plugin-sku",
        productIndex: 1,
        productName: "采购插件来源夹具",
        lockedAt: "2026-07-13T00:00:00.000Z",
      },
    }],
    canonicalKind: "purchase-source-plugin-context",
    canonicalNamespace: "purchase-plugin-context",
    recoveryRetainedKeys: [RETIRED_PURCHASE_PLUGIN_BROWSER_KEY],
    expectedPurchasePluginContext: {
      shopId: "fixture-plugin-shop",
      shopClientId: "fixture-plugin-client",
      orderKey: "fixture-plugin-order",
      offerId: "fixture-plugin-offer",
      sku: "fixture-plugin-sku",
      productIndex: 1,
      productName: "采购插件来源夹具",
      lockedAt: "2026-07-13T00:00:00.000Z",
    },
  }),
  "sales-source-links": Object.freeze({
    legacyEntries: [
      { key: RETIRED_OZON_SHOP_BROWSER_KEY, value: [{ id: "fixture-sales-source-shop", sellerName: "销售来源迁移夹具店铺", shopAlias: "销售来源夹具", clientId: "fixture-sales-source-client", apiKey: "test-sales-source-api-key" }] },
      { key: RETIRED_SALES_SOURCE_BROWSER_KEY, value: {
        "fixture-sales-source-client:fixture-sales-source-order": {
          links: [{ link: "https://detail.1688.com/offer/3001.html", productId: "3001", platform: "1688", title: "销售来源夹具一", previewImageUrl: "https://img.test/fixture-sales-source-1-preview.jpg", originalImageUrl: "https://img.test/fixture-sales-source-1-original.jpg", priceValue: 11.5, qty: "2" }, { link: "https://item.taobao.com/item.htm?id=3002", productId: "3002", platform: "淘宝", title: "销售来源夹具二", previewImageUrl: "https://img.test/fixture-sales-source-2-preview.jpg", originalImageUrl: "https://img.test/fixture-sales-source-2-original.jpg", priceValue: 17.5, qty: "1" }],
          primaryIndex: 1,
          updatedAt: "2026-07-13T00:00:00.000Z",
        },
      } },
    ],
    canonicalKind: "sales-source-links",
    recoveryShopIds: ["fixture-sales-source-shop"],
    recoveryRetainedKeys: [RETIRED_SALES_SOURCE_BROWSER_KEY],
    expectedSalesSourceLinks: [
      { shopId: "fixture-sales-source-shop", orderKey: "fixture-sales-source-order", slotIndex: 0, isPrimary: false, sourceProductId: "3001", link: "https://detail.1688.com/offer/3001.html", previewImageUrl: "https://img.test/fixture-sales-source-1-preview.jpg", originalImageUrl: "https://img.test/fixture-sales-source-1-original.jpg" },
      { shopId: "fixture-sales-source-shop", orderKey: "fixture-sales-source-order", slotIndex: 1, isPrimary: true, sourceProductId: "3002", link: "https://item.taobao.com/item.htm?id=3002", previewImageUrl: "https://img.test/fixture-sales-source-2-preview.jpg", originalImageUrl: "https://img.test/fixture-sales-source-2-original.jpg" },
    ],
  }),
});

const RETIRED_LEGACY_RETIREMENT_FIXTURE_IDS = new Set([
  'marketing-activity-cache',
  'product-material-profiles',
  'product-source-links',
  'purchase-order-overrides',
  'purchase-source-links',
  'purchase-source-plugin-context',
  'sales-source-links',
]);

function getLegacyRetirementFixture(id, variant = "minimum") {
  if (RETIRED_LEGACY_RETIREMENT_FIXTURE_IDS.has(String(id || '').trim())) {
    throw new Error(`已退役的旧浏览器副本夹具不得再被启动：${id}`);
  }
  const fixture = LEGACY_RETIREMENT_FIXTURES[String(id || "").trim()];
  if (!fixture) throw new Error(`未知旧浏览器副本退役夹具：${id || "missing"}`);
  if (variant === "maximum") {
    if (id === "purchase-source-plugin-context") {
      return Object.freeze({
        ...fixture,
        ...createMaximumPurchasePluginContextFixture(),
      });
    }
    if (id === "ozon-shop-settings") {
      return Object.freeze({
        ...fixture,
        ...createMaximumOzonShopSettingsFixture(),
      });
    }
    if (id === "marketing-activity-cache") {
      return Object.freeze({
        ...fixture,
        ...createMaximumMarketingActivityCacheFixture(),
      });
    }
    if (id === "product-material-profiles") {
      return Object.freeze({
        ...fixture,
        ...createMaximumProductMaterialProfilesFixture(),
      });
    }
    if (id === "product-source-links") {
      return Object.freeze({
        ...fixture,
        ...createMaximumProductSourceLinksFixture(),
      });
    }
    if (id === "purchase-order-overrides") {
      return Object.freeze({
        ...fixture,
        ...createMaximumPurchaseOrderOverridesFixture(),
      });
    }
    if (id === "purchase-source-links") {
      return Object.freeze({
        ...fixture,
        ...createMaximumPurchaseSourceLinksFixture(),
      });
    }
    if (id === "sales-source-links") {
      return Object.freeze({
        ...fixture,
        ...createMaximumSalesSourceLinksFixture(),
      });
    }
    throw new Error(`旧浏览器副本退役夹具尚未实现最大量验证：${id || "missing"}`);
  }
  return fixture;
}

const LEGACY_RETIREMENT_MARKETING_CACHE_STORAGE_KEY = RETIRED_MARKETING_BROWSER_KEY;
const LEGACY_RETIREMENT_MARKETING_FILE_SEED_ENV =
  "WANGZAI_LEGACY_RETIREMENT_SEED_MARKETING_FILE";
const LEGACY_RETIREMENT_MARKETING_FILE_SOURCE_PHASES = new Set([
  "seed",
  "bad",
  "write-error",
  "readback-error",
  "max",
  "recovery-failure",
]);
const LEGACY_RETIREMENT_MARKETING_FILE_DIRECTORY = path.join(
  "分类缓存",
  "12-营销活动",
);
const LEGACY_RETIREMENT_MARKETING_FILE_NAME =
  "marketing-activity-cache.json";

function getLegacyRetirementMarketingFilePath() {
  const localDataRoot = String(
    process.env.WANGZAI_DESKTOP_LOCAL_DATA_DIR || "",
  ).trim();
  if (!localDataRoot) {
    throw new Error("营销旧 JSON 夹具缺少显式 local-data 目录。");
  }
  return path.join(
    path.resolve(localDataRoot),
    LEGACY_RETIREMENT_MARKETING_FILE_DIRECTORY,
    LEGACY_RETIREMENT_MARKETING_FILE_NAME,
  );
}

function getLegacyRetirementMarketingFilePayload(fixture) {
  const entry = (fixture?.legacyEntries || []).find(
    (candidate) =>
      String(candidate?.key || "").trim() ===
      LEGACY_RETIREMENT_MARKETING_CACHE_STORAGE_KEY,
  );
  if (
    !entry ||
    !entry.value ||
    typeof entry.value !== "object" ||
    Array.isArray(entry.value)
  ) {
    throw new Error("营销旧 JSON 夹具缺少合法 browser payload。");
  }
  return entry.value;
}

/**
 * The normal R8 runner already seeds the browser copy through preload. This
 * separate, env-gated write adds the real retired local-data file without
 * changing any production path or the other fixture families. It runs before
 * the renderer starts, so the migration must prove both browser and file
 * cleanup/retention through the production app protocol.
 */
function seedLegacyRetirementMarketingFile({ fixture, phase }) {
  if (process.env[LEGACY_RETIREMENT_MARKETING_FILE_SEED_ENV] !== "1") {
    return null;
  }
  if (fixture?.canonicalKind !== "marketing-activity-cache") {
    throw new Error("营销旧 JSON seed gate 被错误用于非营销 fixture。");
  }
  if (!LEGACY_RETIREMENT_MARKETING_FILE_SOURCE_PHASES.has(phase)) {
    throw new Error(`营销旧 JSON seed gate 用于非 source 阶段：${phase || "missing"}`);
  }

  const filePath = getLegacyRetirementMarketingFilePath();
  if (fsSync.existsSync(filePath)) {
    throw new Error("营销旧 JSON 夹具目标文件在 source 阶段开始前已存在。");
  }
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  const raw =
    phase === "bad"
      ? "{legacy-retirement-malformed-json"
      : JSON.stringify(getLegacyRetirementMarketingFilePayload(fixture));
  fsSync.writeFileSync(filePath, raw, "utf8");
  if (!fsSync.existsSync(filePath)) {
    throw new Error("营销旧 JSON 夹具未能写入显式 local-data 目录。");
  }
  return Object.freeze({
    filePath,
    seeded: true,
    existsAtPhaseStart: true,
  });
}

function createLegacyRetirementMarketingFileEvidence(fixture, seededFile) {
  if (fixture?.canonicalKind !== "marketing-activity-cache") return null;
  const filePath = seededFile?.filePath || getLegacyRetirementMarketingFilePath();
  return Object.freeze({
    filePath,
    seeded: seededFile?.seeded === true,
    existsAtPhaseStart: fsSync.existsSync(filePath),
  });
}

function writeLegacyRetirementSeedFile({ fixtureId, entries }) {
  const dataRoot = String(process.env.WANGZAI_DESKTOP_DATA_DIR || "").trim();
  if (!dataRoot) throw new Error("最大量旧浏览器副本退役夹具缺少隔离数据根。");
  const resolvedDataRoot = path.resolve(dataRoot);
  const seedPath = path.join(
    resolvedDataRoot,
    `legacy-retirement-seed-${String(fixtureId || "fixture").replaceAll(/[^a-z0-9-]/giu, "-")}.json`,
  );
  fsSync.writeFileSync(seedPath, JSON.stringify(entries), "utf8");
  return seedPath;
}

function readLegacyRetirementSeedFile(seedFilePath) {
  const dataRoot = String(process.env.WANGZAI_DESKTOP_DATA_DIR || "").trim();
  if (!dataRoot) return "";
  const resolvedDataRoot = path.resolve(dataRoot);
  const resolvedSeedFile = path.resolve(String(seedFilePath || ""));
  const relativeSeedPath = path.relative(resolvedDataRoot, resolvedSeedFile);
  if (
    relativeSeedPath === "" ||
    relativeSeedPath === ".." ||
    relativeSeedPath.startsWith(`..${path.sep}`)
  ) return "";
  try {
    const stat = fsSync.statSync(resolvedSeedFile);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return "";
    return fsSync.readFileSync(resolvedSeedFile, "utf8");
  } catch (_error) {
    return "";
  }
}

async function seedLegacyRetirementCanonicalShops(baseUrl, authToken, entries = []) {
  const shops = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.key === RETIRED_OZON_SHOP_BROWSER_KEY)
    .flatMap((entry) => Array.isArray(entry?.value) ? entry.value : []);
  if (!shops.length) return;
  for (const shop of shops) {
    const id = String(shop?.id || '').trim();
    if (!id) continue;
    const response = await fetch(`${baseUrl}/api/shops`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-wangzai-local-api-token': authToken,
      },
      body: JSON.stringify({
        id,
        name: String(shop?.sellerName || shop?.name || shop?.shopAlias || id),
        alias: String(shop?.shopAlias || shop?.alias || ''),
        clientId: String(shop?.clientId || ''),
        apiKey: String(shop?.apiKey || ''),
        status: String(shop?.status || 'active'),
      }),
    });
    if (!response.ok) throw new Error(`LEGACY_RETIREMENT_CANONICAL_SHOP_SEED_FAILED:${response.status}`);
  }
}

async function waitForLegacyRetirementFixture(
  webContents,
  fixture,
  timeoutMs = 20_000,
  expectRetention = false,
  expectCanonicalWithRetainedLegacy = false,
  retainedLegacyKeys = [],
  {
    legacyMarketingFileEvidence = null,
    expectLegacyMarketingFileRetention = false,
  } = {},
) {
  const marketingFileEvidence = legacyMarketingFileEvidence
    ? {
      filePath: String(legacyMarketingFileEvidence.filePath || "").trim(),
      seeded: legacyMarketingFileEvidence.seeded === true,
      existsAtPhaseStart: legacyMarketingFileEvidence.existsAtPhaseStart === true,
    }
    : null;
  if (marketingFileEvidence && !marketingFileEvidence.filePath) {
    throw new Error("营销旧 JSON 夹具缺少文件证据路径。");
  }
  // The renderer needs legacy key names for presence checks, never the fixture
  // values. Keep test credentials and large seed payloads in the main process.
  const fixtureLegacyEntries = (fixture?.legacyEntries || [])
    .map((entry) => ({ key: String(entry?.key || '').trim() }))
    .filter((entry) => entry.key);
  const explicitRetainedLegacyKeys = Array.isArray(retainedLegacyKeys)
    ? [...new Set(retainedLegacyKeys.map((key) => String(key || '').trim()).filter(Boolean))]
    : [];
  const usesExplicitRetainedLegacyKeys = explicitRetainedLegacyKeys.length > 0;
  const rendererFixture = {
    ...fixture,
    legacyEntries: fixtureLegacyEntries,
    retainedLegacyKeys: usesExplicitRetainedLegacyKeys
      ? explicitRetainedLegacyKeys
      : fixtureLegacyEntries.map((entry) => entry.key),
    retentionScope: usesExplicitRetainedLegacyKeys ? 'explicit-target' : 'all-fixture-keys',
  };
  const serializedFixture = JSON.stringify(rendererFixture);
  const startedAt = Date.now();
  let lastResult = null;
  while (Date.now() - startedAt < timeoutMs) {
    const rendererResult = await webContents
      .executeJavaScript(
        `(async () => {
        const fixture = ${serializedFixture};
        const browserLegacyClearCount = Number(
          window.wangzaiDesktop?.legacyRetirementBrowserClearCount || 0,
        );
        const legacyEntryCount = (fixture.legacyEntries || []).length;
        const legacyRetainedCount = (fixture.legacyEntries || []).filter((entry) => window.localStorage.getItem(entry.key) !== null).length;
        const retainedLegacyEntryKeys = (fixture.legacyEntries || [])
          .filter((entry) => window.localStorage.getItem(entry.key) !== null)
          .map((entry) => entry.key);
        const requiredLegacyKeys = Array.isArray(fixture.retainedLegacyKeys) ? fixture.retainedLegacyKeys : [];
        const requiredLegacyEntryCount = requiredLegacyKeys.length;
        const requiredLegacyRetainedCount = requiredLegacyKeys.filter((key) => window.localStorage.getItem(key) !== null).length;
        const retainedRequiredLegacyKeys = requiredLegacyKeys.filter((key) => window.localStorage.getItem(key) !== null);
        const requiredLegacyKeySet = new Set(requiredLegacyKeys);
        const unexpectedRetainedLegacyKeys = (fixture.legacyEntries || [])
          .map((entry) => String(entry?.key || '').trim())
          .filter((key) => key && !requiredLegacyKeySet.has(key) && window.localStorage.getItem(key) !== null);
        const retentionEvidence = {
          retentionScope: String(fixture.retentionScope || 'all-fixture-keys'),
          declaredRecoveryRetainedKeys: Array.isArray(fixture.recoveryRetainedKeys)
            ? fixture.recoveryRetainedKeys.map((key) => String(key || '').trim()).filter(Boolean)
            : [],
          requiredLegacyEntryKeys: requiredLegacyKeys,
          unexpectedRetainedLegacyKeys,
        };
        const legacyPresent = legacyRetainedCount > 0;
        const requestLocalApi = window.wangzaiDesktop?.localApiRequest;
        if (typeof requestLocalApi !== 'function') {
          return { legacyPresent, legacyEntryCount, legacyRetainedCount, retainedLegacyEntryKeys, requiredLegacyEntryCount, requiredLegacyRetainedCount, retainedRequiredLegacyKeys, ...retentionEvidence, browserLegacyClearCount, canonicalPresent: false, reason: 'LOCAL_API_IPC_BRIDGE_MISSING' };
        }
        try {
          const response = fixture.canonicalNamespace
            ? await requestLocalApi({
              path: '/api/profile-settings/' + encodeURIComponent(fixture.canonicalNamespace),
              method: 'GET',
              headers: { accept: 'application/json' },
              timeoutMs: 10_000,
            })
            : null;
          const value = response?.ok ? response.data?.setting?.value : null;
          const sha256Hex = async (input) => {
            if (!globalThis.crypto?.subtle) return '';
            return Array.from(
              new Uint8Array(
                await globalThis.crypto.subtle.digest(
                  'SHA-256',
                  new TextEncoder().encode(JSON.stringify(input)),
                ),
              ),
              (byte) => byte.toString(16).padStart(2, '0'),
            ).join('');
          };
          // Marketing's canonical evidence is one public SQLite snapshot per
          // explicitly mapped shop. Never read the local-data API here: that
          // file is a migration input and would create a false recovery pass.
          const marketingSnapshotShopIds = fixture.canonicalKind === 'marketing-activity-cache'
            ? (
              Array.isArray(fixture.expectedSnapshotKeys) && fixture.expectedSnapshotKeys.length
                ? fixture.expectedSnapshotKeys
                : Array.isArray(fixture.recoveryShopIds)
                  ? fixture.recoveryShopIds
                  : []
            ).map((shopId) => String(shopId || '').trim()).filter(Boolean)
            : [];
          const marketingSnapshotResponses = fixture.canonicalKind === 'marketing-activity-cache'
            ? await Promise.all(marketingSnapshotShopIds.map(async (shopId) => ({
              shopId,
              response: await requestLocalApi({
                path: '/api/cache/marketing?scope=snapshot&shopId=' + encodeURIComponent(shopId),
                method: 'GET',
                timeoutMs: 10_000,
              }),
            })))
            : [];
          const marketingCacheStore = Object.fromEntries(
            marketingSnapshotResponses
              .filter(({ shopId, response: snapshotResponse }) => (
                Boolean(shopId) &&
                snapshotResponse?.ok === true &&
                snapshotResponse?.data?.ok !== false &&
                snapshotResponse?.data?.found === true &&
                snapshotResponse?.data?.snapshot &&
                typeof snapshotResponse.data.snapshot === 'object'
              ))
              .map(({ shopId, response: snapshotResponse }) => [shopId, snapshotResponse.data.snapshot]),
          );
          const marketingCacheResponse = fixture.canonicalKind === 'marketing-activity-cache'
            ? {
              ok: marketingSnapshotShopIds.length > 0 &&
                marketingSnapshotResponses.length === marketingSnapshotShopIds.length &&
                marketingSnapshotResponses.every(({ response: snapshotResponse }) => (
                  snapshotResponse?.ok === true &&
                  snapshotResponse?.data?.ok !== false &&
                  snapshotResponse?.data?.found === true &&
                  snapshotResponse?.data?.snapshot &&
                  typeof snapshotResponse.data.snapshot === 'object'
                )),
              status: marketingSnapshotResponses.find(({ response: snapshotResponse }) => snapshotResponse?.ok !== true)
                ?.response?.status || marketingSnapshotResponses[0]?.response?.status || 0,
              data: marketingCacheStore,
              snapshots: marketingSnapshotResponses,
            }
            : null;
          // Cursor mode is a test-only public DTO, deliberately distinct from
          // ordinary UI list endpoints. A migration source is cleared only
          // after this reader proves every declared row was received exactly
          // once; a bad cursor, changing total or page ceiling fails closed.
          const readEveryLegacyCursorPage = async (route, pageSize = 1000) => {
            const normalizedPageSize = Math.min(
              Math.max(Number(pageSize) || 1000, 1),
              1000,
            );
            const rows = [];
            const seenCursors = new Set();
            let cursor = '';
            let total = null;
            let pageCount = 0;
            let responseStatus = 0;
            const fail = (reason, pageLimitReached = false) => ({
              ok: false,
              status: responseStatus,
              data: { rows: [], total: total === null ? 0 : total },
              pageCount,
              pageLimitReached,
              complete: false,
              reason,
              rowsRead: rows.length,
            });
            while (pageCount < ${LEGACY_RETIREMENT_CURSOR_READBACK_MAX_PAGES}) {
              const query = new URLSearchParams({
                cursorMode: 'legacy-migration',
                limit: String(normalizedPageSize),
              });
              if (cursor) query.set('cursor', cursor);
              const pageResponse = await requestLocalApi({
                path: route + '?' + query.toString(),
                method: 'GET',
                timeoutMs: 30_000,
              });
              responseStatus = pageResponse?.status || responseStatus;
              pageCount += 1;
              if (pageResponse?.ok !== true || pageResponse?.data?.ok !== true) {
                return fail('CURSOR_PAGE_REQUEST_FAILED');
              }
              const pageRows = Array.isArray(pageResponse.data.rows)
                ? pageResponse.data.rows
                : null;
              const pageTotal = Number(pageResponse.data.total);
              const hasMore = pageResponse.data.hasMore;
              const nextCursor = typeof pageResponse.data.nextCursor === 'string'
                ? pageResponse.data.nextCursor.trim()
                : '';
              if (
                pageRows === null ||
                !Number.isSafeInteger(pageTotal) ||
                pageTotal < 0 ||
                typeof hasMore !== 'boolean'
              ) {
                return fail('CURSOR_PAGE_SHAPE_INVALID');
              }
              if (
                (total !== null && total !== pageTotal) ||
                rows.length + pageRows.length > pageTotal
              ) {
                return fail('CURSOR_PAGE_TOTAL_MISMATCH');
              }
              if (total === null) total = pageTotal;
              rows.push(...pageRows);
              if (!hasMore) {
                if (nextCursor || rows.length !== total) {
                  return fail('CURSOR_PAGE_INCOMPLETE');
                }
                return {
                  ok: true,
                  status: responseStatus,
                  data: { rows, total },
                  pageCount,
                  pageLimitReached: false,
                  complete: true,
                };
              }
              if (!nextCursor || seenCursors.has(nextCursor)) {
                return fail('CURSOR_NEXT_CURSOR_INVALID');
              }
              seenCursors.add(nextCursor);
              cursor = nextCursor;
            }
            return fail('CURSOR_PAGE_LIMIT_REACHED', true);
          };
          const isCompleteLegacyCursorReadback = (result) =>
            result?.ok === true &&
            result?.complete === true &&
            result?.pageLimitReached === false;
          const shopsResponse = fixture.canonicalKind === 'ozon-shop-settings'
            ? await readEveryLegacyCursorPage('/api/shops')
            : null;
          const materialProfilesResponse = fixture.canonicalKind === 'product-material-profiles'
            ? await readEveryLegacyCursorPage(
              '/api/products/material',
              Number(fixture.maxExpectation?.pageSize || ${LEGACY_RETIREMENT_MAX_SUPPORT_PAGE_SIZE}),
            )
            : null;
          const productSourceLinksResponse = fixture.canonicalKind === 'product-source-links'
            ? await readEveryLegacyCursorPage(
              '/api/products/source-links',
              Number(fixture.maxExpectation?.pageSize || ${LEGACY_RETIREMENT_MAX_SUPPORT_PAGE_SIZE}),
            )
            : null;
          const purchaseOverridesResponse = fixture.canonicalKind === 'purchase-order-overrides'
            ? await readEveryLegacyCursorPage(
              '/api/purchase/orders/overrides',
              Number(fixture.maxExpectation?.pageSize || 1000),
            )
            : null;
          const purchaseSourceLinksResponse = fixture.canonicalKind === 'purchase-source-links'
            ? await readEveryLegacyCursorPage(
              '/api/purchase/source-links',
              Number(fixture.maxExpectation?.pageSize || 1000),
            )
            : null;
          const purchasePluginContextResponse = fixture.canonicalKind === 'purchase-source-plugin-context'
            ? response
            : null;
          const salesSourceLinksResponse = fixture.canonicalKind === 'sales-source-links'
            ? await readEveryLegacyCursorPage(
              '/api/sales/source-links',
              Number(fixture.maxExpectation?.pageSize || 1000),
            )
            : null;
          const preferences = response?.ok ? response.data?.setting?.value : null;
          const preferenceShop = Array.isArray(preferences?.shops)
            ? preferences.shops.find((shop) => shop?.id === fixture.expectedShopId)
            : null;
          const shopRecord = Array.isArray(shopsResponse?.data?.rows)
            ? shopsResponse.data.rows.find((shop) => shop?.id === fixture.expectedShopId)
            : null;
          const preferenceShops = Array.isArray(preferences?.shops) ? preferences.shops : [];
          const localShopRows = Array.isArray(shopsResponse?.data?.rows) ? shopsResponse.data.rows : [];
          const expectedShopCount = Number.isInteger(fixture.expectedShopCount) ? fixture.expectedShopCount : 0;
          const expectedWarehouseCount = Number.isInteger(fixture.expectedWarehouseCount)
            ? fixture.expectedWarehouseCount
            : 0;
          const normalizedPreferenceShops = preferenceShops
            .map((shop) => ({
              id: String(shop?.id || ''),
              shopAlias: String(shop?.shopAlias || ''),
              sellerName: String(shop?.sellerName || ''),
              connectionStatus: String(shop?.connectionStatus || ''),
              connectionMessage: String(shop?.connectionMessage || ''),
              connectionDetail: String(shop?.connectionDetail || ''),
              lastTestAt: String(shop?.lastTestAt || ''),
              savedAt: String(shop?.savedAt || ''),
              purchaseManagementStartedAt: String(shop?.purchaseManagementStartedAt || ''),
              purchaseManagementResetAt: String(shop?.purchaseManagementResetAt || ''),
              remark: String(shop?.remark || ''),
              status: String(shop?.status || ''),
            }))
            .sort((left, right) => left.id.localeCompare(right.id));
          const normalizedPublicShops = localShopRows
            .map((shop) => ({
              id: String(shop?.id || ''),
              name: String(shop?.name || ''),
              alias: String(shop?.alias || ''),
              status: String(shop?.status || ''),
              hasClientId: shop?.hasClientId === true,
              hasApiKey: shop?.hasApiKey === true,
            }))
            .sort((left, right) => left.id.localeCompare(right.id));
          const normalizedWarehouseEntries = Object.entries(preferences?.defaultWarehouseIds || {})
            .map(([shopId, warehouseId]) => [String(shopId), String(warehouseId)])
            .sort(([left], [right]) => left.localeCompare(right));
          const preferenceShopDigest = fixture.expectedPreferenceShopDigest
            ? await sha256Hex(normalizedPreferenceShops)
            : '';
          const publicShopDigest = fixture.expectedPublicShopDigest
            ? await sha256Hex(normalizedPublicShops)
            : '';
          const warehouseDigest = fixture.expectedWarehouseDigest
            ? await sha256Hex(normalizedWarehouseEntries)
            : '';
          const ozonShopMaximumMatches = expectedShopCount > 0
            ? isCompleteLegacyCursorReadback(shopsResponse) &&
              preferenceShops.length === expectedShopCount &&
              localShopRows.length === expectedShopCount &&
              normalizedWarehouseEntries.length === expectedWarehouseCount &&
              preferenceShopDigest === fixture.expectedPreferenceShopDigest &&
              publicShopDigest === fixture.expectedPublicShopDigest &&
              warehouseDigest === fixture.expectedWarehouseDigest
            : true;
          const minimumOzonShopSettingsPresent = response?.ok === true &&
            isCompleteLegacyCursorReadback(shopsResponse) &&
            preferences?.activeShopId === fixture.expectedShopId &&
            preferences?.defaultWarehouseIds?.[fixture.expectedShopId] === fixture.expectedWarehouseId &&
            preferenceShop?.id === fixture.expectedShopId &&
            shopRecord?.id === fixture.expectedShopId && shopRecord?.hasClientId === true && shopRecord?.hasApiKey === true;
          const ozonShopSettingsPresent = minimumOzonShopSettingsPresent && ozonShopMaximumMatches;
          const marketingSnapshotKeys = Array.isArray(fixture.expectedSnapshotKeys) ? fixture.expectedSnapshotKeys : [];
          const expectedMarketingSelections = fixture.expectedMarketingSelections && typeof fixture.expectedMarketingSelections === 'object'
            ? fixture.expectedMarketingSelections
            : {};
          const expectedMarketingActivityVariants = fixture.expectedMarketingActivityVariants && typeof fixture.expectedMarketingActivityVariants === 'object'
            ? fixture.expectedMarketingActivityVariants
            : {};
          const marketingSelectionMatches = Object.entries(expectedMarketingSelections).every(([shopKey, expected]) => {
            const snapshot = marketingCacheStore?.[shopKey];
            return String(snapshot?.selectedActivityId || '') === String(expected?.activityId || '') &&
              String(snapshot?.selectedSourceType || '') === String(expected?.sourceType || '');
          });
          const marketingActivityVariantsMatch = Object.entries(expectedMarketingActivityVariants).every(([shopKey, expected]) => {
            const rows = Array.isArray(marketingCacheStore?.[shopKey]?.activityRows)
              ? marketingCacheStore[shopKey].activityRows
              : [];
            const activityId = String(expected?.activityId || '');
            const sourceTypes = Array.isArray(expected?.sourceTypes) ? expected.sourceTypes : [];
            return sourceTypes.every((sourceType) => rows.some((activity) => (
              String(activity?.id || '') === activityId &&
              String(activity?.sourceType || '') === String(sourceType || '')
            )));
          });
          const marketingMinimumPresent = marketingSnapshotKeys.every((shopKey) => {
            const snapshot = marketingCacheStore?.[shopKey];
            return Array.isArray(snapshot?.activityRows) && snapshot.activityRows.some((activity) => activity?.id === 'fixture-activity-' + shopKey.slice(-1)) &&
              Array.isArray(snapshot?.productPool) && snapshot.productPool.some((product) => product?.id === 'fixture-product-' + shopKey.slice(-1));
          }) && marketingSelectionMatches && marketingActivityVariantsMatch;
          const expectedMarketingSnapshotCount = Number.isInteger(fixture.expectedMarketingSnapshotCount)
            ? fixture.expectedMarketingSnapshotCount
            : 0;
          const expectedMarketingActivityCount = Number.isInteger(fixture.expectedMarketingActivityCount)
            ? fixture.expectedMarketingActivityCount
            : 0;
          const expectedMarketingProductCount = Number.isInteger(fixture.expectedMarketingProductCount)
            ? fixture.expectedMarketingProductCount
            : 0;
          const expectedMarketingTotalRowCount = Number.isInteger(fixture.expectedMarketingTotalRowCount)
            ? fixture.expectedMarketingTotalRowCount
            : 0;
          const normalizedMarketingSnapshots = Object.entries(marketingCacheStore)
            .map(([shopId, snapshot]) => ({
              shopId: String(shopId || ''),
              activityRows: (Array.isArray(snapshot?.activityRows) ? snapshot.activityRows : []).map((activity) => ({
                id: String(activity?.id || ''),
                title: String(activity?.title || ''),
                originalTitle: String(activity?.originalTitle || ''),
                source: String(activity?.source || ''),
                sourceTone: String(activity?.sourceTone || ''),
                count: Number(activity?.count || 0),
                description: String(activity?.description || ''),
                available: Number(activity?.available || 0),
                hasAvailableCount: activity?.hasAvailableCount === true,
                estimate: String(activity?.estimate || ''),
                dateStart: String(activity?.dateStart || ''),
                dateEnd: String(activity?.dateEnd || ''),
                isOnline: activity?.isOnline === true,
                sourceType: String(activity?.sourceType || ''),
              })),
              productPool: (Array.isArray(snapshot?.productPool) ? snapshot.productPool : []).map((product) => ({
                id: String(product?.id || ''),
                name: String(product?.name || ''),
                offerId: String(product?.offerId || ''),
                ozonSku: String(product?.ozonSku || ''),
                sku: String(product?.sku || ''),
                price: String(product?.price || ''),
                sourceActivityPrice: String(product?.sourceActivityPrice || ''),
                activityPrice: String(product?.activityPrice || ''),
                // Public marketing snapshot DTO keeps stock as a display
                // string; mirror the expected fixture digest exactly.
                stock: String(product?.stock ?? ''),
                status: String(product?.status || ''),
                statusTone: String(product?.statusTone || ''),
                review: String(product?.review || ''),
                reviewTone: String(product?.reviewTone || ''),
              })),
              marketingSummary: {
                activityTotal: Number(snapshot?.marketingSummary?.activityTotal || 0),
                joinedActivityTotal: Number(snapshot?.marketingSummary?.joinedActivityTotal || 0),
                joinedProductTotal: Number(snapshot?.marketingSummary?.joinedProductTotal || 0),
                issueProductTotal: Number(snapshot?.marketingSummary?.issueProductTotal || 0),
              },
              selectedActivityId: String(snapshot?.selectedActivityId || ''),
              selectedSourceType: String(snapshot?.selectedSourceType || ''),
              productScope: String(snapshot?.productScope || ''),
              selectedProductIds: Array.isArray(snapshot?.selectedProductIds)
                ? snapshot.selectedProductIds.map((id) => String(id || ''))
                : [],
              cachedAt: String(snapshot?.cachedAt || ''),
            }))
            .sort((left, right) => left.shopId.localeCompare(right.shopId));
          const marketingProductCount = normalizedMarketingSnapshots.reduce(
            (count, snapshot) => count + snapshot.productPool.length,
            0,
          );
          const marketingActivityCount = normalizedMarketingSnapshots.reduce(
            (count, snapshot) => count + snapshot.activityRows.length,
            0,
          );
          const marketingTotalRowCount = marketingActivityCount + marketingProductCount;
          const marketingSnapshotDigest = fixture.expectedMarketingSnapshotDigest
            ? await sha256Hex(normalizedMarketingSnapshots)
            : '';
          const marketingCacheMaximumMatches = expectedMarketingSnapshotCount > 0
            ? normalizedMarketingSnapshots.length === expectedMarketingSnapshotCount &&
              marketingActivityCount === expectedMarketingActivityCount &&
              marketingProductCount === expectedMarketingProductCount &&
              marketingTotalRowCount === expectedMarketingTotalRowCount &&
              marketingSnapshotDigest === fixture.expectedMarketingSnapshotDigest
            : true;
          const marketingCachePresent = marketingCacheResponse?.ok === true &&
            marketingMinimumPresent && marketingCacheMaximumMatches;
          const expectedMaterialProfiles = Array.isArray(fixture.expectedMaterialProfiles) ? fixture.expectedMaterialProfiles : [];
          // Cursor migration mode deliberately has one typed DTO for
          // every high-cardinality collection. Do not fall back to the normal
          // UI endpoint aliases here: that could make a partial UI page look
          // like a successful full migration readback.
          const materialProfileRows = Array.isArray(materialProfilesResponse?.data?.rows)
            ? materialProfilesResponse.data.rows
            : [];
          const expectedMaterialProfileCount = Number.isInteger(fixture.expectedMaterialProfileCount)
            ? fixture.expectedMaterialProfileCount
            : 0;
          const normalizedMaterialProfiles = materialProfileRows
            .map((profile) => ({
              key: String(profile?.key || ''),
              shopId: String(profile?.shopId || ''),
              productId: String(profile?.productId || ''),
              offerId: String(profile?.offerId || ''),
              ozonSku: String(profile?.ozonSku || profile?.sku || ''),
              source: String(profile?.source || ''),
              weight: String(profile?.weight || ''),
              length: String(profile?.length || ''),
              width: String(profile?.width || ''),
              height: String(profile?.height || ''),
              applyToProduct: profile?.applyToProduct === true,
              isConfirmed: profile?.isConfirmed === true,
            }))
            .sort((left, right) => left.key.localeCompare(right.key));
          const materialProfileDigest = fixture.expectedMaterialProfileDigest
            ? await sha256Hex(normalizedMaterialProfiles)
            : '';
          const materialProfileMaximumMatches = expectedMaterialProfileCount > 0
            ? isCompleteLegacyCursorReadback(materialProfilesResponse) &&
              materialProfileRows.length === expectedMaterialProfileCount &&
              materialProfileDigest === fixture.expectedMaterialProfileDigest &&
              materialProfilesResponse?.pageCount === Number(fixture.maxExpectation?.pageCount || 0)
            : true;
          const materialProfilesPresent = isCompleteLegacyCursorReadback(materialProfilesResponse) && expectedMaterialProfiles.every((expected) =>
            materialProfileRows.some((profile) =>
              profile?.shopId === expected.shopId && profile?.offerId === expected.offerId &&
              profile?.source === expected.source && String(profile?.weight ?? '') === String(expected.weight) &&
              String(profile?.length ?? '') === String(expected.length) && String(profile?.width ?? '') === String(expected.width) &&
              String(profile?.height ?? '') === String(expected.height)
            )
          ) && materialProfileMaximumMatches;
          const expectedSourceLinks = Array.isArray(fixture.expectedSourceLinks) ? fixture.expectedSourceLinks : [];
          const productSourceRows = Array.isArray(productSourceLinksResponse?.data?.rows)
            ? productSourceLinksResponse.data.rows
            : [];
          const expectedProductSourceLinkCount = Number.isInteger(fixture.expectedProductSourceLinkCount)
            ? fixture.expectedProductSourceLinkCount
            : 0;
          const normalizedProductSourceLinks = productSourceRows
            .map((link) => ({
              shopId: String(link?.shopId || ''),
              productKey: String(link?.productKey || ''),
              slotIndex: Number(link?.slotIndex || 0),
              isPrimary: link?.isPrimary === true,
              platform: String(link?.platform || ''),
              link: String(link?.link || ''),
              productId: String(link?.productId || link?.sourceProductId || ''),
              title: String(link?.title || ''),
              imageUrl: String(link?.imageUrl || ''),
              previewImageUrl: String(link?.previewImageUrl || ''),
              originalImageUrl: String(link?.originalImageUrl || ''),
              priceValue: link?.priceValue === null || link?.priceValue === undefined ? null : Number(link.priceValue),
              currencyCode: String(link?.currencyCode || ''),
              qty: String(link?.qty || ''),
            }))
            .sort((left, right) =>
              (left.shopId + ':' + left.productKey + ':' + left.slotIndex).localeCompare(
                right.shopId + ':' + right.productKey + ':' + right.slotIndex,
              ),
            );
          const productSourceLinkDigest = fixture.expectedProductSourceLinkDigest
            ? await sha256Hex(normalizedProductSourceLinks)
            : '';
          const productSourceLinkMaximumMatches = expectedProductSourceLinkCount > 0
            ? isCompleteLegacyCursorReadback(productSourceLinksResponse) &&
              productSourceRows.length === expectedProductSourceLinkCount &&
              productSourceLinksResponse?.pageCount === Number(fixture.maxExpectation?.pageCount || 0) &&
              productSourceLinkDigest === fixture.expectedProductSourceLinkDigest
            : true;
          const productSourceLinksPresent = isCompleteLegacyCursorReadback(productSourceLinksResponse) && expectedSourceLinks.every((expected) =>
            productSourceRows.some((link) =>
              link?.shopId === expected.shopId && link?.productKey === expected.productKey &&
              Number(link?.slotIndex) === expected.slotIndex && Boolean(link?.isPrimary) === expected.isPrimary &&
              link?.productId === expected.productId && link?.link === expected.link
            )
          ) && productSourceLinkMaximumMatches;
          const expectedPurchaseOverrides = Array.isArray(fixture.expectedPurchaseOverrides)
            ? fixture.expectedPurchaseOverrides
            : [];
          const purchaseOverrideRows = Array.isArray(purchaseOverridesResponse?.data?.rows)
            ? purchaseOverridesResponse.data.rows
            : [];
          const expectedPurchaseOverrideCount = Number.isInteger(fixture.expectedPurchaseOverrideCount)
            ? fixture.expectedPurchaseOverrideCount
            : 0;
          const normalizedPurchaseOverrides = purchaseOverrideRows
            .map((override) => ({
              shopId: String(override?.shopId || ''),
              orderKey: String(override?.orderKey || ''),
              manualBuyerPlatform: String(override?.manualBuyerPlatform || ''),
              manualPurchaseOrderNo: String(override?.manualPurchaseOrderNo || ''),
              manualPurchaseOrderUrl: String(override?.manualPurchaseOrderUrl || ''),
              manualPurchasePriceValue: Number(override?.manualPurchasePriceValue || 0),
              manualPurchasePrice: String(override?.manualPurchasePrice || ''),
              manualPurchaseOrderStatus: String(override?.manualPurchaseOrderStatus || ''),
              crossBorderOrderFound: override?.crossBorderOrderFound === true,
              crossBorderStatus: String(override?.crossBorderStatus || ''),
              crossBorderOrderCount: Number(override?.crossBorderOrderCount || 0),
              packageOrderId: String(override?.packageOrderId || ''),
              crossBorderOrderId: String(override?.crossBorderOrderId || ''),
              crossBorderOrderNumber: String(override?.crossBorderOrderNumber || ''),
              packageOrderIds: Array.isArray(override?.packageOrderIds) ? override.packageOrderIds.map(String) : [],
              readStatus: String(override?.readStatus || ''),
              packageWeight: String(override?.packageWeight || ''),
              packageSize: String(override?.packageSize || ''),
              volumeItems: Array.isArray(override?.volumeItems) ? override.volumeItems : [],
              warehouse: String(override?.warehouse || ''),
              logistics: String(override?.logistics || ''),
              deliveryMethod: String(override?.deliveryMethod || ''),
              deliveryMethodId: String(override?.deliveryMethodId || ''),
              sheetOrderSn: String(override?.sheetOrderSn || ''),
              sheetUrl: String(override?.sheetUrl || ''),
              freightCostValue: Number(override?.freightCostValue || 0),
              freightCost: String(override?.freightCost || ''),
              guooFreight: String(override?.guooFreight || ''),
              crossBorderUpdatedAt: String(override?.crossBorderUpdatedAt || ''),
              materialSource: override?.materialSource || null,
              note: String(override?.note || ''),
            }))
            .sort((left, right) => (left.shopId + ':' + left.orderKey).localeCompare(right.shopId + ':' + right.orderKey));
          const purchaseOverrideDigest = fixture.expectedPurchaseOverrideDigest
            ? await sha256Hex(normalizedPurchaseOverrides)
            : '';
          const purchaseOverrideMaximumMatches = expectedPurchaseOverrideCount > 0
            ? isCompleteLegacyCursorReadback(purchaseOverridesResponse) &&
              purchaseOverrideRows.length === expectedPurchaseOverrideCount &&
              purchaseOverridesResponse?.pageCount === Number(fixture.maxExpectation?.pageCount || 0) &&
              purchaseOverrideDigest === fixture.expectedPurchaseOverrideDigest
            : true;
          const purchaseOrderOverridesPresent = isCompleteLegacyCursorReadback(purchaseOverridesResponse) &&
            expectedPurchaseOverrides.every((expected) => purchaseOverrideRows.some((override) =>
              Object.entries(expected).every(([key, value]) => String(override?.[key] ?? '') === String(value))
            )) && purchaseOverrideMaximumMatches;
          const expectedPurchaseSourceLinks = Array.isArray(fixture.expectedPurchaseSourceLinks)
            ? fixture.expectedPurchaseSourceLinks
            : [];
          const purchaseSourceRows = Array.isArray(purchaseSourceLinksResponse?.data?.rows)
            ? purchaseSourceLinksResponse.data.rows
            : [];
          const expectedPurchaseSourceLinkCount = Number.isInteger(fixture.expectedPurchaseSourceLinkCount)
            ? fixture.expectedPurchaseSourceLinkCount
            : 0;
          const normalizedPurchaseSourceLinks = purchaseSourceRows
            .map((link) => ({
              shopId: String(link?.shopId || ''),
              orderKey: String(link?.orderKey || ''),
              slotIndex: Number(link?.slotIndex || 0),
              isPrimary: link?.isPrimary === true,
              platform: String(link?.platform || ''),
              url: String(link?.url || link?.link || ''),
              sourceProductId: String(link?.sourceProductId || link?.productId || ''),
              title: String(link?.title || ''),
              imageUrl: String(link?.imageUrl || ''),
              previewImageUrl: String(link?.previewImageUrl || ''),
              originalImageUrl: String(link?.originalImageUrl || ''),
              priceValue: link?.priceValue === null || link?.priceValue === undefined ? null : Number(link.priceValue),
              currencyCode: String(link?.currencyCode || ''),
              qty: String(link?.qty || ''),
            }))
            .sort((left, right) =>
              (left.shopId + ':' + left.orderKey + ':' + left.slotIndex).localeCompare(
                right.shopId + ':' + right.orderKey + ':' + right.slotIndex,
              ),
            );
          const purchaseSourceLinkDigest = fixture.expectedPurchaseSourceLinkDigest
            ? await sha256Hex(normalizedPurchaseSourceLinks)
            : '';
          const purchaseSourceLinkMaximumMatches = expectedPurchaseSourceLinkCount > 0
            ? isCompleteLegacyCursorReadback(purchaseSourceLinksResponse) &&
              purchaseSourceRows.length === expectedPurchaseSourceLinkCount &&
              purchaseSourceLinksResponse?.pageCount === Number(fixture.maxExpectation?.pageCount || 0) &&
              purchaseSourceLinkDigest === fixture.expectedPurchaseSourceLinkDigest
            : true;
          const purchaseSourceLinksPresent = isCompleteLegacyCursorReadback(purchaseSourceLinksResponse) &&
            expectedPurchaseSourceLinks.every((expected) => purchaseSourceRows.some((link) =>
              Object.entries(expected).every(([key, value]) => String(link?.[key] ?? '') === String(value))
            )) && purchaseSourceLinkMaximumMatches;
          const expectedPurchasePluginContext = fixture.expectedPurchasePluginContext || {};
          const purchasePluginContext = purchasePluginContextResponse?.data?.setting?.value?.context && typeof purchasePluginContextResponse.data.setting.value.context === 'object'
            ? purchasePluginContextResponse.data.setting.value.context
            : {};
          const normalizedPurchasePluginContext = Object.fromEntries(
            Object.entries(purchasePluginContext).sort(([left], [right]) => left.localeCompare(right))
          );
          const purchasePluginContextDigest = fixture.expectedPurchasePluginContextDigest
            ? await sha256Hex(normalizedPurchasePluginContext)
            : '';
          const purchasePluginContextMaximumMatches = fixture.expectedPurchasePluginContextDigest
            ? purchasePluginContextDigest === fixture.expectedPurchasePluginContextDigest
            : true;
          const purchasePluginContextPresent = purchasePluginContextResponse?.ok === true &&
            Object.entries(expectedPurchasePluginContext).every(([key, value]) =>
              String(purchasePluginContext?.[key] ?? '') === String(value)
            ) && purchasePluginContextMaximumMatches;
          const expectedSalesSourceLinks = Array.isArray(fixture.expectedSalesSourceLinks) ? fixture.expectedSalesSourceLinks : [];
          const salesSourceRows = Array.isArray(salesSourceLinksResponse?.data?.rows) ? salesSourceLinksResponse.data.rows : [];
          const expectedSalesSourceLinkCount = Number.isInteger(fixture.expectedSalesSourceLinkCount)
            ? fixture.expectedSalesSourceLinkCount
            : 0;
          const normalizedSalesSourceLinks = salesSourceRows.map((link) => ({
            shopId: String(link?.shopId || ''), orderKey: String(link?.orderKey || ''), slotIndex: Number(link?.slotIndex || 0), isPrimary: link?.isPrimary === true,
            platform: String(link?.platform || ''), url: String(link?.url || link?.link || ''), sourceProductId: String(link?.sourceProductId || link?.productId || ''),
            title: String(link?.title || ''), imageUrl: String(link?.imageUrl || ''), previewImageUrl: String(link?.previewImageUrl || ''), originalImageUrl: String(link?.originalImageUrl || ''),
            priceValue: link?.priceValue === null || link?.priceValue === undefined ? null : Number(link.priceValue), currencyCode: String(link?.currencyCode || ''), qty: String(link?.qty || ''),
          })).sort((left, right) => (left.shopId + ':' + left.orderKey + ':' + left.slotIndex).localeCompare(right.shopId + ':' + right.orderKey + ':' + right.slotIndex));
          const salesSourceLinkDigest = fixture.expectedSalesSourceLinkDigest ? await sha256Hex(normalizedSalesSourceLinks) : '';
          const salesSourceLinkMaximumMatches = expectedSalesSourceLinkCount > 0
            ? isCompleteLegacyCursorReadback(salesSourceLinksResponse) &&
              salesSourceRows.length === expectedSalesSourceLinkCount && salesSourceLinksResponse?.pageCount === Number(fixture.maxExpectation?.pageCount || 0) && salesSourceLinkDigest === fixture.expectedSalesSourceLinkDigest
            : true;
          const salesSourceLinksPresent = isCompleteLegacyCursorReadback(salesSourceLinksResponse) && expectedSalesSourceLinks.every((expected) =>
            salesSourceRows.some((link) => Object.entries(expected).every(([key, value]) => String(link?.[key] ?? '') === String(value))
          )) && salesSourceLinkMaximumMatches;
          const maxVerification = fixture.maxExpectation?.kind === 'purchase-source-plugin-context' ? {
              kind: fixture.maxExpectation.kind,
              verified: purchasePluginContextResponse?.ok === true && purchasePluginContextPresent && purchasePluginContextMaximumMatches,
              contextFieldCount: Object.keys(normalizedPurchasePluginContext).length,
              contextDigestMatches: purchasePluginContextDigest === fixture.expectedPurchasePluginContextDigest,
              requestPayloadBytes: Number(fixture.maxExpectation.requestPayloadBytes || 0),
              requestBudgetBytes: Number(fixture.maxExpectation.requestBudgetBytes || 0),
            } : fixture.maxExpectation?.kind === 'ozon-shop-settings' ? {
              kind: fixture.maxExpectation.kind,
              verified: response?.ok === true && isCompleteLegacyCursorReadback(shopsResponse) && ozonShopSettingsPresent,
              expectedShopCount,
              actualPreferenceShopCount: preferenceShops.length,
              actualPublicShopCount: localShopRows.length,
              expectedWarehouseCount,
              actualWarehouseCount: normalizedWarehouseEntries.length,
              preferenceShopDigestMatches: preferenceShopDigest === fixture.expectedPreferenceShopDigest,
              publicShopDigestMatches: publicShopDigest === fixture.expectedPublicShopDigest,
              warehouseDigestMatches: warehouseDigest === fixture.expectedWarehouseDigest,
              cursorPageCount: Number(shopsResponse?.pageCount || 0),
              pageLimitReached: shopsResponse?.pageLimitReached ?? null,
              requestPayloadBytes: Number(fixture.maxExpectation.requestPayloadBytes || 0),
              requestBudgetBytes: Number(fixture.maxExpectation.requestBudgetBytes || 0),
            } : fixture.maxExpectation?.kind === 'marketing-activity-cache' ? {
              kind: fixture.maxExpectation.kind,
              verified: marketingCacheResponse?.ok === true && marketingCachePresent && marketingCacheMaximumMatches &&
                Number(fixture.maxExpectation.legacyBrowserInputBytes || 0) > 0 &&
                Number(fixture.maxExpectation.legacyBrowserInputBytes || 0) <=
                  Number(fixture.maxExpectation.legacyBrowserInputBudgetBytes || 0) &&
                Number(fixture.maxExpectation.legacyImportBodyBytes || 0) > 0 &&
                Number(fixture.maxExpectation.legacyImportBodyBytes || 0) <=
                  Number(fixture.maxExpectation.legacyImportBodyBudgetBytes || 0),
              expectedMarketingSnapshotCount,
              actualMarketingSnapshotCount: normalizedMarketingSnapshots.length,
              expectedMarketingActivityCount,
              actualMarketingActivityCount: marketingActivityCount,
              expectedMarketingProductCount,
              actualMarketingProductCount: marketingProductCount,
              expectedMarketingTotalRowCount,
              actualMarketingTotalRowCount: marketingTotalRowCount,
              marketingSnapshotDigestMatches: marketingSnapshotDigest === fixture.expectedMarketingSnapshotDigest,
              legacyBrowserInputBytes: Number(fixture.maxExpectation.legacyBrowserInputBytes || 0),
              legacyBrowserInputBudgetBytes: Number(fixture.maxExpectation.legacyBrowserInputBudgetBytes || 0),
              legacyBrowserInputWithinBudget:
                Number(fixture.maxExpectation.legacyBrowserInputBytes || 0) > 0 &&
                Number(fixture.maxExpectation.legacyBrowserInputBytes || 0) <=
                  Number(fixture.maxExpectation.legacyBrowserInputBudgetBytes || 0),
              legacyImportBodyBytes: Number(fixture.maxExpectation.legacyImportBodyBytes || 0),
              legacyImportBodyBudgetBytes: Number(fixture.maxExpectation.legacyImportBodyBudgetBytes || 0),
              legacyImportBodyWithinBudget:
                Number(fixture.maxExpectation.legacyImportBodyBytes || 0) > 0 &&
                Number(fixture.maxExpectation.legacyImportBodyBytes || 0) <=
                  Number(fixture.maxExpectation.legacyImportBodyBudgetBytes || 0),
            } : fixture.maxExpectation?.kind === 'product-source-links' ? {
              kind: fixture.maxExpectation.kind,
              verified: isCompleteLegacyCursorReadback(productSourceLinksResponse) && productSourceLinksPresent && productSourceLinkMaximumMatches,
              expectedProductSourceLinkCount,
              actualProductSourceLinkCount: productSourceRows.length,
              pageSize: Number(fixture.maxExpectation.pageSize || 0),
              expectedPageCount: Number(fixture.maxExpectation.pageCount || 0),
              actualPageCount: Number(productSourceLinksResponse?.pageCount || 0),
              pageLimitReached: productSourceLinksResponse?.pageLimitReached ?? null,
              productSourceLinkDigestMatches: productSourceLinkDigest === fixture.expectedProductSourceLinkDigest,
              legacySourceLinkBytes: Number(fixture.maxExpectation.legacySourceLinkBytes || 0),
              legacySourceLinkBudgetBytes: Number(fixture.maxExpectation.legacySourceLinkBudgetBytes || 0),
            } : fixture.maxExpectation?.kind === 'purchase-order-overrides' ? {
              kind: fixture.maxExpectation.kind,
              verified: isCompleteLegacyCursorReadback(purchaseOverridesResponse) && purchaseOrderOverridesPresent && purchaseOverrideMaximumMatches,
              expectedPurchaseOverrideCount,
              actualPurchaseOverrideCount: purchaseOverrideRows.length,
              pageSize: Number(fixture.maxExpectation.pageSize || 0),
              expectedPageCount: Number(fixture.maxExpectation.pageCount || 0),
              actualPageCount: Number(purchaseOverridesResponse?.pageCount || 0),
              pageLimitReached: purchaseOverridesResponse?.pageLimitReached ?? null,
              purchaseOverrideDigestMatches: purchaseOverrideDigest === fixture.expectedPurchaseOverrideDigest,
              legacyOverrideBytes: Number(fixture.maxExpectation.legacyOverrideBytes || 0),
              legacyOverrideBudgetBytes: Number(fixture.maxExpectation.legacyOverrideBudgetBytes || 0),
            } : fixture.maxExpectation?.kind === 'purchase-source-links' ? {
              kind: fixture.maxExpectation.kind,
              verified: isCompleteLegacyCursorReadback(purchaseSourceLinksResponse) && purchaseSourceLinksPresent && purchaseSourceLinkMaximumMatches,
              expectedPurchaseSourceLinkCount,
              actualPurchaseSourceLinkCount: purchaseSourceRows.length,
              pageSize: Number(fixture.maxExpectation.pageSize || 0),
              expectedPageCount: Number(fixture.maxExpectation.pageCount || 0),
              actualPageCount: Number(purchaseSourceLinksResponse?.pageCount || 0),
              pageLimitReached: purchaseSourceLinksResponse?.pageLimitReached ?? null,
              purchaseSourceLinkDigestMatches: purchaseSourceLinkDigest === fixture.expectedPurchaseSourceLinkDigest,
              legacySourceLinkBytes: Number(fixture.maxExpectation.legacySourceLinkBytes || 0),
              legacySourceLinkBudgetBytes: Number(fixture.maxExpectation.legacySourceLinkBudgetBytes || 0),
            } : fixture.maxExpectation?.kind === 'sales-source-links' ? {
              kind: fixture.maxExpectation.kind,
              verified: isCompleteLegacyCursorReadback(salesSourceLinksResponse) && salesSourceLinksPresent && salesSourceLinkMaximumMatches,
              expectedSalesSourceLinkCount,
              actualSalesSourceLinkCount: salesSourceRows.length,
              pageSize: Number(fixture.maxExpectation.pageSize || 0),
              expectedPageCount: Number(fixture.maxExpectation.pageCount || 0),
              actualPageCount: Number(salesSourceLinksResponse?.pageCount || 0),
              pageLimitReached: salesSourceLinksResponse?.pageLimitReached ?? null,
              salesSourceLinkDigestMatches: salesSourceLinkDigest === fixture.expectedSalesSourceLinkDigest,
              legacySourceLinkBytes: Number(fixture.maxExpectation.legacySourceLinkBytes || 0),
              legacySourceLinkBudgetBytes: Number(fixture.maxExpectation.legacySourceLinkBudgetBytes || 0),
            } : fixture.maxExpectation?.kind === 'product-material-profiles' ? {
              kind: fixture.maxExpectation.kind,
              verified: isCompleteLegacyCursorReadback(materialProfilesResponse) && materialProfilesPresent && materialProfileMaximumMatches,
              expectedMaterialProfileCount,
              actualMaterialProfileCount: materialProfileRows.length,
              pageSize: Number(fixture.maxExpectation.pageSize || 0),
              expectedPageCount: Number(fixture.maxExpectation.pageCount || 0),
              actualPageCount: Number(materialProfilesResponse?.pageCount || 0),
              pageLimitReached: materialProfilesResponse?.pageLimitReached ?? null,
              materialProfileDigestMatches: materialProfileDigest === fixture.expectedMaterialProfileDigest,
              legacyProfileBytes: Number(fixture.maxExpectation.legacyProfileBytes || 0),
              legacyProfileBudgetBytes: Number(fixture.maxExpectation.legacyProfileBudgetBytes || 0),
            } : null;
          const canonicalPresent = fixture.canonicalKind === 'ozon-shop-settings'
            ? ozonShopSettingsPresent
            : fixture.canonicalKind === 'marketing-activity-cache' ? marketingCachePresent
                : fixture.canonicalKind === 'product-material-profiles' ? materialProfilesPresent
                  : fixture.canonicalKind === 'product-source-links' ? productSourceLinksPresent
                     : fixture.canonicalKind === 'purchase-order-overrides' ? purchaseOrderOverridesPresent
                          : fixture.canonicalKind === 'purchase-source-links' ? purchaseSourceLinksPresent
                            : fixture.canonicalKind === 'purchase-source-plugin-context' ? purchasePluginContextPresent
                                : fixture.canonicalKind === 'sales-source-links' ? salesSourceLinksPresent : false;
          const primaryResponse = fixture.canonicalKind === 'marketing-activity-cache' ? marketingCacheResponse
              : fixture.canonicalKind === 'product-material-profiles' ? materialProfilesResponse
                : fixture.canonicalKind === 'product-source-links' ? productSourceLinksResponse
                  : fixture.canonicalKind === 'purchase-order-overrides' ? purchaseOverridesResponse
                      : fixture.canonicalKind === 'purchase-source-links' ? purchaseSourceLinksResponse
                        : fixture.canonicalKind === 'purchase-source-plugin-context' ? purchasePluginContextResponse
                          : fixture.canonicalKind === 'sales-source-links' ? salesSourceLinksResponse : response;
          return {
            legacyPresent,
            legacyEntryCount,
            legacyRetainedCount,
            retainedLegacyEntryKeys,
            requiredLegacyEntryCount,
            requiredLegacyRetainedCount,
            retainedRequiredLegacyKeys,
            ...retentionEvidence,
            browserLegacyClearCount,
            canonicalPresent: primaryResponse?.ok === true && canonicalPresent,
            responseStatus: primaryResponse?.status || 0,
            maxVerification,
            canonicalDetails: fixture.canonicalKind === 'ozon-shop-settings' ? {
              activeShopId: preferences?.activeShopId || '',
              warehouseId: preferences?.defaultWarehouseIds?.[fixture.expectedShopId] || '',
              preferenceShopPresent: Boolean(preferenceShop),
              localShopId: shopRecord?.id || '',
              hasClientId: shopRecord?.hasClientId === true,
              hasApiKey: shopRecord?.hasApiKey === true,
              expectedShopCount,
              preferenceShopCount: preferenceShops.length,
              publicShopCount: localShopRows.length,
              warehouseCount: normalizedWarehouseEntries.length,
              preferenceShopDigestMatches: fixture.expectedPreferenceShopDigest
                ? preferenceShopDigest === fixture.expectedPreferenceShopDigest
                : true,
              publicShopDigestMatches: fixture.expectedPublicShopDigest
                ? publicShopDigest === fixture.expectedPublicShopDigest
                : true,
              warehouseDigestMatches: fixture.expectedWarehouseDigest
                ? warehouseDigest === fixture.expectedWarehouseDigest
                : true,
            } : fixture.canonicalKind === 'marketing-activity-cache' ? {
              cacheResponseOk: marketingCacheResponse?.ok === true,
              snapshotCount: Object.keys(marketingCacheStore).length,
              expectedSnapshotsPresent: marketingMinimumPresent,
              selectionMatches: marketingSelectionMatches,
              activityVariantsMatch: marketingActivityVariantsMatch,
              selectedSources: Object.fromEntries(
                Object.entries(marketingCacheStore).map(([shopId, snapshot]) => [shopId, {
                  activityId: String(snapshot?.selectedActivityId || ''),
                  sourceType: String(snapshot?.selectedSourceType || ''),
                }]),
              ),
              expectedMarketingSnapshotCount,
              marketingProductCount,
              marketingSnapshotDigestMatches: fixture.expectedMarketingSnapshotDigest
                ? marketingSnapshotDigest === fixture.expectedMarketingSnapshotDigest
                : true,
            } : fixture.canonicalKind === 'product-material-profiles' ? {
              materialResponseOk: materialProfilesResponse?.ok === true,
              materialProfileCount: materialProfileRows.length,
              expectedProfilesPresent: expectedMaterialProfiles.length > 0 && materialProfilesPresent,
              expectedMaterialProfileCount,
              materialPageCount: Number(materialProfilesResponse?.pageCount || 0),
              materialProfileDigestMatches: fixture.expectedMaterialProfileDigest
                ? materialProfileDigest === fixture.expectedMaterialProfileDigest
                : true,
            } : fixture.canonicalKind === 'product-source-links' ? {
              sourceLinksResponseOk: productSourceLinksResponse?.ok === true,
              sourceLinkCount: productSourceRows.length,
              expectedSlotsPresent: expectedSourceLinks.length > 0 && productSourceLinksPresent,
              expectedProductSourceLinkCount,
              productSourcePageCount: Number(productSourceLinksResponse?.pageCount || 0),
              productSourceLinkDigestMatches: fixture.expectedProductSourceLinkDigest
                ? productSourceLinkDigest === fixture.expectedProductSourceLinkDigest
                : true,
            } : fixture.canonicalKind === 'sales-source-links' ? {
              sourceLinksResponseOk: salesSourceLinksResponse?.ok === true,
              sourceLinkCount: salesSourceRows.length,
              expectedSlotsPresent: expectedSalesSourceLinks.length > 0 && salesSourceLinksPresent,
            } : fixture.canonicalKind === 'purchase-order-overrides' ? {
              overridesResponseOk: purchaseOverridesResponse?.ok === true,
              overrideCount: purchaseOverrideRows.length,
              expectedOverridesPresent: expectedPurchaseOverrides.length > 0 && purchaseOrderOverridesPresent,
              expectedPurchaseOverrideCount,
              purchaseOverridePageCount: Number(purchaseOverridesResponse?.pageCount || 0),
              purchaseOverrideDigestMatches: fixture.expectedPurchaseOverrideDigest
                ? purchaseOverrideDigest === fixture.expectedPurchaseOverrideDigest
                : true,
            } : fixture.canonicalKind === 'purchase-source-links' ? {
              sourceLinksResponseOk: purchaseSourceLinksResponse?.ok === true,
              sourceLinkCount: purchaseSourceRows.length,
              expectedSlotsPresent: expectedPurchaseSourceLinks.length > 0 && purchaseSourceLinksPresent,
              expectedPurchaseSourceLinkCount,
              purchaseSourcePageCount: Number(purchaseSourceLinksResponse?.pageCount || 0),
              purchaseSourceLinkDigestMatches: fixture.expectedPurchaseSourceLinkDigest
                ? purchaseSourceLinkDigest === fixture.expectedPurchaseSourceLinkDigest
                : true,
            } : fixture.canonicalKind === 'purchase-source-plugin-context' ? {
              contextResponseOk: purchasePluginContextResponse?.ok === true,
              expectedContextPresent: Object.keys(expectedPurchasePluginContext).length > 0 && purchasePluginContextPresent,
              contextFieldCount: Object.keys(normalizedPurchasePluginContext).length,
              contextDigestMatches: fixture.expectedPurchasePluginContextDigest
                ? purchasePluginContextDigest === fixture.expectedPurchasePluginContextDigest
                : true,
            } : undefined,
          };
        } catch (error) {
          return {
            legacyPresent,
            legacyEntryCount,
            legacyRetainedCount,
            retainedLegacyEntryKeys,
            requiredLegacyEntryCount,
            requiredLegacyRetainedCount,
            retainedRequiredLegacyKeys,
            ...retentionEvidence,
            browserLegacyClearCount,
            canonicalPresent: false,
            reason: String(error?.message || error || 'LOCAL_API_READ_FAILED'),
          };
        }
        })()`,
      )
      .catch((error) => ({
        legacyPresent: true,
        legacyEntryCount: Array.isArray(fixture.legacyEntries) ? fixture.legacyEntries.length : 0,
        legacyRetainedCount: Array.isArray(fixture.legacyEntries) ? fixture.legacyEntries.length : 0,
        browserLegacyClearCount: 0,
        canonicalPresent: false,
        reason: String(error?.stack || error?.message || error || "RENDERER_EVALUATION_FAILED"),
      }));
    const legacyMarketingFile = marketingFileEvidence
      ? {
        seeded: marketingFileEvidence.seeded,
        existsAtPhaseStart: marketingFileEvidence.existsAtPhaseStart,
        exists: fsSync.existsSync(marketingFileEvidence.filePath),
      }
      : null;
    lastResult = {
      ...rendererResult,
      ...(legacyMarketingFile ? { legacyMarketingFile } : {}),
    };
    const marketingFileCondition =
      !legacyMarketingFile ||
      (expectLegacyMarketingFileRetention
        ? legacyMarketingFile.exists === true
        : legacyMarketingFile.exists === false);
    if (
      marketingFileCondition &&
        (
          expectRetention
            ? (
              lastResult.legacyEntryCount > 0 &&
              lastResult.requiredLegacyEntryCount > 0 &&
              lastResult.requiredLegacyRetainedCount === lastResult.requiredLegacyEntryCount &&
              !lastResult.canonicalPresent
            )
            : expectCanonicalWithRetainedLegacy
              ? (
                lastResult.requiredLegacyEntryCount > 0 &&
                lastResult.requiredLegacyRetainedCount === lastResult.requiredLegacyEntryCount &&
                lastResult.canonicalPresent
              )
              : (!lastResult.legacyPresent && lastResult.canonicalPresent)
        )
    )
      return lastResult;
    await delay(120);
  }
  throw new Error(`旧浏览器副本退役夹具超时：${JSON.stringify(lastResult)}`);
}

/**
 * Recovery evidence must use the public desktop recovery IPC, not a copied
 * SQLite file. Values, passphrases, remote tokens and staging paths remain in
 * their owning process; the structured result contains only counts/statuses.
 */
async function runLegacyRetirementRecoveryFixture(webContents, fixture, timeoutMs = 90_000) {
  const rendererFixture = {
    legacyKeys: Array.isArray(fixture.recoveryRetainedKeys) && fixture.recoveryRetainedKeys.length
      ? fixture.recoveryRetainedKeys
      : (fixture.legacyEntries || []).map((entry) => entry.key),
    recoveryShopIds: Array.isArray(fixture.recoveryShopIds)
      ? fixture.recoveryShopIds.map(String).filter(Boolean)
      : [],
  };
  return webContents.executeJavaScript(
    `(async () => {
      const fixture = ${JSON.stringify(rendererFixture)};
      const desktop = window.wangzaiDesktop;
      if (typeof desktop?.localApiRequest !== 'function' || typeof desktop?.recoveryRequest !== 'function') {
        throw new Error('LEGACY_RETIREMENT_RECOVERY_IPC_MISSING');
      }
      const legacyCount = () => fixture.legacyKeys.filter((key) => window.localStorage.getItem(key) !== null).length;
      const requiredLegacyCount = fixture.legacyKeys.length;
      if (!requiredLegacyCount || legacyCount() !== requiredLegacyCount) {
        throw new Error('LEGACY_RETIREMENT_RECOVERY_LEGACY_NOT_RETAINED_BEFORE_STAGE');
      }
      const requestRecovery = async (input) => {
        const result = await desktop.recoveryRequest(input);
        if (!result?.ok) {
          const remoteError = result?.data?.error || result?.error;
          const code = [remoteError?.code, remoteError?.message || remoteError]
            .filter(Boolean)
            .map(String)
            .join(':')
            .slice(0, 512);
          throw new Error('LEGACY_RETIREMENT_RECOVERY_REQUEST_FAILED:' + String(input?.command || 'missing') + ':' + code);
        }
        return result.data || {};
      };
      // Recovery requires a shop-scoped generation. It is deterministic test
      // support only and is persisted through the public local-api shop endpoint.
      const anchorShopId = 'legacy-retirement-recovery-anchor';
      const recoveryShopIds = [...new Set([anchorShopId, ...fixture.recoveryShopIds])];
      // Do not use the normal UI's unpaged shop list in a recovery fixture.
      // A scope check must see every encrypted account before deciding which
      // deterministic recovery anchor records are safe to create.
      const readEveryRecoveryScopeShop = async () => {
        const rows = [];
        const seenCursors = new Set();
        let cursor = '';
        let total = null;
        let pageCount = 0;
        while (pageCount < ${LEGACY_RETIREMENT_CURSOR_READBACK_MAX_PAGES}) {
          const query = new URLSearchParams({ cursorMode: 'legacy-migration', limit: '1000' });
          if (cursor) query.set('cursor', cursor);
          const response = await desktop.localApiRequest({
            path: '/api/shops?' + query.toString(),
            method: 'GET',
            timeoutMs: ${Math.max(30_000, Number(timeoutMs) || 90_000)},
          });
          pageCount += 1;
          const pageRows = Array.isArray(response?.data?.rows) ? response.data.rows : null;
          const pageTotal = Number(response?.data?.total);
          const hasMore = response?.data?.hasMore;
          const nextCursor = typeof response?.data?.nextCursor === 'string'
            ? response.data.nextCursor.trim()
            : '';
          if (
            response?.ok !== true ||
            response?.data?.ok !== true ||
            pageRows === null ||
            !Number.isSafeInteger(pageTotal) ||
            pageTotal < 0 ||
            typeof hasMore !== 'boolean' ||
            (total !== null && total !== pageTotal) ||
            rows.length + pageRows.length > pageTotal
          ) {
            throw new Error('LEGACY_RETIREMENT_RECOVERY_SCOPE_SHOP_LIST_FAILED');
          }
          if (total === null) total = pageTotal;
          rows.push(...pageRows);
          if (!hasMore) {
            if (nextCursor || rows.length !== total) {
              throw new Error('LEGACY_RETIREMENT_RECOVERY_SCOPE_SHOP_LIST_FAILED');
            }
            return { rows, total, pageCount, pageLimitReached: false };
          }
          if (!nextCursor || seenCursors.has(nextCursor)) {
            throw new Error('LEGACY_RETIREMENT_RECOVERY_SCOPE_SHOP_LIST_FAILED');
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
        throw new Error('LEGACY_RETIREMENT_RECOVERY_SCOPE_SHOP_LIST_FAILED');
      };
      const existingShops = await readEveryRecoveryScopeShop();
      const existingShopIds = new Set(
        existingShops.rows
          .map((shop) => String(shop?.id || '').trim())
          .filter(Boolean),
      );
      for (const shopId of recoveryShopIds) {
        // Fixture scope shops may already hold a legacy client id used by a
        // client-id-keyed migration. Never overwrite it merely to make a
        // recovery generation active; doing so would manufacture an
        // unresolved browser key after the restore.
        if (existingShopIds.has(shopId)) continue;
        const saved = await desktop.localApiRequest({
          path: '/api/shops',
          method: 'POST',
          body: {
            id: shopId,
            name: shopId === anchorShopId ? 'Legacy retirement recovery anchor' : 'Legacy retirement recovery scope',
            clientId: 'legacy-retirement-recovery-client-' + shopId,
            apiKey: 'test-legacy-retirement-recovery-api-key',
            status: 'active',
          },
          timeoutMs: ${Math.max(30_000, Number(timeoutMs) || 90_000)},
        });
        if (!saved?.ok || !saved?.data?.shop?.id) {
          throw new Error('LEGACY_RETIREMENT_RECOVERY_SCOPE_SHOP_SAVE_FAILED');
        }
      }
      const passphrase = 'legacy-retirement-isolated-recovery-passphrase';
      const generationIds = [];
      for (const shopId of recoveryShopIds) {
        const backup = await requestRecovery({
          command: 'backup-shop',
          shopId,
          passphrase,
        });
        const generationId = String(backup?.remoteGenerationId || '');
        if (!generationId) throw new Error('LEGACY_RETIREMENT_RECOVERY_GENERATION_MISSING');
        generationIds.push(generationId);
      }
      const staged = await requestRecovery({
        command: 'stage-restore',
        generationIds,
        passphrase,
      });
      if (staged?.mode !== 'staging-ready' || !staged?.restoreId) {
        throw new Error('LEGACY_RETIREMENT_RECOVERY_STAGING_FAILED');
      }
      let activationFailed = false;
      let activationFailureCode = '';
      try {
        await requestRecovery({ command: 'activate-restore', restoreId: staged.restoreId });
      } catch (error) {
        activationFailureCode = String(error?.message || error).slice(0, 180);
        activationFailed = activationFailureCode.includes('LEGACY_RETIREMENT_RECOVERY_ACTIVATION_FAILURE');
      }
      const legacyRetainedAfterFailedActivation = legacyCount();
      if (!activationFailed || legacyRetainedAfterFailedActivation !== requiredLegacyCount) {
        throw new Error('LEGACY_RETIREMENT_RECOVERY_ROLLBACK_OR_LEGACY_RETENTION_FAILED:' + activationFailureCode);
      }
      // Failed activation quarantines its staging family. Re-stage the same
      // opaque generation instead of reusing/copying the old staging database.
      const restaged = await requestRecovery({
        command: 'stage-restore',
        generationIds,
        passphrase,
      });
      if (restaged?.mode !== 'staging-ready' || !restaged?.restoreId) {
        throw new Error('LEGACY_RETIREMENT_RECOVERY_RESTAGING_FAILED');
      }
      const activated = await requestRecovery({
        command: 'activate-restore',
        restoreId: restaged.restoreId,
      });
      if (activated?.mode !== 'activated') {
        throw new Error('LEGACY_RETIREMENT_RECOVERY_ACTIVATION_SUCCESS_MISSING');
      }
      return {
        generationCreated: generationIds.length > 0,
        generationCount: generationIds.length,
        stagedGenerationCount: Array.isArray(staged.generationIds) ? staged.generationIds.length : 0,
        restagedGenerationCount: Array.isArray(restaged.generationIds) ? restaged.generationIds.length : 0,
        failureActivationObserved: activationFailed,
        successfulActivationObserved: true,
        requiredLegacyCount,
        legacyRetainedAfterFailedActivation,
        recoveryScopeShopReadback: {
          total: existingShops.total,
          pageCount: existingShops.pageCount,
          pageLimitReached: existingShops.pageLimitReached,
        },
      };
    })()`,
    true,
  );
}

async function waitForLegacyRetirementRecoveryReadbackFault(
  legacyRetirementFault,
  timeoutMs = 20_000,
) {
  const startedAt = Date.now();
  let snapshot = legacyRetirementFault?.snapshot?.() || null;
  while (Date.now() - startedAt < timeoutMs) {
    snapshot = legacyRetirementFault?.snapshot?.() || null;
    if (
      snapshot?.mode === "recovery-failure" &&
      snapshot.targetConfigured === true &&
      snapshot.targetWriteSucceeded > 0 &&
      snapshot.targetReadRejected > 0
    ) return snapshot;
    await delay(120);
  }
  throw new Error(
    `旧浏览器副本恢复夹具未等到目标 canonical 写入后的真实回读故障：${JSON.stringify(snapshot)}`,
  );
}

/**
 * A retention assertion is not sufficient evidence by itself: the renderer
 * may still be between reading the retired source and issuing its canonical
 * request. Wait for the deliberately injected fault first, otherwise a fast
 * automation window could quit before the migration attempt exists.
 */
async function waitForLegacyRetirementFailureEvidence(
  legacyRetirementFault,
  phase,
  timeoutMs = 20_000,
) {
  const startedAt = Date.now();
  let snapshot = legacyRetirementFault?.snapshot?.() || null;
  const isObserved = (value) => {
    if (phase === "write-error") {
      return value?.mode === phase &&
        value.targetConfigured === true &&
        value.targetWriteAttempted > 0 &&
        value.targetWriteRejected > 0;
    }
    if (phase === "readback-error") {
      return value?.mode === phase &&
        value.targetConfigured === true &&
        value.targetWriteSucceeded > 0 &&
        value.targetReadAttempted > 0 &&
        value.targetReadRejected > 0;
    }
    return true;
  };
  while (Date.now() - startedAt < timeoutMs) {
    snapshot = legacyRetirementFault?.snapshot?.() || null;
    if (isObserved(snapshot)) return snapshot;
    await delay(120);
  }
  throw new Error(
    `旧浏览器副本退役未等到 ${phase || "unknown"} 的 canonical 故障证据：${JSON.stringify(snapshot)}`,
  );
}

export {
  RETIRED_OZON_SHOP_BROWSER_KEY,
  getLegacyRetirementFixture,
  seedLegacyRetirementCanonicalShops,
  writeLegacyRetirementSeedFile,
  readLegacyRetirementSeedFile,
  seedLegacyRetirementMarketingFile,
  createLegacyRetirementMarketingFileEvidence,
  waitForLegacyRetirementFixture,
  runLegacyRetirementRecoveryFixture,
  waitForLegacyRetirementRecoveryReadbackFault,
  waitForLegacyRetirementFailureEvidence,
};
