import {
  LOGISTICS_PRICING_PRESET_VERSION,
  LOGISTICS_PRICING_PROVIDERS,
} from '../shared/config/logisticsPricingPresets.js';

export const LOGISTICS_PRICING_SETTINGS_SCHEMA_VERSION = 1;

const VALID_PROVIDER_IDS = new Set(LOGISTICS_PRICING_PROVIDERS.map((provider) => provider.id));
const VALID_MARKETS = new Set(LOGISTICS_PRICING_PROVIDERS.flatMap((provider) => provider.markets));
const VALID_SERVICE_LEVELS = new Set(['auto', 'express', 'standard', 'economy', 'hk']);

export const emptyLogisticsPricingSelection = Object.freeze({
  // 兼容项目原有 GUOO 预估口径；用户可在设置里切为自动或其他服务商。
  providerId: 'guoo',
  market: 'RU',
  serviceLevel: 'auto',
  routeId: '',
});

function toPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeScopeMap(value) {
  return Object.fromEntries(
    Object.entries(toPlainObject(value))
      .map(([key, selection]) => [String(key || '').trim(), normalizeLogisticsPricingSelection(selection)])
      .filter(([key]) => Boolean(key))
  );
}

export function normalizeLogisticsPricingSelection(value) {
  const source = toPlainObject(value);
  const requestedProviderId = String(source.providerId || source.provider || 'guoo').trim().toLowerCase();
  const providerId = requestedProviderId === 'auto' || VALID_PROVIDER_IDS.has(requestedProviderId)
    ? requestedProviderId
    : 'auto';
  const requestedMarket = String(source.market || 'RU').trim().toUpperCase();
  const market = VALID_MARKETS.has(requestedMarket) ? requestedMarket : 'RU';
  const requestedServiceLevel = String(source.serviceLevel || source.service || 'auto').trim().toLowerCase();
  const serviceLevel = VALID_SERVICE_LEVELS.has(requestedServiceLevel) ? requestedServiceLevel : 'auto';
  return {
    providerId,
    market,
    serviceLevel,
    routeId: String(source.routeId || '').trim(),
  };
}

export function normalizeLogisticsPricingSettings(value) {
  const source = toPlainObject(value);
  return {
    schemaVersion: LOGISTICS_PRICING_SETTINGS_SCHEMA_VERSION,
    presetVersion: LOGISTICS_PRICING_PRESET_VERSION,
    globalSelection: normalizeLogisticsPricingSelection(source.globalSelection),
    shopSelections: normalizeScopeMap(source.shopSelections),
    accountSelections: normalizeScopeMap(source.accountSelections),
    updatedAt: String(source.updatedAt || ''),
  };
}

export function setLogisticsPricingScopeSelection(settings, scope = {}, selection = {}) {
  const normalized = normalizeLogisticsPricingSettings(settings);
  const nextSelection = normalizeLogisticsPricingSelection(selection);
  const scopeType = String(scope.type || 'global').trim().toLowerCase();
  const scopeId = String(scope.id || '').trim();
  if (scopeType === 'account' && scopeId) {
    return {
      ...normalized,
      accountSelections: { ...normalized.accountSelections, [scopeId]: nextSelection },
    };
  }
  if (scopeType === 'shop' && scopeId) {
    return {
      ...normalized,
      shopSelections: { ...normalized.shopSelections, [scopeId]: nextSelection },
    };
  }
  return { ...normalized, globalSelection: nextSelection };
}

export function resolveLogisticsPricingSelection(settings, context = {}) {
  const normalized = normalizeLogisticsPricingSettings(settings);
  const accountIds = [
    context.accountId,
    context.shopClientId,
    context.clientId,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const shopIds = [
    context.shopId,
    context.ownerShopId,
  ].map((value) => String(value || '').trim()).filter(Boolean);

  for (const accountId of accountIds) {
    if (normalized.accountSelections[accountId]) {
      return {
        ...normalized.accountSelections[accountId],
        scopeType: 'account',
        scopeId: accountId,
      };
    }
  }
  for (const shopId of shopIds) {
    if (normalized.shopSelections[shopId]) {
      return {
        ...normalized.shopSelections[shopId],
        scopeType: 'shop',
        scopeId: shopId,
      };
    }
  }
  return { ...normalized.globalSelection, scopeType: 'global', scopeId: '' };
}
