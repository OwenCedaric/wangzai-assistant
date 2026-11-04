function normalizeClientId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createGrantError(message, code) {
  const error = new Error(message);
  error.name = 'ShopLicenseGrantError';
  error.code = code;
  error.retryable = false;
  return error;
}

export function createShopLicenseGrantRegistry({
  enforce = true,
  now = () => Date.now(),
} = {}) {
  let expiryByClientId = new Map();

  function replace(grants = []) {
    if (!Array.isArray(grants) || grants.length > 10_000) {
      throw createGrantError('店铺授权清单无效。', 'SHOP_LICENSE_GRANTS_INVALID');
    }
    const currentTime = Number(now());
    const next = new Map();
    for (const grant of grants) {
      const clientId = normalizeClientId(grant?.clientId ?? grant?.client_id);
      const expiry = Date.parse(String(grant?.expireAt ?? grant?.expire_at ?? ''));
      if (!clientId || clientId.length > 256 || !Number.isFinite(expiry)) {
        throw createGrantError('店铺授权记录无效。', 'SHOP_LICENSE_GRANT_INVALID');
      }
      if (expiry <= currentTime) continue;
      next.set(clientId, Math.max(next.get(clientId) || 0, expiry));
    }
    expiryByClientId = next;
    return { ok: true, activeGrantCount: next.size };
  }

  function assertActive(clientIdInput) {
    if (!enforce) return { authorized: true, enforcement: 'disabled' };
    const clientId = normalizeClientId(clientIdInput);
    if (!clientId) {
      throw createGrantError('Ozon 请求缺少店铺授权标识。', 'SHOP_LICENSE_CLIENT_ID_REQUIRED');
    }
    const expiry = expiryByClientId.get(clientId) || 0;
    if (expiry <= Number(now())) {
      expiryByClientId.delete(clientId);
      throw createGrantError(
        '当前 Ozon 店铺未绑定有效卡密或授权已到期。',
        'SHOP_LICENSE_REQUIRED',
      );
    }
    return { authorized: true, clientId, expireAt: new Date(expiry).toISOString() };
  }

  return Object.freeze({
    enforce,
    replace,
    assertActive,
    clear() {
      expiryByClientId = new Map();
      return { ok: true, activeGrantCount: 0 };
    },
    snapshot() {
      const currentTime = Number(now());
      return [...expiryByClientId.entries()]
        .filter(([, expiry]) => expiry > currentTime)
        .map(([clientId, expiry]) => ({
          clientId,
          expireAt: new Date(expiry).toISOString(),
        }));
    },
  });
}
