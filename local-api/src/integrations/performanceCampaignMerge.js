import { firstText, normalizeLowerText, normalizeMetricNumber, normalizeText } from "./performanceApiNormalization.js";
import {
  buildCampaignStatisticResponses,
  buildCampaignStatisticsAvailability,
  buildDailyTrend,
  calculateCpc,
  calculateCtr,
  groupPerformanceStatisticsByCampaign,
  mergePerformanceTrendRows,
  PERFORMANCE_CAMPAIGN_STATISTIC_METRICS,
  readCampaignMetricFromSources,
  readSingleProductCampaignMetric,
  resolvePerformanceBudgetRemaining,
  resolvePerformanceBudgetStatus,
  sumMetric,
} from "./performanceCampaignMetrics.js";
import { buildPerformanceObjectsFromProducts, getPerformanceStatusLabel } from "./performanceCampaignNormalization.js";

export function mergeCampaignObjectProductDetails(objects = [], products = []) {
  const productByKey = new Map();
  for (const product of products) {
    const keys = [
      product.sku,
      product.offerId,
      firstText(product.raw, ["id", "objectId", "object_id", "advObjectId"]),
    ];
    for (const key of keys.map(normalizeText).filter(Boolean)) {
      productByKey.set(key, product);
    }
  }
  return objects.map((object) => {
    const product = [object.sku, object.offerId, object.objectId]
      .map(normalizeText)
      .filter(Boolean)
      .map((key) => productByKey.get(key))
      .find(Boolean);
    if (!product) return object;

    const objectTitle = firstText(object.raw, [
      "title",
      "name",
      "objectTitle",
      "productName",
    ]);
    const objectStatus = firstText(object.raw, [
      "status",
      "state",
      "moderationStatus",
      "moderation_status",
    ]);
    const objectType = firstText(object.raw, [
      "type",
      "objectType",
      "object_type",
      "advObjectType",
      "adv_object_type",
    ]);
    return {
      ...object,
      sku: object.sku || product.sku,
      offerId: object.offerId || product.offerId,
      title: objectTitle || product.title || object.title,
      type: objectType ? object.type : "商品",
      typeCode: objectType || "SKU",
      status: objectStatus || product.status || object.status,
      statusLabel: objectStatus
        ? object.statusLabel
        : product.statusLabel || object.statusLabel,
      statusSource: objectStatus
        ? "campaign-object"
        : product.statusSource || "unavailable",
      bid: object.bid ?? product.bid,
      reviewReason: object.reviewReason || product.reviewReason,
      reviewReasonState:
        object.reviewReason || product.reviewReason ? "returned" : "empty",
      impressions: product.impressions ?? null,
      clicks: product.clicks ?? null,
      spent: product.spent ?? null,
      orders: product.orders ?? null,
      revenue: product.revenue ?? null,
      ctr: product.ctr ?? null,
      cpc: product.cpc ?? null,
      acos: product.acos ?? null,
      roas: product.roas ?? null,
      statisticsSource: product.statisticsSource || "",
      productMatched: true,
    };
  });
}

export function getPerformanceProductIdentityCandidates(row = {}) {
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
  return [
    ...new Set(
      [
        row?.sku,
        row?.sourceSku,
        row?.productId,
        row?.product_id,
        row?.offerId,
        row?.offer_id,
        raw.sku,
        raw.ozonSku,
        raw.ozon_sku,
        raw.productSku,
        raw.product_sku,
        raw.sourceSku,
        raw.source_sku,
        raw.productId,
        raw.product_id,
        raw.ozonProductId,
        raw.ozon_product_id,
        raw.offerId,
        raw.offer_id,
        raw.vendorCode,
        raw.vendor_code,
        raw.article,
      ]
        .map(normalizeText)
        .filter(Boolean),
    ),
  ];
}

export function appendPerformanceIdentityOwner(index, key, ownerKey) {
  if (!key) return;
  const current = index.get(key) || new Set();
  current.add(ownerKey);
  index.set(key, current);
}

export function createPerformanceProductStatisticsMatcher({
  campaigns = [],
  productsByCampaign = new Map(),
  productStats = [],
} = {}) {
  const campaignIdentityOwners = new Map();
  const globalIdentityOwners = new Map();
  const rowsByOwner = new Map();
  const knownCampaignIds = new Set(
    campaigns.map((campaign) => normalizeText(campaign?.id)).filter(Boolean),
  );

  for (const campaign of campaigns) {
    const campaignId = normalizeText(campaign?.id);
    const products = productsByCampaign.get(campaign?.id) || [];
    products.forEach((product, index) => {
      const ownerKey = `${campaignId}\u0000${index}`;
      for (const identity of getPerformanceProductIdentityCandidates(product)) {
        appendPerformanceIdentityOwner(
          campaignIdentityOwners,
          `${campaignId}\u0000${identity}`,
          ownerKey,
        );
        appendPerformanceIdentityOwner(
          globalIdentityOwners,
          identity,
          ownerKey,
        );
      }
    });
  }

  for (const stat of productStats) {
    const identities = getPerformanceProductIdentityCandidates(stat);
    if (!identities.length) continue;
    const campaignId = normalizeText(stat?.campaignId);
    const candidateOwners = new Set();
    if (campaignId && knownCampaignIds.has(campaignId)) {
      for (const identity of identities) {
        for (const ownerKey of campaignIdentityOwners.get(
          `${campaignId}\u0000${identity}`,
        ) || []) {
          candidateOwners.add(ownerKey);
        }
      }
    } else {
      for (const identity of identities) {
        for (const ownerKey of globalIdentityOwners.get(identity) || []) {
          candidateOwners.add(ownerKey);
        }
      }
    }
    if (candidateOwners.size !== 1) continue;
    const [ownerKey] = candidateOwners;
    const current = rowsByOwner.get(ownerKey) || [];
    current.push(stat);
    rowsByOwner.set(ownerKey, current);
  }

  return {
    getRows(campaignId, productIndex) {
      return (
        rowsByOwner.get(`${normalizeText(campaignId)}\u0000${productIndex}`) ||
        []
      );
    },
  };
}

export function mergeCampaignRealtimeDetails({
  campaigns,
  productsByCampaign,
  objectsByCampaign,
  deriveObjectsFromProducts = false,
  dailyStats,
  campaignProductStats,
  expenseStats,
  mediaStats,
  asyncStats,
  productStats,
  statisticResponses,
  dateRange,
  now = new Date(),
}) {
  const campaignStatsMap = groupPerformanceStatisticsByCampaign(dailyStats);
  const campaignProductStatsMap =
    groupPerformanceStatisticsByCampaign(campaignProductStats);
  const expenseStatsMap = groupPerformanceStatisticsByCampaign(expenseStats);
  const mediaStatsMap = groupPerformanceStatisticsByCampaign(mediaStats);
  const asyncStatsMap = groupPerformanceStatisticsByCampaign(asyncStats);
  const productStatisticsMatcher = createPerformanceProductStatisticsMatcher({
    campaigns,
    productsByCampaign,
    productStats,
  });
  const campaignProductStatisticsMatcher =
    createPerformanceProductStatisticsMatcher({
      campaigns,
      productsByCampaign,
      productStats: campaignProductStats,
    });
  return campaigns.map((campaign) => {
    const products = productsByCampaign.get(campaign.id) || [];
    const campaignStats = campaignStatsMap.get(campaign.id) || [];
    const campaignProductRows = campaignProductStatsMap.get(campaign.id) || [];
    const expenseRows = expenseStatsMap.get(campaign.id) || [];
    const mediaRows = mediaStatsMap.get(campaign.id) || [];
    const asyncRows = asyncStatsMap.get(campaign.id) || [];
    // A single campaign can be absent from the daily endpoint while the
    // campaign/product or expense endpoint still returns an authoritative
    // record (including a real numeric zero). Resolve every metric field by
    // source priority instead of dropping those returned rows.
    const campaignMetricSources = [
      { key: "daily", rows: campaignStats },
      { key: "campaignProduct", rows: campaignProductRows },
      { key: "media", rows: mediaRows },
      { key: "async", rows: asyncRows },
      { key: "expense", rows: expenseRows },
    ];
    const metricResults = Object.fromEntries(
      PERFORMANCE_CAMPAIGN_STATISTIC_METRICS.map((key) => [
        key,
        readCampaignMetricFromSources(
          campaignMetricSources,
          key,
          campaign[key],
        ),
      ]),
    );
    const statisticsAvailability = buildCampaignStatisticsAvailability({
      sources: campaignMetricSources,
      sourceResponses: buildCampaignStatisticResponses(
        campaign,
        statisticResponses,
      ),
    });
    const primaryRows = campaignStats.length
      ? campaignStats
      : campaignProductRows.length
        ? campaignProductRows
        : mediaRows.length
          ? mediaRows
          : asyncRows.length
            ? asyncRows
            : expenseRows;
    const trendRows = mergePerformanceTrendRows(
      campaignStats,
      expenseRows,
      asyncRows.length ? asyncRows : mediaRows,
    );
    const mergedProducts = products.map((product, productIndex) => {
      const authoritativeRows = productStatisticsMatcher.getRows(
        campaign.id,
        productIndex,
      );
      const campaignProductDetailRows =
        campaignProductStatisticsMatcher.getRows(campaign.id, productIndex);
      const rows = authoritativeRows.length
        ? authoritativeRows
        : campaignProductDetailRows;
      const isSingleProductCampaign = products.length === 1;
      const readProductMetric = (key) => {
        if (isSingleProductCampaign) {
          const exactCampaignValue = readSingleProductCampaignMetric(
            metricResults,
            key,
          );
          if (exactCampaignValue !== null) return exactCampaignValue;
        }
        return rows.length
          ? sumMetric(rows, key)
          : normalizeMetricNumber(product[key]);
      };
      const spent = readProductMetric("spent");
      const revenue = readProductMetric("revenue");
      const impressions = readProductMetric("impressions");
      const clicks = readProductMetric("clicks");
      const orders = readProductMetric("orders");
      const usesSingleProductCampaignStatistics =
        isSingleProductCampaign &&
        ["impressions", "clicks", "spent", "orders", "revenue"].some((key) => {
          const source = normalizeText(metricResults?.[key]?.source);
          return Boolean(source) && source !== "campaign";
        });
      const returnedStatusRow = [
        ...authoritativeRows,
        ...campaignProductDetailRows,
      ].find((row) => normalizeText(row?.status));
      const productHasStatus =
        normalizeText(product.status) &&
        normalizeLowerText(product.status) !== "unknown";
      const rawStatus = productHasStatus
        ? product.status
        : normalizeText(returnedStatusRow?.status) ||
          normalizeText(campaign.status);
      const statusSource = productHasStatus
        ? "campaign-product"
        : normalizeText(returnedStatusRow?.status)
          ? "product-statistics"
          : normalizeText(campaign.status)
            ? "campaign"
            : "unavailable";
      return {
        ...product,
        status: rawStatus || "unknown",
        statusLabel: rawStatus
          ? getPerformanceStatusLabel(normalizeLowerText(rawStatus), rawStatus)
          : product.statusLabel,
        statusSource,
        placement: product.placement || returnedStatusRow?.placement || "",
        strategy: product.strategy || returnedStatusRow?.strategy || "",
        impressions,
        clicks,
        spent,
        orders,
        revenue,
        acos:
          Number.isFinite(spent) && Number.isFinite(revenue) && revenue > 0
            ? Number(((spent / revenue) * 100).toFixed(2))
            : product.acos,
        roas:
          Number.isFinite(spent) && spent > 0 && Number.isFinite(revenue)
            ? Number((revenue / spent).toFixed(2))
            : product.roas,
        ctr: calculateCtr(impressions, clicks),
        cpc: calculateCpc(spent, clicks),
        statisticsRows: rows,
        statisticsSource: usesSingleProductCampaignStatistics
          ? "single-product-campaign"
          : authoritativeRows.length
            ? "product-statistics"
            : campaignProductDetailRows.length
              ? "campaign-product-statistics"
              : "",
        statisticsFieldSources: usesSingleProductCampaignStatistics
          ? Object.fromEntries(
              ["impressions", "clicks", "spent", "orders", "revenue"].map(
                (key) => [key, normalizeText(metricResults?.[key]?.source)],
              ),
            )
          : {},
      };
    });
    const exactObjects = objectsByCampaign?.get(campaign.id) || [];
    const objects = exactObjects.length
      ? mergeCampaignObjectProductDetails(exactObjects, mergedProducts)
      : !deriveObjectsFromProducts || getCampaignObjectsSkipReason(campaign)
        ? []
        : buildPerformanceObjectsFromProducts(mergedProducts, campaign);
    const statSpent = metricResults.spent.value;
    const statRevenue = metricResults.revenue.value;
    const statImpressions = metricResults.impressions.value;
    const statClicks = metricResults.clicks.value;
    const dailyTrend = buildDailyTrend(trendRows);
    const budgetRemaining = resolvePerformanceBudgetRemaining({
      campaign,
      dailyRows: campaignStats,
      dailyResponse: statisticResponses?.daily,
      dateRange,
      now,
    });
    return {
      ...campaign,
      budgetRemaining: budgetRemaining?.value ?? null,
      budgetRemainingSource: budgetRemaining?.source || "unavailable",
      budgetRemainingPeriod: budgetRemaining
        ? {
            kind: budgetRemaining.kind,
            dateFrom: budgetRemaining.periodFrom,
            dateTo: budgetRemaining.periodTo,
            budget: budgetRemaining.budget ?? null,
            spent: budgetRemaining.spent ?? null,
          }
        : null,
      budgetStatus: resolvePerformanceBudgetStatus(campaign, budgetRemaining),
      products: mergedProducts,
      objects,
      productCount: products.length ? products.length : campaign.productCount,
      productCountSource: products.length
        ? "campaign-products"
        : campaign.productCountSource,
      objectCount: objects.length ? objects.length : campaign.objectCount,
      objectCountSource: objects.length
        ? "campaign-objects"
        : campaign.objectCountSource,
      statistics: {
        ...campaign.statistics,
        dateFrom: dateRange.dateFrom,
        dateTo: dateRange.dateTo,
        rows: primaryRows,
        sourceRows: {
          daily: campaignStats,
          campaignProduct: campaignProductRows,
          expense: expenseRows,
          media: mediaRows,
          async: asyncRows,
        },
        fieldSources: Object.fromEntries(
          Object.entries(metricResults).map(([key, result]) => [
            key,
            result.source,
          ]),
        ),
        availability: statisticsAvailability,
        impressions: statImpressions,
        clicks: statClicks,
        spent: statSpent,
        orders: metricResults.orders.value,
        revenue: statRevenue,
        toCart: metricResults.toCart.value,
        bonusSpent: metricResults.bonusSpent.value,
        prepaymentSpent: metricResults.prepaymentSpent.value,
        avgCpm: metricResults.avgCpm.value,
        postViewOrders: metricResults.postViewOrders.value,
        postViewRevenue: metricResults.postViewRevenue.value,
        modelOrders: metricResults.modelOrders.value,
        modelSales: metricResults.modelSales.value,
        budget: metricResults.budget.value,
        weeklyBudget: metricResults.weeklyBudget.value,
        dailyBudget: metricResults.dailyBudget.value,
        clickPrice: metricResults.clickPrice.value,
        acos:
          Number.isFinite(statSpent) &&
          Number.isFinite(statRevenue) &&
          statRevenue > 0
            ? Number(((statSpent / statRevenue) * 100).toFixed(2))
            : readCampaignMetricFromSources(
                campaignMetricSources,
                "acos",
                campaign.statistics?.acos,
              ).value,
        roas:
          Number.isFinite(statSpent) &&
          statSpent > 0 &&
          Number.isFinite(statRevenue)
            ? Number((statRevenue / statSpent).toFixed(2))
            : readCampaignMetricFromSources(
                campaignMetricSources,
                "roas",
                campaign.statistics?.roas,
              ).value,
        ctr:
          calculateCtr(statImpressions, statClicks) ??
          readCampaignMetricFromSources(
            campaignMetricSources,
            "ctr",
            campaign.statistics?.ctr,
          ).value,
        cpc:
          calculateCpc(statSpent, statClicks) ??
          readCampaignMetricFromSources(
            campaignMetricSources,
            "cpc",
            campaign.statistics?.cpc,
          ).value,
        dailyTrend,
      },
    };
  });
}

export function summarizeCampaigns(campaigns = []) {
  const total = campaigns.length;
  const running = campaigns.filter(
    (item) => item.statusLabel === "运行中",
  ).length;
  const paused = campaigns.filter(
    (item) => item.statusLabel === "已暂停",
  ).length;
  const finished = campaigns.filter(
    (item) => item.statusLabel === "已结束",
  ).length;
  const reviewFailed = campaigns.filter(
    (item) => item.alerts?.moderationRejected,
  ).length;
  const budgetExhausted = campaigns.filter(
    (item) => item.alerts?.budgetExhausted,
  ).length;
  const returnedProductKeys = new Set();
  let productsWithoutStableIdentity = 0;
  campaigns.forEach((campaign) => {
    const products = Array.isArray(campaign?.products) ? campaign.products : [];
    if (!products.length) return;
    products.forEach((product) => {
      const sku = normalizeText(
        product?.sku || product?.ozonSku || product?.ozon_sku,
      );
      const productId = normalizeText(
        product?.productId || product?.product_id,
      );
      const offerId = normalizeText(product?.offerId || product?.offer_id);
      const identity = sku
        ? `sku:${sku}`
        : productId
          ? `product:${productId}`
          : offerId
            ? `offer:${offerId}`
            : "";
      if (identity) returnedProductKeys.add(identity);
      else productsWithoutStableIdentity += 1;
    });
  });
  // The same Ozon SKU can belong to several campaigns. Count the distinct
  // promoted product once, matching the product page instead of summing
  // campaign assignments.
  const productCount = returnedProductKeys.size
    ? returnedProductKeys.size + productsWithoutStableIdentity
    : total === 0
      ? 0
      : null;
  const sum = (key) =>
    campaigns.reduce((result, item) => {
      const value = normalizeMetricNumber(item.statistics?.[key] ?? item[key]);
      return value === null ? result : (result ?? 0) + value;
    }, null);
  const spent = sum("spent");
  const revenue = sum("revenue");
  const advertisingRoi =
    Number.isFinite(spent) && spent > 0 && Number.isFinite(revenue)
      ? Number((revenue / spent).toFixed(2))
      : null;
  return {
    total,
    running,
    paused,
    finished,
    reviewFailed,
    budgetExhausted,
    productCount,
    spent,
    impressions: sum("impressions"),
    clicks: sum("clicks"),
    orders: sum("orders"),
    revenue,
    acos:
      Number.isFinite(spent) && Number.isFinite(revenue) && revenue > 0
        ? Number(((spent / revenue) * 100).toFixed(2))
        : null,
    roi: advertisingRoi,
    roas: advertisingRoi,
    ctr: calculateCtr(sum("impressions"), sum("clicks")),
    cpc: calculateCpc(spent, sum("clicks")),
  };
}

export function getCampaignCapabilityText(campaign = {}) {
  return normalizeLowerText(
    [
      campaign.status,
      campaign.statusLabel,
      campaign.title,
      campaign.typeCode,
      campaign.type,
      campaign.paymentType,
      campaign.raw?.state,
      campaign.raw?.status,
      campaign.raw?.advObjectType,
      campaign.raw?.paymentType,
      campaign.raw?.productCampaignMode,
      campaign.raw?.campaignType,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

export function isRetiredPerformanceCampaign(campaign = {}) {
  return /campaign_state_(?:archived|finished)|(?:^|\s)(?:archived|finished)(?:\s|$)|已归档|已结束/u.test(
    getCampaignCapabilityText(campaign),
  );
}

export function isSearchPromoPerformanceCampaign(campaign = {}) {
  return /search[_-]?promo|all[_-]?sku[_-]?promo|(?:^|\s)cpo(?:\s|$)|оплата\s+за\s+заказ|order\s+payment/u.test(
    getCampaignCapabilityText(campaign),
  );
}

export function getCampaignObjectsSkipReason(campaign = {}) {
  if (isRetiredPerformanceCampaign(campaign)) {
    return "已归档或已结束计划不再请求投放对象明细";
  }
  if (isSearchPromoPerformanceCampaign(campaign)) {
    return "搜索推广计划改由搜索推广商品接口读取";
  }
  return "";
}
