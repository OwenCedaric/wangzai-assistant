export const PURCHASE_FORECAST_FLOW_VERSION = 1;

export const purchaseForecastStages = Object.freeze({
  idle: 'idle',
  ozonPreparing: 'ozon_preparing',
  ozonPrepared: 'ozon_prepared',
  labelWaiting: 'label_waiting',
  labelReady: 'label_ready',
  forecastSubmitting: 'forecast_submitting',
  completed: 'completed',
});

export const purchaseForecastExecutionModes = Object.freeze({
  manual: 'manual',
  auto: 'auto',
});

export function normalizePurchaseForecastExecutionMode(value) {
  return value === purchaseForecastExecutionModes.auto
    ? purchaseForecastExecutionModes.auto
    : purchaseForecastExecutionModes.manual;
}

function text(value) {
  return String(value ?? '').trim();
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function getPurchaseForecastPostingNumber(order = {}) {
  return text(
    order.posting
      || order.postingNumber
      || order.posting_number
      || order.id
      || order.orderId
      || order.order_id
  );
}

export function normalizePurchaseForecastFlow(flow = {}, context = {}) {
  const source = plainObject(flow);
  const postingNumber = text(context.postingNumber || getPurchaseForecastPostingNumber(context.order));
  const shopId = text(context.shopId || context.shop?.id || context.order?.shopId);
  const storedPostingNumber = text(source.postingNumber);
  const storedShopId = text(source.shopId);
  const sameOrder = !storedPostingNumber || !postingNumber || storedPostingNumber === postingNumber;
  const sameShop = !storedShopId || !shopId || storedShopId === shopId;
  const base = sameOrder && sameShop ? source : {};
  let stage = text(base.stage) || purchaseForecastStages.idle;

  if (text(base.forecastCompletedAt) || base.crossBorderOrderFound === true) {
    stage = purchaseForecastStages.completed;
  } else if (
    stage !== purchaseForecastStages.forecastSubmitting
    && (text(base.sheetUrl) || text(base.sheetOrderSn))
  ) {
    stage = purchaseForecastStages.labelReady;
  }

  return {
    version: PURCHASE_FORECAST_FLOW_VERSION,
    postingNumber,
    shopId,
    executionMode: normalizePurchaseForecastExecutionMode(base.executionMode),
    stage,
    ozonStatus: text(base.ozonStatus),
    ozonPreparedAt: text(base.ozonPreparedAt),
    lastCheckedAt: text(base.lastCheckedAt),
    labelTaskId: text(base.labelTaskId),
    sheetOrderSn: text(base.sheetOrderSn),
    sheetUrl: text(base.sheetUrl),
    labelReadyAt: text(base.labelReadyAt),
    crossBorderOrderId: text(base.crossBorderOrderId),
    crossBorderOrderNumber: text(base.crossBorderOrderNumber),
    associationCompletedAt: text(base.associationCompletedAt),
    statusSyncCompletedAt: text(base.statusSyncCompletedAt),
    crossBorderOrderFound: base.crossBorderOrderFound === true,
    forecastCompletedAt: text(base.forecastCompletedAt),
    lastError: text(base.lastError),
    updatedAt: text(base.updatedAt),
  };
}

export function mergePurchaseForecastFlow(flow = {}, patch = {}, context = {}) {
  const current = normalizePurchaseForecastFlow(flow, context);
  return normalizePurchaseForecastFlow(
    {
      ...current,
      ...plainObject(patch),
      version: PURCHASE_FORECAST_FLOW_VERSION,
      updatedAt: new Date().toISOString(),
    },
    {
      postingNumber: current.postingNumber,
      shopId: current.shopId,
      ...context,
    }
  );
}

export function getPurchaseForecastFlowFromOrder(order = {}, shop = null) {
  const persisted = plainObject(order.purchaseForecastFlow);
  const flow = normalizePurchaseForecastFlow(persisted, { order, shop });
  if (
    order.crossBorderOrderFound === true
    || ((order.packageOrderId || order.crossBorderOrderId) && flow.stage !== purchaseForecastStages.forecastSubmitting)
  ) {
    return mergePurchaseForecastFlow(
      flow,
      {
        stage: purchaseForecastStages.completed,
        crossBorderOrderFound: true,
        crossBorderOrderId: order.packageOrderId || order.crossBorderOrderId || flow.crossBorderOrderId,
        crossBorderOrderNumber: order.crossBorderOrderNumber || flow.crossBorderOrderNumber,
        forecastCompletedAt: order.crossBorderUpdatedAt || flow.forecastCompletedAt,
      },
      { order, shop }
    );
  }
  if (order.sheetUrl || order.sheetOrderSn) {
    return mergePurchaseForecastFlow(
      flow,
      {
        stage: purchaseForecastStages.labelReady,
        sheetUrl: order.sheetUrl || flow.sheetUrl,
        sheetOrderSn: order.sheetOrderSn || flow.sheetOrderSn,
      },
      { order, shop }
    );
  }
  if (order.ozonAwaitingDeliveryPendingAt && flow.stage === purchaseForecastStages.idle) {
    return mergePurchaseForecastFlow(
      flow,
      {
        stage: purchaseForecastStages.labelWaiting,
        ozonStatus: order.ozonAwaitingDeliveryRawStatus || 'awaiting_deliver',
        ozonPreparedAt: order.ozonAwaitingDeliveryPendingAt,
        lastCheckedAt: order.ozonAwaitingDeliveryPendingAt,
      },
      { order, shop }
    );
  }
  return flow;
}

export function isPurchaseForecastOzonPrepared(flow = {}) {
  const stage = normalizePurchaseForecastFlow(flow).stage;
  return [
    purchaseForecastStages.ozonPrepared,
    purchaseForecastStages.labelWaiting,
    purchaseForecastStages.labelReady,
    purchaseForecastStages.forecastSubmitting,
    purchaseForecastStages.completed,
  ].includes(stage);
}

export function isPurchaseForecastLabelReady(flow = {}) {
  const normalized = normalizePurchaseForecastFlow(flow);
  return Boolean(
    normalized.sheetUrl
      && normalized.sheetOrderSn
      && [
        purchaseForecastStages.labelReady,
        purchaseForecastStages.forecastSubmitting,
        purchaseForecastStages.completed,
      ].includes(normalized.stage)
  );
}

export function isPurchaseForecastCompleted(flow = {}) {
  return normalizePurchaseForecastFlow(flow).stage === purchaseForecastStages.completed;
}

export function getPurchaseForecastStageText(flow = {}) {
  const normalized = normalizePurchaseForecastFlow(flow);
  const map = {
    [purchaseForecastStages.idle]: '等待 Ozon 备货',
    [purchaseForecastStages.ozonPreparing]: '正在提交 Ozon 备货',
    [purchaseForecastStages.ozonPrepared]: 'Ozon 已接收备货，等待状态更新',
    [purchaseForecastStages.labelWaiting]: '正在等待 Ozon 面单',
    [purchaseForecastStages.labelReady]: 'Ozon 面单已生成，可以预报',
    [purchaseForecastStages.forecastSubmitting]: '正在提交跨境巴士预报',
    [purchaseForecastStages.completed]: '跨境巴士预报已完成',
  };
  return map[normalized.stage] || '等待 Ozon 备货';
}
