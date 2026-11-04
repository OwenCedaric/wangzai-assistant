export const FEE_SETTINGS_FILE_VERSION = 2;

export const emptyFeeSettings = Object.freeze({
  platform: '',
  labelFeeUnit: '',
  rechargeAmount: '',
  giftAmount: '',
  rechargeRateHistory: [],
  forecastOrderFee: '',
  savedAt: '',
});

function createPlanId() {
  return `fee-plan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function normalizeFeeSettings(value) {
  const source = toPlainObject(value);
  const rechargeRateHistory = (Array.isArray(source.rechargeRateHistory) ? source.rechargeRateHistory : [])
    .map((entry, index) => {
      const raw = toPlainObject(entry);
      const rechargeAmount = String(raw.rechargeAmount ?? raw.cashPaidCny ?? '').trim();
      const giftAmount = String(raw.giftAmount ?? raw.giftCreditCny ?? '0').trim();
      const paid = Number(rechargeAmount);
      const gift = Number(giftAmount);
      if (!Number.isFinite(paid) || paid <= 0 || !Number.isFinite(gift) || gift < 0) return null;
      return {
        id: String(raw.id || `recharge-rate-${index + 1}`),
        effectiveAt: String(raw.effectiveAt || ''),
        rechargeAmount,
        giftAmount,
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(left.effectiveAt).localeCompare(String(right.effectiveAt)));
  return {
    ...emptyFeeSettings,
    ...Object.fromEntries(
      Object.keys(emptyFeeSettings)
        .filter((key) => key !== 'rechargeRateHistory')
        .map((key) => [key, String(source[key] ?? '')]),
    ),
    rechargeRateHistory,
  };
}

function rechargePair(settings = {}) {
  const rechargeAmount = Number(settings.rechargeAmount);
  const giftAmount = String(settings.giftAmount ?? '').trim() === '' ? 0 : Number(settings.giftAmount);
  if (!Number.isFinite(rechargeAmount) || rechargeAmount <= 0 || !Number.isFinite(giftAmount) || giftAmount < 0) {
    return null;
  }
  return { rechargeAmount: String(settings.rechargeAmount), giftAmount: String(giftAmount) };
}

export function snapshotActiveRechargeRate(state, options = {}) {
  const normalized = normalizeFeePlanState(state);
  const effectiveAt = String(options.effectiveAt || new Date().toISOString());
  return {
    ...normalized,
    plans: normalized.plans.map((plan) => {
      if (plan.id !== normalized.activeId || plan.settings.platform !== 'crossBorderBus') return plan;
      const pair = rechargePair(plan.settings);
      if (!pair) return plan;
      const history = [...plan.settings.rechargeRateHistory];
      const latest = history.at(-1);
      if (latest?.rechargeAmount === pair.rechargeAmount && latest?.giftAmount === pair.giftAmount) return plan;
      return {
        ...plan,
        settings: {
          ...plan.settings,
          rechargeRateHistory: [
            ...history,
            {
              id: `recharge-rate-${effectiveAt}-${history.length + 1}`,
              effectiveAt,
              ...pair,
            },
          ],
        },
      };
    }),
  };
}

export function hasFeeSettingsValues(settings) {
  return Object.entries(normalizeFeeSettings(settings)).some(
    ([key, value]) => key !== 'savedAt'
      && (key === 'rechargeRateHistory' ? value.length > 0 : String(value ?? '').trim() !== '')
  );
}

export function createFeePlan(index, settings = emptyFeeSettings) {
  return {
    id: createPlanId(),
    name: index === 1 ? '跨境巴士费用' : `费用方案 ${index}`,
    settings: normalizeFeeSettings(settings),
  };
}

export function normalizeFeePlanState(value, fallbackSettings = emptyFeeSettings) {
  const source = toPlainObject(value);
  const fallbackPlan = createFeePlan(1, fallbackSettings);
  const rawPlans = Array.isArray(source.plans) && source.plans.length > 0 ? source.plans : [fallbackPlan];
  const plans = rawPlans.map((plan, index) => {
    const rawPlan = toPlainObject(plan);
    return {
      id: String(rawPlan.id || `fee-plan-${index + 1}`),
      name: String(rawPlan.name || (index === 0 ? '跨境巴士费用' : `费用方案 ${index + 1}`)),
      settings: normalizeFeeSettings(rawPlan.settings || rawPlan),
    };
  });
  const activeId = plans.some((plan) => plan.id === source.activeId) ? source.activeId : plans[0].id;
  return { activeId, plans };
}

export function hasFeePlanStateValues(state) {
  return normalizeFeePlanState(state).plans.some((plan) => hasFeeSettingsValues(plan.settings));
}

export function getActiveFeeSettingsFromPlanState(state, fallbackSettings = emptyFeeSettings) {
  const normalized = normalizeFeePlanState(state, fallbackSettings);
  const activePlan = normalized.plans.find((plan) => plan.id === normalized.activeId) || normalized.plans[0];
  return normalizeFeeSettings(activePlan?.settings);
}

export function normalizeFeeSettingsFileStore(value) {
  const source = toPlainObject(value);
  const globalState = normalizeFeePlanState(source.global || (Array.isArray(source.plans) ? source : null));
  const shops = {};
  const rawShops = toPlainObject(source.shops);

  for (const [shopKey, state] of Object.entries(rawShops)) {
    const key = String(shopKey || '').trim();
    if (!key) continue;
    shops[key] = normalizeFeePlanState(state);
  }

  return {
    version: FEE_SETTINGS_FILE_VERSION,
    activePlanId: String(source.activePlanId || globalState.activeId || ''),
    activeShopKey: String(source.activeShopKey || ''),
    global: globalState,
    shops,
    updatedAt: String(source.updatedAt || ''),
  };
}

export function hasFeeSettingsFileStoreEntry(store, shopKey = '') {
  const normalized = normalizeFeeSettingsFileStore(store);
  const key = String(shopKey || '').trim();
  return key ? Boolean(normalized.shops[key]) : hasFeePlanStateValues(normalized.global);
}

export function getFeePlanStateFromFileStore(store, shopKey = '', fallbackState = null) {
  const normalized = normalizeFeeSettingsFileStore(store);
  const key = String(shopKey || '').trim();
  if (key && normalized.shops[key]) return normalized.shops[key];
  if (normalized.global && hasFeePlanStateValues(normalized.global)) return normalized.global;
  if (!key) {
    const firstShopState = Object.values(normalized.shops).find((state) => hasFeePlanStateValues(state));
    if (firstShopState) return firstShopState;
  }
  return normalizeFeePlanState(fallbackState);
}

export function getActiveFeeSettingsFromFileStore(store, shopKey = '', fallbackSettings = emptyFeeSettings) {
  const fallbackState = normalizeFeePlanState(null, fallbackSettings);
  const state = getFeePlanStateFromFileStore(store, shopKey, fallbackState);
  return getActiveFeeSettingsFromPlanState(state, fallbackSettings);
}

export function upsertFeePlanStateInFileStore(store, shopKey = '', state, options = {}) {
  const normalized = normalizeFeeSettingsFileStore(store);
  const nextState = normalizeFeePlanState(state);
  const key = String(shopKey || '').trim();
  const updatedAt = String(options.updatedAt || new Date().toISOString());

  if (key) {
    return {
      ...normalized,
      activePlanId: nextState.activeId,
      activeShopKey: key,
      shops: {
        ...normalized.shops,
        [key]: nextState,
      },
      updatedAt,
    };
  }

  return {
    ...normalized,
    activePlanId: nextState.activeId,
    global: nextState,
    updatedAt,
  };
}
