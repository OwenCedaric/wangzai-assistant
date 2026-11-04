import http from 'node:http';
import {
  allowedCorsOrigin,
  authorizationRequired,
  bridgeRequestIsAuthorized,
  readRequestJson,
  sendJson,
} from './purchase-bridge/auth.mjs';
import { HOST, PORT } from './purchase-bridge/config.mjs';
import { handleImageProxy } from './purchase-bridge/image-proxy.mjs';
import { handlePddTitleSearch } from './purchase-bridge/pdd-title-search-service.mjs';
import {
  getPurchasePluginCaptures,
  getPurchasePluginContext,
  isPurchasePluginConnected,
  purgePurchasePluginPurchaseAccountOwner,
  purgePurchasePluginShopOwner,
  savePurchasePluginCapture,
  setPurchasePluginContext,
} from './purchase-bridge/plugin-store.mjs';
import {
  handleImageSearch,
} from './purchase-bridge/search-service.mjs';

async function isExistingBridgeHealthy() {
  try {
    const response = await fetch(`http://${HOST}:${PORT}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => ({}));
    return payload?.service === 'purchase-search-bridge';
  } catch {
    return false;
  }
}

async function handleGet(url, res) {
  if (url.pathname === '/api/purchase/plugin-context') {
    sendJson(res, 200, { ok: true, context: getPurchasePluginContext() });
    return true;
  }
  if (url.pathname === '/api/purchase/plugin-captures') {
    const after = Number(url.searchParams.get('after') || 0);
    sendJson(res, 200, { ok: true, captures: getPurchasePluginCaptures(after) });
    return true;
  }
  if (url.pathname === '/api/purchase/image-proxy') {
    await handleImageProxy(url, res);
    return true;
  }
  return false;
}

async function handlePost(url, req, res) {
  const payload = await readRequestJson(req);
  if (url.pathname === '/api/purchase/pdd-title-search') {
    const result = await handlePddTitleSearch(payload);
    sendJson(res, result.statusCode, result.body);
    return;
  }
  if (url.pathname === '/api/purchase/image-search') {
    const result = await handleImageSearch(payload);
    sendJson(res, result.statusCode, result.body);
    return;
  }
  if (url.pathname === '/api/purchase/plugin-context') {
    const context = setPurchasePluginContext(payload);
    sendJson(res, 200, { ok: true, context });
    return;
  }
  if (url.pathname === '/api/purchase/plugin-capture') {
    sendJson(res, 200, { ok: true, capture: savePurchasePluginCapture(payload) });
    return;
  }
  if (url.pathname === '/api/purchase/account-removal/ozon-shop') {
    const result = purgePurchasePluginShopOwner(payload);
    sendJson(res, result.verified ? 200 : 409, { ok: result.verified, ...result });
    return;
  }
  if (url.pathname === '/api/purchase/account-removal/purchase-account') {
    const result = purgePurchasePluginPurchaseAccountOwner(payload?.ownerId);
    sendJson(res, result.verified ? 200 : 409, { ok: result.verified, ...result });
    return;
  }
  sendJson(res, 404, { ok: false, message: '接口不存在。' });
}

async function routeRequest(req, res) {
  const requestOrigin = String(req.headers.origin || '');
  res.wangzaiCorsOrigin = allowedCorsOrigin(requestOrigin);
  if (requestOrigin && !res.wangzaiCorsOrigin) {
    sendJson(res, 403, { ok: false, message: '请求来源不受信任。' });
    return;
  }
  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { ok: true });
    return;
  }
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'purchase-search-bridge',
      port: PORT,
      pluginConnected: isPurchasePluginConnected(),
      authorizationRequired: authorizationRequired(),
    });
    return;
  }
  if (url.pathname.startsWith('/api/purchase/') && !bridgeRequestIsAuthorized(req)) {
    sendJson(res, 403, { ok: false, message: '当前软件授权不可使用拍单服务。' });
    return;
  }
  if (req.method === 'GET' && (await handleGet(url, res))) return;
  if (req.method !== 'POST') {
    sendJson(res, 404, { ok: false, message: '接口不存在。' });
    return;
  }
  try {
    await handlePost(url, req, res);
  } catch (error) {
    sendJson(res, error?.statusCode || 500, {
      ok: false,
      message: error?.message || '本地搜款服务处理失败。',
    });
  }
}

const server = http.createServer(routeRequest);

server.on('error', async (error) => {
  if (error.code === 'EADDRINUSE') {
    if (await isExistingBridgeHealthy()) {
      console.log(`[purchase-search-bridge] http://${HOST}:${PORT} 已在运行，直接复用。`);
      process.exit(0);
      return;
    }
    console.error(`[purchase-search-bridge] ${HOST}:${PORT} 已被其他程序占用，请关闭占用程序后重试。`);
    process.exit(1);
    return;
  }
  console.error('[purchase-search-bridge] 启动失败:', error);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[purchase-search-bridge] listening on http://${HOST}:${PORT}`);
});
