import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(
  process.env.WANGZAI_TEST_CORE_CONFIG || path.join(__dirname, 'test-core.config.json'),
);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/u, ''));
const gatewayHost = String(config.host || '127.0.0.1');
const gatewayPort = Number(config.port || 18100);
const managementBaseUrl = String(config.managementBaseUrl || 'http://127.0.0.1:18000').replace(/\/$/u, '');
const clientId = String(config.clientId || '').trim();
const localApiRoot = path.resolve(config.localApiRoot || path.join(__dirname, '..', '..', 'local-api'));
const runtimeRoot = path.resolve(config.runtimeRoot || path.join(__dirname, '..', '..', 'artifacts', 'test-core-runtime'));
const workerPortStart = Number(config.workerPortStart || 18120);
const workerPortEnd = Number(config.workerPortEnd || 18219);
const workerIdleMs = Math.max(5 * 60_000, Number(config.workerIdleMinutes || 60) * 60_000);
const maxRequestBytes = Math.max(2 * 1024 * 1024, Number(config.maxRequestBytes || 40 * 1024 * 1024));

if (!/^[A-Za-z0-9._:-]{16,160}$/u.test(clientId)) throw new Error('TEST_CORE_CLIENT_ID_INVALID');
if (!fs.existsSync(path.join(localApiRoot, 'src', 'server.js'))) throw new Error('TEST_CORE_LOCAL_API_SOURCE_MISSING');
fs.mkdirSync(runtimeRoot, { recursive: true });
fs.mkdirSync(path.join(runtimeRoot, 'logs'), { recursive: true });

const workers = new Map();
const profileBindings = new Map();
const authCache = new Map();
let shuttingDown = false;

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function constantTimeEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left || '')).digest();
  const b = crypto.createHash('sha256').update(String(right || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseProfileIdentity(req) {
  const raw = String(req.headers['x-wangzai-local-api-token'] || '');
  const separator = raw.indexOf(':');
  if (separator < 1) return null;
  const claimedClient = raw.slice(0, separator);
  const profileId = raw.slice(separator + 1);
  if (!constantTimeEqual(claimedClient, clientId)) return null;
  if (!/^[A-Za-z0-9._:-]{8,160}$/u.test(profileId)) return null;
  const explicitProfile = String(req.headers['x-wangzai-thin-profile-id'] || '').trim();
  if (explicitProfile && explicitProfile !== profileId) return null;
  return profileId;
}

async function authenticateBearer(req) {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/iu);
  if (!match) return null;
  const token = match[1].trim();
  const tokenKey = crypto.createHash('sha256').update(token).digest('hex');
  const cached = authCache.get(tokenKey);
  if (cached?.expiresAt > Date.now()) return cached.principal;
  const response = await fetch(`${managementBaseUrl}/api/auth/me`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const userId = String(payload?.user?.id || '').trim();
  if (!userId || payload?.user?.status !== 'active') return null;
  const principal = Object.freeze({ userId, accessToken: token });
  authCache.set(tokenKey, { principal, expiresAt: Date.now() + 30_000 });
  return principal;
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

async function allocatePort() {
  const used = new Set([...workers.values()].map((worker) => worker.port));
  for (let port = workerPortStart; port <= workerPortEnd; port += 1) {
    if (!used.has(port) && await portAvailable(port)) return port;
  }
  throw new Error('TEST_CORE_WORKER_PORT_EXHAUSTED');
}

function workerKey(userId) {
  return crypto.createHash('sha256').update(`wangzai-test-core\0${userId}`).digest('hex').slice(0, 32);
}

async function waitForWorker(worker) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (worker.child.exitCode !== null) throw new Error(`TEST_CORE_WORKER_EXITED:${worker.child.exitCode}`);
    try {
      const response = await fetch(`${worker.baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      const payload = await response.json();
      if (response.ok && payload?.service === 'wangzai-local-api') return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('TEST_CORE_WORKER_START_TIMEOUT');
}

async function startWorker(userId) {
  const key = workerKey(userId);
  const userRoot = path.join(runtimeRoot, 'users', key);
  const logRoot = path.join(userRoot, 'logs');
  fs.mkdirSync(logRoot, { recursive: true });
  const port = await allocatePort();
  const authToken = crypto.randomBytes(32).toString('base64url');
  const purchaseBrowserToken = crypto.randomBytes(32).toString('base64url');
  const child = spawn(process.execPath, [path.join(localApiRoot, 'src', 'server.js')], {
    cwd: localApiRoot,
    windowsHide: true,
    stdio: [
      'ignore',
      fs.openSync(path.join(logRoot, 'stdout.log'), 'a'),
      fs.openSync(path.join(logRoot, 'stderr.log'), 'a'),
    ],
    env: {
      ...process.env,
      LOCAL_API_HOST: '127.0.0.1',
      LOCAL_API_PORT: String(port),
      LOCAL_API_CONFIG_PATH: path.join(localApiRoot, 'config', 'local-api.config.json'),
      LOCAL_API_DB_PATH: path.join(userRoot, 'server-execution.sqlite'),
      LOCAL_API_SECRET: '',
      LOCAL_API_SECRET_FILE: path.join(userRoot, 'server-secret.key'),
      LOCAL_API_LOG_DIRECTORY: logRoot,
      LOCAL_API_APP_ID: 'com.wangzai.assistant.desktop.test',
      LOCAL_API_PROFILE_ID: `server-${key}`,
      LOCAL_API_DATA_ROOT_FINGERPRINT: key,
      LOCAL_API_PROTOCOL_VERSION: '1',
      LOCAL_API_CONTINUOUS_SYNC: '0',
      LOCAL_API_DEFER_CONTINUOUS_SYNC: '0',
      LOCAL_API_AUTO_MAINTENANCE: '0',
      LOCAL_API_AUTH_TOKEN: authToken,
      LOCAL_API_PURCHASE_BROWSER_TOKEN: purchaseBrowserToken,
      LOCAL_API_SHOP_LICENSE_ENFORCE: '0',
      LOCAL_API_ALLOWED_ORIGINS: 'app://wangzai,null',
    },
  });
  const worker = {
    userId,
    key,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    authToken,
    purchaseBrowserToken,
    child,
    lastUsedAt: Date.now(),
  };
  workers.set(userId, worker);
  child.once('exit', () => {
    if (workers.get(userId) === worker) workers.delete(userId);
  });
  try {
    await waitForWorker(worker);
    return worker;
  } catch (error) {
    workers.delete(userId);
    child.kill();
    throw error;
  }
}

async function getWorker(userId) {
  const existing = workers.get(userId);
  if (existing && existing.child.exitCode === null) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  return startWorker(userId);
}

async function readRequestBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxRequestBytes) throw Object.assign(new Error('REQUEST_TOO_LARGE'), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : null;
}

function forwardedHeaders(req, worker, principal) {
  const headers = {
    accept: String(req.headers.accept || 'application/json'),
    'x-wangzai-local-api-token': worker.authToken,
    'x-wangzai-tenant-id': `license-user-${principal.userId}`,
    'x-wangzai-user-id': `license-user-${principal.userId}`,
  };
  for (const name of ['content-type', 'if-match', 'x-idempotency-key', 'x-request-id', 'x-wangzai-shop-id']) {
    if (req.headers[name]) headers[name] = String(req.headers[name]);
  }
  if (req.headers['x-wangzai-purchase-browser-token']) {
    headers['x-wangzai-purchase-browser-token'] = worker.purchaseBrowserToken;
  }
  if (req.headers['x-wangzai-protected-compute-access-token']) {
    headers['x-wangzai-protected-compute-access-token'] = String(req.headers['x-wangzai-protected-compute-access-token']);
  }
  if (req.headers['x-wangzai-paid-capability-access-token']) {
    headers['x-wangzai-paid-capability-access-token'] = String(req.headers['x-wangzai-paid-capability-access-token']);
  }
  return headers;
}

async function resolvePrincipal(req, profileId) {
  const authenticated = await authenticateBearer(req);
  if (authenticated) {
    profileBindings.set(profileId, { userId: authenticated.userId, boundAt: Date.now() });
    return authenticated;
  }
  const binding = profileBindings.get(profileId);
  if (!binding) return null;
  return { userId: binding.userId, accessToken: '' };
}

async function handle(req, res) {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      service: 'wangzai-test-core-gateway',
      version: 1,
      workers: workers.size,
      serverTime: new Date().toISOString(),
    });
  }
  if (!requestUrl.pathname.startsWith('/api/') || requestUrl.pathname === '/api/internal/shutdown') {
    return json(res, 404, { ok: false, error: { code: 'CORE_ROUTE_NOT_FOUND', message: '核心服务接口不存在。' } });
  }
  const profileId = parseProfileIdentity(req);
  if (!profileId) return json(res, 401, { ok: false, error: { code: 'CORE_CLIENT_INVALID', message: '测试客户端身份无效。' } });
  const principal = await resolvePrincipal(req, profileId);
  if (!principal) return json(res, 401, { ok: false, error: { code: 'CORE_LOGIN_REQUIRED', message: '请先登录测试账号。' } });
  const worker = await getWorker(principal.userId);
  worker.lastUsedAt = Date.now();
  const body = await readRequestBody(req);
  const response = await fetch(`${worker.baseUrl}${requestUrl.pathname}${requestUrl.search}`, {
    method: req.method,
    headers: forwardedHeaders(req, worker, principal),
    body: ['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : body,
    signal: AbortSignal.timeout(300_000),
  });
  const responseBody = Buffer.from(await response.arrayBuffer());
  const responseHeaders = {
    'content-type': response.headers.get('content-type') || 'application/octet-stream',
    'content-length': responseBody.length,
    'cache-control': 'no-store',
  };
  for (const name of ['etag', 'last-modified', 'content-disposition']) {
    const value = response.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  res.writeHead(response.status, responseHeaders);
  res.end(responseBody);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = Number(error?.status) || 502;
    json(res, status, {
      ok: false,
      error: {
        code: error?.message === 'REQUEST_TOO_LARGE' ? 'CORE_REQUEST_TOO_LARGE' : 'CORE_GATEWAY_FAILED',
        message: error?.message || '核心服务器请求失败。',
      },
    });
  });
});

const idleSweep = setInterval(() => {
  const threshold = Date.now() - workerIdleMs;
  for (const [userId, worker] of workers) {
    if (worker.lastUsedAt >= threshold) continue;
    workers.delete(userId);
    worker.child.kill();
  }
}, 60_000);
idleSweep.unref();

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(idleSweep);
  server.close();
  for (const worker of workers.values()) worker.child.kill();
  workers.clear();
  process.stdout.write(`${signal}: test core gateway stopped\n`);
  setTimeout(() => process.exit(0), 100).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
server.listen(gatewayPort, gatewayHost, () => {
  process.stdout.write(JSON.stringify({
    ok: true,
    service: 'wangzai-test-core-gateway',
    url: `http://${gatewayHost}:${gatewayPort}`,
    managementBaseUrl,
    runtimeRoot,
  }) + '\n');
});
