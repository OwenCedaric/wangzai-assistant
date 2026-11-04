import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { createLocalCacheStore } from './store.js';
import { createCompatibilityRoutes } from './compatRoutes.js';
import { createLocalSmartReplyService } from './smartReply/localService.js';

const host = '127.0.0.1';
const port = Math.max(1, Math.min(65535, Number(process.env.WANGZAI_CACHE_AGENT_PORT || 3792)));
const token = String(process.env.WANGZAI_CACHE_AGENT_TOKEN || '').trim();
const encryptionKey = String(process.env.WANGZAI_CACHE_AGENT_ENCRYPTION_KEY || '').trim();
const dataRoot = path.resolve(process.env.WANGZAI_CACHE_AGENT_DATA_ROOT || path.join(process.cwd(), 'data'));
if (token.length < 32) throw new Error('CACHE_AGENT_TOKEN_REQUIRED');

const store = createLocalCacheStore({
  databasePath: path.join(dataRoot, 'wangzai-user-cache.sqlite'),
  assetRoot: path.join(dataRoot, 'assets'),
  encryptionKey,
});
const compatibilityRoutes = createCompatibilityRoutes({ store });
const localSmartReply = createLocalSmartReplyService({ store });

function tokenMatches(value) {
  const expected = crypto.createHash('sha256').update(token).digest();
  const actual = crypto.createHash('sha256').update(String(value || '')).digest();
  return crypto.timingSafeEqual(expected, actual);
}

function respond(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function body(req, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('CACHE_REQUEST_TOO_LARGE'), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${host}:${port}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    return respond(res, 200, { ok: true, service: 'wangzai-local-cache-agent' });
  }
  if (!tokenMatches(req.headers['x-wangzai-cache-agent-token'])) {
    return respond(res, 401, { ok: false, error: { code: 'CACHE_AGENT_UNAUTHORIZED', message: '本地缓存代理身份无效。' } });
  }
  const scopeId = String(req.headers['x-wangzai-cache-scope'] || '').trim();
  if (
    (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/internal/'))
    && !/^[A-Za-z0-9._:-]{1,200}$/u.test(scopeId)
  ) {
    return respond(res, 401, { ok: false, error: { code: 'CACHE_SCOPE_REQUIRED', message: '本地数据用户范围无效。' } });
  }
  if (req.method === 'GET' && url.pathname === '/v1/status') {
    return respond(res, 200, { ok: true, service: 'wangzai-local-cache-agent', storage: store.status() });
  }
  if (req.method === 'GET' && url.pathname === '/v1/assets/content') {
    const asset = store.readAsset({
      scopeId: url.searchParams.get('scopeId'),
      assetId: url.searchParams.get('assetId'),
    });
    if (!asset) return respond(res, 404, { ok: false, error: { code: 'ASSET_NOT_FOUND', message: '本地文件不存在。' } });
    res.writeHead(200, {
      'content-type': asset.mediaType,
      'content-length': asset.sizeBytes,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      etag: `"sha256-${asset.sha256}"`,
    });
    res.end(asset.content);
    return;
  }
  const payload = await body(req, {
    maxBytes: req.method === 'PUT' && url.pathname === '/v1/assets'
      ? 48 * 1024 * 1024
      : 8 * 1024 * 1024,
  });
  if (localSmartReply.supports(req.method, url.pathname)) {
    const result = await localSmartReply.handle({
      method: req.method,
      pathname: url.pathname,
      searchParams: url.searchParams,
      payload,
      scopeId,
    });
    if (result.handled) return respond(res, result.status, result.payload);
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/internal/')) {
    const result = await compatibilityRoutes.handle({
      method: req.method,
      pathname: url.pathname,
      searchParams: url.searchParams,
      payload,
      scopeId,
    });
    if (result.handled) return respond(res, result.status, result.payload);
  }
  if (req.method === 'POST' && url.pathname === '/v1/records/get') return respond(res, 200, { ok: true, record: store.getRecord(payload) });
  if (req.method === 'POST' && url.pathname === '/v1/records/list') return respond(res, 200, { ok: true, records: store.listRecords(payload) });
  if (req.method === 'PUT' && url.pathname === '/v1/records') return respond(res, 200, { ok: true, record: store.putRecord(payload) });
  if (req.method === 'DELETE' && url.pathname === '/v1/records') return respond(res, 200, { ok: true, ...store.deleteRecord(payload) });
  if (req.method === 'POST' && url.pathname === '/v1/outbox') return respond(res, 201, { ok: true, task: store.enqueueTask(payload) });
  if (req.method === 'POST' && url.pathname === '/v1/outbox/list') return respond(res, 200, { ok: true, tasks: store.listTasks(payload) });
  if (req.method === 'POST' && url.pathname === '/v1/outbox/complete') return respond(res, 200, { ok: true, ...store.completeTask(payload) });
  if (req.method === 'PUT' && url.pathname === '/v1/assets') return respond(res, 200, { ok: true, asset: store.putAsset(payload) });
  if (req.method === 'POST' && url.pathname === '/v1/assets/get') return respond(res, 200, { ok: true, asset: store.getAsset(payload) });
  if (req.method === 'POST' && url.pathname === '/v1/assets/list') return respond(res, 200, { ok: true, assets: store.listAssets(payload) });
  if (req.method === 'DELETE' && url.pathname === '/v1/assets') return respond(res, 200, { ok: true, ...store.deleteAsset(payload) });
  return respond(res, 404, { ok: false, error: { code: 'CACHE_AGENT_ROUTE_NOT_FOUND', message: '本地缓存接口不存在。' } });
}

const server = http.createServer((req, res) => handle(req, res).catch((error) => {
  respond(res, Number(error?.status) || 400, { ok: false, error: { code: error?.code || 'CACHE_AGENT_REQUEST_FAILED', message: error?.message || '本地缓存请求失败。' } });
}));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await localSmartReply.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
server.listen(port, host, () => {
  localSmartReply.start();
  process.stdout.write(JSON.stringify({ ok: true, service: 'wangzai-local-cache-agent', url: `http://${host}:${port}` }) + '\n');
});
