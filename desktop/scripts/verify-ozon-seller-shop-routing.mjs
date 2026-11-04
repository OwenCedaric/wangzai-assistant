import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] || 9223);
const endpoint = `http://127.0.0.1:${port}/json`;
const targets = await fetch(endpoint).then((response) => response.json());
const target = targets.find((item) => item.type === 'page' && item.url.startsWith('app://')) || targets[0];
if (!target?.webSocketDebuggerUrl) throw new Error(`没有找到 Electron CDP 页面：${endpoint}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let requestId = 0;
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
};

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 请求超时：${method}`));
    }, 60_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面执行失败');
  }
  return result.result?.value;
}

const inventory = await evaluate(`(async () => {
  const [shopResult, profileResult] = await Promise.all([
    window.wangzaiDesktop.localApiRequest({ method: 'GET', path: '/api/shops', timeoutMs: 10000 }),
    window.wangzaiDesktop.localApiRequest({ method: 'GET', path: '/api/integrations/profiles', timeoutMs: 10000 }),
  ]);
  const shopPayload = shopResult?.data || shopResult || {};
  const profilePayload = profileResult?.data || profileResult || {};
  return {
    shops: Array.isArray(shopPayload.shops) ? shopPayload.shops : Array.isArray(shopPayload.rows) ? shopPayload.rows : [],
    profiles: Array.isArray(profilePayload.profiles) ? profilePayload.profiles : Array.isArray(profilePayload.rows) ? profilePayload.rows : [],
  };
})()`);

const shops = inventory.shops
  .map((shop) => ({
    id: String(shop.id || shop.shopId || '').trim(),
    name: String(shop.name || shop.shopName || shop.id || '').trim(),
  }))
  .filter((shop) => shop.id);
const connectedProfiles = inventory.profiles
  .filter((profile) => (
    String(profile.integrationType || profile.integration_type || '').trim() === 'ozon-browser-session'
    && String(profile.configStatus || profile.config_status || '').trim() === '连接成功'
    && String(profile.tokenStatus || profile.token_status || '').trim() === 'Cookie 已保存'
  ))
  .map((profile) => ({
    id: String(profile.id || '').trim(),
    shopId: String(profile.shopId || profile.shop_id || '').trim(),
  }));

if (!shops.length) throw new Error('真实数据库没有可验证的 Ozon 店铺');

const results = [];
for (const shop of shops) {
  const expectedProfiles = connectedProfiles.filter((profile) => profile.shopId === shop.id);
  const outcome = await evaluate(`(async () => {
    const before = await window.wangzaiDesktop.purchaseBrowser.command({ command: 'state' });
    try {
      await window.wangzaiDesktop.purchaseBrowser.command({
        command: 'open-external',
        url: 'https://seller.ozon.ru/app/postings/fbs',
        shopId: ${JSON.stringify(shop.id)},
        requireShopBinding: true,
        platformName: 'Ozon',
        accountLabel: ${JSON.stringify(shop.name)},
        browserRole: 'product-link-parser',
        background: true,
        restoreVisible: false,
      });
      const after = await window.wangzaiDesktop.purchaseBrowser.command({ command: 'state' });
      const beforeIds = new Set((before.tabs || []).map((tab) => tab.tabId));
      const candidates = (after.tabs || []).filter((tab) => (
        tab.ownerType === 'integration_profile'
        && tab.browserRole === 'product-link-parser'
        && (!beforeIds.has(tab.tabId) || tab.accountId === ${JSON.stringify(expectedProfiles[0]?.id || '')})
      ));
      const matched = candidates.find((tab) => tab.accountId === ${JSON.stringify(expectedProfiles[0]?.id || '')}) || null;
      return {
        ok: true,
        beforeTabCount: before.tabs?.length || 0,
        afterTabCount: after.tabs?.length || 0,
        matched: matched ? {
          tabId: matched.tabId,
          accountId: matched.accountId,
          ownerType: matched.ownerType,
          browserRole: matched.browserRole,
          url: matched.url,
        } : null,
      };
    } catch (error) {
      const after = await window.wangzaiDesktop.purchaseBrowser.command({ command: 'state' });
      return {
        ok: false,
        code: String(error?.code || ''),
        message: String(error?.message || error || ''),
        beforeTabCount: before.tabs?.length || 0,
        afterTabCount: after.tabs?.length || 0,
        beforeAccountIds: (before.tabs || []).map((tab) => tab.accountId).sort(),
        afterAccountIds: (after.tabs || []).map((tab) => tab.accountId).sort(),
      };
    }
  })()`);

  const hasOneBoundProfile = expectedProfiles.length === 1;
  const missingProfileError = outcome.code === 'PURCHASE_BROWSER_OZON_SELLER_SHOP_PROFILE_REQUIRED'
    || String(outcome.message || '').includes('PURCHASE_BROWSER_OZON_SELLER_SHOP_PROFILE_REQUIRED');
  const unchangedAfterFailure = outcome.beforeTabCount === outcome.afterTabCount
    && JSON.stringify(outcome.beforeAccountIds || []) === JSON.stringify(outcome.afterAccountIds || []);
  const passed = hasOneBoundProfile
    ? outcome.ok === true && outcome.matched?.accountId === expectedProfiles[0].id
    : expectedProfiles.length === 0
      ? outcome.ok === false && missingProfileError && unchangedAfterFailure
      : false;

  results.push({
    shop,
    expectedProfileIds: expectedProfiles.map((profile) => profile.id),
    expected: hasOneBoundProfile ? 'open-exact-profile' : expectedProfiles.length === 0 ? 'fail-closed' : 'reject-duplicate-binding',
    passed,
    outcome,
  });
}

const report = {
  checkedAt: new Date().toISOString(),
  shopCount: shops.length,
  connectedProfileCount: connectedProfiles.length,
  exactOpenCount: results.filter((result) => result.expected === 'open-exact-profile' && result.passed).length,
  failClosedCount: results.filter((result) => result.expected === 'fail-closed' && result.passed).length,
  results,
};
report.passed = report.shopCount > 0 && results.every((result) => result.passed);

const outputDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-results');
await mkdir(outputDirectory, { recursive: true });
const reportPath = path.join(outputDirectory, 'ozon-seller-shop-routing.json');
await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
socket.close();

console.log(JSON.stringify({ ...report, reportPath }, null, 2));
if (!report.passed) process.exitCode = 1;
