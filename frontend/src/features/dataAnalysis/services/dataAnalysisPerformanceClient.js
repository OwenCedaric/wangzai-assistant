import { listPerformanceAccounts, readPerformanceOverview } from '../../../api/localApiClient.js';

function normalizeText(value) {
  return String(value ?? '').trim();
}

function toCredentialedAccounts(payload = {}) {
  const accounts = Array.isArray(payload?.accounts)
    ? payload.accounts
    : Array.isArray(payload?.rows)
      ? payload.rows
      : [];
  return accounts.filter(
    (item) => item.status !== 'disabled' && item.hasClientId && item.hasClientSecret
  );
}

function addAccountContext(rows, account) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    performanceAccountId: account.id,
    performanceAccountName: account.name || account.title || '平台广告接口',
    shopId: normalizeText(row?.shopId) || account.shopId,
  }));
}

function sumSummary(payloads = []) {
  const result = {};
  payloads.forEach(({ payload }) => {
    Object.entries(payload?.summary || {}).forEach(([key, value]) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        result[key] = (Number(result[key]) || 0) + value;
      } else if (!(key in result)) {
        result[key] = value;
      }
    });
  });
  return result;
}

export function mergeDataAnalysisPerformancePayloads(successes = [], failures = []) {
  if (successes.length === 1 && failures.length === 0) {
    const [{ account, payload }] = successes;
    return {
      ...payload,
      account: {
        id: account.id,
        shopId: account.shopId,
        name: account.name || account.title || '平台广告接口',
        lastTestAt: account.lastTestAt || null,
        lastTestMessage: account.lastTestMessage || '',
      },
      accounts: [{ id: account.id, shopId: account.shopId }],
    };
  }

  const arrayKeys = [
    'campaigns',
    'products',
    'objects',
    'dailyStats',
    'productStats',
    'expenseStats',
    'mediaStats',
    'statisticsTasks',
    'externalReports',
  ];
  const merged = Object.fromEntries(arrayKeys.map((key) => [key, []]));
  const stages = [];
  const readIssues = [];
  successes.forEach(({ account, payload }) => {
    arrayKeys.forEach((key) => {
      merged[key].push(...addAccountContext(payload?.[key], account));
    });
    stages.push(...addAccountContext(payload?.stages, account));
    readIssues.push(...addAccountContext(payload?.readIssues, account));
  });
  failures.forEach(({ account, error }) => {
    readIssues.push({
      performanceAccountId: account.id,
      shopId: account.shopId,
      endpoint: 'performance-overview',
      message:
        error?.payload?.error?.message || error?.message || String(error || 'Performance 读取失败'),
    });
  });

  return {
    ok: successes.length > 0,
    partial: failures.length > 0,
    source: 'ozon-performance-multi-account-realtime',
    readDepth: successes.some((item) => item.payload?.readDepth === 'full') ? 'full' : 'fast',
    startedAt: successes.map((item) => item.payload?.startedAt).filter(Boolean).sort()[0] || null,
    finishedAt: successes.map((item) => item.payload?.finishedAt).filter(Boolean).sort().at(-1) || null,
    summary: sumSummary(successes),
    ...merged,
    stages,
    readIssues,
    accounts: successes.map(({ account }) => ({ id: account.id, shopId: account.shopId })),
    cache: {
      enabled: false,
      fallback: false,
      note: '逐个读取与店铺绑定的 Performance API 账号后实时聚合。',
    },
  };
}

export async function readDataAnalysisPerformance(
  { shopId = '', shopName = '', dateFrom = '', dateTo = '' } = {},
  options = {}
) {
  const accountsPayload = await listPerformanceAccounts({
    signal: options.signal,
    timeoutMs: options.accountTimeoutMs ?? 10000,
  });
  const accounts = toCredentialedAccounts(accountsPayload);
  const boundAccounts = accounts.filter((account) => normalizeText(account.shopId));
  const selectedShopId = normalizeText(shopId);
  const targets = selectedShopId
    ? boundAccounts.filter((account) => normalizeText(account.shopId) === selectedShopId)
    : boundAccounts;

  if (!targets.length) {
    const hasUnboundCredentials = accounts.some((account) => !normalizeText(account.shopId));
    return {
      ok: false,
      status: 'authorization_required',
      accounts,
      error: {
        code: hasUnboundCredentials
          ? 'PERFORMANCE_ACCOUNT_SHOP_BINDING_REQUIRED'
          : 'PERFORMANCE_ACCOUNT_REQUIRED',
        message: hasUnboundCredentials
          ? 'Performance API 账号尚未绑定对应的 Ozon 店铺，请先在设置中完成绑定。'
          : selectedShopId
            ? '当前店铺没有绑定可用的 Performance API 账号。'
            : '设置中心尚未配置可用的广告接口授权。',
      },
    };
  }

  const settled = await Promise.allSettled(
    targets.map(async (account) => ({
      account,
      payload: await readPerformanceOverview(
        {
          type: 'ozon-performance',
          values: {
            accountId: account.id,
            shopId: account.shopId,
            shopName: selectedShopId === account.shopId ? shopName : '',
            dateFrom,
            dateTo,
            readDepth: 'full',
          },
        },
        {
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? 120000,
        }
      ),
    }))
  );
  const successes = settled
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value);
  const failures = settled
    .map((result, index) =>
      result.status === 'rejected' ? { account: targets[index], error: result.reason } : null
    )
    .filter(Boolean);

  if (!successes.length) throw failures[0]?.error || new Error('Performance API 实时读取失败。');
  return mergeDataAnalysisPerformancePayloads(successes, failures);
}
