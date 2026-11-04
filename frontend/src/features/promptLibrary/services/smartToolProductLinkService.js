import {
  getInternalBrowserBridge,
  normalizeInternalBrowserUrl,
  openInternalProductLinkParser,
} from '../../../services/internalBrowserLinkClient.js';
import {
  ORDER_CARD_ACQUIRING_RATE,
  OZON_MILEAGE_FEE_RUB,
} from '../../../services/feeCalculationService.js';

export const SMART_TOOL_PRODUCT_LINK_INPUT = '产品链接（可选）';
export const SMART_TOOL_PRODUCT_QUERY_INPUT = '关键词或 SKU';

const PRODUCT_LINK_ROLE = 'product-link-parser';
const TRANSIENT_CAPTURE_CODES = new Set([
  'PURCHASE_BROWSER_CAPTURE_CONTEXT_NOT_READY',
  'PURCHASE_BROWSER_CAPTURE_EMPTY',
  'PURCHASE_BROWSER_CEF_FAILED',
  'PURCHASE_BROWSER_COMMAND_TIMEOUT',
]);
const SUPPORTED_PLATFORMS = Object.freeze([
  { key: '1688', label: '1688', hosts: ['1688.com', 'alibaba.com'] },
  { key: 'taobao', label: '淘宝', hosts: ['taobao.com'] },
  { key: 'tmall', label: '天猫', hosts: ['tmall.com'] },
  { key: 'pinduoduo', label: '拼多多', hosts: ['yangkeduo.com', 'pinduoduo.com'] },
  { key: 'ozon-buyer', label: 'Ozon', hosts: ['ozon.ru'] },
]);

function text(value) {
  return String(value ?? '').trim();
}

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const normalized = text(value).replace(/\s/gu, '').replace(',', '.');
  const match = normalized.match(/-?\d+(?:\.\d+)?/u);
  const parsed = match ? Number(match[0]) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function codeOf(error) {
  const raw = `${text(error?.code)} ${text(error?.message)}`;
  return raw.match(/(?:PURCHASE_BROWSER|OZON_DATA)_[A-Z0-9_]+/u)?.[0] || text(error?.code || error?.message);
}

function hostMatches(hostname, suffix) {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

export function detectSmartToolProductLinkPlatform(value) {
  const normalized = normalizeInternalBrowserUrl(value);
  if (!normalized) return null;
  const hostname = new URL(normalized).hostname.toLowerCase();
  const platform = SUPPORTED_PLATFORMS.find((item) => (
    item.hosts.some((suffix) => hostMatches(hostname, suffix))
  ));
  if (!platform || hostname === 'seller.ozon.ru') return null;
  return { ...platform, url: normalized, hostname };
}

export function ensureSmartToolProductLinkUsageInputs(tool = {}, usageInputs = []) {
  const rows = Array.isArray(usageInputs) ? usageInputs.filter(Boolean) : [];
  if (text(tool?.id) !== 'ozon-product-search') return rows;
  const next = rows.includes(SMART_TOOL_PRODUCT_QUERY_INPUT)
    ? [...rows]
    : [SMART_TOOL_PRODUCT_QUERY_INPUT, ...rows];
  if (!next.includes(SMART_TOOL_PRODUCT_LINK_INPUT)) next.push(SMART_TOOL_PRODUCT_LINK_INPUT);
  return [...new Set(next)].slice(0, 2);
}

export function extractSmartToolProductLink(values = {}) {
  const entries = Object.entries(values && typeof values === 'object' ? values : {});
  const prioritized = [
    ...entries.filter(([label]) => text(label).includes('链接')),
    ...entries.filter(([label]) => !text(label).includes('链接')),
  ];
  for (const [, value] of prioritized) {
    const platform = detectSmartToolProductLinkPlatform(value);
    if (platform) return platform;
  }
  return null;
}

export function buildSmartToolProductLinkSearchValues(values = {}, capture = null) {
  const source = values && typeof values === 'object' ? values : {};
  const next = Object.fromEntries(Object.entries(source).filter(([label, value]) => (
    !text(label).includes('链接') && !detectSmartToolProductLinkPlatform(value)
  )));
  if (Object.values(next).some((value) => text(value))) return next;
  const derived = text(capture?.category) || text(capture?.productTitle) || text(capture?.sourceProductId);
  return derived ? { [SMART_TOOL_PRODUCT_QUERY_INPUT]: derived } : next;
}

function normalizeCommandState(response = {}) {
  if (response?.state?.tabs) return response.state;
  if (response?.tabs) return response;
  return {};
}

function selectParserTab(state = {}, url = '') {
  const tabs = Array.isArray(state?.tabs) ? state.tabs : [];
  const exact = tabs.find((tab) => (
    text(tab?.browserRole) === PRODUCT_LINK_ROLE
    && text(tab?.requestedUrl) === text(url)
  ));
  return exact || [...tabs].reverse().find((tab) => text(tab?.browserRole) === PRODUCT_LINK_ROLE) || null;
}

function normalizeProductCapture(capture = {}, platform = null) {
  return {
    platform: text(capture.platform) || text(platform?.label),
    platformKey: text(platform?.key),
    sourceUrl: text(capture.sourceUrl || capture.pageUrl || platform?.url),
    sourceProductId: text(capture.sourceProductId),
    productTitle: text(capture.productTitle),
    imageUrl: text(capture.imageUrl),
    brand: text(capture.brand),
    category: text(capture.category),
    variant: text(capture.variant),
    price: number(capture.purchasePrice ?? capture.amount),
    currency: text(capture.currency) || (platform?.key === 'ozon-buyer' ? 'RUB' : 'CNY'),
    lengthCm: number(capture.lengthCm),
    widthCm: number(capture.widthCm),
    heightCm: number(capture.heightCm),
    weightKg: number(capture.weightKg),
    packageDimensions: text(capture.packageDimensions),
    packageWeight: text(capture.packageWeight),
    pageType: text(capture.pageType),
    capturedAt: text(capture.capturedAt),
    fieldConfidence: capture.fieldConfidence && typeof capture.fieldConfidence === 'object'
      ? { ...capture.fieldConfidence }
      : {},
  };
}

function productCaptureReady(capture = {}) {
  return capture.pageType === 'product'
    && Boolean(capture.productTitle || capture.sourceProductId || capture.price !== null);
}

export async function parseSmartToolProductLink(value, {
  bridge = getInternalBrowserBridge(),
  accountId = '',
  attempts = 12,
  retryDelayMs = 500,
  sleep = (delay) => new Promise((resolve) => globalThis.setTimeout(resolve, delay)),
} = {}) {
  const platform = detectSmartToolProductLinkPlatform(value);
  if (!platform) {
    const error = new Error('PRODUCT_LINK_PLATFORM_UNSUPPORTED');
    error.code = error.message;
    throw error;
  }
  const opened = await openInternalProductLinkParser(platform.url, { accountId, bridge });
  let state = normalizeCommandState(opened);
  let tab = selectParserTab(state, platform.url);
  if (!tab?.tabId) {
    const error = new Error('PRODUCT_LINK_PARSER_TAB_NOT_FOUND');
    error.code = error.message;
    throw error;
  }

  let best = null;
  let lastInspectionError = null;
  const boundedAttempts = Math.max(1, Math.min(30, Number(attempts) || 12));
  for (let index = 0; index < boundedAttempts; index += 1) {
    let response;
    try {
      response = await bridge({
        command: 'inspect',
        tabId: text(tab.tabId),
        sessionId: text(tab.sessionId),
        generation: Number(tab.generation) || 0,
      });
      lastInspectionError = null;
    } catch (error) {
      lastInspectionError = error;
      if (!TRANSIENT_CAPTURE_CODES.has(codeOf(error)) || index + 1 >= boundedAttempts) throw error;
      await sleep(Math.max(50, Number(retryDelayMs) || 500));
      continue;
    }
    const capture = normalizeProductCapture(response?.inspection || response?.result || {}, platform);
    if (!best || Object.values(capture).filter(Boolean).length > Object.values(best).filter(Boolean).length) best = capture;
    if (productCaptureReady(capture)) return capture;
    if (index + 1 < boundedAttempts) await sleep(Math.max(50, Number(retryDelayMs) || 500));
    state = normalizeCommandState(response) || state;
    tab = selectParserTab(state, platform.url) || tab;
  }
  const error = new Error('PRODUCT_LINK_PARSE_EMPTY');
  error.code = error.message;
  error.capture = best;
  error.causeCode = codeOf(lastInspectionError);
  throw error;
}

function median(values = []) {
  const rows = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

function money(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function commissionPercent(value) {
  const parsed = number(value);
  if (parsed === null || parsed <= 0) return null;
  const percent = parsed <= 1 ? parsed * 100 : parsed;
  return percent <= 100 ? percent : null;
}

function dimensionText(capture = {}) {
  const dimensions = [capture.lengthCm, capture.widthCm, capture.heightCm];
  if (dimensions.every((value) => Number.isFinite(value) && value > 0)) {
    return `${dimensions.join(' × ')} cm`;
  }
  return text(capture.packageDimensions);
}

function packageWeightKg(value) {
  const parsed = number(value);
  if (parsed === null) return null;
  const unit = text(value).toLowerCase();
  if (/(?:mg|毫克)/u.test(unit)) return parsed / 1_000_000;
  if (/(?:^|\s)(?:g|гр|gram)|克|грамм/u.test(unit) && !/(?:kg|кг|千克|килограмм)/u.test(unit)) {
    return parsed / 1_000;
  }
  return parsed;
}

function matchingOzonRecord(records = [], capture = {}) {
  const sourceId = text(capture.sourceProductId);
  if (!sourceId) return null;
  return records.find((record) => [
    record?.id,
    record?.sku,
    record?.productId,
    record?.sourceProductId,
  ].some((value) => text(value) === sourceId)) || null;
}

export function buildSmartToolTargetProductComparison(capture = null, analysis = null) {
  if (!capture) return null;
  const marketAnalysis = analysis && typeof analysis === 'object' ? analysis : {};
  const records = Array.isArray(marketAnalysis.records) ? marketAnalysis.records : [];
  const isOzon = capture.platformKey === 'ozon-buyer' || capture.platform === 'Ozon买家' || capture.platform === 'Ozon';
  const matchedRecord = isOzon ? matchingOzonRecord(records, capture) : null;
  const enrichedCapture = {
    ...capture,
    productTitle: text(capture.productTitle) || text(matchedRecord?.title),
    imageUrl: text(capture.imageUrl) || text(matchedRecord?.imageUrl),
    brand: text(capture.brand) || text(matchedRecord?.brand),
    category: text(capture.category) || text(matchedRecord?.category),
    packageDimensions: text(capture.packageDimensions) || text(matchedRecord?.packageDimensions),
    packageWeight: text(capture.packageWeight) || text(matchedRecord?.packageWeight),
    weightKg: number(capture.weightKg) ?? packageWeightKg(matchedRecord?.packageWeight),
    currency: text(capture.currency) || text(matchedRecord?.currency) || (isOzon ? 'RUB' : 'CNY'),
  };
  const capturedPrice = number(capture.price) ?? (isOzon
    ? number(matchedRecord?.price ?? matchedRecord?.cardPrice ?? matchedRecord?.averagePrice)
    : null);
  const marketPrice = number(marketAnalysis.priceStats?.median);
  const salePriceRub = isOzon && enrichedCapture.currency.toUpperCase() === 'RUB' && capturedPrice !== null
    ? capturedPrice
    : marketPrice;
  const sourceCostCny = !isOzon && enrichedCapture.currency.toUpperCase() === 'CNY' ? capturedPrice : null;
  const commissionRate = median(records.map((record) => commissionPercent(record?.categoryCommission)));
  const commissionRub = salePriceRub !== null && commissionRate !== null
    ? money(salePriceRub * commissionRate / 100)
    : null;
  const acquiringRub = salePriceRub !== null ? money(salePriceRub * ORDER_CARD_ACQUIRING_RATE) : null;
  const platformFeesRub = [commissionRub, acquiringRub, OZON_MILEAGE_FEE_RUB].every((value) => value !== null)
    ? money(commissionRub + acquiringRub + OZON_MILEAGE_FEE_RUB)
    : null;
  const prices = records.map((record) => number(record?.price)).filter((value) => value !== null);
  const pricePercentile = salePriceRub !== null && prices.length
    ? Math.round((prices.filter((price) => price <= salePriceRub).length / prices.length) * 100)
    : null;
  return {
    ...enrichedCapture,
    priceKind: isOzon ? '销售价' : '采购参考价',
    capturedPrice,
    sourceCostCny,
    suggestedSalePriceRub: salePriceRub,
    marketMedianPriceRub: marketPrice,
    marketPricePercentile: pricePercentile,
    dimensions: dimensionText(enrichedCapture),
    commissionPercent: commissionRate,
    estimatedCommissionRub: commissionRub,
    estimatedAcquiringRub: acquiringRub,
    estimatedDeliveryRub: salePriceRub !== null ? OZON_MILEAGE_FEE_RUB : null,
    estimatedPlatformFeesRub: platformFeesRub,
    logisticsEstimateStatus: enrichedCapture.weightKg && dimensionText(enrichedCapture)
      ? '已取得计费尺寸，等待匹配物流线路价格'
      : '还缺少重量或尺寸',
    comparisonStatus: 'ready',
  };
}

export function getSmartToolProductLinkErrorMessage(error) {
  const code = codeOf(error);
  const messages = {
    PRODUCT_LINK_PLATFORM_UNSUPPORTED: '仅支持 Ozon、1688、淘宝、天猫和拼多多商品链接。',
    PRODUCT_LINK_PARSER_TAB_NOT_FOUND: '商品分析服务没有成功启动，请重启软件后重试。',
  PRODUCT_LINK_PARSE_EMPTY: '暂时没有找到商品资料，可能需要先登录对应平台。',
    PURCHASE_BROWSER_EXTERNAL_ACCOUNT_REQUIRED: '请先在设置中添加该采购平台账号。',
    PURCHASE_BROWSER_OZON_BUYER_ACCOUNT_REQUIRED: '请先在设置中添加 Ozon 买家账号。',
    PURCHASE_BROWSER_EXTERNAL_ACCOUNT_PLATFORM_MISMATCH: '链接平台与选择的浏览器账号不一致。',
  };
  return messages[code] || `商品链接解析失败：${code || '未知错误'}`;
}
