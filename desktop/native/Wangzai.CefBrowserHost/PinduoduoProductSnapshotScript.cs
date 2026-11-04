namespace Wangzai.CefBrowserHost;

/// <summary>
/// Installs before the Pinduoduo SPA finishes booting so the short-lived full
/// rawData payload is retained after React replaces it with a compact view.
/// Only the current product object is cached in page memory; no cookie or
/// account value is copied.
/// </summary>
internal static class PinduoduoProductSnapshotScript
{
	public const string Value = """
(() => {
  const host = String(location.hostname || '').toLowerCase();
  const productPage = (host === 'yangkeduo.com' || host.endsWith('.yangkeduo.com')
    || host === 'pinduoduo.com' || host.endsWith('.pinduoduo.com'))
    && /\/goods\.html$/iu.test(location.pathname)
    && new URLSearchParams(location.search).has('goods_id');
  if (!productPage) return false;
  if (window.__wangzaiPddSnapshotWatcherV1?.version === 1) return true;
  const storeKey = '__wangzaiPddProductSnapshotV1';
  const store = window[storeKey]?.version === 1
    ? window[storeKey]
    : { version: 1, records: {}, order: [] };
  window[storeKey] = store;
  const text = value => String(value ?? '').trim();
  const rows = value => {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    try {
      if (typeof value[Symbol.iterator] === 'function') return [...value];
    } catch { /* keep the watcher alive on hostile proxies */ }
    const length = Number(value.length);
    if (Number.isInteger(length) && length >= 0 && length <= 5000) {
      try { return Array.from({ length }, (_, index) => value[index]).filter(item => item != null); }
      catch { /* fall through */ }
    }
    return Object.values(value);
  };
  const identity = value => text(value?.goodsID || value?.goodsId || value?.goods_id);
  const clone = value => {
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
  };
  const skuRows = value => rows(value?.skus || value?.sku?.skus || (Array.isArray(value?.sku) ? value.sku : null) || value?.skuList || value?.sku_list);
  const skuSpecs = row => rows(row?.specs || row?.specifications);
  const complete = value => {
    if (!value || typeof value !== 'object' || !identity(value) || !text(value?.goodsName || value?.name)) return false;
    const skus = skuRows(value);
    if (!skus.some(row => text(row?.skuId || row?.skuID || row?.sku_id || row?.id))) return false;
    if (skus.length > 1 && !skus.some(row => skuSpecs(row).some(spec => text(spec?.spec_value || spec?.specValue || spec?.value || spec?.name)))) return false;
    return rows(value?.topGallery || value?.viewImageData || value?.gallery || value?.goodsGalleryUrls || value?.images).length > 0;
  };
  const score = value => {
    const skus = skuRows(value);
    return rows(value?.topGallery || value?.viewImageData || value?.gallery || value?.goodsGalleryUrls || value?.images).length * 200
      + skus.length * 20
      + skus.reduce((total, row) => total
        + skuSpecs(row).length * 100
        + (text(row?.groupPrice || row?.normalPrice || row?.group_price || row?.normal_price || row?.skuPrice) ? 30 : 0), 0);
  };
  const save = goods => {
    const snapshot = clone(goods);
    if (!complete(snapshot)) return false;
    const key = identity(snapshot);
    const previous = store.records[key]?.goods;
    if (previous && score(previous) > score(snapshot)) return true;
    store.records[key] = { goods: snapshot, capturedAt: Date.now(), pageUrl: location.href };
    store.order = [key, ...rows(store.order).filter(item => String(item) !== key)].slice(0, 50);
    for (const staleKey of Object.keys(store.records)) {
      if (!store.order.includes(staleKey)) delete store.records[staleKey];
    }
    return true;
  };
  const capture = () => {
    const candidates = [];
    try {
      candidates.push(
        window.rawData?.store?.initDataObj?.goods,
        window.store?.initDataObj?.goods,
        window.__INITIAL_STATE__?.store?.initDataObj?.goods,
        window.__NEXT_DATA__?.props?.pageProps?.store?.initDataObj?.goods,
      );
    } catch { /* runtime globals are optional */ }
    return candidates.some(save);
  };
  let observer = null;
  let observerDelay = null;
  const attachObserver = () => {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(() => {
      if (observerDelay) return;
      observerDelay = setTimeout(() => { observerDelay = null; capture(); }, 200);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };
  const interval = setInterval(() => { attachObserver(); capture(); }, 100);
  window.addEventListener('pagehide', () => {
    clearInterval(interval);
    if (observerDelay) clearTimeout(observerDelay);
    observer?.disconnect();
  }, { once: true });
  window.__wangzaiPddSnapshotWatcherV1 = { version: 1, capture };
  attachObserver();
  capture();
  return true;
})()
""";
}
