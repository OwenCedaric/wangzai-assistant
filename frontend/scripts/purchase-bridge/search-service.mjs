const FAST_1688_IMAGE_TIMEOUT_MS = 8_000;
const FAST_1688_TOKEN_TIMEOUT_MS = 6_000;
const FAST_1688_REQUEST_TIMEOUT_MS = 10_000;
const FAST_1688_HTML_FALLBACK_TIMEOUT_MS = 4_000;
const ANONYMOUS_1688_TOKEN_TTL_MS = 10 * 60 * 1000;

let anonymous1688TokenCache = null;
let anonymous1688TokenRequest = null;

async function fetchText(url, timeoutMs = 12000, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': PURCHASE_SEARCH_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...extraHeaders,
      },
      redirect: 'follow',
    });
    if (!response.ok) {
      return { ok: false, status: response.status, text: '' };
    }
    return { ok: true, status: response.status, text: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, text: '', error };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPurchaseSearchResource(url, options = {}, stage = '搜款请求') {
  try {
    const response = await fetch(url, options);
    return response;
  } catch (error) {
    const message = /timeout|aborted/i.test(String(error?.message || error))
      ? `${stage}超时，请稍后重试。`
      : `${stage}失败，请稍后重试。`;
    throw new Error(message, { cause: error });
  }
}

function purchaseSearchHeaders(referer = 'https://s.1688.com/') {
  return {
    Accept: 'application/json,text/plain,*/*',
    Referer: referer,
    'User-Agent': PURCHASE_SEARCH_USER_AGENT,
  };
}

function purchaseSearchCookieHeader(cookies = []) {
  return cookies
    .map((item) => String(item || '').split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function purchaseSearchTokenFromCookies(cookies = []) {
  const cookie = cookies.find((item) => /^_m_h5_tk=/i.test(String(item || ''))) || '';
  const match = String(cookie).match(/_m_h5_tk=([^_;]+)/i);
  return match?.[1] || '';
}

// PURCHASE_PDD_1688_PROVIDER_FREEZE:BEGIN
function invalidateAnonymous1688Token() {
  anonymous1688TokenCache = null;
}

function is1688TokenFailure(error) {
  return /(?:TOKEN|_m_h5_tk|SESSION_EXPIRED|ILLEGAL_ACCESS|令牌)/iu.test(String(error?.message || error || ''));
}

async function requestAnonymous1688Token() {
  const publicAppKey = '12574478';
  const api = 'mtop.ovs.traffic.landing.seotaglist.queryHotSearchWord';
  const endpoint = new URL(`https://h5api.m.1688.com/h5/${api.toLowerCase()}/1.0/`);
  endpoint.searchParams.set('jsv', '2.7.2');
  endpoint.searchParams.set('appKey', publicAppKey);
  endpoint.searchParams.set('t', String(Date.now()));
  endpoint.searchParams.set('api', api);
  endpoint.searchParams.set('v', '1.0');
  endpoint.searchParams.set('type', 'json');
  endpoint.searchParams.set('dataType', 'jsonp');
  endpoint.searchParams.set('callback', 'mtopjsonp1');
  endpoint.searchParams.set('preventFallback', 'true');
  endpoint.searchParams.set('data', '{}');

  const response = await fetchPurchaseSearchResource(endpoint, {
    headers: purchaseSearchHeaders('https://www.1688.com/'),
    signal: AbortSignal.timeout(FAST_1688_TOKEN_TIMEOUT_MS),
  }, '1688 识图令牌获取');
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const token = purchaseSearchTokenFromCookies(cookies);
  if (!response.ok || !token) throw new Error('1688 识图令牌获取失败。');
  return { apiKey: publicAppKey, token, cookies };
}

async function getAnonymous1688Token() {
  if (anonymous1688TokenCache?.expiresAt > Date.now()) {
    return anonymous1688TokenCache.value;
  }
  if (!anonymous1688TokenRequest) {
    anonymous1688TokenRequest = requestAnonymous1688Token()
      .then((value) => {
        anonymous1688TokenCache = {
          value,
          expiresAt: Date.now() + ANONYMOUS_1688_TOKEN_TTL_MS,
        };
        return value;
      })
      .finally(() => {
        anonymous1688TokenRequest = null;
      });
  }
  return anonymous1688TokenRequest;
}

async function call1688ImageSearchMtop(tokenState, params = {}, stage = '1688 识图请求') {
  const api = 'mtop.relationrecommend.wirelessrecommend.recommend';
  const timestamp = Date.now();
  const payload = JSON.stringify({
    appId: 32517,
    params: JSON.stringify(params),
  });
  const endpoint = new URL(`https://h5api.m.1688.com/h5/${api}/2.0/`);
  endpoint.searchParams.set('jsv', '2.7.2');
  endpoint.searchParams.set('appKey', tokenState.apiKey);
  endpoint.searchParams.set('t', String(timestamp));
  endpoint.searchParams.set('api', api);
  endpoint.searchParams.set('ecode', '0');
  endpoint.searchParams.set('v', '2.0');
  endpoint.searchParams.set('type', 'originaljson');
  endpoint.searchParams.set('dataType', 'jsonp');
  endpoint.searchParams.set('sign', md5(`${tokenState.token}&${timestamp}&${tokenState.apiKey}&${payload}`));

  const response = await fetchPurchaseSearchResource(endpoint, {
    method: 'POST',
    headers: {
      ...purchaseSearchHeaders('https://s.1688.com/youyuan/index.htm?tab=imageSearch'),
      Origin: 'https://s.1688.com',
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: purchaseSearchCookieHeader(tokenState.cookies),
    },
    body: new URLSearchParams({ data: payload }),
    signal: AbortSignal.timeout(FAST_1688_REQUEST_TIMEOUT_MS),
  }, stage);
  const text = await response.text();
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = { text };
  }
  if (!response.ok) throw new Error(`${stage}失败，状态码 ${response.status}。`);
  const retText = asArray(raw?.ret).join(' ');
  if (retText && !/SUCCESS/i.test(retText)) throw new Error(`1688 识图返回错误：${retText}`);
  return raw;
}

async function request1688ImageMatches(buffer, tokenState) {
  const imageBase64 = buffer.toString('base64');
  const pageSize = 24;
  const uploadResponse = await call1688ImageSearchMtop(tokenState, {
    beginPage: 1,
    pageSize,
    searchScene: 'pcImageSearch',
    method: 'uploadBase64WithRequest',
    appName: 'pctusou',
    imageBase64,
    sortType: 'normal',
  }, '1688 识图上传图片');
  const imageId = firstPresent(uploadResponse?.data?.data?.imageId, uploadResponse?.data?.imageId);
  if (!imageId) throw new Error('1688 未能识别这张图片。');

  const listResponse = await call1688ImageSearchMtop(tokenState, {
    beginPage: 1,
    pageSize,
    method: 'imageOfferSearchService',
    imageId,
    sortType: 'normal',
    searchScene: 'pcImageSearch',
  }, '1688 识图读取同款列表');
  return { imageId, listResponse };
}

async function request1688ImageMatchesWithTokenRefresh(buffer) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await request1688ImageMatches(buffer, await getAnonymous1688Token());
    } catch (error) {
      lastError = error;
      if (attempt > 0 || !is1688TokenFailure(error)) throw error;
      invalidateAnonymous1688Token();
    }
  }
  throw lastError;
}

export async function search1688ByImage(imageUrl) {
  try {
    const { buffer } = await loadPurchaseSearchImage(imageUrl, {
      timeoutMs: FAST_1688_IMAGE_TIMEOUT_MS,
    });
    const { imageId, listResponse } = await request1688ImageMatchesWithTokenRefresh(buffer);

    const results = [];
    const seen = new Set();
    const offer = listResponse?.data?.data?.OFFER || listResponse?.data?.OFFER || {};
    for (const item of asArray(offer.items)) {
      const normalized = normalize1688SearchResult(item, results.length);
      const key = normalized.offerId || normalized.url || normalized.imageUrl;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(normalized);
    }
    const candidate = selectTitleCandidate(results);
    const searchUrl = `https://s.1688.com/youyuan/index.htm?tab=imageSearch&imageId=${encodeURIComponent(imageId)}&imageIdList=${encodeURIComponent(imageId)}`;
    return {
      provider: '1688',
      providerLabel: '1688 以图搜款',
      imageId,
      searchUrl,
      results,
      searchTitle: normalizeSearchResultTitle(candidate?.title),
      titleSource: candidate || null,
      ok: true,
      status: 200,
    };
  } catch (error) {
    const fallbackUrl = build1688ImageSearchUrl(imageUrl);
    const page = await fetchText(fallbackUrl, FAST_1688_HTML_FALLBACK_TIMEOUT_MS)
      .catch(() => ({ ok: false, status: 0, text: '' }));
    const results = page.ok ? extract1688ResultsFromHtml(page.text, fallbackUrl) : [];
    const candidate = selectTitleCandidate(results);
    return {
      provider: '1688',
      providerLabel: '1688 以图搜款',
      searchUrl: fallbackUrl,
      results,
      searchTitle: normalizeSearchResultTitle(candidate?.title),
      titleSource: candidate || null,
      ok: Boolean(results.length),
      status: page.status || 0,
      errorMessage: error?.message || '1688 以图搜款失败。',
    };
  }
}
// PURCHASE_PDD_1688_PROVIDER_FREEZE:END

async function searchTaobaoByImage(imageUrl, platform = 'taobao') {
  const isTmall = /tmall|天猫/i.test(String(platform || ''));
  const provider = isTmall ? 'tmall' : 'taobao';
  const providerLabel = `${isTmall ? '天猫' : '淘宝'}以图搜款`;
  const searchUrl = buildTaobaoImageSearchUrl(imageUrl, provider);
  try {
    const loaded = await loadPurchaseSearchImage(imageUrl);
    return {
      provider,
      providerLabel,
      searchUrl,
      results: [],
      searchTitle: '',
      titleSource: null,
      imageVerified: Boolean(loaded?.buffer?.length),
      imageContentType: loaded?.contentType || '',
      ok: Boolean(loaded?.buffer?.length),
      status: 200,
    };
  } catch (error) {
    return {
      provider,
      providerLabel,
      searchUrl,
      results: [],
      searchTitle: '',
      titleSource: null,
      imageVerified: false,
      ok: false,
      status: 422,
      errorMessage: error?.message || '商品图片读取失败。',
    };
  }
}

export async function handleImageSearch(payload) {
  const imageUrl = normalizeImageUrl(payload.imageUrl);
  if (!imageUrl) {
    return {
      statusCode: 422,
      body: { ok: false, message: '当前商品没有可用于搜款的公网图片。' },
    };
  }
  const platform = String(payload.platform || '1688').toLowerCase();
  const sourceSearch = platform.includes('taobao') || platform.includes('tmall') || platform.includes('淘宝') || platform.includes('天猫')
    ? await searchTaobaoByImage(imageUrl, platform)
    : await search1688ByImage(imageUrl);
  if (!sourceSearch.ok) {
    return {
      statusCode: sourceSearch.status || 422,
      body: {
        ok: false,
        message: sourceSearch.errorMessage || `${sourceSearch.providerLabel || '平台'}未能读取当前商品图片。`,
        imageUrl,
        sourceSearch,
        results: [],
      },
    };
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      externalOnly: true,
      provider: sourceSearch.provider || payload.platform || '1688',
      providerLabel: sourceSearch.providerLabel || '以图搜款',
      imageUrl,
      searchUrl: sourceSearch.searchUrl,
      sourceSearch,
      results: sourceSearch.results,
      message: sourceSearch.results.length
        ? `已用商品图完成${sourceSearch.providerLabel || '平台'}，请人工核对规格和价格。`
        : `已验证当前商品图片并打开${sourceSearch.providerLabel || '平台搜款'}页面，页面将直接按图片搜索。`,
    },
  };
}
import { PURCHASE_SEARCH_USER_AGENT } from './config.mjs';
import { loadPurchaseSearchImage } from './image-proxy.mjs';
import {
  extract1688ResultsFromHtml,
  normalize1688SearchResult,
} from './search-parsers.mjs';
import {
  asArray,
  build1688ImageSearchUrl,
  buildTaobaoImageSearchUrl,
  firstPresent,
  md5,
  normalizeImageUrl,
  normalizeSearchResultTitle,
  selectTitleCandidate,
} from './search-utils.mjs';
