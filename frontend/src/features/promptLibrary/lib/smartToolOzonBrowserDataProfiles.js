import { isActiveOzonProductQueryMode } from '../../../services/ozonSearch/ozonSearchQueryResolver.js';

export const SMART_TOOL_OZON_BROWSER_DATA_PROFILES = Object.freeze({
  'ozon-product-search': {
    label: 'Ozon 商品搜索',
    queryMode: 'product',
    datasets: ['product-performance'],
  },
  'ozon-product-selection': {
    label: 'Ozon 选品',
    queryMode: 'product',
    datasets: ['product-performance'],
  },
});

export function getSmartToolOzonBrowserDataProfile(toolOrId = '') {
  const toolId = typeof toolOrId === 'string' ? toolOrId : toolOrId?.id;
  return SMART_TOOL_OZON_BROWSER_DATA_PROFILES[String(toolId || '').trim()] || null;
}

export function usesActiveOzonProductQueryProfile(toolOrId = '') {
  return isActiveOzonProductQueryMode(getSmartToolOzonBrowserDataProfile(toolOrId)?.queryMode);
}

export function canUseSmartToolOzonBrowserDataProfile(toolOrId = '') {
  return Boolean(getSmartToolOzonBrowserDataProfile(toolOrId));
}
