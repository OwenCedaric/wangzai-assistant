import { listIntegrationProfiles } from '../../../api/localApiClient.js';
import { selectOzonBrowserProfiles } from '../../../services/ozonBrowserCaptureClient.js';
import { marketCacheText } from '../lib/dataAnalysisMarketCacheValue.js';
import { refreshDataAnalysisMarketHotCache } from './dataAnalysisMarketRefreshService.js';

export const DATA_ANALYSIS_MARKET_BACKGROUND_INTERVAL_MS = 30 * 60_000;

export function createDataAnalysisMarketHotCacheRuntime({
  refresh = refreshDataAnalysisMarketHotCache,
  profileIdsLoader = null,
  onError = () => undefined,
  initialDelayMs = 800,
  retryDelayMs = 1800,
  intervalMs = DATA_ANALYSIS_MARKET_BACKGROUND_INTERVAL_MS,
  startupWindowMs = 10_000,
  now = () => Date.now(),
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  let running = false;
  let timer = null;
  let startedAt = 0;

  const schedule = (delay) => {
    if (!running) return;
    if (timer) clearTimeoutImpl(timer);
    timer = setTimeoutImpl(run, Math.max(0, Number(delay) || 0));
  };

  const run = async () => {
    timer = null;
    if (!running) return;
    try {
      const profileIds = typeof profileIdsLoader === 'function'
        ? [...new Set((await profileIdsLoader()).map(marketCacheText).filter(Boolean))]
        : [];
      if (!profileIds.length) {
        // No trusted Ozon browser profile exists yet. A background task must
        // not open the generic CEF session and wait until the command queue
        // times out; the user can configure/login a profile from the page.
        schedule(intervalMs);
        return;
      } else {
        // 市场数据是软件账号级共享数据，不跟随业务页的 Ozon 店铺筛选。
        // 只让第一个可用登录承担隐藏浏览器轮询，避免每个店铺重复抓取同一份市场数据。
        await refresh({
          trigger: 'background',
          force: true,
          browser: {
            profileId: profileIds[0],
            autoNavigate: true,
            awaitBackground: true,
          },
        });
      }
      schedule(intervalMs);
    } catch (error) {
      onError(error);
      const withinStartupWindow = now() - startedAt < startupWindowMs;
      schedule(withinStartupWindow ? retryDelayMs : intervalMs);
    }
  };

  return Object.freeze({
    start() {
      if (running) return;
      running = true;
      startedAt = now();
      schedule(initialDelayMs);
    },
    stop() {
      running = false;
      if (timer) clearTimeoutImpl(timer);
      timer = null;
    },
    isRunning() {
      return running;
    },
  });
}

export function startDataAnalysisMarketHotCacheRuntime(options = {}) {
  if (typeof globalThis.window?.wangzaiDesktop?.purchaseBrowser?.command !== 'function') {
    return () => undefined;
  }
  const profileIdsLoader = options.profileIdsLoader || (async () => {
    const payload = await listIntegrationProfiles({ timeoutMs: 5000 });
    const profile = selectOzonBrowserProfiles(payload)[0];
    return profile ? [marketCacheText(profile.id)] : [];
  });
  const runtime = createDataAnalysisMarketHotCacheRuntime({ ...options, profileIdsLoader });
  runtime.start();
  return () => runtime.stop();
}
