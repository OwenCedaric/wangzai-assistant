import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(desktopRoot, '..');
const appDataRoot = path.resolve(
  process.env.WANGZAI_DESKTOP_DATA_DIR
    || path.join(process.env.APPDATA || '', 'wangzai-desktop'),
);
const storageRef = readArgument('storage-ref');
const confirm = process.argv.includes('--confirm');
const pageUrl = 'https://www.kuajing84.com/index/finance/record_consume.html';

if (!/^[0-9a-f]{40}$/u.test(storageRef)) {
  throw new Error('CROSS_BORDER_LIVE_STORAGE_REF_REQUIRED');
}

const executable = path.join(
  desktopRoot,
  'native',
  'Wangzai.CefBrowserHost',
  'publish',
  'Wangzai.CefBrowserHost.exe',
);
const browserRoot = path.join(appDataRoot, 'purchase-browser');
const rootCachePath = path.join(browserRoot, 'cef-cache-root');
const profileDirectory = path.join(rootCachePath, storageRef);
const downloadsDirectory = path.join(browserRoot, 'downloads');
const extensionsRoot = path.join(browserRoot, 'extensions');
const observerExtension = path.join(
  desktopRoot,
  'resources',
  'browser-extensions',
  'ozon-analytics-observer',
);

for (const requiredPath of [executable, profileDirectory]) {
  if (!fs.existsSync(requiredPath)) throw new Error(`CROSS_BORDER_LIVE_PATH_MISSING:${requiredPath}`);
}

const pipeName = `wangzai-cross-border-live-${randomUUID()}`;
const pipePath = `\\\\.\\pipe\\${pipeName}`;
const pending = new Map();
let socket;
let child;
let inputBuffer = '';
let readyResolve;
let readyReject;
const ready = new Promise((resolve, reject) => {
  readyResolve = resolve;
  readyReject = reject;
});

const server = net.createServer((connection) => {
  socket = connection;
  socket.setEncoding('utf8');
  socket.on('data', consume);
  socket.on('error', (error) => readyReject(error));
});

try {
  await listen(server, pipePath);
  child = spawn(executable, [
    `--wangzai-ipc-pipe=${pipeName}`,
    `--wangzai-root-cache=${rootCachePath}`,
    `--wangzai-extensions-root=${extensionsRoot}`,
    `--wangzai-built-in-extension=${observerExtension}`,
  ], {
    cwd: path.dirname(executable),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.once('error', (error) => readyReject(error));
  child.once('exit', (code) => {
    if (code !== 0) readyReject(new Error(`PURCHASE_BROWSER_CEF_LIVE_EXIT_${code}`));
  });
  await withTimeout(ready, 30_000, 'PURCHASE_BROWSER_CEF_LIVE_READY_TIMEOUT');
  await request('launch', {
    profile: {
      ownerRef: storageRef,
      storageRef,
      browserRole: 'interactive',
      background: false,
      platformKey: '1688',
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.6',
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      fingerprint: { seed: storageRef },
      proxy: { mode: 'direct' },
    },
    profileDirectory,
    downloadsDirectory,
    url: pageUrl,
    parentHwnd: '0',
    initialBounds: { x: 0, y: 0, width: 1280, height: 800, visible: false },
  }, 60_000);
  await waitForPageReady();
  const capture = await request('cross-border-charges', {
    ownerRef: storageRef,
    pageUrl,
    includeDetails: false,
  }, 10 * 60_000);
  const verification = confirm
    ? await confirmProductionReadback(capture)
    : await previewProductionMatch(capture);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: confirm ? 'confirmed' : 'preview',
    selectedPageUrl: capture.selectedPageUrl,
    pagination: capture.pagination,
    source: {
      chargeCount: Number(capture.chargeCount) || 0,
      orderCount: Number(capture.orderCount) || 0,
    },
    match: verification,
  }, null, 2)}\n`);
} finally {
  await shutdown();
}

function readArgument(name) {
  const prefix = `--${name}=`;
  return String(process.argv.find((value) => value.startsWith(prefix)) || '')
    .slice(prefix.length)
    .trim()
    .toLowerCase();
}

function listen(target, endpoint) {
  return new Promise((resolve, reject) => {
    target.once('error', reject);
    target.listen(endpoint, () => {
      target.off('error', reject);
      resolve();
    });
  });
}

function consume(chunk) {
  inputBuffer += chunk;
  while (true) {
    const newline = inputBuffer.indexOf('\n');
    if (newline < 0) break;
    const line = inputBuffer.slice(0, newline).trim();
    inputBuffer = inputBuffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === 'ready') {
      readyResolve(message);
      continue;
    }
    if (message.type !== 'response' || !message.id) continue;
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok === true) waiter.resolve(message.data);
    else waiter.reject(Object.assign(
      new Error(message.error?.code || 'PURCHASE_BROWSER_CEF_LIVE_COMMAND_FAILED'),
      { code: message.error?.code || 'PURCHASE_BROWSER_CEF_LIVE_COMMAND_FAILED' },
    ));
  }
}

function request(command, payload, timeoutMs) {
  const id = `cross_border_live_${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`PURCHASE_BROWSER_CEF_LIVE_TIMEOUT:${command}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.write(`${JSON.stringify({ id, command, payload })}\n`, 'utf8');
  });
}

async function waitForPageReady() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const state = await request('state', { ownerRef: storageRef }, 10_000);
    if (state.loading !== true && String(state.url || '').startsWith(pageUrl)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('CROSS_BORDER_LIVE_PAGE_READY_TIMEOUT');
}

async function createProductionServices() {
  const [{ openDatabase }, { createShopRepository }, { createCrossBorderAccountService }, { createCrossBorderChargeService }] = await Promise.all([
    import('../../local-api/src/db/database.js'),
    import('../../local-api/src/db/repositories/shopRepository.js'),
    import('../../local-api/src/domain/logistics/crossBorderAccountService.js'),
    import('../../local-api/src/domain/logistics/crossBorderChargeService.js'),
  ]);
  const profile = JSON.parse(fs.readFileSync(path.join(appDataRoot, 'profile.json'), 'utf8'));
  const profileId = String(profile.profileId || '').trim();
  const tenantId = 'com.wangzai.assistant.desktop';
  const userId = profileId;
  const databasePath = path.join(appDataRoot, 'local-api-data', 'wangzai-local-api.sqlite');
  const db = openDatabase({ database: { path: databasePath, enableWal: true, busyTimeoutMs: 15_000 } });
  const shopRepository = createShopRepository(db, { profileId, tenantId, userId });
  const crossBorderAccountService = createCrossBorderAccountService({
    db,
    profileId,
    tenantId,
    userId,
  });
  const chargeService = createCrossBorderChargeService({
    db,
    profileId,
    shopRepository,
    crossBorderAccountService,
  });
  return { db, chargeService, scope: { tenantId, userId } };
}

function previewInput(capture) {
  return {
    browserAccountRef: String(capture.browserAccountRef || storageRef),
    externalAccountRef: String(capture.userCode || ''),
    charges: Array.isArray(capture.charges) ? capture.charges : [],
    orders: Array.isArray(capture.orders) ? capture.orders : [],
  };
}

async function previewProductionMatch(capture) {
  const { db, chargeService, scope } = await createProductionServices();
  try {
    const preview = chargeService.buildPreview(previewInput(capture), scope);
    return { ...preview.summary, readbackVerified: false };
  } finally {
    db.close();
  }
}

async function confirmProductionReadback(capture) {
  const { db, chargeService, scope } = await createProductionServices();
  try {
    const preview = chargeService.buildPreview(previewInput(capture), scope);
    const confirmed = chargeService.confirmImport({
      previewId: preview.previewId,
      confirmationToken: preview.confirmationToken,
    }, scope);
    if (confirmed.ok !== true || confirmed.readbackVerified !== true) {
      throw new Error('CROSS_BORDER_CHARGE_READBACK_FAILED');
    }
    return {
      ...preview.summary,
      savedRecordCount: confirmed.savedRecordCount,
      savedOrderCount: confirmed.savedOrderCount,
      readbackVerified: true,
    };
  } finally {
    db.close();
  }
}

function withTimeout(promise, timeoutMs, code) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(code)), timeoutMs)),
  ]);
}

async function shutdown() {
  try {
    if (socket && !socket.destroyed) {
      await request('shutdown', {}, 5000).catch(() => undefined);
    }
  } finally {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('PURCHASE_BROWSER_CEF_LIVE_CLOSED'));
    }
    pending.clear();
    socket?.destroy();
    await new Promise((resolve) => server.close(resolve));
    if (child?.exitCode === null) child.kill();
  }
}
