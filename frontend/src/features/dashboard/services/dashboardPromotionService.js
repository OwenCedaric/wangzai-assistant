import {
  getRubCnyDailyRate,
  listPerformanceAccounts,
  listRubCnyRateCache,
  readPerformanceOverview,
} from '../../../api/localApiClient.js';
import { normalizeRubCnyRatePayload } from '../../../services/exchangeRateClient.js';
import { resolvePaidPromotionMetric } from '../../paidPromotion/lib/paidPromotionMetrics.js';

function normalizeText(value) {
  return String(value ?? '').trim();
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function credentialedAccounts(payload = {}) {
  const accounts = Array.isArray(payload?.accounts)
    ? payload.accounts
    : Array.isArray(payload?.rows)
      ? payload.rows
      : [];
  return accounts.filter(
    (account) =>
      account.status !== 'disabled' &&
      account.hasClientId &&
      account.hasClientSecret &&
      normalizeText(account.shopId)
  );
}

function getShanghaiDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function latestCachedRate(payload = {}) {
  const records = Array.isArray(payload?.records) ? payload.records : [];
  return records
    .map((record) => normalizeRubCnyRatePayload({ ...record, ok: true }))
    .filter(Boolean)
    .sort((left, right) => String(right.date || right.requestedDate).localeCompare(String(left.date || left.requestedDate)))[0] || null;
}

async function readRubCnyRate(options = {}) {
  try {
    const cached = latestCachedRate(
      await listRubCnyRateCache({ signal: options.signal, timeoutMs: 4_000, limit: 30 })
    );
    if (cached?.rubToCnyRate) return cached;
  } catch {
    // Money remains available in RUB when the local exchange-rate cache is empty.
  }
  try {
    return normalizeRubCnyRatePayload(
      await getRubCnyDailyRate(getShanghaiDateKey(options.now), {
        signal: options.signal,
        timeoutMs: 8_000,
        allowNearest: true,
        maxLookbackDays: 14,
      })
    );
  } catch {
    return null;
  }
}

export function createEmptyDashboardPromotionSummary(status = 'empty', message = '') {
  return {
    status,
    message,
    accountCount: 0,
    campaignCount: null,
    spentRub: null,
    revenueRub: null,
    spentCny: null,
    revenueCny: null,
    orders: null,
    acos: null,
    roas: null,
    balanceRub: null,
    balanceCny: null,
    currency: 'RUB',
    rate: null,
    updatedAt: null,
    partial: false,
    byShop: [],
  };
}

export function summarizeDashboardPromotionPayloads(successes = [], options = {}) {
  if (!successes.length) return createEmptyDashboardPromotionSummary('unavailable', '推广数据暂不可用');
  const numericKeys = ['total', 'spent', 'revenue', 'orders'];
  const totals = Object.fromEntries(numericKeys.map((key) => [key, null]));
  const balanceValues = [];
  let updatedAt = '';
  successes.forEach(({ payload }) => {
    const summary = payload?.summary || {};
    numericKeys.forEach((key) => {
      const value = toFiniteNumber(summary[key]);
      if (value === null) return;
      totals[key] = (totals[key] ?? 0) + value;
    });
    (Array.isArray(payload?.campaigns) ? payload.campaigns : []).forEach((campaign) => {
      const balance = toFiniteNumber(campaign?.budgetRemaining);
      if (balance !== null) balanceValues.push(balance);
    });
    const candidate = normalizeText(payload?.finishedAt || payload?.freshness?.capturedAt);
    if (candidate > updatedAt) updatedAt = candidate;
  });
  const ratioRecord = { statistics: { spent: totals.spent, revenue: totals.revenue } };
  const acos = resolvePaidPromotionMetric(ratioRecord, 'acos').value;
  const roas = resolvePaidPromotionMetric(ratioRecord, 'roas').value;
  const rate = toFiniteNumber(options.rate?.rubToCnyRate);
  const balanceRub = balanceValues.length ? balanceValues.reduce((total, value) => total + value, 0) : null;
  const toCny = (value) => (value !== null && rate !== null ? Number((value * rate).toFixed(2)) : null);
  const byShop = successes.map(({ account, payload }) => {
    const summary = payload?.summary || {};
    const spentRub = toFiniteNumber(summary.spent);
    const revenueRub = toFiniteNumber(summary.revenue);
    const shopBalanceValues = (Array.isArray(payload?.campaigns) ? payload.campaigns : [])
      .map((campaign) => toFiniteNumber(campaign?.budgetRemaining))
      .filter((value) => value !== null);
    const ratios = { statistics: { spent: spentRub, revenue: revenueRub } };
    return {
      shopId: normalizeText(account?.shopId),
      accountId: normalizeText(account?.id),
      spentRub,
      revenueRub,
      spentCny: toCny(spentRub),
      revenueCny: toCny(revenueRub),
      orders: toFiniteNumber(summary.orders),
      acos: resolvePaidPromotionMetric(ratios, 'acos').value,
      roas: resolvePaidPromotionMetric(ratios, 'roas').value,
      balanceRub: shopBalanceValues.length
        ? shopBalanceValues.reduce((total, value) => total + value, 0)
        : null,
    };
  });
  return {
    status: 'data',
    message: options.failureCount ? '部分店铺推广数据未更新' : '',
    accountCount: successes.length,
    campaignCount: totals.total,
    spentRub: totals.spent,
    revenueRub: totals.revenue,
    spentCny: toCny(totals.spent),
    revenueCny: toCny(totals.revenue),
    orders: totals.orders,
    acos,
    roas,
    balanceRub,
    balanceCny: toCny(balanceRub),
    currency: rate === null ? 'RUB' : 'CNY',
    rate,
    updatedAt: updatedAt || null,
    partial: Boolean(options.failureCount),
    byShop,
  };
}

export async function readDashboardPromotionSummary(
  { shops = [], selectedShopId = 'all', dateFrom = '', dateTo = '', refresh = false } = {},
  options = {}
) {
  const accountsPayload = await listPerformanceAccounts({
    signal: options.signal,
    timeoutMs: options.accountTimeoutMs ?? 8_000,
  });
  const knownShopIds = new Set((Array.isArray(shops) ? shops : []).map((shop) => normalizeText(shop?.id)).filter(Boolean));
  const accounts = credentialedAccounts(accountsPayload).filter((account) => knownShopIds.has(normalizeText(account.shopId)));
  const targets = selectedShopId === 'all'
    ? accounts
    : accounts.filter((account) => normalizeText(account.shopId) === normalizeText(selectedShopId));
  if (!targets.length) return createEmptyDashboardPromotionSummary('unconfigured', '当前范围尚未配置推广账号');

  const [settled, rate] = await Promise.all([
    Promise.allSettled(
      targets.map(async (account) => {
        const baseValues = {
          accountId: account.id,
          shopId: account.shopId,
          dateFrom,
          dateTo,
        };
        if (!refresh) {
          const snapshotPayload = await readPerformanceOverview(
            { type: 'ozon-performance', values: { ...baseValues, readDepth: 'snapshot', snapshotOnly: true } },
            { signal: options.signal, timeoutMs: options.snapshotTimeoutMs ?? 5_000 }
          );
          if (snapshotPayload?.found && snapshotPayload?.snapshot?.ok) {
            return { account, payload: snapshotPayload.snapshot };
          }
        }
        const payload = await readPerformanceOverview(
          { type: 'ozon-performance', values: { ...baseValues, readDepth: 'dashboard' } },
          { signal: options.signal, timeoutMs: options.timeoutMs ?? 90_000 }
        );
        if (!payload?.ok) throw new Error('推广数据未返回');
        return { account, payload };
      })
    ),
    readRubCnyRate({ signal: options.signal, now: options.now }),
  ]);
  const successes = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  const failureCount = settled.length - successes.length;
  if (!successes.length) return createEmptyDashboardPromotionSummary('unavailable', '推广数据暂不可用');
  return summarizeDashboardPromotionPayloads(successes, { rate, failureCount });
}
