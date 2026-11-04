import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { execFile as execFileCallback } from 'node:child_process';

const DEFAULT_GATEWAY_PORT = 3794;
const DEFAULT_FUNNEL_PORT = 8443;
const MAX_BODY_BYTES = 512 * 1024;
const PUSH_PATH_PREFIX = '/api/ozon/push/';
const INTERNAL_PUSH_PATH = '/api/internal/ozon/push-notifications';
const INTERNAL_SIGNATURE_HEADER = 'x-wangzai-ozon-push-signature';
const LOCAL_API_TOKEN_HEADER = 'x-wangzai-local-api-token';
const SERVICE_NAME = 'Wangzai Ozon Notifications';
const SERVICE_VERSION = '1.1.0';

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalizeBaseUrl(value) {
  const text = normalizeText(value).replace(/\/+$/u, '');
  if (!text) return '';
  const parsed = new URL(text);
  if (parsed.protocol !== 'https:') throw new Error('OZON_PUSH_PUBLIC_BASE_URL_HTTPS_REQUIRED');
  return parsed.toString().replace(/\/+$/u, '');
}

function deepSort(value) {
  if (Array.isArray(value)) return value.map(deepSort);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = deepSort(value[key]);
    return result;
  }, {});
}

function canonicalBody(value) {
  return Buffer.from(JSON.stringify(deepSort(value)), 'utf8');
}

function safeEqual(left, right) {
  const a = Buffer.from(normalizeText(left), 'utf8');
  const b = Buffer.from(normalizeText(right), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createOzonPushBindingToken(secret, { bindingId, shopId, clientId } = {}) {
  const normalizedBindingId = normalizeText(bindingId);
  const material = [normalizedBindingId, normalizeText(shopId), normalizeText(clientId)].join('\n');
  if (!normalizedBindingId || normalizeText(secret).length < 32) {
    throw new Error('OZON_PUSH_BINDING_SECRET_INVALID');
  }
  const signature = crypto.createHmac('sha256', normalizeText(secret)).update(material, 'utf8').digest('base64url');
  return `${normalizedBindingId}.${signature}`;
}

export function verifyOzonPushBindingToken(secret, token, shop = {}) {
  const expected = createOzonPushBindingToken(secret, {
    bindingId: shop.ozonPushBindingId,
    shopId: shop.id,
    clientId: shop.clientId,
  });
  return safeEqual(token, expected);
}

export function createInternalOzonPushSignature(secret, envelope, timestamp = Math.floor(Date.now() / 1000)) {
  const time = String(timestamp);
  const digest = crypto.createHmac('sha256', normalizeText(secret))
    .update(time, 'ascii')
    .update('.', 'ascii')
    .update(canonicalBody(envelope))
    .digest('hex');
  return `t=${time},v1=${digest}`;
}

export function toInternalOzonPushEnvelope(payload, shop, receivedAt = new Date().toISOString()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('OZON_PUSH_BODY_OBJECT_REQUIRED');
  }
  const messageType = normalizeText(payload.message_type);
  if (!messageType) throw new Error('OZON_PUSH_MESSAGE_TYPE_REQUIRED');
  const expectedSellerId = normalizeText(shop?.clientId);
  const suppliedSellerId = normalizeText(payload.seller_id ?? payload.sellerId ?? payload.client_id);
  if (!expectedSellerId) throw new Error('OZON_PUSH_SHOP_CLIENT_ID_REQUIRED');
  if (suppliedSellerId && suppliedSellerId !== expectedSellerId) {
    throw new Error('OZON_PUSH_SELLER_SCOPE_MISMATCH');
  }
  const normalizedPayload = { ...payload, seller_id: expectedSellerId };
  const remoteId = normalizeText(payload.id ?? payload.event_id ?? payload.notification_id)
    || `direct_${crypto.createHash('sha256').update(canonicalBody(normalizedPayload)).digest('hex')}`;
  return {
    events: [{
      id: remoteId,
      message_type: messageType,
      seller_id: expectedSellerId,
      received_at: normalizeText(payload.time ?? payload.created_at) || receivedAt,
      payload: normalizedPayload,
    }],
  };
}

function publicError(code, message, status = 400) {
  return { status, body: { error: { code, message, details: null } } };
}

function readJsonBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > limit) {
        const error = new Error('OZON_PUSH_BODY_TOO_LARGE');
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('OZON_PUSH_BODY_INVALID_JSON'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, body) {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(serialized),
  });
  response.end(serialized);
}

const TAILSCALE_TIMEOUT_MS = 20_000;

const COMMAND_ERROR_MESSAGES = Object.freeze({
  OZON_PUSH_TAILSCALE_NOT_INSTALLED: '当前电脑没有找到 Tailscale，请先安装并登录 Tailscale，或配置服务器通知地址。',
  OZON_PUSH_TAILSCALE_NOT_RUNNING: 'Tailscale 后台服务没有运行，请打开 Tailscale 后重试。',
  OZON_PUSH_TAILSCALE_NOT_LOGGED_IN: 'Tailscale 尚未登录，请先登录 Tailscale 后重试。',
  OZON_PUSH_TAILSCALE_NOT_CONNECTED: '当前电脑的公网通道未连接，请先启动 Tailscale，或配置服务器通知地址。',
  OZON_PUSH_TAILSCALE_STATUS_INVALID: 'Tailscale 状态读取异常，请重启 Tailscale 后重试。',
  OZON_PUSH_TAILSCALE_FUNNEL_NOT_ENABLED: 'Tailscale 账号尚未开启 Funnel 公网访问，请在 Tailscale 管理后台开启后重试。',
  OZON_PUSH_TAILSCALE_FUNNEL_FAILED: 'Tailscale 公网通道开启失败，请确认 Tailscale 已登录并允许 Funnel 后重试。',
  OZON_PUSH_TAILSCALE_TIMEOUT: 'Tailscale 响应超时，请确认 Tailscale 正常运行后重试。',
  OZON_PUSH_GATEWAY_PORT_IN_USE: '本机通知接收端口被其他程序占用，请关闭占用程序或重启电脑后重试。',
  OZON_PUSH_GATEWAY_START_FAILED: '本机通知接收服务启动失败，请重启旺崽助手后重试。',
  OZON_PUSH_LOCAL_API_UNAVAILABLE: '本地店铺服务没有响应，请稍后重试或重启旺崽助手。',
  OZON_PUSH_BINDING_SAVE_FAILED: '通知地址未能保存到当前店铺，本次没有生效，请重试。',
  OZON_PUSH_PUBLIC_BASE_URL_HTTPS_REQUIRED: '服务器通知地址必须使用 HTTPS。',
  OZON_PUSH_RUNTIME_NOT_CONFIGURED: '店铺通知运行环境尚未就绪，请重启旺崽助手。',
});

function stageError(code, cause) {
  const error = new Error(code);
  error.code = code;
  error.cause = cause;
  return error;
}

function tailscaleCommandError(error, fallbackCode) {
  if (error?.code === 'ENOENT') return stageError('OZON_PUSH_TAILSCALE_NOT_INSTALLED', error);
  if (error?.killed || error?.code === 'ETIMEDOUT') return stageError('OZON_PUSH_TAILSCALE_TIMEOUT', error);
  const output = `${normalizeText(error?.stderr)}\n${normalizeText(error?.stdout)}\n${normalizeText(error?.message)}`;
  if (/failed to connect to local tailscale|tailscaled|is tailscale running/iu.test(output)) {
    return stageError('OZON_PUSH_TAILSCALE_NOT_RUNNING', error);
  }
  if (/logged out|needs ?login|not logged in/iu.test(output)) {
    return stageError('OZON_PUSH_TAILSCALE_NOT_LOGGED_IN', error);
  }
  if (fallbackCode === 'OZON_PUSH_TAILSCALE_FUNNEL_FAILED' && /funnel/iu.test(output) && /not enabled|enable|admin|policy|acl/iu.test(output)) {
    return stageError('OZON_PUSH_TAILSCALE_FUNNEL_NOT_ENABLED', error);
  }
  return stageError(fallbackCode, error);
}

function execFilePromise(execFileImpl, file, args) {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, { windowsHide: true, encoding: 'utf8', timeout: TAILSCALE_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function publicShopPatch(shop, updates) {
  return {
    id: shop.id,
    name: shop.name || shop.alias || shop.id,
    alias: shop.alias || '',
    clientId: shop.clientId || '',
    status: shop.status || 'active',
    ...updates,
  };
}

export function createOzonPushEndpointRuntime({
  runtimeInfo,
  secretPath,
  fetchImpl = fetch,
  createServerImpl = http.createServer,
  execFileImpl = execFileCallback,
  env = process.env,
  gatewayPort = DEFAULT_GATEWAY_PORT,
  funnelPort = DEFAULT_FUNNEL_PORT,
  tailscaleExecutable = 'C:\\Program Files\\Tailscale\\tailscale.exe',
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  logger = () => undefined,
} = {}) {
  const localApi = runtimeInfo?.localApi || {};
  const localApiBaseUrl = normalizeText(localApi.baseUrl).replace(/\/+$/u, '');
  const localApiAuthToken = normalizeText(localApi.authToken);
  const signingSecret = normalizeText(secretPath && fs.readFileSync(secretPath, 'utf8'));
  if (!localApiBaseUrl || !localApiAuthToken || signingSecret.length < 32) {
    throw new Error('OZON_PUSH_RUNTIME_NOT_CONFIGURED');
  }
  let server = null;
  let serverReady = null;
  const pendingReceiptWrites = new Map();

  async function localApiJson(pathname, { method = 'GET', body } = {}) {
    const response = await fetchImpl(`${localApiBaseUrl}${pathname}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        [LOCAL_API_TOKEN_HEADER]: localApiAuthToken,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(normalizeText(data?.error?.message ?? data?.message) || `LOCAL_API_${response.status}`);
      error.code = normalizeText(data?.error?.code) || `LOCAL_API_${response.status}`;
      throw error;
    }
    return data;
  }

  async function listShops() {
    const data = await localApiJson('/api/shops');
    return Array.isArray(data?.shops) ? data.shops : [];
  }

  async function getShop(shopId) {
    const normalizedShopId = normalizeText(shopId);
    return (await listShops()).find((shop) => normalizeText(shop?.id) === normalizedShopId) || null;
  }

  async function saveShop(shop, updates) {
    const result = await localApiJson('/api/shops', {
      method: 'POST',
      body: publicShopPatch(shop, updates),
    });
    return result?.shop || result?.binding?.shop || result;
  }

  function scheduleReceiptWrite(shop, receivedAt) {
    const shopId = normalizeText(shop?.id);
    if (!shopId) return;
    const previous = pendingReceiptWrites.get(shopId);
    if (previous?.timer) clearTimeout(previous.timer);
    const entry = { shop, receivedAt, timer: null };
    entry.timer = setTimeout(() => {
      pendingReceiptWrites.delete(shopId);
      void saveShop(entry.shop, {
        ozonPushStatus: 'receiving',
        ozonPushLastReceivedAt: entry.receivedAt,
      }).catch((error) => logger(`[ozon-push] receipt write failed=${normalizeText(error?.message || error)}`));
    }, 250);
    entry.timer.unref?.();
    pendingReceiptWrites.set(shopId, entry);
  }

  function bindingView(shop) {
    const bindingId = normalizeText(shop?.ozonPushBindingId);
    const baseUrl = normalizeText(shop?.ozonPushPublicBaseUrl).replace(/\/+$/u, '');
    if (!bindingId || !baseUrl) return null;
    const token = createOzonPushBindingToken(signingSecret, {
      bindingId,
      shopId: shop.id,
      clientId: shop.clientId,
    });
    return {
      shopId: shop.id,
      clientId: shop.clientId,
      url: `${baseUrl}${PUSH_PATH_PREFIX}${token}`,
      mode: shop.ozonPushBindingMode || 'desktop',
      status: shop.ozonPushStatus || 'generated',
      createdAt: shop.ozonPushCreatedAt || null,
      rotatedAt: shop.ozonPushRotatedAt || null,
      lastReceivedAt: shop.ozonPushLastReceivedAt || null,
    };
  }

  async function resolvePublicProvider(publicPath) {
    const configuredBaseUrl = normalizeBaseUrl(env.WANGZAI_OZON_PUSH_PUBLIC_BASE_URL || '');
    if (configuredBaseUrl) return { mode: 'server', baseUrl: configuredBaseUrl };
    let status;
    try {
      status = await execFilePromise(execFileImpl, tailscaleExecutable, ['status', '--json']);
    } catch (error) {
      throw tailscaleCommandError(error, 'OZON_PUSH_TAILSCALE_NOT_RUNNING');
    }
    let parsed;
    try {
      parsed = JSON.parse(status.stdout || '{}');
    } catch (error) {
      throw stageError('OZON_PUSH_TAILSCALE_STATUS_INVALID', error);
    }
    if (normalizeText(parsed?.BackendState) === 'NeedsLogin') throw stageError('OZON_PUSH_TAILSCALE_NOT_LOGGED_IN');
    const dnsName = normalizeText(parsed?.Self?.DNSName).replace(/\.$/u, '');
    if (!dnsName) throw stageError('OZON_PUSH_TAILSCALE_NOT_CONNECTED');
    try {
      await execFilePromise(execFileImpl, tailscaleExecutable, [
        'funnel', '--bg', '--yes', `--https=${funnelPort}`, `--set-path=${publicPath}`,
        `http://127.0.0.1:${gatewayPort}${publicPath}`,
      ]);
    } catch (error) {
      throw tailscaleCommandError(error, 'OZON_PUSH_TAILSCALE_FUNNEL_FAILED');
    }
    return { mode: 'desktop', baseUrl: `https://${dnsName}:${funnelPort}` };
  }

  async function handleGatewayRequest(request, response) {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    if (!requestUrl.pathname.startsWith(PUSH_PATH_PREFIX)) {
      sendJson(response, 404, { detail: 'Not Found' });
      return;
    }
    const token = decodeURIComponent(requestUrl.pathname.slice(PUSH_PATH_PREFIX.length));
    const bindingId = token.split('.', 1)[0];
    const shop = (await listShops()).find((candidate) => (
      normalizeText(candidate?.ozonPushBindingId) === bindingId
      && candidate?.status === 'active'
    ));
    if (!shop || !verifyOzonPushBindingToken(signingSecret, token, shop)) {
      sendJson(response, 404, { detail: 'Not Found' });
      return;
    }
    if (request.method === 'GET') {
      sendJson(response, 200, {
        ok: true,
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        status: shop.ozonPushStatus || 'generated',
        last_received_at: shop.ozonPushLastReceivedAt || null,
      });
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, publicError('ERROR_UNKNOWN', 'Method not allowed', 405).body);
      return;
    }
    const contentType = normalizeText(request.headers['content-type']).split(';', 1)[0].toLowerCase();
    if (contentType !== 'application/json') {
      sendJson(response, 415, publicError('ERROR_UNKNOWN', 'Content-Type must be application/json', 415).body);
      return;
    }
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      const tooLarge = error?.statusCode === 413;
      sendJson(response, tooLarge ? 413 : 400, publicError(
        'ERROR_UNKNOWN',
        tooLarge ? 'Notification body is too large' : 'Request body must be valid JSON',
        tooLarge ? 413 : 400,
      ).body);
      return;
    }
    const messageType = normalizeText(payload?.message_type);
    if (!messageType) {
      sendJson(response, 400, publicError('ERROR_PARAMETER_VALUE_MISSED', 'message_type is required').body);
      return;
    }
    const receivedAt = now().toISOString();
    if (messageType === 'TYPE_PING') {
      scheduleReceiptWrite(shop, receivedAt);
      sendJson(response, 200, { version: SERVICE_VERSION, name: SERVICE_NAME, time: receivedAt });
      return;
    }
    let envelope;
    try {
      envelope = toInternalOzonPushEnvelope(payload, shop, receivedAt);
    } catch (error) {
      const scopeMismatch = error?.message === 'OZON_PUSH_SELLER_SCOPE_MISMATCH';
      sendJson(response, scopeMismatch ? 403 : 400, publicError(
        scopeMismatch ? 'ERROR_ACCESS_DENIED' : 'ERROR_PARAMETER_VALUE_MISSED',
        scopeMismatch ? 'seller_id does not match this callback' : 'Notification payload is incomplete',
        scopeMismatch ? 403 : 400,
      ).body);
      return;
    }
    const sinkResponse = await fetchImpl(`${localApiBaseUrl}${INTERNAL_PUSH_PATH}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        [INTERNAL_SIGNATURE_HEADER]: createInternalOzonPushSignature(signingSecret, envelope),
      },
      body: JSON.stringify(envelope),
    });
    const sinkResult = await sinkResponse.json().catch(() => ({}));
    if (!sinkResponse.ok || sinkResult?.ok !== true) {
      logger(`[ozon-push] sink rejected status=${sinkResponse.status}`);
      sendJson(response, 503, publicError('ERROR_UNKNOWN', 'Notification receiver is temporarily unavailable', 503).body);
      return;
    }
    scheduleReceiptWrite(shop, receivedAt);
    sendJson(response, 200, { result: true });
  }

  function start() {
    if (serverReady) return serverReady;
    server = createServerImpl((request, response) => {
      Promise.resolve(handleGatewayRequest(request, response)).catch((error) => {
        logger(`[ozon-push] gateway error=${normalizeText(error?.message || error)}`);
        if (!response.headersSent) sendJson(response, 500, publicError('ERROR_UNKNOWN', 'Notification receiver failed', 500).body);
        else response.end();
      });
    });
    const pendingServer = server;
    serverReady = new Promise((resolve, reject) => {
      pendingServer.once('error', reject);
      pendingServer.listen(gatewayPort, '127.0.0.1', () => {
        pendingServer.unref?.();
        resolve({ ok: true, port: pendingServer.address()?.port || gatewayPort });
      });
    }).catch((error) => {
      // A failed listen must not stay cached, otherwise every later click fails until restart.
      if (server === pendingServer) {
        server = null;
        serverReady = null;
      }
      pendingServer.close?.(() => undefined);
      throw stageError(error?.code === 'EADDRINUSE' ? 'OZON_PUSH_GATEWAY_PORT_IN_USE' : 'OZON_PUSH_GATEWAY_START_FAILED', error);
    });
    return serverReady;
  }

  async function command(input = {}) {
    const action = normalizeText(input.command || 'read');
    const shopId = normalizeText(input.shopId);
    if (!shopId) return { ok: false, code: 'OZON_PUSH_SHOP_REQUIRED', error: '请先选择店铺。' };
    try {
      await start();
      let shop;
      try {
        shop = await getShop(shopId);
      } catch (error) {
        throw stageError('OZON_PUSH_LOCAL_API_UNAVAILABLE', error);
      }
      // `read` reports whether the shop is durably saved so the panel can gate generation
      // instead of letting an unsaved draft fail with "shop not found".
      if (action === 'read') {
        return {
          ok: true,
          shopSaved: Boolean(shop),
          savedClientId: normalizeText(shop?.clientId),
          binding: shop && normalizeText(shop.clientId) ? bindingView(shop) : null,
        };
      }
      if (!shop) {
        return { ok: false, code: 'OZON_PUSH_SHOP_NOT_SAVED', error: '当前店铺还没有保存成功，请先点击「保存」或「测试连接」，保存成功后再生成通知地址。' };
      }
      if (!normalizeText(shop.clientId)) {
        return { ok: false, code: 'OZON_PUSH_CLIENT_ID_REQUIRED', error: '请先保存当前店铺的 Client ID。' };
      }
      if (!['ensure', 'rotate'].includes(action)) {
        return { ok: false, code: 'OZON_PUSH_COMMAND_INVALID', error: '不支持的店铺通知操作。' };
      }
      if (action === 'ensure') {
        const existing = bindingView(shop);
        if (existing) return { ok: true, binding: existing, reused: true };
      }
      const bindingId = randomBytes(18).toString('base64url');
      const token = createOzonPushBindingToken(signingSecret, {
        bindingId,
        shopId: shop.id,
        clientId: shop.clientId,
      });
      const publicPath = `${PUSH_PATH_PREFIX}${token}`;
      const provider = await resolvePublicProvider(publicPath);
      const timestamp = now().toISOString();
      let saved;
      try {
        saved = await saveShop(shop, {
          ozonPushBindingId: bindingId,
          ozonPushBindingMode: provider.mode,
          ozonPushPublicBaseUrl: provider.baseUrl,
          ozonPushStatus: 'generated',
          ozonPushCreatedAt: shop.ozonPushCreatedAt || timestamp,
          ozonPushRotatedAt: action === 'rotate' ? timestamp : shop.ozonPushRotatedAt || null,
          ozonPushLastReceivedAt: action === 'rotate' ? null : shop.ozonPushLastReceivedAt || null,
        });
      } catch (error) {
        throw stageError('OZON_PUSH_BINDING_SAVE_FAILED', error);
      }
      const binding = bindingView(saved);
      if (!binding || normalizeText(saved?.ozonPushBindingId) !== bindingId) {
        throw stageError('OZON_PUSH_BINDING_SAVE_FAILED');
      }
      return { ok: true, binding, reused: false };
    } catch (error) {
      const code = normalizeText(error?.code || error?.message || 'OZON_PUSH_ENDPOINT_FAILED');
      const cause = normalizeText(error?.cause?.code || error?.cause?.message);
      logger(`[ozon-push] command=${action} failed code=${code}${cause ? ` cause=${cause}` : ''}`);
      const message = COMMAND_ERROR_MESSAGES[code] || '店铺通知地址生成失败，请稍后重试。';
      return { ok: false, code, error: `${message}（错误代码：${code}）` };
    }
  }

  async function stop() {
    const pending = [...pendingReceiptWrites.values()];
    pendingReceiptWrites.clear();
    await Promise.all(pending.map(async (entry) => {
      clearTimeout(entry.timer);
      try {
        await saveShop(entry.shop, {
          ozonPushStatus: 'receiving',
          ozonPushLastReceivedAt: entry.receivedAt,
        });
      } catch {
        // Runtime shutdown still closes the listener even when status persistence fails.
      }
    }));
    if (!server) return { ok: true, stopped: false };
    await new Promise((resolve) => server.close(resolve));
    server = null;
    serverReady = null;
    return { ok: true, stopped: true };
  }

  return Object.freeze({ start, stop, command });
}

