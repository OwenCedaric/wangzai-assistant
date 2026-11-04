import {
  listIntegrationProfiles,
  saveIntegrationProfile,
  verifyOzonBrowserShopIdentity,
} from '../../../api/localApiClient.js';

export const OZON_SHOP_SELLER_LOGIN_TYPE = 'ozon-browser-session';

function text(value) {
  return String(value ?? '').trim();
}

function profilesFrom(result = {}) {
  return Array.isArray(result?.profiles)
    ? result.profiles
    : Array.isArray(result?.rows)
      ? result.rows
      : [];
}

export function selectExactOzonShopSellerLoginProfile(profiles = [], shopId = '') {
  const exactShopId = text(shopId);
  if (!exactShopId) return null;
  return (Array.isArray(profiles) ? profiles : []).find((profile) => (
    text(profile?.integrationType) === OZON_SHOP_SELLER_LOGIN_TYPE
    && text(profile?.shopId) === exactShopId
  )) || null;
}

export function isOzonShopSellerLoginConnected(profile = {}) {
  return text(profile?.configStatus) === '连接成功'
    && text(profile?.tokenStatus) === 'Cookie 已保存'
    && text(profile?.identityStatus) === 'verified';
}

export async function readOzonShopSellerLoginProfile({ shopId = '' } = {}, options = {}) {
  const exactShopId = text(shopId);
  if (!exactShopId) return null;
  const loader = options.listProfiles || listIntegrationProfiles;
  const result = await loader({
    signal: options.signal,
    timeoutMs: options.timeoutMs || 30_000,
  });
  return selectExactOzonShopSellerLoginProfile(profilesFrom(result), exactShopId);
}

function profilePayload({ profile = {}, shopId, shopName, connected = false }) {
  const exactShopId = text(shopId);
  const exactShopName = text(shopName) || exactShopId;
  return {
    ...(text(profile?.id) ? { id: text(profile.id) } : {}),
    integrationType: OZON_SHOP_SELLER_LOGIN_TYPE,
    platformName: `Ozon 卖家后台 · ${exactShopName}`,
    shopId: exactShopId,
    apiType: 'Ozon Seller Web',
    authMode: '验证码登录',
    configStatus: connected ? '连接成功' : text(profile?.configStatus) || '待登录',
    tokenStatus: connected ? 'Cookie 已保存' : text(profile?.tokenStatus) || 'Cookie 未保存',
    readScope: '当前店铺卖家后台商品、客服与投诉回读',
    writeScope: '当前店铺剔除跟卖投诉提交',
    note: 'Ozon 店铺设置创建；每个 shopId 使用独立浏览器 Profile/RequestContext 和 Cookie',
  };
}

export async function ensureOzonShopSellerLoginProfile({ shopId = '', shopName = '' } = {}, options = {}) {
  const exactShopId = text(shopId);
  if (!exactShopId) throw new Error('请选择需要登录卖家后台的 Ozon 店铺。');
  const existing = await readOzonShopSellerLoginProfile({ shopId: exactShopId }, options);
  if (existing?.id) return existing;
  const saver = options.saveProfile || saveIntegrationProfile;
  try {
    const saved = await saver(profilePayload({ shopId: exactShopId, shopName }), {
      signal: options.signal,
      timeoutMs: options.timeoutMs || 30_000,
    });
    const profile = saved?.profile || saved?.data?.profile || null;
    if (!profile?.id || text(profile.shopId) !== exactShopId) {
      throw new Error('Ozon 卖家后台登录配置没有绑定到当前店铺。');
    }
    return profile;
  } catch (error) {
    const concurrent = await readOzonShopSellerLoginProfile({ shopId: exactShopId }, options).catch(() => null);
    if (concurrent?.id) return concurrent;
    throw error;
  }
}

export async function completeOzonShopSellerLogin({
  profile,
  shopId = '',
  result = {},
} = {}, options = {}) {
  const exactShopId = text(shopId);
  if (!profile?.id || text(profile.shopId) !== exactShopId) {
    throw new Error('卖家后台登录配置与当前店铺不一致，已停止保存。');
  }
  if (result?.loggedIn !== true || result?.cookieSaved !== true) {
    throw new Error('Ozon 登录或 Cookie 保存尚未通过验证。');
  }
  if (result?.profile?.shopId && text(result.profile.shopId) !== exactShopId) {
    throw new Error('浏览器保存的卖家账号与当前店铺不一致。');
  }
  if (text(result?.identityStatus || result?.profile?.identityStatus) === 'mismatch') {
    const browserId = text(result?.profile?.browserCompanyId) || '未识别';
    const apiId = text(result?.profile?.apiIdentityId) || '当前店铺';
    throw new Error(`网页登录账号 ${browserId} 与 API 账号 ${apiId} 不一致。`);
  }
  const verifier = options.verifyIdentity || verifyOzonBrowserShopIdentity;
  const saved = await verifier(profile.id, exactShopId, {
    signal: options.signal,
    timeoutMs: options.timeoutMs || 60_000,
  });
  const connected = saved?.profile || saved?.data?.profile || null;
  if (!connected?.id
    || text(connected.shopId) !== exactShopId
    || !isOzonShopSellerLoginConnected(connected)) {
    throw new Error('Ozon 卖家后台账号与当前店铺 API 身份核对未通过。');
  }
  return connected;
}
