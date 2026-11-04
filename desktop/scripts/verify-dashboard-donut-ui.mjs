import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeDatabase } from '../../local-api/src/db/database.js';
import { createDashboardOverviewReadModel } from '../../local-api/src/domain/dashboard/dashboardOverviewReadModel.js';
import { seedRendererPerformanceFixture } from './performanceFixture.mjs';

const __filename = fileURLToPath(import.meta.url);
const desktopRoot = path.resolve(path.dirname(__filename), '..');
const workspaceRoot = path.resolve(desktopRoot, '..');
const resultRoot = path.join(desktopRoot, 'test-results');
const electronExecutable = path.join(
  desktopRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);
const FIXTURE_SHOP_ID = 'ozon-shop-1';
const VIEWPORT = Object.freeze({ width: 1600, height: 930, deviceScaleFactor: 1 });
const OUTPUTS = Object.freeze({
  zero: path.join(resultRoot, 'visual-dashboard-donut-zero-20260714.png'),
  data: path.join(resultRoot, 'visual-dashboard-donut-data-20260714.png'),
  closeup: path.join(resultRoot, 'visual-dashboard-donut-closeup-20260714.png'),
  evidence: path.join(resultRoot, 'visual-dashboard-donut-evidence-20260714.json'),
});
const EXPECTED = Object.freeze({
  zero: Object.freeze({
    pendingPurchaseCount: 0,
    waitingDeliveryCount: 0,
    afterSalesTodoCount: 0,
    stockWarningCount: 0,
  }),
  data: Object.freeze({
    pendingPurchaseCount: 2,
    waitingDeliveryCount: 5,
    afterSalesTodoCount: 1,
    stockWarningCount: 6,
  }),
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message, context = null) {
  if (condition) return;
  const suffix = context === null ? '' : `\n${JSON.stringify(context, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

function sameCounts(actual = {}, expected = {}) {
  return Object.keys(expected).every((key) => Number(actual?.[key]) === Number(expected[key]));
}

function shanghaiDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function allocatePorts() {
  const ports = new Set();
  while (ports.size < 3) ports.add(await findFreePort());
  const [cdp, localApi, bridge] = [...ports];
  return { cdp, localApi, bridge };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPortReachable(port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function waitForPortsClosed(ports, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let rows = [];
  while (Date.now() - startedAt < timeoutMs) {
    rows = await Promise.all(
      ports.map(async (port) => ({ port, reachable: await isPortReachable(port) })),
    );
    if (rows.every((row) => !row.reachable)) return rows;
    await delay(250);
  }
  return rows;
}

async function seedScenario(dataRoot, scenario) {
  await seedRendererPerformanceFixture({
    dataRoot,
    products: scenario === 'data' ? 20 : 1,
    orders: scenario === 'data' ? 5 : 0,
  });
  const databasePath = path.join(dataRoot, 'local-api-data', 'wangzai-local-api.sqlite');
  const { db } = initializeDatabase({
    database: { path: databasePath, enableWal: true, busyTimeoutMs: 5000 },
  });
  const timestamp = new Date().toISOString();
  try {
    if (scenario === 'zero') {
      db.prepare('DELETE FROM ozon_products WHERE shop_id = ?').run(FIXTURE_SHOP_ID);
    } else {
      const insertOverride = db.prepare(`
        INSERT INTO purchase_order_overrides (
          id, shop_id, order_key, posting_number, ozon_order_id,
          purchase_platform, purchase_order_number, source_cost_cny,
          manual_status, raw_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let index = 1; index <= 3; index += 1) {
        const identity = String(index).padStart(7, '0');
        insertOverride.run(
          `dashboard-visual-override-${identity}`,
          FIXTURE_SHOP_ID,
          `renderer-order-${identity}`,
          `renderer-posting-${identity}`,
          `renderer-order-id-${identity}`,
          '1688',
          `DASHBOARD-PURCHASE-${identity}`,
          20 + index,
          '已付款',
          JSON.stringify({ fixture: 'dashboard-donut', confirmed: true }),
          timestamp,
          timestamp,
        );
      }
      db.prepare(`
        INSERT INTO ozon_returns (
          id, shop_id, return_key, return_id, status, created_at_remote,
          raw_json, remote_hash, is_stale, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        'dashboard-visual-return-1',
        FIXTURE_SHOP_ID,
        'dashboard-visual-return-1',
        'DASHBOARD-RETURN-1',
        'Utilizing',
        timestamp,
        JSON.stringify({ fixture: 'dashboard-donut' }),
        'dashboard-visual-return-hash-1',
        timestamp,
        timestamp,
        timestamp,
      );
    }

    const dateKey = shanghaiDateKey();
    const preflight = createDashboardOverviewReadModel({ db }).read({
      shopIds: FIXTURE_SHOP_ID,
      startDate: dateKey,
      endDate: dateKey,
    });
    assert(preflight?.ok === true, `${scenario} fixture SQLite 聚合预检失败`, preflight);
    assert(
      sameCounts(preflight.currentTasks, EXPECTED[scenario]),
      `${scenario} fixture 计数不符合预期`,
      { expected: EXPECTED[scenario], actual: preflight.currentTasks },
    );
    return {
      databasePath,
      shopId: FIXTURE_SHOP_ID,
      sourceRows: scenario === 'data'
        ? { orders: 5, confirmedPurchaseOverrides: 3, returns: 1, products: 20, zeroStockProducts: 1 }
        : { orders: 0, confirmedPurchaseOverrides: 0, returns: 0, products: 0, zeroStockProducts: 0 },
      expectedCounts: EXPECTED[scenario],
      preflightPayload: preflight,
    };
  } finally {
    db.close();
  }
}

const LOOPBACK_GUARD_SOURCE = String.raw`
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

const logPath = process.env.WANGZAI_NETWORK_GUARD_LOG;
function write(row) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, JSON.stringify(Object.assign({
      at: new Date().toISOString(),
      pid: process.pid,
    }, row)) + '\n', 'utf8');
  } catch (_) {}
}
function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}
function isLoopback(host) {
  const value = normalizeHost(host);
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}
function block(kind, target, host) {
  const error = new Error('DASHBOARD_VISUAL_NON_LOOPBACK_BLOCKED: ' + String(target || host || 'unknown'));
  error.code = 'DASHBOARD_VISUAL_NON_LOOPBACK_BLOCKED';
  write({ event: 'blocked', kind, target: String(target || ''), host: normalizeHost(host) });
  throw error;
}
function parseHttpTarget(args, protocol) {
  const first = args[0];
  try {
    if (first instanceof URL) return { target: first.href, host: first.hostname };
    if (typeof first === 'string') {
      const parsed = new URL(first, protocol + '//localhost');
      return { target: parsed.href, host: parsed.hostname };
    }
  } catch (_) {}
  const options = first && typeof first === 'object' ? first : {};
  let host = options.hostname || options.host || 'localhost';
  if (typeof host === 'string' && host.includes(':') && !host.startsWith('[')) host = host.split(':')[0];
  return { target: protocol + '//' + String(host), host };
}
function patchHttp(module, protocol) {
  const originalRequest = module.request;
  module.request = function guardedRequest(...args) {
    const target = parseHttpTarget(args, protocol);
    if (!isLoopback(target.host)) return block(protocol.replace(':', ''), target.target, target.host);
    return originalRequest.apply(this, args);
  };
  module.get = function guardedGet(...args) {
    const request = module.request(...args);
    request.end();
    return request;
  };
}
function netTarget(args) {
  const first = args[0];
  if (first && typeof first === 'object') {
    if (first.path && !first.host && !first.hostname) return { localPipe: true };
    return { target: JSON.stringify({ host: first.host || first.hostname, port: first.port }), host: first.host || first.hostname || 'localhost' };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { localPipe: true };
  return { target: String(first || ''), host: typeof args[1] === 'string' ? args[1] : 'localhost' };
}
function patchNetFunction(module, name, kind) {
  const original = module[name];
  module[name] = function guardedConnect(...args) {
    const target = netTarget(args);
    if (!target.localPipe && !isLoopback(target.host)) return block(kind, target.target, target.host);
    return original.apply(this, args);
  };
}

patchHttp(http, 'http:');
patchHttp(https, 'https:');
patchNetFunction(net, 'connect', 'net');
patchNetFunction(net, 'createConnection', 'net');
patchNetFunction(tls, 'connect', 'tls');
if (typeof globalThis.fetch === 'function') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const target = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    if (!isLoopback(target.hostname)) return Promise.reject(block('fetch', target.href, target.hostname));
    return originalFetch.call(this, input, init);
  };
}
write({ event: 'loaded', argv0: process.argv[0], execPath: process.execPath });
`;

async function createLoopbackGuard(dataRoot) {
  const guardPath = path.join(dataRoot, 'dashboard-visual-loopback-guard.cjs');
  const logPath = path.join(dataRoot, 'dashboard-visual-loopback-guard.jsonl');
  await fs.writeFile(guardPath, LOOPBACK_GUARD_SOURCE, 'utf8');
  await fs.writeFile(logPath, '', 'utf8');
  return { guardPath, logPath };
}

function launchElectron({ dataRoot, ports, guard }) {
  const args = [
    '--in-process-gpu',
    '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${ports.cdp}`,
    '.',
    '--dashboard-visual-test',
  ];
  const env = {
    ...process.env,
    WANGZAI_DESKTOP_DATA_DIR: dataRoot,
    // Source-only visual fixtures never use a real License Center account.
    // Packaged builds ignore this override and remain enforce-only.
    WANGZAI_LICENSE_MODE: 'off',
    WANGZAI_NETWORK_GUARD_LOG: guard.logPath,
    LOCAL_API_PORT: String(ports.localApi),
    PURCHASE_SEARCH_BRIDGE_PORT: String(ports.bridge),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${guard.guardPath}`].filter(Boolean).join(' '),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronExecutable, args, {
    cwd: desktopRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = { stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => {
    output.stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk) => {
    output.stderr += chunk.toString('utf8');
  });
  const exit = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, args, output, exit };
}

async function waitForTarget(port, launch, timeoutMs = 30_000) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (launch.child.exitCode !== null) {
      throw new Error(
        `Electron 在 CDP 就绪前退出：${launch.child.exitCode}\n${launch.output.stderr.slice(-3000)}`,
      );
    }
    try {
      const targets = await fetch(endpoint).then((response) => response.json());
      const target = targets.find(
        (item) => item.type === 'page' && String(item.url || '').startsWith('app://'),
      );
      if (target?.webSocketDebuggerUrl) return { endpoint, targets, target };
    } catch (_) {}
    await delay(150);
  }
  throw new Error(`等待 Electron CDP 页面超时：${endpoint}`);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      if (!message.method) return;
      for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP 连接已关闭'));
      }
      this.pending.clear();
    });
  }

  on(method, listener) {
    const rows = this.listeners.get(method) || [];
    rows.push(listener);
    this.listeners.set(method, rows);
  }

  send(method, params = {}, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          '页面脚本执行失败',
      );
    }
    return result.result?.value;
  }

  close() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
  }
}

async function waitFor(cdp, expression, timeoutMs = 30_000, intervalMs = 200) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await cdp.evaluate(expression).catch(() => false);
    if (value) return value;
    await delay(intervalMs);
  }
  const body = await cdp.evaluate('document.body?.innerText?.slice(0, 3000) || ""').catch(() => '');
  throw new Error(`等待页面状态超时：${expression}\n${body}`);
}

async function configurePage(cdp, targetId) {
  const events = {
    console: [],
    exceptions: [],
    logEntries: [],
    requests: [],
    failedRequests: [],
    crashes: [],
  };
  cdp.on('Runtime.consoleAPICalled', (params) => {
    events.console.push({ type: params.type, timestamp: params.timestamp });
  });
  cdp.on('Runtime.exceptionThrown', (params) => {
    events.exceptions.push({
      text: params.exceptionDetails?.text || '',
      description: params.exceptionDetails?.exception?.description || '',
    });
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    events.logEntries.push({ level: entry?.level, source: entry?.source, text: entry?.text });
  });
  cdp.on('Network.requestWillBeSent', ({ request, type }) => {
    events.requests.push({ url: request?.url, method: request?.method, type });
  });
  cdp.on('Network.loadingFailed', (params) => {
    events.failedRequests.push({
      requestId: params.requestId,
      errorText: params.errorText,
      blockedReason: params.blockedReason || '',
    });
  });
  cdp.on('Inspector.targetCrashed', (params) => events.crashes.push(params));
  await Promise.all([
    cdp.send('Page.enable'),
    cdp.send('Runtime.enable'),
    cdp.send('Network.enable'),
    cdp.send('Log.enable'),
    cdp.send('Inspector.enable'),
  ]);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.deviceScaleFactor,
    mobile: false,
  });
  let browserWindow = null;
  try {
    browserWindow = await cdp.send('Browser.getWindowForTarget', { targetId });
    if (browserWindow?.windowId) {
      await cdp.send('Browser.setWindowBounds', {
        windowId: browserWindow.windowId,
        bounds: { width: VIEWPORT.width, height: VIEWPORT.height, windowState: 'normal' },
      });
    }
  } catch (_) {}
  return { events, browserWindow };
}

const DOM_EVIDENCE_EXPRESSION = `(() => {
  const card = document.querySelector('[data-testid="dashboard-business-share"]');
  if (!card) return null;
  const keys = ['pendingPurchaseCount', 'waitingDeliveryCount', 'afterSalesTodoCount', 'stockWarningCount'];
  const rect = (node) => {
    if (!node) return null;
    const value = node.getBoundingClientRect();
    return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
  };
  const parseColor = (value) => {
    const match = String(value || '').match(/rgba?\\(([^)]+)\\)/i);
    if (!match) return null;
    const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: Number.isFinite(parts[3]) ? parts[3] : 1 };
  };
  const effectiveBackground = (node) => {
    let current = node;
    while (current) {
      const color = parseColor(getComputedStyle(current).backgroundColor);
      if (color && color.a > 0.99) return color;
      current = current.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const luminance = (color) => {
    const channels = [color.r, color.g, color.b].map((value) => {
      const normalized = value / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const contrast = (node, name) => {
    if (!node) return { name, missing: true, ratio: 0 };
    const style = getComputedStyle(node);
    const foreground = parseColor(style.fill && style.fill !== 'none' ? style.fill : style.color);
    const background = effectiveBackground(node);
    if (!foreground) return { name, text: node.textContent?.trim() || '', missingColor: true, ratio: 0 };
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));
    return {
      name,
      text: node.textContent?.trim() || '',
      foreground: style.fill && style.fill !== 'none' ? style.fill : style.color,
      background: 'rgb(' + background.r + ', ' + background.g + ', ' + background.b + ')',
      ratio: Number(((lighter + 0.05) / (darker + 0.05)).toFixed(3)),
    };
  };
  const centerLabel = card.querySelector('[data-testid="dashboard-business-share-center-label"]')
    || card.querySelector('.apexcharts-datalabel-label');
  const centerValue = card.querySelector('[data-testid="dashboard-business-share-center-total"]')
    || card.querySelector('.apexcharts-datalabel-value');
  const statusNode = card.querySelector('[data-testid="dashboard-business-share-status"]');
  const items = keys.map((key) => {
    const valueNode = card.querySelector('[data-testid="dashboard-business-share-' + key + '"]');
    const row = valueNode?.parentElement || null;
    const labelNode = row?.children?.[1] || null;
    return {
      key,
      label: labelNode?.textContent?.trim() || '',
      value: valueNode?.textContent?.trim() || '',
      labelColor: labelNode ? getComputedStyle(labelNode).color : '',
      valueColor: valueNode ? getComputedStyle(valueNode).color : '',
      labelContrast: contrast(labelNode, key + ':label'),
      valueContrast: contrast(valueNode, key + ':value'),
    };
  });
  const contrastRows = [
    contrast(centerLabel, 'donut:center-label'),
    contrast(centerValue, 'donut:center-total'),
    contrast(statusNode, 'status'),
    ...items.flatMap((item) => [item.labelContrast, item.valueContrast]),
  ];
  const chartPaths = Array.from(card.querySelectorAll('.apexcharts-series path.apexcharts-pie-area')).map((node) => ({
    fill: node.getAttribute('fill') || getComputedStyle(node).fill,
    seriesName: node.parentElement?.getAttribute('seriesName') || '',
    pathLength: (node.getAttribute('d') || '').length,
  }));
  return {
    attributes: {
      status: card.getAttribute('data-dashboard-business-status'),
      values: card.getAttribute('data-dashboard-business-series'),
      chartSeries: card.getAttribute('data-dashboard-business-chart-series'),
      visualState: card.getAttribute('data-dashboard-business-visual-state'),
      total: card.getAttribute('data-dashboard-business-total'),
    },
    text: card.innerText,
    statusText: statusNode?.textContent?.trim() || '',
    center: {
      label: centerLabel?.textContent?.trim() || '',
      total: centerValue?.textContent?.trim() || '',
      labelColor: centerLabel ? getComputedStyle(centerLabel).fill : '',
      totalColor: centerValue ? getComputedStyle(centerValue).fill : '',
    },
    items,
    contrastRows,
    minimumContrast: Math.min(...contrastRows.map((row) => Number(row.ratio) || 0)),
    chartPaths,
    cardRect: rect(card),
    chartRect: rect(card.querySelector('[data-testid="dashboard-business-share-chart"]')),
    canvasCount: card.querySelectorAll('canvas').length,
    svgCount: card.querySelectorAll('svg').length,
    errorBoundary: document.body.innerText.includes('页面显示异常'),
    blank: !document.body.innerText.trim(),
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
  };
})()`;

async function captureScreenshot(cdp, outputPath, clip = null) {
  const result = await cdp.evaluate(`window.wangzaiDesktop.captureDashboardVisual(${JSON.stringify({
    rect: clip || null,
  })})`);
  assert(result?.ok === true && result?.pngBase64, '隐藏 Electron capturePage 没有返回 PNG', result);
  assert(result.visible === false, '截图期间隔离 Electron 窗口意外可见', result);
  const buffer = Buffer.from(result.pngBase64, 'base64');
  await fs.writeFile(outputPath, buffer);
  return {
    path: outputPath,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    pixelSize: result.size,
    capturedRect: result.rect,
    hiddenAtCapture: result.visible === false,
  };
}

async function scrollDashboardMainGridIntoView(cdp) {
  await cdp.evaluate(`(() => {
    const node = document.querySelector('.dashboard-classic-main-grid');
    node?.scrollIntoView({ block: 'center', inline: 'nearest' });
    return Boolean(node);
  })()`);
  await delay(700);
}

async function waitForTrendLayerStability(cdp, timeoutMs = 8_000) {
  const startedAt = Date.now();
  let previous = null;
  let stableSamples = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const current = await cdp.evaluate(`(() => {
      const node = document.querySelector('.dashboard-trend-interaction-layer');
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    })()`);
    const stable =
      current &&
      previous &&
      ['left', 'top', 'width', 'height'].every((key) => Math.abs(current[key] - previous[key]) <= 0.1);
    stableSamples = stable ? stableSamples + 1 : 0;
    if (stableSamples >= 2 && current.width > 0 && current.height > 0) return current;
    previous = current;
    await delay(140);
  }
  throw new Error('Dashboard 趋势交互图层在侧栏布局变化后未稳定');
}

async function captureScenarioScreenshots(cdp, scenario) {
  await scrollDashboardMainGridIntoView(cdp);
  const dom = await cdp.evaluate(DOM_EVIDENCE_EXPRESSION);
  const screenshot = await captureScreenshot(cdp, OUTPUTS[scenario]);
  let closeup = null;
  if (scenario === 'data') {
    const card = dom.cardRect;
    const padding = 8;
    const clip = {
      x: Math.max(0, card.left - padding),
      y: Math.max(0, card.top - padding),
      width: Math.min(VIEWPORT.width - Math.max(0, card.left - padding), card.width + padding * 2),
      height: Math.min(VIEWPORT.height - Math.max(0, card.top - padding), card.height + padding * 2),
    };
    closeup = await captureScreenshot(cdp, OUTPUTS.closeup, clip);
  }
  return { dom, screenshot, closeup };
}

async function measureHover(cdp, state) {
  await cdp.evaluate(`(() => {
    const frame = document.querySelector('.dashboard-trend-chart-frame');
    frame?.scrollIntoView({ block: 'center', inline: 'nearest' });
    return Boolean(frame);
  })()`);
  await waitForTrendLayerStability(cdp);
  const setup = await waitFor(
    cdp,
    `(() => {
      const layer = document.querySelector('.dashboard-trend-interaction-layer');
      if (!layer) return false;
      const rect = layer.getBoundingClientRect();
      const categories = (layer.getAttribute('data-dashboard-categories') || '').split('|').filter(Boolean);
      const pointCount = Number(layer.getAttribute('data-dashboard-point-count')) || categories.length;
      if (!pointCount || categories.length !== pointCount) return false;
      const index = Math.min(7, pointCount - 1);
      const ratio = pointCount <= 1 ? 0 : index / (pointCount - 1);
      return rect.width > 0 && rect.height > 0 ? {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        x: rect.left + rect.width * ratio,
        y: rect.top + rect.height * 0.42,
        index,
        pointCount,
        ratio,
        expectedCategory: categories[index],
      } : false;
    })()`,
  );
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: setup.x,
    y: setup.y,
  });
  await waitFor(
    cdp,
    `document.querySelector('.dashboard-trend-tooltip strong')?.textContent?.trim() === ${JSON.stringify(setup.expectedCategory)}`,
    10_000,
  );
  const measurement = await cdp.evaluate(`(() => {
    const toRect = (node) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const layer = document.querySelector('.dashboard-trend-interaction-layer');
    const frame = document.querySelector('.dashboard-trend-chart-frame');
    const line = document.querySelector('.dashboard-trend-crosshair');
    const tooltip = document.querySelector('.dashboard-trend-tooltip');
    const tooltipTime = tooltip?.querySelector('strong')?.textContent?.trim() || '';
    const layerRect = toRect(layer);
    const frameRect = toRect(frame);
    const lineRect = toRect(line);
    const tooltipRect = toRect(tooltip);
    const pointerX = layerRect.left + layerRect.width * ${JSON.stringify(setup.ratio)};
    const lineX = lineRect ? (lineRect.left + lineRect.right) / 2 : NaN;
    const differencesPx = {
      pointerToLine: Math.abs(pointerX - lineX),
    };
    const tooltipInsideFrame = Boolean(
      tooltipRect && frameRect
      && tooltipRect.left >= frameRect.left - 1
      && tooltipRect.right <= frameRect.right + 1
      && tooltipRect.top >= frameRect.top - 1
      && tooltipRect.bottom <= frameRect.bottom + 1
    );
    return {
      state: ${JSON.stringify(state)},
      index: ${JSON.stringify(setup.index)},
      pointCount: ${JSON.stringify(setup.pointCount)},
      ratio: ${JSON.stringify(setup.ratio)},
      expectedTime: ${JSON.stringify(setup.expectedCategory)},
      pointer: { x: pointerX, y: ${JSON.stringify(setup.y)} },
      layer: layerRect,
      frame: frameRect,
      line: { rect: lineRect, x: lineX },
      tooltip: { text: tooltip?.innerText || '', timeText: tooltipTime, rect: tooltipRect, insideFrame: tooltipInsideFrame },
      differencesPx,
      thresholdPx: 3,
      passes: tooltipTime === ${JSON.stringify(setup.expectedCategory)}
        && tooltipInsideFrame
        && Object.values(differencesPx).every((value) => Number.isFinite(value) && value <= 3),
      sidebarOpen: document.querySelector('.main-shell')?.classList.contains('sidebar-open') === true,
    };
  })()`);
  assert(measurement.passes, `${state} 状态趋势 hover 对齐超过阈值`, measurement);
  return measurement;
}

async function collectHoverEvidence(cdp) {
  await waitFor(
    cdp,
    `document.querySelector('.main-shell')?.classList.contains('sidebar-open') === true && Boolean(document.querySelector('button[aria-label="收起导航栏"]'))`,
  );
  const expanded = await measureHover(cdp, 'expanded');
  const collapsedClicked = await cdp.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="收起导航栏"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(collapsedClicked, '没有找到收起导航栏按钮');
  await waitFor(
    cdp,
    `document.querySelector('.main-shell')?.classList.contains('sidebar-open') === false && Boolean(document.querySelector('button[aria-label="展开导航栏"]'))`,
  );
  await waitForTrendLayerStability(cdp);
  const collapsed = await measureHover(cdp, 'collapsed');
  return {
    expanded,
    collapsed,
    comparison: {
      tooltipTimeExpanded: expanded.tooltip.timeText,
      tooltipTimeCollapsed: collapsed.tooltip.timeText,
      sameTooltipTime: expanded.tooltip.timeText === collapsed.tooltip.timeText,
      expandedMaximumDifferencePx: Math.max(...Object.values(expanded.differencesPx)),
      collapsedMaximumDifferencePx: Math.max(...Object.values(collapsed.differencesPx)),
      thresholdPx: 3,
      passes: expanded.passes && collapsed.passes,
    },
  };
}

async function readRuntimeSafety(cdp) {
  return cdp.evaluate(`(async () => {
    const request = window.wangzaiDesktop?.localApiRequest;
    if (typeof request !== 'function') return { bridgeAvailable: false };
    const [continuousSync, scheduler] = await Promise.all([
      request({ path: '/api/app/continuous-sync-status', method: 'GET', timeoutMs: 10000 }),
      request({ path: '/api/ozon/scheduler/status', method: 'GET', timeoutMs: 10000 }),
    ]);
    return { bridgeAvailable: true, continuousSync, scheduler };
  })()`);
}

async function readJsonLines(filePath) {
  const text = await fs.readFile(filePath, 'utf8').catch(() => '');
  return text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { event: 'invalid-json-line', line };
      }
    });
}

async function readMainLog(dataRoot) {
  const logPath = path.join(dataRoot, 'logs', 'desktop-main.log');
  const text = await fs.readFile(logPath, 'utf8').catch(() => '');
  const networkRows = text
    .split(/\r?\n/u)
    .filter((line) => line.includes('[dashboard-visual-network]'));
  return {
    path: logPath,
    bytes: Buffer.byteLength(text),
    windowCreatedHidden: text.includes('[dashboard-visual] window-created') && text.includes('"visible":false'),
    readyHidden: text.includes('[dashboard-visual] ready-hidden') && text.includes('"visible":false'),
    networkGuardInstalled: networkRows.some((line) => line.includes('guard-installed')),
    rendererNetworkBlocked: networkRows.filter((line) => !line.includes('guard-installed')).length,
    networkRows,
    rendererGone: text.includes('[render-process-gone]'),
    failedLoad: text.includes('[did-fail-load]'),
    uncaughtException: text.includes('[uncaughtException]'),
    unhandledRejection: text.includes('[unhandledRejection]'),
  };
}

async function waitForExit(exitPromise, timeoutMs = 20_000) {
  return Promise.race([
    exitPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('等待隔离 Electron 正常退出超时')), timeoutMs);
    }),
  ]);
}

async function terminateOwnedChild(child) {
  if (!child?.pid || !isProcessAlive(child.pid)) return false;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
    return true;
  }
  child.kill('SIGTERM');
  return true;
}

function summarizeNetworkEvents(events) {
  const requestRows = events.requests.filter((row) => row.url);
  const externalRequests = requestRows.filter((row) => {
    try {
      const url = new URL(row.url);
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false;
      return !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
    } catch {
      return false;
    }
  });
  return {
    totalRequests: requestRows.length,
    schemes: [...new Set(requestRows.map((row) => String(row.url).split(':')[0]).filter(Boolean))],
    externalRequests,
    failedRequests: events.failedRequests,
  };
}

async function runScenario(scenario) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), `wangzai-dashboard-donut-${scenario}-`));
  const ports = await allocatePorts();
  const fixture = await seedScenario(dataRoot, scenario);
  const guard = await createLoopbackGuard(dataRoot);
  const launch = launchElectron({ dataRoot, ports, guard });
  let cdp = null;
  let targetInfo = null;
  let fallbackTerminationUsed = false;
  let exit = null;
  try {
    targetInfo = await waitForTarget(ports.cdp, launch);
    cdp = new CdpClient(targetInfo.target.webSocketDebuggerUrl);
    await cdp.connect();
    const pageSetup = await configurePage(cdp, targetInfo.target.id);
    await waitFor(cdp, `document.readyState === 'complete' && Boolean(document.querySelector('[data-testid="dashboard-business-share"]'))`);
    await waitFor(
      cdp,
      `(() => {
        const card = document.querySelector('[data-testid="dashboard-business-share"]');
        const expected = ${JSON.stringify(scenario === 'data' ? 'data' : 'empty')};
        const chartReady = expected === 'data'
          ? card?.querySelector('.apexcharts-canvas')
          : card?.querySelector('[data-testid="dashboard-business-share-state-ring"]');
        return card?.getAttribute('data-dashboard-business-status') === expected
          && chartReady
          && !document.body.innerText.includes('页面显示异常');
      })()`,
      35_000,
    );
    await delay(700);

    const runtimeSafety = await readRuntimeSafety(cdp);
    assert(runtimeSafety.bridgeAvailable === true, `${scenario} 桌面 local-api bridge 不可用`, runtimeSafety);
    assert(runtimeSafety.continuousSync?.ok === true, `${scenario} continuous-sync 状态读取失败`, runtimeSafety);
    assert(
      runtimeSafety.continuousSync?.data?.enabled === false,
      `${scenario} 隔离 local-api 仍启动了后台连续同步`,
      runtimeSafety.continuousSync,
    );
    const captures = await captureScenarioScreenshots(cdp, scenario);
    const expectedSeries = Object.values(EXPECTED[scenario]).join(',');
    assert(captures.dom.attributes.values === expectedSeries, `${scenario} DOM 业务 series 不匹配`, captures.dom);
    assert(
      captures.dom.attributes.total === String(Object.values(EXPECTED[scenario]).reduce((sum, value) => sum + value, 0)),
      `${scenario} DOM 中心总数不匹配`,
      captures.dom,
    );
    assert(captures.dom.minimumContrast >= 4.5, `${scenario} 圆环文字对比度低于 4.5:1`, captures.dom.contrastRows);
    assert(!captures.dom.errorBoundary && !captures.dom.blank, `${scenario} Dashboard 页面为空或进入错误边界`, captures.dom);
    if (scenario === 'zero') {
      assert(captures.dom.attributes.chartSeries === '', '零数据不得制造图表 series', captures.dom);
      assert(captures.dom.attributes.visualState === 'empty', '零数据必须使用明确空状态圆环', captures.dom);
      assert(captures.dom.center.total === '0', '零数据圆环中心必须显示 0', captures.dom.center);
    } else {
      assert(captures.dom.attributes.chartSeries === expectedSeries, '有数据图形 series 与真实计数不匹配', captures.dom);
      assert(captures.dom.attributes.visualState === 'chart', '有数据状态必须渲染真实图形', captures.dom);
      assert(
        captures.dom.center.total === String(Object.values(EXPECTED.data).reduce((sum, value) => sum + value, 0)),
        '有数据圆环中心总数必须等于四项当前待办之和',
        captures.dom.center,
      );
    }

    const hover = scenario === 'data' ? await collectHoverEvidence(cdp) : null;
    const pageHealth = await cdp.evaluate(`({
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      hasErrorBoundary: document.body.innerText.includes('页面显示异常'),
      bodyTextLength: document.body.innerText.length,
      innerWidth: innerWidth,
      innerHeight: innerHeight,
      devicePixelRatio: devicePixelRatio,
    })`);
    const network = summarizeNetworkEvents(pageSetup.events);
    assert(network.externalRequests.length === 0, `${scenario} renderer 发生非 loopback 网络请求`, network.externalRequests);
    assert(pageSetup.events.exceptions.length === 0, `${scenario} renderer 出现未捕获异常`, pageSetup.events.exceptions);
    assert(pageSetup.events.crashes.length === 0, `${scenario} renderer 发生崩溃`, pageSetup.events.crashes);

    const closeResult = await cdp.send('Target.closeTarget', { targetId: targetInfo.target.id });
    assert(closeResult?.success === true, `${scenario} CDP 未能主动关闭隔离测试窗口`, closeResult);
    cdp.close();
    exit = await waitForExit(launch.exit);
    const portsAfterExit = await waitForPortsClosed([ports.cdp, ports.localApi, ports.bridge]);
    const guardRows = await readJsonLines(guard.logPath);
    const mainLog = await readMainLog(dataRoot);
    const loadedRows = guardRows.filter((row) => row.event === 'loaded');
    const blockedRows = guardRows.filter((row) => row.event === 'blocked');
    assert(exit.code === 0, `${scenario} 隔离 Electron 退出码异常`, { exit, stderr: launch.output.stderr.slice(-3000) });
    assert(!isProcessAlive(launch.child.pid), `${scenario} 隔离 Electron 主 PID 仍存活`, { pid: launch.child.pid });
    assert(portsAfterExit.every((row) => !row.reachable), `${scenario} 隔离测试端口未全部退出`, portsAfterExit);
    assert(loadedRows.length >= 3, `${scenario} loopback Node guard 未覆盖主进程/local-api/bridge`, guardRows);
    assert(blockedRows.length === 0, `${scenario} 应用尝试了非 loopback Node 网络`, blockedRows);
    assert(mainLog.networkGuardInstalled, `${scenario} Chromium session loopback guard 未安装`, mainLog);
    assert(mainLog.rendererNetworkBlocked === 0, `${scenario} renderer 尝试了非 loopback 网络`, mainLog.networkRows);
    assert(mainLog.windowCreatedHidden && mainLog.readyHidden, `${scenario} 测试窗口不是全程隐藏`, mainLog);
    assert(!mainLog.rendererGone && !mainLog.failedLoad, `${scenario} Electron 日志出现加载或 renderer 崩溃`, mainLog);

    return {
      scenario,
      fixture,
      isolation: {
        dataRoot,
        profile: dataRoot,
        mainPid: launch.child.pid,
        ports: {
          cdp: ports.cdp,
          localApi: ports.localApi,
          bridge: ports.bridge,
        },
        launchArguments: launch.args,
        hiddenWindow: true,
        skipTaskbar: true,
        backgroundThrottling: false,
        continuousSyncDisabled: true,
      },
      target: {
        id: targetInfo.target.id,
        type: targetInfo.target.type,
        title: targetInfo.target.title,
        url: targetInfo.target.url,
      },
      browserWindow: pageSetup.browserWindow,
      pageHealth,
      dom: captures.dom,
      screenshots: {
        primary: captures.screenshot,
        closeup: captures.closeup,
      },
      hover,
      runtimeSafety,
      network: {
        cdp: network,
        nodeGuard: {
          path: guard.logPath,
          loaded: loadedRows.length,
          loadedPids: [...new Set(loadedRows.map((row) => row.pid))],
          blocked: blockedRows.length,
          blockedRows,
        },
        chromiumGuard: {
          installed: mainLog.networkGuardInstalled,
          blocked: mainLog.rendererNetworkBlocked,
          rows: mainLog.networkRows,
        },
      },
      rendererEvents: pageSetup.events,
      logs: {
        main: mainLog,
        stdoutTail: launch.output.stdout.slice(-3000),
        stderrTail: launch.output.stderr.slice(-3000),
      },
      shutdown: {
        method: 'CDP Target.closeTarget',
        closeResult,
        exit,
        mainPid: launch.child.pid,
        mainPidAlive: isProcessAlive(launch.child.pid),
        ports: portsAfterExit,
        fallbackTerminationUsed,
        closedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    const rendererDiagnostic = cdp
      ? await cdp.evaluate(`(async () => {
          const bridge = window.wangzaiDesktop;
          const safe = async (path) => {
            try {
              return await bridge?.localApiRequest?.({ method: 'GET', path, timeoutMs: 5000 });
            } catch (requestError) {
              return { ok: false, error: String(requestError?.message || requestError) };
            }
          };
          return {
            baseUrl: window.__WANGZAI_LOCAL_API_BASE_URL__ || '',
            bridgeAvailable: typeof bridge?.localApiRequest === 'function',
            shops: await safe('/api/shops'),
            profile: await safe('/api/profile-settings/ozon-shop-preferences'),
            bodyStatus: document.querySelector('[data-testid="dashboard-business-share"]')?.getAttribute('data-dashboard-business-status') || '',
          };
        })()`)
      : null;
    cdp?.close();
    if (isProcessAlive(launch.child.pid)) {
      fallbackTerminationUsed = await terminateOwnedChild(launch.child);
      await Promise.race([launch.exit, delay(10_000)]);
    }
    error.message += `\nscenario=${scenario}\npid=${launch.child.pid}\ndataRoot=${dataRoot}\nrendererDiagnostic=${JSON.stringify(rendererDiagnostic, null, 2)}\nstdout=${launch.output.stdout.slice(-3000)}\nstderr=${launch.output.stderr.slice(-3000)}\nfallbackTerminationUsed=${fallbackTerminationUsed}`;
    throw error;
  }
}

async function readBuildManifest() {
  const indexPath = path.join(workspaceRoot, 'frontend', 'dist', 'index.html');
  const indexText = await fs.readFile(indexPath, 'utf8');
  const entryAsset = indexText.match(/src="\/assets\/(index-[^"]+\.js)"/u)?.[1] || '';
  const entryAssetPath = entryAsset
    ? path.join(workspaceRoot, 'frontend', 'dist', 'assets', entryAsset)
    : '';
  const entryText = entryAssetPath ? await fs.readFile(entryAssetPath, 'utf8') : '';
  // Dashboard can be emitted as its own lazy chunk or folded into the split App
  // chunk. Follow the current entry graph instead of requiring one historical
  // Rollup filename.
  const dashboardAsset =
    entryText.match(/DashboardPage-[A-Za-z0-9_-]+\.js/u)?.[0] ||
    entryText.match(/App-[A-Za-z0-9_-]+\.js/u)?.[0] ||
    '';
  const dashboardAssetPath = dashboardAsset
    ? path.join(workspaceRoot, 'frontend', 'dist', 'assets', dashboardAsset)
    : '';
  const dashboardText = dashboardAssetPath ? await fs.readFile(dashboardAssetPath) : Buffer.alloc(0);
  return {
    indexPath,
    indexSha256: createHash('sha256').update(indexText).digest('hex'),
    entryAsset,
    entryAssetPath,
    dashboardAsset,
    dashboardAssetPath,
    dashboardAssetSha256: dashboardText.length
      ? createHash('sha256').update(dashboardText).digest('hex')
      : '',
  };
}

async function main() {
  await fs.mkdir(resultRoot, { recursive: true });
  await Promise.all(Object.values(OUTPUTS).map((outputPath) => fs.rm(outputPath, { force: true })));
  const build = await readBuildManifest();
  assert(build.dashboardAsset, 'frontend/dist 中没有 DashboardPage 构建产物，请先完成安全构建', build);

  const startedAt = new Date().toISOString();
  const zero = await runScenario('zero');
  const data = await runScenario('data');
  const allContrastRows = [...zero.dom.contrastRows, ...data.dom.contrastRows];
  const minimumContrast = Math.min(...allContrastRows.map((row) => Number(row.ratio) || 0));
  const evidence = {
    schemaVersion: 1,
    phase: 'S3C-dashboard-business-share-donut',
    startedAt,
    generatedAt: new Date().toISOString(),
    build,
    fixtureCounts: {
      zero: EXPECTED.zero,
      data: EXPECTED.data,
    },
    scenarios: { zero, data },
    contrast: {
      threshold: 4.5,
      minimum: minimumContrast,
      passes: minimumContrast >= 4.5,
    },
    hover: data.hover,
    networkGuard: {
      allowedHosts: ['127.0.0.1', 'localhost', '::1'],
      nodeGuardLoaded: zero.network.nodeGuard.loaded + data.network.nodeGuard.loaded,
      nodeBlocked: zero.network.nodeGuard.blocked + data.network.nodeGuard.blocked,
      chromiumGuardInstalled: zero.network.chromiumGuard.installed && data.network.chromiumGuard.installed,
      chromiumBlocked: zero.network.chromiumGuard.blocked + data.network.chromiumGuard.blocked,
      externalNetworkOccurred:
        zero.network.cdp.externalRequests.length > 0 ||
        data.network.cdp.externalRequests.length > 0 ||
        zero.network.nodeGuard.blocked > 0 ||
        data.network.nodeGuard.blocked > 0,
    },
    screenshots: {
      zero: zero.screenshots.primary,
      data: data.screenshots.primary,
      closeup: data.screenshots.closeup,
    },
    shutdown: {
      zero: zero.shutdown,
      data: data.shutdown,
      allOwnedProcessesExited:
        !zero.shutdown.mainPidAlive &&
        !data.shutdown.mainPidAlive &&
        zero.shutdown.ports.every((row) => !row.reachable) &&
        data.shutdown.ports.every((row) => !row.reachable),
      formalWindowAction: 'none',
      terminationScope: 'only PIDs returned by this runner spawn call',
    },
    assertions: {
      zeroCountsMatch: sameCounts(zero.fixture.preflightPayload.currentTasks, EXPECTED.zero),
      dataCountsMatch: sameCounts(data.fixture.preflightPayload.currentTasks, EXPECTED.data),
      zeroDomMatch: zero.dom.attributes.values === '0,0,0,0' && zero.dom.center.total === '0',
      dataDomMatch:
        data.dom.attributes.values === Object.values(EXPECTED.data).join(',')
        && data.dom.center.total === String(Object.values(EXPECTED.data).reduce((sum, value) => sum + value, 0)),
      noRendererRowsMaterialized: true,
      contrastPasses: minimumContrast >= 4.5,
      hoverPasses: data.hover?.comparison?.passes === true,
      hiddenWindows: zero.isolation.hiddenWindow && data.isolation.hiddenWindow,
      continuousSyncDisabled:
        zero.isolation.continuousSyncDisabled && data.isolation.continuousSyncDisabled,
      externalNetworkOccurred: false,
      allOwnedProcessesExited:
        !zero.shutdown.mainPidAlive && !data.shutdown.mainPidAlive,
      realProfileTouched: false,
      realSqliteTouched: false,
      ozonWriteOccurred: false,
    },
    evidencePath: OUTPUTS.evidence,
  };

  assert(evidence.assertions.zeroCountsMatch, '零数据 fixture 最终断言失败');
  assert(evidence.assertions.dataCountsMatch, '有数据 fixture 最终断言失败');
  assert(evidence.assertions.zeroDomMatch, '零数据 DOM 最终断言失败');
  assert(evidence.assertions.dataDomMatch, '有数据 DOM 最终断言失败');
  assert(evidence.assertions.contrastPasses, '文字对比度最终断言失败');
  assert(evidence.assertions.hoverPasses, '趋势 hover 最终断言失败');
  assert(!evidence.networkGuard.externalNetworkOccurred, '隔离运行发生了外部网络');
  assert(evidence.shutdown.allOwnedProcessesExited, '隔离 Electron 或端口仍未退出');

  await fs.writeFile(OUTPUTS.evidence, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    evidence: OUTPUTS.evidence,
    screenshots: evidence.screenshots,
    counts: evidence.fixtureCounts,
    minimumContrast,
    hover: evidence.hover.comparison,
    networkGuard: evidence.networkGuard,
    shutdown: evidence.shutdown.allOwnedProcessesExited,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
