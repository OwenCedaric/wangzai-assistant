function normalizeText(value, maximum = 500) {
  const text = value == null ? '' : String(value).trim();
  return text.slice(0, maximum);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/[^0-9.+-]/gu, ''));
  return Number.isFinite(number) ? number : null;
}

function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRateEntry(input = {}, index = 0, fallbackEffectiveAt = '') {
  const cashPaidCny = finiteNumber(
    input.cashPaidCny ?? input.rechargeAmount ?? input.paidAmount ?? input.paid,
  );
  const giftCreditCny = finiteNumber(
    input.giftCreditCny ?? input.giftAmount ?? input.bonusAmount ?? input.gift,
  ) ?? 0;
  if (cashPaidCny === null || cashPaidCny <= 0 || giftCreditCny < 0) return null;
  const creditedBalanceCny = cashPaidCny + giftCreditCny;
  if (creditedBalanceCny <= 0) return null;
  const effectiveAt = normalizeText(
    input.effectiveAt ?? input.effective_at ?? fallbackEffectiveAt,
    80,
  );
  return {
    id: normalizeText(input.id, 160) || `recharge-rate-${index + 1}`,
    effectiveAt,
    effectiveAtMs: parseTimestamp(effectiveAt),
    cashPaidCny,
    giftCreditCny,
    creditedBalanceCny,
    cashRate: cashPaidCny / creditedBalanceCny,
  };
}

function unwrapFeePlanState(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  if (value.global && typeof value.global === 'object' && !Array.isArray(value.global)) {
    return value.global;
  }
  return value;
}

function selectCrossBorderPlan(state = {}) {
  const plans = Array.isArray(state.plans) ? state.plans : [];
  const active = plans.find((plan) => String(plan?.id || '') === String(state.activeId || ''));
  if (String(active?.settings?.platform || '').trim() === 'crossBorderBus') return active;
  return plans.find((plan) => String(plan?.settings?.platform || '').trim() === 'crossBorderBus')
    || active
    || plans[0]
    || null;
}

/**
 * Builds the immutable conversion policy used by one preview/reconciliation.
 * Legacy rechargeAmount/giftAmount settings remain valid as the earliest
 * known rate. New saves append rechargeRateHistory entries with effectiveAt.
 */
export function createCrossBorderRechargePolicy(feePlanState = {}, options = {}) {
  const state = unwrapFeePlanState(feePlanState);
  const plan = selectCrossBorderPlan(state);
  const settings = plan?.settings && typeof plan.settings === 'object' ? plan.settings : {};
  const settingUpdatedAt = normalizeText(options.updatedAt ?? options.updated_at, 80);
  const history = (Array.isArray(settings.rechargeRateHistory) ? settings.rechargeRateHistory : [])
    .map((entry, index) => normalizeRateEntry(entry, index, settingUpdatedAt))
    .filter(Boolean);
  const current = normalizeRateEntry({
    id: 'legacy-current-rate',
    effectiveAt: settingUpdatedAt,
    rechargeAmount: settings.rechargeAmount,
    giftAmount: settings.giftAmount,
  }, history.length, settingUpdatedAt);

  if (current && !history.some((entry) => (
    entry.cashPaidCny === current.cashPaidCny
    && entry.giftCreditCny === current.giftCreditCny
  ))) {
    history.push(current);
  }

  history.sort((left, right) => {
    if (left.effectiveAtMs === null && right.effectiveAtMs === null) return 0;
    if (left.effectiveAtMs === null) return -1;
    if (right.effectiveAtMs === null) return 1;
    return left.effectiveAtMs - right.effectiveAtMs;
  });

  const fallback = history.at(-1) || {
    id: 'unconfigured-one-to-one',
    effectiveAt: '',
    effectiveAtMs: null,
    cashPaidCny: 1,
    giftCreditCny: 0,
    creditedBalanceCny: 1,
    cashRate: 1,
  };
  return {
    version: 1,
    mode: 'time-effective-recharge-rate',
    source: history.length ? 'fee-settings-recharge-history' : 'unconfigured-one-to-one',
    configured: history.length > 0,
    planId: normalizeText(plan?.id, 160),
    planName: normalizeText(plan?.name, 160),
    updatedAt: settingUpdatedAt,
    defaultRate: fallback.cashRate,
    entries: history,
  };
}

export function resolveCrossBorderCashRate(policy = {}, occurredAt = '') {
  const entries = Array.isArray(policy.entries) ? policy.entries : [];
  if (!entries.length) {
    return {
      rate: 1,
      entryId: 'unconfigured-one-to-one',
      effectiveAt: '',
      cashPaidCny: 1,
      giftCreditCny: 0,
      creditedBalanceCny: 1,
      source: 'unconfigured-one-to-one',
    };
  }
  const occurredAtMs = parseTimestamp(occurredAt);
  let selected = entries[0];
  if (occurredAtMs === null) {
    selected = entries.at(-1);
  } else {
    for (const entry of entries) {
      if (entry.effectiveAtMs === null || entry.effectiveAtMs <= occurredAtMs) selected = entry;
      else break;
    }
  }
  return {
    rate: selected.cashRate,
    entryId: selected.id,
    effectiveAt: selected.effectiveAt,
    cashPaidCny: selected.cashPaidCny,
    giftCreditCny: selected.giftCreditCny,
    creditedBalanceCny: selected.creditedBalanceCny,
    source: policy.source || 'fee-settings-recharge-history',
  };
}

export function compactCrossBorderRechargePolicy(policy = {}) {
  return {
    version: Number(policy.version) || 1,
    mode: normalizeText(policy.mode, 80) || 'time-effective-recharge-rate',
    source: normalizeText(policy.source, 120) || 'unconfigured-one-to-one',
    configured: policy.configured === true,
    planId: normalizeText(policy.planId, 160),
    planName: normalizeText(policy.planName, 160),
    updatedAt: normalizeText(policy.updatedAt, 80),
    defaultRate: Number(policy.defaultRate) || 1,
    entries: (Array.isArray(policy.entries) ? policy.entries : []).map((entry) => ({
      id: normalizeText(entry.id, 160),
      effectiveAt: normalizeText(entry.effectiveAt, 80),
      cashPaidCny: Number(entry.cashPaidCny) || 0,
      giftCreditCny: Number(entry.giftCreditCny) || 0,
      creditedBalanceCny: Number(entry.creditedBalanceCny) || 0,
      cashRate: Number(entry.cashRate) || 1,
    })),
  };
}
