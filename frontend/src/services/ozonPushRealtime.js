export const OZON_PUSH_REALTIME_BROWSER_EVENT = 'wangzai:ozon-push-realtime';

export function isOzonPushDomainRefreshEvent(event, domain) {
  const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
  return detail.stage === 'refreshed' && detail.domain === domain;
}

export function getOzonPushRealtimeShopId(event) {
  return String(event?.detail?.shopId ?? '').trim();
}

