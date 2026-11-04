const OZON_SELLER_INTEGRATION_TYPE = 'ozon-browser-session';

function clean(value) {
  return String(value ?? '').trim();
}

function gateError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  return error;
}

function commandOwner(input = {}, snapshot = {}) {
  let accountId = clean(input.accountId);
  let ownerType = clean(input.ownerType);
  if (accountId && ownerType) return { accountId, ownerType };

  const requestedTabId = clean(input.tabId || snapshot.activeTabId);
  const tab = Array.isArray(snapshot.tabs)
    ? snapshot.tabs.find((candidate) => clean(candidate?.tabId) === requestedTabId)
    : null;
  accountId ||= clean(tab?.accountId);
  ownerType ||= clean(tab?.ownerType);
  return { accountId, ownerType };
}

/**
 * Authorize the Ozon Seller native browser with the same exact Client ID
 * ledger used by API and cache reads. The renderer supplies neither the
 * Client ID nor the grant: Main resolves integration profile -> local shop ->
 * Client ID through its private local-api capability before checking License
 * Center state.
 */
export async function assertOzonSellerBrowserEntitled({
  input = {},
  snapshot = {},
  localApiClient,
  licenseRuntime,
} = {}) {
  const owner = commandOwner(input, snapshot);
  if (owner.ownerType !== 'integration_profile' || !owner.accountId) {
    return { authorized: true, applicable: false };
  }
  if (typeof localApiClient?.getOwnerBinding !== 'function') {
    throw gateError('SHOP_LICENSE_BROWSER_GATE_UNAVAILABLE', '店铺卡密校验服务尚未就绪。');
  }
  const payload = await localApiClient.getOwnerBinding(owner.accountId, owner.ownerType);
  const binding = payload?.binding || {};
  if (clean(binding.integrationType) !== OZON_SELLER_INTEGRATION_TYPE) {
    return { authorized: true, applicable: false };
  }
  const clientId = clean(binding.clientId);
  if (!clientId) {
    throw gateError(
      'SHOP_LICENSE_CLIENT_ID_REQUIRED',
      '当前卖家后台登录没有对应到已保存的 Ozon Client ID。',
    );
  }
  if (typeof licenseRuntime?.assertOzonShopEntitled !== 'function') {
    throw gateError('SHOP_LICENSE_BROWSER_GATE_UNAVAILABLE', '店铺卡密校验服务尚未就绪。');
  }
  await licenseRuntime.assertOzonShopEntitled(clientId);
  return { authorized: true, applicable: true };
}

export default assertOzonSellerBrowserEntitled;
