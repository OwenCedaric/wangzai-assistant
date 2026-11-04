import {
  getInternalBrowserBridge,
  getInternalBrowserLinkErrorMessage,
  normalizeInternalBrowserUrl,
  openInternalBrowserLink,
  openInternalProductLinkParser,
} from '../../../services/internalBrowserLinkClient.js';
import { collectionSourceHomeUrls } from '../constants/collectionPricingRules.js';
import { normalizeCollectedProduct } from '../lib/collectionProductNormalizer.js';
import { assertCollectedProductUsable } from '../lib/collectionProductValidation.js';

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function activeTabOf(state = {}) {
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  return tabs.find((tab) => String(tab.tabId) === String(state.activeTabId))
    || tabs.find((tab) => tab.background !== true)
    || tabs[0]
    || null;
}

const LINK_CAPTURE_TRANSIENT_ERRORS = new Set([
  'PURCHASE_BROWSER_CAPTURE_CONTEXT_NOT_READY',
  'PURCHASE_BROWSER_CAPTURE_EMPTY',
  'PURCHASE_BROWSER_PRODUCT_CAPTURE_INCOMPLETE',
  'COLLECTION_PRODUCT_CAPTURE_INCOMPLETE',
  'PURCHASE_BROWSER_CEF_FAILED',
  'PURCHASE_BROWSER_COMMAND_TIMEOUT',
]);

function commandState(response = {}) {
  if (Array.isArray(response?.state?.tabs)) return response.state;
  if (Array.isArray(response?.tabs)) return response;
  return {};
}

function linkParserTab(state = {}, url = '') {
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  return tabs.find((tab) => tab.browserRole === 'product-link-parser' && tab.requestedUrl === url)
    || [...tabs].reverse().find((tab) => tab.browserRole === 'product-link-parser')
    || null;
}

function productLinkIdentity(value) {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.toLowerCase();
    if (host.endsWith('yangkeduo.com') || host.endsWith('pinduoduo.com')) {
      const id = String(url.searchParams.get('goods_id') || '').trim();
      return id ? `pinduoduo:${id}` : '';
    }
    return '';
  } catch {
    return '';
  }
}

function parserNavigationPending(tab = {}, url = '') {
  const expectedIdentity = productLinkIdentity(url);
  if (!expectedIdentity) return false;
  const actualIdentity = productLinkIdentity(tab.url);
  const sequence = Number(tab.navigationSequence) || 0;
  const completed = Number(tab.navigationCompletedSequence) || 0;
  return tab.loading === true
    || (actualIdentity && actualIdentity !== expectedIdentity)
    || (sequence > 0 && completed < sequence);
}

function captureMatchesRequestedProduct(product = {}, url = '') {
  const expectedIdentity = productLinkIdentity(url);
  if (!expectedIdentity) return true;
  const productId = String(product.sourceProductId || '').trim();
  const sourceIdentity = productLinkIdentity(product.sourceUrl);
  return (productId && `pinduoduo:${productId}` === expectedIdentity)
    || sourceIdentity === expectedIdentity;
}

function errorCode(error) {
  return String(error?.code || error?.message || '').match(/PURCHASE_BROWSER_[A-Z0-9_]+/u)?.[0]
    || String(error?.code || error?.message || '');
}

function platformLabelFromUrl(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (host.endsWith('1688.com') || host.endsWith('alibaba.com')) return '1688';
  if (host.endsWith('taobao.com')) return '淘宝';
  if (host.endsWith('tmall.com')) return '天猫';
  if (host.endsWith('yangkeduo.com') || host.endsWith('pinduoduo.com')) return '拼多多';
  if (host.endsWith('ozon.ru')) return 'Ozon';
  if (host.endsWith('jd.com')) return '京东';
  if (host.endsWith('wildberries.ru')) return 'Wildberries';
  if (host.endsWith('amazon.com')) return 'Amazon';
  if (host.endsWith('temu.com')) return 'Temu';
  if (host.endsWith('aliexpress.com')) return 'AliExpress';
  return '供应商';
}

export async function openCollectionSourceInBrowser({ sourcePlatform = '', sourceUrl = '' } = {}, options = {}) {
  const url = String(sourceUrl || collectionSourceHomeUrls[sourcePlatform] || '').trim();
  if (!url) throw fail('COLLECTION_SOURCE_URL_REQUIRED', '请先填写货源或竞品链接。');
  try {
    return await openInternalBrowserLink(url, options);
  } catch (error) {
    if (!error?.message || error.message === error.code) error.message = getInternalBrowserLinkErrorMessage(error);
    throw error;
  }
}

export async function captureCurrentCollectionProduct({ bridge = getInternalBrowserBridge() } = {}) {
  if (typeof bridge !== 'function') throw fail('PURCHASE_BROWSER_BRIDGE_UNAVAILABLE', '当前窗口未连接内置浏览器。');
  const state = await bridge({ command: 'state' });
  const tab = activeTabOf(state);
  if (!tab?.tabId) throw fail('PURCHASE_BROWSER_TAB_NOT_FOUND', '请先在内置浏览器打开商品详情页。');
  const response = await bridge({ command: 'capture-purchase', tabId: String(tab.tabId) });
  if (response?.ok !== true) throw fail(response?.error?.code || 'PURCHASE_BROWSER_CAPTURE_EMPTY', '当前页面没有读到可用商品信息。');
  const product = normalizeCollectedProduct(response.capture || response.inspection || {});
  assertCollectedProductUsable(product);
  return { product, state: response.state || state, tabId: String(tab.tabId) };
}

export async function collectCollectionProductFromLink(value, {
  bridge = getInternalBrowserBridge(),
  attempts = 12,
  retryDelayMs = 500,
  sleep = (delay) => new Promise((resolve) => globalThis.setTimeout(resolve, delay)),
} = {}) {
  const url = normalizeInternalBrowserUrl(value);
  if (!url) throw fail('COLLECTION_PRODUCT_LINK_INVALID', '请粘贴完整的 http/https 商品链接。');
  if (typeof bridge !== 'function') throw fail('PURCHASE_BROWSER_BRIDGE_UNAVAILABLE', '当前窗口未连接内置浏览器。');

  const opened = await openInternalProductLinkParser(url, { bridge });
  let state = commandState(opened);
  let tab = linkParserTab(state, url);
  if (!tab?.tabId) throw fail('COLLECTION_LINK_TAB_NOT_FOUND', '链接采集浏览器没有成功启动。');

  // The native LoadUrl call commits asynchronously. On a reused hidden parser,
  // capturing immediately can read the previous Pinduoduo product even though
  // the controller already received the new requestedUrl. Wait only when the
  // native state exposes an in-flight navigation fence; old mocks/runtimes that
  // do not expose the sequence fields keep their previous behavior.
  if (parserNavigationPending(tab, url)) {
    const navigationDeadline = Date.now() + 15_000;
    while (Date.now() < navigationDeadline && parserNavigationPending(tab, url)) {
      await sleep(100);
      state = commandState(await bridge({ command: 'state' }));
      tab = linkParserTab(state, url) || tab;
    }
  }

  const boundedAttempts = Math.max(1, Math.min(30, Number(attempts) || 12));
  let lastError = null;
  for (let index = 0; index < boundedAttempts; index += 1) {
    try {
      const response = await bridge({ command: 'capture-purchase', tabId: String(tab.tabId) });
      if (response?.ok !== true) {
        throw fail(response?.error?.code || 'PURCHASE_BROWSER_CAPTURE_EMPTY');
      }
      const product = normalizeCollectedProduct({
        ...(response.capture || response.inspection || {}),
        sourceUrl: response?.capture?.sourceUrl || response?.inspection?.sourceUrl || url,
        platform: response?.capture?.platform || response?.inspection?.platform || platformLabelFromUrl(url),
      });
      try {
        assertCollectedProductUsable(product);
        if (!captureMatchesRequestedProduct(product, url)) {
          throw fail('COLLECTION_PRODUCT_CAPTURE_INCOMPLETE', '商品页面仍在切换，尚未读到当前链接。');
        }
        return { product, state: response.state || state, tabId: String(tab.tabId) };
      } catch (error) {
        lastError = error;
      }
    } catch (error) {
      lastError = error;
      if (!LINK_CAPTURE_TRANSIENT_ERRORS.has(errorCode(error)) || index + 1 >= boundedAttempts) throw error;
    }
    if (index + 1 < boundedAttempts) await sleep(Math.max(50, Number(retryDelayMs) || 500));
    state = commandState(lastError?.state) || state;
    tab = linkParserTab(state, url) || tab;
  }
  throw lastError || fail('PURCHASE_BROWSER_CAPTURE_EMPTY');
}

export function getCollectionBrowserErrorMessage(error) {
  const code = String(error?.code || error?.message || '');
  const messages = {
    COLLECTION_SOURCE_URL_REQUIRED: '请先填写货源或竞品链接。',
    COLLECTION_PRODUCT_LINK_INVALID: '请粘贴完整、有效的商品链接。',
    COLLECTION_LINK_TAB_NOT_FOUND: '链接采集浏览器没有成功启动，请重试。',
    PURCHASE_BROWSER_TAB_NOT_FOUND: '请先在内置浏览器打开商品详情页。',
    PURCHASE_BROWSER_CAPTURE_EMPTY: '当前页面没有读到可用商品信息，请进入商品详情页后重试。',
    PURCHASE_BROWSER_PRODUCT_CAPTURE_INCOMPLETE: '商品页关键资料还没有读取完整，请确认页面加载完成后重试。',
    PURCHASE_BROWSER_PRODUCT_PAGE_REQUIRED: '商品读取页已经进入规格确认或结算流程，请返回商品详情页后重新读取。',
    COLLECTION_PRODUCT_CAPTURE_INCOMPLETE: String(error?.message || '商品资料不完整，本次没有加入采集列表。'),
  };
  return messages[code] || getInternalBrowserLinkErrorMessage(error) || String(error?.message || '内置浏览器操作失败。');
}
