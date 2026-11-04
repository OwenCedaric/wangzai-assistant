import { normalizeText, toFiniteNumber } from './dataAnalysisUtils.js';

function metricMap(sections = []) {
  const map = new Map();
  sections.forEach((section) => {
    (Array.isArray(section?.metrics) ? section.metrics : []).forEach((metric) => {
      if (metric?.id) map.set(metric.id, metric);
    });
  });
  return map;
}

function createDiagnostic({ id, severity, title, message, moduleId, metric, sourceIds = [], action = '' }) {
  return {
    id,
    severity,
    title,
    message,
    moduleId,
    evidence: metric
      ? {
          metricId: metric.id,
          label: metric.label,
          value: metric.value,
          unit: metric.unit,
          currency: metric.currency,
          status: metric.status,
          source: metric.source,
        }
      : null,
    sourceIds,
    action,
  };
}

export function buildDataAnalysisDiagnostics({ sales, products, finance, traffic, afterSales, marketing, sources = [], dataQuality = {} } = {}) {
  const metrics = metricMap([sales, products, finance, traffic, afterSales, marketing]);
  const diagnostics = [];
  if (Number(dataQuality.missingCoreSourceShopCount) > 0) {
    diagnostics.push({
      id: 'multi-shop-source-coverage-gap',
      severity: 'high',
      title: '部分店铺缺少核心分析来源',
      message: `${dataQuality.missingCoreSourceShopCount} 个店铺×来源组合没有数据，全部店铺汇总不能视为完整。`,
      moduleId: 'overview',
      evidence: null,
      sourceIds: ['orders', 'products', 'finance', 'analytics'],
      action: '查看店铺数据覆盖并补同步缺失来源。',
    });
  }
  if (Number(dataQuality.duplicateRowCount) > 0 || Number(dataQuality.orphanRowCount) > 0) {
    diagnostics.push({
      id: 'analysis-grain-integrity-gap',
      severity: 'high',
      title: '分析数据存在重复或无法归属店铺的记录',
      message: `重复业务键 ${Number(dataQuality.duplicateRowCount) || 0} 条，无法归属当前店铺范围 ${Number(dataQuality.orphanRowCount) || 0} 条。`,
      moduleId: 'overview',
      evidence: null,
      sourceIds: ['orders', 'products', 'finance', 'returns', 'analytics'],
      action: '先修复重复键和店铺归属，再使用聚合指标。',
    });
  }
  if (dataQuality.reconciliation?.status === 'mismatch') {
    diagnostics.push({
      id: 'shop-aggregate-reconciliation-gap',
      severity: 'high',
      title: '店铺分项与汇总订单数不一致',
      message: `店铺分项合计与有效订单指标相差 ${Number(dataQuality.reconciliation.difference) || 0} 单。`,
      moduleId: 'sales',
      evidence: null,
      sourceIds: ['orders'],
      action: '核对店铺作用域、订单去重键和取消订单过滤。',
    });
  }
  if (Number(dataQuality.periodEmptyOrderShopCount) > 0 && Number(dataQuality.expectedShopCount) > 1) {
    diagnostics.push({
      id: 'selected-period-empty-shop',
      severity: 'info',
      title: '部分店铺在当前周期没有订单',
      message: `${dataQuality.periodEmptyOrderShopCount}/${dataQuality.expectedShopCount} 家店铺当前周期订单数为 0；该店仍保留商品、财务和流量覆盖状态供核对。`,
      moduleId: 'overview',
      evidence: null,
      sourceIds: ['orders'],
      action: '查看店铺数据覆盖，确认是本期无订单还是订单日期缺失。',
    });
  }
  if (Number(dataQuality.metricCoverage?.financeInferredCurrencyRows) > 0) {
    const inferred = Number(dataQuality.metricCoverage.financeInferredCurrencyRows) || 0;
    const official = Number(dataQuality.metricCoverage.financeOfficialCurrencyRows) || 0;
    diagnostics.push({
      id: 'finance-currency-inferred-from-platform-rule',
      severity: official ? 'low' : 'medium',
      title: '财务流水币种来自平台规则推断',
      message: `${inferred} 条财务流水没有直接返回币种，当前按 Ozon 结算规则判定为 RUB；官方币种字段直接返回 ${official} 条。`,
      moduleId: 'profit',
      evidence: null,
      sourceIds: ['finance'],
      action: '使用财务报告或后续新接口的明确币种字段交叉核对。',
    });
  }
  if (Number(dataQuality.metricCoverage?.analyticsLagDays) > 1) {
    diagnostics.push({
      id: 'traffic-latest-date-lag',
      severity: 'medium',
      title: '流量日数据尚未覆盖筛选结束日',
      message: `最新流量日期为 ${dataQuality.metricCoverage.latestAnalyticsDate || '未返回'}，距离筛选结束日 ${dataQuality.metricCoverage.expectedAnalyticsEndDate || '未返回'} 相差 ${dataQuality.metricCoverage.analyticsLagDays} 天。`,
      moduleId: 'traffic',
      evidence: null,
      sourceIds: ['analytics'],
      action: '同步官方流量并确认最近日期是否存在平台延迟。',
    });
  }
  if (Number(dataQuality.performanceCoverage?.coveredShopCount) < Number(dataQuality.performanceCoverage?.expectedShopCount)) {
    diagnostics.push({
      id: 'performance-account-shop-coverage-gap',
      severity: 'info',
      title: '广告接口尚未覆盖全部店铺',
      message: `Performance API 已覆盖 ${Number(dataQuality.performanceCoverage?.coveredShopCount) || 0}/${Number(dataQuality.performanceCoverage?.expectedShopCount) || 0} 家店铺；未绑定店铺不会进入广告汇总。`,
      moduleId: 'advertising',
      evidence: null,
      sourceIds: ['performance'],
      action: '在设置中为缺失店铺绑定对应的 Performance API 账号。',
    });
  }
  const cancellationRate = metrics.get('cancellationRate');
  const cancellationRateValue = toFiniteNumber(cancellationRate?.value);
  if (cancellationRateValue !== null && cancellationRateValue >= 20) {
    diagnostics.push(
      createDiagnostic({
        id: 'high-period-cancellation-ratio',
        severity: cancellationRateValue >= 40 ? 'high' : 'medium',
        title: '所选期间取消订单占比较高',
        message: `取消订单占所选期间订单的 ${cancellationRateValue.toFixed(1)}%。该指标用于经营观察，不等同平台考核取消率。`,
        moduleId: 'sales',
        metric: cancellationRate,
        sourceIds: ['orders'],
        action: '进入销售分析查看订单状态分布和取消订单明细。',
      })
    );
  }

  const outOfStock = metrics.get('outOfStockCount');
  const outOfStockValue = toFiniteNumber(outOfStock?.value);
  if (outOfStockValue !== null && outOfStockValue > 0) {
    diagnostics.push(
      createDiagnostic({
        id: 'active-products-out-of-stock',
        severity: outOfStockValue >= 10 ? 'high' : 'medium',
        title: '存在待补货候选商品',
        message: `${Math.round(outOfStockValue)} 个可经营候选商品的库存结果明确为0；归档、校验失败和库存未确认商品未计入。`,
        moduleId: 'inventory',
        metric: outOfStock,
        sourceIds: ['products'],
        action: '进入库存分析查看缺货SKU和库存同步时间。',
      })
    );
  }

  const newReturnCount = metrics.get('returnCount');
  const newReturnCountValue = toFiniteNumber(newReturnCount?.value);
  if (newReturnCountValue !== null && newReturnCountValue >= 20) {
    diagnostics.push(
      createDiagnostic({
        id: 'high-period-new-return-count',
        severity: newReturnCountValue >= 50 ? 'high' : 'medium',
        title: '本期新建售后单较多',
        message: `所选期间新建售后 ${Math.round(newReturnCountValue)} 笔。售后创建期与下单期不同，页面不再把两者直接相除为比例。`,
        moduleId: 'after-sales',
        metric: newReturnCount,
        sourceIds: ['returns', 'orders'],
        action: '进入售后分析核查状态、涉及订单和平台原因编号。',
      })
    );
  }

  const financeCoverage = metrics.get('financeCurrencyCoverage');
  const financeCoverageValue = toFiniteNumber(financeCoverage?.value);
  if (financeCoverageValue !== null && financeCoverageValue < 100) {
    diagnostics.push(
      createDiagnostic({
        id: 'finance-currency-coverage-gap',
        severity: financeCoverageValue < 60 ? 'medium' : 'low',
        title: '部分财务流水结算币种尚未判定',
        message: `当前结算币种判定率为 ${financeCoverageValue.toFixed(1)}%。币种未判定的流水不会和已确认币种金额混合展示。`,
        moduleId: 'profit',
        metric: financeCoverage,
        sourceIds: ['finance', 'orders'],
        action: '进入利润分析查看结算币种和按日汇率换算状态。',
      })
    );
  }

  const purchaseCoverage = metrics.get('purchaseCostCoverage');
  const purchaseCoverageValue = toFiniteNumber(purchaseCoverage?.value);
  if (purchaseCoverageValue !== null && purchaseCoverageValue < 100) {
    diagnostics.push(
      createDiagnostic({
        id: 'purchase-cost-coverage-gap',
        severity: purchaseCoverageValue < 50 ? 'medium' : 'low',
        title: '采购成本尚未覆盖全部订单',
        message: `所选期间采购成本覆盖率为 ${purchaseCoverageValue.toFixed(1)}%，因此不生成完整实际净利润。`,
        moduleId: 'profit',
        metric: purchaseCoverage,
        sourceIds: ['purchase', 'orders'],
        action: '先在拍单管理补齐并确认采购成本。',
      })
    );
  }

  const productQuality = products?.quality || {};
  const categoryCoverage = toFiniteNumber(productQuality.categoryCoveragePercent);
  if (categoryCoverage !== null && categoryCoverage < 100) {
    diagnostics.push({
      id: 'product-category-data-gap',
      severity: 'low',
      title: '商品类目数据未完整返回',
      message: `商品类目覆盖率为 ${categoryCoverage.toFixed(1)}%，类目排行不会把“类目未返回”解释成真实类目。`,
      moduleId: 'products',
      evidence: null,
      sourceIds: ['products'],
      action: '刷新商品属性补水后再查看类目分析。',
    });
  }

  const analyticsSource = sources.find((source) => normalizeText(source.id) === 'analytics');
  if (analyticsSource?.status !== 'ready') {
    diagnostics.push({
      id: 'traffic-analytics-not-synced',
      severity: 'info',
      title: '官方流量与转化数据尚未形成缓存',
      message: '当前不会用订单数反推访客、曝光、加购或平台转化率。',
      moduleId: 'traffic',
      evidence: null,
      sourceIds: ['analytics'],
      action: '待验证当前店铺 /v1/analytics/data 指标权限后接入。',
    });
  }

  return diagnostics.sort((left, right) => {
    const order = { high: 0, medium: 1, low: 2, info: 3 };
    return (order[left.severity] ?? 9) - (order[right.severity] ?? 9);
  });
}
