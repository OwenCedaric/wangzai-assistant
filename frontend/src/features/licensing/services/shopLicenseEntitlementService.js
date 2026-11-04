import {
  activatePurchasedLicense,
  bindOwnedLicenseToOzonShop,
  listShopLicenseEntitlements,
  renewPurchasedLicense,
} from './licenseCenterClient.js';

const CARD_PATTERN = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/u;
const STANDARD_SHOP_LICENSE_ROLES = new Set([
  'shop_standard_monthly',
  'shop_standard_annual',
]);

function normalizedText(value) {
  return String(value || '').trim();
}

const SHOP_BOUND_ELSEWHERE_PATTERN = /already (?:assigned|bound) to another (?:card|license|account|user)/iu;

export function isShopBoundElsewhereError(error) {
  return error?.code === 'SHOP_BOUND_TO_ANOTHER_LICENSE'
    || SHOP_BOUND_ELSEWHERE_PATTERN.test(String(error?.message || error || ''));
}

// License Center rejects a Client ID that another account's card already owns.
// Renewing here cannot fix that, so explain the real next step in Chinese.
async function bindShopOrExplainConflict(runtime, { licenseId, shopId, shopName }) {
  try {
    return await bindOwnedLicenseToOzonShop(runtime, { licenseId, shopId, shopName });
  } catch (cause) {
    if (!isShopBoundElsewhereError(cause)) throw cause;
    const error = new Error([
      `Ozon Client ID ${shopId} 已被其他账号的卡密绑定，当前账号无法直接绑定或续费该店铺。`,
      '请先在原账号中解除这个 Client ID 的店铺绑定（请以 Client ID 核对，不要只看店铺名称），或联系管理员处理换绑。',
      '这种情况不需要续费，也不需要再买新卡。',
      '当前账号的卡密额度仍然保留，解除原绑定后再次保存店铺会直接使用，不会重复扣卡。',
    ].join(''));
    error.code = 'SHOP_BOUND_TO_ANOTHER_LICENSE';
    error.status = cause?.status;
    error.cause = cause;
    throw error;
  }
}

export function createOzonShopLicenseIdentityKey(shops = []) {
  return (Array.isArray(shops) ? shops : [])
    .map((shop) => `${normalizedText(shop?.id)}:${normalizedText(shop?.clientId || shop?.client_id)}`)
    .join('|');
}

/**
 * License checks resolve asynchronously from a fixed shop snapshot.  Keep a
 * late result from an older snapshot from replacing a newer canonical SQLite
 * shop list (for example, the single blank bootstrap placeholder).
 */
export function applyOzonShopLicenseResolution(currentShops, checkedShops, resolvedShops) {
  if (
    createOzonShopLicenseIdentityKey(currentShops)
    !== createOzonShopLicenseIdentityKey(checkedShops)
  ) {
    return currentShops;
  }
  return Array.isArray(resolvedShops) ? resolvedShops : currentShops;
}

export function shopLicenseIsCurrent(entitlement, nowMs = Date.now()) {
  const expiryMs = Date.parse(entitlement?.expire_time || '');
  return entitlement?.status === 'active' && Number.isFinite(expiryMs) && expiryMs > nowMs;
}

function shopIdentityCandidates(shopOrClientId) {
  const values = typeof shopOrClientId === 'object' && shopOrClientId !== null
    ? [
        shopOrClientId.clientId,
        shopOrClientId.client_id,
      ]
    : [shopOrClientId];
  return new Set(values.map(normalizedText).filter(Boolean));
}

function entitlementContainsShop(entitlement, shopOrClientId) {
  const candidates = shopIdentityCandidates(shopOrClientId);
  if (!candidates.size) return false;
  return (Array.isArray(entitlement?.shops) ? entitlement.shops : []).some(
    (shop) => shop?.status === 'active' && candidates.has(normalizedText(shop?.shop_id)),
  );
}

export function findOzonShopLicenseEntitlement(entitlements, shopOrClientId) {
  return (Array.isArray(entitlements) ? entitlements : []).find(
    (entitlement) => entitlementContainsShop(entitlement, shopOrClientId),
  ) || null;
}

export async function getOzonShopLicenseExpiration(runtime, shopOrClientId) {
  const entitlements = await listShopLicenseEntitlements(runtime);
  const entitlement = findOzonShopLicenseEntitlement(entitlements, shopOrClientId);
  if (entitlement) {
    return {
      licenseId: entitlement.license_id,
      expireAt: normalizedText(entitlement.expire_time),
      status: normalizedText(entitlement.status),
    };
  }
  return null;
}

export async function resolveOzonShopLicenseStates(runtime, shops = []) {
  const entitlements = await listShopLicenseEntitlements(runtime);
  const nowMs = Date.now();
  return (Array.isArray(shops) ? shops : []).map((shop) => {
    const entitlement = findOzonShopLicenseEntitlement(entitlements, shop);
    const active = shopLicenseIsCurrent(entitlement, nowMs);
    return {
      ...shop,
      licenseAuthorizationStatus: active
        ? 'active'
        : entitlement
          ? 'expired'
          : 'missing',
      licenseAuthorized: active,
      licenseId: entitlement?.license_id ?? null,
      licenseExpireAt: normalizedText(entitlement?.expire_time),
      ...(!active
        ? {
            connectionStatus: '未授权',
            connectionMessage: entitlement
              ? '当前店铺卡密已到期，请续费后再连接 Ozon。'
              : '当前店铺尚未绑定有效卡密，不能连接 Ozon 或读取店铺数据。',
            connectionDetail: '',
          }
        : {}),
    };
  });
}

export async function renewOzonShopLicense(runtime, shopOrClientId, cardKey) {
  const renewalCard = requireCard(
    cardKey,
    'SHOP_LICENSE_RENEWAL_CARD_REQUIRED',
    '请输入月卡或年卡卡密后再续费。',
  );
  const clientId = normalizedText(
    typeof shopOrClientId === 'object'
      ? shopOrClientId?.clientId || shopOrClientId?.client_id
      : shopOrClientId,
  );
  if (!clientId) {
    const error = new Error('当前店铺缺少 Ozon Client ID，无法确定要续费的店铺。');
    error.code = 'OZON_CLIENT_ID_REQUIRED';
    throw error;
  }

  const entitlements = await listShopLicenseEntitlements(runtime);
  const matching = findOzonShopLicenseEntitlement(entitlements, clientId);
  if (!matching?.license_id) {
    // An existing local shop can predate the per-shop ledger.  It must not use
    // an account-level fallback: consume (or resume) one real shop card and
    // create the exact Client-ID binding before any Ozon access is restored.
    const authorization = await authorizeAdditionalShopSlot(runtime, renewalCard);
    const shopName = normalizedText(
      typeof shopOrClientId === 'object'
        ? shopOrClientId?.sellerName
          || shopOrClientId?.name
          || shopOrClientId?.shopAlias
          || shopOrClientId?.alias
        : '',
    ) || clientId;
    const bound = await bindShopOrExplainConflict(runtime, {
      licenseId: authorization.licenseId,
      shopId: clientId,
      shopName,
    });
    return {
      action: 'activated-and-bound',
      licenseId: authorization.licenseId,
      expireAt: normalizedText(bound?.expire || bound?.expire_time),
    };
  }

  const result = await renewPurchasedLicense(runtime, matching.license_id, renewalCard);
  return {
    action: 'renewed',
    licenseId: matching.license_id,
    expireAt: normalizedText(result?.expire || result?.expire_time),
  };
}

function requireCard(cardKey, code, message) {
  const normalized = normalizedText(cardKey).toUpperCase();
  if (CARD_PATTERN.test(normalized)) return normalized;
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function findPendingAdditionalShopLicense(entitlements, nowMs = Date.now()) {
  return (Array.isArray(entitlements) ? entitlements : []).find((item) => (
    STANDARD_SHOP_LICENSE_ROLES.has(normalizedText(item?.license_role))
    && shopLicenseIsCurrent(item, nowMs)
    && (!Array.isArray(item?.shops) || item.shops.length === 0)
  )) || null;
}

export async function getPendingAdditionalShopLicense(runtime) {
  return findPendingAdditionalShopLicense(await listShopLicenseEntitlements(runtime));
}

export async function authorizeAdditionalShopSlot(runtime, cardKey) {
  const existing = await getPendingAdditionalShopLicense(runtime);
  if (existing) {
    return { action: 'resume-pending', licenseId: existing.license_id };
  }
  const activationCard = requireCard(
    cardKey,
    'ADDITIONAL_SHOP_CARD_REQUIRED',
    '每新增一个店铺都需要一张新的月卡或年卡，请先输入卡密。',
  );
  await activatePurchasedLicense(runtime, activationCard);
  const activated = await getPendingAdditionalShopLicense(runtime);
  if (!activated) {
    const error = new Error('卡密已激活，但授权服务未返回待绑定店铺额度，请重新打开新增店铺。');
    error.code = 'ADDITIONAL_SHOP_SLOT_NOT_FOUND';
    throw error;
  }
  return { action: 'activated', licenseId: activated.license_id };
}

export async function authorizeOzonShopSave(runtime, shop) {
  const clientId = normalizedText(shop?.clientId || shop?.client_id);
  if (!clientId) {
    if (shop?.hasClientId === true) return { action: 'main-process-verification' };
    const error = new Error('请先填写 Ozon Client ID。');
    error.code = 'OZON_CLIENT_ID_REQUIRED';
    throw error;
  }
  const shopName = normalizedText(
    shop?.sellerName || shop?.name || shop?.shopAlias || shop?.alias || clientId,
  );
  const entitlements = await listShopLicenseEntitlements(runtime);
  const matching = findOzonShopLicenseEntitlement(entitlements, shop);
  if (matching && shopLicenseIsCurrent(matching)) {
    return { action: 'already-authorized', licenseId: matching.license_id };
  }
  if (matching) {
    const error = new Error('该店铺授权已到期，请先完成续费。');
    error.code = 'SHOP_LICENSE_RENEWAL_CARD_REQUIRED';
    throw error;
  }
  const unbound = entitlements.find(
    (item) => shopLicenseIsCurrent(item) && (!Array.isArray(item?.shops) || item.shops.length === 0),
  );
  if (unbound) {
    await bindShopOrExplainConflict(runtime, {
      licenseId: unbound.license_id,
      shopId: clientId,
      shopName,
    });
    return { action: 'bound-existing', licenseId: unbound.license_id };
  }
  const error = new Error('请点击“新增”并先激活月卡或年卡，验证成功后才能填写和保存新店铺。');
  error.code = 'ADDITIONAL_SHOP_PREACTIVATION_REQUIRED';
  throw error;
}
