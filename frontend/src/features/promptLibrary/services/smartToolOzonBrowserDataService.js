import { runSmartToolDraft } from './smartToolDraftService.js';
import { normalizeMarketRecord } from '../../dataAnalysis/lib/dataAnalysisMarketRecordMapper.js';
import {
  canUseSmartToolOzonBrowserDataProfile,
  getSmartToolOzonBrowserDataProfile,
  SMART_TOOL_OZON_BROWSER_DATA_PROFILES,
  usesActiveOzonProductQueryProfile,
} from '../lib/smartToolOzonBrowserDataProfiles.js';
import {
  buildOzonQueryTokens,
  normalizeOzonQueryText,
} from '../../../services/ozonSearch/ozonSearchQueryResolver.js';
import { analyzeOzonProductRecords } from '../lib/smartToolOzonProductAnalysis.js';
import { buildSmartToolOzonSnapshotSections } from '../lib/smartToolOzonSnapshotResultFormatter.js';
import {
  getOzonBrowserCaptureErrorMessage,
  readOzonBrowserCaptureSnapshot,
} from '../../../services/ozonBrowserCaptureClient.js';
import { buildOzonProductPageUrl } from '../../../services/ozonProductPageLink.js';
import { searchOzonProductsFromInput } from '../../../services/ozonSearch/ozonProductSearchService.js';
import {
  buildSmartToolProductLinkSearchValues,
  buildSmartToolTargetProductComparison,
  extractSmartToolProductLink,
  getSmartToolProductLinkErrorMessage,
  parseSmartToolProductLink,
} from './smartToolProductLinkService.js';

export { SMART_TOOL_OZON_BROWSER_DATA_PROFILES } from '../lib/smartToolOzonBrowserDataProfiles.js';

const MAX_RESULT_RECORDS = 1000;

function text(value) {
  return String(value ?? '').trim();
}

function compactQueryPlan(queryPlan = {}) {
  const source = queryPlan && typeof queryPlan === 'object' ? queryPlan : {};
  return {
    queryMode: text(source.queryMode),
    matchSource: text(source.matchSource),
    confidence: text(source.confidence),
    categoryPath: text(source.categoryMatch?.pathText),
    categoryName: text(source.categoryMatch?.name),
    catalogHydrated: source.catalogHydrated === true,
  };
}

function recordSearchText(record = {}) {
  return normalizeOzonQueryText([
    record.id,
    record.title,
    record.category,
    record.category1,
    record.category2,
    record.category3,
    record.brand,
    record.seller,
    record.article,
    record.link,
    record.feature,
    record.price,
    record.cardPrice,
    record.sales,
    record.revenue,
    record.stock,
    record.article,
    record.feature,
  ].map(text).join(' '));
}

function compactRecord(record = {}, dataset = '', sequence = 0, capturedAt = '', endpoint = '') {
  // 商品搜索和数据分析必须共用同一套 Ozon 字段语义，避免搜索卡片再次丢掉
  // 毛子插件验证过的广告、流量、履约、尺寸和跟卖字段。
  const normalized = normalizeMarketRecord(record, dataset, sequence, capturedAt, endpoint);
  const source = { ...record, ...normalized };
  const value = (...keys) => keys.map((key) => source?.[key]).find((candidate) => (
    candidate !== undefined && candidate !== null && candidate !== ''
  )) ?? null;
  const compact = {
    dataset: text(normalized.dataset || dataset),
    id: value('id', 'productId', 'sku', 'skuId'),
    title: value('title', 'productName', 'name'),
    category: value('category', 'category3', 'category3Name', 'nicheName'),
    category1: value('category1', 'category1Name'),
    category2: value('category2', 'category2Name'),
    category3: value('category3', 'category3Name'),
    brand: value('brand', 'brandName'),
    seller: value('seller', 'sellerName'),
    article: value('article', 'vendorCode'),
    imageUrl: value('imageUrl', 'photo', 'photoUrl', 'picture'),
    link: value('link', 'productPageUrl', 'productUrl'),
    feature: value('feature'),
    price: value('price', 'currentPrice', 'averagePrice', 'avgPrice'),
    averagePrice: value('averagePrice', 'avgPrice'),
    cardPrice: value('cardPrice', 'ozonCardPrice', 'priceWithCard'),
    cardPriceCurrency: value('cardPriceCurrency'),
    discount: value('discount', 'discountPercent'),
    rating: value('rating', 'score'),
    reviews: value('reviews', 'reviewCount'),
    orders: value('orders', 'orderCount', 'ordersCount'),
    sales: value('sales', 'monthlySalesUnits', 'salesUnits', ...(dataset === 'missing-items' ? ['totalItems'] : [])),
    orderedProducts: value('orderedProducts'),
    productCount: value('productCount', ...(dataset === 'missing-items' ? [] : ['totalItems', 'itemsCount'])),
    revenue: value('revenue', 'gmv', 'gmvSum', 'monthlySalesRevenue', 'salesRevenue'),
    orderAmount: value('orderAmount'),
    stock: value('stock', 'balance'),
    views: value('views', 'viewCount'),
    conversion: value('conversion', 'conversionRate'),
    growth: value('growth', 'gmvGrowth', 'salesDynamics'),
    dynamics: value('dynamics'),
    averageDailyRevenue: value('averageDailyRevenue', ...(dataset === 'missing-items' ? ['adsDays'] : [])),
    averageDailyUnits: value('averageDailyUnits', ...(dataset === 'missing-items' ? ['adqDays'] : [])),
    averagePurchasePrice: value('averagePurchasePrice'),
    searchPosition: value('searchPosition'),
    previousSales: value('previousSales', 'previousSalesUnits'),
    previousRevenue: value('previousRevenue'),
    revenuePotential: value('revenuePotential'),
    lostProfit: value('lostProfit'),
    lostProfitPercent: value('lostProfitPercent'),
    adSpendShare: value('adSpendShare'),
    promoDays: value('promoDays'),
    promoDiscount: value('promoDiscount'),
    promoRevenueShare: value('promoRevenueShare'),
    paidPromotionDays: value('paidPromotionDays'),
    productCardViews: value('productCardViews'),
    productCardToCartRate: value('productCardToCartRate'),
    searchCatalogViews: value('searchCatalogViews'),
    searchCatalogToCartRate: value('searchCatalogToCartRate'),
    impressionToOrderRate: value('impressionToOrderRate'),
    clickThroughRate: value('clickThroughRate'),
    fulfillmentModel: value('fulfillmentModel'),
    redemptionRate: value('redemptionRate'),
    returnCancelRate: value('returnCancelRate'),
    packageDimensions: value('packageDimensions'),
    packageWeight: value('packageWeight'),
    listedAt: value('listedAt'),
    listingDays: value('listingDays'),
    followSellerCount: value('followSellerCount'),
    followMinPrice: value('followMinPrice'),
    followMaxPrice: value('followMaxPrice'),
    rfbsRate: value('rfbsRate'),
    fbpRate: value('fbpRate'),
    categoryCommission: value('categoryCommission'),
    categoryIds: value('categoryIds'),
    currency: value('currency', 'currencyCode'),
    deliveryScheme: value('deliveryScheme'),
    firstDate: value('firstDate'),
    updated: value('updated'),
  };
  if (!compact.link) compact.link = buildOzonProductPageUrl(compact) || null;
  return compact;
}

function recordKey(record = {}) {
  const identity = text(record.id) || text(record.title);
  if (identity) return identity;
  return JSON.stringify(record);
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function mergeRecordFields(latest = {}, fallback = {}) {
  const merged = { ...latest };
  for (const [key, value] of Object.entries(fallback)) {
    if (!hasValue(merged[key]) && hasValue(value)) merged[key] = value;
  }
  return merged;
}

export function canUseSmartToolOzonBrowserData(toolOrId = '') {
  return canUseSmartToolOzonBrowserDataProfile(toolOrId);
}

export function buildSmartToolOzonBrowserResult({
  toolId,
  datasets = [],
  catalog = {},
  values = {},
  observerVersion = '',
  tabId = '',
  captureMode = '',
  query = '',
  serverQueryMatched = false,
  queryPlan = null,
  followSellerCoverage = null,
} = {}) {
  const profile = SMART_TOOL_OZON_BROWSER_DATA_PROFILES[text(toolId)];
  if (!profile) return null;
  const accepted = new Set(profile.datasets);
  const selectedDatasets = (Array.isArray(datasets) ? datasets : [])
    .filter((dataset) => accepted.has(text(dataset?.dataset)))
    .filter((dataset) => text(dataset?.quality) === 'confirmed-data')
    .sort((left, right) => (Number(right?.sequence) || 0) - (Number(left?.sequence) || 0));
  const recordsByKey = new Map();
  for (const dataset of selectedDatasets) {
    for (const sourceRecord of Array.isArray(dataset?.records) ? dataset.records : []) {
      const record = compactRecord(
        sourceRecord,
        dataset.dataset,
        dataset.sequence,
        dataset.capturedAt,
        dataset.endpoint,
      );
      const key = recordKey(record);
      const previous = recordsByKey.get(key);
      recordsByKey.set(key, previous ? mergeRecordFields(previous, record) : record);
    }
  }
  const records = [...recordsByKey.values()];

  const queryValues = Object.values(values).map(text).filter(Boolean);
  const { tokens, aliases: queryAliases } = buildOzonQueryTokens(values);
  const matchedRecords = serverQueryMatched
    ? records
    : tokens.length
      ? records.filter((record) => tokens.some((token) => recordSearchText(record).includes(token)))
      : records;
  const queryMatched = serverQueryMatched || !tokens.length || matchedRecords.length > 0;
  const outputRecords = (serverQueryMatched || queryMatched ? matchedRecords : records)
    .slice(0, MAX_RESULT_RECORDS);
  const newestCaptureAt = selectedDatasets
    .map((dataset) => text(dataset.capturedAt))
    .filter(Boolean)
    .sort()
    .at(-1) || '';
  const endpointCount = Math.max(0, Number(catalog?.endpointCount) || 0);
  const datasetLabels = [...new Set(selectedDatasets.map((dataset) => text(dataset.dataset)).filter(Boolean))];

  if (!selectedDatasets.length || !records.length) {
    const wasActiveSearch = captureMode === 'product-search';
    return {
      status: 'browser_data_empty',
      statusLabel: '插件在线，暂无匹配数据',
      summary: wasActiveSearch
        ? `${profile.label}已执行后台查询，但 Ozon 没有返回可用的商品数据。`
        : `${profile.label}没有读到已捕获的真实数据。请先在内置浏览器打开对应 Ozon 分析页面并完成一次查询。`,
      sections: [
        {
          title: '当前插件状态',
          rows: [
            `观察器版本：${text(observerVersion) || '未知'}`,
            `已发现接口：${endpointCount} 个`,
            `本 Skill 需要：${profile.datasets.join(' / ')}`,
            wasActiveSearch && query ? `本次查询：${query}` : '',
          ].filter(Boolean),
        },
      ],
      missingInputs: [],
      integrationNeeds: [],
      nextActions: wasActiveSearch
        ? ['更换关键词或 SKU 后重试', '确认 Ozon 商品页已登录并返回数据']
        : ['在内置浏览器完成一次对应查询', '返回智能工具重新运行 Skill'],
      browserData: {
        tabId: text(tabId),
        observerVersion: text(observerVersion),
        endpointCount,
        captureMode: text(captureMode),
        query: text(query),
        queryPlan: compactQueryPlan(queryPlan),
        datasetCount: 0,
        recordCount: 0,
        records: [],
      },
    };
  }

  const productAnalysis = analyzeOzonProductRecords(outputRecords, {
    query: text(query) || queryValues.join(' / '),
    capturedAt: newestCaptureAt,
  });

  const followCoverage = followSellerCoverage && typeof followSellerCoverage === 'object'
    ? {
      source: text(followSellerCoverage.source),
      status: text(followSellerCoverage.status) || 'ready',
      totalProductCount: Math.max(0, Number(followSellerCoverage.totalProductCount) || 0),
      requestedCount: Math.max(0, Number(followSellerCoverage.requestedCount) || 0),
      confirmedCount: Math.max(0, Number(followSellerCoverage.confirmedCount) || 0),
      cachedCount: Math.max(0, Number(followSellerCoverage.cachedCount) || 0),
      failedCount: Math.max(0, Number(followSellerCoverage.failedCount) || 0),
      limited: followSellerCoverage.limited === true,
    }
    : null;
  return {
    status: 'browser_data_ready',
    statusLabel: '已使用浏览器插件真实数据',
    summary: captureMode === 'product-search'
      ? `后台查询「${text(query)}」已返回 ${records.length} 条真实商品记录，本次展示 ${outputRecords.length} 条。`
      : `${profile.label}已读取 ${selectedDatasets.length} 组真实响应，去重后 ${records.length} 条，本次返回 ${outputRecords.length} 条。`,
    ...(usesActiveOzonProductQueryProfile(toolId) ? {} : {
      sections: buildSmartToolOzonSnapshotSections({
        observerVersion,
        datasetLabels,
        endpointCount,
        records: outputRecords,
        newestCaptureAt,
        captureMode,
        query,
        tokens,
        queryMatched,
        queryValues,
        queryAliases,
      }),
    }),
    missingInputs: [],
    integrationNeeds: [],
    nextActions: outputRecords.length < records.length
      ? [`当前展示前 ${outputRecords.length} 条，可按 SKU、品牌、类目或关键词缩小范围。`]
      : ['可继续按 SKU、品牌、类目或关键词筛选。'],
    productAnalysis,
    browserData: {
      tabId: text(tabId),
      observerVersion: text(observerVersion),
      endpointCount,
      datasetCount: selectedDatasets.length,
      recordCount: records.length,
      returnedRecordCount: outputRecords.length,
      newestCaptureAt,
      datasets: datasetLabels,
      queryMatched,
      serverQueryMatched: serverQueryMatched === true,
      queryAliases,
      captureMode: text(captureMode),
      query: text(query),
      queryPlan: compactQueryPlan(queryPlan),
      followSellerCoverage: followCoverage,
      records: outputRecords,
    },
  };
}

export async function runSmartToolDraftWithOzonBrowserData(
  tool = {},
  values = {},
  {
    command: commandOverride,
    shopScope = null,
    productSearchOptions = {},
    productSearchRunner = searchOzonProductsFromInput,
    productSearchExecutor,
    productLinkParser = parseSmartToolProductLink,
  } = {},
) {
  const draft = runSmartToolDraft(tool, values, { shopScope });
  if (!canUseSmartToolOzonBrowserData(tool)) return draft;

  try {
    const profile = getSmartToolOzonBrowserDataProfile(tool);
    const activeProductQuery = usesActiveOzonProductQueryProfile(tool);
    let search = { query: '', input: '', aliases: [], queryMode: profile?.queryMode || 'snapshot' };
    let snapshot = null;
    let targetProductCapture = null;
    let productLinkError = null;
    let marketSearchError = null;
    let searchValues = values;
    if (activeProductQuery) {
      const productLink = extractSmartToolProductLink(values);
      if (productLink) {
        try {
          targetProductCapture = await productLinkParser(productLink.url, { bridge: commandOverride });
        } catch (error) {
          productLinkError = error;
        }
        searchValues = buildSmartToolProductLinkSearchValues(values, targetProductCapture);
      }
      try {
        const productSearch = await productSearchRunner(searchValues, {
          queryMode: profile.queryMode,
          categoryTreeLoader: productSearchOptions.categoryTreeLoader,
          loadCategoryCatalog: productSearchOptions.loadCategoryCatalog,
          catalogTimeoutMs: productSearchOptions.catalogTimeoutMs,
          searchExecutor: productSearchExecutor,
          captureOptions: {
            ...productSearchOptions,
            command: commandOverride,
          },
        });
        search = productSearch?.queryPlan || search;
        snapshot = productSearch?.snapshot || null;
      } catch (error) {
        if (!targetProductCapture) throw error;
        marketSearchError = error;
        const fallbackInput = Object.values(searchValues || {}).map(text).find(Boolean) || '';
        search = { ...search, input: fallbackInput, query: fallbackInput };
        snapshot = {
          datasets: [],
          catalog: {},
          captureMode: 'product-search',
          query: fallbackInput,
        };
      }
    } else {
      snapshot = await readOzonBrowserCaptureSnapshot({ command: commandOverride });
    }
    snapshot ||= {
      datasets: [],
      catalog: {},
      captureMode: activeProductQuery ? 'product-search' : '',
      query: search.input,
    };
    const result = buildSmartToolOzonBrowserResult({
      toolId: tool.id,
      datasets: snapshot.datasets,
      catalog: snapshot.catalog,
      values: searchValues,
      observerVersion: snapshot.observerVersion,
      tabId: snapshot.tabId,
      captureMode: snapshot.captureMode,
      query: snapshot.query || search.input,
      serverQueryMatched: snapshot.serverQueryMatched === true,
      queryPlan: search,
      followSellerCoverage: snapshot.followSellerCoverage,
    });
    const targetProduct = buildSmartToolTargetProductComparison(targetProductCapture, result?.productAnalysis);
    const productLinkStatus = targetProductCapture
      ? { status: 'ready', message: '商品资料已解析。' }
      : productLinkError
        ? { status: 'error', message: getSmartToolProductLinkErrorMessage(productLinkError) }
        : null;
    return {
      ...draft,
      result: {
        ...result,
        ...(targetProduct ? { targetProduct } : {}),
        ...(productLinkStatus ? { productLinkStatus } : {}),
        ...(marketSearchError ? {
          marketSearchWarning: getOzonBrowserCaptureErrorMessage(marketSearchError),
        } : {}),
      },
    };
  } catch (error) {
    console.error('[智能工具] Ozon 浏览器查询失败', {
      code: text(error?.code || error?.message || 'OZON_BROWSER_QUERY_FAILED'),
      message: text(error?.message || ''),
    });
    return {
      ...draft,
      result: {
        status: 'browser_data_error',
        statusLabel: 'Ozon 浏览器数据读取失败',
        summary: getOzonBrowserCaptureErrorMessage(error),
        sections: [
          {
            title: '处理办法',
            rows: [
              '确认设置里存在已登录的 Ozon 内置浏览器账号。',
              '保持后台专用浏览器可用，再重新运行 Skill。',
              '本次只执行 Ozon 商品只读查询，不写入商品、订单或库存。',
            ],
          },
        ],
        missingInputs: [],
        integrationNeeds: [],
        nextActions: ['打开 Ozon 内置浏览器', '完成一次对应查询', '重新运行 Skill'],
        errorCode: text(error?.code || error?.message),
      },
    };
  }
}
