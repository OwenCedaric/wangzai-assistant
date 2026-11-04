const REPORT_METRIC_ORDER = Object.freeze([
  'trafficSessionCount',
  'trafficOrderCount',
  'trafficOrderConversionRate',
  'salesAmount',
  'financeNetAmount',
  'actualNetProfit',
  'outOfStockCount',
]);

export function parseDataAnalysisInsightSections(value = '') {
  const text = String(value || '').trim();
  if (!text) return [];
  const sections = [];
  let current = null;
  text.split(/\r?\n/u).forEach((line) => {
    const heading = line.trim().match(
      /^(?:#{1,6}\s*)?(?:\*\*|__)?(一|二|三|四|五|六|七|八|九|十)[、.．:：]\s*(.+?)(?:\*\*|__)?$/u
    );
    if (heading) {
      current = { title: heading[2].trim(), body: '' };
      sections.push(current);
      return;
    }
    if (!current) {
      current = { title: '经营诊断', body: '' };
      sections.push(current);
    }
    current.body = `${current.body}${current.body ? '\n' : ''}${line}`.trim();
  });
  return sections.filter((section) => section.body || section.title);
}

export function getDataAnalysisSectionEmoji(title = '') {
  if (/销售|订单|成交/u.test(title)) return '📈';
  if (/利润|费用|成本/u.test(title)) return '💰';
  if (/库存|补货|缺货/u.test(title)) return '📦';
  if (/商品|选品/u.test(title)) return '🛍️';
  if (/售后|退货|退款/u.test(title)) return '⚠️';
  if (/建议|行动|优先/u.test(title)) return '✅';
  if (/数据|缺口/u.test(title)) return '🔎';
  return '📌';
}

export function selectDataAnalysisReportMetrics(dashboard = {}) {
  const metrics = Array.isArray(dashboard?.overview?.metrics) ? dashboard.overview.metrics : [];
  const metricById = new Map(metrics.map((metric) => [metric.id, metric]));
  return REPORT_METRIC_ORDER.map((id) => metricById.get(id)).filter(Boolean).slice(0, 6);
}

export function cleanDataAnalysisReportText(value = '') {
  return String(value || '')
    .replace(/\*\*(.+?)\*\*/gu, '$1')
    .replace(/__(.+?)__/gu, '$1')
    .replace(/`(.+?)`/gu, '$1')
    .trim();
}

export function parseDataAnalysisReportBody(body = '') {
  const blocks = [];
  let listItems = [];
  const flushList = () => {
    if (!listItems.length) return;
    blocks.push({ type: 'list', items: listItems });
    listItems = [];
  };

  String(body || '').split(/\r?\n/u).forEach((sourceLine) => {
    const line = cleanDataAnalysisReportText(sourceLine);
    if (!line) {
      flushList();
      return;
    }
    const listMatch = line.match(/^(?:[-*•]|\d+[.)、]|[①②③④⑤⑥⑦⑧⑨⑩])\s*(.+)$/u);
    if (listMatch) {
      listItems.push(cleanDataAnalysisReportText(listMatch[1]));
      return;
    }
    flushList();
    const labelMatch = line.match(/^(结论|现状|判断|数据依据|问题|风险|机会|建议动作|处理建议|预期结果|衡量指标)[：:]\s*(.+)$/u);
    blocks.push(labelMatch
      ? { type: 'label', label: labelMatch[1], text: cleanDataAnalysisReportText(labelMatch[2]) }
      : { type: 'paragraph', text: line });
  });
  flushList();
  return blocks;
}

export function isWideDataAnalysisReportSection({ title = '', index = 0, count = 0 } = {}) {
  const unpairedLast = count % 2 === 1 && index === count - 1;
  return /行动|优先|计划|数据缺口/u.test(title) || unpairedLast;
}
