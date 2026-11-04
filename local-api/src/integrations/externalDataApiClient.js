const PROVIDER_CONFIG = Object.freeze({
  'seerfar-open-api': Object.freeze({
    defaultBaseUrl: 'https://api.seerfar.cn',
    allowedHosts: Object.freeze(['api.seerfar.cn']),
    authHeader: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  }),
  'linkfox-agent': Object.freeze({
    defaultBaseUrl: 'https://tool-gateway.linkfox.com',
    allowedHosts: Object.freeze(['tool-gateway.linkfox.com']),
    authHeader: (apiKey) => ({ Authorization: apiKey }),
  }),
});

const LINKFOX_OPERATIONS = Object.freeze({
  'seerfar-ozon-category-search': '/seerfar/ozon/categorySearch',
  'seerfar-ozon-keyword-back-search': '/seerfar/ozon/keywordBackSearch',
  'seerfar-ozon-keyword-mining': '/seerfar/ozon/keywordMining',
  'seerfar-ozon-market-keyword-search': '/seerfar/ozon/marketKeywordSearch',
  'seerfar-ozon-product-detail-search': '/seerfar/ozon/productDetailSearch',
  'seerfar-ozon-product-report-search': '/seerfar/ozon/productReportSearch',
  'seerfar-ozon-shop-search': '/seerfar/ozon/shopSearch',
});

function normalizeText(value) {
  return value == null ? '' : String(value).trim();
}

function createExternalIntegrationError(message, code, options = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = options.statusCode || 502;
  error.remoteStatus = options.remoteStatus ?? null;
  error.provider = options.provider || '';
  error.causeCode = options.causeCode || '';
  error.causeName = options.causeName || '';
  error.causeSyscall = options.causeSyscall || '';
  if (options.cause !== undefined) error.cause = options.cause;
  return error;
}

function findNetworkCause(error) {
  let current = error;
  const visited = new Set();
  for (let depth = 0; current && depth < 5 && !visited.has(current); depth += 1) {
    visited.add(current);
    const code = normalizeText(current?.code);
    const syscall = normalizeText(current?.syscall);
    if (code || syscall || depth === 4 || !current?.cause) {
      return {
        code,
        name: normalizeText(current?.name),
        syscall,
      };
    }
    current = current.cause;
  }
  return { code: '', name: '', syscall: '' };
}

function externalNetworkFailureMessage(error, cause = findNetworkCause(error)) {
  const code = cause.code.toUpperCase();
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return `外部接口域名解析失败（${code}）。`;
  if (['ECONNRESET', 'UND_ERR_SOCKET'].includes(code)) return `外部接口连接被重置（${code}）。`;
  if (['ECONNREFUSED'].includes(code)) return `外部接口拒绝连接（${code}）。`;
  if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) {
    return `外部接口连接超时（${code}）。`;
  }
  if (/CERT|TLS|SSL/u.test(code)) return `外部接口 TLS 连接失败（${code}）。`;
  const message = error instanceof Error ? error.message : String(error);
  return `外部接口无法连接：${message || '网络连接失败'}`;
}

function getProviderConfig(integrationType) {
  const type = normalizeText(integrationType);
  const config = PROVIDER_CONFIG[type];
  if (!config) {
    throw createExternalIntegrationError(
      '当前外部服务还没有可调用的后端适配器。',
      'EXTERNAL_INTEGRATION_UNSUPPORTED',
      { statusCode: 400, provider: type },
    );
  }
  return { type, config };
}

export function normalizeExternalIntegrationBaseUrl(integrationType, value) {
  const { type, config } = getProviderConfig(integrationType);
  const candidate = normalizeText(value) || config.defaultBaseUrl;
  let url;
  try {
    url = new URL(candidate.includes('://') ? candidate : `https://${candidate}`);
  } catch {
    throw createExternalIntegrationError('接口网址格式不正确。', 'EXTERNAL_INTEGRATION_BASE_URL_INVALID', {
      statusCode: 400,
      provider: type,
    });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw createExternalIntegrationError(
      '接口网址必须使用 HTTPS，且不能包含账号、密码、查询参数或锚点。',
      'EXTERNAL_INTEGRATION_BASE_URL_INVALID',
      { statusCode: 400, provider: type },
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (!config.allowedHosts.includes(hostname)) {
    throw createExternalIntegrationError(
      `接口网址必须属于 ${config.allowedHosts.join(' 或 ')}。`,
      'EXTERNAL_INTEGRATION_HOST_NOT_ALLOWED',
      { statusCode: 400, provider: type },
    );
  }
  const normalizedPath = url.pathname.replace(/\/+$/u, '');
  return `${url.origin}${normalizedPath === '/' ? '' : normalizedPath}`;
}

function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/u, '')}/${String(path || '').replace(/^\/+/, '')}`;
}

function parseJsonText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { rawMessage: text.slice(0, 1000) };
  }
}

async function requestJson({
  fetchImpl,
  url,
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 15000,
  provider = '',
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: { Accept: 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (text.length > 10 * 1024 * 1024) {
      throw createExternalIntegrationError(
        '外部接口响应超过 10MB 安全上限。',
        'EXTERNAL_INTEGRATION_RESPONSE_TOO_LARGE',
        { provider },
      );
    }
    return { response, payload: parseJsonText(text) };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createExternalIntegrationError('外部接口连接超时。', 'EXTERNAL_INTEGRATION_TIMEOUT', { provider });
    }
    if (normalizeText(error?.code).startsWith('EXTERNAL_INTEGRATION_')) throw error;
    const cause = findNetworkCause(error);
    throw createExternalIntegrationError(
      externalNetworkFailureMessage(error, cause),
      'EXTERNAL_INTEGRATION_NETWORK_FAILED',
      {
        cause: error,
        causeCode: cause.code,
        causeName: cause.name,
        causeSyscall: cause.syscall,
        provider,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

function getRemoteCode(payload) {
  return Number(payload?.code ?? payload?.errcode ?? payload?.statusCode ?? 0) || 0;
}

function getRemoteMessage(payload, fallback = '') {
  return normalizeText(payload?.msg ?? payload?.message ?? payload?.errmsg ?? payload?.error ?? fallback);
}

function assertApiKey(credentials, provider) {
  const apiKey = normalizeText(credentials?.apiKey);
  if (!apiKey) {
    throw createExternalIntegrationError('请先填写并保存 API Key / Token。', 'EXTERNAL_INTEGRATION_API_KEY_REQUIRED', {
      statusCode: 400,
      provider,
    });
  }
  return apiKey;
}

function assertAuthenticatedResponse(response, payload, provider) {
  const remoteCode = getRemoteCode(payload);
  const remoteMessage = getRemoteMessage(payload);
  const balanceInsufficient = remoteCode === 402
    || remoteCode === 8000
    || /(?:limit\s+exhausted|insufficient\s+(?:credit|balance)|积分(?:不足|耗尽|用完))/iu.test(remoteMessage);
  if (balanceInsufficient) {
    throw createExternalIntegrationError(
      remoteMessage || '当前外部接口积分不足。',
      'EXTERNAL_INTEGRATION_BALANCE_INSUFFICIENT',
      { statusCode: 402, remoteStatus: response.status, provider },
    );
  }
  if (response.status === 401 || response.status === 403 || remoteCode === 401 || remoteCode === 403) {
    throw createExternalIntegrationError(
      remoteMessage || 'API Key / Token 无效。',
      'EXTERNAL_INTEGRATION_AUTH_FAILED',
      { statusCode: 401, remoteStatus: response.status, provider },
    );
  }
}

async function testSeerfar({ baseUrl, apiKey, fetchImpl, timeoutMs }) {
  const { response, payload } = await requestJson({
    fetchImpl,
    url: joinUrl(baseUrl, '/open-api/quota'),
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs,
    provider: 'seerfar-open-api',
  });
  assertAuthenticatedResponse(response, payload, 'seerfar-open-api');
  if (!response.ok || (getRemoteCode(payload) && getRemoteCode(payload) !== 200)) {
    throw createExternalIntegrationError(
      getRemoteMessage(payload, `Seerfar 返回 HTTP ${response.status}`),
      'EXTERNAL_INTEGRATION_REMOTE_FAILED',
      { remoteStatus: response.status, provider: 'seerfar-open-api' },
    );
  }
  const quota = payload?.data ?? payload?.quota ?? payload;
  return {
    ok: true,
    status: 'connected',
    message: 'Seerfar API Key 有效，额度接口读取成功。',
    metadata: quota && typeof quota === 'object' ? { quota } : null,
  };
}

async function testLinkFox({ baseUrl, apiKey, fetchImpl, timeoutMs }) {
  const { response, payload } = await requestJson({
    fetchImpl,
    url: joinUrl(baseUrl, LINKFOX_OPERATIONS['seerfar-ozon-shop-search']),
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: {},
    timeoutMs,
    provider: 'linkfox-agent',
  });
  assertAuthenticatedResponse(response, payload, 'linkfox-agent');
  const remoteCode = getRemoteCode(payload);
  if (response.status === 402 || remoteCode === 402) {
    return {
      ok: true,
      status: 'limited',
      message: 'LinkFox API Key 有效，但当前积分或套餐不足。',
      metadata: { balanceLimited: true },
    };
  }
  if (response.status >= 500) {
    throw createExternalIntegrationError(
      getRemoteMessage(payload, `LinkFox 返回 HTTP ${response.status}`),
      'EXTERNAL_INTEGRATION_REMOTE_FAILED',
      { remoteStatus: response.status, provider: 'linkfox-agent' },
    );
  }
  return {
    ok: true,
    status: 'connected',
    message: 'LinkFox API Key 已通过网关鉴权；测试未查询商品，不消耗业务查询积分。',
    metadata: { validationOnly: true },
  };
}

export async function testExternalDataApiConnection(profile = {}, credentials = {}, options = {}) {
  const { type, config } = getProviderConfig(profile.integrationType ?? profile.integration_type);
  const baseUrl = normalizeExternalIntegrationBaseUrl(type, credentials.baseUrl || config.defaultBaseUrl);
  const apiKey = assertApiKey(credentials, type);
  const params = {
    baseUrl,
    apiKey,
    fetchImpl: options.fetchImpl || fetch,
    timeoutMs: options.timeoutMs || 15000,
  };
  const result = type === 'seerfar-open-api'
    ? await testSeerfar(params)
    : await testLinkFox(params);
  return { ...result, provider: type, baseUrl, testedAt: new Date().toISOString() };
}

const SEERFAR_MARKET_RANGE_FIELDS = Object.freeze([
  'price',
  'monthlySales',
  'monthlyRevenue',
  'weight',
  'volume',
  'reviews',
  'ratings',
  'searchVolume',
  'searchChange30',
  'sellers',
  'products',
  'productViews',
  'conversionSharing',
  'marketSpace',
]);

const SEERFAR_MARKET_SORT_FIELDS = new Set([
  'searchVolume',
  'avgPrice',
  'sales',
  'revenue',
  'count30GrowthRate',
  'productCount',
  'sellers',
  'competingProducts',
  'reviews',
  'ratings',
  'marketSpace',
  'itemsViews',
  'conversionSharing',
  'returnCancellationRate',
  'weight',
  'volume',
]);

const SEERFAR_KEYWORD_MINING_RANGE_FIELDS = Object.freeze([
  'uniqQueriesWCa',
  'relevancy',
  'searchVolume',
  'ca',
  'products',
  'wordCount',
  'titleDensity',
  'price',
  'sellers',
  'adRivalCount',
  'productViews',
  'conversionSharing',
  'searchChange30',
  'marketSpace',
]);

const SEERFAR_KEYWORD_MINING_SORT_FIELDS = new Set([
  'uniqQueriesWCa',
  'ca',
  'searchVolume',
  'count30GrowthRate',
  'relevancy',
  'titleDensity',
  'wordCount',
  'avgPrice',
  'competingProducts',
  'productCount',
  'sellers',
  'adRivalCount',
  'itemsViews',
  'marketSpace',
  'conversionSharing',
  'returnCancellationRate',
]);

const SEERFAR_PRODUCT_RANGE_FIELDS = Object.freeze([
  'reviewCount',
  'drr',
  'reviewRating',
  'questionsAndAnswers',
  'price',
  'monthlyRevenue',
  'monthlySales',
  'monthlySalesRate',
  'weight',
  'volume',
  'grossMargin',
  'variants',
  'convToCartPdp',
  'returnCancellationRate',
]);

const SEERFAR_PRODUCT_SORT_FIELDS = new Set([
  'revenue',
  'price',
  'sales',
  'grossMargin',
  'views',
  'sessionCountSearch',
  'sessionCount',
  'convToCartPdp',
  'orderConversionRate',
  'drr',
  'returnCancellationRate',
  'missedRevenue',
  'variants',
  'reviewCount',
  'reviewRating',
  'upTime',
  'weight',
  'volume',
  'questionsAndAnswers',
]);

const SEERFAR_KEYWORD_BACK_RANGE_FIELDS = Object.freeze([
  'uniqQueriesWCa',
  'ca',
  'searchVolume',
  'searchChange30',
  'naturalRank',
  'adRank',
  'titleDensity',
  'wordCount',
  'products',
  'adRivalCount',
  'productViews',
  'conversionSharing',
  'sellers',
  'exposure',
  'conversion',
  'marketSpace',
]);

const SEERFAR_KEYWORD_BACK_SORT_FIELDS = new Set([
  'exposure',
  'conversion',
  'uniqQueriesWCa',
  'ca',
  'searchVolume',
  'count30GrowthRate',
  'naturalRank',
  'adRank',
  'titleDensity',
  'wordCount',
  'competingProducts',
  'productCount',
  'sellers',
  'adRivalCount',
  'itemsViews',
  'marketSpace',
  'conversionSharing',
  'returnCancellationRate',
]);

function invalidSeerfarMarketInput(message) {
  return createExternalIntegrationError(
    message,
    'EXTERNAL_INTEGRATION_INPUT_INVALID',
    { statusCode: 400, provider: 'seerfar-open-api' },
  );
}

function normalizeSeerfarNumber(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) throw invalidSeerfarMarketInput(`${label}必须是数字。`);
  return normalized;
}

function normalizeSeerfarRange(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidSeerfarMarketInput(`${label}必须使用 min/max 范围格式。`);
  }
  const min = normalizeSeerfarNumber(value.min, `${label}最小值`);
  const max = normalizeSeerfarNumber(value.max, `${label}最大值`);
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min > max) {
    throw invalidSeerfarMarketInput(`${label}最小值不能大于最大值。`);
  }
  return {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
}

function normalizeSeerfarStringList(value, label) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw invalidSeerfarMarketInput(`${label}必须是数组。`);
  const normalized = value.map(normalizeText).filter(Boolean);
  if (normalized.length > 1000) throw invalidSeerfarMarketInput(`${label}最多 1000 项。`);
  return normalized;
}

function normalizeSeerfarNumberList(value, label, { maxItems = 1000 } = {}) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw invalidSeerfarMarketInput(`${label}必须是数组。`);
  if (value.length > maxItems) throw invalidSeerfarMarketInput(`${label}最多 ${maxItems} 项。`);
  return value.map((item) => {
    const normalized = Number(item);
    if (!Number.isInteger(normalized)) throw invalidSeerfarMarketInput(`${label}只能包含整数。`);
    return normalized;
  });
}

function normalizeSeerfarEnumNumber(value, label, allowedValues) {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = Number(value);
  if (!allowedValues.includes(normalized)) {
    throw invalidSeerfarMarketInput(`${label}只能是 ${allowedValues.join('、')}。`);
  }
  return normalized;
}

function copySeerfarRanges(input, body, fields) {
  for (const field of fields) {
    const range = normalizeSeerfarRange(input[field], field);
    if (range) body[field] = range;
  }
}

function copySeerfarStringLists(input, body, fields) {
  for (const [field, label = field] of fields) {
    const values = normalizeSeerfarStringList(input[field], label);
    if (values !== undefined) body[field] = values;
  }
}

function normalizeSeerfarPage(pageInput, { label, sortFields, defaultSortField }) {
  if (!pageInput || typeof pageInput !== 'object' || Array.isArray(pageInput)) {
    throw invalidSeerfarMarketInput(`${label}需要 page 分页参数。`);
  }
  const pageNumber = Number(pageInput.pageNumber ?? pageInput.page ?? 1);
  const pageSize = Number(pageInput.pageSize ?? 20);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw invalidSeerfarMarketInput('page.pageNumber 必须是大于 0 的整数。');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw invalidSeerfarMarketInput('page.pageSize 必须是 1-100 的整数。');
  }

  const orderInput = Array.isArray(pageInput.orders) && pageInput.orders.length
    ? pageInput.orders
    : [{ field: defaultSortField, direction: 'DESC' }];
  const orders = orderInput.map((item) => {
    const field = normalizeText(item?.field);
    const direction = normalizeText(item?.direction).toUpperCase();
    if (!sortFields.has(field)) {
      throw invalidSeerfarMarketInput(`${label}不支持按 ${field || '空字段'} 排序。`);
    }
    if (!['ASC', 'DESC'].includes(direction)) {
      throw invalidSeerfarMarketInput('page.orders.direction 只能是 ASC 或 DESC。');
    }
    return { field, direction };
  });
  return { pageNumber, pageSize, orders };
}

function normalizeSeerfarBrand(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidSeerfarMarketInput('品牌筛选必须是对象。');
  }
  const type = normalizeSeerfarEnumNumber(value.type ?? 0, '品牌筛选类型', [0, 1, 2]);
  const brandName = normalizeSeerfarStringList(value.brandName ?? [], '品牌名称');
  return { type, brandName };
}

function toSeerfarProductSearchRequest(input = {}, {
  label,
  mode,
  defaultSortField = 'revenue',
} = {}) {
  const body = {
    page: normalizeSeerfarPage(input.page, {
      label,
      sortFields: SEERFAR_PRODUCT_SORT_FIELDS,
      defaultSortField,
    }),
  };
  copySeerfarRanges(input, body, SEERFAR_PRODUCT_RANGE_FIELDS);

  if (mode === 'shop') {
    const id = normalizeSeerfarNumber(input.id, '店铺 ID');
    if (!Number.isInteger(id)) throw invalidSeerfarMarketInput('Seerfar 店铺商品查询需要整数店铺 ID。');
    body.id = id;
  }
  if (mode === 'category') {
    const categoryId = normalizeText(input.categoryId);
    if (!categoryId) throw invalidSeerfarMarketInput('Seerfar 类目商品查询需要类目 ID。');
    body.categoryId = categoryId;
    const date = normalizeText(input.date);
    if (date) {
      if (!/^\d{4}-\d{2}$/u.test(date)) throw invalidSeerfarMarketInput('date 必须使用 YYYY-MM 格式。');
      body.date = date;
    }
    const fulfillment = normalizeText(input.fulfillment);
    if (fulfillment) {
      if (!['OZON', 'FBO', 'FBS', 'RFBS', 'FBP'].includes(fulfillment)) {
        throw invalidSeerfarMarketInput('配送方式必须是 OZON、FBO、FBS、RFBS 或 FBP。');
      }
      body.fulfillment = fulfillment;
    }
  }

  copySeerfarStringLists(input, body, [
    ['keywords', '关键词'],
    ['sellerName', '卖家名称'],
    ...(mode === 'category' ? [] : [['fulfillment', '配送方式']]),
    ...(mode === 'category' ? [] : [['categoryIds', '类目 ID']]),
  ]);

  const skus = normalizeSeerfarNumberList(input.skus, 'SKU', { maxItems: 10 });
  if (skus !== undefined) body.skus = skus;
  const labels = normalizeSeerfarNumberList(input.labels, '商品标签', { maxItems: 3 });
  if (labels !== undefined) {
    if (labels.some((value) => ![0, 1, 2].includes(value))) {
      throw invalidSeerfarMarketInput('商品标签只能是 0、1、2。');
    }
    body.labels = labels;
  }

  const brand = normalizeSeerfarBrand(input.brand);
  if (brand) body.brand = brand;
  const creationDate = normalizeSeerfarEnumNumber(input.creationDate, '上架时间', [1, 3, 6, 12, 24]);
  if (creationDate !== undefined) body.creationDate = creationDate;
  if (mode === 'report') {
    const variationsMerge = normalizeSeerfarEnumNumber(input.variationsMerge, '变体合并', [0, 1]);
    if (variationsMerge !== undefined) body.variationsMerge = variationsMerge;
    const searchDate = normalizeText(input.searchDate);
    if (searchDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(searchDate)) {
        throw invalidSeerfarMarketInput('searchDate 必须使用 YYYY-MM-DD 格式。');
      }
      body.searchDate = searchDate;
    }
  }

  const tag = normalizeText(input.tag);
  if (tag) body.tag = tag;
  if (typeof input.filterRemoveProduct === 'boolean') body.filterRemoveProduct = input.filterRemoveProduct;
  return body;
}

function toSeerfarProductDetailRequest(input = {}) {
  const sku = normalizeText(input.sku);
  if (!/^\d+$/u.test(sku)) throw invalidSeerfarMarketInput('Seerfar 商品详情查询需要数字 SKU。');
  const dateRange = normalizeText(input.dateRange) || 'past_30_days';
  const allowedDateRanges = [
    'past_7_days',
    'past_30_days',
    'past_60_days',
    'past_90_days',
    'past_180_days',
    'past_365_days',
  ];
  if (!allowedDateRanges.includes(dateRange)) {
    throw invalidSeerfarMarketInput('商品详情日期范围不受支持。');
  }
  return { sku, dateRange };
}

function toSeerfarMarketKeywordSearchRequest(input = {}) {
  const page = normalizeSeerfarPage(input.page, {
    label: 'Seerfar 市场热词搜索',
    sortFields: SEERFAR_MARKET_SORT_FIELDS,
    defaultSortField: 'searchVolume',
  });

  const body = {
    page,
  };
  for (const field of SEERFAR_MARKET_RANGE_FIELDS) {
    const range = normalizeSeerfarRange(input[field], field);
    if (range) body[field] = range;
  }

  const categories = normalizeSeerfarStringList(input.categories, '类目');
  if (categories !== undefined) body.categories = categories;
  const keywords = normalizeSeerfarStringList(input.keywords, '关键词');
  if (keywords !== undefined) body.keywords = keywords;

  if (input.matchType !== undefined && input.matchType !== null && input.matchType !== '') {
    const matchType = Number(input.matchType);
    if (![0, 1].includes(matchType)) {
      throw invalidSeerfarMarketInput('matchType 只能是 0（精准）或 1（模糊）。');
    }
    body.matchType = matchType;
  }

  const searchDate = normalizeText(input.searchDate);
  if (searchDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(searchDate)) {
      throw invalidSeerfarMarketInput('searchDate 必须使用 YYYY-MM-DD 格式。');
    }
    body.searchDate = searchDate;
  }
  const uId = normalizeText(input.uId);
  if (uId) body.uId = uId;
  const memberId = normalizeText(input.memberId);
  if (memberId) body.memberId = memberId;
  return body;
}

function toSeerfarKeywordMiningRequest(input = {}) {
  const keyword = normalizeText(input.keyword);
  if (!keyword) throw invalidSeerfarMarketInput('Seerfar 关键词挖掘需要俄语种子词。');
  if (keyword.length > 1000) throw invalidSeerfarMarketInput('Seerfar 关键词最长 1000 个字符。');

  const body = {
    keyword,
    page: normalizeSeerfarPage(input.page, {
      label: 'Seerfar 关键词挖掘',
      sortFields: SEERFAR_KEYWORD_MINING_SORT_FIELDS,
      defaultSortField: 'relevancy',
    }),
  };
  for (const field of SEERFAR_KEYWORD_MINING_RANGE_FIELDS) {
    const range = normalizeSeerfarRange(input[field], field);
    if (range) body[field] = range;
  }

  const includeKeywords = normalizeSeerfarStringList(input.includeKeywords, '包含关键词');
  if (includeKeywords !== undefined) body.includeKeywords = includeKeywords;
  const excludeKeywords = normalizeSeerfarStringList(input.excludeKeywords, '排除关键词');
  if (excludeKeywords !== undefined) body.excludeKeywords = excludeKeywords;

  if (input.matchType !== undefined && input.matchType !== null && input.matchType !== '') {
    const matchType = Number(input.matchType);
    if (![0, 1].includes(matchType)) {
      throw invalidSeerfarMarketInput('matchType 只能是 0（精准）或 1（模糊）。');
    }
    body.matchType = matchType;
  }
  return body;
}

function toSeerfarKeywordBackSearchRequest(input = {}) {
  const skuIds = normalizeSeerfarNumberList(input.skuIds, '反查 SKU', { maxItems: 20 });
  if (!skuIds?.length) throw invalidSeerfarMarketInput('Seerfar 关键词反查至少需要一个 SKU。');
  const hasVariant = normalizeSeerfarEnumNumber(input.hasVariant, '是否剔除变体', [0, 1]);
  if (hasVariant === undefined) throw invalidSeerfarMarketInput('Seerfar 关键词反查需要 hasVariant。');

  const body = {
    skuIds,
    hasVariant,
    page: normalizeSeerfarPage(input.page, {
      label: 'Seerfar 关键词反查',
      sortFields: SEERFAR_KEYWORD_BACK_SORT_FIELDS,
      defaultSortField: 'exposure',
    }),
  };
  copySeerfarRanges(input, body, SEERFAR_KEYWORD_BACK_RANGE_FIELDS);
  copySeerfarStringLists(input, body, [
    ['includeKeywords', '包含关键词'],
    ['excludeKeywords', '排除关键词'],
    ['type', '关键词类型'],
  ]);
  if (body.type?.some((value) => !['0', '1'].includes(value))) {
    throw invalidSeerfarMarketInput('关键词类型只能是 0 或 1。');
  }

  const matchType = normalizeSeerfarEnumNumber(input.matchType, '关键词匹配模式', [0, 1]);
  if (matchType !== undefined) body.matchType = matchType;
  const historyDate = normalizeText(input.historyDate);
  if (historyDate) {
    if (!/^\d{4}-\d{2}$/u.test(historyDate)) {
      throw invalidSeerfarMarketInput('historyDate 必须使用 YYYY-MM 格式。');
    }
    body.historyDate = historyDate;
  }
  return body;
}

const SEERFAR_DIRECT_OPERATIONS = Object.freeze({
  'ozon-shop-search': Object.freeze({
    path: '/open-api/shop/detail/search/ozon',
    transform: (input) => toSeerfarProductSearchRequest(input, {
      label: 'Seerfar 店铺商品查询',
      mode: 'shop',
      defaultSortField: 'sales',
    }),
  }),
  'seerfar-ozon-shop-search': Object.freeze({
    path: '/open-api/shop/detail/search/ozon',
    transform: (input) => toSeerfarProductSearchRequest(input, {
      label: 'Seerfar 店铺商品查询',
      mode: 'shop',
      defaultSortField: 'sales',
    }),
  }),
  'seerfar-ozon-product-detail-search': Object.freeze({
    path: '/open-api/product/detail/search/ozon',
    transform: toSeerfarProductDetailRequest,
  }),
  'seerfar-ozon-category-search': Object.freeze({
    path: '/open-api/category/detail/search/ozon',
    transform: (input) => toSeerfarProductSearchRequest(input, {
      label: 'Seerfar 类目商品查询',
      mode: 'category',
      defaultSortField: 'revenue',
    }),
  }),
  'seerfar-ozon-product-report-search': Object.freeze({
    path: '/open-api/productReport/search/ozon',
    transform: (input) => toSeerfarProductSearchRequest(input, {
      label: 'Seerfar 商品筛选',
      mode: 'report',
      defaultSortField: 'revenue',
    }),
  }),
  'seerfar-ozon-market-keyword-search': Object.freeze({
    path: '/open-api/market/search/ozon',
    transform: toSeerfarMarketKeywordSearchRequest,
  }),
  'seerfar-ozon-keyword-mining': Object.freeze({
    path: '/open-api/keyword/mining/ozon',
    transform: toSeerfarKeywordMiningRequest,
  }),
  'seerfar-ozon-keyword-back-search': Object.freeze({
    path: '/open-api/keyword/backSearch/ozon',
    transform: toSeerfarKeywordBackSearchRequest,
  }),
});

const SEERFAR_PAID_CAPABILITIES = Object.freeze({
  'ozon-shop-search': 'external.seerfar.shop',
  'seerfar-ozon-shop-search': 'external.seerfar.shop',
  'seerfar-ozon-product-detail-search': 'external.seerfar.product-detail',
  'seerfar-ozon-category-search': 'external.seerfar.category',
  'seerfar-ozon-product-report-search': 'external.seerfar.product-report',
  'seerfar-ozon-market-keyword-search': 'external.seerfar.market-keyword',
  'seerfar-ozon-keyword-mining': 'external.seerfar.keyword-mining',
  'seerfar-ozon-keyword-back-search': 'external.seerfar.keyword-back',
});

export function preparePaidSeerfarRead(request = {}) {
  const operation = normalizeText(request.operation);
  const descriptor = SEERFAR_DIRECT_OPERATIONS[operation];
  const capability = SEERFAR_PAID_CAPABILITIES[operation];
  if (!descriptor || !capability) {
    throw createExternalIntegrationError(
      '当前操作未在内置积分查询白名单中。',
      'EXTERNAL_INTEGRATION_OPERATION_NOT_ALLOWED',
      { statusCode: 400, provider: 'seerfar-open-api' },
    );
  }
  const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input)
    ? request.input
    : {};
  return Object.freeze({
    capability,
    operation,
    requestBody: descriptor.transform(input),
  });
}

export async function callExternalDataApi(profile = {}, credentials = {}, request = {}, options = {}) {
  const { type, config } = getProviderConfig(profile.integrationType ?? profile.integration_type);
  const baseUrl = normalizeExternalIntegrationBaseUrl(type, credentials.baseUrl || config.defaultBaseUrl);
  const apiKey = assertApiKey(credentials, type);
  const operation = normalizeText(request.operation);
  const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input)
    ? request.input
    : {};
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || 120000;
  let call;

  const seerfarOperation = type === 'seerfar-open-api' ? SEERFAR_DIRECT_OPERATIONS[operation] : null;
  if (seerfarOperation) {
    call = {
      url: joinUrl(baseUrl, seerfarOperation.path),
      method: 'POST',
      headers: { ...config.authHeader(apiKey), 'Content-Type': 'application/json' },
      body: seerfarOperation.transform(input),
    };
  } else if (type === 'linkfox-agent' && LINKFOX_OPERATIONS[operation]) {
    call = {
      url: joinUrl(baseUrl, LINKFOX_OPERATIONS[operation]),
      method: 'POST',
      headers: { ...config.authHeader(apiKey), 'Content-Type': 'application/json' },
      body: input,
    };
  } else {
    throw createExternalIntegrationError(
      '当前操作未在后端只读接口白名单中。',
      'EXTERNAL_INTEGRATION_OPERATION_NOT_ALLOWED',
      { statusCode: 400, provider: type },
    );
  }

  const { response, payload } = await requestJson({ fetchImpl, timeoutMs, provider: type, ...call });
  assertAuthenticatedResponse(response, payload, type);
  const remoteCode = getRemoteCode(payload);
  const remoteBusinessFailure = remoteCode !== 0 && remoteCode !== 200;
  if (!response.ok || remoteBusinessFailure) {
    const balanceInsufficient = remoteCode === 402 || remoteCode === 8000;
    const publicStatusCode = !response.ok
      ? response.status
      : balanceInsufficient
        ? 402
        : 502;
    throw createExternalIntegrationError(
      getRemoteMessage(payload, `外部接口返回 HTTP ${response.status}`),
      balanceInsufficient ? 'EXTERNAL_INTEGRATION_BALANCE_INSUFFICIENT' : 'EXTERNAL_INTEGRATION_REMOTE_FAILED',
      { statusCode: publicStatusCode, remoteStatus: response.status, provider: type },
    );
  }
  return { ok: true, provider: type, operation, data: payload };
}

export function createExternalDataApiErrorPayload(error) {
  const diagnostic = createExternalDataApiDiagnostic(error);
  return {
    ok: false,
    error: {
      code: error?.code || 'EXTERNAL_INTEGRATION_FAILED',
      message: error instanceof Error ? error.message : String(error),
      status: error?.remoteStatus ?? null,
      provider: error?.provider || '',
      retryable: error?.code === 'EXTERNAL_INTEGRATION_NETWORK_FAILED',
      diagnostic: {
        causeCode: diagnostic.causeCode,
        causeName: diagnostic.causeName,
        causeSyscall: diagnostic.causeSyscall,
      },
    },
  };
}

export function createExternalDataApiDiagnostic(error, request = {}) {
  const page = Number(request?.input?.page?.page ?? request?.input?.page?.pageNumber);
  return {
    code: normalizeText(error?.code) || 'EXTERNAL_INTEGRATION_FAILED',
    provider: normalizeText(error?.provider),
    remoteStatus: error?.remoteStatus ?? null,
    causeCode: normalizeText(error?.causeCode),
    causeName: normalizeText(error?.causeName),
    causeSyscall: normalizeText(error?.causeSyscall),
    operation: normalizeText(request?.operation),
    page: Number.isInteger(page) && page > 0 ? page : null,
  };
}
