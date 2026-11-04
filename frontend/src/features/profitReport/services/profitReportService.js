import { getJobStatus, readDomainCache, startDomainRefresh } from '../../../services/ozonSyncClient.js';

function sleep(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function terminal(status = '') {
  return ['success', 'partial', 'failed', 'canceled', 'blocked', 'rate_limited', 'circuit_open'].includes(String(status));
}

export function getProfitReportErrorMessage(error) {
  const message = String(error?.message || error || '').trim();
  if (!message) return 'Ozon 利润报表同步失败，请稍后重试。';
  if (/GetFinanceBalanceV1Request\.DateFrom|DateFrom.*regex|date_from/iu.test(message)) {
    return 'Ozon 余额接口日期格式校验失败，请重新选择日期后重试。';
  }
  if (/GetFinanceBalanceV1Request\.DateTo|DateTo.*regex|date_to/iu.test(message)) {
    return 'Ozon 余额接口结束日期格式校验失败，请重新选择日期后重试。';
  }
  if (/HTTP\s*400|validation error|invalid request/iu.test(message)) {
    return 'Ozon 财务接口请求参数不符合要求，请重新选择店铺和日期后重试。';
  }
  if (/HTTP\s*401|HTTP\s*403|unauthori[sz]ed|forbidden/iu.test(message)) {
    return '当前店铺的 Ozon 财务接口授权无效，请检查店铺 API Key 权限。';
  }
  if (/HTTP\s*429|too many requests|rate limit/iu.test(message)) {
    return 'Ozon 财务接口请求过于频繁，请稍后重试。';
  }
  if (/timeout|timed out|ECONN|network|fetch failed/iu.test(message)) {
    return 'Ozon 财务接口网络请求失败，请检查网络后重试。';
  }
  return /[\u3400-\u9fff]/u.test(message) && !/[A-Z_]{4,}/u.test(message)
    ? message
    : 'Ozon 利润报表同步失败，请稍后重试。';
}

export function readProfitReport({ shopIds = [], from = '', to = '', pageSize = 500 } = {}, options = {}) {
  return readDomainCache('profit-report', {
    shopIds: shopIds.join(','),
    from,
    to,
    pageSize,
  }, options);
}

export async function refreshProfitReport({ shops = [], from = '', to = '' } = {}, options = {}) {
  const requests = await Promise.all((Array.isArray(shops) ? shops : []).map(async (shop) => {
    const result = await startDomainRefresh('profit-report', {
      shopId: shop.id || shop.shopId,
      from,
      to,
      pageSize: 100,
      forceRefresh: true,
      requestedBy: 'profit-report-page',
    }, { timeoutMs: options.submitTimeoutMs || 8000 });
    return { shop, result, jobId: result?.jobId || result?.job?.jobId || result?.job?.id || '' };
  }));
  const deadline = Date.now() + Math.max(10_000, Number(options.waitTimeoutMs) || 180_000);
  const pending = new Map(requests.filter((item) => item.jobId).map((item) => [item.jobId, item]));
  const results = [];
  requests.filter((item) => !item.jobId).forEach((item) => results.push({ ...item, status: 'failed', error: getProfitReportErrorMessage(item.result?.error) }));
  while (pending.size && Date.now() < deadline) {
    await sleep(900);
    await Promise.all([...pending.entries()].map(async ([jobId, item]) => {
      const payload = await getJobStatus(jobId, { timeoutMs: 8000 }).catch(() => null);
      const job = payload?.job || payload;
      if (!job || !terminal(job.status)) return;
      results.push({ ...item, status: job.status, job, error: job.lastError || job.error ? getProfitReportErrorMessage(job.lastError || job.error) : null });
      pending.delete(jobId);
    }));
  }
  pending.forEach((item, jobId) => results.push({ ...item, jobId, status: 'timeout', error: '利润报表仍在后台同步' }));
  return {
    ok: results.some((item) => ['success', 'partial'].includes(item.status)),
    results,
    pending: pending.size,
  };
}
