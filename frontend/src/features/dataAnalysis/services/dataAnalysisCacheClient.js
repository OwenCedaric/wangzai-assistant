import {
  getDomainCache,
  getSyncJob,
  listIntegrationProfiles,
  saveDataAnalysisSnapshot,
  saveDataAnalysisSyncState,
  deleteDataAnalysisSnapshot,
  startDomainSync,
} from '../../../api/localApiClient.js';

const OZON_BROWSER_SESSION_TYPE = 'ozon-browser-session';
const DATA_ANALYSIS_SNAPSHOT_SAVE_TIMEOUT_MS = 30_000;

function text(value) {
  return String(value ?? '').trim();
}

export async function resolveDataAnalysisMarketProfileScope(input = {}, options = {}) {
  const requestedProfileId = text(input.profileId || input.profile_id);
  const requestedShopId = text(input.shopId || input.shop_id);
  const profileLoader = options.profileLoader || listIntegrationProfiles;
  const payload = await profileLoader({
    timeoutMs: options.timeoutMs ?? 8000,
    signal: options.signal,
  });
  const profiles = (Array.isArray(payload?.profiles) ? payload.profiles : Array.isArray(payload?.rows) ? payload.rows : [])
    .filter((profile) => text(profile?.integrationType) === OZON_BROWSER_SESSION_TYPE);
  const profile = (requestedProfileId
    ? profiles.find((candidate) => text(candidate?.id) === requestedProfileId)
    : requestedShopId
      ? profiles.find((candidate) => text(candidate?.shopId) === requestedShopId)
      : profiles.find((candidate) => (
          text(candidate?.configStatus) === '连接成功'
          && text(candidate?.tokenStatus) === 'Cookie 已保存'
        ))) || null;
  if (!profile) throw new Error('DATA_ANALYSIS_MARKET_PROFILE_NOT_FOUND');
  const profileId = text(profile.id);
  const shopId = text(profile.shopId);
  if (!shopId) throw new Error('DATA_ANALYSIS_MARKET_SHOP_SCOPE_REQUIRED');
  if (requestedShopId && requestedShopId !== shopId) {
    throw new Error('DATA_ANALYSIS_MARKET_SHOP_SCOPE_MISMATCH');
  }
  return { profileId, shopId };
}

export function readDataAnalysisCache(query = {}, options = {}) {
  return getDomainCache(
    'data-analysis',
    {
      ...query,
      limit: query.limit ?? 50,
    },
    {
      timeoutMs: options.timeoutMs ?? 8000,
      signal: options.signal,
      observe: options.observe,
    }
  );
}

export function requestDataAnalysisSync(payload = {}, options = {}) {
  return startDomainSync(
    'data-analysis',
    {
      ...payload,
      requestedBy: payload.requestedBy || 'frontend:data-analysis',
    },
    {
      timeoutMs: options.timeoutMs ?? 8000,
      signal: options.signal,
    }
  );
}

export function saveDataAnalysisCacheSnapshot(snapshot = {}, options = {}) {
  return saveDataAnalysisSnapshot(snapshot, {
    // 市场快照可能包含数千行。只放宽整份快照序列化和 SQLite 写入的等待时间，
    // 读取、同步状态和其他 local-api 请求仍保持 8 秒快速失败。
    timeoutMs: options.timeoutMs ?? DATA_ANALYSIS_SNAPSHOT_SAVE_TIMEOUT_MS,
    signal: options.signal,
    observe: options.observe,
  });
}

export function deleteDataAnalysisCacheSnapshot(query = {}, options = {}) {
  return deleteDataAnalysisSnapshot(query, {
    timeoutMs: options.timeoutMs ?? 8000,
    signal: options.signal,
    observe: options.observe,
  });
}

export function saveDataAnalysisCacheSyncState(state = {}, options = {}) {
  return saveDataAnalysisSyncState(state, {
    timeoutMs: options.timeoutMs ?? 8000,
    signal: options.signal,
    observe: options.observe,
  });
}

function getJobStatus(payload = {}) {
  return String(payload?.job?.status || payload?.status || '').trim();
}

function getJobId(payload = {}) {
  return String(payload?.jobId || payload?.job?.jobId || payload?.job?.id || '').trim();
}

function delay(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export async function syncOfficialTrafficData(payload = {}, options = {}) {
  const submitted = await startDomainSync(
    'reports',
    {
      ...payload,
      requestedBy: payload.requestedBy || 'frontend:data-analysis-traffic',
      forceRefresh: true,
    },
    { timeoutMs: options.submitTimeoutMs ?? 12000, signal: options.signal }
  );
  const jobId = getJobId(submitted);
  if (!jobId) return submitted;
  const timeoutMs = Math.max(Number(options.timeoutMs) || 90000, 1000);
  const startedAt = Date.now();
  let current = submitted;
  while (Date.now() - startedAt < timeoutMs) {
    const status = getJobStatus(current);
    if (['success', 'partial', 'failed', 'canceled'].includes(status)) return current;
    await delay(500);
    current = await getSyncJob(jobId, { timeoutMs: 6000, signal: options.signal });
  }
  return { ...current, ok: false, timedOut: true };
}
