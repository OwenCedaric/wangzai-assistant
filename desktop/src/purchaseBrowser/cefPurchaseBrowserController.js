import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BUILT_IN_CEF_ADDON,
  BUILT_IN_CROSS_BORDER_ADDON,
} from './purchaseBrowserBuiltinManager.js';
import { createPurchaseBrowserCommandQueue } from './purchaseBrowserCommandQueue.js';
import {
  BUILTIN_CROSS_BORDER_PROFILE_OWNER_TYPE,
  BUILTIN_PUBLIC_PROFILE_OWNER_TYPE,
  getPurchaseBrowserBuiltinBinding,
} from './purchaseBrowserBuiltinProfile.js';
import { createPurchaseLogisticsSyncService } from './purchaseLogisticsSyncService.js';
import { createPurchaseBrowserSessionManager } from './purchaseBrowserSessionManager.js';
import { normalizePurchaseCapture } from './adapters/purchaseCaptureRegistry.js';
import {
  purchaseTitleSimilarity,
  selectAlibaba1688OrderCandidate,
} from './alibaba1688OrderSelection.js';
import { readAlibaba1688SourceRecord } from './alibaba1688SourceReader.js';
import { createPurchaseRemovalMaintenance } from './purchaseRemovalMaintenance.js';
import { validatePurchaseRemovalReceiptBinding } from './purchaseRemovalReceiptBinding.js';
import { validatePurchaseProductCapture } from './purchaseProductCaptureValidation.js';
import { isAlipayH5PaymentUrl, isAlipayPaymentUrl } from './alipayPaymentWindowController.js';
import { detectFollowSellerLoopbackHttpProxy } from './followSellerNetworkRoute.js';
import {
  accountSupportsPurchaseRehearsal,
  createPurchaseRehearsalResult,
  normalizePurchaseRehearsalTargets,
  publicPurchaseRehearsalResult,
  PURCHASE_REHEARSAL_PLATFORMS,
  resolvePurchaseRehearsalPlatform,
  samplePurchaseRehearsalTarget,
} from './purchaseRehearsal.js';
import {
  fail,
  assertNotAborted,
  requiredText,
  sanitizedErrorCode,
  isOzonSellerLoginUrl,
  isOzonAuthenticationDeniedResult,
  isRecoverableOpenError,
  isTransientCaptureContextError,
  isPinduoduoUrl,
  isPinduoduoProductUrl,
  isAlibaba1688Url,
  purchasePlatformFromUrl,
  purchaseSourceProductId,
  purchaseOverrideIsVoided,
  isConfirmedPurchaseOrderStatus,
  isConfirmedPurchaseRefundStatus,
  sha256,
  normalizePinduoduoTopLevelUrl,
  normalizePurchaseWorkbenchForPlatform,
  canonicalReceipt,
  cleanOptionalText,
} from './purchaseBrowserControllerHelpers.js';
export { normalizePinduoduoTopLevelUrl, normalizePurchaseWorkbenchForPlatform } from './purchaseBrowserControllerHelpers.js';

const nodePath = path;

const OWNER_REF_PATTERN = /^[a-f0-9]{40}$/u;
const PENDING_REMOVAL_VERSION = 2;
const OZON_BROWSER_DEFAULT_URL = 'https://seller.ozon.ru/app/dashboard/main';
const OZON_FOLLOW_SELLER_SESSION_TYPE = 'ozon-follow-seller-session';
// Chromium can expose the reparented host before its render surface becomes
// visible. Applying a per-site zoom (1688 fit-width) makes that handoff take a
// couple of extra frames, so keep the strict HWND readback but retry briefly
// instead of tearing down an otherwise healthy embedded session.
const EMBEDDED_SURFACE_READBACK_DELAYS_MS = Object.freeze([40, 80, 120]);
const CAPTURE_CONTEXT_RETRY_DELAYS_MS = Object.freeze([300]);
const PINDUODUO_ORDER_POLL_MS = 1_500;
const PINDUODUO_ORDER_HIDDEN_POLL_MS = 5_000;
const ACCOUNT_REMOVAL_PATH_RELEASE_DELAYS_MS = Object.freeze([150, 300, 600, 1200, 2400]);
const OZON_LOGIN_VERIFICATION_TTL_MS = 30_000;
const OZON_LOGIN_SETTLE_ATTEMPTS = 12;
const OZON_LOGIN_SETTLE_DELAY_MS = 1_000;
const PURCHASE_REHEARSAL_MIN_RUNS = 10;
const PURCHASE_REHEARSAL_MAX_RUNS = 50;
const PURCHASE_REHEARSAL_PAGE_TIMEOUT_MS = 30_000;
const PURCHASE_AUTO_ORDER_TIMEOUT_MS = 180_000;
const PURCHASE_AUTO_ORDER_PLATFORMS = new Set(['拼多多', '淘宝', '天猫', '1688']);
const PINDUODUO_PAYMENT_BOOTSTRAP_URL = 'https://mobile.yangkeduo.com/orders.html?type=1&order_index=75';
const PAYMENT_BOOTSTRAP_URLS = Object.freeze({
  拼多多: PINDUODUO_PAYMENT_BOOTSTRAP_URL,
  淘宝: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm?action=itemlist/BoughtQueryAction&event_submit_do_query=1&tabCode=waitPay',
  天猫: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm?action=itemlist/BoughtQueryAction&event_submit_do_query=1&tabCode=waitPay',
  '1688': 'https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?tradeStatus=waitbuyerpay&page=1&pageSize=10',
});

function paymentPlatformFromProfileKey(value = '') {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'pinduoduo') return '拼多多';
  if (key === 'taobao') return '淘宝';
  if (key === 'tmall') return '天猫';
  if (key === '1688') return '1688';
  return '';
}
const MAX_INTERACTIVE_BROWSER_TABS = 2;
const INTERACTIVE_NAVIGATION_COMMANDS = new Set([
  'activate',
  'navigate',
  'back',
  'forward',
  'reload',
  'restore',
  'ozon-open-order',
  'purchase-auto-order',
]);
const INTERACTIVE_TARGET_COMMANDS = new Set([
  'set-target',
  'clear-target',
  'target-recovery',
]);
// Observer status is a passive readiness poll.  It must never cancel a native
// pagination replay merely because the surrounding frontend collector task is
// marked interactive.  Commands that actually change the route/query (for
// example navigate or ozon-data-probe) retain the preemption path below.
const PASSIVE_COLLECTOR_COMMANDS = new Set([
  'ozon-data-status',
]);
export const PURCHASE_BROWSER_ROLES = Object.freeze({
  INTERACTIVE: 'interactive',
  MARKET_COLLECTOR: 'market-collector',
  FOLLOW_SELLER_COLLECTOR: 'follow-seller-collector',
  PRODUCT_LINK_PARSER: 'product-link-parser',
});
export const PURCHASE_BROWSER_TARGET_PHASES = Object.freeze([
  'idle',
  'target-selecting',
  'target-locked',
  'capturing',
  'capture-preview',
  'confirming',
  'saving',
  'readback',
  'completed',
  'error',
]);

const TARGET_PHASE_TRANSITIONS = Object.freeze({
  idle: new Set(['idle', 'target-selecting', 'target-locked', 'error']),
  'target-selecting': new Set(['target-selecting', 'target-locked', 'idle', 'error']),
  'target-locked': new Set(['target-locked', 'capturing', 'capture-preview', 'target-selecting', 'idle', 'error']),
  capturing: new Set(['capturing', 'target-locked', 'capture-preview', 'error']),
  'capture-preview': new Set(['capture-preview', 'capturing', 'confirming', 'target-locked', 'idle', 'error']),
  confirming: new Set(['confirming', 'saving', 'error']),
  saving: new Set(['saving', 'readback', 'error']),
  readback: new Set(['readback', 'completed', 'error']),
  completed: new Set(['completed', 'capturing', 'target-selecting', 'target-locked', 'idle', 'error']),
  error: new Set(['error', 'target-selecting', 'target-locked', 'capturing', 'capture-preview', 'idle']),
});









function validatedFollowSellerEvidenceAttachments(value) {
  const attachments = Array.isArray(value) ? value : [];
  if (attachments.length !== 2) fail('FOLLOW_SELLER_EVIDENCE_PAIR_REQUIRED');
  const normalized = attachments.map((item) => {
    const kind = String(item?.kind || '').trim().toLowerCase();
    const filePath = path.resolve(String(item?.path || '').trim());
    const expectedSha256 = String(item?.sha256 || '').trim().toLowerCase();
    if (!['psd', 'pdf'].includes(kind) || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
      fail('FOLLOW_SELLER_EVIDENCE_ATTACHMENT_INVALID');
    }
    const evidenceSegment = `${path.sep}follow-seller-evidence${path.sep}`.toLowerCase();
    if (!filePath.toLowerCase().includes(evidenceSegment) || !fs.existsSync(filePath)) {
      fail('FOLLOW_SELLER_EVIDENCE_ATTACHMENT_PATH_FORBIDDEN');
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 50 * 1024 * 1024) {
      fail('FOLLOW_SELLER_EVIDENCE_ATTACHMENT_SIZE_INVALID');
    }
    const bytes = fs.readFileSync(filePath);
    const actualSha256 = createHash('sha256').update(bytes).digest('hex');
    const magicValid = kind === 'psd'
      ? bytes.subarray(0, 4).toString('ascii') === '8BPS'
      : bytes.subarray(0, 5).toString('ascii') === '%PDF-';
    if (!magicValid || actualSha256 !== expectedSha256) {
      fail('FOLLOW_SELLER_EVIDENCE_ATTACHMENT_TAMPERED');
    }
    return {
      kind,
      name: path.basename(String(item?.name || filePath)).slice(0, 180),
      path: filePath,
      sha256: actualSha256,
      size: stat.size,
    };
  });
  if (new Set(normalized.map((item) => item.kind)).size !== 2) {
    fail('FOLLOW_SELLER_EVIDENCE_PAIR_REQUIRED');
  }
  return normalized.sort((left, right) => left.kind.localeCompare(right.kind));
}

function validatedFollowSellerQuickAttachments(value) {
  const attachments = Array.isArray(value) ? value : [];
  if (!attachments.length || attachments.length > 3) fail('FOLLOW_SELLER_SCHEME1_IMAGE_REQUIRED');
  const evidenceSegment = `${path.sep}follow-seller-evidence${path.sep}`.toLowerCase();
  return attachments.map((item) => {
    const filePath = path.resolve(String(item?.path || '').trim());
    const expectedSha256 = String(item?.sha256 || '').trim().toLowerCase();
    if (String(item?.kind || '').trim().toLowerCase() !== 'current_image'
      || !/^[a-f0-9]{64}$/u.test(expectedSha256)
      || !filePath.toLowerCase().includes(evidenceSegment)
      || !fs.existsSync(filePath)) {
      fail('FOLLOW_SELLER_SCHEME1_IMAGE_INVALID');
    }
    const stat = fs.statSync(filePath);
    const bytes = fs.readFileSync(filePath);
    const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    const magicValid = (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
      || bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      || ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
      || webp;
    const actualSha256 = createHash('sha256').update(bytes).digest('hex');
    if (!stat.isFile() || stat.size <= 0 || stat.size > 20 * 1024 * 1024
      || !magicValid || actualSha256 !== expectedSha256) {
      fail('FOLLOW_SELLER_SCHEME1_IMAGE_TAMPERED');
    }
    return {
      kind: 'current_image',
      name: path.basename(String(item?.name || filePath)).slice(0, 180),
      path: filePath,
      sha256: actualSha256,
      size: stat.size,
    };
  });
}

function validatedFollowSellerQuickEvidenceFollowers(value) {
  const rows = Array.isArray(value) ? value : [];
  const normalized = [];
  for (const item of rows.slice(0, 3)) {
    const sku = String(item?.sku || '').trim();
    let parsed;
    try {
      parsed = new URL(String(item?.productLink || '').trim());
    } catch {
      fail('FOLLOW_SELLER_SCHEME1_FOLLOWER_URL_INVALID');
    }
    const hostname = parsed.hostname.toLowerCase();
    if (!/^\d{5,20}$/u.test(sku)
      || parsed.protocol !== 'https:'
      || (hostname !== 'ozon.ru' && !hostname.endsWith('.ozon.ru'))
      || !parsed.toString().includes(sku)) {
      fail('FOLLOW_SELLER_SCHEME1_FOLLOWER_URL_INVALID');
    }
    normalized.push({ sku, productLink: parsed.toString() });
  }
  if (!normalized.length) fail('FOLLOW_SELLER_SCHEME1_FOLLOWER_URL_REQUIRED');
  return normalized;
}

function validatedFollowSellerQuickFollowers(value, followerSkus = []) {
  const allowed = [...new Set((Array.isArray(followerSkus) ? followerSkus : [])
    .map((item) => String(item || '').trim())
    .filter((item) => /^\d{5,20}$/u.test(item)))];
  const rows = Array.isArray(value) ? value : [];
  if (rows.length > 200) fail('FOLLOW_SELLER_SCHEME1_FOLLOWER_DATA_INCOMPLETE');
  const bySku = new Map();
  for (const item of rows.slice(0, 200)) {
    const normalized = validatedFollowSellerQuickEvidenceFollowers([item])[0];
    if (bySku.has(normalized.sku)) fail('FOLLOW_SELLER_SCHEME1_FOLLOWER_URL_INVALID');
    bySku.set(normalized.sku, normalized);
  }
  if (!allowed.length || bySku.size !== allowed.length || allowed.some((sku) => !bySku.has(sku))) {
    fail('FOLLOW_SELLER_SCHEME1_FOLLOWER_DATA_INCOMPLETE');
  }
  return allowed.map((sku) => bySku.get(sku));
}

function validatedFollowSellerEvidenceManifest(value) {
  const filePath = path.resolve(String(value || '').trim());
  const evidenceSegment = `${path.sep}follow-seller-evidence${path.sep}`.toLowerCase();
  if (!filePath.toLowerCase().includes(evidenceSegment)
    || path.extname(filePath).toLowerCase() !== '.json'
    || !fs.existsSync(filePath)
    || !fs.statSync(filePath).isFile()) {
    fail('FOLLOW_SELLER_EVIDENCE_MANIFEST_PATH_FORBIDDEN');
  }
  return filePath;
}



























function normalizeBrowserRole(value, background = false) {
  if (value === PURCHASE_BROWSER_ROLES.MARKET_COLLECTOR) return PURCHASE_BROWSER_ROLES.MARKET_COLLECTOR;
  if (value === PURCHASE_BROWSER_ROLES.FOLLOW_SELLER_COLLECTOR) return PURCHASE_BROWSER_ROLES.FOLLOW_SELLER_COLLECTOR;
  if (value === PURCHASE_BROWSER_ROLES.PRODUCT_LINK_PARSER) return PURCHASE_BROWSER_ROLES.PRODUCT_LINK_PARSER;
  return background === true ? PURCHASE_BROWSER_ROLES.MARKET_COLLECTOR : PURCHASE_BROWSER_ROLES.INTERACTIVE;
}





function isBackgroundBrowserRole(role) {
  return role === PURCHASE_BROWSER_ROLES.MARKET_COLLECTOR
    || role === PURCHASE_BROWSER_ROLES.FOLLOW_SELLER_COLLECTOR
    || role === PURCHASE_BROWSER_ROLES.PRODUCT_LINK_PARSER;
}

function isBackgroundCollectorCommand(command) {
  return String(command || '').startsWith('ozon-data-');
}

function followSellerRuntimeProxy(storedProxy = {}, networkMode = 'auto', detectedProxy = null) {
  const requestedMode = String(networkMode || 'auto').trim().toLowerCase();
  if (!['auto', 'direct', 'system', 'fixed'].includes(requestedMode)) {
    fail('PURCHASE_BROWSER_NETWORK_MODE_INVALID');
  }
  if (requestedMode === 'direct') {
    return { mode: 'direct', rules: '', bypassRules: '<-loopback>', credentialRef: '' };
  }
  if (requestedMode === 'fixed') {
    if (storedProxy?.mode !== 'fixed_servers' || !String(storedProxy?.rules || '').trim()) {
      fail('PURCHASE_BROWSER_FIXED_PROXY_REQUIRED');
    }
    return storedProxy;
  }
  if (requestedMode === 'auto' && storedProxy?.mode === 'fixed_servers') return storedProxy;
  if (
    requestedMode === 'auto'
    && detectedProxy?.mode === 'fixed_servers'
    && String(detectedProxy?.rules || '').trim()
  ) {
    return detectedProxy;
  }
  // Chromium's system mode follows a live desktop proxy when one is enabled,
  // and is equivalent to a direct connection when Windows has no proxy. This
  // keeps the patrol-only browser independent from the other browser roles.
  return { mode: 'system', rules: '', bypassRules: '<-loopback>', credentialRef: '' };
}

export function ozonFollowSellerCommandTimeoutMs(skus = []) {
  const skuCount = new Set((Array.isArray(skus) ? skus : [])
    .map((sku) => String(sku || '').trim())
    .filter((sku) => /^\d{5,20}$/u.test(sku)))
    .size;
  const requestGroups = Math.max(1, Math.ceil(Math.min(1000, skuCount) / 100));
  // Native follow-seller capture allows 60s base time plus 20s per 100 SKUs.
  // Keep a 15s queue buffer so the JS queue never cancels a healthy CEF job first.
  return Math.min(300_000, 75_000 + requestGroups * 20_000);
}

export function marketCollectorOwnerRef(storageRef) {
  const normalized = requiredText(storageRef, 'PURCHASE_BROWSER_STORAGE_REF_INVALID', 40);
  if (!OWNER_REF_PATTERN.test(normalized)) fail('PURCHASE_BROWSER_STORAGE_REF_INVALID');
  return sha256(`market-collector\0${normalized}`).slice(0, 40);
}

export function followSellerCollectorOwnerRef(storageRef) {
  const normalized = requiredText(storageRef, 'PURCHASE_BROWSER_STORAGE_REF_INVALID', 40);
  if (!OWNER_REF_PATTERN.test(normalized)) fail('PURCHASE_BROWSER_STORAGE_REF_INVALID');
  return sha256(`follow-seller-collector\0${normalized}`).slice(0, 40);
}

export function productLinkParserOwnerRef(storageRef) {
  const normalized = requiredText(storageRef, 'PURCHASE_BROWSER_STORAGE_REF_INVALID', 40);
  if (!OWNER_REF_PATTERN.test(normalized)) fail('PURCHASE_BROWSER_STORAGE_REF_INVALID');
  return sha256(`product-link-parser\0${normalized}`).slice(0, 40);
}

export function selectInteractiveTabsToEvict(values = [], exemptTabId = '', maximum = MAX_INTERACTIVE_BROWSER_TABS) {
  const boundedMaximum = Math.max(1, Number(maximum) || MAX_INTERACTIVE_BROWSER_TABS);
  return (Array.isArray(values) ? values : [])
    .filter((tab) => tab?.background !== true && tab?.tabId !== exemptTabId)
    .sort((left, right) => Number(right?.lastUsedAt || 0) - Number(left?.lastUsedAt || 0))
    .slice(Math.max(0, boundedMaximum - 1));
}

function isDescendant(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}





function normalizeTargetPhase(value, fallback = 'idle') {
  return PURCHASE_BROWSER_TARGET_PHASES.includes(value) ? value : fallback;
}

function normalizeTargetContext(value = {}) {
  const target = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const targetId = requiredText(target.targetId, 'PURCHASE_BROWSER_TARGET_REQUIRED', 180);
  const shopId = requiredText(target.shopId, 'PURCHASE_BROWSER_TARGET_REQUIRED', 180);
  const orderKey = requiredText(target.orderKey, 'PURCHASE_BROWSER_TARGET_REQUIRED', 260);
  return Object.freeze({
    targetId,
    shopId,
    orderKey,
    ozonOrderId: cleanOptionalText(target.ozonOrderId, 260),
    sku: cleanOptionalText(target.sku, 260),
    offerId: cleanOptionalText(target.offerId, 260),
    productTitle: cleanOptionalText(target.productTitle, 600),
    quantity: target.quantity ?? null,
    purchaseRecordId: cleanOptionalText(target.purchaseRecordId, 260),
    requiredFields: Object.freeze(
      (Array.isArray(target.requiredFields) && target.requiredFields.length
        ? target.requiredFields
        : ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny', 'sourceUrl'])
        .map((field) => cleanOptionalText(field, 80))
        .filter(Boolean)
        .slice(0, 20),
    ),
    selectedAt: cleanOptionalText(target.selectedAt, 80) || new Date().toISOString(),
  });
}

function targetFingerprint(target) {
  if (!target) return '';
  return sha256(JSON.stringify({
    targetId: target.targetId,
    shopId: target.shopId,
    orderKey: target.orderKey,
    ozonOrderId: target.ozonOrderId || '',
    sku: target.sku || '',
    offerId: target.offerId || '',
    productTitle: target.productTitle || '',
    quantity: target.quantity ?? null,
    purchaseRecordId: target.purchaseRecordId || '',
    requiredFields: [...(target.requiredFields || [])].sort(),
    selectedAt: target.selectedAt || '',
  }));
}

function normalizeAutoOrderProduct(value = {}) {
  const product = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceUrl = requiredText(product.sourceUrl, 'PURCHASE_AUTO_ORDER_SOURCE_URL_REQUIRED', 1800);
  const platform = cleanOptionalText(product.sourcePlatform || purchasePlatformFromUrl(sourceUrl), 40);
  if (!PURCHASE_AUTO_ORDER_PLATFORMS.has(platform)) fail('PURCHASE_AUTO_ORDER_PLATFORM_UNSUPPORTED');
  const quantity = Number(product.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) fail('PURCHASE_AUTO_ORDER_QUANTITY_INVALID');
  const expectedUnitPrice = Number(product.expectedUnitPrice);
  if (!Number.isFinite(expectedUnitPrice) || expectedUnitPrice < 0) fail('PURCHASE_AUTO_ORDER_EXPECTED_PRICE_INVALID');
  return Object.freeze({
    sourceUrl,
    sourcePlatform: platform,
    sourceSkuId: cleanOptionalText(product.sourceSkuId, 260),
    sourceSkuName: cleanOptionalText(product.sourceSkuName, 800),
    sourceProductId: purchaseSourceProductId(sourceUrl),
    quantity,
    expectedUnitPrice: Number(expectedUnitPrice.toFixed(2)),
  });
}

function existingPaymentStartUrl(platform, orderNumber) {
  const order = cleanOptionalText(orderNumber, 260);
  if (!order) return '';
  if (platform === '拼多多') return `https://mobile.yangkeduo.com/order.html?order_sn=${encodeURIComponent(order)}`;
  if (platform === '淘宝' || platform === '天猫') return PAYMENT_BOOTSTRAP_URLS[platform];
  if (platform === '1688') return PAYMENT_BOOTSTRAP_URLS['1688'];
  return '';
}

export function normalizeAutoOrderRequest(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceAccountId = cleanOptionalText(input.sourceAccountId, 260);
  const posting = requiredText(input.posting, 'PURCHASE_AUTO_ORDER_POSTING_REQUIRED', 260);
  const shopId = requiredText(input.shopId, 'PURCHASE_AUTO_ORDER_SHOP_REQUIRED', 180);
  const rawProducts = (Array.isArray(input.products) ? input.products : []).map(normalizeAutoOrderProduct);
  if (!rawProducts.length) fail('PURCHASE_AUTO_ORDER_PRODUCTS_REQUIRED');
  const platforms = new Set(rawProducts.map((product) => product.sourcePlatform));
  if (platforms.size !== 1) fail('PURCHASE_AUTO_ORDER_SINGLE_PLATFORM_REQUIRED');
  // The current checkout primitive selects one exact marketplace SKU.  Merge
  // repeated lines of that same SKU, but fail closed instead of silently
  // ordering only the first line when one Ozon order contains several source
  // products/SKUs.
  const productKeys = new Set(rawProducts.map((product) => JSON.stringify({
    sourceUrl: product.sourceUrl,
    sourceSkuId: product.sourceSkuId,
    sourceSkuName: product.sourceSkuName,
    sourceProductId: product.sourceProductId,
    expectedUnitPrice: product.expectedUnitPrice,
  })));
  if (productKeys.size > 1) fail('PURCHASE_AUTO_ORDER_MULTI_PRODUCT_UNSUPPORTED');
  const combinedQuantity = rawProducts.reduce((sum, product) => sum + product.quantity, 0);
  if (!Number.isInteger(combinedQuantity) || combinedQuantity < 1 || combinedQuantity > 999) {
    fail('PURCHASE_AUTO_ORDER_QUANTITY_INVALID');
  }
  const products = Object.freeze([{ ...rawProducts[0], quantity: combinedQuantity }]);
  const calculatedTotal = products.reduce((sum, product) => sum + product.expectedUnitPrice * product.quantity, 0);
  const rawExpectedTotal = input.expectedTotal === undefined || input.expectedTotal === ''
    ? calculatedTotal
    : Number(input.expectedTotal);
  if (!Number.isFinite(rawExpectedTotal) || rawExpectedTotal < 0) fail('PURCHASE_AUTO_ORDER_EXPECTED_TOTAL_INVALID');
  if (Math.abs(Number(rawExpectedTotal.toFixed(2)) - Number(calculatedTotal.toFixed(2))) > 0.01 && input.allowShippingDifference !== true) {
    fail('PURCHASE_AUTO_ORDER_EXPECTED_TOTAL_MISMATCH');
  }
  const maxPayPrice = input.maxPayPrice === undefined || input.maxPayPrice === ''
    ? null
    : Number(input.maxPayPrice);
  if (maxPayPrice !== null && (!Number.isFinite(maxPayPrice) || maxPayPrice < 0 || maxPayPrice > 100000)) {
    fail('PURCHASE_AUTO_ORDER_MAX_PAYMENT_INVALID');
  }
  if (maxPayPrice !== null && rawExpectedTotal > maxPayPrice) fail('PURCHASE_AUTO_ORDER_MAX_PAYMENT_EXCEEDED');
  const minProfit = input.minProfit === undefined || input.minProfit === '' ? 0 : Number(input.minProfit);
  const minProfitPercent = input.minProfitPercent === undefined || input.minProfitPercent === ''
    ? 0
    : Number(input.minProfitPercent);
  if (!Number.isFinite(minProfit) || minProfit < -100000 || minProfit > 100000) {
    fail('PURCHASE_AUTO_ORDER_MIN_PROFIT_INVALID');
  }
  if (!Number.isFinite(minProfitPercent) || minProfitPercent < -100 || minProfitPercent > 100) {
    fail('PURCHASE_AUTO_ORDER_MIN_PROFIT_PERCENT_INVALID');
  }
  const verifiedProfit = input.verifiedProfit === undefined || input.verifiedProfit === null
    ? null
    : Number(input.verifiedProfit);
  const verifiedProfitPercent = input.verifiedProfitPercent === undefined || input.verifiedProfitPercent === null
    ? null
    : Number(input.verifiedProfitPercent);
  if (verifiedProfit !== null && !Number.isFinite(verifiedProfit)) fail('PURCHASE_AUTO_ORDER_VERIFIED_PROFIT_INVALID');
  if (verifiedProfitPercent !== null && !Number.isFinite(verifiedProfitPercent)) {
    fail('PURCHASE_AUTO_ORDER_VERIFIED_PROFIT_PERCENT_INVALID');
  }
  if (verifiedProfit !== null && verifiedProfit < minProfit) fail('PURCHASE_AUTO_ORDER_MIN_PROFIT_NOT_MET');
  if (verifiedProfitPercent !== null && verifiedProfitPercent < minProfitPercent) {
    fail('PURCHASE_AUTO_ORDER_MIN_PROFIT_PERCENT_NOT_MET');
  }
  const paymentMode1688 = input.paymentMode1688 === 'protocol' ? 'protocol' : 'password';
  const receiverInput = input.receiver && typeof input.receiver === 'object' && !Array.isArray(input.receiver)
    ? input.receiver
    : {};
  const receiver = Object.freeze({
    name: cleanOptionalText(receiverInput.name, 120),
    phone: cleanOptionalText(receiverInput.phone, 80),
    province: cleanOptionalText(receiverInput.province, 120),
    city: cleanOptionalText(receiverInput.city, 120),
    district: cleanOptionalText(receiverInput.district, 120),
    detail: cleanOptionalText(receiverInput.detail, 500),
    fullAddress: cleanOptionalText(receiverInput.fullAddress, 800),
  });
  const maxShippingFee = Number.isFinite(Number(input.maxShippingFee))
    ? Math.max(0, Math.min(100000, Number(input.maxShippingFee)))
    : 20;
  return Object.freeze({
    sourceAccountId: sourceAccountId || `auto:${products[0].sourcePlatform}`,
    posting,
    shopId,
    sourcePlatform: products[0].sourcePlatform,
    sourceAccountLogin: cleanOptionalText(input.sourceAccountLogin, 260),
    existingOrderNumber: cleanOptionalText(input.existingOrderNumber, 260),
    receiver,
    buyerMemo: cleanOptionalText(input.buyerMemo, 500),
    maxShippingFee: Number(maxShippingFee.toFixed(2)),
    allowSimilarSku: input.allowSimilarSku === true,
    products,
    expectedTotal: Number(rawExpectedTotal.toFixed(2)),
    calculatedTotal: Number(calculatedTotal.toFixed(2)),
    idempotencyKey: cleanOptionalText(input.idempotencyKey, 260) || sha256(JSON.stringify({ sourceAccountId, posting, shopId, products })),
    paymentMode: cleanOptionalText(input.paymentMode || 'alipay-password', 40),
    autoPay: input.autoPay !== false,
    autoSubmitOrder: input.autoSubmitOrder === true,
    allowTogetherPay: input.allowTogetherPay === true,
    allowShippingDifference: input.allowShippingDifference === true,
    maxPayPrice,
    minProfit: Number(minProfit.toFixed(2)),
    minProfitPercent: Number(minProfitPercent.toFixed(2)),
    verifiedProfit: verifiedProfit === null ? null : Number(verifiedProfit.toFixed(2)),
    verifiedProfitPercent: verifiedProfitPercent === null ? null : Number(verifiedProfitPercent.toFixed(2)),
    paymentMode1688,
    skipPresale: input.skipPresale === true,
    showVerificationWindow: input.showVerificationWindow !== false,
  });
}

export const PURCHASE_BROWSER_PURGE_RESOURCE_IDS = Object.freeze([
  'browser:purchase-cache-storage',
  'browser:purchase-cookies',
  'browser:purchase-downloads',
  'browser:purchase-extension-storage',
  'browser:purchase-http-cache',
  'browser:purchase-indexed-db',
  'browser:purchase-local-storage',
  'browser:purchase-persistent-partition',
  'browser:purchase-plugin-installation-state',
  'browser:purchase-profile-identity',
  'browser:purchase-proxy-auth',
  'browser:purchase-service-workers',
]);

export const INTEGRATION_BROWSER_PURGE_RESOURCE_IDS = Object.freeze([
  'browser:integration-cache-storage',
  'browser:integration-cookies',
  'browser:integration-downloads',
  'browser:integration-extension-storage',
  'browser:integration-http-cache',
  'browser:integration-indexed-db',
  'browser:integration-local-storage',
  'browser:integration-persistent-partition',
  'browser:integration-plugin-installation-state',
  'browser:integration-profile-identity',
  'browser:integration-proxy-auth',
  'browser:integration-service-workers',
]);

export function createCefPurchaseBrowserController({
  cefRuntime,
  profileStore,
  addonManager,
  policy,
  localApiClient,
  dataRoot,
  profileRoot = path.join(dataRoot || '', 'purchase-browser', 'cef-profiles'),
  downloadsRoot = path.join(dataRoot || '', 'purchase-browser', 'downloads'),
  appendLog = () => undefined,
  onStateChanged = () => undefined,
  createTabId = () => `purchase_tab_${randomUUID()}`,
  requestRestartForAccountRemoval,
  removalObserveTimeoutMs = 20_000,
  alipayPaymentWindowController = null,
  getPaymentCredential = async () => null,
  savePaymentCredential = async () => ({ ok: false, code: 'PURCHASE_PAYMENT_CREDENTIAL_STORE_UNAVAILABLE' }),
  clearPaymentCredential = async () => ({ ok: false, code: 'PURCHASE_PAYMENT_CREDENTIAL_STORE_UNAVAILABLE' }),
  getPaymentCredentialStatus = async () => ({ ok: false, code: 'PURCHASE_PAYMENT_CREDENTIAL_STORE_UNAVAILABLE' }),
  getAlipayLoginCredential = async () => null,
  saveAlipayLoginCredential = async () => ({ ok: false, code: 'ALIPAY_LOGIN_CREDENTIAL_STORE_UNAVAILABLE' }),
  clearAlipayLoginCredential = async () => ({ ok: false, code: 'ALIPAY_LOGIN_CREDENTIAL_STORE_UNAVAILABLE' }),
  getAlipayLoginCredentialStatus = async () => ({ ok: false, code: 'ALIPAY_LOGIN_CREDENTIAL_STORE_UNAVAILABLE' }),
  resolveFollowSellerAutoProxy = detectFollowSellerLoopbackHttpProxy,
	waitForDelay = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); }),
} = {}) {
  if (!cefRuntime || !profileStore || !addonManager || !policy || !localApiClient) {
    fail('PURCHASE_BROWSER_CEF_CONTROLLER_DEPENDENCY_REQUIRED');
  }
  const ownedDataRoot = path.resolve(requiredText(dataRoot, 'PURCHASE_BROWSER_DATA_ROOT_REQUIRED', 1200));
  const ownedProfileRoot = path.resolve(profileRoot);
  const ownedDownloadsRoot = path.resolve(downloadsRoot);
  const pendingRemovalRoot = path.join(ownedDataRoot, 'purchase-browser', 'pending-account-removals');
  if (!isDescendant(ownedDataRoot, ownedProfileRoot) || !isDescendant(ownedDataRoot, ownedDownloadsRoot)) {
    fail('PURCHASE_BROWSER_OWNED_ROOT_INVALID');
  }
  fs.mkdirSync(ownedProfileRoot, { recursive: true });
  fs.mkdirSync(ownedDownloadsRoot, { recursive: true });

  let hostWindow = null;
  let browserOwnerWindow = null;
  let activeTabId = '';
  let viewport = { x: 0, y: 0, width: 1, height: 1, visible: false };
  let stateRevision = 0;
  const tabs = new Map();
  const pendingOpens = new Map();
  let visibilityVersion = 0;
  let hiddenIntentVersion = 0;
  let boundsVersion = 0;
  let visibilityChain = Promise.resolve();
  let activeQueuedCommand = null;
  const sessions = createPurchaseBrowserSessionManager();
  const commandQueue = createPurchaseBrowserCommandQueue({
    onStateChanged: () => {
      if (hostWindow && !hostWindow.isDestroyed?.()) emit('queue-state');
    },
  });
  // Product-link inspection owns a separate native-browser lane.  A slow
  // Taobao/1688/Ozon product page can no longer cancel, supersede or wait
  // behind the long-running market-collector pagination queue.
  const productLinkCommandQueue = createPurchaseBrowserCommandQueue({
    onStateChanged: () => {
      if (hostWindow && !hostWindow.isDestroyed?.()) emit('product-link-queue-state');
    },
  });
  // Follow-seller patrols can spend several minutes reading public product
  // pages. Give them a dedicated queue so they never block, cancel or reuse
  // the market collector or a user's interactive browser command lane.
  const followSellerCommandQueue = createPurchaseBrowserCommandQueue({
    onStateChanged: () => {
      if (hostWindow && !hostWindow.isDestroyed?.()) emit('follow-seller-queue-state');
    },
  });
  const removingOwnerRefs = new Set();
  const removalMaintenance = createPurchaseRemovalMaintenance({
    run: purgeOperation,
    observeTimeoutMs: removalObserveTimeoutMs,
  });

  function emit(event, details = {}) {
    if (!hostWindow || hostWindow.isDestroyed?.()) return;
    stateRevision += 1;
    const nextState = snapshot();
    try {
      hostWindow.webContents?.send?.('desktop:purchase-browser-event', { event, ...details, state: nextState });
    } catch {
      // A closing main window must not interrupt the browser session cleanup.
    }
    try {
      onStateChanged(nextState);
    } catch {
      // UI state synchronization must never break the browser command itself.
    }
  }

  function publicTab(tab) {
    return {
      tabId: tab.tabId,
      accountId: tab.binding.accountId,
      ownerType: tab.binding.ownerType || 'purchase_account',
      integrationType: tab.binding.integrationType || '',
      browserRole: tab.browserRole,
      background: tab.background === true,
      displayMode: tab.displayMode || 'window',
      browserLayout: cleanOptionalText(tab.browserLayout, 80),
      followSellerVerificationVisible: tab.followSellerVerificationPresentation?.visible === true
        && tab.background !== true,
      followSellerVerificationStatus: tab.followSellerVerificationStatus
        && typeof tab.followSellerVerificationStatus === 'object'
        ? { ...tab.followSellerVerificationStatus }
        : null,
      storageRef: tab.storageRef,
      engine: 'cef',
      title: tab.state.title || '新标签页',
      url: tab.state.url || 'about:blank',
      requestedUrl: tab.requestedUrl || tab.state.url || 'about:blank',
      loading: tab.state.loading === true,
      navigationSequence: Number(tab.state.navigationSequence) || 0,
      navigationStartedSequence: Number(tab.state.navigationStartedSequence) || 0,
      navigationCompletedSequence: Number(tab.state.navigationCompletedSequence) || 0,
      crashed: tab.state.crashed === true,
      canGoBack: tab.state.canGoBack === true,
      canGoForward: tab.state.canGoForward === true,
      extension: tab.addonState,
      sessionId: tab.session?.sessionId || '',
      generation: Number(tab.session?.generation) || 0,
      phase: tab.session?.phase || (tab.state.crashed ? 'crashed' : 'ready'),
      health: tab.session?.health || (tab.state.crashed ? 'unhealthy' : 'healthy'),
      target: tab.target || null,
      targetPhase: normalizeTargetPhase(
        tab.targetPhase,
        tab.target ? 'target-locked' : 'idle',
      ),
      captureReady: Boolean(tab.capturePreview),
      purchaseContextReady: Boolean(tab.purchaseContext?.purchaseOrderNumber),
      autoOrder: tab.autoOrder && typeof tab.autoOrder === 'object'
        ? {
            idempotencyKey: tab.autoOrder.idempotencyKey,
            stage: tab.autoOrder.stage,
            sourcePlatform: tab.autoOrder.sourcePlatform,
            purchaseOrderNumber: tab.autoOrder.purchaseOrderNumber || '',
            paymentUrl: tab.autoOrder.paymentUrl || '',
            paused: tab.autoOrder.paused === true,
            updatedAt: tab.autoOrder.updatedAt || '',
          }
        : null,
      proxyMode: cleanOptionalText(tab.state.proxyMode, 40) || 'direct',
      proxyConfigured: tab.state.proxyConfigured === true,
      zoomLevel: Number.isFinite(Number(tab.state.zoomLevel)) ? Number(tab.state.zoomLevel) : 0,
      pageFitMode: cleanOptionalText(tab.state.pageFitMode, 40) || 'native',
      loadErrorCode: Number.isInteger(Number(tab.state.loadErrorCode)) ? Number(tab.state.loadErrorCode) : 0,
      loadErrorHost: cleanOptionalText(tab.state.loadErrorHost, 253),
      lastUsedAt: Number(tab.lastUsedAt) || 0,
      embedding: tab.state.embedding && typeof tab.state.embedding === 'object'
        ? { ...tab.state.embedding }
        : null,
    };
  }

  function snapshot() {
    const activeTab = tabs.get(activeTabId);
    return {
      ok: true,
      engine: 'cef',
      revision: stateRevision,
      boundsVersion,
      activeTabId,
      visible: Boolean(activeTab && viewport.visible && activeTab.background !== true),
      sessionId: String(activeTab?.session?.sessionId || ''),
      generation: Number(activeTab?.session?.generation) || 0,
      phase: activeTab?.session?.phase || (activeTab ? 'ready' : 'idle'),
      health: activeTab?.session?.health || (activeTab?.state?.crashed ? 'unhealthy' : 'unknown'),
      queue: commandQueue.getSnapshot(),
      productLinkQueue: productLinkCommandQueue.getSnapshot(),
      followSellerQueue: followSellerCommandQueue.getSnapshot(),
      tabs: [...tabs.values()].map(publicTab),
    };
  }

  function browserBounds(tab) {
    return {
      ...viewport,
      visible: tab.background !== true && viewport.visible && tab.tabId === activeTabId,
    };
  }

  function verifyEmbeddedWindowReadback(tab, applied, requestedBounds) {
    if (
      tab.background === true
      || tab.tabId !== activeTabId
      || tab.displayMode !== 'embedded'
      || requestedBounds.visible !== true
    ) return;
    const embedding = applied?.embedding;
    const expectedParent = String(embedding?.parentHwnd || '0');
    const actualParent = String(embedding?.actualParentHwnd || '0');
    const nativeBounds = embedding?.bounds;
	const chromiumWindows = Array.isArray(embedding?.chromiumWindows) ? embedding.chromiumWindows : [];
    const boundsMatch = nativeBounds && ['x', 'y', 'width', 'height'].every((field) => (
      Number.isFinite(Number(nativeBounds[field]))
      && Math.abs(Number(nativeBounds[field]) - Number(requestedBounds[field])) <= 2
    ));
    if (
      embedding?.requested !== true
      || embedding?.embedded !== true
      || embedding?.childStyle !== true
      || expectedParent === '0'
      || actualParent !== expectedParent
	  || embedding?.windowVisible !== true
	  || embedding?.browserPanelVisible !== true
	  || embedding?.browserPresentationVisible !== true
	  || (chromiumWindows.length > 0 && embedding?.browserSurfaceVisible !== true)
      || !boundsMatch
    ) fail('PURCHASE_BROWSER_EMBED_READBACK_FAILED');
  }

  function verifyEmbeddedHiddenReadback(tab, applied, requestedBounds) {
    if (
      tab.background === true
      || tab.tabId !== activeTabId
      || tab.displayMode !== 'embedded'
      || requestedBounds.visible !== false
    ) return;
    const embedding = applied?.embedding;
    const nativeBounds = embedding?.bounds;
	const chromiumWindows = Array.isArray(embedding?.chromiumWindows) ? embedding.chromiumWindows : [];
	const chromiumSurfaceStillVisible = chromiumWindows.some((window) => (
	  window?.visible === true || window?.onScreen === true
	));
    if (
      embedding?.requested !== true
      || embedding?.embedded !== true
      || embedding?.childStyle !== true
	  || embedding?.windowVisible !== false
	  || embedding?.browserPanelVisible !== false
	  || embedding?.browserPresentationVisible !== false
	  || embedding?.browserSurfaceVisible !== false
	  || chromiumSurfaceStillVisible
      || !nativeBounds
      || !Number.isFinite(Number(nativeBounds.x))
      || !Number.isFinite(Number(nativeBounds.y))
      || Number(nativeBounds.x) > -30_000
      || Number(nativeBounds.y) > -30_000
    ) fail('PURCHASE_BROWSER_EMBED_HIDE_READBACK_FAILED');
  }

  async function applyVerifiedBounds(tab, bounds, requestedVisibilityVersion) {
    const retryDelays = (
      tab.background !== true
      && tab.displayMode === 'embedded'
      && bounds.visible === true
    ) ? EMBEDDED_SURFACE_READBACK_DELAYS_MS : [];
    for (let attempt = 0; ; attempt += 1) {
      try {
        const applied = await tab.browser.request('bounds', {
          bounds,
          visibilityVersion: requestedVisibilityVersion,
        });
        const readback = applied?.bounds;
        if (readback && bounds.visible === true && tab.displayMode === 'embedded') {
          // Embedded HWNDs must match the React card exactly. A standalone
          // top-level window is different: WinForms/Windows may legally clamp
          // it to MinimumSize or the monitor work area while switching out of
          // WS_CHILD mode. Rejecting that valid native readback made a product
          // title open flash, hide, and fail forever after an order workbench.
          const matches = ['x', 'y', 'width', 'height'].every((field) => (
            Number.isFinite(Number(readback[field]))
            && Math.abs(Number(readback[field]) - Number(bounds[field])) <= 2
          ));
          if (!matches) fail('PURCHASE_BROWSER_BOUNDS_READBACK_FAILED');
        }
        verifyEmbeddedWindowReadback(tab, applied, bounds);
        verifyEmbeddedHiddenReadback(tab, applied, bounds);
        return applied;
      } catch (error) {
        if (
          sanitizedErrorCode(error) !== 'PURCHASE_BROWSER_EMBED_READBACK_FAILED'
          || attempt >= retryDelays.length
        ) throw error;
        await new Promise((resolve) => { setTimeout(resolve, retryDelays[attempt]); });
      }
    }
  }

  function firstInteractiveTabId() {
    return [...tabs.values()].find((tab) => tab.background !== true)?.tabId || '';
  }

  function invalidateBoundsForViewportChange() {
    for (const tab of tabs.values()) {
      if (tab.background === true) continue;
      // A hidden inactive tab does not need the new rectangle. Preserve its
      // proven hidden state so a slow unrelated page cannot delay the active
      // order workbench. The active/previously-visible tab is always fenced.
      if (
        tab.tabId === activeTabId
        || tab.appliedBounds?.visible === true
        || !tab.appliedBounds
      ) tab.appliedBounds = null;
    }
  }

  function setTargetPhase(tab, phase) {
    const next = normalizeTargetPhase(phase, tab.target ? 'target-locked' : 'idle');
    const changed = tab.targetPhase !== next;
    if (changed && !TARGET_PHASE_TRANSITIONS[tab.targetPhase || 'idle']?.has(next)) {
      fail('PURCHASE_BROWSER_TARGET_PHASE_INVALID');
    }
    tab.targetPhase = next;
    if (changed && tabs.has(tab.tabId)) emit('target-phase', { tabId: tab.tabId, targetPhase: next });
    return next;
  }

  function clearPinduoduoAutoCapture(tab, { reset = false } = {}) {
    if (tab?.pinduoduoAutoCaptureTimer) clearTimeout(tab.pinduoduoAutoCaptureTimer);
    if (tab) tab.pinduoduoAutoCaptureTimer = null;
    if (reset && tab) {
      tab.pinduoduoOrderEvidence = null;
      tab.pinduoduoAutoCaptureCompletedKey = '';
      tab.pinduoduoAutoCaptureBlockedKey = '';
      tab.pinduoduoRefundCaptureCompletedKey = '';
      tab.alipayPaymentRedirectKey = '';
    }
  }

  function evictInactiveInteractiveTabs(exemptTabId) {
    const stale = selectInteractiveTabsToEvict([...tabs.values()], exemptTabId);
    for (const tab of stale) {
      void close(tab.tabId).catch(() => forceClose(tab.tabId).catch(() => undefined));
    }
  }

  function shouldMonitorPinduoduoOrder(tab) {
    return Boolean(
      tab
      && tabs.has(tab.tabId)
      && tab.background !== true
      && tab.profile?.platformKey === 'pinduoduo'
      && tab.target
      && !tab.state?.crashed
      && isPinduoduoUrl(tab.state?.url),
    );
  }

  function schedulePinduoduoAutoCapture(tab, delayMs = PINDUODUO_ORDER_POLL_MS) {
    if (!shouldMonitorPinduoduoOrder(tab)) return;
    if (tab.pinduoduoAutoCaptureTimer || tab.pinduoduoAutoCaptureInFlight) return;
    tab.pinduoduoAutoCaptureTimer = setTimeout(() => {
      tab.pinduoduoAutoCaptureTimer = null;
      void commandQueue.enqueue('pdd-auto-capture', ({ signal }) => (
        runPinduoduoAutoCapture(tab, { signal })
      ), {
        timeoutMs: 45_000,
        coalesceKey: `pdd-auto-capture\u0000${tab.tabId}`,
      }).catch((error) => appendLog(
        'desktop-main',
        `[purchase-browser] pdd auto-capture queue pending tab=${tab.tabId} code=${sanitizedErrorCode(error)}\n`,
      ));
    }, Math.max(100, Number(delayMs) || PINDUODUO_ORDER_POLL_MS));
  }

  function rememberPinduoduoOrderEvidence(tab, capture, targetHash) {
    const previous = tab.pinduoduoOrderEvidence?.targetHash === targetHash
      ? tab.pinduoduoOrderEvidence
      : {};
    const price = Number(capture.purchasePrice);
    const currentSourceUrl = cleanOptionalText(capture.sourceUrl, 1800);
    tab.pinduoduoOrderEvidence = {
      targetHash,
      purchasePrice: Number.isFinite(price) && price > 0 ? price : previous.purchasePrice ?? null,
      amount: Number.isFinite(price) && price > 0 ? String(price) : previous.amount || '',
      productTitle: cleanOptionalText(capture.productTitle, 600) || previous.productTitle || '',
      quantity: capture.quantity ?? previous.quantity ?? null,
      sourceProductId: cleanOptionalText(capture.sourceProductId, 260) || previous.sourceProductId || '',
      sourceUrl: isPinduoduoProductUrl(currentSourceUrl) ? currentSourceUrl : previous.sourceUrl || '',
      capturedAt: cleanOptionalText(capture.capturedAt, 80) || previous.capturedAt || '',
    };
    return tab.pinduoduoOrderEvidence;
  }

  async function runPinduoduoAutoCapture(tab, { force = false, signal } = {}) {
    if (!shouldMonitorPinduoduoOrder(tab)) return;
    if (tab.pinduoduoAutoCaptureInFlight) return;
    if (!force && (tab.tabId !== activeTabId || viewport.visible !== true || tab.state?.loading === true)) {
      schedulePinduoduoAutoCapture(tab, PINDUODUO_ORDER_HIDDEN_POLL_MS);
      return;
    }
    tab.pinduoduoAutoCaptureInFlight = true;
    const target = tab.target;
    const targetHash = targetFingerprint(target);
    try {
      const raw = await tab.browser.request('inspect-pinduoduo-order', {}, 7_000, signal);
      if (!tabs.has(tab.tabId) || targetFingerprint(tab.target) !== targetHash) return;
      const inspected = normalizePurchaseCapture(raw && typeof raw === 'object' ? raw : {});
      if (inspected.platform !== '拼多多') return;
      const evidence = rememberPinduoduoOrderEvidence(tab, inspected, targetHash);
      const inspectedPrice = Number(inspected.purchasePrice);
      const capture = Object.freeze({
        ...inspected,
        purchasePrice: Number.isFinite(inspectedPrice) && inspectedPrice > 0
          ? inspectedPrice
          : evidence.purchasePrice,
        amount: Number.isFinite(inspectedPrice) && inspectedPrice > 0
          ? String(inspectedPrice)
          : evidence.amount,
        productTitle: inspected.productTitle || evidence.productTitle,
        quantity: inspected.quantity ?? evidence.quantity,
        sourceProductId: inspected.sourceProductId || evidence.sourceProductId,
        sourceUrl: evidence.sourceUrl || inspected.sourceUrl,
        purchaseOrderUrl: inspected.purchaseOrderUrl || inspected.pageUrl,
      });
      const orderNumber = cleanOptionalText(capture.purchaseOrderNumber, 260);
      const status = cleanOptionalText(capture.purchaseOrderStatus || capture.status, 160);
      const purchasePrice = Number(capture.purchasePrice);
      const refundConfirmed = capture.refundConfirmed === true || isConfirmedPurchaseRefundStatus(status);
      if (refundConfirmed) {
        if (!orderNumber) return;
        const boundOrderNumber = cleanOptionalText(tab.purchaseContext?.purchaseOrderNumber, 260);
        if (boundOrderNumber && boundOrderNumber !== orderNumber) {
          fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
        }
        const refundKey = sha256(JSON.stringify([targetHash, orderNumber, status, 'refund']));
        if (refundKey === tab.pinduoduoRefundCaptureCompletedKey) return;
        if (
          typeof localApiClient.previewPurchaseRefund !== 'function'
          || typeof localApiClient.confirmPurchaseRefund !== 'function'
        ) fail('PURCHASE_BROWSER_CAPTURE_SERVICE_UNAVAILABLE');
        const refundCapture = {
          platform: '拼多多',
          purchaseOrderNumber: orderNumber,
          purchaseOrderStatus: status,
          purchaseOrderUrl: capture.purchaseOrderUrl || capture.pageUrl,
          capturedAt: capture.capturedAt,
        };
        const preview = await localApiClient.previewPurchaseRefund({
          target,
          capture: refundCapture,
          idempotencyKey: `pdd_refund_${refundKey}`,
        }, { signal });
        if (!tabs.has(tab.tabId) || targetFingerprint(tab.target) !== targetHash) {
          fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
        }
        const result = await localApiClient.confirmPurchaseRefund({
          previewId: preview.previewId,
          idempotencyKey: preview.idempotencyKey || `pdd_refund_${refundKey}`,
          confirmationToken: preview.confirmationToken,
          captureHash: preview.captureHash,
          target,
        }, { signal });
        if (result?.readbackVerified !== true) fail('PURCHASE_BROWSER_READBACK_FAILED');
        if (!tabs.has(tab.tabId) || targetFingerprint(tab.target) !== targetHash) {
          fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
        }
        tab.purchaseContext = null;
        tab.pinduoduoRefundCaptureCompletedKey = refundKey;
        emit('purchase-order-refund-captured', {
          tabId: tab.tabId,
          target,
          capture: refundCapture,
          readback: result.readback,
          readbackVerified: true,
        });
        appendLog(
          'desktop-main',
          `[purchase-browser] pdd refund captured tab=${tab.tabId} target=${targetHash.slice(0, 12)} order=${sha256(orderNumber).slice(0, 12)}\n`,
        );
        return;
      }
      if (
        !orderNumber
        || !Number.isFinite(purchasePrice)
        || purchasePrice <= 0
        || !(capture.paymentConfirmed === true || isConfirmedPurchaseOrderStatus(status))
      ) return;
      const captureKey = sha256(JSON.stringify([targetHash, orderNumber, purchasePrice, status]));
      if (
        captureKey === tab.pinduoduoAutoCaptureCompletedKey
        || captureKey === tab.pinduoduoAutoCaptureBlockedKey
      ) return;
      if (
        typeof localApiClient.previewPurchaseCapture !== 'function'
        || typeof localApiClient.confirmPurchaseCapture !== 'function'
      ) fail('PURCHASE_BROWSER_CAPTURE_SERVICE_UNAVAILABLE');
      const preview = await localApiClient.previewPurchaseCapture({
        target,
        capture,
        idempotencyKey: `pdd_auto_${captureKey}`,
      }, { signal });
      if (!tabs.has(tab.tabId) || targetFingerprint(tab.target) !== targetHash) {
        fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
      }
      const missingFields = Array.isArray(preview?.missingFields) ? preview.missingFields : [];
      const conflicts = Array.isArray(preview?.conflicts) ? preview.conflicts : [];
      if (missingFields.length || conflicts.length) {
        tab.pinduoduoAutoCaptureBlockedKey = captureKey;
        emit('purchase-order-auto-capture-blocked', {
          tabId: tab.tabId,
          target,
          code: conflicts.length
            ? 'PURCHASE_BROWSER_CAPTURE_CONFLICT_CONFIRMATION_REQUIRED'
            : 'PURCHASE_BROWSER_CAPTURE_FIELDS_MISSING',
          missingFields,
          conflicts,
        });
        return;
      }
      const result = await localApiClient.confirmPurchaseCapture({
        previewId: preview.previewId,
        idempotencyKey: preview.idempotencyKey || `pdd_auto_${captureKey}`,
        confirmationToken: preview.confirmationToken,
        captureHash: preview.captureHash,
        target,
        acceptConflicts: false,
      }, { signal });
      if (result?.readbackVerified !== true) fail('PURCHASE_BROWSER_READBACK_FAILED');
      if (!tabs.has(tab.tabId) || targetFingerprint(tab.target) !== targetHash) {
        fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
      }
      const override = result.readback?.override || {};
      tab.purchaseContext = {
        purchaseOrderNumber: cleanOptionalText(override.purchaseOrderNumber || orderNumber, 260),
        purchasePlatform: cleanOptionalText(override.purchasePlatform || capture.platform, 80),
        purchaseOrderUrl: cleanOptionalText(
          override.purchaseOrderUrl || capture.purchaseOrderUrl || capture.pageUrl,
          1800,
        ),
        purchaseOrderStatus: cleanOptionalText(override.manualStatus || override.purchaseOrderStatus || status, 160),
        sourceCostCny: override.sourceCostCny ?? purchasePrice,
        productTitle: cleanOptionalText(capture.productTitle, 600),
        quantity: capture.quantity ?? null,
      };
      tab.pinduoduoAutoCaptureCompletedKey = captureKey;
      tab.pinduoduoAutoCaptureBlockedKey = '';
      emit('purchase-order-auto-captured', {
        tabId: tab.tabId,
        target,
        capture: {
          platform: tab.purchaseContext.purchasePlatform,
          purchaseOrderNumber: tab.purchaseContext.purchaseOrderNumber,
          purchaseOrderUrl: tab.purchaseContext.purchaseOrderUrl,
          purchaseOrderStatus: tab.purchaseContext.purchaseOrderStatus,
          purchasePrice: tab.purchaseContext.sourceCostCny,
          productTitle: tab.purchaseContext.productTitle,
          quantity: tab.purchaseContext.quantity,
          capturedAt: capture.capturedAt,
        },
        purchaseContext: { ...tab.purchaseContext },
        readback: result.readback,
        readbackVerified: true,
      });
      appendLog(
        'desktop-main',
        `[purchase-browser] pdd order auto-captured tab=${tab.tabId} target=${targetHash.slice(0, 12)} order=${sha256(orderNumber).slice(0, 12)}\n`,
      );
    } catch (error) {
      appendLog(
        'desktop-main',
        `[purchase-browser] pdd order auto-capture pending tab=${tab.tabId} code=${sanitizedErrorCode(error)}\n`,
      );
    } finally {
      tab.pinduoduoAutoCaptureInFlight = false;
      if (
        shouldMonitorPinduoduoOrder(tab)
        && !tab.pinduoduoRefundCaptureCompletedKey
        && (
          (tab.tabId === activeTabId && viewport.visible === true && tab.state?.loading !== true)
          || !tab.pinduoduoAutoCaptureCompletedKey
        )
      ) schedulePinduoduoAutoCapture(tab);
    }
  }

  async function returnPinduoduoTabFromAlipay(tab) {
    if (!tabs.has(tab.tabId)) return;
    try {
      if (tab.state?.canGoBack === true) {
        await tab.browser.request('back', {}, 12_000);
        return;
      }
      if (isPinduoduoUrl(tab.lastPinduoduoUrl)) {
        await tab.browser.request('navigate', { url: tab.lastPinduoduoUrl }, 20_000);
      }
    } catch (error) {
      appendLog(
        'desktop-main',
        `[alipay-payment] PDD return pending tab=${tab.tabId} code=${sanitizedErrorCode(error)}\n`,
      );
    }
  }

  async function returnMarketplaceTabFromAlipay(tab) {
    if (tab.profile?.platformKey === 'pinduoduo') return returnPinduoduoTabFromAlipay(tab);
    if (!tabs.has(tab.tabId)) return;
    const fallbackUrl = tab.lastMarketplaceUrl || PAYMENT_BOOTSTRAP_URLS[paymentPlatformFromProfileKey(tab.profile?.platformKey)];
    try {
      if (tab.state?.canGoBack === true) await tab.browser.request('back', {}, 12_000);
      else if (fallbackUrl) await tab.browser.request('navigate', { url: fallbackUrl }, 20_000);
    } catch (error) {
      appendLog('desktop-main', `[alipay-payment] marketplace return pending tab=${tab.tabId} code=${sanitizedErrorCode(error)}\n`);
    }
  }

  async function openMarketplaceAlipayPayment(tab, paymentUrl) {
    if (!alipayPaymentWindowController?.open || !tab.target) return;
    const platform = paymentPlatformFromProfileKey(tab.profile?.platformKey) || tab.autoOrder?.sourcePlatform;
    if (!platform) return;
    const paymentKey = sha256(paymentUrl);
    if (tab.alipayPaymentRedirectKey === paymentKey || tab.alipayPaymentOpening === true) return;
    tab.alipayPaymentRedirectKey = paymentKey;
    tab.alipayPaymentOpening = true;
    if (tab.autoOrder) {
      tab.autoOrder = {
        ...tab.autoOrder,
        paymentUrl,
        stage: 'payment-pending',
        updatedAt: new Date().toISOString(),
      };
    }
    try {
      const credential = await getPaymentCredential({
        accountRef: tab.binding.accountId,
        platform,
      });
      await alipayPaymentWindowController.open({
        paymentUrl,
        sourceTabId: tab.tabId,
        // Share the same independent Alipay Electron partition used by the
        // manual-login window for this exact purchase account.
        ownerRef: tab.binding.accountId,
        accountId: tab.binding.accountId,
        platform,
        targetHash: targetFingerprint(tab.target),
        showWindow: tab.autoOrder?.request?.showVerificationWindow !== false,
        paymentCredential: credential
          ? {
              loginAccount: cleanOptionalText(credential.loginAccount, 260),
              paymentPassword: cleanOptionalText(credential.paymentPassword, 128),
              autoSubmit: true,
            }
          : null,
      });
      await returnMarketplaceTabFromAlipay(tab);
    } catch (error) {
      tab.alipayPaymentRedirectKey = '';
      appendLog(
        'desktop-main',
        `[alipay-payment] open failed tab=${tab.tabId} code=${sanitizedErrorCode(error)}\n`,
      );
      emit('alipay-payment-error', {
        tabId: tab.tabId,
        code: sanitizedErrorCode(error),
      });
    } finally {
      tab.alipayPaymentOpening = false;
    }
  }

  const openPinduoduoAlipayPayment = openMarketplaceAlipayPayment;

  async function verifyPinduoduoAlipayPayment(tabId) {
    const tab = getTab(tabId);
    if (tab.profile?.platformKey !== 'pinduoduo') {
      const result = await verifyNonPinduoduoAutoOrderReadback(tab);
      return { ok: true, ...result, state: snapshot() };
    }
    if (!tab.target) {
      return { ok: true, paymentVerified: false, readbackVerified: false, reason: 'target-missing' };
    }
    if (tab.purchaseContext?.purchaseOrderNumber && tab.pinduoduoAutoCaptureCompletedKey) {
      return {
        ok: true,
        paymentVerified: true,
        readbackVerified: true,
        purchaseContext: { ...tab.purchaseContext },
        state: snapshot(),
      };
    }
    const waitUntil = Date.now() + 12_000;
    while (Date.now() < waitUntil && (tab.pinduoduoAutoCaptureInFlight || tab.state?.loading === true)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!isPinduoduoUrl(tab.state?.url) && isPinduoduoUrl(tab.lastPinduoduoUrl)) {
      await tab.browser.request('navigate', { url: tab.lastPinduoduoUrl }, 20_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await runPinduoduoAutoCapture(tab, { force: true });
    const captureDeadline = Date.now() + 8_000;
    while (Date.now() < captureDeadline && tab.pinduoduoAutoCaptureInFlight) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return {
      ok: true,
      paymentVerified: Boolean(tab.purchaseContext?.purchaseOrderNumber && tab.pinduoduoAutoCaptureCompletedKey),
      readbackVerified: Boolean(tab.purchaseContext?.purchaseOrderNumber && tab.pinduoduoAutoCaptureCompletedKey),
      purchaseContext: tab.purchaseContext ? { ...tab.purchaseContext } : null,
      state: snapshot(),
    };
  }

  async function verifyNonPinduoduoAutoOrderReadback(tab) {
    const platform = tab.autoOrder?.sourcePlatform || tab.autoOrder?.request?.sourcePlatform;
    const orderNumber = cleanOptionalText(tab.autoOrder?.purchaseOrderNumber, 260);
    if (!orderNumber || !['淘宝', '天猫', '1688'].includes(platform)) {
      return { paymentVerified: false, readbackVerified: false };
    }
    const readbackUrl = platform === '1688'
      ? 'https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?tradeStatus=all&page=1&pageSize=50'
      : `https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=${encodeURIComponent(orderNumber)}`;
    await navigate({ tabId: tab.tabId, url: readbackUrl, waitUntil: 'commit' });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const readback = await readMarketplaceOrderReadonly({
      tabId: tab.tabId,
      expectedOrderNumber: orderNumber,
    });
    const capture = readback?.capture || {};
    const confirmed = capture.paymentConfirmed === true
      || isConfirmedPurchaseOrderStatus(capture.purchaseOrderStatus);
    return {
      paymentVerified: confirmed,
      readbackVerified: confirmed,
      capture,
    };
  }

  function applyVisibility() {
    const requestedVersion = ++visibilityVersion;
    const run = visibilityChain.catch(() => undefined).then(async () => {
      if (requestedVersion !== visibilityVersion) return snapshot();
      // The market collector is born hidden and never becomes the active
      // purchase tab. Sending every viewport update to that hidden session
      // couples an interactive open to a long-running Ozon EvaluateScript
      // call. Keep the collector completely outside the presentation path.
      const presentationTabs = [...tabs.values()].filter((tab) => tab.background !== true);
      await Promise.all(presentationTabs.map(async (tab) => {
        if (!sessions.isCurrent(tab.session.sessionId, tab.session.generation)) return;
        const bounds = browserBounds(tab);
        if (
          tab.appliedBounds
          && (
            (tab.appliedBounds.visible === false && bounds.visible === false)
            || ['x', 'y', 'width', 'height', 'visible'].every((field) => tab.appliedBounds[field] === bounds[field])
          )
        ) return;
        try {
          const applied = await applyVerifiedBounds(tab, bounds, requestedVersion);
          if (applied && typeof applied === 'object') {
            tab.state = { ...tab.state, ...applied };
          }
          if (requestedVersion === visibilityVersion) tab.appliedBounds = bounds;
        } catch (error) {
          appendLog(
            'desktop-main',
            '[cef] bounds failed owner=' + tab.profile.ownerRef + ' code=' + sanitizedErrorCode(error) + '\n',
          );
          throw error;
        }
      }));
      return snapshot();
    });
    visibilityChain = run.catch(() => undefined);
    return run;
  }

  function attachHost(window) {
    if (!window || window.isDestroyed?.()) fail('PURCHASE_BROWSER_HOST_WINDOW_REQUIRED');
    if (hostWindow?.isDestroyed?.()) hostWindow = null;
    if (hostWindow && hostWindow !== window) fail('PURCHASE_BROWSER_WINDOW_OCCUPIED');
    hostWindow = window;
    const owner = browserOwnerWindow && !browserOwnerWindow.isDestroyed?.() ? browserOwnerWindow : window;
    void attachBrowserOwner(owner).catch((error) => appendLog(
      'desktop-main',
      '[purchase-browser] attach owner failed code=' + sanitizedErrorCode(error) + '\n',
    ));
    void applyVisibility().catch((error) => appendLog(
      'desktop-main',
      '[purchase-browser] initial bounds apply failed code=' + sanitizedErrorCode(error) + '\n',
    ));
    return snapshot();
  }

  function attachBrowserOwner(window) {
    if (!window || window.isDestroyed?.()) fail('PURCHASE_BROWSER_HOST_WINDOW_REQUIRED');
    if (browserOwnerWindow === window && !window.isDestroyed?.()) {
      return Promise.resolve(snapshot());
    }
    const activeBeforeQueue = commandQueue.getSnapshot().active;
    const cancellationFence = activeBeforeQueue?.name === 'ozon-data-paginate'
      ? beginOzonPaginationCancellation('parent')
      : null;
    return commandQueue.enqueue('parent', async () => {
      await cancellationFence;
      browserOwnerWindow = window;
      await Promise.all([...tabs.values()].filter((tab) => tab.background !== true).map((tab) => {
        if (!sessions.isCurrent(tab.session.sessionId, tab.session.generation)) return undefined;
        return tab.browser.request('parent', {
          parentHwnd: cefRuntime.nativeWindowHandle?.(window),
        });
      }));
      return snapshot();
    }, {
      timeoutMs: 10_000,
      latestKey: 'parent',
      priority: 'high',
      preemptActive: ({ name }) => isBackgroundCollectorCommand(name),
    });
  }

  async function removeOwnedPath(candidate, ownerRef) {
    const resolved = path.resolve(candidate);
    if (!isDescendant(ownedDataRoot, resolved) || !resolved.includes(ownerRef) || !OWNER_REF_PATTERN.test(ownerRef)) {
      fail('PURCHASE_BROWSER_REMOVE_PATH_FORBIDDEN');
    }
    await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    if (fs.existsSync(resolved)) fail('PURCHASE_BROWSER_REMOVE_READBACK_FAILED');
  }

  async function removeOwnedPathAfterRuntimeClose(candidate, ownerRef) {
    let lastError = null;
    for (let attempt = 0; attempt <= ACCOUNT_REMOVAL_PATH_RELEASE_DELAYS_MS.length; attempt += 1) {
      try {
        await removeOwnedPath(candidate, ownerRef);
        return;
      } catch (error) {
        const code = String(error?.code || error?.message || '');
        const retryable = ['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM', 'PURCHASE_BROWSER_REMOVE_READBACK_FAILED']
          .includes(code);
        if (!retryable || attempt >= ACCOUNT_REMOVAL_PATH_RELEASE_DELAYS_MS.length) throw error;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, ACCOUNT_REMOVAL_PATH_RELEASE_DELAYS_MS[attempt]));
      }
    }
    throw lastError;
  }

  function validateRemovalResourceIds(resourceIds) {
    const normalized = Array.isArray(resourceIds) ? [...resourceIds].map(String).sort() : [];
    const matchesPurchase = JSON.stringify(normalized) === JSON.stringify(PURCHASE_BROWSER_PURGE_RESOURCE_IDS);
    const matchesIntegration = JSON.stringify(normalized) === JSON.stringify(INTEGRATION_BROWSER_PURGE_RESOURCE_IDS);
    if (!matchesPurchase && !matchesIntegration) {
      fail('PURCHASE_BROWSER_ACCOUNT_REMOVAL_RESOURCE_MISMATCH');
    }
    return normalized;
  }

  function pendingRemovalPath(operationId) {
    const id = requiredText(operationId, 'ACCOUNT_REMOVAL_OPERATION_ID_REQUIRED', 160);
    return path.join(pendingRemovalRoot, `${sha256(id).slice(0, 40)}.json`);
  }

  function validatePendingRemoval(value) {
    const operationId = requiredText(value?.operationId, 'ACCOUNT_REMOVAL_OPERATION_ID_REQUIRED', 160);
    const ownerRef = requiredText(value?.ownerRef, 'PURCHASE_BROWSER_OWNER_REF_INVALID', 40);
    const storagePath = path.resolve(requiredText(value?.storagePath, 'PURCHASE_BROWSER_PENDING_REMOVAL_INVALID', 1200));
    const legacyElectronRemoval = value?.version === 1
      && isDescendant(ownedDataRoot, storagePath)
      && path.basename(storagePath) === `purchase-${ownerRef}`;
    const currentCefRemoval = value?.version === PENDING_REMOVAL_VERSION
      && path.dirname(storagePath) === ownedProfileRoot
      && path.basename(storagePath) === ownerRef;
    if (!OWNER_REF_PATTERN.test(ownerRef) || (!legacyElectronRemoval && !currentCefRemoval)) {
      fail('PURCHASE_BROWSER_PENDING_REMOVAL_INVALID');
    }
    return Object.freeze({
      version: value.version,
      operationId,
      ownerRef,
      storagePath,
      resourceIds: validateRemovalResourceIds(value?.resourceIds),
      ...(value?.receiptBinding ? { receiptBinding: validatePurchaseRemovalReceiptBinding(value.receiptBinding, { operationId }) } : {}),
    });
  }

  function writePendingRemoval(value) {
    const pending = validatePendingRemoval(value);
    fs.mkdirSync(pendingRemovalRoot, { recursive: true });
    const filePath = pendingRemovalPath(pending.operationId);
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(pending)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.rmSync(filePath, { force: true });
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
    return { ...pending, filePath };
  }

  function readPendingRemovals() {
    if (!fs.existsSync(pendingRemovalRoot)) return [];
    return fs.readdirSync(pendingRemovalRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-f0-9]{40}\.json$/u.test(entry.name))
      .map((entry) => {
        const filePath = path.join(pendingRemovalRoot, entry.name);
        let value;
        try { value = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
        catch { fail('PURCHASE_BROWSER_PENDING_REMOVAL_INVALID'); }
        const pending = validatePendingRemoval(value);
        if (filePath !== pendingRemovalPath(pending.operationId)) fail('PURCHASE_BROWSER_PENDING_REMOVAL_INVALID');
        return { ...pending, filePath };
      });
  }

  async function failActiveAttempt(tab, errorCode) {
    const activeAttempt = tab.activeAttempt;
    if (!activeAttempt) return;
    tab.activeAttempt = null;
    await localApiClient.failTask(activeAttempt.taskId, { attemptId: activeAttempt.attemptId, errorCode });
  }

  function bindBrowserEvents(tab) {
    return tab.browser.onEvent((event, details = {}) => {
      if (!sessions.isCurrent(tab.session.sessionId, tab.session.generation)) return;
      let urlChanged = false;
      if (details.state) {
        urlChanged = String(details.state.url || '') !== String(tab.state.url || '');
        tab.state = { ...tab.state, ...details.state };
        const currentUrl = tab.state.url;
        const target = policy.classifyUrl(currentUrl, { allowBlank: true });
        const paymentPlatform = paymentPlatformFromProfileKey(tab.profile?.platformKey);
        const marketplaceAlipayRedirect = Boolean(paymentPlatform) && isAlipayPaymentUrl(currentUrl);
        if (paymentPlatform && purchasePlatformFromUrl(currentUrl) === paymentPlatform) {
          tab.lastMarketplaceUrl = currentUrl;
          if (paymentPlatform === '拼多多') tab.lastPinduoduoUrl = currentUrl;
        }
        if (
          tab.background !== true
          && !tab.followSellerVerificationPresentation
          && target.allowed
          && currentUrl !== 'about:blank'
          && !marketplaceAlipayRedirect
        ) {
          try {
            profileStore.updateSession(tab.binding, { lastUrl: target.url });
          } catch (error) {
            appendLog(
              'desktop-main',
              `[purchase-browser] profile checkpoint deferred owner=${tab.storageRef.slice(0, 8)} code=${sanitizedErrorCode(error)}\n`,
            );
          }
        }
        if (marketplaceAlipayRedirect) void openMarketplaceAlipayPayment(tab, currentUrl);
      }
      if (urlChanged) {
        tab.appliedBounds = null;
        tab.ozonLoginVerification = null;
        if (tab.binding?.ownerType === 'integration_profile' && isOzonSellerLoginUrl(tab.state?.url)) {
          void persistOzonLoginVerification(tab, {
            loggedIn: false,
            cookieSaved: false,
            verificationSource: 'login-page',
            url: tab.state.url,
            verifiedAt: new Date().toISOString(),
          }).catch((error) => appendLog(
            'desktop-main',
            `[purchase-browser] Ozon login invalidation failed tab=${tab.tabId} code=${sanitizedErrorCode(error)}\n`,
          ));
        }
        void applyVisibility().catch((error) => appendLog(
          'desktop-main',
          '[cef] site window profile apply failed code=' + sanitizedErrorCode(error) + '\n',
        ));
      }
      if (event === 'window-hidden') {
        if (tab.followSellerVerificationPresentation) {
          const presentation = tab.followSellerVerificationPresentation;
          visibilityVersion += 1;
          boundsVersion += 1;
          for (const currentTab of tabs.values()) currentTab.appliedBounds = null;
          tab.followSellerVerificationPresentation = {
            ...presentation,
            visible: false,
          };
          tab.background = true;
          const previousActiveTabId = String(presentation.previousActiveTabId || '');
          activeTabId = previousActiveTabId && tabs.has(previousActiveTabId)
            ? previousActiveTabId
            : firstInteractiveTabId();
          viewport = {
            ...viewport,
            visible: presentation.previousViewportVisible === true && Boolean(activeTabId),
          };
        }
        if (tab.background !== true && tab.tabId === activeTabId) {
          // Native X/Alt+F4 is a new visibility generation. Any visible bounds
          // request that started before this event is stale and must never be
          // allowed to re-arm the standalone CEF form.
          visibilityVersion += 1;
          hiddenIntentVersion += 1;
          boundsVersion += 1;
          viewport = { ...viewport, visible: false };
          for (const currentTab of tabs.values()) {
            currentTab.appliedBounds = null;
            if (sessions.isCurrent(currentTab.session.sessionId, currentTab.session.generation)) {
              currentTab.session = sessions.updateSession(currentTab.session.sessionId, { phase: 'hidden' });
            }
          }
        }
      }
      if (event === 'crashed') {
        tab.state = { ...tab.state, loading: false, crashed: true };
        tab.session = sessions.invalidate(tab.session.sessionId, 'crashed') || tab.session;
        setTargetPhase(tab, 'error');
        void failActiveAttempt(tab, details.code || 'PURCHASE_BROWSER_RENDERER_GONE').catch(() => undefined);
      }
      if (event === 'load-error') {
		appendLog(
		  'desktop-main',
		  `[purchase-browser] navigation failed platform=${tab.profile.platformKey || 'unknown'} owner=${tab.storageRef.slice(0, 8)} code=${Number(tab.state.loadErrorCode) || 0} host=${cleanOptionalText(tab.state.loadErrorHost, 253) || 'unknown'}\n`,
		);
	  }
      if (tab.profile?.platformKey === 'pinduoduo') {
        if (!isPinduoduoUrl(tab.state?.url)) {
          clearPinduoduoAutoCapture(tab);
        } else if (['address', 'loading', 'title', 'initialized', 'state'].includes(event) && tab.state?.loading !== true) {
          schedulePinduoduoAutoCapture(tab, 250);
        }
      }
      if (event === 'follow-seller-result') {
        emit(event, {
          tabId: tab.tabId,
          captureToken: cleanOptionalText(details.captureToken, 120),
          result: details.result && typeof details.result === 'object' ? details.result : null,
        });
        return;
      }
      if (event === 'follow-seller-scheme1-progress') {
        emit(event, {
          tabId: tab.tabId,
          progressToken: cleanOptionalText(details.progressToken, 200),
          evidenceId: cleanOptionalText(details.evidenceId, 160),
          offerId: cleanOptionalText(details.offerId, 160),
          originalSku: cleanOptionalText(details.originalSku, 30),
          stage: cleanOptionalText(details.stage, 100),
          status: cleanOptionalText(details.status, 40),
          message: cleanOptionalText(details.message, 300),
          code: cleanOptionalText(details.code, 160),
          at: cleanOptionalText(details.at, 80),
        });
        return;
      }
      emit(event, { tabId: tab.tabId, code: details.code });
    });
  }

  async function open({
    accountId,
    ownerType = 'purchase_account',
    url = '',
    waitUntil = 'commit',
    signal,
    restoreVisible = true,
    browserRole = PURCHASE_BROWSER_ROLES.INTERACTIVE,
    background = false,
    workbench = null,
    purchaseTarget = null,
    bounds = null,
    traceId = '',
    queuedAt = 0,
    networkMode = 'auto',
  } = {}) {
    const openStartedAt = Date.now();
    const openHiddenIntentVersion = hiddenIntentVersion;
    let stageStartedAt = openStartedAt;
    const safeTraceId = cleanOptionalText(traceId, 100) || 'purchase_open';
    const logStage = (stage) => {
      const now = Date.now();
      appendLog(
        'desktop-main',
        `[purchase-browser] open stage=${stage} request=${safeTraceId} durationMs=${Math.max(0, now - stageStartedAt)} totalMs=${Math.max(0, now - (Number(queuedAt) || openStartedAt))}\n`,
      );
      stageStartedAt = now;
    };
    if (signal?.aborted) fail('PURCHASE_BROWSER_COMMAND_CANCELLED');
    const normalizedPurchaseTarget = purchaseTarget
      ? normalizeTargetContext(purchaseTarget)
      : null;
    if (shutdownPromise) await shutdownPromise;
    if (!hostWindow || hostWindow.isDestroyed?.()) fail('PURCHASE_BROWSER_HOST_WINDOW_REQUIRED');
    const builtinBinding = getPurchaseBrowserBuiltinBinding(accountId, ownerType);
    const binding = builtinBinding
      || (await localApiClient.getOwnerBinding(accountId, ownerType)).binding;
    assertNotAborted(signal);
    if (removingOwnerRefs.has(profileStore.ownerRefFor(binding))) fail('PURCHASE_BROWSER_ACCOUNT_REMOVAL_IN_PROGRESS');
    logStage('owner-binding');
    const role = normalizeBrowserRole(browserRole, background);
    const isMarketCollector = role === PURCHASE_BROWSER_ROLES.MARKET_COLLECTOR;
    const isFollowSellerCollector = role === PURCHASE_BROWSER_ROLES.FOLLOW_SELLER_COLLECTOR;
    const isBackground = isBackgroundBrowserRole(role);
    const assertOpenCurrent = (tab = null) => {
      assertNotAborted(signal);
      // A native X/Alt+F4 does not abort the JavaScript command queue. Keep
      // that newer hide intent separate from routine native bounds events.
      if (!isBackground && openHiddenIntentVersion !== hiddenIntentVersion) {
        fail('PURCHASE_BROWSER_COMMAND_CANCELLED');
      }
      if (tab && (
        tabs.get(tab.tabId) !== tab
        || !sessions.isCurrent(tab.session.sessionId, tab.session.generation)
      )) fail('PURCHASE_BROWSER_SESSION_STALE');
    };
    assertOpenCurrent();
    if ((isMarketCollector || isFollowSellerCollector) && ownerType !== 'integration_profile') {
      fail('PURCHASE_BROWSER_BACKGROUND_ROLE_INVALID');
    }
    if (!isBackground && bounds && typeof bounds === 'object') {
      const requestedBounds = ['x', 'y', 'width', 'height'].map((field) => Number(bounds[field]));
      if (requestedBounds.some((value) => !Number.isFinite(value))) fail('PURCHASE_BROWSER_BOUNDS_INVALID');
      const suppliedVersion = Number(bounds.boundsVersion);
      const staleBounds = Number.isFinite(suppliedVersion) && suppliedVersion > 0 && suppliedVersion < boundsVersion;
      if (Number.isFinite(suppliedVersion) && suppliedVersion > boundsVersion) {
        boundsVersion = Math.floor(suppliedVersion);
      } else if (!staleBounds) {
        boundsVersion += 1;
      }
      viewport = staleBounds
        ? { ...viewport, visible: restoreVisible !== false && bounds.visible !== false }
        : {
            x: Math.floor(requestedBounds[0]),
            y: Math.floor(requestedBounds[1]),
            width: Math.max(320, Math.min(Math.floor(requestedBounds[2]), 16_384)),
            height: Math.max(240, Math.min(Math.floor(requestedBounds[3]), 16_384)),
            visible: restoreVisible !== false && bounds.visible !== false,
            ...(bounds.compact === true ? { compact: true } : {}),
          };
      invalidateBoundsForViewportChange();
    }
    const rawRequested = url || profileStore.get(binding)?.lastUrl
      || (ownerType === 'integration_profile' ? OZON_BROWSER_DEFAULT_URL : 'about:blank');
	const requested = normalizePinduoduoTopLevelUrl(rawRequested);
    const target = policy.classifyUrl(requested, { allowBlank: true });
    if (!target.allowed) fail('PURCHASE_BROWSER_NAVIGATION_FORBIDDEN');
    const storedProfile = profileStore.getOrCreate(binding, target.url === 'about:blank' ? {} : { lastUrl: target.url });
	const effectiveWorkbench = normalizePurchaseWorkbenchForPlatform(storedProfile.platformKey, workbench);
	let followSellerProxy = null;
	if (isFollowSellerCollector) {
		followSellerProxy = followSellerRuntimeProxy(storedProfile.proxy, networkMode);
		if (
			String(networkMode || 'auto').trim().toLowerCase() === 'auto'
			&& followSellerProxy.mode === 'system'
		) {
			try {
				const detectedProxy = await resolveFollowSellerAutoProxy();
				followSellerProxy = followSellerRuntimeProxy(storedProfile.proxy, networkMode, detectedProxy);
			} catch {
				// Proxy discovery is only an automatic compatibility path. A failed
				// probe must preserve the existing system-route behavior.
			}
		}
	}
    const storageRef = storedProfile.ownerRef;
    const runtimeOwnerRef = isMarketCollector
      ? marketCollectorOwnerRef(storageRef)
      : isFollowSellerCollector
        ? followSellerCollectorOwnerRef(storageRef)
      : role === PURCHASE_BROWSER_ROLES.PRODUCT_LINK_PARSER
        ? productLinkParserOwnerRef(storageRef)
        : storageRef;
    const profile = Object.freeze({
      ...storedProfile,
      ownerRef: runtimeOwnerRef,
      storageRef,
      browserRole: role,
      background: isBackground,
      proxy: isFollowSellerCollector
		? followSellerProxy
        : storedProfile.proxy,
    });
    if (isFollowSellerCollector) {
      appendLog(
        'desktop-main',
		`[purchase-browser] follow-seller route requested=${String(networkMode || 'auto')} proxyMode=${profile.proxy?.mode || 'direct'} proxySource=${profile.proxy?.source || 'profile-or-system'}\n`,
      );
    }
    let existing = [...tabs.values()].find((tab) => tab.profile.ownerRef === profile.ownerRef);
    if (existing?.state.crashed) {
      await close(existing.tabId);
      existing = null;
    }
    if (existing) {
      try {
        assertOpenCurrent(existing);
        if (!isBackground) activeTabId = existing.tabId;
        existing.lastUsedAt = Date.now();
        existing.requestedUrl = target.url;
        const currentOwner = browserOwnerWindow && !browserOwnerWindow.isDestroyed?.()
          ? browserOwnerWindow
          : hostWindow;
        await existing.browser.request('parent', {
          parentHwnd: cefRuntime.nativeWindowHandle?.(currentOwner),
        }, 20_000, signal);
        assertOpenCurrent(existing);
        logStage('parent');
        if (target.url !== 'about:blank' && target.url !== existing.state.url) {
          const navigationState = await existing.browser.request(
            'navigate',
            { url: target.url, waitUntil },
            20_000,
            signal,
          );
          assertOpenCurrent(existing);
          existing.state = {
            ...existing.state,
            ...navigationState,
            // A reused product parser must keep the native address until CEF
            // actually commits the new document. requestedUrl already records
            // intent; overwriting url here defeated the stale-page fence.
            ...(role === PURCHASE_BROWSER_ROLES.PRODUCT_LINK_PARSER ? {} : { url: target.url }),
          };
        }
        logStage('navigate');
        if (!isBackground && (restoreVisible !== false || effectiveWorkbench)) {
          await existing.browser.request('workbench', { workbench: effectiveWorkbench }, 5_000, signal);
          assertOpenCurrent(existing);
          existing.displayMode = effectiveWorkbench?.displayMode === 'embedded' ? 'embedded' : 'window';
          existing.browserLayout = cleanOptionalText(effectiveWorkbench?.browserLayout, 80);
        }
        logStage('workbench');
        if (normalizedPurchaseTarget) {
          await setTarget({ tabId: existing.tabId, target: normalizedPurchaseTarget, signal });
          assertOpenCurrent(existing);
          logStage('target');
        }
        if (restoreVisible !== false && !isBackground) {
          viewport = { ...viewport, visible: true };
          existing.appliedBounds = null;
          if (sessions.isCurrent(existing.session.sessionId, existing.session.generation)) {
            existing.session = sessions.updateSession(existing.session.sessionId, {
              phase: 'ready',
              health: 'healthy',
            });
          }
          // Do not issue a separate native `restore` here. applyVisibility()
          // immediately sends one verified visible bounds command, and the
          // native ApplyBounds path restores the form at that final rectangle.
          // Restoring first displayed the old/off-screen rectangle and then
          // displayed the final rectangle, which caused one visible flash on
          // every reopen after the native X button hid the browser.
        }
        logStage('visibility-armed');
        await applyVisibility();
        assertOpenCurrent(existing);
        logStage('visibility');
        logStage('complete');
        if (!isBackground) evictInactiveInteractiveTabs(existing.tabId);
        return snapshot();
      } catch (error) {
        assertNotAborted(signal);
        if (!isBackground && openHiddenIntentVersion !== hiddenIntentVersion) {
          fail('PURCHASE_BROWSER_COMMAND_CANCELLED');
        }
        if (tabs.get(existing.tabId) !== existing) throw error;
        if (!isRecoverableOpenError(error)) throw error;
        await forceClose(existing.tabId).catch(() => undefined);
        return open({
          accountId,
          ownerType,
          url,
          waitUntil,
          signal,
          restoreVisible,
          browserRole: role,
          background: isBackground,
          workbench,
          purchaseTarget: normalizedPurchaseTarget,
          bounds,
          traceId: safeTraceId,
          queuedAt,
          networkMode,
        });
      }
    }
    const ownerRef = profile.ownerRef;
    const pendingOpen = pendingOpens.get(ownerRef);
    if (pendingOpen) {
      await pendingOpen;
      assertOpenCurrent();
      return open({
        accountId,
        ownerType,
        url,
        waitUntil,
        signal,
        restoreVisible,
        browserRole: role,
        background: isBackground,
        workbench,
        purchaseTarget: normalizedPurchaseTarget,
        bounds,
        traceId: safeTraceId,
        queuedAt,
        networkMode,
      });
    }
    let releasePending = () => undefined;
    const pending = new Promise((resolve) => { releasePending = resolve; });
    pendingOpens.set(ownerRef, pending);
    let openingSession = null;
    try {
      assertOpenCurrent();
      if (removingOwnerRefs.has(storageRef)) fail('PURCHASE_BROWSER_ACCOUNT_REMOVAL_IN_PROGRESS');
      const session = sessions.createSession({
        sessionKey: runtimeOwnerRef,
        accountId: binding.accountId,
        profilePath: path.join(ownedProfileRoot, storageRef),
        currentUrl: target.url,
        phase: 'opening',
        health: 'unknown',
      });
      openingSession = session;
      const ownerWindow = browserOwnerWindow && !browserOwnerWindow.isDestroyed?.()
      ? browserOwnerWindow
      : hostWindow;
    const browser = await cefRuntime.open({
      profile,
      profileRoot: ownedProfileRoot,
      downloadsDirectory: path.join(ownedDownloadsRoot, runtimeOwnerRef),
      hostWindow: ownerWindow,
      url: target.url,
      allowedHosts: policy.allowedHostSuffixes,
      allowHttpNavigation: policy.allowHttpNavigation === true,
      fixtureOrigins: [...policy.fixtureOrigins],
      navigationWaitUntil: waitUntil,
      initialBounds: { ...viewport, visible: !isBackground && viewport.visible },
      workbench: isBackground ? null : effectiveWorkbench,
      signal,
    });
    logStage('launch');
    if (signal?.aborted || (!isBackground && openHiddenIntentVersion !== hiddenIntentVersion)) {
      await cefRuntime.close(profile.ownerRef).catch(() => undefined);
      fail('PURCHASE_BROWSER_COMMAND_CANCELLED');
    }
    const tab = {
      tabId: createTabId(),
      binding,
      profile,
      browserRole: role,
      background: isBackground,
      storageRef,
      browser,
      displayMode: effectiveWorkbench?.displayMode === 'embedded' ? 'embedded' : 'window',
      browserLayout: cleanOptionalText(effectiveWorkbench?.browserLayout, 80),
      state: { ...browser.state },
      requestedUrl: target.url,
      addonState: {
        installState: 'active',
        runtimeKind: 'builtin',
        // local-api keeps the historical audit fields stable. The new CEF
        // browser exposes the built-in capability without installing an
        // extension package.
        extensionId: BUILT_IN_CEF_ADDON.extensionId,
        extensionVersion: String(browser.state.extensionVersion || BUILT_IN_CEF_ADDON.version),
        packageSha256: BUILT_IN_CEF_ADDON.sha256,
        addons: [{
          extensionId: BUILT_IN_CROSS_BORDER_ADDON.geckoId,
          extensionVersion: String(browser.state.crossBorderVersion || BUILT_IN_CROSS_BORDER_ADDON.version),
          packageSha256: BUILT_IN_CROSS_BORDER_ADDON.sha256,
          runtimeKind: 'builtin',
        }],
      },
      activeAttempt: null,
      appliedBounds: null,
      removeListener: null,
      session,
      target: session.target || null,
      capturePreview: null,
      captureResult: null,
      purchaseContext: null,
      pendingPurchaseCapture: null,
      pinduoduoOrderEvidence: null,
      pinduoduoAutoCaptureTimer: null,
      pinduoduoAutoCaptureInFlight: false,
      pinduoduoAutoCaptureCompletedKey: '',
      pinduoduoAutoCaptureBlockedKey: '',
      pinduoduoRefundCaptureCompletedKey: '',
      lastUsedAt: Date.now(),
      lastPinduoduoUrl: isPinduoduoUrl(target.url) ? target.url : '',
      alipayPaymentRedirectKey: '',
      alipayPaymentOpening: false,
      ozonLoginVerification: null,
      followSellerVerificationPresentation: null,
      targetPhase: session.target ? 'target-locked' : 'idle',
    };
    tab.session = sessions.updateSession(session.sessionId, {
      phase: !isBackground && viewport.visible ? 'ready' : 'hidden',
      health: 'healthy',
      currentUrl: browser.state.url || target.url,
    });
    tab.removeListener = bindBrowserEvents(tab);
    const previousActiveTabId = activeTabId;
    tabs.set(tab.tabId, tab);
    if (!isBackground) activeTabId = tab.tabId;
    try {
      assertOpenCurrent(tab);
      if (normalizedPurchaseTarget) {
        await setTarget({ tabId: tab.tabId, target: normalizedPurchaseTarget, signal });
        assertOpenCurrent(tab);
        logStage('target');
      }
      if (![
        'integration_profile',
        BUILTIN_PUBLIC_PROFILE_OWNER_TYPE,
        BUILTIN_CROSS_BORDER_PROFILE_OWNER_TYPE,
      ].includes(binding.ownerType)) {
        await localApiClient.recordPluginState({ ownerId: binding.accountId, ...tab.addonState });
        assertOpenCurrent(tab);
      }
      await applyVisibility();
      assertOpenCurrent(tab);
      logStage('visibility');
    } catch (error) {
      // Do not leave a CEF session and a half-registered tab behind when
      // the audit/readback endpoint rejects the plugin state.  A stale tab is
      // exactly what made the next click look like a first-open failure.
      tab.removeListener?.();
      tabs.delete(tab.tabId);
      sessions.invalidate(tab.session.sessionId, 'crashed');
      sessions.removeSession(tab.session.sessionId);
      if (activeTabId === tab.tabId) {
        activeTabId = previousActiveTabId && tabs.has(previousActiveTabId)
          ? previousActiveTabId
          : firstInteractiveTabId();
      }
      await cefRuntime.close(ownerRef).catch(() => undefined);
      await applyVisibility().catch(() => undefined);
      throw error;
    }
    emit('opened', { tabId: tab.tabId, browserRole: role, background: isBackground });
    if (!isBackground) evictInactiveInteractiveTabs(tab.tabId);
    logStage('complete');
    return snapshot();
    } catch (error) {
      if (openingSession?.sessionId) {
        sessions.invalidate(openingSession.sessionId, 'crashed');
        sessions.removeSession(openingSession.sessionId);
      }
      throw error;
    } finally {
      pendingOpens.delete(ownerRef);
      releasePending();
    }
  }


  async function prewarm({
    accountId,
    ownerType = 'purchase_account',
    url,
    signal,
    browserRole = PURCHASE_BROWSER_ROLES.INTERACTIVE,
    background = false,
  } = {}) {
    const targetUrl = typeof url === 'string' ? url.trim() : '';
    const result = await open({
      accountId,
      ownerType,
      url: targetUrl,
      waitUntil: 'commit',
      signal,
      restoreVisible: false,
      browserRole,
      background,
    });
    const tab = [...tabs.values()].find((candidate) => (
      candidate.binding.accountId === String(accountId || '')
      && Boolean(paymentPlatformFromProfileKey(candidate.profile?.platformKey))
      && candidate.browserRole === PURCHASE_BROWSER_ROLES.INTERACTIVE
    ));
    if (tab) {
      await prewarmMarketplacePaymentWindow(tab).catch((error) => appendLog(
        'desktop-main',
        `[alipay-payment] prewarm deferred account=${sha256(tab.binding.accountId).slice(0, 12)} code=${sanitizedErrorCode(error)}\n`,
      ));
    }
    return result;
  }

  function getTab(tabId = activeTabId) {
    const tab = tabs.get(String(tabId || ''));
    if (!tab) fail('PURCHASE_BROWSER_TAB_NOT_FOUND');
    if (removingOwnerRefs.has(tab.storageRef)) fail('PURCHASE_BROWSER_ACCOUNT_REMOVAL_IN_PROGRESS');
    return tab;
  }

  async function activate(tabId) {
    const tab = getTab(tabId);
    if (tab.background === true) fail('PURCHASE_BROWSER_BACKGROUND_TAB_NOT_ACTIVATABLE');
    if (tab.state?.crashed || tab.session?.phase === 'crashed' || tab.session?.health === 'unhealthy') {
      fail('PURCHASE_BROWSER_SESSION_CRASHED');
    }
    activeTabId = String(tabId);
    viewport = { ...viewport, visible: true };
    tab.appliedBounds = null;
    if (sessions.isCurrent(tab.session.sessionId, tab.session.generation)) {
      tab.session = sessions.updateSession(tab.session.sessionId, { phase: 'ready', health: 'healthy' });
    }
    // applyVisibility owns the one native show operation through verified
    // bounds. A second `restore` after it is both redundant and visibly
    // reactivates the top-level form, so activation follows the same atomic
    // path as reopen.
    await applyVisibility();
    emit('activated', { tabId: activeTabId });
    return snapshot();
  }

  async function showFollowSellerVerification({ tabId, url, signal } = {}) {
    const tab = getTab(tabId);
    if (tab.browserRole !== PURCHASE_BROWSER_ROLES.FOLLOW_SELLER_COLLECTOR) {
      fail('PURCHASE_BROWSER_FOLLOW_SELLER_TAB_REQUIRED');
    }
    const target = policy.classifyUrl(url, { allowBlank: false });
    let hostname = '';
    try { hostname = new URL(target.url).hostname.toLowerCase(); } catch { /* rejected below */ }
    if (!target.allowed || !(hostname === 'ozon.ru' || hostname.endsWith('.ozon.ru'))) {
      fail('PURCHASE_BROWSER_FOLLOW_SELLER_VERIFICATION_URL_INVALID');
    }
    if (!tab.followSellerVerificationPresentation) {
      tab.followSellerVerificationPresentation = {
        previousActiveTabId: activeTabId,
        previousViewportVisible: viewport.visible === true,
        visible: false,
        targetUrl: '',
      };
    }
    try {
      // The native profile is intentionally immutable/background. Grant a
      // narrowly scoped observation lease before bounds are applied, otherwise
      // native ApplyBounds correctly refuses to show this collector.
      let nativePresentation = await tab.browser.request(
        'show-follow-seller-verification-browser',
        {},
        5_000,
        signal,
      );
      if (nativePresentation?.visible !== true
        || nativePresentation?.windowVisible !== true
        || nativePresentation?.browserPanelVisible !== true
        || nativePresentation?.browserPresentationVisible !== true
        || nativePresentation?.browserControlVisible !== true) {
        fail('FOLLOW_SELLER_VERIFICATION_WINDOW_NOT_VISIBLE');
      }
      tab.background = false;
      activeTabId = tab.tabId;
      viewport = { ...viewport, visible: true };
      tab.appliedBounds = null;
      if (sessions.isCurrent(tab.session.sessionId, tab.session.generation)) {
        tab.session = sessions.updateSession(tab.session.sessionId, { phase: 'ready', health: 'healthy' });
      }
      await applyVisibility();
      const shouldNavigate = tab.followSellerVerificationPresentation?.targetUrl !== target.url;
      tab.requestedUrl = target.url;
      if (shouldNavigate) {
        try {
          tab.state = {
            ...tab.state,
            ...(await tab.browser.request('navigate', { url: target.url, waitUntil: 'commit' }, 20_000, signal)),
          };
        } catch (error) {
          if (tab.state?.crashed || sanitizedErrorCode(error) === 'PURCHASE_BROWSER_RENDERER_GONE') throw error;
          appendLog(
            'desktop-main',
            `[purchase-browser] follow-seller verification navigation kept visible tab=${tab.tabId} code=${sanitizedErrorCode(error)}\n`,
          );
        }
      }
      nativePresentation = await tab.browser.request(
        'show-follow-seller-verification-browser',
        {},
        5_000,
        signal,
      );
      if (nativePresentation?.visible !== true
        || nativePresentation?.windowVisible !== true
        || nativePresentation?.browserPanelVisible !== true
        || nativePresentation?.browserPresentationVisible !== true
        || nativePresentation?.browserControlVisible !== true) {
        fail('FOLLOW_SELLER_VERIFICATION_WINDOW_NOT_VISIBLE');
      }
      tab.state = {
        ...tab.state,
        embedding: nativePresentation.embedding || tab.state.embedding,
      };
      tab.followSellerVerificationStatus = await tab.browser.request(
        'follow-seller-verification-status',
        {},
        5_000,
        signal,
      );
      tab.followSellerVerificationPresentation = {
        ...tab.followSellerVerificationPresentation,
        visible: true,
        targetUrl: target.url,
        baselineNavigationSequence: Number(tab.state.navigationCompletedSequence) || 0,
      };
      appendLog(
        'desktop-main',
        `[purchase-browser] follow-seller verification visible tab=${tab.tabId} window=true panel=true control=true\n`,
      );
      emit('follow-seller-verification-shown', { tabId: tab.tabId });
      return snapshot();
    } catch (error) {
      await tab.browser.request('hide-follow-seller-verification-browser', {}, 5_000).catch(() => undefined);
      const presentation = tab.followSellerVerificationPresentation || {};
      tab.background = true;
      tab.followSellerVerificationPresentation = null;
      tab.followSellerVerificationStatus = null;
      const previousActiveTabId = String(presentation.previousActiveTabId || '');
      activeTabId = previousActiveTabId && tabs.has(previousActiveTabId)
        ? previousActiveTabId
        : firstInteractiveTabId();
      viewport = {
        ...viewport,
        visible: presentation.previousViewportVisible === true && Boolean(activeTabId),
      };
      await applyVisibility().catch(() => undefined);
      throw error;
    }
  }

  async function hideFollowSellerVerification({ tabId } = {}) {
    const tab = getTab(tabId);
    if (tab.browserRole !== PURCHASE_BROWSER_ROLES.FOLLOW_SELLER_COLLECTOR) {
      fail('PURCHASE_BROWSER_FOLLOW_SELLER_TAB_REQUIRED');
    }
    const presentation = tab.followSellerVerificationPresentation || {};
    await tab.browser.request('hide-follow-seller-verification-browser', {}, 5_000).catch(() => undefined);
    if (tab.background !== true) {
      const requestedVersion = ++visibilityVersion;
      const hiddenBounds = { ...viewport, visible: false };
      const applied = await applyVerifiedBounds(tab, hiddenBounds, requestedVersion);
      if (applied && typeof applied === 'object') tab.state = { ...tab.state, ...applied };
      tab.appliedBounds = hiddenBounds;
    }
    tab.background = true;
    tab.followSellerVerificationPresentation = {
      ...presentation,
      visible: false,
    };
    const previousActiveTabId = String(presentation.previousActiveTabId || '');
    activeTabId = previousActiveTabId && tabs.has(previousActiveTabId)
      ? previousActiveTabId
      : firstInteractiveTabId();
    viewport = {
      ...viewport,
      visible: presentation.previousViewportVisible === true && Boolean(activeTabId),
    };
    if (sessions.isCurrent(tab.session.sessionId, tab.session.generation)) {
      tab.session = sessions.updateSession(tab.session.sessionId, { phase: 'hidden', health: 'healthy' });
    }
    await applyVisibility();
    // ApplyVisibility may issue a generic hidden-bounds update for the
    // restored previous tab. Reassert the follow-seller-only native hide after
    // that update so WinForms cannot leave a disabled app-window taskbar shell.
    await tab.browser.request('hide-follow-seller-verification-browser', {}, 5_000).catch(() => undefined);
    emit('follow-seller-verification-hidden', { tabId: tab.tabId });
    return snapshot();
  }

  async function readFollowSellerVerification({ tabId, signal } = {}) {
    const tab = getTab(tabId);
    if (tab.browserRole !== PURCHASE_BROWSER_ROLES.FOLLOW_SELLER_COLLECTOR) {
      fail('PURCHASE_BROWSER_FOLLOW_SELLER_TAB_REQUIRED');
    }
    if (!tab.followSellerVerificationPresentation) {
      fail('FOLLOW_SELLER_VERIFICATION_WINDOW_NOT_VISIBLE');
    }
    tab.followSellerVerificationStatus = await tab.browser.request(
      'follow-seller-verification-status',
      {},
      5_000,
      signal,
    );
    return snapshot();
  }

	async function showFollowSellerQuickBrowser({ tabId, signal } = {}) {
		const tab = getTab(tabId);
		if (tab.browserRole !== PURCHASE_BROWSER_ROLES.FOLLOW_SELLER_COLLECTOR) {
			fail('PURCHASE_BROWSER_FOLLOW_SELLER_TAB_REQUIRED');
		}
		const presentation = await tab.browser.request(
			'show-follow-seller-quick-browser',
			{},
			5_000,
			signal,
		);
		return { ...snapshot(), followSellerQuickBrowser: presentation };
	}

  async function close(tabId, signal, { skipVisibility = false } = {}) {
    const tab = tabs.get(String(tabId || ''));
    if (!tab) return snapshot();
    if (tab.browserRole === PURCHASE_BROWSER_ROLES.FOLLOW_SELLER_COLLECTOR
      && tab.followSellerVerificationPresentation) {
      await hideFollowSellerVerification({ tabId: tab.tabId }).catch(() => undefined);
    }
    clearPinduoduoAutoCapture(tab, { reset: true });
    tab.session = sessions.invalidate(tab.session.sessionId, 'closing') || tab.session;
    // Account-attempt bookkeeping must not hold the visible close path open.
    // It is fenced to this tab and safely collected in the background.
    void failActiveAttempt(tab, 'PURCHASE_BROWSER_TAB_CLOSED').catch(() => undefined);
    tab.removeListener?.();
    tabs.delete(tab.tabId);
    if (activeTabId === tab.tabId) activeTabId = firstInteractiveTabId();
    const closeOperation = Promise.resolve().then(() => cefRuntime.close(tab.profile.ownerRef));
    let closeError = null;
    let removeAbortListener = () => undefined;
    try {
      if (!signal) {
        await closeOperation;
      } else {
        await Promise.race([
          closeOperation,
          new Promise((_, reject) => {
            if (signal.aborted) {
              const error = new Error('PURCHASE_BROWSER_COMMAND_CANCELLED');
              error.code = 'PURCHASE_BROWSER_COMMAND_CANCELLED';
              reject(error);
              return;
            }
            const onAbort = () => {
              const error = new Error('PURCHASE_BROWSER_COMMAND_CANCELLED');
              error.code = 'PURCHASE_BROWSER_COMMAND_CANCELLED';
              reject(error);
            };
            signal.addEventListener('abort', onAbort, { once: true });
            removeAbortListener = () => signal.removeEventListener('abort', onAbort);
          }),
        ]);
      }
    } catch (error) {
      closeError = error;
      try { cefRuntime.forceTerminate?.(tab.profile.ownerRef); } catch (forceError) {
        appendLog('desktop-main', '[cef] close fallback failed code=' + sanitizedErrorCode(forceError) + '\n');
      }
      if (signal?.aborted) {
        await closeOperation.catch(() => undefined);
      }
    } finally {
      removeAbortListener();
      sessions.removeSession(tab.session.sessionId);
    }
    if (!skipVisibility) {
      try { await applyVisibility(); } catch (error) { closeError ||= error; }
    }
    // Selecting the surviving tab is presentation cleanup, not evidence that
    // the native close succeeded. Preserve its error for the caller and UI.
    emit(closeError ? 'close-failed' : 'closed', {
      tabId: tab.tabId,
      ...(closeError ? { code: sanitizedErrorCode(closeError) } : {}),
    });
    if (closeError) throw closeError;
    return snapshot();
  }

  async function setBounds(input = {}) {
    const visible = input.visible === true;
    if (!visible) {
      hiddenIntentVersion += 1;
      const suppliedVersion = Number(input.boundsVersion);
      if (Number.isFinite(suppliedVersion) && suppliedVersion > boundsVersion) {
        boundsVersion = Math.floor(suppliedVersion);
      } else {
        boundsVersion += 1;
      }
      // A native CEF window still needs its full rectangle while hidden
      // (prewarm and restore must not fall back to 1x1).  Older callers only
      // send {visible:false}, so geometry remains optional on this path.
      const hasGeometry = ['x', 'y', 'width', 'height'].every((field) => input[field] !== undefined);
      if (hasGeometry) {
        const requested = ['x', 'y', 'width', 'height'].map((field) => Number(input[field]));
        if (requested.some((value) => !Number.isFinite(value))) fail('PURCHASE_BROWSER_BOUNDS_INVALID');
        viewport = {
          x: Math.floor(requested[0]),
          y: Math.floor(requested[1]),
          width: Math.max(320, Math.min(Math.floor(requested[2]), 16_384)),
          height: Math.max(240, Math.min(Math.floor(requested[3]), 16_384)),
          visible: false,
          compact: input.compact === true || viewport.compact === true,
        };
      } else {
        viewport = { ...viewport, visible: false };
      }
      // Do not rely on the last controller-side bounds cache here.  The
      // native CEF window can become visible again after a restore or a
      // DPI change. Clearing the cache forces one fresh hide command.
      for (const tab of tabs.values()) tab.appliedBounds = null;
      await applyVisibility();
      for (const tab of tabs.values()) {
        if (sessions.isCurrent(tab.session.sessionId, tab.session.generation)) {
          tab.session = sessions.updateSession(tab.session.sessionId, { phase: 'hidden' });
        }
      }
      return snapshot();
    }
    const suppliedVersion = Number(input.boundsVersion);
    if (Number.isFinite(suppliedVersion) && suppliedVersion > 0) {
      if (suppliedVersion < boundsVersion) return snapshot();
      boundsVersion = Math.floor(suppliedVersion);
    } else {
      boundsVersion += 1;
    }
    const requested = ['x', 'y', 'width', 'height'].map((field) => Number(input[field]));
    if (requested.some((value) => !Number.isFinite(value))) fail('PURCHASE_BROWSER_BOUNDS_INVALID');
    const x = Math.floor(requested[0]);
    const y = Math.floor(requested[1]);
    const width = Math.max(320, Math.min(Math.floor(requested[2]), 16_384));
    const height = Math.max(240, Math.min(Math.floor(requested[3]), 16_384));
    const nextViewport = {
      x, y, width, height, visible: true,
      ...(input.compact === true || viewport.compact === true ? { compact: true } : {}),
    };
    if (['x', 'y', 'width', 'height', 'visible', 'compact'].every((field) => viewport[field] === nextViewport[field])) {
      return snapshot();
    }
    viewport = nextViewport;
    await applyVisibility();
    for (const tab of tabs.values()) {
      if (sessions.isCurrent(tab.session.sessionId, tab.session.generation)) {
        tab.session = sessions.updateSession(tab.session.sessionId, {
          phase: tab.background !== true && tab.tabId === activeTabId ? 'ready' : 'hidden',
        });
      }
    }
    return snapshot();
  }

  async function navigate({ tabId, url, waitUntil = 'commit', signal } = {}) {
    const tab = getTab(tabId);
    const requestedUrl = tab.profile?.platformKey === 'pinduoduo'
      ? normalizePinduoduoTopLevelUrl(url)
      : url;
    const target = policy.classifyUrl(requestedUrl, { allowBlank: true });
    if (!target.allowed) fail('PURCHASE_BROWSER_NAVIGATION_FORBIDDEN');
    tab.state = { ...tab.state, ...(await tab.browser.request('navigate', { url: target.url, waitUntil }, 20_000, signal)) };
    if (tab.background === true && String(target.url).includes('seller.ozon.ru')) {
      appendLog(
        'desktop-main',
        `[purchase-browser] ozon navigation requested tab=${tab.tabId} sequence=${Number(tab.state.navigationSequence) || 0} completed=${Number(tab.state.navigationCompletedSequence) || 0} loading=${tab.state.loading === true}\n`,
      );
    }
    return snapshot();
  }

  async function browserCommand(tabId, command, signal, timeoutMs = 20_000) {
    const tab = getTab(tabId);
    tab.state = { ...tab.state, ...(await tab.browser.request(command, { waitUntil: 'commit' }, timeoutMs, signal)) };
    return snapshot();
  }

  async function executePurchaseAutoOrder(input = {}) {
    const normalizedRequest = normalizeAutoOrderRequest(input);
    if (normalizedRequest.sourcePlatform === '1688' && normalizedRequest.paymentMode1688 === 'protocol') {
      fail('PURCHASE_AUTO_ORDER_1688_PROTOCOL_PAYMENT_UNAVAILABLE');
    }
    let sourceAccountId = normalizedRequest.sourceAccountId;
    if (sourceAccountId.startsWith('auto:')) {
      const platformId = {
        '拼多多': 'pinduoduo',
        '淘宝': 'taobao',
        '天猫': 'tmall',
        '1688': '1688',
      }[normalizedRequest.sourcePlatform];
      const accountPayload = typeof localApiClient.listAccounts === 'function'
        ? await localApiClient.listAccounts().catch(() => null)
        : null;
      const accounts = Array.isArray(accountPayload?.accounts) ? accountPayload.accounts : [];
      const candidate = accounts.find((account) => (
        account?.status === true
        && accountSupportsPurchaseRehearsal(account, platformId)
      )) || accounts.find((account) => accountSupportsPurchaseRehearsal(account, platformId));
      sourceAccountId = cleanOptionalText(candidate?.id || candidate?.accountId, 260);
    }
    if (!sourceAccountId) fail('PURCHASE_AUTO_ORDER_ACCOUNT_REQUIRED');
    const request = Object.freeze({ ...normalizedRequest, sourceAccountId });
    const platformKey = {
      '拼多多': 'pinduoduo',
      '淘宝': 'taobao',
      '天猫': 'tmall',
      '1688': '1688',
    }[request.sourcePlatform] || request.sourcePlatform;
    const firstProduct = request.products[0];
    const firstProductStartUrl = existingPaymentStartUrl(request.sourcePlatform, request.existingOrderNumber)
      || firstProduct.sourceUrl;
    const target = normalizeTargetContext({
      targetId: `auto-order:${request.idempotencyKey}`,
      shopId: request.shopId,
      orderKey: request.posting,
      sku: firstProduct.sourceSkuId,
      offerId: firstProduct.sourceProductId,
      productTitle: firstProduct.sourceSkuName,
      quantity: firstProduct.quantity,
      purchaseRecordId: request.idempotencyKey,
      requiredFields: ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny', 'sourceUrl'],
    });
    let tab = [...tabs.values()].find((candidate) => (
      candidate.binding.accountId === request.sourceAccountId
      && candidate.profile?.platformKey === platformKey
      && candidate.background !== true
    )) || null;
    if (!tab) {
      await open({
        accountId: request.sourceAccountId,
        ownerType: 'purchase_account',
        url: firstProductStartUrl,
        waitUntil: 'commit',
        restoreVisible: true,
        purchaseTarget: target,
        traceId: `purchase_auto_order_${request.idempotencyKey.slice(0, 16)}`,
      });
      tab = [...tabs.values()].find((candidate) => (
        candidate.binding.accountId === request.sourceAccountId
        && candidate.profile?.platformKey === platformKey
        && candidate.background !== true
      )) || null;
    } else {
      await navigate({ tabId: tab.tabId, url: firstProductStartUrl, waitUntil: 'commit' });
      await setTarget({ tabId: tab.tabId, target });
    }
    if (!tab) fail('PURCHASE_AUTO_ORDER_BROWSER_SESSION_MISSING');
    if (
      request.autoPay === true
      && typeof alipayPaymentWindowController?.getSharedLoginStatus === 'function'
      && typeof alipayPaymentWindowController?.syncSharedLoginToOwners === 'function'
    ) {
      const sharedStatus = await alipayPaymentWindowController.getSharedLoginStatus().catch(() => null);
      if (sharedStatus?.loggedIn === true) {
        await alipayPaymentWindowController.syncSharedLoginToOwners([request.sourceAccountId]);
      }
    }
    if (request.autoPay === true && typeof alipayPaymentWindowController?.exportLoginCookies === 'function') {
      const paymentSession = await alipayPaymentWindowController.exportLoginCookies({
        sourceTabId: `payment-login-${request.sourceAccountId}`,
        ownerRef: request.sourceAccountId,
        platform: request.sourcePlatform,
      }).catch(() => null);
      if (paymentSession?.cookies?.length) {
        await tab.browser.request(
          'import-purchase-session-cookies',
          { cookies: paymentSession.cookies },
          12_000,
          input.signal,
        );
      }
    }
    if (tab.autoOrder?.idempotencyKey === request.idempotencyKey && tab.autoOrder.stage === 'completed') {
      return { ok: true, reused: true, ...tab.autoOrder, state: snapshot() };
    }
    tab.autoOrder = {
      idempotencyKey: request.idempotencyKey,
      sourcePlatform: request.sourcePlatform,
      request,
      stage: 'checkout-started',
      paused: false,
      updatedAt: new Date().toISOString(),
    };
    emit('purchase-auto-order-stage', {
      tabId: tab.tabId,
      stage: tab.autoOrder.stage,
      idempotencyKey: request.idempotencyKey,
    });
    const paymentCredential = request.autoPay
      ? await getPaymentCredential({ accountRef: sourceAccountId, platform: request.sourcePlatform })
      : null;
    const nativeResult = await tab.browser.request('purchase-auto-order', {
      ...request,
      target,
      paymentCredential: paymentCredential && typeof paymentCredential === 'object'
        ? {
            loginAccount: cleanOptionalText(paymentCredential.loginAccount, 260),
            paymentPassword: cleanOptionalText(paymentCredential.paymentPassword, 128),
          }
        : null,
      delegatePaymentToElectron: request.autoPay === true,
      products: request.products.map((product) => ({ ...product })),
    }, PURCHASE_AUTO_ORDER_TIMEOUT_MS, input.signal);
    const result = nativeResult && typeof nativeResult === 'object' ? nativeResult : {};
    if (result.paused === true || result.challengeRequired === true) {
      tab.autoOrder = {
        ...tab.autoOrder,
        stage: 'paused',
        paused: true,
        pauseReason: cleanOptionalText(result.pauseReason || '需要人工处理验证', 180),
        updatedAt: new Date().toISOString(),
      };
      emit('purchase-auto-order-paused', {
        tabId: tab.tabId,
        idempotencyKey: request.idempotencyKey,
        reason: tab.autoOrder.pauseReason,
      });
      return { ok: true, paused: true, tabId: tab.tabId, ...tab.autoOrder, state: snapshot() };
    }
    tab.autoOrder = {
      ...tab.autoOrder,
      ...result,
      stage: cleanOptionalText(result.stage || 'payment-pending', 80),
      paymentUrl: cleanOptionalText(result.paymentUrl, 1800),
      purchaseOrderNumber: cleanOptionalText(result.purchaseOrderNumber, 260),
      updatedAt: new Date().toISOString(),
    };
    if (request.autoPay && isAlipayPaymentUrl(tab.autoOrder.paymentUrl)) {
      await openMarketplaceAlipayPayment(tab, tab.autoOrder.paymentUrl);
      tab.autoOrder = { ...tab.autoOrder, stage: 'payment-pending', updatedAt: new Date().toISOString() };
      const paymentDeadline = Date.now() + PURCHASE_AUTO_ORDER_TIMEOUT_MS;
      while (Date.now() < paymentDeadline) {
        if (tab.autoOrder.stage === 'completed' && tab.autoOrder.paymentConfirmed === true) break;
        if (tab.autoOrder.paused === true) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (tab.autoOrder.stage !== 'completed' || tab.autoOrder.paymentConfirmed !== true) {
        if (!tab.autoOrder.paused) {
          tab.autoOrder = {
            ...tab.autoOrder,
            stage: 'payment-pending',
            paused: true,
            pauseReason: '等待支付宝付款结果或订单回读',
            updatedAt: new Date().toISOString(),
          };
        }
        emit('purchase-auto-order-paused', {
          tabId: tab.tabId,
          idempotencyKey: request.idempotencyKey,
          reason: tab.autoOrder.pauseReason,
        });
        return { ok: true, paused: true, tabId: tab.tabId, ...tab.autoOrder, state: snapshot() };
      }
    }
    if (
      tab.autoOrder.stage === 'completed'
      && tab.autoOrder.paymentConfirmed === true
      && request.sourcePlatform !== '拼多多'
    ) {
      let readback = null;
      try { readback = await verifyNonPinduoduoAutoOrderReadback(tab); }
      catch (error) {
        appendLog(
          'desktop-main',
          `[purchase-auto-order] payment readback pending tab=${tab.tabId} code=${sanitizedErrorCode(error)}\n`,
        );
      }
      if (readback?.readbackVerified !== true) {
        tab.autoOrder = {
          ...tab.autoOrder,
          stage: 'paused',
          paused: true,
          paymentConfirmed: false,
          pauseReason: 'PURCHASE_AUTO_ORDER_PAYMENT_READBACK_PENDING',
          updatedAt: new Date().toISOString(),
        };
        emit('purchase-auto-order-paused', {
          tabId: tab.tabId,
          idempotencyKey: request.idempotencyKey,
          reason: tab.autoOrder.pauseReason,
        });
        return { ok: true, paused: true, tabId: tab.tabId, ...tab.autoOrder, state: snapshot() };
      }
      tab.autoOrder = {
        ...tab.autoOrder,
        purchaseAmount: Number(readback.capture?.purchasePrice) || tab.autoOrder.purchaseAmount,
        purchaseOrderStatus: cleanOptionalText(readback.capture?.purchaseOrderStatus, 160),
        purchaseOrderUrl: cleanOptionalText(readback.capture?.purchaseOrderUrl, 1800),
        readbackVerified: true,
        updatedAt: new Date().toISOString(),
      };
    }
    emit('purchase-auto-order-stage', {
      tabId: tab.tabId,
      stage: tab.autoOrder.stage,
      idempotencyKey: request.idempotencyKey,
      purchaseOrderNumber: tab.autoOrder.purchaseOrderNumber || '',
    });
    return { ok: true, ...tab.autoOrder, state: snapshot() };
  }

  async function scanPurchaseWaitPayOrders(input = {}) {
    const accountId = requiredText(input.accountId, 'PURCHASE_PAYMENT_ACCOUNT_REF_REQUIRED', 160);
    const rawPlatform = cleanOptionalText(input.platform, 40);
    const platform = ({ PDD: '拼多多', Pinduoduo: '拼多多', pinduoduo: '拼多多', Taobao: '淘宝', taobao: '淘宝', Tmall: '天猫', tmall: '天猫' }[rawPlatform] || rawPlatform);
    const url = PAYMENT_BOOTSTRAP_URLS[platform];
    if (!url) fail('PURCHASE_AUTO_ORDER_PLATFORM_UNSUPPORTED');
    const openedState = await open({
      accountId,
      ownerType: 'purchase_account',
      url,
      waitUntil: 'commit',
      restoreVisible: false,
      traceId: `wait_pay_scan_${sha256(`${accountId}:${platform}`).slice(0, 16)}`,
    });
    const profileKeys = platform === '拼多多' ? new Set(['pinduoduo']) : platform === '1688' ? new Set(['1688']) : new Set(['taobao', 'tmall']);
    const openedTabId = openedState?.tabs?.find((candidate) => (
      candidate.tabId === openedState.activeTabId
      && candidate.accountId === accountId
    ))?.tabId;
    const tab = (openedTabId ? tabs.get(openedTabId) : null)
      || [...tabs.values()].find((candidate) => candidate.binding.accountId === accountId && profileKeys.has(candidate.profile?.platformKey));
    if (tab && !profileKeys.has(tab.profile?.platformKey)) fail('PURCHASE_PAYMENT_PLATFORM_ACCOUNT_MISMATCH');
    if (!tab) fail('PURCHASE_PAYMENT_MARKETPLACE_SESSION_MISSING');
    const result = await tab.browser.request('purchase-wait-pay-scan', {}, 30_000, input.signal);
    const rows = (Array.isArray(result?.rows) ? result.rows : []).map((row) => ({
      platform: cleanOptionalText(row?.platform || platform, 40),
      orderNumber: cleanOptionalText(row?.orderNumber, 260),
      amount: Number.isFinite(Number(row?.amount)) ? Number(row.amount) : null,
      status: cleanOptionalText(row?.status, 120),
      title: cleanOptionalText(row?.title, 800),
      sku: cleanOptionalText(row?.sku, 800),
      pageUrl: cleanOptionalText(row?.pageUrl || result?.pageUrl, 1800),
    })).filter((row) => row.orderNumber);
    return { ok: true, accountId, platform, rows, tabId: tab.tabId, state: snapshot() };
  }

  async function saveAutoPayCredential(input = {}) {
    const accountRef = requiredText(input.accountRef, 'PURCHASE_PAYMENT_ACCOUNT_REF_REQUIRED', 160);
    const paymentPassword = requiredText(input.paymentPassword, 'PURCHASE_PAYMENT_PASSWORD_REQUIRED', 128);
    return savePaymentCredential({
      accountRef,
      platform: cleanOptionalText(input.platform, 40),
      loginAccount: cleanOptionalText(input.loginAccount, 260),
      paymentPassword,
    });
  }

  async function clearAutoPayCredential(input = {}) {
    return clearPaymentCredential({ accountRef: requiredText(input.accountRef, 'PURCHASE_PAYMENT_ACCOUNT_REF_REQUIRED', 260) });
  }

  async function sharedAlipayOwnerRefs() {
    const payload = typeof localApiClient.listAccounts === 'function'
      ? await localApiClient.listAccounts().catch(() => ({ accounts: [] }))
      : { accounts: [] };
    return (Array.isArray(payload?.accounts) ? payload.accounts : []).flatMap((account) => {
      const platform = cleanOptionalText(account?.platformName || account?.platform, 40);
      return ['拼多多', 'Pinduoduo', 'PDD', '淘宝', 'Taobao', '天猫', 'Tmall', '1688'].includes(platform)
        ? [cleanOptionalText(account?.id || account?.accountId, 160)]
        : [];
    }).filter(Boolean);
  }

  async function saveSharedAlipayLogin(input = {}) {
    let current = null;
    try { current = await getAlipayLoginCredential(); } catch { /* first configuration */ }
    const loginAccount = cleanOptionalText(input.loginAccount || current?.loginAccount, 260);
    const loginPassword = cleanOptionalText(input.loginPassword || current?.loginPassword, 128);
    return saveAlipayLoginCredential({ loginAccount, loginPassword });
  }

  async function openSharedAlipayLogin(input = {}) {
    if (typeof alipayPaymentWindowController?.openSharedLogin !== 'function') fail('ALIPAY_PAYMENT_LOGIN_UNAVAILABLE');
    const accountPayload = typeof localApiClient.listAccounts === 'function'
      ? await localApiClient.listAccounts()
      : { accounts: [] };
    const pddAccounts = (Array.isArray(accountPayload?.accounts) ? accountPayload.accounts : []).filter((account) => (
      ['拼多多', 'Pinduoduo', 'PDD'].includes(cleanOptionalText(account?.platformName || account?.platform, 40))
    ));
    const requestedAccountId = cleanOptionalText(input.purchaseAccountId, 160);
    const purchaseAccount = (requestedAccountId
      ? pddAccounts.find((account) => cleanOptionalText(account?.id || account?.accountId, 160) === requestedAccountId)
      : pddAccounts.find((account) => account?.isDefault === true) || pddAccounts[0]) || null;
    const purchaseAccountId = cleanOptionalText(purchaseAccount?.id || purchaseAccount?.accountId, 160);
    if (!purchaseAccountId) fail('ALIPAY_LOGIN_PDD_PURCHASE_ACCOUNT_REQUIRED');
    const purchaseUrl = PAYMENT_BOOTSTRAP_URLS['拼多多'];
    let tab = [...tabs.values()].find((candidate) => (
      candidate.binding.accountId === purchaseAccountId && candidate.profile?.platformKey === 'pinduoduo'
    )) || null;
    if (!tab) {
      const opened = await open({
        accountId: purchaseAccountId,
        ownerType: 'purchase_account',
        url: purchaseUrl,
        waitUntil: 'commit',
        restoreVisible: false,
        traceId: `shared_alipay_login_${purchaseAccountId.slice(0, 24)}`,
      });
      const tabId = opened?.tabs?.find((candidate) => (
        candidate.tabId === opened.activeTabId && candidate.accountId === purchaseAccountId
      ))?.tabId;
      tab = (tabId ? tabs.get(tabId) : null)
        || [...tabs.values()].find((candidate) => (
          candidate.binding.accountId === purchaseAccountId && candidate.profile?.platformKey === 'pinduoduo'
        ))
        || null;
    }
    if (!tab) fail('PURCHASE_PAYMENT_MARKETPLACE_SESSION_MISSING');
    const cookies = await exportMarketplacePaymentCookies(tab, input.signal);
    const saved = await saveSharedAlipayLogin(input);
    const credential = await getAlipayLoginCredential();
    const result = await alipayPaymentWindowController.openSharedLogin({
      loginAccount: credential?.loginAccount || saved?.loginAccount || '',
      loginPassword: credential?.loginPassword || '',
      purchaseUrl,
      cookies,
    });
    return {
      ...result,
      credentialConfigured: true,
      loginAccount: saved?.loginAccount || credential?.loginAccount || '',
      purchaseAccountId,
      importedCookieCount: cookies.length,
      mode: 'queshou-pdd-wait-pay-to-alipay-login',
    };
  }

  async function readSharedAlipayLoginStatus() {
    const credential = await getAlipayLoginCredentialStatus();
    const sessionStatus = typeof alipayPaymentWindowController?.getSharedLoginStatus === 'function'
      ? await alipayPaymentWindowController.getSharedLoginStatus()
      : { loggedIn: false, cookieSaved: false, verificationSource: 'unavailable' };
    let syncedOwnerCount = 0;
    if (sessionStatus.loggedIn === true && typeof alipayPaymentWindowController?.syncSharedLoginToOwners === 'function') {
      const synced = await alipayPaymentWindowController.syncSharedLoginToOwners(await sharedAlipayOwnerRefs());
      syncedOwnerCount = Number(synced?.syncedOwnerCount) || 0;
    }
    return {
      ok: true,
      configured: credential?.configured === true,
      passwordConfigured: credential?.passwordConfigured === true,
      loginAccount: cleanOptionalText(credential?.loginAccount, 260),
      loggedIn: sessionStatus.loggedIn === true,
      cookieSaved: sessionStatus.cookieSaved === true,
      windowOpen: sessionStatus.windowOpen === true,
      verificationSource: cleanOptionalText(sessionStatus.verificationSource, 80),
      syncedOwnerCount,
      verifiedAt: sessionStatus.verifiedAt || new Date().toISOString(),
    };
  }

  async function clearSharedAlipayLogin() {
    await alipayPaymentWindowController?.purgeOwner?.('shared:alipay-login');
    return clearAlipayLoginCredential();
  }

  async function exportMarketplacePaymentCookies(tab, signal) {
    const exported = await tab.browser.request('export-purchase-session-cookies', {}, 10_000, signal);
    // A manual-login window must also open for a brand-new account whose CEF
    // profile has no marketplace cookie yet. Electron will persist the login
    // completed in that account-isolated partition and later payment windows
    // reuse it. Requiring a cookie here made the first login impossible.
    return Array.isArray(exported?.cookies) ? exported.cookies : [];
  }

  async function prewarmMarketplacePaymentWindow(tab) {
    if (typeof alipayPaymentWindowController?.prewarmLogin !== 'function') return null;
    const accountId = requiredText(tab?.binding?.accountId, 'PURCHASE_PAYMENT_ACCOUNT_REF_REQUIRED', 160);
    const platform = paymentPlatformFromProfileKey(tab?.profile?.platformKey);
    const purchaseUrl = PAYMENT_BOOTSTRAP_URLS[platform];
    if (!platform || !purchaseUrl) return null;
    const cookies = await exportMarketplacePaymentCookies(tab);
    const credential = await getPaymentCredential({ accountRef: accountId, platform });
    return alipayPaymentWindowController.prewarmLogin({
      sourceTabId: `payment-login-${accountId}`,
      ownerRef: accountId,
      accountId,
      platform,
      purchaseUrl,
      cookies,
      paymentCredential: credential?.loginAccount
        ? { loginAccount: cleanOptionalText(credential.loginAccount, 260), autoSubmit: false }
        : null,
    });
  }

  const prewarmPinduoduoPaymentWindow = prewarmMarketplacePaymentWindow;

  async function syncMarketplacePaymentLoginCookies({
    accountId,
    ownerRef,
    sourceTabId,
    platform,
    purchaseUrl,
    profileKeys,
  }) {
    let tab = [...tabs.values()].find((candidate) => (
      candidate.binding.accountId === accountId
      && profileKeys.has(candidate.profile?.platformKey)
    )) || null;
    if (!tab) {
      const openedState = await open({
        accountId,
        ownerType: 'purchase_account',
        url: purchaseUrl,
        waitUntil: 'commit',
        restoreVisible: false,
        traceId: `payment_cookie_export_${accountId.slice(0, 24)}`,
      });
      const openedTabId = openedState?.tabs?.find((candidate) => (
        candidate.tabId === openedState.activeTabId
        && candidate.accountId === accountId
      ))?.tabId;
      tab = (openedTabId ? tabs.get(openedTabId) : null)
        || [...tabs.values()].find((candidate) => (
          candidate.binding.accountId === accountId
          && profileKeys.has(candidate.profile?.platformKey)
        ))
        || null;
    }
    if (tab && !profileKeys.has(tab.profile?.platformKey)) fail('PURCHASE_PAYMENT_PLATFORM_ACCOUNT_MISMATCH');
    if (!tab) fail('PURCHASE_PAYMENT_MARKETPLACE_SESSION_MISSING');
    const cookies = await exportMarketplacePaymentCookies(tab);
    if (cookies.length && typeof alipayPaymentWindowController?.syncLoginCookies === 'function') {
      await alipayPaymentWindowController.syncLoginCookies({ sourceTabId, ownerRef, cookies });
    }
    appendLog(
      'desktop-main',
      `[alipay-payment] background cookie sync account=${sha256(accountId).slice(0, 12)} platform=${platform} count=${cookies.length}\n`,
    );
  }

  async function openPurchasePaymentLogin(input = {}) {
    const accountId = cleanOptionalText(input.accountId, 160);
    const sourceTabId = cleanOptionalText(
      input.sourceTabId || input.tabId || (accountId ? `payment-login-${accountId}` : `payment-login-${randomUUID()}`),
      180,
    );
    const ownerRef = cleanOptionalText(input.ownerRef || accountId || `payment-login:${sourceTabId}`, 160);
    const rawPlatform = cleanOptionalText(input.platform, 40);
    const platform = ({
      Pinduoduo: '拼多多', PDD: '拼多多', pinduoduo: '拼多多',
      Taobao: '淘宝', taobao: '淘宝', Tmall: '天猫', tmall: '天猫',
      Alibaba: '1688', alibaba: '1688',
    }[rawPlatform] || rawPlatform);
    if (!accountId || !PURCHASE_AUTO_ORDER_PLATFORMS.has(platform)) fail('PURCHASE_PAYMENT_PLATFORM_ACCOUNT_REQUIRED');
    const purchaseUrl = PAYMENT_BOOTSTRAP_URLS[platform];
    const profileKeys = platform === '拼多多'
      ? new Set(['pinduoduo'])
      : platform === '1688' ? new Set(['1688']) : new Set(['taobao', 'tmall']);
    if (typeof alipayPaymentWindowController?.openLogin !== 'function') {
      fail('PURCHASE_PAYMENT_LOGIN_UNAVAILABLE');
    }
    const prewarmed = alipayPaymentWindowController.snapshot?.().windows?.find((window) => (
      window.ownerRef === accountId && window.closed !== true
      && (!window.platform || window.platform === platform)
    ));
    if (prewarmed) {
      const credential = await getPaymentCredential({ accountRef: accountId, platform });
      const result = await alipayPaymentWindowController.openLogin({
        sourceTabId,
        ownerRef,
        accountId,
        platform,
        purchaseUrl,
        paymentCredential: credential?.loginAccount
          ? { loginAccount: cleanOptionalText(credential.loginAccount, 260), autoSubmit: false }
          : null,
      });
      return {
        ...result,
        mode: platform === '拼多多' ? 'prewarmed-electron-pdd-to-alipay-login' : `prewarmed-electron-${platform}-payment`,
        importedCookieCount: 0,
      };
    }
    if (platform === '拼多多') {
      let tab = [...tabs.values()].find((candidate) => (
        candidate.binding.accountId === accountId
        && profileKeys.has(candidate.profile?.platformKey)
      )) || null;
      if (!tab) {
        const openedState = await open({
          accountId,
          ownerType: 'purchase_account',
          url: purchaseUrl,
          waitUntil: 'commit',
          restoreVisible: false,
          traceId: `payment_cookie_export_${accountId.slice(0, 24)}`,
        });
        const openedTabId = openedState?.tabs?.find((candidate) => (
          candidate.tabId === openedState.activeTabId
          && candidate.accountId === accountId
        ))?.tabId;
        tab = (openedTabId ? tabs.get(openedTabId) : null)
          || [...tabs.values()].find((candidate) => (
            candidate.binding.accountId === accountId
            && profileKeys.has(candidate.profile?.platformKey)
          ))
          || null;
      }
      if (tab && !profileKeys.has(tab.profile?.platformKey)) fail('PURCHASE_PAYMENT_PLATFORM_ACCOUNT_MISMATCH');
      if (!tab) fail('PURCHASE_PAYMENT_MARKETPLACE_SESSION_MISSING');
      const cookies = await exportMarketplacePaymentCookies(tab, input.signal);
      const credential = await getPaymentCredential({ accountRef: accountId, platform });
      const result = await alipayPaymentWindowController.openLogin({
        sourceTabId,
        ownerRef,
        accountId,
        platform,
        purchaseUrl,
        cookies,
        paymentCredential: credential?.loginAccount
          ? { loginAccount: cleanOptionalText(credential.loginAccount, 260), autoSubmit: false }
          : null,
      });
      return {
        ...result,
        mode: 'independent-electron-pdd-to-alipay-login',
        importedCookieCount: cookies.length,
      };
    }
    const existingAccountTab = [...tabs.values()].find((candidate) => candidate.binding.accountId === accountId) || null;
    if (existingAccountTab && !profileKeys.has(existingAccountTab.profile?.platformKey)) {
      fail('PURCHASE_PAYMENT_PLATFORM_ACCOUNT_MISMATCH');
    }
    if (!existingAccountTab) {
      const payload = await localApiClient.getOwnerBinding(accountId, 'purchase_account');
      const accountProfile = profileStore.getOrCreate(payload?.binding || {});
      if (!profileKeys.has(accountProfile.platformKey)) fail('PURCHASE_PAYMENT_PLATFORM_ACCOUNT_MISMATCH');
    }
    const credential = await getPaymentCredential({ accountRef: accountId, platform });
    const loginPromise = alipayPaymentWindowController.openLogin({
      sourceTabId,
      ownerRef,
      accountId,
      platform,
      purchaseUrl,
      cookies: [],
      paymentCredential: credential?.loginAccount
        ? {
            loginAccount: cleanOptionalText(credential.loginAccount, 260),
            autoSubmit: false,
          }
        : null,
    });
    void syncMarketplacePaymentLoginCookies({
      accountId,
      ownerRef,
      sourceTabId,
      platform,
      purchaseUrl,
      profileKeys,
    }).catch((error) => appendLog(
      'desktop-main',
      `[alipay-payment] background cookie sync deferred account=${sha256(accountId).slice(0, 12)} platform=${platform} code=${sanitizedErrorCode(error)}\n`,
    ));
    const result = await loginPromise;
    return {
      ...result,
      mode: platform === '拼多多' ? 'independent-electron-pdd-to-alipay-login' : `independent-electron-${platform}-payment`,
      importedCookieCount: 0,
      cookieSyncPending: true,
    };
  }

  async function readPurchasePaymentLoginStatus(input = {}) {
    const accountId = requiredText(input.accountId || input.accountRef, 'PURCHASE_PAYMENT_ACCOUNT_REF_REQUIRED', 160);
    const rawPlatform = cleanOptionalText(input.platform, 40);
    const platform = ({
      Pinduoduo: '拼多多', PDD: '拼多多', pinduoduo: '拼多多',
      Taobao: '淘宝', taobao: '淘宝', Tmall: '天猫', tmall: '天猫',
      Alibaba: '1688', alibaba: '1688',
    }[rawPlatform] || rawPlatform);
    if (!PURCHASE_AUTO_ORDER_PLATFORMS.has(platform)) fail('PURCHASE_PAYMENT_PLATFORM_ACCOUNT_REQUIRED');
    const purchaseUrl = PAYMENT_BOOTSTRAP_URLS[platform];
    const profileKeys = platform === '拼多多'
      ? new Set(['pinduoduo'])
      : platform === '1688' ? new Set(['1688']) : new Set(['taobao', 'tmall']);
    let tab = [...tabs.values()].find((candidate) => candidate.binding.accountId === accountId) || null;
    if (tab && !profileKeys.has(tab.profile?.platformKey)) fail('PURCHASE_PAYMENT_PLATFORM_ACCOUNT_MISMATCH');
    if (!tab) {
      const payload = await localApiClient.getOwnerBinding(accountId, 'purchase_account');
      const accountProfile = profileStore.getOrCreate(payload?.binding || {});
      if (!profileKeys.has(accountProfile.platformKey)) fail('PURCHASE_PAYMENT_PLATFORM_ACCOUNT_MISMATCH');
      const openedState = await open({
        accountId,
        ownerType: 'purchase_account',
        url: purchaseUrl,
        waitUntil: 'commit',
        restoreVisible: false,
        traceId: `payment_login_status_${accountId.slice(0, 24)}`,
      });
      const openedTabId = openedState?.tabs?.find((candidate) => (
        candidate.tabId === openedState.activeTabId && candidate.accountId === accountId
      ))?.tabId;
      tab = (openedTabId ? tabs.get(openedTabId) : null)
        || [...tabs.values()].find((candidate) => (
          candidate.binding.accountId === accountId && profileKeys.has(candidate.profile?.platformKey)
        ))
        || null;
    }
    if (!tab) fail('PURCHASE_PAYMENT_MARKETPLACE_SESSION_MISSING');

    const sourceTabId = `payment-login-${accountId}`;
    let electronBefore = null;
    let electronCookies = null;
    if (typeof alipayPaymentWindowController?.getLoginStatus === 'function') {
      electronBefore = await alipayPaymentWindowController.getLoginStatus({ sourceTabId, ownerRef: accountId, platform });
    }
    if (typeof alipayPaymentWindowController?.exportLoginCookies === 'function') {
      electronCookies = await alipayPaymentWindowController.exportLoginCookies({ sourceTabId, ownerRef: accountId, platform });
    }
    if (electronCookies?.cookies?.length) {
      await tab.browser.request(
        'import-purchase-session-cookies',
        { cookies: electronCookies.cookies },
        12_000,
        input.signal,
      );
    }
    const cef = await tab.browser.request('purchase-login-status', {}, 20_000, input.signal);
    if (
      cef?.loggedIn === true
      && electronBefore?.loggedIn !== true
      && typeof alipayPaymentWindowController?.syncLoginCookies === 'function'
    ) {
      const cefCookies = await exportMarketplacePaymentCookies(tab, input.signal);
      if (cefCookies.length) {
        await alipayPaymentWindowController.syncLoginCookies({ sourceTabId, ownerRef: accountId, cookies: cefCookies });
      }
    }
    if (
      typeof alipayPaymentWindowController?.getSharedLoginStatus === 'function'
      && typeof alipayPaymentWindowController?.syncSharedLoginToOwners === 'function'
    ) {
      const sharedStatus = await alipayPaymentWindowController.getSharedLoginStatus();
      if (sharedStatus?.loggedIn === true) {
        await alipayPaymentWindowController.syncSharedLoginToOwners([accountId]);
      }
    }
    const electron = typeof alipayPaymentWindowController?.getLoginStatus === 'function'
      ? await alipayPaymentWindowController.getLoginStatus({ sourceTabId, ownerRef: accountId, platform })
      : electronBefore;
    const marketplaceLoggedIn = electron?.marketplaceLoggedIn === true || cef?.loggedIn === true;
    const alipayLoggedIn = electron?.alipayLoggedIn === true
      || (electron?.loggedIn === true && electron?.marketplaceLoggedIn === undefined);
    const loggedIn = marketplaceLoggedIn && alipayLoggedIn;
    const cookieSaved = loggedIn && (electron?.cookieSaved === true || cef?.cookieSaved === true);
    return {
      ok: true,
      accountId,
      platform,
      loggedIn,
      paymentReady: loggedIn,
      marketplaceLoggedIn,
      alipayLoggedIn,
      cookieSaved,
      windowOpen: electron?.windowOpen === true,
      cookieCount: Math.max(Number(electron?.cookieCount) || 0, Number(cef?.cookieCount) || 0),
      verificationSource: loggedIn
        ? electron.verificationSource
        : marketplaceLoggedIn ? 'alipay-login-required'
          : electron?.verificationSource || cef?.verificationSource || 'none',
      verifiedAt: new Date().toISOString(),
      cef: {
        loggedIn: cef?.loggedIn === true,
        cookieSaved: cef?.cookieSaved === true,
        cookieCount: Number(cef?.cookieCount) || 0,
        verificationSource: cleanOptionalText(cef?.verificationSource, 80),
      },
      electron: electron ? {
        loggedIn: electron.loggedIn === true,
        marketplaceLoggedIn: electron.marketplaceLoggedIn === true,
        alipayLoggedIn: electron.alipayLoggedIn === true,
        cookieSaved: electron.cookieSaved === true,
        cookieCount: Number(electron.cookieCount) || 0,
        windowOpen: electron.windowOpen === true,
        verificationSource: cleanOptionalText(electron.verificationSource, 80),
      } : null,
    };
  }

  async function clearPurchasePaymentSession(input = {}) {
    const accountRef = requiredText(input.accountRef, 'PURCHASE_PAYMENT_ACCOUNT_REF_REQUIRED', 160);
    const ownerRefs = new Set([accountRef]);
    try {
      const payload = await localApiClient.getOwnerBinding(accountRef, 'purchase_account');
      const profile = profileStore.get(payload?.binding || {});
      if (profile?.ownerRef) ownerRefs.add(profile.ownerRef);
    } catch {
      // A missing/deleted purchase account can still clear the direct account partition below.
    }
    for (const tab of tabs.values()) {
      if (tab.binding.accountId === accountRef) ownerRefs.add(tab.storageRef);
    }
    const results = [];
    for (const ownerRef of ownerRefs) {
      results.push(await alipayPaymentWindowController?.purgeOwner?.(ownerRef));
    }
    return { ok: true, accountRef, clearedSessions: results.filter(Boolean).length };
  }

  async function showPurchasePaymentWindow(input = {}) {
    return alipayPaymentWindowController?.show?.(cleanOptionalText(input.sourceTabId || input.tabId, 180))
      || { ok: false, shown: false };
  }

  async function resumePurchaseAutoOrder(input = {}) {
    const tab = getTab(input.tabId);
    if (!tab.autoOrder?.paused || !tab.autoOrder.request) fail('PURCHASE_AUTO_ORDER_NOT_PAUSED');
    tab.autoOrder = { ...tab.autoOrder, paused: false, stage: 'resuming', updatedAt: new Date().toISOString() };
    emit('purchase-auto-order-stage', { tabId: tab.tabId, stage: 'resuming', idempotencyKey: tab.autoOrder.idempotencyKey });
    return executePurchaseAutoOrder(tab.autoOrder.request);
  }

  async function readAutoPayCredentialStatus(input = {}) {
    return getPaymentCredentialStatus({ accountRef: requiredText(input.accountRef, 'PURCHASE_PAYMENT_ACCOUNT_REF_REQUIRED', 260) });
  }

  async function crossBorderCommand({ tabId, command, payload = {}, signal } = {}) {
    const tab = getTab(tabId);
    if (tab.addonState.installState !== 'active') fail('PURCHASE_BROWSER_EXTENSION_NOT_VERIFIED');
    const target = policy.classifyUrl(tab.state.url, { allowBlank: false });
    if (!target.allowed) fail('PURCHASE_BROWSER_NAVIGATION_FORBIDDEN');
    if (command === 'cross-border-sync' && payload?.commit === true && payload?.confirmed !== true) {
      fail('CROSS_BORDER_SYNC_PREVIEW_REQUIRED');
    }
    const syncMode = cleanOptionalText(payload?.mode, 40);
    const timeoutMs = command === 'cross-border-sync'
      ? ['supplier-read', 'supplier-order-read', 'package-update'].includes(syncMode)
        ? 65_000
        : 600_000
      // The queue already grants charge reads 630s. Keep the native transport
      // inside that existing task budget; a 45s inner cutoff killed valid pages.
      : command === 'cross-border-charges' ? 600_000
      : 45_000;
    const result = await tab.browser.request(command, payload, timeoutMs, signal);
    return { ok: true, result, state: snapshot() };
  }

  async function openExactOzonSellerOrder({ tabId, postingNumber, routeKind = 'fbs', signal } = {}) {
    const tab = getTab(tabId);
    const target = policy.classifyUrl(tab.state.url, { allowBlank: false });
    let sellerHost = '';
    try { sellerHost = new URL(String(target.url || '')).hostname.toLowerCase(); } catch { /* handled below */ }
    if (!target.allowed || sellerHost !== 'seller.ozon.ru') fail('PURCHASE_BROWSER_OZON_ORDER_PAGE_REQUIRED');
    const normalizedPostingNumber = requiredText(
      postingNumber,
      'PURCHASE_BROWSER_OZON_ORDER_NUMBER_REQUIRED',
      160,
    );
    const normalizedRouteKind = String(routeKind || '').trim().toLowerCase();
    if (!['fbs', 'fbo', 'rfbs'].includes(normalizedRouteKind)) {
      fail('PURCHASE_BROWSER_OZON_ORDER_ROUTE_INVALID');
    }
    const result = await tab.browser.request('ozon-open-order', {
      postingNumber: normalizedPostingNumber,
      routeKind: normalizedRouteKind,
    }, 115_000, signal);
    if (result?.exact !== true || result?.opened !== true || String(result?.posting || '').trim() !== normalizedPostingNumber) {
      fail('PURCHASE_BROWSER_OZON_ORDER_OPEN_FAILED');
    }
    tab.state = { ...tab.state, url: String(result.pageUrl || tab.state.url) };
    return { ok: true, result, state: snapshot() };
  }

  async function persistOzonLoginVerification(tab, verification = {}) {
    if (tab.binding?.ownerType !== 'integration_profile') return null;
    if (typeof localApiClient?.saveIntegrationProfileLoginStatus !== 'function') {
      fail('PURCHASE_BROWSER_INTEGRATION_LOGIN_STATUS_SERVICE_UNAVAILABLE');
    }
    const verificationOutcome = cleanOptionalText(verification.verificationOutcome, 40).toLowerCase();
    if (verification.verificationPending === true || verificationOutcome === 'pending') {
      // A 403 from Ozon's private interface-state endpoint while the Seller
      // SPA is still loading is inconclusive, not a logout.  Keep the last
      // confirmed SQLite state until the browser produces either an
      // authenticated app shell or explicit sign-in evidence.
      return { ok: true, pending: true, connected: null, profile: null };
    }
    let saved;
    try {
      saved = await localApiClient.saveIntegrationProfileLoginStatus(tab.binding.accountId, {
        loggedIn: verification.loggedIn === true,
        cookieSaved: verification.cookieSaved === true,
        verifiedAt: verification.verifiedAt || new Date().toISOString(),
        verificationSource: String(verification.verificationSource || '').trim(),
        probeStatus: Math.max(0, Number(verification.probeStatus) || 0),
        companyId: cleanOptionalText(verification.companyId, 200),
        companyName: cleanOptionalText(verification.companyName, 300),
      });
    } catch (error) {
      const code = sanitizedErrorCode(error);
      const rawCauseCode = cleanOptionalText(error?.causeCode || error?.cause?.code, 80).toUpperCase();
      const causeCode = /^[A-Z0-9_]{1,80}$/u.test(rawCauseCode) ? rawCauseCode : 'UNKNOWN';
      const attempts = Math.max(1, Math.min(4, Number(error?.attempts) || 1));
      appendLog(
        'desktop-main',
        `[purchase-browser] Ozon login persistence failed tab=${tab.tabId} code=${code} cause=${causeCode} attempts=${attempts}\n`,
      );
      if (code !== 'PURCHASE_BROWSER_LOCAL_API_TRANSPORT_FAILED') throw error;
      const wrapped = new Error('PURCHASE_BROWSER_INTEGRATION_LOGIN_STATUS_PERSIST_FAILED');
      wrapped.code = 'PURCHASE_BROWSER_INTEGRATION_LOGIN_STATUS_PERSIST_FAILED';
      wrapped.causeCode = causeCode;
      wrapped.attempts = attempts;
      wrapped.cause = error;
      throw wrapped;
    }
    const expectedConnected = verification.loggedIn === true && verification.cookieSaved === true;
    const identityPendingStatuses = new Set(['unverified', 'api-missing', 'browser-matched', 'mismatch']);
    const shopIdentityPending = expectedConnected
      && saved?.connected === false
      && identityPendingStatuses.has(String(saved?.identityStatus || saved?.profile?.identityStatus || '').trim());
    if (
      !saved?.profile?.id
      || String(saved.profile.id) !== String(tab.binding.accountId)
      || (!expectedConnected && saved?.connected !== false)
      || (expectedConnected && saved?.connected !== true && !shopIdentityPending)
    ) {
      fail('PURCHASE_BROWSER_INTEGRATION_LOGIN_READBACK_FAILED');
    }
    return saved;
  }

  async function verifyOzonLogin(tab, { signal, force = true, persist = true } = {}) {
    const cached = tab.ozonLoginVerification;
    if (
      force !== true
      && cached?.result?.loggedIn === true
      && cached?.result?.cookieSaved === true
      && Date.now() - Number(cached.checkedAt || 0) <= OZON_LOGIN_VERIFICATION_TTL_MS
    ) {
      return cached;
    }
    const loginCommand = tab.binding?.integrationType === OZON_FOLLOW_SELLER_SESSION_TYPE
      ? 'purchase-login-status'
      : 'ozon-login-status';
    const result = await tab.browser.request(loginCommand, {}, 20_000, signal);
    const saved = persist === true ? await persistOzonLoginVerification(tab, result) : null;
    const verification = {
      result: {
        ...result,
        ...(saved?.profile ? { profile: saved.profile } : {}),
        ...(saved ? {
          connected: saved.connected === true,
          identityMatched: saved.identityMatched ?? null,
          identityStatus: saved.identityStatus || saved.profile?.identityStatus || '',
        } : {}),
      },
      checkedAt: Date.now(),
    };
    tab.ozonLoginVerification = verification;
    return verification;
  }

	function isOzonLoginVerificationPending(verification = {}) {
	  return verification?.result?.verificationPending === true
	    || cleanOptionalText(verification?.result?.verificationOutcome, 40).toLowerCase() === 'pending';
	}

	async function waitForOzonLoginVerification(tab, { signal, force = false, persist = true } = {}) {
	  let verification = null;
	  for (let attempt = 0; attempt < OZON_LOGIN_SETTLE_ATTEMPTS; attempt += 1) {
	    assertNotAborted(signal);
	    verification = await verifyOzonLogin(tab, {
	      signal,
	      force: attempt === 0 ? force : true,
	      persist,
	    });
	    if (!isOzonLoginVerificationPending(verification)) return verification;
	    appendLog(
	      'desktop-main',
	      `[purchase-browser] ozon login gate pending tab=${tab.tabId} attempt=${attempt + 1}/${OZON_LOGIN_SETTLE_ATTEMPTS}\n`,
	    );
	    if (attempt === OZON_LOGIN_SETTLE_ATTEMPTS - 1) return verification;
	    await waitForDelay(OZON_LOGIN_SETTLE_DELAY_MS);
	  }
	  return verification;
	}

  async function markOzonLoginInvalid(tab, result = {}) {
    const verification = {
      loggedIn: false,
      cookieSaved: false,
      verificationSource: Number(result?.status) === 401 ? 'api-401' : 'login-page',
      probeStatus: Math.max(0, Number(result?.status) || 0),
      url: String(result?.url || result?.pageUrl || tab.state?.url || '').trim(),
      verifiedAt: new Date().toISOString(),
    };
    const saved = await persistOzonLoginVerification(tab, verification);
    tab.ozonLoginVerification = { result: { ...verification, profile: saved?.profile }, checkedAt: Date.now() };
    return verification;
  }

  async function ozonLoginStatus({ tabId, signal, persistStatus = true } = {}) {
    const tab = getTab(tabId);
    const verification = await verifyOzonLogin(tab, { signal, force: true, persist: persistStatus !== false });
    return { ok: true, result: verification.result, state: snapshot() };
  }

  async function purchaseLoginStatus({ tabId, signal } = {}) {
    const tab = getTab(tabId);
    if (tab.background === true) fail('PURCHASE_BROWSER_INTERACTIVE_TAB_REQUIRED');
    const result = await tab.browser.request('purchase-login-status', {}, 20_000, signal);
    if (
      paymentPlatformFromProfileKey(tab.profile?.platformKey)
      && result?.loggedIn === true
      && result?.cookieSaved === true
    ) {
      void prewarmMarketplacePaymentWindow(tab).catch((error) => appendLog(
        'desktop-main',
        `[alipay-payment] cookie sync deferred account=${sha256(tab.binding.accountId).slice(0, 12)} code=${sanitizedErrorCode(error)}\n`,
      ));
    }
    return { ok: true, result, state: snapshot() };
  }

  async function seedPurchaseLoginFixture({ tabId, signal } = {}) {
    if (process.env.WANGZAI_PURCHASE_BROWSER_LOGIN_FIXTURE !== '1') {
      fail('PURCHASE_BROWSER_LOGIN_FIXTURE_DISABLED');
    }
    const tab = getTab(tabId);
    if (tab.background === true) fail('PURCHASE_BROWSER_INTERACTIVE_TAB_REQUIRED');
    const result = await tab.browser.request('purchase-login-fixture', {}, 20_000, signal);
    return { ok: true, result, state: snapshot() };
  }

  async function ozonDataCommand({
    tabId,
    command,
    afterSequence = 0,
    limit = 20,
    drain = false,
    sourceSequence = 0,
    offset = 0,
    query = '',
    path = '',
    method = 'POST',
    body = null,
    origin = 'https://seller.ozon.ru',
    skus = [],
    concurrency = 6,
    includeProductFacts = false,
    captureToken = '',
    attachments = [],
    evidenceId = '',
    progressToken = '',
    speech = {},
    evidencePath = '',
    materialDirectory = '',
    sourceProductUrl = '',
    originalSku = '',
    offerId = '',
    followerSkus = [],
    followers = [],
    evidenceFollowers = [],
	resumeExisting = false,
	reusePreparedEvidence = false,
	resumeTicketId = '',
	resumePageUrl = '',
	resumePhase = '',
	stopBeforeFirstMessage = false,
	stopAfterRepeatedPromptDetection = false,
    maxPages = 5,
    delayMs = 100,
    signal,
  } = {}) {
    const tab = getTab(tabId);
    if (
      command === 'ozon-data-follow-sellers'
      && tab.browserRole !== PURCHASE_BROWSER_ROLES.FOLLOW_SELLER_COLLECTOR
    ) fail('PURCHASE_BROWSER_FOLLOW_SELLER_ROLE_REQUIRED');
    if (
      command === 'ozon-submit-follow-seller-complaint'
      && tab.browserRole !== PURCHASE_BROWSER_ROLES.FOLLOW_SELLER_COLLECTOR
    ) fail('PURCHASE_BROWSER_FOLLOW_SELLER_ROLE_REQUIRED');
    if (
      command === 'ozon-submit-follow-seller-quick-complaint'
      && tab.browserRole !== PURCHASE_BROWSER_ROLES.FOLLOW_SELLER_COLLECTOR
    ) fail('PURCHASE_BROWSER_FOLLOW_SELLER_ROLE_REQUIRED');
    if (
      tab.browserRole === PURCHASE_BROWSER_ROLES.FOLLOW_SELLER_COLLECTOR
      && !['ozon-data-status', 'ozon-data-follow-sellers', 'ozon-submit-follow-seller-complaint', 'ozon-submit-follow-seller-quick-complaint'].includes(command)
    ) fail('PURCHASE_BROWSER_FOLLOW_SELLER_COMMAND_INVALID');
    let loginVerification;
    try {
      // Scheme 1 already resolved the exact saved seller profile before this
      // command. Re-validate the live Chromium session, but do not write the
      // same Cookie/login state back through local-api on every complaint.
      // A local persistence timeout must never break an otherwise valid Ozon
      // conversation before submission has started.
      // Data reads validate the live Chromium session, but do not synchronously
      // rewrite the same login row every 30 seconds. Explicit login/save flows
      // and confirmed logout evidence still persist status separately.
      const persistLoginVerification = false;
      loginVerification = await waitForOzonLoginVerification(tab, {
        signal,
        force: false,
        persist: persistLoginVerification,
      });
    } catch (error) {
      appendLog(
        'desktop-main',
        `[purchase-browser] ozon login gate error command=${cleanOptionalText(command, 80)} tab=${tab.tabId} code=${sanitizedErrorCode(error)}\n`,
      );
      throw error;
    }
	if (isOzonLoginVerificationPending(loginVerification)) {
	  fail('OZON_LOGIN_VERIFICATION_PENDING');
	}
    if (loginVerification?.result?.loggedIn !== true || loginVerification?.result?.cookieSaved !== true) {
      fail('OZON_LOGIN_REQUIRED');
    }
    const boundedPages = Math.max(1, Math.min(250, Number(maxPages) || 5));
    const boundedDelay = Math.max(100, Math.min(3000, Number(delayMs) || 100));
    const limitCeiling = command === 'ozon-data-payload' ? 512 * 1024 : 50;
    let result;
    try {
      const complaintAttachments = command === 'ozon-submit-follow-seller-complaint'
        ? validatedFollowSellerEvidenceAttachments(attachments)
        : command === 'ozon-submit-follow-seller-quick-complaint'
          ? validatedFollowSellerQuickAttachments(attachments)
          : [];
      const quickFollowerSkus = command === 'ozon-submit-follow-seller-quick-complaint'
        ? [...new Set((Array.isArray(followerSkus) ? followerSkus : []).map((value) => String(value || '').trim()).filter((value) => /^\d{5,20}$/u.test(value)))].slice(0, 200)
        : [];
      const quickFollowers = command === 'ozon-submit-follow-seller-quick-complaint'
        ? validatedFollowSellerQuickFollowers(followers, quickFollowerSkus)
        : [];
      result = await tab.browser.request(command, {
        afterSequence: Math.max(0, Number(afterSequence) || 0),
        limit: Math.max(1, Math.min(limitCeiling, Number(limit) || 20)),
        drain: drain === true,
        sourceSequence: Math.max(0, Number(sourceSequence) || 0),
        offset: Math.max(0, Number(offset) || 0),
        query: String(query || '').trim().slice(0, 160),
        path: String(path || '').trim().slice(0, 500),
        method: String(method || 'POST').trim().toUpperCase().slice(0, 10),
        body: body && typeof body === 'object' && !Array.isArray(body) ? body : null,
        origin: String(origin || 'https://seller.ozon.ru').trim().slice(0, 200),
        skus: [...new Set((Array.isArray(skus) ? skus : [])
          .map((sku) => String(sku || '').trim())
          .filter((sku) => /^\d{5,20}$/u.test(sku)))]
          .slice(0, 100),
        concurrency: Math.max(1, Math.min(8, Number(concurrency) || 6)),
        includeProductFacts: includeProductFacts === true,
        captureToken: String(captureToken || '').trim().slice(0, 120),
        attachments: complaintAttachments,
        evidenceId: String(evidenceId || '').trim().slice(0, 160),
        progressToken: command === 'ozon-submit-follow-seller-quick-complaint'
          ? cleanOptionalText(progressToken, 200)
          : '',
        speech: ['ozon-submit-follow-seller-complaint', 'ozon-submit-follow-seller-quick-complaint'].includes(command) ? {
          ru: String(speech?.ru || '').trim().slice(0, 12_000),
          initialEvidenceRu: String(speech?.initialEvidenceRu || '').trim().slice(0, 12_000),
          supplementRu: String(speech?.supplementRu || '').trim().slice(0, 12_000),
          followerBatchRu: String(speech?.followerBatchRu || '').trim().slice(0, 12_000),
          zh: String(speech?.zh || '').trim().slice(0, 12_000),
        } : null,
        materialDirectory: command === 'ozon-submit-follow-seller-quick-complaint'
          ? nodePath.dirname(validatedFollowSellerEvidenceManifest(evidencePath))
          : '',
        sourceProductUrl: command === 'ozon-submit-follow-seller-quick-complaint'
          ? requiredText(sourceProductUrl, 'FOLLOW_SELLER_SCHEME1_PRODUCT_URL_REQUIRED', 1000)
          : '',
        originalSku: command === 'ozon-submit-follow-seller-quick-complaint'
          ? requiredText(originalSku, 'FOLLOW_SELLER_SCHEME1_ORIGINAL_SKU_REQUIRED', 30)
          : '',
        offerId: command === 'ozon-submit-follow-seller-quick-complaint'
          ? requiredText(offerId, 'FOLLOW_SELLER_SCHEME1_OFFER_ID_REQUIRED', 160)
          : '',
        followerSkus: command === 'ozon-submit-follow-seller-quick-complaint'
          ? quickFollowerSkus
          : [],
        followers: quickFollowers,
        evidenceFollowers: command === 'ozon-submit-follow-seller-quick-complaint'
          ? validatedFollowSellerQuickEvidenceFollowers(evidenceFollowers)
          : [],
		resumeExisting: command === 'ozon-submit-follow-seller-quick-complaint' && resumeExisting === true,
		reusePreparedEvidence: command === 'ozon-submit-follow-seller-quick-complaint' && reusePreparedEvidence === true,
		resumeTicketId: command === 'ozon-submit-follow-seller-quick-complaint'
		  ? cleanOptionalText(resumeTicketId, 160)
		  : '',
		resumePageUrl: command === 'ozon-submit-follow-seller-quick-complaint'
		  ? cleanOptionalText(resumePageUrl, 1000)
		  : '',
		resumePhase: command === 'ozon-submit-follow-seller-quick-complaint'
		  ? cleanOptionalText(resumePhase, 80)
		  : '',
		stopBeforeFirstMessage: command === 'ozon-submit-follow-seller-quick-complaint'
		  && stopBeforeFirstMessage === true,
		stopAfterRepeatedPromptDetection: command === 'ozon-submit-follow-seller-quick-complaint'
		  && stopAfterRepeatedPromptDetection === true,
        maxPages: boundedPages,
        delayMs: boundedDelay,
      }, command === 'ozon-data-paginate'
        ? Math.min(1_200_000, 30_000 + boundedPages * (boundedDelay + 750))
        : command === 'ozon-data-follow-sellers'
          ? Math.min(300_000, 60_000 + Math.ceil(Math.min(100, skus.length) / 100) * 20_000)
          : command === 'ozon-submit-follow-seller-complaint' ? 240_000
	          : command === 'ozon-submit-follow-seller-quick-complaint' ? 620_000
          : command === 'ozon-data-probe' ? 40_000 : 20_000, signal);
    } catch (error) {
      appendLog(
        'desktop-main',
        `[purchase-browser] ozon command error command=${cleanOptionalText(command, 80)} tab=${tab.tabId} code=${cleanOptionalText(error?.code || error?.message, 160) || 'unknown'} url=${cleanOptionalText(tab.state.url, 500)} loading=${tab.state.loading === true} sequence=${Number(tab.state.navigationSequence) || 0} completed=${Number(tab.state.navigationCompletedSequence) || 0}\n`,
      );
      throw error;
    }
    if (command === 'ozon-data-status') {
      appendLog(
        'desktop-main',
        `[purchase-browser] ozon observer status tab=${tab.tabId} installed=${result?.installed === true} enabled=${result?.enabled === true} eligible=${result?.pageEligible === true} ready=${result?.ready === true} version=${cleanOptionalText(result?.runtime?.version || result?.extensionVersion, 40)} url=${cleanOptionalText(tab.state.url, 500)} loading=${tab.state.loading === true} sequence=${Number(tab.state.navigationSequence) || 0} completed=${Number(tab.state.navigationCompletedSequence) || 0}\n`,
      );
    }
    if (command === 'ozon-data-probe') {
      appendLog(
        'desktop-main',
        `[purchase-browser] ozon probe result tab=${tab.tabId} origin=${cleanOptionalText(origin, 200)} path=${cleanOptionalText(path, 300)} status=${Number(result?.status) || 0} quality=${cleanOptionalText(result?.quality, 80) || 'unknown'} records=${Number(result?.recordCount) || 0} captured=${Number(result?.capturedSequence) || 0}\n`,
      );
    }
    if (isOzonAuthenticationDeniedResult(result)) {
      await markOzonLoginInvalid(tab, result);
      fail('OZON_LOGIN_REQUIRED');
    }
    if (command === 'ozon-data-follow-sellers') {
      appendLog(
        'desktop-main',
        `[purchase-browser] ozon follow sellers tab=${tab.tabId} requested=${Number(result?.requested) || 0} confirmed=${Number(result?.confirmed) || 0} failed=${Number(result?.failed) || 0}\n`,
      );
    }
    return { ok: true, result, state: snapshot() };
  }

  function beginOzonPaginationCancellation(reason = 'interactive') {
    const execution = activeQueuedCommand;
    if (execution?.command !== 'ozon-data-paginate') return null;
    const tab = tabs.get(String(execution.tabId || ''));
    if (!tab) return null;
    appendLog(
      'desktop-main',
      `[purchase-browser] pagination cancel fence reason=${cleanOptionalText(reason, 80) || 'interactive'} tab=${tab.tabId}\n`,
    );
    return tab.browser.request('ozon-data-cancel-pagination', {}, 5_000)
      .then((result) => {
        appendLog(
          'desktop-main',
          `[purchase-browser] pagination cancel fence completed tab=${tab.tabId} cancelled=${result?.cancelled === true}\n`,
        );
        return result;
      })
      .catch((error) => {
        // A navigation can destroy the old page between the active pagination
        // snapshot and this fence. In that case the old document is already
        // incapable of mutating the new observer, so log and continue.
        appendLog(
          'desktop-main',
          `[purchase-browser] pagination cancel fence skipped tab=${tab.tabId} code=${sanitizedErrorCode(error)}\n`,
        );
        return null;
      });
  }

  async function inspect(tabId, signal) {
    const tab = getTab(tabId);
    if (tab.addonState.installState !== 'active') fail('PURCHASE_BROWSER_EXTENSION_NOT_VERIFIED');
    const target = policy.classifyUrl(tab.state.url, { allowBlank: false });
    if (!target.allowed) fail('PURCHASE_BROWSER_NAVIGATION_FORBIDDEN');
    const result = await tab.browser.request('inspect', {}, 35_000, signal);
    return { ok: true, inspection: normalizePurchaseCapture(result), state: snapshot() };
  }

  async function setTarget({ tabId, target, targetHash = '', signal } = {}) {
    const tab = getTab(tabId);
    let normalized;
    try {
      normalized = normalizeTargetContext(target);
    } catch (error) {
      setTargetPhase(tab, 'error');
      throw error;
    }
    if (targetHash && String(targetHash) !== targetFingerprint(normalized)) {
      setTargetPhase(tab, 'error');
      fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
    }
    setTargetPhase(tab, 'target-selecting');
    try {
      await tab.browser.request('set-target', {
        target: normalized,
        targetHash: targetFingerprint(normalized),
      }, 20_000, signal);
    } catch (error) {
      // Older fixture sessions do not implement the sidecar target command;
      // the controller still remains authoritative for those sessions.
      if (error?.code !== 'PURCHASE_BROWSER_COMMAND_INVALID') {
        setTargetPhase(tab, 'error');
        throw error;
      }
    }
    const targetChanged = targetFingerprint(tab.target) !== targetFingerprint(normalized);
    tab.target = normalized;
    if (targetChanged) {
      tab.capturePreview = null;
      tab.captureResult = null;
      tab.purchaseContext = null;
      tab.pendingPurchaseCapture = null;
      clearPinduoduoAutoCapture(tab, { reset: true });
    }
    tab.session = sessions.updateSession(tab.session.sessionId, { target: normalized });
    setTargetPhase(tab, 'target-locked');
    emit('target-changed', { tabId: tab.tabId });
    schedulePinduoduoAutoCapture(tab, 250);
    return { ok: true, target: normalized, targetPhase: tab.targetPhase, state: snapshot() };
  }

  async function clearTarget(tabId, signal) {
    const tab = getTab(tabId);
    try {
      await tab.browser.request('clear-target', {}, 20_000, signal);
    } catch (error) {
      if (error?.code !== 'PURCHASE_BROWSER_COMMAND_INVALID') {
        setTargetPhase(tab, 'error');
        throw error;
      }
    }
    tab.target = null;
    clearPinduoduoAutoCapture(tab, { reset: true });
    tab.capturePreview = null;
    tab.captureResult = null;
    tab.purchaseContext = null;
    tab.pendingPurchaseCapture = null;
    tab.session = sessions.updateSession(tab.session.sessionId, { target: null });
    setTargetPhase(tab, 'idle');
    emit('target-changed', { tabId: tab.tabId });
    return { ok: true, target: null, targetPhase: tab.targetPhase, state: snapshot() };
  }

  function suspendWorkbench(bounds = {}) {
    const tab = tabs.get(activeTabId);
    if (tab && tab.background !== true) {
      const targetChanged = Boolean(tab.target || tab.pendingPurchaseCapture || tab.pinduoduoAutoCaptureTimer);
      clearPinduoduoAutoCapture(tab, { reset: true });
      tab.target = null;
      tab.capturePreview = null;
      tab.captureResult = null;
      tab.purchaseContext = null;
      tab.pendingPurchaseCapture = null;
      tab.targetPhase = 'idle';
      if (sessions.isCurrent(tab.session.sessionId, tab.session.generation)) {
        tab.session = sessions.updateSession(tab.session.sessionId, { target: null, phase: 'hidden' });
      }
      if (targetChanged) emit('target-changed', { tabId: tab.tabId });
    }
    return setBounds({ ...bounds, visible: false });
  }

  function getTarget(tabId) {
    const tab = getTab(tabId);
    return {
      ok: true,
      target: tab.target || null,
      targetPhase: normalizeTargetPhase(tab.targetPhase, tab.target ? 'target-locked' : 'idle'),
      state: snapshot(),
    };
  }

  async function recoverTarget({ tabId, target, targetHash = '', signal } = {}) {
    const tab = getTab(tabId);
    const normalized = target ? normalizeTargetContext(target) : tab.target;
    if (!normalized) fail('PURCHASE_BROWSER_TARGET_REQUIRED');
    if (targetHash && String(targetHash) !== targetFingerprint(normalized)) {
      setTargetPhase(tab, 'error');
      fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
    }
    if (target && tab.target && targetFingerprint(tab.target) !== targetFingerprint(normalized)) {
      setTargetPhase(tab, 'error');
      fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
    }
    try {
      await tab.browser.request('target-recovery', {
        target: normalized,
        targetHash: targetFingerprint(normalized),
      }, 20_000, signal);
    } catch (error) {
      if (error?.code !== 'PURCHASE_BROWSER_COMMAND_INVALID') {
        setTargetPhase(tab, 'error');
        throw error;
      }
    }
    tab.target = normalized;
    clearPinduoduoAutoCapture(tab, { reset: true });
    tab.capturePreview = null;
    tab.captureResult = null;
    tab.purchaseContext = null;
    tab.session = sessions.updateSession(tab.session.sessionId, { target: normalized });
    setTargetPhase(tab, 'target-locked');
    emit('target-recovered', { tabId: tab.tabId });
    schedulePinduoduoAutoCapture(tab, 250);
    return {
      ok: true,
      target: normalized,
      targetHash: targetFingerprint(normalized),
      targetPhase: tab.targetPhase,
      state: snapshot(),
    };
  }

  async function capturePurchase(tabId, signal) {
    const tab = getTab(tabId);
    assertNotAborted(signal);
    setTargetPhase(tab, tab.target ? 'capturing' : 'target-selecting');
    let response;
    for (let attempt = 0; attempt <= CAPTURE_CONTEXT_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        response = await inspect(tab.tabId, signal);
        assertNotAborted(signal);
        break;
      } catch (error) {
        if (signal?.aborted) throw Object.assign(new Error('PURCHASE_BROWSER_COMMAND_CANCELLED'), { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
        if (!isTransientCaptureContextError(error) || attempt >= CAPTURE_CONTEXT_RETRY_DELAYS_MS.length) {
          setTargetPhase(tab, 'error');
          throw error;
        }
        appendLog(
          'desktop-main',
          `[purchase-browser] capture context retry tab=${tab.tabId} attempt=${attempt + 1}\n`,
        );
        await new Promise((resolve) => { setTimeout(resolve, CAPTURE_CONTEXT_RETRY_DELAYS_MS[attempt]); });
        assertNotAborted(signal);
      }
    }
    const inspection = response.inspection && typeof response.inspection === 'object'
      ? response.inspection
      : {};
    const capture = normalizePurchaseCapture({
      ...inspection,
      pageUrl: cleanOptionalText(inspection.pageUrl || tab.state.url, 1800),
      sourceUrl: cleanOptionalText(inspection.sourceUrl || inspection.pageUrl || tab.state.url, 1800),
      capturedAt: cleanOptionalText(inspection.capturedAt, 80) || new Date().toISOString(),
    });
    const hasEvidence = capture.fixture === true
      || capture.platform !== 'unknown'
      || Boolean(capture.productTitle || capture.purchaseOrderNumber || capture.trackingNumber)
      || Number.isFinite(capture.purchasePrice);
    if (!hasEvidence) {
      setTargetPhase(tab, 'error');
      fail('PURCHASE_BROWSER_CAPTURE_EMPTY');
    }
    if (tab.browserRole === 'product-link-parser' && capture.pageType !== 'product') {
      // A product parser can be made visible for diagnosis. If the operator
      // continues into SKU checkout, the old product graph can remain in the
      // SPA while the URL/page type is already checkout. Stop immediately;
      // treating this as an incomplete product would trigger the caller's
      // transient retry loop against a rapidly replacing payment frame.
      setTargetPhase(tab, 'error');
      fail('PURCHASE_BROWSER_PRODUCT_PAGE_REQUIRED');
    }
    if (tab.browserRole === 'product-link-parser' || capture.pageType === 'product') {
      const validation = validatePurchaseProductCapture(capture);
      if (!validation.accepted) {
        appendLog(
          'desktop-main',
          `[purchase-browser] product capture rejected tab=${tab.tabId} source=${capture.sourceMethod || 'none'} title=${capture.productTitle ? 1 : 0} images=${capture.mainImages?.length || 0} skus=${capture.skus?.length || 0} missing=${validation.missing.join(',')}\n`,
        );
        setTargetPhase(tab, 'error');
        fail('PURCHASE_BROWSER_PRODUCT_CAPTURE_INCOMPLETE');
      }
    }
    setTargetPhase(tab, tab.target ? 'target-locked' : 'target-selecting');
    return {
      ok: true,
      capture,
      target: tab.target || null,
      canCommit: Boolean(tab.target),
      targetPhase: tab.targetPhase,
      state: snapshot(),
    };
  }

  async function capturePreview(tabId, signal) {
    const tab = getTab(tabId);
    assertNotAborted(signal);
    // A new inspection must never leave an older preview eligible for
    // confirmation if the page or product has changed underneath it.
    tab.capturePreview = null;
    tab.captureResult = null;
    let captured;
    try {
      captured = await capturePurchase(tab.tabId, signal);
      assertNotAborted(signal);
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('PURCHASE_BROWSER_COMMAND_CANCELLED'), { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
      setTargetPhase(tab, 'error');
      throw error;
    }
    if (!tab.target) {
      setTargetPhase(tab, 'target-selecting');
      return {
        ...captured,
        preview: null,
        canCommit: false,
        code: 'PURCHASE_BROWSER_TARGET_REQUIRED',
        targetPhase: tab.targetPhase,
      };
    }
    if (typeof localApiClient.previewPurchaseCapture !== 'function') {
      setTargetPhase(tab, 'error');
      fail('PURCHASE_BROWSER_CAPTURE_SERVICE_UNAVAILABLE');
    }
    let preview;
    try {
      preview = await localApiClient.previewPurchaseCapture({
        target: tab.target,
        capture: captured.capture,
      }, { signal });
      assertNotAborted(signal);
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('PURCHASE_BROWSER_COMMAND_CANCELLED'), { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
      setTargetPhase(tab, 'error');
      throw error;
    }
    if (!preview || typeof preview !== 'object' || !preview.previewId) {
      setTargetPhase(tab, 'error');
      fail('PURCHASE_BROWSER_CAPTURE_SERVICE_UNAVAILABLE');
    }
    tab.capturePreview = preview;
    tab.captureResult = captured.capture;
    setTargetPhase(tab, 'capture-preview');
    emit('capture-preview', { tabId: tab.tabId });
    return { ...captured, preview, canCommit: true, state: snapshot() };
  }

  async function captureConfirm({ tabId, confirmationToken, acceptConflicts = false, signal } = {}) {
    const tab = getTab(tabId);
    assertNotAborted(signal);
    const preview = tab.capturePreview;
    if (!preview || !tab.target) {
      setTargetPhase(tab, 'error');
      fail('PURCHASE_BROWSER_CONFIRMATION_REQUIRED');
    }
    if (preview.target && targetFingerprint(preview.target) !== targetFingerprint(tab.target)) {
      setTargetPhase(tab, 'error');
      fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
    }
    if (!requiredText(confirmationToken, 'PURCHASE_BROWSER_CONFIRMATION_REQUIRED', 300)) {
      setTargetPhase(tab, 'error');
      fail('PURCHASE_BROWSER_CONFIRMATION_REQUIRED');
    }
    if (typeof localApiClient.confirmPurchaseCapture !== 'function') {
      setTargetPhase(tab, 'error');
      fail('PURCHASE_BROWSER_CAPTURE_SERVICE_UNAVAILABLE');
    }
    setTargetPhase(tab, 'confirming');
    let result;
    try {
      setTargetPhase(tab, 'saving');
      result = await localApiClient.confirmPurchaseCapture({
        previewId: preview.previewId,
        idempotencyKey: preview.idempotencyKey || preview.previewId,
        confirmationToken,
        captureHash: preview.captureHash,
        target: tab.target,
        acceptConflicts: acceptConflicts === true,
      }, { signal });
      assertNotAborted(signal);
      setTargetPhase(tab, 'readback');
      if (result?.readbackVerified !== true) fail('PURCHASE_BROWSER_READBACK_FAILED');
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('PURCHASE_BROWSER_COMMAND_CANCELLED'), { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
      setTargetPhase(tab, 'error');
      throw error;
    }
    tab.purchaseContext = {
      purchaseOrderNumber: cleanOptionalText(result.readback?.override?.purchaseOrderNumber, 260),
      purchasePlatform: cleanOptionalText(result.readback?.override?.purchasePlatform, 80),
      purchaseOrderUrl: cleanOptionalText(result.readback?.override?.purchaseOrderUrl, 1800),
      purchaseOrderStatus: cleanOptionalText(
        result.readback?.override?.manualStatus || result.readback?.override?.purchaseOrderStatus,
        160,
      ),
      sourceCostCny: result.readback?.override?.sourceCostCny ?? null,
      trackingNumber: cleanOptionalText(tab.captureResult?.trackingNumber, 260),
      carrierName: cleanOptionalText(tab.captureResult?.carrierName, 120),
    };
    tab.capturePreview = null;
    tab.captureResult = null;
    setTargetPhase(tab, 'completed');
    emit('capture-complete', { tabId: tab.tabId });
    return {
      ok: true,
      capture: preview.after,
      result,
      targetPhase: tab.targetPhase,
      state: snapshot(),
    };
  }

  async function captureMarketplaceOrder({ tabId, operation = 'read-payment-info', signal } = {}) {
    const tab = getTab(tabId);
    assertNotAborted(signal);
    if (!tab.target) fail('PURCHASE_BROWSER_TARGET_REQUIRED');
    const pagePlatform = purchasePlatformFromUrl(tab.state?.url);
    if (!pagePlatform) fail('PURCHASE_BROWSER_ORDER_PAGE_REQUIRED');
    if (
      typeof localApiClient.readbackPurchaseCapture !== 'function'
      || typeof localApiClient.previewPurchaseCapture !== 'function'
      || typeof localApiClient.confirmPurchaseCapture !== 'function'
    ) fail('PURCHASE_BROWSER_CAPTURE_SERVICE_UNAVAILABLE');
    const mode = operation === 'refresh-order-status' ? 'refresh-order-status' : 'read-payment-info';
    const target = tab.target;
    const targetHash = targetFingerprint(target);
    tab.pendingPurchaseCapture = null;
    setTargetPhase(tab, 'capturing');
    try {
      const existing = await localApiClient.readbackPurchaseCapture(target, { signal });
      assertNotAborted(signal);
      const override = existing?.override || {};
      const overrideVoided = purchaseOverrideIsVoided(override);
      const sourceLinks = Array.isArray(existing?.sourceLinks) ? existing.sourceLinks : [];
      const targetProductKeys = new Set([target.sku, target.offerId]
        .map((value) => cleanOptionalText(value, 260))
        .filter(Boolean));
      const sourceLink = sourceLinks.find((row) => {
        const rowKey = cleanOptionalText(row?.productKey || row?.offerId || row?.sku, 260);
        return !targetProductKeys.size || targetProductKeys.has(rowKey);
      }) || sourceLinks[0] || {};
      // A retained source link is sourcing evidence, not an active purchase.
      // Refunded/voided purchases must never be rebound from that historical row.
      const boundPlatform = overrideVoided ? '' : cleanOptionalText(override.purchasePlatform, 80);
      const boundOrderNumber = overrideVoided ? '' : cleanOptionalText(override.purchaseOrderNumber, 260);
      if (mode === 'refresh-order-status' && (!boundPlatform || !boundOrderNumber)) {
        fail('PURCHASE_BROWSER_ORDER_NOT_BOUND');
      }
      if (mode === 'refresh-order-status' && boundPlatform !== pagePlatform) {
        fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
      }

      const nativeCommand = pagePlatform === '1688'
        ? 'inspect-1688-order'
        : pagePlatform === '拼多多' ? 'inspect-pinduoduo-order' : 'capture-purchase';
      const raw = await tab.browser.request(nativeCommand, {}, pagePlatform === '1688' ? 32_000 : 20_000, signal);
      assertNotAborted(signal);
      if (!tabs.has(tab.tabId) || targetFingerprint(tab.target) !== targetHash) {
        fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
      }
      const inspection = normalizePurchaseCapture(raw && typeof raw === 'object' ? raw : {});
      if (inspection.platform !== pagePlatform) fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');

      const samePlatformSourceUrl = purchasePlatformFromUrl(sourceLink.url) === pagePlatform
        ? cleanOptionalText(sourceLink.url, 1800)
        : '';
      let selected;
      if (pagePlatform === '1688') {
        const visibleOrderNumber = cleanOptionalText(inspection.currentOrderNumber, 260);
        selected = selectAlibaba1688OrderCandidate(inspection, {
          expectedOrderNumber: mode === 'refresh-order-status'
            ? boundOrderNumber
            : visibleOrderNumber || (boundPlatform === '1688' ? boundOrderNumber : ''),
          expectedSourceUrl: samePlatformSourceUrl,
          targetProductTitle: target.productTitle,
          targetQuantity: target.quantity,
        });
        selected = Object.freeze({
          ...selected,
          ...readAlibaba1688SourceRecord(selected),
        });
      } else {
        if (inspection.pageType !== 'order-detail') fail('PURCHASE_BROWSER_ORDER_PAGE_REQUIRED');
        const captureProductId = cleanOptionalText(inspection.sourceProductId, 260)
          || purchaseSourceProductId(inspection.sourceUrl);
        const expectedProductId = purchaseSourceProductId(samePlatformSourceUrl);
        if (captureProductId && expectedProductId && captureProductId !== expectedProductId) {
          fail('PURCHASE_BROWSER_ORDER_NOT_FOUND');
        }
        const capturedTitle = cleanOptionalText(inspection.productTitle, 600);
        const targetTitle = cleanOptionalText(target.productTitle, 600);
        if (capturedTitle && targetTitle && purchaseTitleSimilarity(capturedTitle, targetTitle) < 0.34) {
          fail('PURCHASE_BROWSER_ORDER_NOT_FOUND');
        }
        const expectedQuantity = Number(target.quantity);
        const capturedQuantity = Number(inspection.quantity);
        if (
          Number.isFinite(expectedQuantity) && expectedQuantity > 0
          && Number.isFinite(capturedQuantity) && capturedQuantity > 0
          && expectedQuantity !== capturedQuantity
        ) fail('PURCHASE_BROWSER_ORDER_NOT_FOUND');
        selected = inspection;
      }

      const selectedPrice = Number(selected.purchasePrice);
      const boundPrice = boundPlatform === pagePlatform && boundOrderNumber
        ? Number(override.sourceCostCny)
        : Number.NaN;
      const purchasePrice = Number.isFinite(selectedPrice) && selectedPrice > 0
        ? selectedPrice
        : mode === 'refresh-order-status' && Number.isFinite(boundPrice) && boundPrice > 0
          ? boundPrice
          : Number.NaN;
      const capture = normalizePurchaseCapture({
        ...selected,
        platform: pagePlatform,
        sourceUrl: selected.sourceUrl || samePlatformSourceUrl || selected.pageUrl,
        purchaseOrderUrl: selected.purchaseOrderUrl || selected.pageUrl,
        purchasePrice,
        amount: Number.isFinite(purchasePrice) ? String(purchasePrice) : '',
      });
      const orderNumber = cleanOptionalText(capture.purchaseOrderNumber, 260);
      const orderStatus = cleanOptionalText(capture.purchaseOrderStatus || capture.status, 160);
      if (!orderNumber || !orderStatus || !Number.isFinite(purchasePrice) || purchasePrice <= 0) {
        fail('PURCHASE_BROWSER_ORDER_INCOMPLETE');
      }
      if (mode === 'refresh-order-status' && orderNumber !== boundOrderNumber) {
        fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
      }

      const refundConfirmed = capture.refundConfirmed === true || isConfirmedPurchaseRefundStatus(orderStatus);
      if (refundConfirmed) {
        if (mode !== 'refresh-order-status') fail('PURCHASE_BROWSER_PAYMENT_NOT_CONFIRMED');
        if (
          typeof localApiClient.previewPurchaseRefund !== 'function'
          || typeof localApiClient.confirmPurchaseRefund !== 'function'
        ) fail('PURCHASE_BROWSER_CAPTURE_SERVICE_UNAVAILABLE');
        const refundKey = sha256(JSON.stringify([targetHash, pagePlatform, orderNumber, orderStatus, 'refund']));
        const refundCapture = {
          platform: pagePlatform,
          purchaseOrderNumber: orderNumber,
          purchaseOrderStatus: orderStatus,
          purchaseOrderUrl: capture.purchaseOrderUrl || capture.pageUrl,
          capturedAt: capture.capturedAt,
        };
        const preview = await localApiClient.previewPurchaseRefund({
          target,
          capture: refundCapture,
          idempotencyKey: `purchase_refund_${refundKey}`,
        }, { signal });
        assertNotAborted(signal);
        if (!tabs.has(tab.tabId) || targetFingerprint(tab.target) !== targetHash) {
          fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
        }
        const missingFields = Array.isArray(preview?.missingFields) ? preview.missingFields : [];
        if (missingFields.length) fail('PURCHASE_BROWSER_CAPTURE_FIELDS_MISSING');
        setTargetPhase(tab, 'capture-preview');
        setTargetPhase(tab, 'confirming');
        setTargetPhase(tab, 'saving');
        const result = await localApiClient.confirmPurchaseRefund({
          previewId: preview.previewId,
          idempotencyKey: preview.idempotencyKey || `purchase_refund_${refundKey}`,
          confirmationToken: preview.confirmationToken,
          captureHash: preview.captureHash,
          target,
        }, { signal });
        assertNotAborted(signal);
        setTargetPhase(tab, 'readback');
        if (result?.readbackVerified !== true) fail('PURCHASE_BROWSER_READBACK_FAILED');
        const readbackOverride = result.readback?.override || {};
        if (
          cleanOptionalText(readbackOverride.purchaseOrderNumber, 260)
          || cleanOptionalText(readbackOverride.purchasePlatform, 80)
          || (
            readbackOverride.sourceCostCny !== null
            && readbackOverride.sourceCostCny !== undefined
            && String(readbackOverride.sourceCostCny).trim() !== ''
            && Number.isFinite(Number(readbackOverride.sourceCostCny))
          )
        ) fail('PURCHASE_BROWSER_READBACK_FAILED');
        tab.purchaseContext = null;
        setTargetPhase(tab, 'completed');
        const payload = {
          tabId: tab.tabId,
          operation: mode,
          target,
          capture: refundCapture,
          purchaseContext: null,
          readback: result.readback,
          readbackVerified: true,
          refunded: true,
        };
        emit('purchase-order-refund-captured', payload);
        appendLog(
          'desktop-main',
          `[purchase-browser] ${pagePlatform} manual refund captured tab=${tab.tabId} target=${targetHash.slice(0, 12)} order=${sha256(orderNumber).slice(0, 12)}\n`,
        );
        return { ok: true, ...payload, targetPhase: tab.targetPhase, state: snapshot() };
      }

      if (
        mode === 'read-payment-info'
        && !(capture.paymentConfirmed === true || isConfirmedPurchaseOrderStatus(orderStatus))
      ) fail('PURCHASE_BROWSER_PAYMENT_NOT_CONFIRMED');
      const captureKey = sha256(JSON.stringify([
        targetHash, pagePlatform, mode, orderNumber, purchasePrice, orderStatus,
      ]));
      const preview = await localApiClient.previewPurchaseCapture({
        target,
        capture,
        idempotencyKey: `purchase_manual_${captureKey}`,
      }, { signal });
      assertNotAborted(signal);
      if (!tabs.has(tab.tabId) || targetFingerprint(tab.target) !== targetHash) {
        fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
      }
      const missingFields = Array.isArray(preview?.missingFields) ? preview.missingFields : [];
      if (missingFields.length) fail('PURCHASE_BROWSER_CAPTURE_FIELDS_MISSING');
      const conflicts = Array.isArray(preview?.conflicts) ? preview.conflicts : [];
      setTargetPhase(tab, 'capture-preview');
      const pendingPurchaseContext = {
        purchaseOrderNumber: orderNumber,
        purchasePlatform: pagePlatform,
        purchaseOrderUrl: cleanOptionalText(capture.purchaseOrderUrl || capture.pageUrl, 1800),
        purchaseOrderStatus: orderStatus,
        sourceCostCny: purchasePrice,
        productTitle: cleanOptionalText(capture.productTitle, 600),
        quantity: capture.quantity ?? null,
      };
      // The fast native order reader remains read-only.  Once its 1688 order
      // line has been matched to a canonical offer and the local preview has
      // no conflicts, persist the purchase + source link in the same command.
      // Conflicting existing data deliberately falls through to the existing
      // manual Save action so nothing is overwritten without confirmation.
      if (pagePlatform === '1688' && mode === 'read-payment-info' && conflicts.length === 0) {
        setTargetPhase(tab, 'confirming');
        setTargetPhase(tab, 'saving');
        const result = await localApiClient.confirmPurchaseCapture({
          previewId: preview.previewId,
          idempotencyKey: preview.idempotencyKey || `purchase_manual_${captureKey}`,
          confirmationToken: preview.confirmationToken,
          captureHash: preview.captureHash,
          target,
          acceptConflicts: false,
        }, { signal });
        assertNotAborted(signal);
        setTargetPhase(tab, 'readback');
        if (result?.readbackVerified !== true) fail('PURCHASE_BROWSER_READBACK_FAILED');
        if (!tabs.has(tab.tabId) || targetFingerprint(tab.target) !== targetHash) {
          fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
        }
        const readbackOverride = result.readback?.override || {};
        const readbackOrderNumber = cleanOptionalText(readbackOverride.purchaseOrderNumber, 260);
        const readbackPlatform = cleanOptionalText(readbackOverride.purchasePlatform, 80);
        const canonicalSourceUrl = cleanOptionalText(capture.sourceUrl, 1800);
        const sourceLinkSaved = (Array.isArray(result.readback?.sourceLinks)
          ? result.readback.sourceLinks
          : []).some((row) => cleanOptionalText(row?.url, 1800) === canonicalSourceUrl);
        if (
          readbackOrderNumber !== orderNumber
          || readbackPlatform !== pagePlatform
          || !canonicalSourceUrl
          || !sourceLinkSaved
        ) fail('PURCHASE_BROWSER_READBACK_FAILED');
        tab.purchaseContext = {
          purchaseOrderNumber: readbackOrderNumber,
          purchasePlatform: readbackPlatform,
          purchaseOrderUrl: cleanOptionalText(
            readbackOverride.purchaseOrderUrl || capture.purchaseOrderUrl || capture.pageUrl,
            1800,
          ),
          purchaseOrderStatus: cleanOptionalText(
            readbackOverride.manualStatus || readbackOverride.purchaseOrderStatus || orderStatus,
            160,
          ),
          sourceCostCny: readbackOverride.sourceCostCny ?? purchasePrice,
          productTitle: pendingPurchaseContext.productTitle,
          quantity: pendingPurchaseContext.quantity,
        };
        tab.pendingPurchaseCapture = null;
        setTargetPhase(tab, 'completed');
        const payload = {
          tabId: tab.tabId,
          operation: mode,
          target,
          capture: {
            platform: tab.purchaseContext.purchasePlatform,
            purchaseOrderNumber: tab.purchaseContext.purchaseOrderNumber,
            purchaseOrderUrl: tab.purchaseContext.purchaseOrderUrl,
            purchaseOrderStatus: tab.purchaseContext.purchaseOrderStatus,
            purchasePrice: tab.purchaseContext.sourceCostCny,
            productTitle: tab.purchaseContext.productTitle,
            quantity: tab.purchaseContext.quantity,
            sourceUrl: canonicalSourceUrl,
            sourceProductId: cleanOptionalText(capture.sourceProductId, 260),
            sourceMethod: cleanOptionalText(capture.sourceMethod, 80),
            capturedAt: capture.capturedAt,
          },
          purchaseContext: { ...tab.purchaseContext },
          readback: result.readback,
          captureVerified: true,
          pendingSave: false,
          readbackVerified: true,
        };
        appendLog(
          'desktop-main',
          `[purchase-browser] 1688 payment and source auto-saved tab=${tab.tabId} target=${targetHash.slice(0, 12)} order=${sha256(orderNumber).slice(0, 12)} offer=${sha256(capture.sourceProductId).slice(0, 12)}\n`,
        );
        return { ok: true, ...payload, targetPhase: tab.targetPhase, state: snapshot() };
      }
      tab.pendingPurchaseCapture = {
        targetHash,
        target,
        pagePlatform,
        mode,
        orderNumber,
        orderStatus,
        purchasePrice,
        capture,
        captureKey,
        preview,
        purchaseContext: pendingPurchaseContext,
      };
      const payload = {
        tabId: tab.tabId,
        operation: mode,
        target,
        capture: {
          platform: pendingPurchaseContext.purchasePlatform,
          purchaseOrderNumber: pendingPurchaseContext.purchaseOrderNumber,
          purchaseOrderUrl: pendingPurchaseContext.purchaseOrderUrl,
          purchaseOrderStatus: pendingPurchaseContext.purchaseOrderStatus,
          purchasePrice: pendingPurchaseContext.sourceCostCny,
          productTitle: pendingPurchaseContext.productTitle,
          quantity: pendingPurchaseContext.quantity,
          capturedAt: capture.capturedAt,
        },
        purchaseContext: { ...pendingPurchaseContext },
        captureVerified: true,
        pendingSave: true,
        readbackVerified: false,
      };
      appendLog(
        'desktop-main',
        `[purchase-browser] ${pagePlatform} ${mode} previewed tab=${tab.tabId} target=${targetHash.slice(0, 12)} order=${sha256(orderNumber).slice(0, 12)}\n`,
      );
      return { ok: true, ...payload, targetPhase: tab.targetPhase, state: snapshot() };
    } catch (error) {
      if (signal?.aborted) {
        throw Object.assign(new Error('PURCHASE_BROWSER_COMMAND_CANCELLED'), { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
      }
      setTargetPhase(tab, 'error');
      throw error;
    }
  }

  async function readMarketplaceOrderReadonly({ tabId, expectedOrderNumber = '', signal } = {}) {
    const tab = getTab(tabId);
    assertNotAborted(signal);
    const orderNumber = cleanOptionalText(expectedOrderNumber, 260);
    if (!orderNumber || !/^[A-Za-z0-9._:@/+\-=]{5,120}$/u.test(orderNumber)) {
      fail('PURCHASE_BROWSER_ORDER_NUMBER_REQUIRED');
    }
    const pagePlatform = purchasePlatformFromUrl(tab.state?.url);
    if (!['1688', '淘宝', '天猫', '拼多多'].includes(pagePlatform)) {
      fail('PURCHASE_BROWSER_ORDER_PAGE_REQUIRED');
    }
    const nativeCommand = pagePlatform === '1688'
      ? 'inspect-1688-order'
      : pagePlatform === '拼多多' ? 'inspect-pinduoduo-order' : 'capture-purchase';
    const raw = await tab.browser.request(
      nativeCommand,
      {},
      pagePlatform === '1688' ? 32_000 : 20_000,
      signal,
    );
    assertNotAborted(signal);
    const inspection = normalizePurchaseCapture(raw && typeof raw === 'object' ? raw : {});
    const selected = pagePlatform === '1688'
      ? selectAlibaba1688OrderCandidate(inspection, { expectedOrderNumber: orderNumber })
      : inspection;
    const capture = normalizePurchaseCapture({
      ...selected,
      platform: pagePlatform,
      pageUrl: cleanOptionalText(selected.pageUrl || tab.state?.url, 1800),
      purchaseOrderUrl: cleanOptionalText(
        selected.purchaseOrderUrl || selected.pageUrl || tab.state?.url,
        1800,
      ),
    });
    const capturedOrderNumber = cleanOptionalText(capture.purchaseOrderNumber, 260);
    const purchaseOrderStatus = cleanOptionalText(capture.purchaseOrderStatus || capture.status, 160);
    const purchasePrice = Number(capture.purchasePrice);
    if (capture.platform !== pagePlatform || capturedOrderNumber !== orderNumber) {
      fail('PURCHASE_BROWSER_ORDER_NOT_FOUND');
    }
    if (!purchaseOrderStatus || !Number.isFinite(purchasePrice) || purchasePrice <= 0) {
      fail('PURCHASE_BROWSER_ORDER_INCOMPLETE');
    }
    return {
      ok: true,
      readonly: true,
      pluginVerified: true,
      capture: {
        platform: pagePlatform,
        purchaseOrderNumber: capturedOrderNumber,
        purchaseOrderUrl: capture.purchaseOrderUrl,
        purchaseOrderStatus,
        purchasePrice,
        currency: cleanOptionalText(capture.currency, 12) || 'CNY',
        productTitle: cleanOptionalText(capture.productTitle, 600),
        quantity: capture.quantity ?? null,
        paymentConfirmed: capture.paymentConfirmed === true,
        refundConfirmed: capture.refundConfirmed === true,
        capturedAt: cleanOptionalText(capture.capturedAt, 80) || new Date().toISOString(),
      },
      state: snapshot(),
    };
  }

  async function saveMarketplaceOrder({ tabId, signal } = {}) {
    const tab = getTab(tabId);
    assertNotAborted(signal);
    if (!tab.target) fail('PURCHASE_BROWSER_TARGET_REQUIRED');
    const pending = tab.pendingPurchaseCapture;
    if (!pending?.preview || !pending?.purchaseContext) fail('PURCHASE_BROWSER_CAPTURE_PREVIEW_REQUIRED');
    const targetHash = targetFingerprint(tab.target);
    if (pending.targetHash !== targetHash) fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
    if (tab.targetPhase === 'error') setTargetPhase(tab, 'capture-preview');
    setTargetPhase(tab, 'confirming');
    try {
      setTargetPhase(tab, 'saving');
      const result = await localApiClient.confirmPurchaseCapture({
        previewId: pending.preview.previewId,
        idempotencyKey: pending.preview.idempotencyKey || `purchase_manual_${pending.captureKey}`,
        confirmationToken: pending.preview.confirmationToken,
        captureHash: pending.preview.captureHash,
        target: pending.target,
        acceptConflicts: true,
      }, { signal });
      assertNotAborted(signal);
      setTargetPhase(tab, 'readback');
      if (result?.readbackVerified !== true) fail('PURCHASE_BROWSER_READBACK_FAILED');
      if (!tabs.has(tab.tabId) || targetFingerprint(tab.target) !== targetHash) {
        fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
      }
      const readbackOverride = result.readback?.override || {};
      const readbackOrderNumber = cleanOptionalText(readbackOverride.purchaseOrderNumber, 260);
      const readbackPlatform = cleanOptionalText(readbackOverride.purchasePlatform, 80);
      if (readbackOrderNumber !== pending.orderNumber || readbackPlatform !== pending.pagePlatform) {
        fail('PURCHASE_BROWSER_READBACK_FAILED');
      }
      tab.purchaseContext = {
        purchaseOrderNumber: readbackOrderNumber,
        purchasePlatform: readbackPlatform,
        purchaseOrderUrl: cleanOptionalText(
          readbackOverride.purchaseOrderUrl || pending.capture.purchaseOrderUrl || pending.capture.pageUrl,
          1800,
        ),
        purchaseOrderStatus: cleanOptionalText(
          readbackOverride.manualStatus || readbackOverride.purchaseOrderStatus || pending.orderStatus,
          160,
        ),
        sourceCostCny: readbackOverride.sourceCostCny ?? pending.purchasePrice,
        productTitle: cleanOptionalText(pending.capture.productTitle, 600),
        quantity: pending.capture.quantity ?? null,
      };
      tab.pendingPurchaseCapture = null;
      setTargetPhase(tab, 'completed');
      const payload = {
        tabId: tab.tabId,
        operation: 'save-payment-info',
        sourceOperation: pending.mode,
        target: pending.target,
        capture: {
          platform: tab.purchaseContext.purchasePlatform,
          purchaseOrderNumber: tab.purchaseContext.purchaseOrderNumber,
          purchaseOrderUrl: tab.purchaseContext.purchaseOrderUrl,
          purchaseOrderStatus: tab.purchaseContext.purchaseOrderStatus,
          purchasePrice: tab.purchaseContext.sourceCostCny,
          productTitle: tab.purchaseContext.productTitle,
          quantity: tab.purchaseContext.quantity,
          capturedAt: pending.capture.capturedAt,
        },
        purchaseContext: { ...tab.purchaseContext },
        readback: result.readback,
        captureVerified: true,
        pendingSave: false,
        readbackVerified: true,
      };
      emit('purchase-order-manual-captured', payload);
      appendLog(
        'desktop-main',
        `[purchase-browser] ${pending.pagePlatform} saved tab=${tab.tabId} target=${targetHash.slice(0, 12)} order=${sha256(pending.orderNumber).slice(0, 12)}\n`,
      );
      return { ok: true, ...payload, targetPhase: tab.targetPhase, state: snapshot() };
    } catch (error) {
      if (signal?.aborted) {
        throw Object.assign(new Error('PURCHASE_BROWSER_COMMAND_CANCELLED'), { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
      }
      setTargetPhase(tab, 'error');
      throw error;
    }
  }

  async function getPurchaseContext(tabId) {
    const tab = getTab(tabId);
    if (!tab.target) fail('PURCHASE_BROWSER_TARGET_REQUIRED');
    if (tab.purchaseContext?.purchaseOrderNumber) {
      return { ok: true, context: tab.purchaseContext, target: tab.target, state: snapshot() };
    }
    if (typeof localApiClient.readbackPurchaseCapture !== 'function') {
      fail('PURCHASE_BROWSER_CAPTURE_SERVICE_UNAVAILABLE');
    }
    const readback = await localApiClient.readbackPurchaseCapture(tab.target);
    const override = readback?.override || {};
    const voided = purchaseOverrideIsVoided(override);
    tab.purchaseContext = {
      purchaseOrderNumber: voided ? '' : cleanOptionalText(override.purchaseOrderNumber, 260),
      purchasePlatform: voided ? '' : cleanOptionalText(override.purchasePlatform, 80),
      purchaseOrderUrl: voided ? '' : cleanOptionalText(override.purchaseOrderUrl, 1800),
      purchaseOrderStatus: voided ? '' : cleanOptionalText(override.manualStatus || override.purchaseOrderStatus, 160),
      sourceCostCny: voided ? null : override.sourceCostCny ?? null,
      trackingNumber: '',
      carrierName: '',
    };
    if (!tab.purchaseContext.purchaseOrderNumber) fail('CROSS_BORDER_PACKAGE_CONTEXT_MISSING');
    return { ok: true, context: tab.purchaseContext, target: tab.target, state: snapshot() };
  }

  async function health(tabId) {
    const tab = getTab(tabId);
    const result = typeof cefRuntime.health === 'function'
      ? await cefRuntime.health(tab.profile.ownerRef)
      : { ok: !tab.state.crashed, health: tab.state.crashed ? 'unhealthy' : 'healthy' };
    if (sessions.isCurrent(tab.session.sessionId, tab.session.generation)) {
      tab.session = sessions.updateSession(tab.session.sessionId, {
        health: result.health || (result.ok ? 'healthy' : 'unhealthy'),
      });
    }
    return { ok: result.ok === true, health: result, state: snapshot() };
  }

  async function forceClose(tabId, { skipVisibility = false } = {}) {
    const tab = tabs.get(String(tabId || ''));
    if (!tab) return snapshot();
    clearPinduoduoAutoCapture(tab, { reset: true });
    tab.session = sessions.invalidate(tab.session.sessionId, 'closing') || tab.session;
    // A forced close is also a lifecycle fence for any in-flight purchase
    // attempt. Do not let account bookkeeping keep the visible close path
    // waiting for a Sidecar that may already be unresponsive.
    void failActiveAttempt(tab, 'PURCHASE_BROWSER_TAB_CLOSED').catch(() => undefined);
    tab.removeListener?.();
    tabs.delete(tab.tabId);
    cefRuntime.invalidate?.(tab.profile.ownerRef, 'PURCHASE_BROWSER_SESSION_STALE');
    cefRuntime.forceTerminate?.(tab.profile.ownerRef);
    sessions.removeSession(tab.session.sessionId);
    if (activeTabId === tab.tabId) activeTabId = firstInteractiveTabId();
    if (!skipVisibility) await applyVisibility().catch(() => undefined);
    emit('closed', { tabId: tab.tabId, forced: true });
    return snapshot();
  }

  let closeInteractiveTabsPromise = null;
  async function closeInteractiveTabs() {
    if (closeInteractiveTabsPromise) return closeInteractiveTabsPromise;
    closeInteractiveTabsPromise = (async () => {
      visibilityVersion += 1;
      hiddenIntentVersion += 1;
      visibilityChain = Promise.resolve();
      viewport = { ...viewport, visible: false };
      activeTabId = '';
      // The window close entry point bypasses dispatch, and a CEF launch may
      // not have registered its tab yet. Cancel only explicitly interactive
      // opens/prewarms; background collectors and purchase submissions keep
      // their existing command semantics.
      commandQueue.cancelMatching(({ name, scope }) => (
        ['open', 'prewarm'].includes(name)
        && scope?.browserRole === PURCHASE_BROWSER_ROLES.INTERACTIVE
      ));
      const interactiveTabIds = [...tabs.values()]
        .filter((tab) => tab.background !== true)
        .map((tab) => tab.tabId);
      await Promise.allSettled(interactiveTabIds.map(
        (tabId) => forceClose(tabId, { skipVisibility: true }),
      ));
      await applyVisibility().catch(() => undefined);
      return snapshot();
    })().finally(() => {
      closeInteractiveTabsPromise = null;
    });
    return closeInteractiveTabsPromise;
  }

  let forceCloseAllPromise = null;
  async function forceCloseAll() {
    if (forceCloseAllPromise) return forceCloseAllPromise;
    forceCloseAllPromise = (async () => {
      // A normal navigation/物流 command can be waiting inside the CEF host and
      // therefore cannot receive a Sidecar hide message yet. Cancel the
      // queue first, then kill the owned process tree directly. This is the
      // close path used by the user-facing browser X/关闭按钮.
      commandQueue.cancelPending('PURCHASE_BROWSER_COMMAND_CANCELLED');
      commandQueue.cancelActive('PURCHASE_BROWSER_COMMAND_CANCELLED');
      productLinkCommandQueue.cancelPending('PURCHASE_BROWSER_COMMAND_CANCELLED');
      productLinkCommandQueue.cancelActive('PURCHASE_BROWSER_COMMAND_CANCELLED');
      followSellerCommandQueue.cancelPending('PURCHASE_BROWSER_COMMAND_CANCELLED');
      followSellerCommandQueue.cancelActive('PURCHASE_BROWSER_COMMAND_CANCELLED');
      visibilityVersion += 1;
      hiddenIntentVersion += 1;
      // Do not inherit a bounds request that is blocked behind the same
      // unresponsive Sidecar. Its rejection is already fenced; new lifecycle
      // work must start from a resolved chain.
      visibilityChain = Promise.resolve();
      viewport = { ...viewport, visible: false };
      const tabIds = [...tabs.keys()];
      const operations = tabIds.map((tabId) => forceClose(tabId, { skipVisibility: true }).catch(() => undefined));
      // A launch can create a runtime session before its tab is registered.
      // The runtime-level sweep closes that orphan as well.
      try { await cefRuntime.forceTerminateAll?.(); } catch { /* best effort */ }
      await Promise.allSettled(operations);
      try { await cefRuntime.forceTerminateAll?.(); } catch { /* best effort */ }
      return snapshot();
    })().finally(() => {
      forceCloseAllPromise = null;
    });
    return forceCloseAllPromise;
  }

  async function executeTask({ tabId, taskId, executionCapability } = {}) {
    const tab = getTab(tabId);
    if (tab.addonState.installState !== 'active') fail('PURCHASE_BROWSER_EXTENSION_NOT_VERIFIED');
    const loaded = await localApiClient.getTask(taskId);
    const task = loaded.task;
    if (task?.ownerId !== tab.binding.accountId) fail('PURCHASE_BROWSER_TASK_OWNER_MISMATCH');
    const target = policy.classifyUrl(task?.preview?.targetUrl);
    if (!target.allowed || target.kind !== 'fixture') fail('PURCHASE_BROWSER_REAL_SITE_EXECUTION_DISABLED');
    tab.state = { ...tab.state, ...(await tab.browser.request('navigate', { url: target.url })) };
    const inspection = await tab.browser.request('inspect');
    if (inspection?.fixture !== true) fail('PURCHASE_BROWSER_FIXTURE_REQUIRED');
    let attemptId = '';
    try {
      const claimed = await localApiClient.claimTask(taskId, executionCapability);
      attemptId = requiredText(claimed.attemptId, 'PURCHASE_BROWSER_ATTEMPT_ID_REQUIRED', 160);
      tab.activeAttempt = { taskId, attemptId };
      const submitted = canonicalReceipt(await tab.browser.request('execute', {
        task: {
          taskId,
          attemptId,
          productTitle: task.preview.productTitle,
          variant: task.preview.variant,
          quantity: task.preview.quantity,
          address: task.preview.address,
          expectedAmount: task.preview.expectedAmount,
        },
      }, 20_000));
      const readback = await tab.browser.request('inspect');
      const receipt = canonicalReceipt(readback);
      if (JSON.stringify(receipt) !== JSON.stringify(submitted)) fail('PURCHASE_BROWSER_WEBSITE_READBACK_MISMATCH');
      const receiptHash = sha256(JSON.stringify(receipt));
      const websiteReadbackHash = sha256(JSON.stringify({ taskId, attemptId, receipt, fixture: true }));
      const completed = await localApiClient.completeTask(taskId, {
        attemptId,
        receipt,
        receiptHash,
        websiteReadbackVerified: true,
        websiteReadbackHash,
      });
      tab.activeAttempt = null;
      emit('task-completed', { tabId: tab.tabId, taskId });
      return { ok: true, task: completed.task, state: snapshot() };
    } catch (error) {
      if (attemptId && tab.activeAttempt?.attemptId === attemptId) {
        await failActiveAttempt(tab, sanitizedErrorCode(error)).catch(() => undefined);
      }
      throw error;
    }
  }

  async function approveDownload({ tabId, url } = {}) {
    const tab = getTab(tabId);
    const target = policy.classifyUrl(url);
    if (!target.allowed || !policy.canDownload({ url, userApproved: true })) {
      fail('PURCHASE_BROWSER_DOWNLOAD_URL_FORBIDDEN');
    }
    await tab.browser.request('approve-download', { url: target.url });
    return { ok: true };
  }

  function createRemovalProof({ ownerRef, resourceIds, storagePath, receiptBinding }) {
    const runtimeOwnerRefs = [
      ownerRef,
      marketCollectorOwnerRef(ownerRef),
      followSellerCollectorOwnerRef(ownerRef),
      productLinkParserOwnerRef(ownerRef),
    ];
    const downloadDirectories = runtimeOwnerRefs.map((runtimeOwnerRef) => path.join(ownedDownloadsRoot, runtimeOwnerRef));
    const addonState = addonManager.readState(ownerRef);
    const profileAbsent = !profileStore.hasOwnerRef(ownerRef);
    const partitionUnavailable = !storagePath || !fs.existsSync(storagePath);
    const artifactsAbsent = downloadDirectories.every((directory) => !fs.existsSync(directory))
      && !addonState.activeSha
      && runtimeOwnerRefs.every((runtimeOwnerRef) => !cefRuntime.get(runtimeOwnerRef))
      && ![...tabs.values()].some((tab) => tab.storageRef === ownerRef);
    if (!profileAbsent || !partitionUnavailable || !artifactsAbsent) {
      fail('PURCHASE_BROWSER_ACCOUNT_REMOVAL_READBACK_FAILED');
    }
    return Object.freeze({
      verified: true,
      ownerRef,
      resourceIds: validateRemovalResourceIds(resourceIds),
      profileAbsent,
      partitionUnavailable,
      artifactsAbsent,
      receiptBinding,
    });
  }

  async function recoverPendingPurges() {
    const recovered = [];
    for (const pending of readPendingRemovals()) {
      if (typeof localApiClient.getAccountRemovalOperation !== 'function') fail('PURCHASE_BROWSER_ACCOUNT_REMOVAL_READBACK_UNAVAILABLE');
      const operation = await localApiClient.getAccountRemovalOperation(pending.operationId);
      if (operation?.operationId !== pending.operationId) fail('PURCHASE_BROWSER_ACCOUNT_REMOVAL_OPERATION_MISMATCH');
      if (operation.completed === true) {
        // A completed old operation cannot authorize deleting whatever now
        // occupies its historical filesystem path. Only retire the marker.
        fs.rmSync(pending.filePath, { force: true });
        recovered.push({ operationId: pending.operationId, completed: true, skippedCleanup: true });
        continue;
      }
      const prepared = await localApiClient.prepareAccountRemoval(pending.operationId);
      if (prepared?.operationId !== pending.operationId) fail('PURCHASE_BROWSER_ACCOUNT_REMOVAL_OPERATION_MISMATCH');
      const receiptBinding = validatePurchaseRemovalReceiptBinding(prepared.receiptBinding, { operationId: pending.operationId, binding: prepared.binding });
      const ownerRef = profileStore.ownerRefFor(prepared.binding);
      const resourceIds = validateRemovalResourceIds(prepared.resourceIds);
      const expectedResources = prepared.binding?.ownerType === 'integration_profile'
        ? INTEGRATION_BROWSER_PURGE_RESOURCE_IDS : PURCHASE_BROWSER_PURGE_RESOURCE_IDS;
      if (ownerRef !== pending.ownerRef
        || JSON.stringify(resourceIds) !== JSON.stringify(pending.resourceIds)
        || JSON.stringify(resourceIds) !== JSON.stringify(expectedResources)) fail('PURCHASE_BROWSER_ACCOUNT_REMOVAL_SCOPE_CHANGED');
      if (pending.receiptBinding) validatePurchaseRemovalReceiptBinding(pending.receiptBinding, { operationId: pending.operationId, binding: prepared.binding });
      // Upgrade legacy markers using only a current backend challenge, before
      // deleting anything. Never trust a persisted nonce over a fresh prepare.
      writePendingRemoval({ ...pending, receiptBinding });
      removingOwnerRefs.add(ownerRef);
      await alipayPaymentWindowController?.purgeOwner?.(ownerRef);
      for (const tab of [...tabs.values()]) {
        if (tab.storageRef === ownerRef) await close(tab.tabId, undefined, { skipVisibility: true });
      }
      for (const ref of [ownerRef, marketCollectorOwnerRef(ownerRef), followSellerCollectorOwnerRef(ownerRef), productLinkParserOwnerRef(ownerRef)]) await cefRuntime.close(ref);
      profileStore.remove(prepared.binding);
      if (fs.existsSync(pending.storagePath)) await removeOwnedPath(pending.storagePath, pending.ownerRef);
      const currentStoragePath = path.join(ownedProfileRoot, ownerRef);
      if (currentStoragePath !== pending.storagePath && fs.existsSync(currentStoragePath)) await removeOwnedPathAfterRuntimeClose(currentStoragePath, ownerRef);
      await removeOwnedPath(path.join(ownedDownloadsRoot, pending.ownerRef), pending.ownerRef);
      const collectorOwnerRef = marketCollectorOwnerRef(pending.ownerRef);
      const followSellerOwnerRef = followSellerCollectorOwnerRef(pending.ownerRef);
      const parserOwnerRef = productLinkParserOwnerRef(pending.ownerRef);
      await removeOwnedPath(path.join(ownedDownloadsRoot, collectorOwnerRef), collectorOwnerRef);
      await removeOwnedPath(path.join(ownedDownloadsRoot, followSellerOwnerRef), followSellerOwnerRef);
      await removeOwnedPath(path.join(ownedDownloadsRoot, parserOwnerRef), parserOwnerRef);
      addonManager.purgeOwner(pending.ownerRef);
      if (fs.existsSync(currentStoragePath)) fail('PURCHASE_BROWSER_ACCOUNT_REMOVAL_READBACK_FAILED');
      const proof = createRemovalProof({ ...pending, receiptBinding });
      await localApiClient.recordAccountRemovalReceipt(pending.operationId, proof);
      if (typeof localApiClient.finalizeAccountRemoval === 'function') {
        await localApiClient.finalizeAccountRemoval(pending.operationId);
      }
      fs.rmSync(pending.filePath, { force: true });
      recovered.push({ operationId: pending.operationId, proof });
    }
    if (fs.existsSync(pendingRemovalRoot) && fs.readdirSync(pendingRemovalRoot).length === 0) {
      fs.rmdirSync(pendingRemovalRoot);
    }
    return { ok: true, recovered };
  }

  async function purgeOperation(operationId, update = () => undefined) {
    const prepared = await localApiClient.prepareAccountRemoval(operationId);
    if (prepared?.operationId !== operationId) fail('PURCHASE_BROWSER_ACCOUNT_REMOVAL_OPERATION_MISMATCH');
    const binding = prepared.binding;
    const resourceIds = validateRemovalResourceIds(prepared.resourceIds);
    const ownerType = binding?.ownerType || 'purchase_account';
    const expectedResources = ownerType === 'purchase_account' ? PURCHASE_BROWSER_PURGE_RESOURCE_IDS
      : ownerType === 'integration_profile' ? INTEGRATION_BROWSER_PURGE_RESOURCE_IDS : null;
    if (!expectedResources || JSON.stringify(resourceIds) !== JSON.stringify(expectedResources)) fail('PURCHASE_BROWSER_ACCOUNT_REMOVAL_RESOURCE_MISMATCH');
    const receiptBinding = validatePurchaseRemovalReceiptBinding(prepared.receiptBinding, { operationId, binding });
    const ownerRef = profileStore.ownerRefFor(binding);
    const collectorOwnerRef = marketCollectorOwnerRef(ownerRef);
    const followSellerOwnerRef = followSellerCollectorOwnerRef(ownerRef);
    const parserOwnerRef = productLinkParserOwnerRef(ownerRef);
    update({ ownerRef, phase: 'closing' });
    removingOwnerRefs.add(ownerRef);
    const matchesOwner = ({ scope }) => Boolean(scope && (
      scope.ownerRef ? scope.ownerRef === ownerRef
        : scope.accountId === binding.accountId && scope.ownerType === ownerType
    ));
    for (const tab of tabs.values()) {
      if (tab.storageRef === ownerRef) tab.session = sessions.invalidate(tab.session.sessionId, 'closing') || tab.session;
    }
    for (const queue of [commandQueue, productLinkCommandQueue, followSellerCommandQueue]) queue.cancelMatching(matchesOwner);
    await Promise.all([ownerRef, collectorOwnerRef, followSellerOwnerRef, parserOwnerRef]
      .map((ref) => pendingOpens.get(ref)).filter(Boolean));
    await alipayPaymentWindowController?.purgeOwner?.(ownerRef);
    for (const tab of [...tabs.values()]) {
      if (tab.storageRef === ownerRef) await close(tab.tabId, undefined, { skipVisibility: true });
    }
    await cefRuntime.close(ownerRef);
    await cefRuntime.close(collectorOwnerRef);
    await cefRuntime.close(followSellerOwnerRef);
    await cefRuntime.close(parserOwnerRef);
    void applyVisibility().catch(() => undefined);
    update({ phase: 'deleting' });
    addonManager.purgeOwner(ownerRef);
    profileStore.remove(binding);
    const downloadDirectory = path.join(ownedDownloadsRoot, ownerRef);
    await removeOwnedPath(downloadDirectory, ownerRef);
    await removeOwnedPath(path.join(ownedDownloadsRoot, collectorOwnerRef), collectorOwnerRef);
    await removeOwnedPath(path.join(ownedDownloadsRoot, followSellerOwnerRef), followSellerOwnerRef);
    await removeOwnedPath(path.join(ownedDownloadsRoot, parserOwnerRef), parserOwnerRef);
    const storagePath = path.join(ownedProfileRoot, ownerRef);
    if (fs.existsSync(storagePath)) {
      try {
        await removeOwnedPathAfterRuntimeClose(storagePath, ownerRef);
      } catch (error) {
        if (!['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM'].includes(String(error?.code || ''))) throw error;
        const pending = writePendingRemoval({
          version: PENDING_REMOVAL_VERSION,
          operationId,
          ownerRef,
          storagePath,
          resourceIds,
          receiptBinding,
        });
        appendLog('desktop-main', `[cef] account-removal restart-required owner=${ownerRef} operation=${sha256(operationId).slice(0, 16)}\n`);
        if (typeof requestRestartForAccountRemoval === 'function') {
          await requestRestartForAccountRemoval({ operationId, ownerRef, pendingFile: pending.filePath });
        }
        return { ok: true, verified: false, restartRequired: true, ownerRef, resourceIds, state: snapshot() };
      }
    }
    const proof = createRemovalProof({ ownerRef, resourceIds, storagePath, receiptBinding });
    update({ phase: 'receipt' });
    await localApiClient.recordAccountRemovalReceipt(operationId, proof);
    return { ok: true, verified: true, proof, state: snapshot() };
  }

  function requestPurgeOperation(operationId) {
    return removalMaintenance.request(operationId).then((result) => ({
      ...result, command: 'purge-operation', state: snapshot(),
    }));
  }

  function rowsFromLocalApiPayload(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.rows)) return payload.rows;
    if (Array.isArray(payload?.sourceLinks)) return payload.sourceLinks;
    return [];
  }

  async function loadPurchaseRehearsalInventory() {
    if (
      typeof localApiClient.listAccounts !== 'function'
      || typeof localApiClient.listPurchaseSourceLinks !== 'function'
      || typeof localApiClient.listProductSourceLinks !== 'function'
    ) fail('PURCHASE_REHEARSAL_DATA_SERVICE_UNAVAILABLE');
    const [accountPayload, purchaseLinksResult, productLinksResult] = await Promise.all([
      localApiClient.listAccounts(),
      localApiClient.listPurchaseSourceLinks({ limit: 500 }),
      localApiClient.listProductSourceLinks({ limit: 500 }),
    ]);
    const accounts = Array.isArray(accountPayload?.accounts)
      ? accountPayload.accounts
      : rowsFromLocalApiPayload(accountPayload);
    const targets = normalizePurchaseRehearsalTargets([
      ...rowsFromLocalApiPayload(purchaseLinksResult),
      ...rowsFromLocalApiPayload(productLinksResult),
    ]);
    const platforms = PURCHASE_REHEARSAL_PLATFORMS.map((platform) => ({
      ...platform,
      accountCount: accounts.filter((account) => accountSupportsPurchaseRehearsal(account, platform.id)).length,
      targetCount: targets.filter((target) => target.platformId === platform.id).length,
      ready: accounts.some((account) => accountSupportsPurchaseRehearsal(account, platform.id))
        && targets.some((target) => target.platformId === platform.id),
    }));
    return { accounts, targets, platforms };
  }

  async function purchaseRehearsalInventory() {
    const inventory = await loadPurchaseRehearsalInventory();
    return {
      ok: true,
      minimumRuns: PURCHASE_REHEARSAL_MIN_RUNS,
      platforms: inventory.platforms,
      safety: {
        realBrowserEngine: 'cef',
        realAccountSession: true,
        realProductRead: true,
        orderSubmitBlocked: true,
        paymentPasswordInputBlocked: true,
      },
    };
  }

  async function waitForPurchaseRehearsalPage(tab, expectedUrl, signal) {
    const deadline = Date.now() + PURCHASE_REHEARSAL_PAGE_TIMEOUT_MS;
    let expectedHost = '';
    let expectedPath = '';
    try {
      const parsedExpected = new URL(expectedUrl);
      expectedHost = parsedExpected.hostname.toLowerCase();
      expectedPath = parsedExpected.pathname;
    } catch { /* validated earlier */ }
    while (Date.now() < deadline) {
      assertNotAborted(signal);
      const state = await tab.browser.request('state', {}, 5_000, signal);
      tab.state = { ...tab.state, ...(state && typeof state === 'object' ? state : {}) };
      let actualHost = '';
      let actualPath = '';
      try {
        const parsedActual = new URL(tab.state.url);
        actualHost = parsedActual.hostname.toLowerCase();
        actualPath = parsedActual.pathname;
      } catch { /* keep waiting */ }
      const pageIdentityMatches = expectedHost && actualHost === expectedHost && (
        !/^\/offer\/\d+\.html$/u.test(expectedPath)
        || actualPath === expectedPath
      );
      const pageMarker = `${String(tab.state.title || '')} ${String(tab.state.url || '')}`;
      if (tab.state.loading !== true && /(?:验证码|人机验证|安全验证|访问受限|captcha|verify\s+you\s+are\s+human|\/challenge(?:\/|\?|$))/iu.test(pageMarker)) {
        fail('PURCHASE_REHEARSAL_MANUAL_VERIFICATION_REQUIRED');
      }
      if (
        tab.state.loading !== true
        && pageIdentityMatches
        && String(tab.state.title || '').trim()
        && String(tab.state.title || '').trim() !== '新标签页'
      ) {
        await waitForDelay(500);
        return;
      }
      await waitForDelay(250);
    }
    fail('PURCHASE_REHEARSAL_PAGE_TIMEOUT');
  }

  function writePurchaseRehearsalReport(report) {
    const reportRoot = path.join(ownedDataRoot, 'purchase-browser', 'rehearsal-reports');
    fs.mkdirSync(reportRoot, { recursive: true });
    const timestamp = String(report.completedAt || new Date().toISOString())
      .replace(/[^0-9A-Za-z]+/gu, '-')
      .replace(/^-|-$/gu, '');
    const platformId = String(report.platformId || 'unknown').replace(/[^a-z0-9-]/gu, '');
    const reportId = sha256(JSON.stringify(report));
    const reportPath = path.join(reportRoot, `${timestamp}-${platformId}-${reportId.slice(0, 12)}.json`);
    const temporaryPath = `${reportPath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ ...report, reportId }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, reportPath);
    return { reportId, reportPath };
  }

  async function runPurchaseRehearsalBatch({ platform, runs = PURCHASE_REHEARSAL_MIN_RUNS, signal } = {}) {
    const platformSpec = resolvePurchaseRehearsalPlatform(platform);
    if (!platformSpec) fail('PURCHASE_REHEARSAL_PLATFORM_UNSUPPORTED');
    const requiredRuns = Math.max(
      PURCHASE_REHEARSAL_MIN_RUNS,
      Math.min(PURCHASE_REHEARSAL_MAX_RUNS, Math.trunc(Number(runs) || PURCHASE_REHEARSAL_MIN_RUNS)),
    );
    const inventory = await loadPurchaseRehearsalInventory();
    const account = inventory.accounts.find((candidate) => (
      accountSupportsPurchaseRehearsal(candidate, platformSpec.id)
      && candidate.browserLoginStatus === '已登录'
      && candidate.cookieStatus === 'Cookie 已保存'
    )) || inventory.accounts.find((candidate) => accountSupportsPurchaseRehearsal(candidate, platformSpec.id));
    if (!account) fail('PURCHASE_REHEARSAL_ACCOUNT_MISSING');
    const platformTargets = inventory.targets.filter((target) => target.platformId === platformSpec.id);
    if (!platformTargets.length) fail('PURCHASE_REHEARSAL_TARGETS_MISSING');

    const results = [];
    const failures = [];
    const maximumAttempts = Math.min(150, requiredRuns * 3);
    // Pinduoduo's dedicated mobile WinForms host does not create a renderer
    // surface for a background product-parser tab on every GPU/CEF build.
    // Reuse the account's already-prewarmed interactive CEF session, keep its
    // bounds hidden, and retain the same no-click rehearsal state machine.
    const rehearsalBrowserRole = platformSpec.id === 'pinduoduo'
      ? PURCHASE_BROWSER_ROLES.INTERACTIVE
      : PURCHASE_BROWSER_ROLES.PRODUCT_LINK_PARSER;
    let tab = null;
    let consecutivePageFailures = 0;
    for (let attempt = 1; results.length < requiredRuns && attempt <= maximumAttempts; attempt += 1) {
      assertNotAborted(signal);
      const target = samplePurchaseRehearsalTarget(platformTargets, platformSpec.id);
      if (!target) fail('PURCHASE_REHEARSAL_TARGETS_MISSING');
      emit('purchase-rehearsal-progress', {
        platformId: platformSpec.id,
        platformLabel: platformSpec.label,
        attempt,
        completedRuns: results.length,
        requiredRuns,
        stage: 'opening-product',
        targetHash: target.targetHash,
      });
      try {
        await open({
          accountId: account.id,
          ownerType: 'purchase_account',
          url: target.url,
          waitUntil: 'commit',
          signal,
          restoreVisible: false,
          browserRole: rehearsalBrowserRole,
          background: rehearsalBrowserRole === PURCHASE_BROWSER_ROLES.PRODUCT_LINK_PARSER,
          traceId: `purchase_rehearsal_${platformSpec.id}_${attempt}`,
        });
        tab = [...tabs.values()].find((candidate) => (
          candidate.binding.accountId === account.id
          && candidate.browserRole === rehearsalBrowserRole
        )) || null;
        if (!tab) fail('PURCHASE_REHEARSAL_BROWSER_SESSION_MISSING');
        if (platformSpec.id === 'pinduoduo' && viewport.visible !== true) {
          // The dedicated PDD host creates its Chromium renderer only after
          // the native window receives one real presentation. Keep that same
          // built-in CEF window visible for the bounded batch, then hide it
          // again below. No website control is clicked during this lease.
          await activate(tab.tabId);
        }
        await waitForPurchaseRehearsalPage(tab, target.url, signal);
        const accountLogin = await tab.browser.request('purchase-login-status', {}, 20_000, signal);
        const captured = await capturePurchase(tab.tabId, signal);
        const result = publicPurchaseRehearsalResult(createPurchaseRehearsalResult({
          platform: platformSpec.id,
          target,
          accountLogin,
          capture: captured.capture,
          runNumber: results.length + 1,
        }));
        results.push(result);
        consecutivePageFailures = 0;
        emit('purchase-rehearsal-progress', {
          platformId: platformSpec.id,
          platformLabel: platformSpec.label,
          attempt,
          completedRuns: results.length,
          requiredRuns,
          stage: result.stopStage,
          targetHash: result.targetHash,
          productHash: result.productHash,
          skuHash: result.skuHash,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        const code = sanitizedErrorCode(error);
        const manualVerificationRequired = code === 'PURCHASE_REHEARSAL_MANUAL_VERIFICATION_REQUIRED';
        const recoverablePageFailure = [
          'PURCHASE_BROWSER_REQUEST_INVALID',
          'PURCHASE_BROWSER_PRODUCT_PAGE_REQUIRED',
          'PURCHASE_BROWSER_CAPTURE_CONTEXT_NOT_READY',
        ].includes(code);
        consecutivePageFailures = recoverablePageFailure ? consecutivePageFailures + 1 : 0;
        failures.push({
          attempt,
          code,
          targetHash: target.targetHash,
          failedAt: new Date().toISOString(),
        });
        appendLog(
          'desktop-main',
          `[purchase-rehearsal] platform=${platformSpec.id} attempt=${attempt} code=${code} target=${target.targetHash.slice(0, 12)}\n`,
        );
        emit('purchase-rehearsal-progress', {
          platformId: platformSpec.id,
          platformLabel: platformSpec.label,
          attempt,
          completedRuns: results.length,
          requiredRuns,
          stage: 'failed',
          code,
          targetHash: target.targetHash,
        });
        if (manualVerificationRequired) break;
        if (
          consecutivePageFailures >= 2
          && tab
          && rehearsalBrowserRole === PURCHASE_BROWSER_ROLES.PRODUCT_LINK_PARSER
        ) {
          await forceClose(tab.tabId).catch(() => undefined);
          tab = null;
          consecutivePageFailures = 0;
          await waitForDelay(500);
        }
      }
    }
    if (platformSpec.id === 'pinduoduo' && tab) {
      await setBounds({ visible: false }).catch(() => undefined);
    }
    const completedAt = new Date().toISOString();
    const report = {
      schemaVersion: 1,
      platformId: platformSpec.id,
      platformLabel: platformSpec.label,
      requiredRuns,
      attemptedRuns: results.length + failures.length,
      passedRuns: results.length,
      failedRuns: failures.length,
      passed: results.length >= requiredRuns,
      engine: 'cef',
      mode: 'live-readonly-plus-local-payment-replay',
      stopStage: 'PAYMENT_PASSWORD_REQUIRED',
      safety: {
        clickedSubmitOrder: false,
        createdPendingOrder: false,
        openedRealPaymentGateway: false,
        enteredPaymentPassword: false,
        clickedFinalPay: false,
      },
      results,
      failures,
      completedAt,
    };
    const saved = writePurchaseRehearsalReport(report);
    appendLog(
      'desktop-main',
      `[purchase-rehearsal] platform=${platformSpec.id} passed=${results.length}/${requiredRuns} failures=${failures.length} report=${saved.reportId.slice(0, 12)}\n`,
    );
    return {
      ok: report.passed,
      ...report,
      ...saved,
      state: snapshot(),
    };
  }

  const purchaseLogisticsSyncService = createPurchaseLogisticsSyncService({
    listAccounts: () => localApiClient.listAccounts(),
    listPurchaseOverrides: typeof localApiClient.listPurchaseOrderOverrides === 'function'
      ? (query) => localApiClient.listPurchaseOrderOverrides(query)
      : undefined,
    savePurchaseOverride: typeof localApiClient.savePurchaseOrderOverride === 'function'
      ? (body) => localApiClient.savePurchaseOrderOverride(body)
      : undefined,
    saveCrossBorderRecord: typeof localApiClient.saveCrossBorderOrderRecord === 'function'
      ? (body) => localApiClient.saveCrossBorderOrderRecord(body)
      : undefined,
    openSession: (input) => open(input),
    executeCommand: ({ tabId, command, payload }) => {
      if (command === 'purchase-login-status') return purchaseLoginStatus({ tabId });
      return crossBorderCommand({ tabId, command, payload });
    },
    emitProgress: (progress) => emit('cross-border-logistics-progress', progress),
  });

  async function executeCommand(input = {}) {
    switch (String(input.command || '')) {
      case 'state': return snapshot();
      case 'open': return open(input);
      case 'prewarm': return prewarm(input);
      case 'activate': return activate(input.tabId);
      case 'show-follow-seller-verification': return showFollowSellerVerification(input);
      case 'hide-follow-seller-verification': return hideFollowSellerVerification(input);
      case 'read-follow-seller-verification': return readFollowSellerVerification(input);
	  case 'show-follow-seller-quick-browser': return showFollowSellerQuickBrowser(input);
      case 'close': return close(input.tabId, input.signal);
      case 'close-interactive': return closeInteractiveTabs();
      case 'force-close': return forceClose(input.tabId || activeTabId);
      case 'bounds': return setBounds(input.bounds || input);
      case 'hide': return setBounds({ ...(input.bounds || {}), visible: false });
      case 'suspend-workbench': return suspendWorkbench(input.bounds || input);
      case 'navigate': return navigate(input);
      case 'purchase-auto-order': return executePurchaseAutoOrder(input.order || input);
      case 'scan-purchase-wait-pay-orders': return scanPurchaseWaitPayOrders(input);
      case 'save-purchase-payment-credential': return saveAutoPayCredential(input);
      case 'clear-purchase-payment-credential': return clearAutoPayCredential(input);
      case 'purchase-payment-credential-status': return readAutoPayCredentialStatus(input);
      case 'purchase-payment-login-status': return readPurchasePaymentLoginStatus(input);
      case 'save-shared-alipay-login': return saveSharedAlipayLogin(input);
      case 'open-shared-alipay-login': return openSharedAlipayLogin(input);
      case 'shared-alipay-login-status': return readSharedAlipayLoginStatus(input);
      case 'clear-shared-alipay-login': return clearSharedAlipayLogin(input);
      case 'open-purchase-payment-login': return openPurchasePaymentLogin(input);
      case 'clear-purchase-payment-session': return clearPurchasePaymentSession(input);
      case 'show-purchase-payment-window': return showPurchasePaymentWindow(input);
      case 'resume-purchase-auto-order': return resumePurchaseAutoOrder(input);
      case 'back': return browserCommand(input.tabId, 'back', input.signal);
      case 'forward': return browserCommand(input.tabId, 'forward', input.signal);
      case 'reload': return browserCommand(input.tabId, 'reload', input.signal);
      case 'open-extension-manager': return browserCommand(input.tabId, 'open-extension-manager', input.signal, 10_000);
      case 'ozon-open-order': return openExactOzonSellerOrder(input);
      case 'restore': return browserCommand(input.tabId, 'restore', input.signal);
      case 'inspect': return inspect(input.tabId, input.signal);
      case 'capture-purchase': return capturePurchase(input.tabId, input.signal);
      case 'capture-preview': return capturePreview(input.tabId, input.signal);
      case 'capture-confirm': return captureConfirm(input);
      case 'read-payment-info': return captureMarketplaceOrder({ ...input, operation: 'read-payment-info' });
      case 'refresh-order-status': return captureMarketplaceOrder({ ...input, operation: 'refresh-order-status' });
      case 'read-order-readonly': return readMarketplaceOrderReadonly(input);
      case 'save-payment-info': return saveMarketplaceOrder(input);
      case 'verify-alipay-payment': return verifyPinduoduoAlipayPayment(input.tabId);
      case 'purchase-context': return getPurchaseContext(input.tabId);
      case 'set-target': return setTarget(input);
      case 'clear-target': return clearTarget(input.tabId, input.signal);
      case 'get-target': return getTarget(input.tabId);
      case 'target-recovery': return recoverTarget(input);
      case 'health': return health(input.tabId);
      case 'execute-task': return executeTask(input);
      case 'cross-border-status': return crossBorderCommand({ ...input, command: 'cross-border-status' });
      case 'cross-border-orders': return crossBorderCommand({ ...input, command: 'cross-border-orders' });
      case 'cross-border-charges-status': return crossBorderCommand({ ...input, command: 'cross-border-charges-status' });
      case 'cross-border-charges': return crossBorderCommand({ ...input, command: 'cross-border-charges' });
      case 'cross-border-sync': return crossBorderCommand({ ...input, command: 'cross-border-sync' });
      case 'cross-border-logistics-sync': return purchaseLogisticsSyncService.execute();
      case 'cross-border-purchase-read': return purchaseLogisticsSyncService.readOrders({
        orderNumbers: input.orderNumbers,
        platform: input.platform,
      });
      case 'cross-border-login-status': return crossBorderCommand({ ...input, command: 'cross-border-login-status' });
      case 'purchase-login-status': return purchaseLoginStatus(input);
      case 'purchase-login-fixture': return seedPurchaseLoginFixture(input);
      case 'purchase-rehearsal-inventory': return purchaseRehearsalInventory();
      case 'purchase-rehearsal-batch': return runPurchaseRehearsalBatch(input);
      case 'ozon-login-status': return ozonLoginStatus(input);
      case 'ozon-data-status': return ozonDataCommand({ ...input, command: 'ozon-data-status' });
      case 'ozon-data-read': return ozonDataCommand({ ...input, command: 'ozon-data-read' });
      case 'ozon-data-catalog': return ozonDataCommand({ ...input, command: 'ozon-data-catalog' });
      case 'ozon-data-normalize': return ozonDataCommand({ ...input, command: 'ozon-data-normalize' });
      case 'ozon-data-payload': return ozonDataCommand({ ...input, command: 'ozon-data-payload' });
      case 'ozon-data-search': return ozonDataCommand({ ...input, command: 'ozon-data-search' });
      case 'ozon-data-probe': return ozonDataCommand({ ...input, command: 'ozon-data-probe' });
      case 'ozon-data-follow-sellers': return ozonDataCommand({ ...input, command: 'ozon-data-follow-sellers' });
      case 'ozon-submit-follow-seller-complaint': return ozonDataCommand({ ...input, command: 'ozon-submit-follow-seller-complaint' });
      case 'ozon-submit-follow-seller-quick-complaint': return ozonDataCommand({ ...input, command: 'ozon-submit-follow-seller-quick-complaint' });
      case 'ozon-data-paginate': return ozonDataCommand({ ...input, command: 'ozon-data-paginate' });
      case 'ozon-data-cancel-pagination': return ozonDataCommand({ ...input, command: 'ozon-data-cancel-pagination' });
      case 'approve-download': return approveDownload(input);
      case 'purge-operation': return requestPurgeOperation(input.operationId);
      default: fail('PURCHASE_BROWSER_COMMAND_INVALID');
    }
  }

  function crashCommandTab(input, code) {
    const tabId = String(input?.tabId || '');
    if (!tabId) return;
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.state = { ...tab.state, loading: false, crashed: true };
    tab.session = sessions.invalidate(tab.session.sessionId, 'crashed') || tab.session;
    setTargetPhase(tab, 'error');
    cefRuntime.invalidate?.(tab.profile.ownerRef, code);
    cefRuntime.forceTerminate?.(tab.profile.ownerRef);
    emit('crashed', { tabId, code });
  }

  function decorateResponse(value, input = {}, requestId = '') {
    const state = value?.state?.tabs ? value.state : value?.tabs ? value : snapshot();
    const requestedTab = tabs.get(String(input.tabId || ''));
    const stateTabs = Array.isArray(state?.tabs) ? state.tabs : [];
    const active = stateTabs.find((tab) => tab.tabId === requestedTab?.tabId)
      || stateTabs.find((tab) => tab.tabId === state?.activeTabId)
      || stateTabs[0]
      || null;
    const phase = String(
      active?.phase
      || (String(input.command || '') === 'close' || String(input.command || '') === 'force-close' ? 'closed' : 'idle'),
    );
    return {
      ...(value && typeof value === 'object' ? value : { value }),
      requestId,
      command: String(input.command || ''),
      sessionId: String(active?.sessionId || requestedTab?.session?.sessionId || ''),
      generation: Number(active?.generation || requestedTab?.session?.generation) || 0,
      targetPhase: normalizeTargetPhase(
        active?.targetPhase,
        active?.target ? 'target-locked' : 'idle',
      ),
      phase,
    };
  }

  function validateSessionInput(input = {}) {
    const tabId = String(input.tabId || '');
    if (!tabId || input.sessionId === undefined && input.generation === undefined) return;
    const tab = tabs.get(tabId);
    if (!tab) fail('PURCHASE_BROWSER_TAB_NOT_FOUND');
    if (input.sessionId !== undefined && String(input.sessionId || '') !== tab.session.sessionId) {
      fail('PURCHASE_BROWSER_SESSION_STALE');
    }
    if (input.generation !== undefined) {
      const generation = Number(input.generation);
      if (!Number.isInteger(generation) || generation !== Number(tab.session.generation)) {
        fail('PURCHASE_BROWSER_SESSION_STALE');
      }
    }
    if (!sessions.isCurrent(tab.session.sessionId, tab.session.generation)) {
      fail('PURCHASE_BROWSER_SESSION_STALE');
    }
  }

  function dispatch(input = {}) {
    const command = String(input.command || '');
    if (command === 'state') return Promise.resolve(decorateResponse(snapshot(), input, `purchase_state_${randomUUID()}`));
    // Delete maintenance never enters the browser's long-running read queues.
    // Ignore renderer owner/path fields: only the backend operation determines
    // its exact binding and resource scope.
    if (command === 'purge-operation') return requestPurgeOperation(input.operationId);
    try {
      validateSessionInput(input);
    } catch (error) {
      return Promise.reject(error);
    }
	if (command === 'show-follow-seller-quick-browser') {
	  const requestId = `purchase_quick_browser_${randomUUID()}`;
	  return Promise.resolve()
	    .then(() => executeCommand(input))
	    .then((result) => decorateResponse(result, input, requestId));
	}
    const requestedRole = ['open', 'prewarm'].includes(command)
      ? normalizeBrowserRole(input.browserRole, input.background)
      : '';
    const prewarmCoalesceKey = command === 'prewarm'
      ? [
          'prewarm',
          String(input.ownerType || 'purchase_account').trim(),
          String(input.accountId || '').trim(),
          requestedRole,
        ].join('\u0000')
      : '';
    const commandTab = tabs.get(String(input.tabId || ''));
    const productLinkParserCommand = requestedRole === PURCHASE_BROWSER_ROLES.PRODUCT_LINK_PARSER
      || commandTab?.browserRole === PURCHASE_BROWSER_ROLES.PRODUCT_LINK_PARSER;
    const followSellerCollectorCommand = requestedRole === PURCHASE_BROWSER_ROLES.FOLLOW_SELLER_COLLECTOR
      || commandTab?.browserRole === PURCHASE_BROWSER_ROLES.FOLLOW_SELLER_COLLECTOR;
    const purchaseRehearsalCommand = command === 'purchase-rehearsal-inventory'
      || command === 'purchase-rehearsal-batch';
    const selectedQueue = productLinkParserCommand || purchaseRehearsalCommand
      ? productLinkCommandQueue
      : followSellerCollectorCommand
        ? followSellerCommandQueue
        : commandQueue;
    const lifecycleCommand = ['close', 'close-interactive', 'force-close', 'hide', 'suspend-workbench'].includes(command);
    const interactiveOpen = command === 'open'
      && normalizeBrowserRole(input.browserRole, input.background) === PURCHASE_BROWSER_ROLES.INTERACTIVE;
    const interactiveNavigation = INTERACTIVE_NAVIGATION_COMMANDS.has(command)
      && commandTab?.background !== true;
    const interactiveTargetCommand = INTERACTIVE_TARGET_COMMANDS.has(command)
      && commandTab?.background !== true;
    const interactiveCollectorTask = input.collectorPriority === 'interactive'
      && !PASSIVE_COLLECTOR_COMMANDS.has(command);
    const highPriority = lifecycleCommand
      || interactiveOpen
      || interactiveNavigation
      || interactiveTargetCommand
      || interactiveCollectorTask;
    const paginationPages = Math.max(1, Math.min(250, Number(input.maxPages) || 5));
    const paginationDelay = Math.max(100, Math.min(3000, Number(input.delayMs) || 100));
    const timeoutMs = command === 'purchase-rehearsal-batch'
      ? 1_205_000
      : ['open', 'prewarm'].includes(command)
      ? 65_000
        : command === 'ozon-open-order'
          ? 125_000
        : ['inspect', 'capture-purchase', 'capture-preview'].includes(command)
        ? 90_000
        : command === 'cross-border-charges'
          || ['cross-border-logistics-sync', 'cross-border-purchase-read'].includes(command)
          ? 630_000
        : command === 'capture-confirm'
          ? 45_000
        : ['read-payment-info', 'refresh-order-status', 'save-payment-info'].includes(command)
            || command === 'read-order-readonly'
            ? 90_000
          : ['close', 'close-interactive', 'force-close'].includes(command)
          ? 7_000
      : command === 'purchase-auto-order'
        ? PURCHASE_AUTO_ORDER_TIMEOUT_MS
      : command === 'verify-alipay-payment'
            ? 60_000
          : command === 'open-extension-manager'
            ? 30_000
          : command === 'bounds' || command === 'hide' || command === 'suspend-workbench'
            ? 5_000
            : command === 'ozon-data-paginate'
              ? Math.min(1_205_000, 150_000 + paginationPages * (paginationDelay + 30_000))
             : command === 'ozon-data-follow-sellers'
                ? ozonFollowSellerCommandTimeoutMs(input.skus)
               : command === 'ozon-submit-follow-seller-complaint'
                 ? 245_000
                : command === 'ozon-submit-follow-seller-quick-complaint'
	                  ? 650_000
              : command === 'ozon-data-probe'
                ? 45_000
                : 20_000;
    let queueRequestId = '';
    const queuedAt = Date.now();
    const activeBeforeQueue = selectedQueue.getSnapshot().active;
    const shouldPreemptCollector = !productLinkParserCommand && (
      !followSellerCollectorCommand && (
        interactiveOpen
        || interactiveNavigation
        || interactiveTargetCommand
        || interactiveCollectorTask
      )
    );
    const willPreemptActive = shouldPreemptCollector || lifecycleCommand;
    const cancellationFence = willPreemptActive && activeBeforeQueue?.name === 'ozon-data-paginate'
      ? beginOzonPaginationCancellation(command)
      : null;
    if (willPreemptActive && isBackgroundCollectorCommand(activeBeforeQueue?.name)) {
      appendLog(
        'desktop-main',
        `[purchase-browser] interactive command=${command} preempt=${activeBeforeQueue.name}\n`,
      );
    }
    return selectedQueue.enqueue(command, async ({ signal, requestId }) => {
      queueRequestId = requestId;
      if (command === 'open') {
        appendLog(
          'desktop-main',
          `[purchase-browser] open stage=queue-ready request=${requestId} durationMs=${Math.max(0, Date.now() - queuedAt)} totalMs=${Math.max(0, Date.now() - queuedAt)}\n`,
        );
      }
      await cancellationFence;
      const execution = {
        requestId,
        command,
        tabId: String(input.tabId || ''),
      };
      if (!productLinkParserCommand && !followSellerCollectorCommand) activeQueuedCommand = execution;
      try {
        return await executeCommand({
          ...input,
          signal,
          ...(command === 'open' ? { traceId: requestId, queuedAt } : {}),
        });
      } finally {
        if (
          !productLinkParserCommand
          && !followSellerCollectorCommand
          && activeQueuedCommand?.requestId === requestId
        ) activeQueuedCommand = null;
      }
    }, {
      timeoutMs,
      priority: highPriority ? 'high' : 'normal',
      latestKey: command === 'bounds' || command === 'hide' || command === 'suspend-workbench' ? 'bounds' : '',
      coalesceKey: prewarmCoalesceKey,
      scope: {
        browserRole: requestedRole || commandTab?.browserRole || '',
        ownerRef: commandTab?.storageRef || '',
        accountId: commandTab?.binding?.accountId || String(input.accountId || ''),
        ownerType: commandTab?.binding?.ownerType || String(input.ownerType || 'purchase_account'),
      },
      supersedePendingKeys: lifecycleCommand || interactiveOpen ? ['bounds'] : [],
      preemptActive: shouldPreemptCollector
        ? ({ name }) => isBackgroundCollectorCommand(name) || name === 'prewarm'
        : lifecycleCommand,
    }).then((result) => decorateResponse(result, input, queueRequestId))
      .catch((error) => {
      const recoverablePaginationTimeout = command === 'ozon-data-paginate'
        && String(error?.code || '') === 'PURCHASE_BROWSER_COMMAND_TIMEOUT';
      if (
        !recoverablePaginationTimeout
        &&
        ['PURCHASE_BROWSER_COMMAND_TIMEOUT', 'PURCHASE_BROWSER_CEF_HOST_UNHEALTHY'].includes(String(error?.code || ''))
      ) crashCommandTab(input, error.code);
      if (error && typeof error === 'object') {
        error.requestId = queueRequestId;
        error.command = command;
        const errorTab = tabs.get(String(input.tabId || activeTabId || ''));
        error.sessionId = String(errorTab?.session?.sessionId || '');
        error.generation = Number(errorTab?.session?.generation) || 0;
        error.phase = 'error';
      }
      throw error;
    });
  }

  let shutdownPromise = null;
  async function shutdown({ timeoutMs = 3_000 } = {}) {
    if (shutdownPromise) return shutdownPromise;
    const limit = Math.max(1, Number(timeoutMs) || 3_000);
    shutdownPromise = (async () => {
      const tabIds = [...tabs.keys()];
      let gracefulClosed = false;
      const closeAll = Promise.allSettled(tabIds.map((tabId) => close(tabId)))
        .finally(() => { gracefulClosed = true; });
      let timer;
      try {
        await Promise.race([
          closeAll,
          new Promise((resolve) => { timer = setTimeout(resolve, limit); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      // A hung Sidecar must never hold Electron shutdown open. The graceful
      // close removes a tab before it awaits the native process, so inspecting
      // tabs alone is insufficient here; use the process-tree sweep when the
      // bounded graceful pass did not finish.
      if (!gracefulClosed) await forceCloseAll().catch(() => undefined);
      else for (const tab of [...tabs.values()]) await forceClose(tab.tabId).catch(() => undefined);
      await Promise.resolve(
        typeof cefRuntime.shutdown === 'function'
          ? cefRuntime.shutdown({ timeoutMs: limit })
          : cefRuntime.dispose?.(),
      ).catch(() => undefined);
      return snapshot();
    })().finally(() => {
      shutdownPromise = null;
    });
    return shutdownPromise;
  }

  function dispose() {
    commandQueue.dispose();
    productLinkCommandQueue.dispose();
    followSellerCommandQueue.dispose();
    for (const tab of tabs.values()) {
      clearPinduoduoAutoCapture(tab, { reset: true });
      tab.removeListener?.();
      sessions.removeSession(tab.session?.sessionId);
    }
    tabs.clear();
    cefRuntime.dispose();
    browserOwnerWindow = null;
    hostWindow = null;
  }

  function publishAlipayPaymentEvent(payload = {}) {
    const event = String(payload?.event || '');
    if (!event.startsWith('alipay-payment-')) return;
    const { event: _event, sourceTabId, ...details } = payload;
    const tabId = String(sourceTabId || '');
    const tab = tabs.get(tabId);
    if (tab?.autoOrder && event === 'alipay-payment-verified') {
      tab.autoOrder = {
        ...tab.autoOrder,
        stage: 'completed',
        paused: false,
        paymentConfirmed: true,
        purchaseOrderNumber: tab.purchaseContext?.purchaseOrderNumber || tab.autoOrder.purchaseOrderNumber || '',
        transactionNo: cleanOptionalText(details.transactionNo, 260),
        paymentAccount: cleanOptionalText(details.paymentAccount, 160),
        paymentAmount: Number.isFinite(Number(details.paymentAmount)) ? Number(details.paymentAmount) : tab.autoOrder.paymentAmount,
        updatedAt: new Date().toISOString(),
      };
    } else if (tab?.autoOrder && event === 'alipay-payment-pending') {
      tab.autoOrder = { ...tab.autoOrder, stage: 'payment-pending', updatedAt: new Date().toISOString() };
    } else if (tab?.autoOrder && event === 'alipay-payment-paused') {
      tab.autoOrder = {
        ...tab.autoOrder,
        stage: 'paused',
        paused: true,
        pauseReason: cleanOptionalText(details.message || '支付页需要人工处理', 180),
        updatedAt: new Date().toISOString(),
      };
    }
    if (tab && ['alipay-payment-closed', 'alipay-payment-error'].includes(event)) {
      tab.alipayPaymentRedirectKey = '';
    }
    emit(event, { tabId, ...details });
  }

  function acceptsSender(sender) {
    return Boolean(hostWindow && !hostWindow.isDestroyed?.() && sender === hostWindow.webContents);
  }

  return Object.freeze({
    acceptsSender,
    attachBrowserOwner,
    attachHost,
    closeInteractiveTabs,
    dispatch,
    dispose,
    forceClose,
    forceCloseAll,
    health,
    publishAlipayPaymentEvent,
    purgeOperation: requestPurgeOperation,
    recoverPendingPurges,
    shutdown,
    snapshot,
  });
}


