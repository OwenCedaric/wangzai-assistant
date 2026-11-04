import { getDomainCache, getSyncJob, getSyncJobs, startDomainSync } from '../api/localApiClient.js';

function normalizeProductCacheQuery(query = {}) {
  const visibility = String(query.visibility || query.status || '')
    .trim()
    .toUpperCase();
  return {
    scope: visibility === 'ALL' || !visibility ? 'software_all' : 'status',
    sort: query.sort || 'stable',
    ...query,
  };
}

export function readProductListCache(query = {}, options = {}) {
  return getDomainCache('products', normalizeProductCacheQuery(query), options);
}

export async function startProductListSync(payload = {}, options = {}) {
  const syncPayload = { ...payload };
  delete syncPayload.shop;
  const shopId = String(syncPayload.shopId || '').trim();
  if (!shopId) {
    throw new Error('商品同步必须使用已经绑定的本地 shopId，不能在同步链路隐式保存店铺。');
  }
  syncPayload.shopId = shopId;
  return startDomainSync(
    'products',
    {
      endpointKey: 'products.list',
      action: payload.hydrate === false ? 'sync-products-list' : 'sync-products-list-hydrate',
      forceRefresh: true,
      hydrate: true,
      ...syncPayload,
    },
    options
  );
}

export function startProductFullSync(payload = {}, options = {}) {
  return startProductListSync(
    {
      allStatuses: true,
      hydrate: true,
      maxPages: 'all',
      pageSize: 1000,
      ...payload,
    },
    options
  );
}

export function getProductListSyncJob(jobId, options = {}) {
  return getSyncJob(jobId, options);
}

export function getProductListSyncJobs(jobIds = [], options = {}) {
  return getSyncJobs(jobIds, options);
}

function sleep(ms) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, Math.max(0, ms));
  });
}

export async function pollProductListSyncJob(jobId, options = {}) {
  const intervalMs = Math.max(Number(options.intervalMs) || 1000, 100);
  const timeoutMs = Math.max(Number(options.timeoutMs) || 60_000, intervalMs);
  const startedAt = Date.now();
  const finalStatuses = new Set([
    'success',
    'partial',
    'failed',
    'canceled',
    'blocked',
    'rate_limited',
    'circuit_open',
  ]);

  while (Date.now() - startedAt <= timeoutMs) {
    const job = await getProductListSyncJob(jobId, options);
    const status = job?.job?.status || job?.status;
    if (finalStatuses.has(status)) return job;
    await sleep(intervalMs);
  }

  return {
    ok: false,
    jobId,
    status: 'timeout',
    error: {
      code: 'PRODUCT_SYNC_POLL_TIMEOUT',
      message: '商品同步轮询超时，页面可继续读取本地缓存。',
    },
  };
}

export async function pollProductListSyncJobs(jobIds = [], options = {}) {
  const ids = Array.isArray(jobIds) ? jobIds.filter(Boolean) : [];
  if (!ids.length) return [];
  const intervalMs = Math.max(Number(options.intervalMs) || 1000, 100);
  const timeoutMs = Math.max(Number(options.timeoutMs) || 60_000, intervalMs);
  const startedAt = Date.now();
  const finalStatuses = new Set([
    'success',
    'partial',
    'failed',
    'canceled',
    'blocked',
    'rate_limited',
    'circuit_open',
  ]);

  while (Date.now() - startedAt <= timeoutMs) {
    const payload = await getProductListSyncJobs(ids, options);
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    if (jobs.length >= ids.length && jobs.every((job) => finalStatuses.has(job?.status))) {
      return jobs.map((job) => ({
        ok: !['failed', 'canceled', 'blocked', 'rate_limited', 'circuit_open'].includes(job.status),
        job,
        status: job.status,
        jobId: job.jobId || job.id,
      }));
    }
    await sleep(intervalMs);
  }

  return ids.map((jobId) => ({
    ok: false,
    jobId,
    status: 'timeout',
    error: {
      code: 'PRODUCT_SYNC_POLL_TIMEOUT',
      message: '商品同步轮询超时，页面可继续读取本地缓存。',
    },
  }));
}
