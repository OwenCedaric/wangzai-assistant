export const PROFIT_REVIEW_PRESENTATION_VERSION = 1;

export const PROFIT_REVIEW_DENSITY_OPTIONS = Object.freeze([
  Object.freeze({ value: 'compact', label: '紧凑整洁' }),
  Object.freeze({ value: 'comfortable', label: '舒展易读' }),
]);

export const DEFAULT_PROFIT_REVIEW_PRESENTATION = Object.freeze({
  version: PROFIT_REVIEW_PRESENTATION_VERSION,
  assistantName: '经营分析助手',
  assistantSubtitle: '订单利润与商品投入评估',
  density: 'compact',
  paragraphIndent: true,
  showAssistantBrand: true,
  showMarketSignal: true,
  showModel: true,
  showMetricNotes: true,
  showSectionIcons: true,
});

function booleanValue(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizeProfitReviewPresentation(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const density = PROFIT_REVIEW_DENSITY_OPTIONS.some((item) => item.value === source.density)
    ? source.density
    : DEFAULT_PROFIT_REVIEW_PRESENTATION.density;
  return {
    version: PROFIT_REVIEW_PRESENTATION_VERSION,
    assistantName: String(source.assistantName || DEFAULT_PROFIT_REVIEW_PRESENTATION.assistantName).trim(),
    assistantSubtitle: String(source.assistantSubtitle || DEFAULT_PROFIT_REVIEW_PRESENTATION.assistantSubtitle).trim(),
    density,
    paragraphIndent: booleanValue(source.paragraphIndent, DEFAULT_PROFIT_REVIEW_PRESENTATION.paragraphIndent),
    showAssistantBrand: booleanValue(source.showAssistantBrand, DEFAULT_PROFIT_REVIEW_PRESENTATION.showAssistantBrand),
    showMarketSignal: booleanValue(source.showMarketSignal, DEFAULT_PROFIT_REVIEW_PRESENTATION.showMarketSignal),
    showModel: booleanValue(source.showModel, DEFAULT_PROFIT_REVIEW_PRESENTATION.showModel),
    showMetricNotes: booleanValue(source.showMetricNotes, DEFAULT_PROFIT_REVIEW_PRESENTATION.showMetricNotes),
    showSectionIcons: booleanValue(source.showSectionIcons, DEFAULT_PROFIT_REVIEW_PRESENTATION.showSectionIcons),
  };
}
