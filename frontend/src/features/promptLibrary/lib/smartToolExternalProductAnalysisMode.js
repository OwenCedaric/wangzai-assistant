export const EXTERNAL_PRODUCT_ANALYSIS_MODE_INPUT_LABEL = '分析对象';

export const EXTERNAL_PRODUCT_ANALYSIS_MODES = Object.freeze({
  competitor: 'competitor',
  own: 'own',
});

export const EXTERNAL_PRODUCT_ANALYSIS_MODE_OPTIONS = Object.freeze([
  Object.freeze({
    value: EXTERNAL_PRODUCT_ANALYSIS_MODES.competitor,
    label: '竞对商品分析',
  }),
  Object.freeze({
    value: EXTERNAL_PRODUCT_ANALYSIS_MODES.own,
    label: '自己商品分析',
  }),
]);

export function normalizeExternalProductAnalysisMode(value = '') {
  const normalized = String(value ?? '').trim().toLocaleLowerCase();
  if (normalized === EXTERNAL_PRODUCT_ANALYSIS_MODES.own || /自己|自营|本店|自家/u.test(normalized)) {
    return EXTERNAL_PRODUCT_ANALYSIS_MODES.own;
  }
  return EXTERNAL_PRODUCT_ANALYSIS_MODES.competitor;
}

export function externalProductAnalysisModeLabel(value = '') {
  const mode = normalizeExternalProductAnalysisMode(value);
  return EXTERNAL_PRODUCT_ANALYSIS_MODE_OPTIONS.find((item) => item.value === mode)?.label
    || EXTERNAL_PRODUCT_ANALYSIS_MODE_OPTIONS[0].label;
}
