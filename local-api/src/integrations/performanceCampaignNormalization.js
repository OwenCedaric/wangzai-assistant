import {
  firstNumber,
  firstPerformanceBidRubles,
  firstPerformanceBudgetRubles,
  firstText,
  firstValue,
  isPlainObject,
  normalizeLowerText,
  normalizeText,
} from "./performanceApiNormalization.js";
import { calculateCpc, calculateCtr } from "./performanceCampaignMetrics.js";

export function normalizePerformanceCampaign(row = {}, index = 0) {
  const id =
    firstText(row, [
      "id",
      "campaignId",
      "campaign_id",
      "advObjectId",
      "objectId",
    ]) || `campaign-${index + 1}`;
  const title =
    firstText(row, [
      "title",
      "name",
      "campaignName",
      "campaign_name",
      "objectTitle",
    ]) || `广告计划 ${id}`;
  const rawStatus = firstText(row, [
    "state",
    "status",
    "campaignStatus",
    "campaign_status",
    "moderationStatus",
  ]);
  const statusText = [
    rawStatus,
    firstText(row, [
      "statusText",
      "status_text",
      "stateText",
      "state_text",
      "moderationStatus",
      "moderation_status",
      "reason",
      "rejectReason",
      "rejectionReason",
    ]),
  ]
    .filter(Boolean)
    .join(" ");
  const statusLower = normalizeLowerText(statusText);
  const statusLabel = getPerformanceStatusLabel(statusLower, rawStatus);
  const rawType = firstText(row, [
    "advObjectType",
    "type",
    "campaignType",
    "campaign_type",
    "placement",
  ]);
  const typeLabel = getPerformanceCampaignTypeLabel(rawType);
  const rawPlacement = firstText(row, [
    "placement",
    "place",
    "placementType",
    "placement_type",
  ]);
  const rawStrategy = firstText(row, [
    "productAutopilotStrategy",
    "strategy",
    "bidStrategy",
    "bid_strategy",
  ]);
  const budget = firstPerformanceBudgetRubles(row, [
    "budget",
    "totalBudget",
    "total_budget",
    "dailyBudget",
    "daily_budget",
    "weeklyBudget",
    "weekly_budget",
    "budgetLimit",
    "budget_limit",
    "moneyLimit",
    "money_limit",
  ]);
  const spent = firstNumber(row, [
    "spent",
    "moneySpent",
    "money_spent",
    "expense",
    "cost",
    "consumption",
  ]);
  const budgetRemaining = firstPerformanceBudgetRubles(row, [
    "budgetRemaining",
    "budget_remaining",
    "remainingBudget",
    "remaining_budget",
    "budgetLeft",
    "budget_left",
    "balance",
  ]);
  const revenue = firstNumber(row, [
    "revenue",
    "ordersMoney",
    "orders_money",
    "sales",
    "income",
  ]);
  const orders = firstNumber(row, [
    "orders",
    "orderCount",
    "order_count",
    "ordersCount",
  ]);
  const clicks = firstNumber(row, ["clicks", "clickCount", "click_count"]);
  const impressions = firstNumber(row, [
    "views",
    "shows",
    "impressions",
    "viewCount",
  ]);
  const acos = firstNumber(row, ["acos", "drr"]);
  const roas = firstNumber(row, ["roas"]);
  const returnedProductCount = firstNumber(row, [
    "productCount",
    "productsCount",
    "skuCount",
  ]);
  const returnedObjectCount = firstNumber(row, [
    "objectCount",
    "objectsCount",
  ]);
  return {
    id,
    title,
    type: typeLabel,
    typeLabel,
    typeCode: rawType || "unknown",
    paymentType: firstText(row, ["PaymentType", "paymentType", "payment_type"]),
    placement: getPerformancePlacementLabel(rawPlacement),
    placementCode: rawPlacement || "unknown",
    strategy: getPerformanceStrategyLabel(rawStrategy),
    strategyCode: rawStrategy || "unknown",
    status: rawStatus || "unknown",
    statusLabel,
    statusText: statusText || rawStatus || "未返回",
    budget,
    dailyBudget: firstPerformanceBudgetRubles(row, [
      "dailyBudget",
      "daily_budget",
    ]),
    weeklyBudget: firstPerformanceBudgetRubles(row, [
      "weeklyBudget",
      "weekly_budget",
    ]),
    totalBudget: firstPerformanceBudgetRubles(row, [
      "budget",
      "totalBudget",
      "total_budget",
    ]),
    budgetKind:
      firstText(row, [
        "budgetType",
        "budget_type",
        "budgetKind",
        "budget_kind",
      ]) || "未返回预算类型",
    budgetType: firstText(row, [
      "budgetType",
      "budget_type",
      "budgetKind",
      "budget_kind",
    ]),
    budgetStatus: isBudgetExhausted(row) ? "预算花完" : "未返回",
    spent,
    budgetRemaining,
    impressions,
    clicks,
    orders,
    revenue,
    acos:
      acos ??
      (Number.isFinite(spent) && Number.isFinite(revenue) && revenue > 0
        ? Number(((spent / revenue) * 100).toFixed(2))
        : null),
    roas:
      roas ??
      (Number.isFinite(spent) && spent > 0 && Number.isFinite(revenue)
        ? Number((revenue / spent).toFixed(2))
        : null),
    updatedAt: firstText(row, [
      "updatedAt",
      "updated_at",
      "lastUpdated",
      "last_updated",
    ]),
    createdAt: firstText(row, ["createdAt", "created_at"]),
    fromDate: firstText(row, [
      "fromDate",
      "from_date",
      "dateFrom",
      "startDate",
    ]),
    toDate: firstText(row, ["toDate", "to_date", "dateTo", "endDate"]),
    startWeekDay: firstText(row, ["startWeekDay", "start_week_day"]),
    endWeekDay: firstText(row, ["endWeekDay", "end_week_day"]),
    productAdvPlacements:
      row.ProductAdvPlacements ??
      row.productAdvPlacements ??
      row.product_adv_placements ??
      null,
    autoIncrease: row.autoIncrease ?? row.auto_increase ?? null,
    autopilot: row.autopilot ?? null,
    autostopStatus: firstText(row, ["autostopStatus", "autostop_status"]),
    expenseStrategy: firstText(row, ["expenseStrategy", "expense_strategy"]),
    isAutocreated: row.isAutocreated ?? row.is_autocreated ?? null,
    productCampaignMode: firstText(row, [
      "productCampaignMode",
      "product_campaign_mode",
    ]),
    reviewReason:
      firstText(row, [
        "rejectReason",
        "rejectionReason",
        "reason",
        "moderationReason",
        "moderation_reason",
      ]) || "",
    productCount: returnedProductCount,
    productCountSource:
      returnedProductCount === null ? "unavailable" : "campaign",
    objectCount: returnedObjectCount,
    objectCountSource:
      returnedObjectCount === null ? "unavailable" : "campaign",
    products: [],
    statistics: {
      dateFrom: "",
      dateTo: "",
      impressions,
      clicks,
      spent,
      orders,
      revenue,
      acos:
        acos ??
        (Number.isFinite(spent) && Number.isFinite(revenue) && revenue > 0
          ? Number(((spent / revenue) * 100).toFixed(2))
          : null),
      roas:
        roas ??
        (Number.isFinite(spent) && spent > 0 && Number.isFinite(revenue)
          ? Number((revenue / spent).toFixed(2))
          : null),
    },
    raw: row,
    alerts: {
      budgetExhausted: isBudgetExhausted(row),
      moderationRejected: isModerationRejected(row),
    },
  };
}

export function getPerformanceStatusLabel(statusLower, rawStatus = "") {
  const statusCode = normalizeLowerText(rawStatus).replace(
    /[^a-zа-я0-9]+/giu,
    "_",
  );
  const statusMap = new Map([
    ["campaign_state_running", "运行中"],
    ["campaign_state_inactive", "已暂停"],
    ["campaign_state_stopped", "已停止"],
    ["campaign_state_archived", "已归档"],
    ["campaign_state_finished", "已结束"],
    ["campaign_state_moderation", "审核中"],
    ["campaign_state_rejected", "审核不通过"],
    ["campaign_state_budget_exhausted", "预算花完"],
    ["campaign_state_money_limit_reached", "预算花完"],
    ["budget_exhausted", "预算花完"],
    ["money_limit_reached", "预算花完"],
    ["approved", "已通过审核"],
    ["moderation_passed", "已通过审核"],
    ["running", "运行中"],
    ["active", "运行中"],
    ["inactive", "已暂停"],
    ["paused", "已暂停"],
    ["stopped", "已停止"],
    ["finished", "已结束"],
    ["archived", "已归档"],
    ["rejected", "审核不通过"],
    ["moderation", "审核中"],
  ]);
  if (statusMap.has(statusCode)) return statusMap.get(statusCode);
  if (
    /reject|declin|not[_\s-]?approved|fail|отклон|не\s*прош|непрош|отказ/u.test(
      statusLower,
    )
  ) {
    return "审核不通过";
  }
  if (/moderation|review|провер|модерац/u.test(statusLower)) return "审核中";
  if (/budget|исчерп|недостат|законч|лимит/u.test(statusLower))
    return "预算受限";
  if (/run|active|enabled|started|работ|актив/u.test(statusLower))
    return "运行中";
  if (/pause|stop|disable|stopped|приост|останов/u.test(statusLower))
    return "已暂停";
  if (/finish|end|archiv|complete|заверш/u.test(statusLower)) return "已结束";
  return normalizeText(rawStatus) ? "未识别状态" : "未知状态";
}

export function getPerformanceCampaignTypeLabel(value) {
  const text = normalizeLowerText(value);
  if (!text) return "未返回类型";
  if (/cpc[_-]?product|search[_-]?promo|sku|product|товар|трафар/u.test(text))
    return "商品推广";
  if (/auto[_-]?action|autopilot/u.test(text)) return "自动推广";
  if (/search|поиск/u.test(text)) return "搜索推广";
  if (/brand|shelf|бренд/u.test(text)) return "品牌推广";
  if (/banner|баннер/u.test(text)) return "横幅推广";
  if (/video|видео/u.test(text)) return "视频推广";
  if (/cpc|click/u.test(text)) return "按点击付费推广";
  if (/cpm|impression|view/u.test(text)) return "按展示付费推广";
  return "未识别推广类型";
}

export function getPerformancePlacementLabel(value) {
  const text = normalizeLowerText(value);
  if (!text || text === "placement_invalid") return "未返回位置";
  if (/search_and_category|search.*category|category.*search/u.test(text))
    return "搜索和类目";
  if (/top[_-]?promotion|top|premium|верх/u.test(text)) return "搜索顶部";
  if (/search|поиск/u.test(text)) return "搜索结果";
  if (/card|product|товар/u.test(text)) return "商品卡片";
  if (/category|катег/u.test(text)) return "类目页";
  if (/home|main|глав/u.test(text)) return "首页";
  return "未识别展示位置";
}

export function getPerformanceStrategyLabel(value) {
  const text = normalizeLowerText(value);
  if (!text) return "未返回策略";
  if (/max[_-]?clicks|maximum.*click|клик/u.test(text)) return "最大点击量";
  if (/top[_-]?max[_-]?clicks/u.test(text)) return "搜索最大点击量";
  if (/target[_-]?cir|acos|drr/u.test(text)) return "目标广告成本比";
  if (/target[_-]?bids|avg|average|cpc/u.test(text)) return "平均点击成本";
  if (/top[_-]?promotion|top/u.test(text)) return "顶部推广";
  if (/auto|авто|autopilot/u.test(text)) return "自动策略";
  if (/manual|руч/u.test(text)) return "手动策略";
  return "未识别出价策略";
}

export function isBudgetExhausted(row = {}) {
  const text = [
    row.status,
    row.state,
    row.statusText,
    row.status_text,
    row.stateText,
    row.state_text,
    row.reason,
    row.stopReason,
    row.stop_reason,
  ]
    .map(normalizeLowerText)
    .join(" ");
  if (
    /budget|бюджет|limit|лимит/u.test(text) &&
    /exhaust|spent|empty|zero|insufficient|исчерп|законч|недостат|израсход/u.test(
      text,
    )
  ) {
    return true;
  }
  const remaining = firstNumber(row, [
    "budgetRemaining",
    "budget_remaining",
    "remainingBudget",
    "remaining_budget",
    "budgetLeft",
    "budget_left",
    "balance",
  ]);
  if (remaining !== null && remaining <= 0) return true;
  const budget = firstNumber(row, [
    "budget",
    "dailyBudget",
    "daily_budget",
    "budgetLimit",
    "budget_limit",
  ]);
  const spent = firstNumber(row, [
    "spent",
    "moneySpent",
    "money_spent",
    "expense",
    "cost",
    "consumption",
  ]);
  return budget !== null && spent !== null && budget > 0 && spent >= budget;
}

export function isModerationRejected(row = {}) {
  const text = [
    row.status,
    row.state,
    row.moderationStatus,
    row.moderation_status,
    row.statusText,
    row.status_text,
    row.reason,
    row.rejectReason,
    row.rejectionReason,
  ]
    .map(normalizeLowerText)
    .join(" ");
  return /reject|declin|not[_\s-]?approved|fail|отклон|не\s*прош|непрош|отказ/u.test(
    text,
  );
}

export function normalizePerformanceProduct(row = {}, campaign = {}, index = 0) {
  const sku =
    firstText(row, ["sku", "ozonSku", "ozon_sku", "productSku"]) ||
    `sku-${index + 1}`;
  const bid = firstPerformanceBidRubles(row, [
    "bid",
    "currentBid",
    "current_bid",
    "cpc",
  ]);
  const targetCir = firstNumber(row, ["targetCir", "target_cir", "cir"]);
  const rawStatus = firstText(row, [
    "status",
    "state",
    "moderationStatus",
    "moderation_status",
  ]);
  const statusText = [
    rawStatus,
    firstText(row, [
      "statusText",
      "status_text",
      "stateText",
      "state_text",
      "rejectReason",
      "rejectionReason",
      "reason",
    ]),
  ]
    .filter(Boolean)
    .join(" ");
  const spent = firstNumber(row, ["spent", "expense", "cost", "moneySpent"]);
  const revenue = firstNumber(row, [
    "revenue",
    "ordersMoney",
    "orders_money",
    "sales",
  ]);
  const orders = firstNumber(row, ["orders", "ordersCount", "orderCount"]);
  const clicks = firstNumber(row, ["clicks", "clickCount"]);
  const impressions = firstNumber(row, ["views", "shows", "impressions"]);
  return {
    id: `${campaign.id || "campaign"}:${sku}`,
    campaignId: campaign.id || "",
    campaignTitle: campaign.title || "",
    sku,
    sourceSku: firstText(row, ["sourceSku", "source_sku"]),
    productId: firstText(row, [
      "productId",
      "product_id",
      "ozonProductId",
      "ozon_product_id",
    ]),
    offerId: firstText(row, ["offerId", "offer_id", "article", "vendorCode"]),
    title:
      firstText(row, [
        "title",
        "name",
        "productName",
        "product_name",
        "skuName",
      ]) || `商品 ${sku}`,
    image: firstText(row, ["image", "imageUrl", "image_url", "picture"]),
    status: rawStatus || "unknown",
    statusLabel: getPerformanceStatusLabel(
      normalizeLowerText(statusText),
      rawStatus,
    ),
    statusText: statusText || rawStatus || "未返回",
    reviewReason:
      firstText(row, [
        "rejectReason",
        "rejectionReason",
        "reason",
        "moderationReason",
        "moderation_reason",
      ]) || "",
    bid,
    previousBid: firstPerformanceBidRubles(row, [
      "previousBid",
      "previous_bid",
    ]),
    recommendedBid: firstPerformanceBidRubles(row, [
      "recommendedBid",
      "recommended_bid",
    ]),
    competitiveBid: firstPerformanceBidRubles(row, [
      "competitiveBid",
      "competitive_bid",
    ]),
    minCpoBid: firstPerformanceBidRubles(row, [
      "minCpoBid",
      "min_cpo_bid",
      "cpoMinBid",
      "cpo_min_bid",
    ]),
    bidAvailability: isPlainObject(row.bidAvailability)
      ? row.bidAvailability
      : {},
    visibilityIndex: firstText(row, ["visibilityIndex", "visibility_index"]),
    targetCir,
    topPosition: firstText(row, ["topPosition", "top_position"]),
    price: firstNumber(row, ["price", "salePrice", "sale_price"]),
    impressions,
    clicks,
    spent,
    orders,
    revenue,
    acos:
      firstNumber(row, ["acos", "drr"]) ??
      (Number.isFinite(spent) && Number.isFinite(revenue) && revenue > 0
        ? Number(((spent / revenue) * 100).toFixed(2))
        : null),
    roas:
      firstNumber(row, ["roas"]) ??
      (Number.isFinite(spent) && spent > 0 && Number.isFinite(revenue)
        ? Number((revenue / spent).toFixed(2))
        : null),
    alerts: {
      moderationRejected: isModerationRejected(row),
    },
    raw: row,
  };
}

export function normalizePerformanceObject(row = {}, campaign = {}, index = 0) {
  const scalarObjectId = ["string", "number"].includes(typeof row)
    ? normalizeText(row)
    : "";
  const sku = firstText(row, [
    "sku",
    "ozonSku",
    "ozon_sku",
    "productSku",
    "objectSku",
  ]);
  const objectId =
    firstText(row, ["id", "objectId", "object_id", "advObjectId"]) ||
    scalarObjectId ||
    sku ||
    `object-${index + 1}`;
  const rawType = firstText(row, [
    "type",
    "objectType",
    "object_type",
    "advObjectType",
    "adv_object_type",
  ]);
  const rawStatus = firstText(row, [
    "status",
    "state",
    "moderationStatus",
    "moderation_status",
  ]);
  const statusText = [
    rawStatus,
    firstText(row, [
      "statusText",
      "status_text",
      "stateText",
      "state_text",
      "rejectReason",
      "rejectionReason",
      "reason",
    ]),
  ]
    .filter(Boolean)
    .join(" ");
  const reviewReason = firstText(row, [
    "rejectReason",
    "rejectionReason",
    "reason",
    "moderationReason",
  ]);
  return {
    id: `${campaign.id || "campaign"}:${objectId}`,
    objectId,
    campaignId: campaign.id || "",
    campaignTitle: campaign.title || "",
    type: getPerformanceCampaignTypeLabel(rawType),
    typeCode: rawType || "",
    sku,
    offerId: firstText(row, ["offerId", "offer_id", "article", "vendorCode"]),
    title:
      firstText(row, ["title", "name", "objectTitle", "productName"]) ||
      (sku ? `投放对象 ${sku}` : `投放对象 ${objectId}`),
    status: rawStatus || "unknown",
    statusLabel: getPerformanceStatusLabel(
      normalizeLowerText(statusText),
      rawStatus,
    ),
    bid: firstPerformanceBidRubles(row, [
      "bid",
      "currentBid",
      "current_bid",
      "cpc",
    ]),
    reviewReason: reviewReason || "",
    reviewReasonState: reviewReason ? "returned" : "empty",
    raw: row,
  };
}

export function normalizePerformanceCandidateProduct(row = {}, index = 0) {
  const sku =
    firstText(row, ["sku", "sourceSku", "ozonSku", "ozon_sku", "productSku"]) ||
    `sku-${index + 1}`;
  const availabilityRaw = firstValue(row, [
    "isSearchPromoAvailable",
    "searchPromoAvailable",
    "available",
  ]);
  const currentBid = firstPerformanceBidRubles(row, [
    "bid",
    "bidWithoutAdditive",
    "currentBid",
    "current_bid",
  ]);
  return {
    id: firstText(row, ["id"]) || sku,
    key: firstText(row, ["id"]) || sku,
    sku,
    sourceSku: firstText(row, ["sourceSku", "source_sku"]),
    title:
      firstText(row, ["title", "name", "productName", "product_name"]) ||
      `推广商品 ${sku}`,
    image: firstText(row, ["imageUrl", "image_url", "image", "photo"]),
    price: firstNumber(row, ["price", "bidPrice"]),
    bid: currentBid,
    previousBid: firstPerformanceBidRubles(row, [
      "previousBid",
      "previous_bid",
    ]),
    recommendedBid: null,
    competitiveBid: null,
    minimumCpcBid: null,
    minCpoBid: null,
    visibilityIndex: firstText(row, ["visibilityIndex", "visibility_index"]),
    available:
      availabilityRaw === null
        ? true
        : String(availabilityRaw).toLowerCase() === "true",
    statusLabel:
      availabilityRaw === null
        ? "可投放"
        : String(availabilityRaw).toLowerCase() === "true"
          ? "可投放"
          : "不可投放",
    raw: row,
  };
}

export function normalizePerformanceStatistic(row = {}, index = 0) {
  const campaignId = firstText(row, [
    "campaignId",
    "campaign_id",
    "id",
    "campaign_id_num",
  ]);
  const sku = firstText(row, ["sku", "ozonSku", "ozon_sku", "productSku"]);
  const spent = firstNumber(row, [
    "spent",
    "expense",
    "expenses",
    "cost",
    "moneySpent",
  ]);
  const revenue = firstNumber(row, [
    "revenue",
    "ordersMoney",
    "orders_money",
    "sales",
    "money",
  ]);
  const orders = firstNumber(row, [
    "orders",
    "ordersCount",
    "orderCount",
    "ordersNumber",
  ]);
  const clicks = firstNumber(row, ["clicks", "clickCount"]);
  const impressions = firstNumber(row, [
    "views",
    "shows",
    "impressions",
    "viewsCount",
  ]);
  return {
    id:
      firstText(row, ["id", "uuid"]) ||
      `${campaignId || "campaign"}:${sku || "all"}:${index + 1}`,
    campaignId,
    campaignTitle: firstText(row, [
      "campaignTitle",
      "campaignName",
      "campaign_name",
      "title",
      "name",
    ]),
    sku,
    sourceSku: firstText(row, ["sourceSku", "source_sku"]),
    productId: firstText(row, [
      "productId",
      "product_id",
      "ozonProductId",
      "ozon_product_id",
    ]),
    offerId: firstText(row, [
      "offerId",
      "offer_id",
      "vendorCode",
      "vendor_code",
      "article",
    ]),
    date: firstText(row, ["date", "day", "dateFrom", "date_from"]),
    impressions,
    clicks,
    spent,
    orders,
    revenue,
    acos:
      firstNumber(row, ["acos", "drr"]) ??
      (Number.isFinite(spent) && Number.isFinite(revenue) && revenue > 0
        ? Number(((spent / revenue) * 100).toFixed(2))
        : null),
    roas:
      firstNumber(row, ["roas"]) ??
      (Number.isFinite(spent) && spent > 0 && Number.isFinite(revenue)
        ? Number((revenue / spent).toFixed(2))
        : null),
    ctr: firstNumber(row, ["ctr"]) ?? calculateCtr(impressions, clicks),
    cpc:
      firstNumber(row, ["cpc", "avgCpc", "avg_cpc"]) ??
      calculateCpc(spent, clicks),
    objectType: firstText(row, ["objectType", "object_type", "advObjectType"]),
    status: firstText(row, ["status", "state"]),
    placement: firstText(row, ["placement", "placementType", "placement_type"]),
    strategy: firstText(row, [
      "strategy",
      "expenseStrategy",
      "expense_strategy",
    ]),
    budget: firstNumber(row, ["budget", "totalBudget", "total_budget"]),
    weeklyBudget: firstNumber(row, ["weeklyBudget", "weekly_budget"]),
    dailyBudget: firstNumber(row, ["dailyBudget", "daily_budget"]),
    clickPrice: firstNumber(row, ["clickPrice", "click_price"]),
    toCart: firstNumber(row, ["toCart", "to_cart", "addToCart", "add_to_cart"]),
    bonusSpent: firstNumber(row, ["bonusSpent", "bonus_spent"]),
    prepaymentSpent: firstNumber(row, ["prepaymentSpent", "prepayment_spent"]),
    avgCpm: firstNumber(row, ["avgCpm", "avg_cpm", "cpm"]),
    postViewOrders: firstNumber(row, ["postViewOrders", "post_view_orders"]),
    postViewRevenue: firstNumber(row, [
      "postViewRevenue",
      "post_view_revenue",
      "postViewIncome",
    ]),
    paymentType: firstText(row, ["PaymentType", "paymentType", "payment_type"]),
    mediaFormat: firstText(row, ["format", "mediaFormat", "media_format"]),
    modelOrders: firstNumber(row, ["modelOrders", "model_orders"]),
    modelSales: firstNumber(row, ["modelSales", "model_sales"]),
    price: firstNumber(row, ["price", "productPrice", "product_price"]),
    dateAdded: firstText(row, ["dateAdded", "date_added"]),
    raw: row,
  };
}

export function buildPerformanceObjectsFromProducts(products = [], campaign = {}) {
  return (Array.isArray(products) ? products : []).map((product, index) => ({
    id: `${campaign.id || "campaign"}:product-object:${
      normalizeText(product.sku || product.productId || product.offerId) ||
      index + 1
    }`,
    objectId:
      normalizeText(product.sku || product.productId || product.offerId) ||
      `product-${index + 1}`,
    campaignId: campaign.id || "",
    campaignTitle: campaign.title || "",
    type: "商品",
    typeCode: "PRODUCT",
    sku: normalizeText(product.sku),
    productId: normalizeText(product.productId),
    offerId: normalizeText(product.offerId),
    title:
      normalizeText(product.title) ||
      `商品 ${normalizeText(product.sku) || index + 1}`,
    status: product.status || campaign.status || "unknown",
    statusLabel: product.statusLabel || campaign.statusLabel || "未知状态",
    bid: product.bid,
    reviewReason: product.reviewReason || "",
    reviewReasonState: product.reviewReason ? "returned" : "empty",
    impressions: product.impressions,
    clicks: product.clicks,
    spent: product.spent,
    orders: product.orders,
    revenue: product.revenue,
    ctr: product.ctr,
    cpc: product.cpc,
    acos: product.acos,
    roas: product.roas,
    objectSource: "campaign-product",
    raw: product.raw || {},
  }));
}
