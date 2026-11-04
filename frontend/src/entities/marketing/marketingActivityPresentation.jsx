import {
  getMarketingActivityDescription,
  translateMarketingActivityType,
} from './marketingActionDisplay.jsx';

/** Renderer-facing copy is always compact Chinese, including restored legacy snapshots. */
export function getMarketingActivityDisplayTitle(activity = {}) {
  return translateMarketingActivityType(activity) || '活动';
}

export function getMarketingActivityDisplayDescription(activity = {}) {
  return getMarketingActivityDescription(activity);
}

export function getMarketingActivityDisplaySource(activity = {}) {
  return String(activity?.sourceType || '').toLowerCase() === 'seller' ? '商家自主' : '平台活动';
}
